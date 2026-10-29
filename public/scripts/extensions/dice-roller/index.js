import {
    chat as savedChat,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    name1,
    saveSettingsDebounced,
    sendTextareaMessage,
    setExtensionPrompt,
} from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { Popup, POPUP_TYPE } from '../../popup.js';
import {
    DICE_SIDES,
    DIFFICULTIES,
    MAX_DICE,
    MAX_MODIFIER,
    OUTCOMES,
    ROLL_MODES,
    buildDiceDirective,
    findRollMessageForGeneration,
    formatDiceNotation,
    formatRollLine,
    getGenerationChat,
    getOutcomeKey,
    getTotalRange,
    normaliseCount,
    normaliseMode,
    normaliseModifier,
    normaliseSides,
    parseRollLines,
    resolveTarget,
    rollDice,
} from './lib/dice.js';

const MODULE_NAME = 'dice-roller';
const PROMPT_KEY = 'neco_dice_roller';
const COMPOSER_BUTTON_ID = 'neco-dice-composer-button';
const WAND_BUTTON_ID = 'neco-dice-wand-button';
const SETTINGS_ID = 'neco-dice-settings';
const CHIP_CLASS = 'neco-dice-chip';
const ROLL_DURATION_MS = 900;
const FLICKER_INTERVAL_MS = 55;

const DEFAULT_SETTINGS = Object.freeze({
    sides: 20,
    count: 1,
    modifier: 0,
    difficulty: 'normal',
    customTarget: 12,
    mode: ROLL_MODES.NORMAL,
    criticals: true,
    partials: true,
    composerButton: true,
    rollOnOpen: true,
});

const OUTCOME_LABELS = Object.freeze({
    [OUTCOMES.CRITICAL_SUCCESS]: 'Critical success',
    [OUTCOMES.SUCCESS]: 'Success',
    [OUTCOMES.PARTIAL_SUCCESS]: 'Partial success',
    [OUTCOMES.FAILURE]: 'Failure',
    [OUTCOMES.CRITICAL_FAILURE]: 'Critical failure',
});

const OUTCOME_ICONS = Object.freeze({
    [OUTCOMES.CRITICAL_SUCCESS]: 'fa-star',
    [OUTCOMES.SUCCESS]: 'fa-circle-check',
    [OUTCOMES.PARTIAL_SUCCESS]: 'fa-circle-half-stroke',
    [OUTCOMES.FAILURE]: 'fa-circle-xmark',
    [OUTCOMES.CRITICAL_FAILURE]: 'fa-skull',
});

const MODE_LABELS = Object.freeze({
    [ROLL_MODES.NORMAL]: 'Normal',
    [ROLL_MODES.ADVANTAGE]: 'Advantage',
    [ROLL_MODES.DISADVANTAGE]: 'Disadvantage',
});

const DIE_SHAPES = Object.freeze({
    4: '<polygon points="50,7 95,88 5,88" /><path d="M50,7 L50,62 M50,62 L95,88 M50,62 L5,88" />',
    6: '<rect x="11" y="11" width="78" height="78" rx="14" /><rect x="22" y="22" width="56" height="56" rx="8" />',
    8: '<polygon points="50,4 95,50 50,96 5,50" /><path d="M5,50 L95,50 M50,4 L32,50 L50,96 M50,4 L68,50 L50,96" />',
    10: '<polygon points="50,4 95,40 50,96 5,40" /><path d="M5,40 L50,58 L95,40 M50,58 L50,96 M50,4 L50,58" />',
    12: '<polygon points="50,4 95,36 78,93 22,93 5,36" /><polygon points="50,24 74,42 65,72 35,72 26,42" />',
    20: '<polygon points="50,3 93,27 93,73 50,97 7,73 7,27" /><polygon points="50,24 76,68 24,68" /><path d="M50,3 L50,24 M93,27 L76,68 M93,73 L76,68 M50,97 L76,68 M50,97 L24,68 M7,73 L24,68 M7,27 L24,68 M7,27 L50,24 M93,27 L50,24" />',
    100: '<polygon points="50,4 95,40 50,96 5,40" /><path d="M5,40 L50,58 L95,40 M50,58 L50,96 M50,4 L50,58" /><circle cx="50" cy="50" r="44" class="neco-dice-shape-ring" />',
});

