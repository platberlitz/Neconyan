/**
 * Conversation games: a board or a puzzle played with the characters of this
 * chat. The rules modules stay pure and know nothing about the DOM; this file
 * owns the panel, the pal's turns, the notes in the timeline and the one saved
 * game per conversation branch.
 *
 * Chess and Connect Four are played against the pal seat, which is driven by
 * the chat's connection profile when it has one and by the main API otherwise.
 * Picross and Minesweeper are solo puzzles, so no model is asked for anything.
 */
import { loadStylesheetAsync } from '../../dynamic-styles.js';
import { eventSource, event_types } from '../../events.js';
import { t } from '../../i18n.js';
import { clear, h } from '../../notebooks/dom.js';
import { accountStorage } from '../../util/AccountStorage.js';
import { SAFE_TOAST_OPTIONS } from '../constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getCurrentCharAvatar,
} from '../context.js';
import { getConversationParticipants, getParticipantNamesForDisplay } from '../media.js';
import { getConversationPersonaName } from '../personas.js';
import { getSettings } from '../settings-store.js';
import { persistConversationStoreNow } from '../store-sync.js';
import { appendConversationOocNote } from '../timeline-slash-commands.js';
import { requestPalMove } from './pal.js';
import { GAME_RULES, getGameRules } from './registry.js';
import { createChessView } from './views/chess.js';
import { createConnectFourView } from './views/connect-four.js';
import { createMinesweeperView } from './views/minesweeper.js';
import { createPicrossView } from './views/picross.js';

const SECTION_ID = 'neconyan-conversation-games';
const STYLESHEET = 'css/neconyan-conversation-games.css';
const STYLESHEET_ID = 'neconyan-conversation-games-css';
const PREFS_KEY = 'neconyanConversationGames.v1';
const PHONE_QUERY = '(max-width: 768px)';
const RECORD_VERSION = 1;

const VIEWS = {
    chess: createChessView,
    'connect-four': createConnectFourView,
    picross: createPicrossView,
    minesweeper: createMinesweeperView,
};

const app = {
    built: false,
    open: false,
    layout: 'beside',
    target: null,
    contextKey: '',
    record: null,
    savedRecord: '',
    rules: null,
    view: null,
    pick: null,
    browsing: false,
    busy: false,
    note: '',
    hint: null,
    turnToken: 0,
    listening: false,
    el: {},
};

const rememberedChoices = new Map();

/* Helpers */

function isPhone() {
    return globalThis.matchMedia?.(PHONE_QUERY).matches === true;
}

function warn(error, fallback) {
    console.warn('[neconyan] games:', error);
    if (fallback) {
        globalThis.toastr?.error?.(fallback, '', SAFE_TOAST_OPTIONS);
    }
}

