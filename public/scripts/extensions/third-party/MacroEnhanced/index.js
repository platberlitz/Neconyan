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
import { onPronounsChanged, registerPronounMacros } from './src/pronoun-macros.js';
import { mountPersonaPronounField, renderPersonaPronounField, unmountPersonaPronounField } from './src/persona-pronoun-field.js';
import { clearCache, prewarm, indexBook, setActiveEntries } from './src/lorebook-cache.js';
import { syncRegistrations, teardownCustomRegistrations } from './src/custom/registrar.js';
import { isBrowserStoreKey } from './src/custom/browser-store.js';
import { registerCommands, setCommandsActive } from './src/commands.js';
import { removeDrawer, renderDrawer } from './src/drawer-ui.js';
import { closeWorkbench } from './src/workbench/panel.js';
import { onMacroDataChanged } from './src/data-events.js';
import { appChatChanged, appSettingsUpdated, refreshApp } from './src/ui/app-loader.js';
import { createRefreshQueue } from './src/ui/refresh-queue.js';

const subscriptions = [];
let initialized = false;
/** @type {(() => void)|null} stops the page following pronoun writes */
let stopPronounSync = null;
/** @type {(() => void)|null} stops the page following data writes */
let stopDataSync = null;
/** @type {(() => void)|null} stops the page following other tabs' browser macros */
let stopBrowserStoreSync = null;
let macrosRegistered = false;
/** @type {boolean|null} engine availability at the last page mount */
let lastRenderedAvailability = null;
const appRefreshes = createRefreshQueue(kind => {
    if (initialized) {
        refreshApp(kind);
    }
});

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

/**
 * Browser-scoped macros belong to this browser, not the server. A write in
 * another tab arrives as a storage event; the registry and the page have to
 * follow it the same way an editor save does.
 */
function startBrowserStoreSync() {
    if (stopBrowserStoreSync) {
        return;
    }
    const win = globalThis.window;
    if (typeof win?.addEventListener !== 'function') {
        return;
    }
    const onStorage = event => {
        if (!initialized) {
            return;
        }
        if (event?.key !== null && !isBrowserStoreKey(event.key)) {
            return;
        }
        if (macrosRegistered) {
            syncRegistrations();
        }
        appRefreshes.push('macros');
    };
    win.addEventListener('storage', onStorage);
    stopBrowserStoreSync = () => win.removeEventListener('storage', onStorage);
}

/**
 * The page and the Persona page edit the same persona pronouns. A write from
 * either side (or from {{setpronouns}}) refreshes the other view.
 */
function startPronounSync() {
    mountPersonaPronounField();
    if (!stopPronounSync) {
        stopPronounSync = onPronounsChanged(() => {
            appRefreshes.push('pronouns');
        });
    }
    if (!stopDataSync) {
        stopDataSync = onMacroDataChanged(kind => {
            appRefreshes.push(kind);
        });
    }
}

export function init() {
    if (initialized) {
        setCommandsActive(true);
        activateMacros();
        registerCommands();
        renderDrawerTracked();
        startPronounSync();
        startBrowserStoreSync();
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
    startPronounSync();
    startBrowserStoreSync();

    // The page and the Persona page both show the selected persona's pronouns.
    for (const personaEvent of [events.PERSONA_CHANGED, events.PERSONA_CREATED, events.PERSONA_DELETED]) {
        subscribe(personaEvent, () => {
            if (!initialized) {
                return;
            }
            renderPersonaPronounField();
            appRefreshes.push('persona');
        });
    }

    subscribe(events.APP_READY, () => {
        if (!initialized) {
            return;
        }
        activateMacros();
        registerCommands();
        renderDrawerTracked();
        if (macrosRegistered) {
            // The account handle is final by APP_READY, so the browser layer can
            // switch to that account's definitions without reloading the page.
            syncRegistrations();
            prewarm(SillyTavern.getContext());
        }
    });

    // Hot-activate when the engine flag is switched on after boot, and refresh
    // whenever availability changes in either direction (macros stay registered
    // while the flag is off, so macrosRegistered cannot track this).
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
        if (macrosRegistered) {
            // A settings load or account refresh can change which handle owns the
            // browser scope. Re-read it instead of serving the previous account.
            syncRegistrations();
        }
        appSettingsUpdated();
    });

    subscribe(events.CHAT_CHANGED, () => {
        if (!initialized) {
            return;
        }
        // A {{setpronouns}} override belongs to one chat, so its notice follows the chat.
        renderPersonaPronounField();
        if (macrosRegistered) {
            const liveCtx = SillyTavern.getContext();
            prewarm(liveCtx);
            // Character-scoped custom macros follow the chat.
            syncRegistrations();
        }
        closeWorkbench();
        appChatChanged();
    });

    // Counters for {{usermsgcount}}/{{sticky}}/etc. are maintained only from
    // events, never from macro evaluation, so prompt builds and dry runs cannot
    // drift them.
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
    appRefreshes.clear();
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
    stopPronounSync?.();
    stopPronounSync = null;
    stopDataSync?.();
    stopDataSync = null;
    stopBrowserStoreSync?.();
    stopBrowserStoreSync = null;
    unmountPersonaPronounField();

    const { eventSource } = SillyTavern.getContext();
    while (subscriptions.length) {
        const { eventType, handler } = subscriptions.pop();
        eventSource.removeListener(eventType, handler);
    }
}