let settings = { ...DEFAULT_SETTINGS };
let activePanel = null;
let decorateFrame = 0;
let initialised = false;

function prefersReducedMotion() {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

function loadSettings() {
    const stored = extension_settings[MODULE_NAME] && typeof extension_settings[MODULE_NAME] === 'object'
        ? extension_settings[MODULE_NAME]
        : {};
    settings = { ...DEFAULT_SETTINGS, ...stored };
    settings.sides = normaliseSides(settings.sides);
    settings.count = normaliseCount(settings.count);
    settings.modifier = normaliseModifier(settings.modifier);
    settings.mode = normaliseMode(settings.mode);
    if (settings.difficulty !== 'custom' && !DIFFICULTIES.some(item => item.id === settings.difficulty)) {
        settings.difficulty = DEFAULT_SETTINGS.difficulty;
    }
    extension_settings[MODULE_NAME] = settings;
}

function saveSettings() {
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
}

function el(tag, attributes = {}, children = []) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined || value === null || value === false) {
            continue;
        }
        if (key === 'className') {
            element.className = value;
        } else if (key === 'text') {
            element.textContent = value;
        } else if (key === 'html') {
            element.innerHTML = value;
        } else if (key === 'dataset') {
            Object.assign(element.dataset, value);
        } else {
            element.setAttribute(key, value === true ? '' : String(value));
        }
    }
    for (const child of [children].flat()) {
        if (child !== null && child !== undefined) {
            element.append(child);
        }
    }
    return element;
}

function createSegmented(label, name, options, current, onChoose) {
    const group = el('div', { className: 'neco-dice-segmented', role: 'group', 'aria-label': label, dataset: { name } });
    for (const option of options) {
        const button = el('button', {
            type: 'button',
            className: 'neco-dice-segment',
            'aria-pressed': String(String(option.value) === String(current)),
            dataset: { value: String(option.value) },
            title: option.title ?? option.label,
            text: option.label,
        });
        button.addEventListener('click', () => {
            for (const sibling of group.querySelectorAll('.neco-dice-segment')) {
                sibling.setAttribute('aria-pressed', String(sibling === button));
            }
            onChoose(option.value);
        });
        group.append(button);
    }
    return group;
}

function createStepper(label, value, min, max, onChange, formatValue = String) {
    let current = value;
    const output = el('output', { className: 'neco-dice-stepper-value', 'aria-live': 'polite', text: formatValue(current) });
    const minus = el('button', { type: 'button', className: 'neco-dice-step', 'aria-label': `Less ${label.toLowerCase()}`, title: `Less ${label.toLowerCase()}` }, el('i', { className: 'fa-solid fa-minus', 'aria-hidden': 'true' }));
    const plus = el('button', { type: 'button', className: 'neco-dice-step', 'aria-label': `More ${label.toLowerCase()}`, title: `More ${label.toLowerCase()}` }, el('i', { className: 'fa-solid fa-plus', 'aria-hidden': 'true' }));
    const sync = () => {
        output.textContent = formatValue(current);
        minus.disabled = current <= min;
        plus.disabled = current >= max;
    };
    minus.addEventListener('click', () => {
        current = Math.max(min, current - 1);
        sync();
        onChange(current);
    });
    plus.addEventListener('click', () => {
        current = Math.min(max, current + 1);
        sync();
        onChange(current);
    });
    sync();
    return el('div', { className: 'neco-dice-stepper', role: 'group', 'aria-label': label }, [minus, output, plus]);
}

function formatModifier(value) {
    return value > 0 ? `+${value}` : String(value);
}

function createDie(sides, index) {
    const die = el('span', { className: 'neco-dice-die', dataset: { sides: String(sides) } });
    die.style.setProperty('--neco-dice-delay', `${index * 70}ms`);
    die.innerHTML = `<svg class="neco-dice-shape" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${DIE_SHAPES[sides] ?? DIE_SHAPES[20]}</svg>`;
    die.append(el('span', { className: 'neco-dice-face', text: String(sides) }));
    return die;
}

