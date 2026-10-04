/**
 * Story Mode: NovelAI-style co-writing on top of the normal Neconyan chat.
 * The chat is the manuscript (one message = one block); this file only wires
 * the host's events to src/api.js (host I/O) and src/ui.js (DOM).
 */
import * as api from './src/api.js';
import * as ui from './src/ui.js';
import { BODY_CLASS, parseStoryArg } from './src/core.js';

const subscriptions = [];
let active = false;
let mounted = false;
let changingMode = false;
let observer = null;
let busyObserver = null;
let stampFrame = 0;
let modeLifecycle = null;

function registerModeLifecycle() {
    const lifecycles = globalThis.NeconyanModeLifecycle || {};
    modeLifecycle = {
        setEnabled: (enabled, options = {}) => setEnabled(enabled, { renderDrawer: true, ...options }),
        isBusy: () => api.isBusy(),
    };
    lifecycles.story = modeLifecycle;
    globalThis.NeconyanModeLifecycle = lifecycles;
}

function unregisterModeLifecycle() {
    if (globalThis.NeconyanModeLifecycle?.story === modeLifecycle) {
        delete globalThis.NeconyanModeLifecycle.story;
    }
    modeLifecycle = null;
}

function ctx() {
    return globalThis.SillyTavern.getContext();
}

function subscribe(context, eventType, handler) {
    if (!eventType) {
        return;
    }
    context.eventSource.on(eventType, handler);
    subscriptions.push({ eventType, handler });
}

function unsubscribeAll() {
    const context = ctx();
    for (const { eventType, handler } of subscriptions.splice(0)) {
        context.eventSource.removeListener(eventType, handler);
    }
}

function assertCapabilities(context) {
    const missing = [];
    for (const [name, available] of [
        ['extension settings', context.extensionSettings && typeof context.saveSettingsDebounced === 'function'],
        ['event source', typeof context.eventSource?.on === 'function' && typeof context.eventSource?.removeListener === 'function'],
        ['chat metadata', typeof context.saveMetadata === 'function'],
        ['generation', typeof context.generate === 'function' && typeof context.generateRaw === 'function' && typeof context.generateQuietPrompt === 'function'],
        ['request-specific generation controls', context.generationSupportsRequestControls === true],
        ['prompt injection', typeof context.setExtensionPrompt === 'function'],
        ['message editing', typeof context.updateMessageBlock === 'function' && typeof context.deleteLastMessage === 'function' && typeof context.addOneMessage === 'function' && typeof context.saveChat === 'function'],
        ['swipes', typeof context.swipe?.to === 'function'],
        ['card fields', typeof context.writeExtensionField === 'function'],
        ['message formatting', typeof context.messageFormatting === 'function'],
    ]) {
        if (!available) {
            missing.push(name);
        }
    }
    for (const event of ['APP_READY', 'CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_EDITED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED']) {
        if (!context.eventTypes?.[event]) {
            missing.push(`event ${event}`);
        }
    }
    if (missing.length > 0) {
        throw new Error(`Unsupported Neconyan context; missing ${missing.join(', ')}`);
    }
}

function scheduleStamp() {
    if (!document.body.classList.contains(BODY_CLASS)) {
        return;
    }
    cancelAnimationFrame(stampFrame);
    stampFrame = requestAnimationFrame(() => {
        if (!document.body.classList.contains(BODY_CLASS)) {
            return;
        }
        try {
            ui.stampBlocks();
            ui.refreshBar();
        } catch (error) {
            console.warn('[Story Mode] stamping failed', error);
        }
    });
}

/** Re-resolves the per-chat state and makes the page match it. */
function apply({ renderDrawer = true } = {}) {
    if (!active) {
        return;
    }
    const enabled = api.isEnabled();
    if (enabled) {
        api.setRules();
    } else {
        api.clearRules();
        api.clearDirection();
    }
    api.applyAgentGate();
    ui.applyState(enabled);
    window.dispatchEvent(new CustomEvent('neconyan:story-state-changed', { detail: { enabled } }));
    if (renderDrawer) {
        ui.renderDrawer();
    }
}

async function setEnabled(enabled, { renderDrawer = false, presentationOnly = false, navigationGuard = () => true } = {}) {
    if (!navigationGuard()) return false;
    if (!active || changingMode) return false;
    if (api.isBusy()) {
        api.toast('info', 'Let the current reply finish before changing Story Mode.');
        return false;
    }
    if (!api.hasChat()) {
        api.toast('info', 'Open a chat first, then turn Story Mode on.');
        ui.renderDrawer();
        return false;
    }
    changingMode = true;
    try {
        if (presentationOnly) {
            if (!api.presentChat(enabled)) return false;
        } else if (!await api.setChatFlag(enabled)) return false;
    } catch (error) {
        console.error('[Story Mode] mode preference was not saved', error);
        api.toast('error', 'Story Mode could not save this chat preference. Try again.');
        ui.renderDrawer();
        return false;
    } finally {
        changingMode = false;
    }
    if (!navigationGuard()) return false;
    if (enabled && document.body.classList.contains('neconyan')) {
        window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
        window.dispatchEvent(new CustomEvent('neconyan:open-story'));
    }
    apply({ renderDrawer });
    return true;
}

async function onStoryCommand(arg) {
    if (!active) {
        return 'Story Mode is disabled.';
    }
    const next = parseStoryArg(arg, api.isEnabled());
    if (next === null) {
        return 'Use /story on, /story off or /story toggle.';
    }
    if (!api.hasChat()) {
        return 'Open a chat first.';
    }
    if (!await setEnabled(next, { renderDrawer: true })) return 'Story Mode preference was not saved.';
    return next ? 'on' : 'off';
}

