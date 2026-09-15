import { isEngineAvailable } from './src/engine-gate.js';
import { getSettings } from './src/settings.js';
import { teardownRegistrations } from './src/registration.js';
import { recordCharMessage, recordGeneration, recordSwipe, recordUserMessage } from './src/chat-state.js';
import { registerUtilityMacros } from './src/utility-macros.js';
import { registerStateMacros } from './src/state-macros.js';
import { registerLogicMacros } from './src/logic-macros.js';
import { registerChatVarMacros } from './src/chatvar-macros.js';
import { disableCompatMode, registerCompatMacros, syncCompatMode } from './src/compat-macros.js';
import { disableImportFixes, syncImportFixes } from './src/import-fixes.js';
import { registerDateMacros } from './src/date-macros.js';
import { registerLorebookMacros } from './src/lorebook-macros.js';
import { registerPronounMacros } from './src/pronoun-macros.js';
import { clearCache, prewarm, indexBook, setActiveEntries } from './src/lorebook-cache.js';
import { syncRegistrations, teardownCustomRegistrations } from './src/custom/registrar.js';
import { registerCommands, setCommandsActive } from './src/commands.js';
import { removeDrawer, renderDrawer } from './src/drawer-ui.js';
import { closeWorkbench } from './src/workbench/panel.js';

const subscriptions = [];
let initialized = false;
let macrosRegistered = false;
/** @type {boolean|null} engine availability at the last drawer render */
let lastRenderedAvailability = null;

function renderDrawerTracked() {
    const engineAvailable = isEngineAvailable();
    lastRenderedAvailability = engineAvailable;
    renderDrawer({ engineAvailable });
}

function subscribe(eventType, handler) {
    if (!eventType) {
        return;
    }
    const { eventSource } = SillyTavern.getContext();
    eventSource.on(eventType, handler);
    subscriptions.push({ eventType, handler });
}

function activateMacros() {
    if (macrosRegistered || !isEngineAvailable()) {
        return;
    }
    macrosRegistered = true;
    registerUtilityMacros();
    registerStateMacros();
    // Before the logic pack: {{and}}/{{or}} ask compat mode how to read an argument.
    registerCompatMacros();
    registerLogicMacros();
    registerChatVarMacros();
    registerDateMacros();
    registerLorebookMacros();
    registerPronounMacros();
    syncRegistrations();
    syncCompatMode(getSettings().compatExpressions);
    syncImportFixes(getSettings().fixImportedSyntax);
    const ctx = SillyTavern.getContext();
    prewarm(ctx);
}

export function init() {
    if (initialized) {
        setCommandsActive(true);
        activateMacros();
        registerCommands();
        renderDrawerTracked();
        return;
    }

    initialized = true;
    setCommandsActive(true);
    const ctx = SillyTavern.getContext();
    const events = ctx.eventTypes;

    getSettings();
    activateMacros();
    registerCommands();
    renderDrawerTracked();

    subscribe(events.APP_READY, () => {
        if (!initialized) {
            return;
        }
        activateMacros();
        registerCommands();
        renderDrawerTracked();
        if (macrosRegistered) {
            prewarm(SillyTavern.getContext());
        }
    });

    // Hot-activate when the experimental engine flag is switched on after boot, and
    // re-render whenever availability changes in either direction (macros stay
    // registered while the flag is off, so macrosRegistered can't track this).
    subscribe(events.SETTINGS_UPDATED, () => {
        if (!initialized) {
            return;
        }
        const available = isEngineAvailable();
        if (available && !macrosRegistered) {
            activateMacros();
        }
        if (available !== lastRenderedAvailability) {
            renderDrawerTracked();
        }
    });

    subscribe(events.CHAT_CHANGED, () => {
        if (!initialized || !macrosRegistered) {
            return;
        }
        closeWorkbench();
        const liveCtx = SillyTavern.getContext();
        prewarm(liveCtx);
        // Character-scoped custom macros follow the chat.
        syncRegistrations();
        renderDrawerTracked();
    });

    // Counters for {{usermsgcount}}/{{sticky}}/etc. — maintained only from events,
    // never from macro evaluation, so prompt builds and dry runs cannot drift them.
    subscribe(events.MESSAGE_SENT, () => {
        if (initialized && macrosRegistered) {
            recordUserMessage();
        }
    });

    subscribe(events.MESSAGE_RECEIVED, () => {
        if (initialized && macrosRegistered) {
            recordCharMessage();
        }
    });

    subscribe(events.MESSAGE_SWIPED, () => {
        if (initialized && macrosRegistered) {
            recordSwipe();
        }
    });

    subscribe(events.GENERATION_STARTED, (_type, _params, isDryRun) => {
        if (initialized && macrosRegistered && !isDryRun) {
            recordGeneration();
        }
    });

    subscribe(events.WORLDINFO_SETTINGS_UPDATED, () => {
        if (initialized && macrosRegistered) {
            prewarm(SillyTavern.getContext());
        }
    });

    subscribe(events.WORLDINFO_UPDATED, (name, data) => {
        if (initialized && macrosRegistered && name && data) {
            indexBook(name, data);
        }
    });

    subscribe(events.WORLD_INFO_ACTIVATED, (entries) => {
        if (initialized && macrosRegistered) {
            setActiveEntries(entries);
        }
    });
}

export function deactivate() {
    if (!initialized) {
        return;
    }
    initialized = false;

    setCommandsActive(false);
    closeWorkbench();
    // Pre-processors are not swept by unregisterMacrosBySource; they have to go
    // back explicitly or they outlive the disabled extension.
    disableCompatMode();
    disableImportFixes();
    teardownCustomRegistrations();
    teardownRegistrations();
    macrosRegistered = false;
    lastRenderedAvailability = null;
    clearCache();
    removeDrawer();

    const { eventSource } = SillyTavern.getContext();
    while (subscriptions.length) {
        const { eventType, handler } = subscriptions.pop();
        eventSource.removeListener(eventType, handler);
    }
}