function buildPanel() {
    const state = {
        action: '',
        rolling: false,
        result: null,
        timers: [],
    };

    const root = el('div', { className: 'neco-dice', dataset: { outcome: '' } });
    const burst = el('span', { className: 'neco-dice-burst', 'aria-hidden': 'true' });
    const tray = el('span', { className: 'neco-dice-tray' });
    const rollButton = el('button', {
        type: 'button',
        className: 'neco-dice-roll',
        'aria-label': 'Roll the dice',
        title: 'Roll the dice',
    }, [burst, tray]);
    const outcome = el('div', { className: 'neco-dice-outcome', text: 'Tap the dice to roll' });
    const breakdown = el('div', { className: 'neco-dice-breakdown', text: '' });
    const result = el('div', { className: 'neco-dice-result', 'aria-live': 'polite' }, [outcome, breakdown]);
    const stage = el('div', { className: 'neco-dice-stage' }, [rollButton, result]);

    const actionInput = el('input', {
        type: 'text',
        className: 'text_pole neco-dice-action',
        maxlength: '120',
        placeholder: 'Pick the lock, charm the guard...',
        autocomplete: 'off',
    });
    const actionField = el('label', { className: 'neco-dice-field' }, [
        el('span', { className: 'neco-dice-label', text: 'What are you attempting?' }),
        actionInput,
    ]);

    const targetText = el('span', { className: 'neco-dice-target-text' });
    const targetInput = el('input', {
        type: 'number',
        className: 'text_pole neco-dice-target-input',
        inputmode: 'numeric',
        'aria-label': 'Target number',
        title: 'Target number',
    });

    const renderTray = () => {
        tray.replaceChildren(...Array.from({ length: settings.count }, (_, index) => createDie(settings.sides, index)));
        tray.dataset.count = String(settings.count);
    };

    const syncTarget = () => {
        const { min, max } = getTotalRange(settings);
        targetInput.min = String(min);
        targetInput.max = String(max + 1);
        const target = resolveTarget(settings);
        if (settings.difficulty === 'custom') {
            targetInput.hidden = false;
            targetInput.value = String(target);
            targetText.textContent = `Need ${target}+ (${formatDiceNotation(settings)}, ${min}-${max})`;
        } else {
            targetInput.hidden = true;
            targetText.textContent = `Need ${target}+ (${formatDiceNotation(settings)}, ${min}-${max})`;
        }
    };

    const resetResult = () => {
        if (state.rolling) {
            return;
        }
        state.result = null;
        root.dataset.outcome = '';
        outcome.textContent = 'Tap the dice to roll';
        breakdown.textContent = '';
        sendButton.disabled = true;
        addButton.disabled = true;
    };

    const onSettingsChange = ({ redrawDice = false } = {}) => {
        saveSettings();
        if (redrawDice) {
            renderTray();
        }
        syncTarget();
        resetResult();
    };

    targetInput.addEventListener('change', () => {
        const { min, max } = getTotalRange(settings);
        const value = Math.min(max + 1, Math.max(min, Math.round(Number(targetInput.value) || 0)));
        settings.customTarget = value;
        onSettingsChange();
    });

    const dieField = el('div', { className: 'neco-dice-field' }, [
        el('span', { className: 'neco-dice-label', text: 'Die' }),
        createSegmented('Die', 'sides', DICE_SIDES.map(sides => ({ value: sides, label: `d${sides}` })), settings.sides, value => {
            settings.sides = normaliseSides(value);
            onSettingsChange({ redrawDice: true });
        }),
    ]);

    const countField = el('div', { className: 'neco-dice-field neco-dice-field-compact' }, [
        el('span', { className: 'neco-dice-label', text: 'Dice' }),
        createStepper('Dice', settings.count, 1, MAX_DICE, value => {
            settings.count = normaliseCount(value);
            onSettingsChange({ redrawDice: true });
        }),
    ]);

    const modifierField = el('div', { className: 'neco-dice-field neco-dice-field-compact' }, [
        el('span', { className: 'neco-dice-label', text: 'Bonus' }),
        createStepper('Bonus', settings.modifier, -MAX_MODIFIER, MAX_MODIFIER, value => {
            settings.modifier = normaliseModifier(value);
            onSettingsChange();
        }, formatModifier),
    ]);

    const difficultyField = el('div', { className: 'neco-dice-field' }, [
        el('span', { className: 'neco-dice-label', text: 'Difficulty' }),
        createSegmented('Difficulty', 'difficulty', [
            ...DIFFICULTIES.map(item => ({ value: item.id, label: item.label })),
            { value: 'custom', label: 'Custom', title: 'Set your own target number' },
        ], settings.difficulty, value => {
            if (value === 'custom' && settings.difficulty !== 'custom') {
                settings.customTarget = resolveTarget(settings);
            }
            settings.difficulty = value;
            onSettingsChange();
        }),
        el('div', { className: 'neco-dice-target' }, [targetText, targetInput]),
    ]);

    const modeField = el('div', { className: 'neco-dice-field' }, [
        el('span', { className: 'neco-dice-label', text: 'Luck' }),
        createSegmented('Luck', 'mode', Object.values(ROLL_MODES).map(mode => ({
            value: mode,
            label: MODE_LABELS[mode],
            title: mode === ROLL_MODES.ADVANTAGE ? 'Roll twice and keep the higher total' : mode === ROLL_MODES.DISADVANTAGE ? 'Roll twice and keep the lower total' : 'Roll once',
        })), settings.mode, value => {
            settings.mode = normaliseMode(value);
            onSettingsChange();
        }),
    ]);

    const addButton = el('button', {
        type: 'button',
        className: 'menu_button neco-dice-add',
        title: 'Put the result in the message box so you can add to it',
        disabled: true,
    }, [el('i', { className: 'fa-solid fa-pen', 'aria-hidden': 'true' }), el('span', { text: 'Add to message' })]);
    const sendButton = el('button', {
        type: 'button',
        className: 'menu_button menu_button_primary neco-dice-send',
        title: 'Send the result to the story now',
        disabled: true,
    }, [el('i', { className: 'fa-solid fa-paper-plane', 'aria-hidden': 'true' }), el('span', { text: 'Send' })]);
    const actions = el('div', { className: 'neco-dice-actions' }, [addButton, sendButton]);

    const controls = el('div', { className: 'neco-dice-controls' }, [
        actionField,
        dieField,
        el('div', { className: 'neco-dice-row' }, [countField, modifierField]),
        difficultyField,
        modeField,
    ]);
    root.append(stage, controls, actions);

    const clearTimers = () => {
        for (const timer of state.timers) {
            clearTimeout(timer);
            clearInterval(timer);
        }
        state.timers = [];
    };

    const showResult = (rolled) => {
        state.result = rolled;
        state.rolling = false;
        root.classList.remove('is-rolling');
        const faces = tray.querySelectorAll('.neco-dice-face');
        rolled.dice.forEach((value, index) => {
            if (faces[index]) {
                faces[index].textContent = String(value);
            }
        });
        const dice = tray.querySelectorAll('.neco-dice-die');
        dice.forEach((die, index) => {
            const value = rolled.dice[index];
            die.dataset.face = value === rolled.sides ? 'max' : value === 1 ? 'min' : '';
        });
        root.dataset.outcome = getOutcomeKey(rolled.outcome);
        outcome.replaceChildren(
            el('i', { className: `fa-solid ${OUTCOME_ICONS[rolled.outcome]}`, 'aria-hidden': 'true' }),
            el('span', { text: OUTCOME_LABELS[rolled.outcome] ?? rolled.outcome }),
        );
        const modifierText = rolled.modifier ? ` ${rolled.modifier > 0 ? '+' : '-'} ${Math.abs(rolled.modifier)}` : '';
        const dropped = rolled.droppedDice.length ? ` (other roll ${rolled.droppedDice.join(' + ')})` : '';
        breakdown.textContent = `${rolled.dice.join(' + ')}${modifierText} = ${rolled.total} vs ${rolled.target}${dropped}`;
        sendButton.disabled = false;
        addButton.disabled = false;
    };

    const roll = () => {
        if (state.rolling) {
            return;
        }
        clearTimers();
        const rolled = rollDice({
            ...settings,
            action: actionInput.value,
        });
        if (prefersReducedMotion()) {
            showResult(rolled);
            return;
        }
        state.rolling = true;
        root.dataset.outcome = '';
        root.classList.remove('is-rolling');
        void root.offsetWidth;
        root.classList.add('is-rolling');
        outcome.textContent = 'Rolling...';
        breakdown.textContent = '';
        sendButton.disabled = true;
        addButton.disabled = true;
        const faces = tray.querySelectorAll('.neco-dice-face');
        const flicker = setInterval(() => {
            for (const face of faces) {
                face.textContent = String(Math.floor(Math.random() * rolled.sides) + 1);
            }
        }, FLICKER_INTERVAL_MS);
        state.timers.push(flicker);
        state.timers.push(setTimeout(() => {
            clearInterval(flicker);
            showResult(rolled);
        }, ROLL_DURATION_MS + ((settings.count - 1) * 70)));
    };

    rollButton.addEventListener('click', roll);

    const getRollLine = () => (state.result ? formatRollLine({ ...state.result, action: actionInput.value }) : '');

    addButton.addEventListener('click', () => {
        const line = getRollLine();
        if (!line) {
            return;
        }
        insertIntoComposer(line);
        activePanel?.popup?.completeCancelled();
        focusComposer();
    });

    sendButton.addEventListener('click', async () => {
        const line = getRollLine();
        if (!line) {
            return;
        }
        insertIntoComposer(line);
        activePanel?.popup?.completeCancelled();
        await sendTextareaMessage();
    });

    actionInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            roll();
        }
    });

    renderTray();
    syncTarget();

    return {
        root,
        roll,
        focus: () => rollButton.focus({ preventScroll: true }),
        destroy: clearTimers,
    };
}