function observeChat() {
    const chat = document.getElementById('chat');
    if (!chat || observer) {
        return;
    }
    observer = new MutationObserver(() => {
        ui.checkEditor();
        // Streaming mutates the last block on every chunk; the end-of-generation hook stamps once instead.
        if (document.body.dataset.generating !== 'true') {
            scheduleStamp();
        }
    });
    observer.observe(chat, { childList: true, subtree: true });
    ui.checkEditor();
    ui.refreshTransformRow();
}

/** Follow the host markers as well as its completion events. */
function observeBusy() {
    const sendForm = document.getElementById('send_form');
    if (busyObserver || !sendForm) {
        return;
    }
    busyObserver = new MutationObserver(() => api.refreshBusy());
    busyObserver.observe(document.body, { attributes: true, attributeFilter: ['data-generating'] });
    busyObserver.observe(sendForm, { attributes: true, attributeFilter: ['class'] });
}

function mountAll() {
    // APP_READY is sticky (the host replays it to late subscribers), so the
    // subscription and the direct fallback below both arrive here: mount once.
    if (mounted) {
        return;
    }
    mounted = true;
    ui.mountBar();
    ui.mountTransformRow();
    ui.bindClickToEdit();
    ui.bindEscapeSave();
    ui.bindSelectionWatch();
    ui.ensureMenuItem({ onToggle: enabled => setEnabled(typeof enabled === 'boolean' ? enabled : !api.isEnabled(), { renderDrawer: true }) });
    ui.ensureDrawer({ onChatToggle: setEnabled, onChange: () => apply() });
    observeChat();
    observeBusy();
    api.registerCommands({ onToggle: onStoryCommand });
    apply();
    ui.setBusy(api.isBusy());
}

function start() {
    if (active) {
        return;
    }
    const context = ctx();
    assertCapabilities(context);
    const events = context.eventTypes;
    active = true;
    registerModeLifecycle();
    try {
        api.setHooks({
            afterGeneration: (action) => {
                if (!active) {
                    api.clearRules();
                    api.clearDirection();
                    return;
                }
                if (action.success) ui.clearDirectionInput(action.direction);
                ui.reportGenerationResult(action);
                scheduleStamp();
            },
            busyChanged: (busy) => active && ui.setBusy(busy),
        });
        subscribe(context, events.APP_READY, () => {
            try {
                mountAll();
            } catch (error) {
                console.error('[Story Mode] could not mount', error);
            }
        });
        subscribe(context, events.CHAT_CHANGED, () => {
            api.clearRedo();
            api.clearDirection();
            ui.clearDirectionInput();
            ui.cancelTransform();
            ui.cleanupStamps();
            ui.setBusy(api.isBusy());
            apply();
        });
        subscribe(context, events.MESSAGE_SENT, (index) => {
            api.onMessageSent(index);
            api.clearRedoIfDiverged();
        });
        subscribe(context, events.MESSAGE_EDITED, (index) => {
            api.onMessageEdited(index);
            api.clearRedoIfDiverged();
            scheduleStamp();
        });
        for (const name of ['MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_RECEIVED']) {
            subscribe(context, events[name], () => {
                api.clearRedoIfDiverged();
                scheduleStamp();
            });
        }
        subscribe(context, events.GENERATION_STARTED, (type, options, dryRun) => {
            api.onGenerationStarted(type, options, dryRun);
            // Agents gate: re-assert before every generation (the user may have flipped an agent in the Agents tab).
            if (!dryRun) {
                api.applyAgentGate();
            }
        });
        subscribe(context, events.GENERATION_ENDED, api.refreshBusy);
        subscribe(context, events.GENERATION_STOPPED, api.refreshBusy);
        void api.loadAgentStore().then((store) => {
            if (active && store) {
                api.applyAgentGate();
                ui.renderDrawer();
            }
        });
        for (const name of ['MORE_MESSAGES_LOADED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED']) {
            subscribe(context, events[name], scheduleStamp);
        }
        // Fallback for a host without a sticky APP_READY; mountAll() itself runs once.
        if (document.getElementById('send_form')) {
            mountAll();
        }
    } catch (error) {
        active = false;
        unregisterModeLifecycle();
        mounted = false;
        unsubscribeAll();
        observer?.disconnect();
        observer = null;
        busyObserver?.disconnect();
        busyObserver = null;
        cancelAnimationFrame(stampFrame);
        api.releaseAgentGate();
        ui.unmountAll();
        throw error;
    }
}

async function stop() {
    active = false;
    unregisterModeLifecycle();
    mounted = false;
    unsubscribeAll();
    observer?.disconnect();
    observer = null;
    busyObserver?.disconnect();
    busyObserver = null;
    cancelAnimationFrame(stampFrame);
    try {
        api.releaseAgentGate();
        if (!api.isInflight()) {
            api.clearRules();
            api.clearDirection();
        }
        api.clearRedo();
    } catch (error) {
        console.warn('[Story Mode] cleanup skipped a step', error);
    }
    ui.unmountAll();
}

export function activate() {
    start();
}

export function enable() {
    start();
}

export function setEnabledForNeconyan(enabled) {
    return setEnabled(Boolean(enabled), { renderDrawer: true });
}

export function disable() {
    return stop();
}