function joinNames(names) {
    const list = (names || []).filter(Boolean);
    if (!list.length) {
        return '';
    }
    if (list.length === 1) {
        return list[0];
    }
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function palLabel() {
    return joinNames(app.target?.names) || t`your pal`;
}

function sentence(label, detail) {
    const parts = [label, detail]
        .map(part => String(part || '').trim().replace(/\.$/, ''))
        .filter(Boolean);
    return parts.length ? `${parts.join('. ')}.` : '';
}

/* Preferences */

function readPrefs() {
    try {
        const saved = JSON.parse(accountStorage.getItem(PREFS_KEY) || '{}');
        if (saved.layout === 'full' || saved.layout === 'beside') {
            app.layout = saved.layout;
        }
        if (saved.choices && typeof saved.choices === 'object') {
            for (const [id, choice] of Object.entries(saved.choices)) {
                if (!choice || typeof choice !== 'object') {
                    continue;
                }
                rememberedChoices.set(id, {
                    difficulty: typeof choice.difficulty === 'string' ? choice.difficulty : '',
                    options: choice.options && typeof choice.options === 'object' ? { ...choice.options } : {},
                });
            }
        }
    } catch (error) {
        warn(error);
    }
}

function writePrefs() {
    try {
        accountStorage.setItem(PREFS_KEY, JSON.stringify({
            layout: app.layout,
            choices: Object.fromEntries(rememberedChoices),
        }));
    } catch (error) {
        warn(error);
    }
}

function chooseFor(rules) {
    const saved = rememberedChoices.get(rules.id);
    const difficulties = rules.difficulties || [];
    const picked = { id: rules.id, difficulty: '', options: {} };
    if (difficulties.length) {
        const known = difficulties.some(item => item.id === saved?.difficulty);
        picked.difficulty = known ? saved.difficulty : (difficulties.find(item => item.id === 'normal')?.id || difficulties[0].id);
    }
    for (const option of rules.options || []) {
        const wanted = saved?.options?.[option.id];
        const known = option.values.some(item => item.id === wanted);
        picked.options[option.id] = known ? wanted : defaultChoice(option);
    }
    return picked;
}

/** A phone gets the smallest board first: a ten wide grid leaves fingers nowhere to land. */
function defaultChoice(option) {
    const compact = option?.compact;
    if (isPhone() && compact && option.values?.some(item => item.id === compact)) {
        return compact;
    }
    return option.default;
}

/* The chat the panel is looking at */

function resolveTarget() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return null;
    }
    const groupId = getConversationGroupIdForAvatar(avatar);
    const personaId = getConversationPersonaId();
    const branch = getActiveConversationBranch(avatar, { groupId, personaId, create: true });
    const settings = getSettings(avatar, { groupId, personaId });
    const participants = getConversationParticipants(avatar, settings, { groupId, personaId });
    const names = getParticipantNamesForDisplay(participants).filter(Boolean);
    return {
        avatar,
        groupId,
        personaId,
        branchId: branch.id,
        lifetimeSeed: branch.lifetimeSeed || '',
        createdAt: branch.createdAt,
        names,
        profileName: String(settings?.connection_profile || '').trim(),
        userName: getConversationPersonaName(personaId, 'the human player'),
    };
}

function contextKeyOf(target) {
    return target ? JSON.stringify([target.avatar, target.groupId, target.personaId, target.branchId, target.lifetimeSeed, target.createdAt]) : '';
}

function activeBranch(target = app.target) {
    if (!target) {
        return null;
    }
    const branch = getActiveConversationBranch(target.avatar, {
        create: false,
        branchId: target.branchId,
        groupId: target.groupId,
        personaId: target.personaId,
    });
    return branch && (branch.lifetimeSeed || '') === target.lifetimeSeed && branch.createdAt === target.createdAt ? branch : null;
}

function readRecord(target) {
    const saved = activeBranch(target)?.games;
    if (!saved || typeof saved !== 'object') {
        return null;
    }
    const rules = getGameRules(saved.id);
    if (!rules) {
        return null;
    }
    let state = null;
    try {
        state = rules.hydrate(saved.state);
    } catch (error) {
        console.warn('[neconyan] games: the saved board could not be read', error);
    }
    if (!state) {
        return null;
    }
    return {
        version: RECORD_VERSION,
        id: rules.id,
        difficulty: typeof saved.difficulty === 'string' ? saved.difficulty : '',
        options: saved.options && typeof saved.options === 'object' ? { ...saved.options } : {},
        state,
        startedAt: Number.isFinite(saved.startedAt) ? saved.startedAt : 0,
        finishedNoted: saved.finishedNoted === true,
    };
}

function saveRecord() {
    const record = app.record;
    const branch = activeBranch();
    if (!branch) {
        return;
    }
    if (record) {
        branch.games = {
            version: RECORD_VERSION,
            id: record.id,
            difficulty: record.difficulty,
            options: { ...record.options },
            state: record.state,
            startedAt: record.startedAt,
            finishedNoted: record.finishedNoted,
        };
    } else {
        delete branch.games;
    }
    branch.updatedAt = Date.now();
    app.savedRecord = JSON.stringify(branch.games ?? null);
    void persistConversationStoreNow().then(saved => {
        if (!saved) {
            warn(new Error('Game save was not acknowledged'), t`The game could not be saved. Keep this page open and check your connection.`);
        }
    }).catch(error => warn(error, t`The game could not be saved. Keep this page open and check your connection.`));
}