function getComposer() {
    return /** @type {HTMLTextAreaElement|null} */ (document.getElementById('send_textarea'));
}

function insertIntoComposer(line) {
    const composer = getComposer();
    if (!composer) {
        return;
    }
    const existing = composer.value.replace(/\s+$/u, '');
    composer.value = existing ? `${existing}\n${line}` : line;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
}

function focusComposer() {
    const composer = getComposer();
    if (!composer) {
        return;
    }
    composer.focus({ preventScroll: true });
    composer.setSelectionRange(composer.value.length, composer.value.length);
}

export async function openDicePanel() {
    if (activePanel) {
        activePanel.panel.focus();
        return;
    }
    loadSettings();
    const panel = buildPanel();
    const popup = new Popup(panel.root, POPUP_TYPE.DISPLAY, '', {
        allowVerticalScrolling: true,
        onOpen: () => {
            panel.focus();
            if (settings.rollOnOpen) {
                panel.roll();
            }
        },
    });
    popup.dlg.classList.add('neco-dice-popup');
    activePanel = { panel, popup };
    try {
        await popup.show();
    } finally {
        panel.destroy();
        activePanel = null;
    }
}

function createMenuButton() {
    const button = el('div', {
        id: WAND_BUTTON_ID,
        className: 'list-group-item flex-container flexGap5 interactable',
        tabindex: '0',
        role: 'button',
        title: 'Roll dice and send the result to the story',
    }, [
        el('div', { className: 'fa-solid fa-dice-d20 extensionsMenuExtensionButton', 'aria-hidden': 'true' }),
        el('span', { text: 'Roll dice' }),
    ]);
    const open = () => void openDicePanel();
    button.addEventListener('click', open);
    button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
        }
    });
    return button;
}

