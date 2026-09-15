import { installHook, setHookActive, uninstallHook } from './src/hook.js';
import { registerCommands, setCommandsActive } from './src/commands.js';
import { removeSettings, renderSettings } from './src/ui.js';
import { getSettings } from './src/settings.js';
import { flushPresetWrites, invalidatePresetCache } from './src/preset-store.js';

let refresh = () => {};
const subscriptions = [];
let initialized = false;
let pagehideHandler = null;

const requestPresetFlush = () => flushPresetWrites().catch(() => {});

function subscribe(eventType, handler) {
    if (!eventType) {
        return;
    }
    const { eventSource } = SillyTavern.getContext();
    eventSource.on(eventType, handler);
    subscriptions.push({ eventType, handler });
}

export function init() {
    if (initialized) {
        const renderedRefresh = renderSettings();
        if (typeof renderedRefresh === 'function') {
            refresh = renderedRefresh;
        }
        setHookActive(true);
        registerCommands(() => refresh());
        installHook();
        requestPresetFlush();
        return;
    }

    initialized = true;
    setCommandsActive(true);
    setHookActive(true);
    const ctx = SillyTavern.getContext();
    const events = ctx.eventTypes;

    getSettings();
    const renderedRefresh = renderSettings();
    if (typeof renderedRefresh === 'function') {
        refresh = renderedRefresh;
    }

    registerCommands(() => refresh());

    installHook();

    // The prompt manager is built lazily, so it may not exist yet when the app boots on
    // Text Completion. Re-attempting is cheap and idempotent.
    const retry = () => {
        if (!initialized) {
            return;
        }
        // Equipping another preset swaps the stored rules and the prompt list behind them.
        requestPresetFlush();
        invalidatePresetCache();
        installHook();
        registerCommands(() => refresh());
        refresh();
    };
    subscribe(events.APP_READY, retry);
    subscribe(events.MAIN_API_CHANGED, retry);
    subscribe(events.CHATCOMPLETION_SOURCE_CHANGED, retry);
    subscribe(events.SETTINGS_UPDATED, retry);
    subscribe(events.PRESET_CHANGED, retry);

    pagehideHandler = () => { requestPresetFlush(); };
    globalThis.addEventListener?.('pagehide', pagehideHandler);

    // Character and chat scoped profiles change what is in force.
    subscribe(events.CHAT_CHANGED, () => {
        if (!initialized) {
            return;
        }
        requestPresetFlush();
        invalidatePresetCache();
        installHook();
        refresh();
    });
}

export async function deactivate() {
    if (!initialized) {
        return;
    }

    initialized = false;
    setCommandsActive(false);
    setHookActive(false);
    uninstallHook();

    if (pagehideHandler) {
        globalThis.removeEventListener?.('pagehide', pagehideHandler);
        pagehideHandler = null;
    }

    const presetFlush = requestPresetFlush();

    removeSettings();

    const { eventSource } = SillyTavern.getContext();
    while (subscriptions.length) {
        const { eventType, handler } = subscriptions.pop();
        eventSource.removeListener(eventType, handler);
    }

    refresh = () => {};
    await presetFlush;
}
