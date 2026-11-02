import {
    chat,
    eventSource,
    event_types,
    extension_prompt_types,
    saveSettingsDebounced,
    sendTextareaMessage,
    setExtensionPrompt,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import {
    areAgentsGloballyEnabled,
    getAgentById,
    getCompanionConfig,
    isAgentEnabledForCurrentScope,
    isAgentHidden,
} from '../agent-store.js';
import {
    DICE_SIDES,
    DIFFICULTIES,
    MAX_DICE,
    MAX_MODIFIER,
    OUTCOMES,
    ROLL_MODES,
    formatDiceNotation,
    formatRollLine,
    getOutcomeKey,
    getTotalRange,
    normaliseCount,
    normaliseMode,
    normaliseModifier,
    normaliseSides,
    parseRollLines,
    resolveTarget,
    rollDice,
} from './dice.js';
import { setDiceCompanionRunner } from './dice-companion-local.js';
import {
    DICE_COMPANION_COMPOSER_REQUEST_EVENT,
    DICE_COMPANION_HOST_SELECTOR,
    DICE_COMPANION_HOSTS_CHANGED_EVENT,
    getDiceRunHint,
} from './dice-companion-view.js';

const SETTINGS_KEY = 'diceRoller';
const LEGACY_SETTINGS_KEY = 'dice-roller';
const LEGACY_PROMPT_KEY = 'neco_dice_roller';
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
let widget = null;
let initialised = false;
let hostsRefreshFrame = 0;
let decorateFrame = 0;
let autoRolled = false;

function prefersReducedMotion() {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

function getSettingsStore() {
    return extension_settings?.inChatAgents && typeof extension_settings.inChatAgents === 'object'
        ? extension_settings.inChatAgents
        : null;
}

function normaliseSettings(stored = {}) {
    const next = { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
    delete next.composerButton;
    delete next.introduced;
    next.sides = normaliseSides(next.sides);
    next.count = normaliseCount(next.count);
    next.modifier = normaliseModifier(next.modifier);
    next.mode = normaliseMode(next.mode);
    if (next.difficulty !== 'custom' && !DIFFICULTIES.some(item => item.id === next.difficulty)) {
        next.difficulty = DEFAULT_SETTINGS.difficulty;
    }
    next.criticals = next.criticals !== false;
    next.partials = next.partials !== false;
    next.rollOnOpen = next.rollOnOpen !== false;
    return next;
}

function loadSettings() {
    const store = getSettingsStore();
    const legacy = extension_settings?.[LEGACY_SETTINGS_KEY];
    const stored = store?.[SETTINGS_KEY] ?? (legacy && typeof legacy === 'object' ? legacy : null);
    settings = normaliseSettings(stored);
    if (!store?.[SETTINGS_KEY]) {
        saveSettings();
    }
}

function saveSettings() {
    if (!extension_settings || typeof extension_settings !== 'object') {
        return;
    }
    if (!getSettingsStore()) {
        extension_settings.inChatAgents = {};
    }
    extension_settings.inChatAgents[SETTINGS_KEY] = { ...settings };
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

function createCheckbox(key, label, hint) {
    const input = el('input', { type: 'checkbox', checked: settings[key] === true });
    input.addEventListener('change', () => {
        settings[key] = input.checked;
        saveSettings();
        widget?.onOptionsChanged?.(key);
    });
    return el('label', { className: 'checkbox_label neco-dice-setting', title: hint }, [
        input,
        el('span', { text: label }),
    ]);
}

function buildWidget() {
    const state = {
        rolling: false,
        result: null,
        timers: [],
        agentId: '',
    };

    const root = el('div', { className: 'neco-dice', dataset: { outcome: '' } });
    const status = el('p', { className: 'neco-dice-companion-status', role: 'status', hidden: true });
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
        } else {
            targetInput.hidden = true;
        }
        targetText.textContent = `Need ${target}+ (${formatDiceNotation(settings)}, ${min}-${max})`;
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

    const options = el('details', { className: 'neco-dice-options' }, [
        el('summary', { text: 'Roll options' }),
        createCheckbox('criticals', 'Critical rolls', 'All dice on their highest face is a critical success; all ones is a critical failure'),
        createCheckbox('partials', 'Partial successes', 'Just missing the target still succeeds, with a cost'),
        createCheckbox('rollOnOpen', 'Roll when the Companion panel opens', 'Roll straight away the first time the dice appear in a panel or window'),
    ]);

    const controls = el('div', { className: 'neco-dice-controls' }, [
        actionField,
        dieField,
        el('div', { className: 'neco-dice-row' }, [countField, modifierField]),
        difficultyField,
        modeField,
        options,
    ]);
    root.append(status, stage, controls, actions);

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
            return state.result;
        }
        clearTimers();
        const rolled = rollDice({
            ...settings,
            action: actionInput.value,
        });
        if (prefersReducedMotion()) {
            showResult(rolled);
            return rolled;
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
        return rolled;
    };

    rollButton.addEventListener('click', roll);

    const getRollLine = () => (state.result ? formatRollLine({ ...state.result, action: actionInput.value }) : '');

    addButton.addEventListener('click', () => {
        const line = getRollLine();
        if (!line) {
            return;
        }
        insertIntoComposer(line);
        // The phone panel covers the composer. A deliberate Add reveals it, but
        // only the panel hosting this widget, never an unrelated window.
        const host = root.closest?.(DICE_COMPANION_HOST_SELECTOR);
        if (host?.dataset?.necoDiceSurface === 'panel') {
            globalThis.document?.dispatchEvent?.(new Event(DICE_COMPANION_COMPOSER_REQUEST_EVENT));
        }
        focusComposer();
    });

    sendButton.addEventListener('click', async () => {
        const line = getRollLine();
        if (!line) {
            return;
        }
        insertIntoComposer(line);
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
        state,
        roll,
        getLine: getRollLine,
        focus: () => rollButton.focus({ preventScroll: true }),
        destroy: clearTimers,
        resetForChat() {
            clearTimers();
            state.rolling = false;
            state.result = null;
            root.classList.remove('is-rolling');
            root.dataset.outcome = '';
            outcome.textContent = 'Tap the dice to roll';
            breakdown.textContent = '';
            actionInput.value = '';
            sendButton.disabled = true;
            addButton.disabled = true;
        },
        onOptionsChanged: key => {
            if (key === 'criticals' || key === 'partials') {
                resetResult();
            }
        },
        syncAvailability(agent) {
            const globallyEnabled = areAgentsGloballyEnabled();
            const enabledForScope = agent ? isAgentEnabledForCurrentScope(agent) : false;
            const hidden = agent ? isAgentHidden(agent.id) : false;
            rollButton.disabled = !globallyEnabled || !enabledForScope;
            if (!globallyEnabled) {
                status.hidden = false;
                status.textContent = 'Agents are off. Turn them on in Agents to roll for a reply.';
            } else if (!enabledForScope) {
                status.hidden = false;
                status.textContent = 'This companion is off.';
            } else if (hidden) {
                status.hidden = false;
                status.textContent = 'This companion is hidden, so the next reply will not see the roll.';
            } else {
                status.hidden = true;
                status.textContent = '';
            }
            if (rollButton.disabled) {
                sendButton.disabled = true;
                addButton.disabled = true;
            } else if (state.result) {
                sendButton.disabled = false;
                addButton.disabled = false;
            }
        },
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

function ensureWidget() {
    if (!widget) {
        widget = buildWidget();
    }
    return widget;
}

function isHostVisible(host, messageIndex) {
    if (!host?.isConnected) {
        return false;
    }
    const panel = host.closest('#ica--tracker-panel');
    if (panel) {
        if (panel.getAttribute('aria-hidden') === 'true') {
            return false;
        }
        const currentChat = chat?.[messageIndex];
        if (currentChat && chat.indexOf(currentChat) !== messageIndex) {
            return false;
        }
    }
    if (host.closest('[hidden]')) {
        return false;
    }
    const windowLayer = host.closest('.ica--cwin-layer');
    if (windowLayer?.hidden) {
        return false;
    }
    const windowSection = host.closest('.ica--cwin');
    if (windowSection) {
        if (windowSection.hidden
            || windowSection.getAttribute('aria-hidden') === 'true'
            || windowSection.dataset.collapsed === 'true'
            || windowSection.dataset.temporaryCollapse === 'true') {
            return false;
        }
    }
    return true;
}

function chooseHost() {
    const hosts = [...document.querySelectorAll(DICE_COMPANION_HOST_SELECTOR)];
    let best = null;
    let bestRank = -1;
    let bestMessageIndex = -1;
    for (const host of hosts) {
        const surface = host.dataset.necoDiceSurface || 'card';
        const messageIndex = Number(host.dataset.necoDiceMessageIndex ?? -1);
        if (!isHostVisible(host, messageIndex)) {
            continue;
        }
        const rank = surface === 'window' ? 3 : surface === 'panel' ? 2 : 1;
        if (rank > bestRank || (rank === bestRank && messageIndex > bestMessageIndex)) {
            best = host;
            bestRank = rank;
            bestMessageIndex = messageIndex;
        }
    }
    return best;
}

function syncHost() {
    if (!widget || !document?.body) {
        return;
    }
    const host = chooseHost();
    if (!host) {
        if (widget.root.isConnected) {
            widget.root.remove();
        }
        return;
    }

    const agentId = host.dataset.necoDiceAgent || '';
    const agent = getAgentById(agentId);
    widget.state.agentId = agentId;
    widget.syncAvailability(agent);

    if (widget.root.parentElement !== host) {
        host.append(widget.root);
    }

    const surface = host.dataset.necoDiceSurface || 'card';
    if (!autoRolled && surface !== 'card' && settings.rollOnOpen && !widget.state.result && !widget.state.rolling) {
        autoRolled = true;
        globalThis.setTimeout(() => widget?.roll(), 0);
    }
}

function scheduleHostSync() {
    if (hostsRefreshFrame) {
        return;
    }
    hostsRefreshFrame = requestAnimationFrame(() => {
        hostsRefreshFrame = 0;
        syncHost();
    });
}

function syncAfterAgentChange() {
    scheduleHostSync();
}

function handleLocalRun(agentId, messageIndex = -1) {
    const agent = getAgentById(agentId);
    if (!agent || !widget || !areAgentsGloballyEnabled() || !isAgentEnabledForCurrentScope(agent)) {
        return null;
    }
    widget.state.agentId = agentId;
    widget.syncAvailability(agent);
    const rolled = widget.roll();
    if (rolled && !widget.root.isConnected) {
        globalThis.toastr?.info?.(`Rolled ${rolled.total} vs ${rolled.target}. ${getDiceRunHint(getCompanionConfig(agent).displayMode)}`);
    }
    return { agentId, messageIndex, changed: false, local: true, result: null };
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
    const chatRoot = document.getElementById('chat');
    if (!chatRoot) {
        return;
    }
    for (const messageText of chatRoot.querySelectorAll('.mes[is_user="true"] .mes_text')) {
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
 * Starts the Dice Roller companion widget and the roll chips in sent messages.
 * Safe to call more than once.
 */
export function initDiceRollerCompanion() {
    if (initialised) {
        return;
    }
    initialised = true;
    loadSettings();
    ensureWidget();
    setDiceCompanionRunner(handleLocalRun);
    setExtensionPrompt(LEGACY_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
    for (const eventName of [
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_EDITED,
        event_types.MORE_MESSAGES_LOADED,
        event_types.CHAT_LOADED,
        event_types.CHARACTER_MESSAGE_RENDERED,
    ]) {
        if (eventName) {
            eventSource.on(eventName, scheduleDecorate);
        }
    }
    eventSource.on(event_types.CHAT_CHANGED, () => {
        autoRolled = false;
        widget?.resetForChat();
        setExtensionPrompt(LEGACY_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        scheduleDecorate();
        scheduleHostSync();
    });
    document.addEventListener(DICE_COMPANION_HOSTS_CHANGED_EVENT, scheduleHostSync);
    document.addEventListener('neconyan:agents-changed', syncAfterAgentChange);
    document.addEventListener('toggle', event => {
        const target = event.target;
        if (target?.matches?.('.ica--companion-card') || target?.closest?.('.ica--companion-card')) {
            scheduleHostSync();
        }
    }, true);
    scheduleDecorate();
    scheduleHostSync();
}