function ensureWandButton() {
    if (document.getElementById(WAND_BUTTON_ID)) {
        return;
    }
    const host = document.getElementById('dice_wand_container') ?? document.getElementById('extensionsMenu');
    host?.append(createMenuButton());
}

function ensureComposerButton() {
    const existing = document.getElementById(COMPOSER_BUTTON_ID);
    if (!settings.composerButton) {
        existing?.remove();
        return;
    }
    if (existing) {
        return;
    }
    const host = document.getElementById('leftSendForm');
    if (!host) {
        return;
    }
    const button = el('div', {
        id: COMPOSER_BUTTON_ID,
        className: 'fa-solid fa-dice-d20 interactable',
        role: 'button',
        tabindex: '0',
        title: 'Roll dice',
        'aria-label': 'Roll dice',
    });
    button.addEventListener('click', () => void openDicePanel());
    button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void openDicePanel();
        }
    });
    host.append(button);
}

function createCheckbox(key, label, hint) {
    const input = el('input', { type: 'checkbox', checked: settings[key] === true });
    input.addEventListener('change', () => {
        settings[key] = input.checked;
        saveSettings();
        if (key === 'composerButton') {
            ensureComposerButton();
        }
    });
    return el('label', { className: 'checkbox_label neco-dice-setting', title: hint }, [
        input,
        el('span', { text: label }),
    ]);
}