function refreshChangedRecord() {
    const branch = activeBranch();
    if (!app.target || (branch && JSON.stringify(branch.games ?? null) === app.savedRecord)) {
        return false;
    }
    app.turnToken += 1;
    app.busy = false;
    syncTarget();
    render();
    resumePalTurn();
    return true;
}

function noteTimeline(text) {
    const target = app.target;
    if (!target || !text) {
        return;
    }
    const branch = activeBranch(target);
    if (!branch) {
        return;
    }
    try {
        appendConversationOocNote(text, {
            avatar: target.avatar,
            branchId: branch.id,
            groupId: target.groupId,
            personaId: target.personaId,
        });
    } catch (error) {
        warn(error);
    }
}

/* Building the panel */

function iconOnly(icon, label, onClick) {
    return h('button', {
        type: 'button',
        class: 'neco-games-icon',
        'aria-label': label,
        title: label,
        onclick: onClick,
    }, h('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }));
}

function actionButton(icon, label, onClick, className = '') {
    return h('button', {
        type: 'button',
        class: `neco-games-button ${className}`.trim(),
        onclick: onClick,
    },
    h('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }),
    h('span', { text: label }));
}

function build() {
    if (app.built) {
        return;
    }
    app.built = true;
    const el = app.el;

    el.subtitle = h('p', { class: 'neco-games-subtitle' });
    el.picker = h('div', { class: 'neco-games-picker' });
    el.name = h('span', { class: 'neco-games-game-name' });
    el.icon = h('i', { class: 'fa-solid fa-chess', 'aria-hidden': 'true' });
    el.meta = h('p', { class: 'neco-games-game-meta' });
    el.status = h('p', { class: 'neco-games-status' });
    el.dots = h('span', { class: 'neco-games-dots', 'aria-hidden': 'true' },
        h('span'), h('span'), h('span'));
    el.thinkingText = h('span', { class: 'neco-games-thinking-text' });
    el.thinking = h('p', { class: 'neco-games-thinking', hidden: true }, el.dots, el.thinkingText);
    el.board = h('div', { class: 'neco-games-board' });
    el.note = h('p', { class: 'neco-games-note', hidden: true });
    el.hint = actionButton('fa-lightbulb', t`Hint`, () => showHint(), 'neco-games-button-quiet neco-games-hint');
    el.againText = h('span', { text: t`New game` });
    el.again = h('button', {
        type: 'button',
        class: 'neco-games-button neco-games-button-primary neco-games-again',
        onclick: () => again(),
    }, h('i', { class: 'fa-solid fa-rotate-right', 'aria-hidden': 'true' }), el.againText);
    el.end = actionButton('fa-flag', t`End game`, () => endGame(), 'neco-games-button-quiet neco-games-end');
    el.game = h('div', { class: 'neco-games-game', hidden: true },
        h('div', { class: 'neco-games-game-bar' },
            h('button', {
                type: 'button',
                class: 'neco-games-back',
                onclick: () => browseGames(),
            }, h('i', { class: 'fa-solid fa-chevron-left', 'aria-hidden': 'true' }), h('span', { text: t`All games` })),
            h('div', { class: 'neco-games-game-titles' },
                h('p', { class: 'neco-games-game-title' }, el.icon, el.name),
                el.meta)),
        el.status,
        el.thinking,
        el.board,
        el.note,
        h('div', { class: 'neco-games-actions' }, el.hint, el.again, el.end));

    el.section = h('section', {
        id: SECTION_ID,
        class: 'neco-games',
        'aria-label': t`Games`,
        hidden: true,
    },
    h('header', { class: 'neco-games-head' },
        h('div', { class: 'neco-games-titles' },
            h('h2', { class: 'neco-games-title', text: t`Games` }),
            el.subtitle),
        h('div', { class: 'neco-games-head-actions' }, iconOnly('fa-xmark', t`Close games`, () => hideGames()))),
    h('div', { class: 'neco-games-body' }, el.picker, el.game));

    document.body.append(el.section);
}

function destroyView() {
    if (app.view) {
        try {
            app.view.destroy?.();
        } catch (error) {
            warn(error);
        }
        app.view.element.remove();
    }
    app.view = null;
}

function syncView() {
    const rules = app.record ? getGameRules(app.record.id) : null;
    if (!rules) {
        app.rules = null;
        destroyView();
        return;
    }
    app.rules = rules;
    if (app.view && app.view.id === rules.id) {
        return;
    }
    destroyView();
    const factory = VIEWS[rules.id];
    if (!factory) {
        app.rules = null;
        return;
    }
    app.view = factory({ onMove });
    app.view.id = rules.id;
    app.el.board.append(app.view.element);
}

/* Rendering */

function render() {
    if (!app.built) {
        return;
    }
    const playing = Boolean(app.record && app.rules) && !app.browsing;
    app.el.picker.hidden = playing;
    app.el.game.hidden = !playing;
    app.el.subtitle.hidden = playing;
    app.el.subtitle.textContent = playing ? '' : t`Playing with ${palLabel()}, or on your own.`;
    app.el.section.dataset.state = playing ? 'playing' : (app.record ? 'browsing' : 'picking');
    if (playing) {
        renderGame();
    } else {
        renderPicker();
    }
}

function renderPicker() {
    const host = app.el.picker;
    clear(host);
    const pal = palLabel();

    if (app.record) {
        const rules = getGameRules(app.record.id);
        if (rules) {
            host.append(h('div', { class: 'neco-games-resume' },
                h('p', { class: 'neco-games-resume-title' }, h('i', { class: `fa-solid ${rules.icon}`, 'aria-hidden': 'true' }), h('span', { text: t`${rules.name} in progress` })),
                h('div', { class: 'neco-games-resume-actions' },
                    h('button', {
                        type: 'button',
                        class: 'neco-games-button neco-games-button-primary',
                        onclick: () => resumeGame(),
                    }, h('span', { text: t`Back to the board` })),
                    h('button', {
                        type: 'button',
                        class: 'neco-games-button neco-games-button-quiet',
                        onclick: () => endGame(),
                    }, h('span', { text: t`End game` })))));
        }
    }

    host.append(h('p', { class: 'neco-games-intro', text: t`Pick a game. The board stays with this chat.` }));

    const cards = h('div', { class: 'neco-games-cards' });
    for (const rules of GAME_RULES) {
        const selected = app.pick?.id === rules.id;
        cards.append(h('button', {
            type: 'button',
            class: 'neco-games-card',
            'aria-pressed': String(selected),
            'data-game': rules.id,
            onclick: () => selectGame(rules),
        },
        h('span', { class: 'neco-games-card-icon' }, h('i', { class: `fa-solid ${rules.icon}`, 'aria-hidden': 'true' })),
        h('span', { class: 'neco-games-card-text' },
            h('span', { class: 'neco-games-card-name', text: rules.name }),
            h('span', { class: 'neco-games-card-blurb', text: rules.blurb })),
        h('span', {
            class: 'neco-games-card-kind',
            text: rules.kind === 'versus' ? t`With your pal` : t`On your own`,
        })));
    }
    host.append(cards);

    const rules = app.pick ? getGameRules(app.pick.id) : null;
    if (rules) {
        const setup = h('div', { class: 'neco-games-setup' });
        if (rules.difficulties?.length) {
            setup.append(choiceField(t`How hard`, rules.difficulties, app.pick.difficulty, (value) => {
                app.pick.difficulty = value;
                render();
            }));
        }
        for (const option of rules.options || []) {
            setup.append(choiceField(option.label, option.values, app.pick.options[option.id], (value) => {
                app.pick.options[option.id] = value;
                render();
            }));
        }
        if (rules.kind === 'versus') {
            setup.append(h('p', {
                class: 'neco-games-setup-hint',
                text: t`${pal} plays the other side through this chat's connection profile, or the main API.`,
            }));
        }
        setup.append(h('button', {
            type: 'button',
            class: 'neco-games-button neco-games-button-primary neco-games-start',
            onclick: () => startGame(rules),
        }, h('i', { class: 'fa-solid fa-play', 'aria-hidden': 'true' }), h('span', { text: t`Start` })));
        host.append(setup);
    }
}

function choiceField(label, values, current, onChoose) {
    const row = h('div', { class: 'neco-games-choices', role: 'group', 'aria-label': label });
    for (const item of values) {
        row.append(h('button', {
            type: 'button',
            class: 'neco-games-choice',
            'aria-pressed': String(item.id === current),
            onclick: () => onChoose(item.id),
        },
        h('span', { class: 'neco-games-choice-label', text: item.label }),
        item.detail ? h('span', { class: 'neco-games-choice-detail', text: item.detail }) : null));
    }
    return h('div', { class: 'neco-games-field' },
        h('p', { class: 'neco-games-field-label', text: label }),
        row);
}

function renderGame() {
    const rules = app.rules;
    const record = app.record;
    const state = record.state;
    const status = rules.status(state);
    const turn = rules.turn(state);
    const playing = !status.over;

    app.el.icon.className = `fa-solid ${rules.icon}`;
    app.el.name.textContent = rules.name;
    app.el.meta.textContent = metaText();
    app.el.status.textContent = sentence(status.label, status.detail);
    app.el.status.dataset.turn = status.over ? 'over' : (app.busy || turn === 'pal' ? 'pal' : 'you');
    app.el.thinking.hidden = !app.busy;
    app.el.thinkingText.textContent = t`${palLabel()} is working out a move.`;
    app.el.note.hidden = !app.note;
    app.el.note.textContent = app.note;
    app.el.hint.hidden = typeof rules.hintCell !== 'function';
    app.el.hint.disabled = app.busy || !playing;
    app.el.againText.textContent = playing
        ? (rules.kind === 'versus' ? t`New game` : t`New puzzle`)
        : (rules.kind === 'versus' ? t`Play again` : t`Another puzzle`);

    const interactive = playing && !app.busy && (rules.kind === 'solo' || turn === 'you');
    app.view?.setState(state, { interactive, hint: app.hint, moves: legalMovesFor(rules, state), status });
}

/** Boards that play from a list of moves need that list; a broken board must not stop the frame. */
function legalMovesFor(rules, state) {
    try {
        const moves = rules.legalMoves(state);
        return Array.isArray(moves) ? moves : [];
    } catch (error) {
        warn(error, t`The board could not be read.`);
        return [];
    }
}

function metaText() {
    const rules = app.rules;
    const record = app.record;
    if (!rules || !record) {
        return '';
    }
    const bits = [];
    const difficulty = (rules.difficulties || []).find(item => item.id === record.difficulty);
    if (difficulty) {
        bits.push(difficulty.label);
    }
    for (const option of rules.options || []) {
        const value = option.values.find(item => item.id === record.options?.[option.id]);
        if (value) {
            bits.push(value.label);
        }
    }
    if (rules.kind === 'versus') {
        bits.push(t`With ${palLabel()}`);
    }
    return bits.join(' · ');
}

/* Playing */

function selectGame(rules) {
    app.pick = chooseFor(rules);
    app.browsing = true;
    render();
}

function browseGames() {
    app.pick = null;
    app.browsing = true;
    app.note = '';
    render();
}

function resumeGame() {
    app.browsing = false;
    app.note = '';
    render();
    resumePalTurn();
}

function again() {
    if (app.rules) {
        startGame(app.rules);
    }
}

function startGame(rules) {
    if (!app.target || refreshChangedRecord()) {
        return;
    }
    const picked = app.pick?.id === rules.id ? app.pick : chooseFor(rules);
    let state = null;
    try {
        state = rules.createState({ options: { ...picked.options }, random: Math.random });
    } catch (error) {
        warn(error, t`That game could not be set up.`);
        return;
    }
    if (!state) {
        warn(new Error('createState returned nothing'), t`That game could not be set up.`);
        return;
    }
    rememberedChoices.set(rules.id, { difficulty: picked.difficulty, options: { ...picked.options } });
    writePrefs();
    app.turnToken += 1;
    app.busy = false;
    app.hint = null;
    app.note = '';
    app.pick = null;
    app.browsing = false;
    app.rules = null;
    app.record = {
        version: RECORD_VERSION,
        id: rules.id,
        difficulty: picked.difficulty,
        options: { ...picked.options },
        state,
        startedAt: Date.now(),
        finishedNoted: false,
    };
    syncView();
    saveRecord();
    noteStart(rules);
    render();
    if (rules.kind === 'versus' && rules.turn(state) === 'pal') {
        void palTurn();
    }
}

function endGame() {
    if (refreshChangedRecord()) {
        return;
    }
    app.turnToken += 1;
    app.busy = false;
    app.hint = null;
    app.note = '';
    app.pick = null;
    app.browsing = false;
    app.record = null;
    app.rules = null;
    destroyView();
    saveRecord();
    render();
}

function noteStart(rules) {
    const owner = palLabel();
    const line = rules.kind === 'versus'
        ? t`Started a game of ${rules.name} with ${owner}.`
        : t`Started a ${rules.name} puzzle.`;
    noteTimeline(line);
}

function noteResult(rules, status) {
    const owner = palLabel();
    let line = '';
    if (rules.kind === 'versus') {
        const outcome = status.winner === 'you'
            ? t`you won`
            : (status.winner === 'pal' ? t`${owner} won` : t`a draw`);
        line = t`${rules.name} with ${owner}: ${outcome}.`;
    } else {
        line = t`${rules.name}: ${String(status.label || '').toLowerCase()}.`;
    }
    noteTimeline(line);
}

function showHint() {
    if (!app.record || app.busy) {
        return;
    }
    const rules = app.rules;
    if (typeof rules.hintCell !== 'function') {
        return;
    }
    let hint = null;
    try {
        hint = rules.hintCell(app.record.state) || null;
    } catch (error) {
        warn(error);
        return;
    }
    app.hint = hint;
    app.note = hint
        ? t`Hint: ${rules.describeMove(app.record.state, hint) || t`look at the highlighted square`}.`
        : t`Nothing to suggest right now.`;
    render();
}

function settle(rules, after, source) {
    const record = app.record;
    if (!record) {
        return;
    }
    app.hint = null;
    record.state = after;
    const status = rules.status(after);
    if (status.over && !record.finishedNoted) {
        record.finishedNoted = true;
        noteResult(rules, status);
    }
    saveRecord();
    app.note = source === 'search' && rules.kind === 'versus'
        ? t`${palLabel()} answered from the board itself this time.`
        : '';
    render();
}

function onMove(move) {
    if (!app.record || app.busy || refreshChangedRecord()) {
        return;
    }
    const rules = app.rules;
    const before = app.record.state;
    if (rules.turn(before) !== 'you') {
        return;
    }
    let after = before;
    try {
        after = rules.applyMove(before, move);
    } catch (error) {
        warn(error, t`That move could not be played.`);
        return;
    }
    if (after === before) {
        app.note = t`That move is not allowed here.`;
        render();
        return;
    }
    settle(rules, after, 'you');
    if (rules.kind === 'versus' && !rules.status(after).over && rules.turn(after) === 'pal') {
        void palTurn();
    }
}

async function palTurn() {
    const rules = app.rules;
    const record = app.record;
    const target = app.target;
    if (!rules || !record || !target || app.busy) {
        return;
    }
    const token = ++app.turnToken;
    app.busy = true;
    app.note = '';
    render();
    let asked = null;
    try {
        asked = await requestPalMove({
            rules,
            state: record.state,
            difficulty: record.difficulty || 'normal',
            profileName: target.profileName,
            palNames: target.names,
            userName: target.userName,
        });
    } catch (error) {
        warn(error);
    }
    if (token !== app.turnToken || refreshChangedRecord()) {
        return;
    }
    app.busy = false;
    if (!app.record) {
        render();
        return;
    }
    const move = asked?.move || null;
    if (!move) {
        app.note = t`${palLabel()} had no move to give. Try again, or start a new game.`;
        render();
        return;
    }
    const before = app.record.state;
    let after = before;
    try {
        after = rules.applyMove(before, move);
    } catch (error) {
        warn(error);
    }
    if (after === before) {
        app.note = t`That reply was not a legal move. Try the turn again.`;
        render();
        return;
    }
    settle(rules, after, asked?.source || '');
}

function resumePalTurn() {
    if (app.open && !app.browsing && !app.busy && app.rules?.kind === 'versus'
        && app.rules.turn(app.record?.state) === 'pal') {
        void palTurn();
    }
}

/* Opening and closing */

function applyLayout() {
    const section = app.el.section;
    if (!section) {
        return;
    }
    const layout = isPhone() ? 'phone' : app.layout;
    section.dataset.layout = layout;
    document.body.classList.toggle('neconyan-games-open', app.open);
    document.body.classList.toggle('neconyan-games-beside', app.open && layout === 'beside');
}

function hideSiblings() {
    try {
        globalThis.NeconyanScratchpad?.hide?.();
    } catch (error) {
        warn(error);
    }
    try {
        if (globalThis.NeconyanNotes?.hide) {
            globalThis.NeconyanNotes.hide();
        }
    } catch (error) {
        warn(error);
    }
}

function listenForChatChanges() {
    if (app.listening) {
        return;
    }
    app.listening = true;
    const changed = (event) => {
        if (event?.detail?.open === false) {
            app.turnToken += 1;
            app.busy = false;
            hideGames();
            return;
        }
        syncTarget();
        if (app.open) {
            render();
            resumePalTurn();
        }
    };
    eventSource.on(event_types.CHAT_CHANGED, changed);
    globalThis.addEventListener?.('sb:conversation-workspace-state-changed', changed);
    globalThis.addEventListener?.('neconyan:conversation-store-saved', () => refreshChangedRecord());
    globalThis.addEventListener?.('neconyan:conversation-store-refreshed', () => refreshChangedRecord());
    globalThis.addEventListener?.('resize', () => {
        if (app.open) {
            applyLayout();
        }
    });
}

function syncTarget() {
    const target = resolveTarget();
    const changed = contextKeyOf(target) !== app.contextKey;
    if (!changed && app.busy) {
        return;
    }
    app.target = target;
    app.contextKey = contextKeyOf(target);
    if (changed) {
        app.turnToken += 1;
        app.busy = false;
        app.pick = null;
        app.browsing = false;
        app.hint = null;
        app.note = '';
        app.rules = null;
    }
    app.record = target ? readRecord(target) : null;
    app.savedRecord = JSON.stringify(activeBranch(target)?.games ?? null);
    app.rules = app.record ? getGameRules(app.record.id) : null;
    syncView();
}

export async function openGames({ game = '' } = {}) {
    const target = resolveTarget();
    if (!target) {
        globalThis.toastr?.warning?.(t`Open a conversation first, then start a game.`, '', SAFE_TOAST_OPTIONS);
        return false;
    }
    await loadStylesheetAsync(STYLESHEET, { id: STYLESHEET_ID }).catch(error => warn(error));
    readPrefs();
    build();
    listenForChatChanges();
    hideSiblings();
    if (!app.open) {
        app.open = true;
        app.browsing = false;
    }
    syncTarget();
    const wanted = String(game || '').trim();
    const rules = wanted ? getGameRules(wanted) : null;
    if (rules) {
        if (app.record?.id === rules.id) {
            app.browsing = false;
        } else {
            app.pick = chooseFor(rules);
            app.browsing = true;
        }
    }
    app.el.section.hidden = false;
    if (isPhone()) {
        globalThis.NeconyanShell?.closeWorkspace?.();
    }
    applyLayout();
    render();
    resumePalTurn();
    return true;
}

export function hideGames() {
    if (!app.built || !app.open) {
        return;
    }
    app.open = false;
    app.el.section.hidden = true;
    applyLayout();
}

export function toggleGames(options = {}) {
    if (app.open) {
        hideGames();
        return Promise.resolve(false);
    }
    return openGames(options);
}

export function isGamesOpen() {
    return app.open;
}

/** The shell asks every floating workspace to step aside when the route changes. */
export function onWorkspaceRoute(route) {
    if (!app.open) {
        return;
    }
    if (route === 'notes' || isPhone() || app.layout === 'full') {
        hideGames();
    }
}

const api = Object.freeze({
    open: openGames,
    hide: hideGames,
    toggle: toggleGames,
    isOpen: isGamesOpen,
    onRoute: onWorkspaceRoute,
});

globalThis.NeconyanGames = api;

export const testExports = Object.freeze({ joinNames, sentence, palLabelForTests: palLabel });