function ensureSettingsPanel() {
    if (document.getElementById(SETTINGS_ID)) {
        return;
    }
    const parent = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!parent) {
        return;
    }
    const content = el('div', { className: 'inline-drawer-content neco-dice-settings-content' }, [
        el('p', { className: 'neco-dice-settings-hint', text: 'Roll from the dice button beside the message box or from the wand menu. The result goes to the story as part of your message, and the AI writes what happens.' }),
        createCheckbox('composerButton', 'Dice button beside the message box', 'Show a dice button next to the message box'),
        createCheckbox('rollOnOpen', 'Roll as soon as the dice open', 'Roll straight away when you open the dice'),
        createCheckbox('criticals', 'Critical rolls', 'All dice on their highest face is a critical success; all ones is a critical failure'),
        createCheckbox('partials', 'Partial successes', 'Just missing the target still succeeds, with a cost'),
    ]);
    const drawer = el('div', { id: SETTINGS_ID, className: 'inline-drawer' }, [
        el('div', { className: 'inline-drawer-toggle inline-drawer-header' }, [
            el('b', { text: 'Dice Roller' }),
            el('div', { className: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
        ]),
        content,
    ]);
    parent.append(drawer);
}

function decorateTextNode(node) {
    const text = node.nodeValue ?? '';
    const rolls = parseRollLines(text);
    if (rolls.length === 0) {
        return;
    }
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const roll of rolls) {
        if (roll.index > cursor) {
            fragment.append(text.slice(cursor, roll.index));
        }
        const chip = el('span', {
            className: CHIP_CLASS,
            dataset: { outcome: getOutcomeKey(roll.outcome) },
            title: roll.details ? `${roll.details}` : undefined,
        }, [
            el('i', { className: `fa-solid ${OUTCOME_ICONS[roll.outcome] ?? 'fa-dice-d20'}`, 'aria-hidden': 'true' }),
            el('span', { text: roll.text }),
        ]);
        fragment.append(chip);
        cursor = roll.index + roll.text.length;
    }
    if (cursor < text.length) {
        fragment.append(text.slice(cursor));
    }
    node.replaceWith(fragment);
}

function decorateChat() {
    decorateFrame = 0;
    const chat = document.getElementById('chat');
    if (!chat) {
        return;
    }
    for (const messageText of chat.querySelectorAll('.mes[is_user="true"] .mes_text')) {
        if (!messageText.textContent?.includes('\u{1F3B2}')) {
            continue;
        }
        const walker = document.createTreeWalker(messageText, NodeFilter.SHOW_TEXT, {
            acceptNode: node => (node.parentElement?.closest(`.${CHIP_CLASS}`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
        });
        const nodes = [];
        while (walker.nextNode()) {
            nodes.push(walker.currentNode);
        }
        nodes.forEach(decorateTextNode);
    }
}

function scheduleDecorate() {
    if (decorateFrame) {
        return;
    }
    decorateFrame = requestAnimationFrame(decorateChat);
}

/**
 * Sets or clears the dice note for the next reply. Server replies pass no chat,
 * so the note is read from the saved chat instead.
 */
export function applyDiceDirective(chat, type) {
    const source = Array.isArray(chat) ? chat : getGenerationChat(savedChat, type);
    const message = findRollMessageForGeneration(source, type);
    const rolls = message ? parseRollLines(message.mes) : [];
    const directive = buildDiceDirective(rolls, name1);
    setExtensionPrompt(PROMPT_KEY, directive, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    return directive;
}

globalThis.necoDiceRollerInterceptor = async function (chat, _contextSize, _abort, type) {
    try {
        applyDiceDirective(chat, type);
    } catch (error) {
        console.warn('[Dice Roller] Could not add the dice result to the prompt.', error);
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
    }
};

export function activate() {
    if (initialised) {
        return;
    }
    initialised = true;
    loadSettings();
    ensureSettingsPanel();
    ensureWandButton();
    ensureComposerButton();
    for (const eventName of [event_types.USER_MESSAGE_RENDERED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_EDITED, event_types.MORE_MESSAGES_LOADED, event_types.CHAT_LOADED]) {
        if (eventName) {
            eventSource.on(eventName, scheduleDecorate);
        }
    }
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        scheduleDecorate();
    });
    scheduleDecorate();
}
