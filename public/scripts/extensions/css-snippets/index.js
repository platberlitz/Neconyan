import { registerCommands } from './src/commands.js';
import { applyCss, getCtx, loadSettings, removeCss, startWatching, stopWatching, tr } from './src/runtime.js';
import { closeManager, openManager } from './src/ui.js';

const BUTTON_ID = 'csss_manager_button';
const TOOLBAR_SELECTOR = '#CustomCSS-block .sb-settings-subdrawer-toolbar > .flex-container';
const OBSERVER_DEBOUNCE_MS = 150;

let active = false;
let observer = null;
let pending = null;
let readyHandler = null;
let closing = null;
let lifecycleGeneration = 0;

function onOpen(event) {
    event.preventDefault();
    event.stopPropagation();
    void openManager(event.currentTarget).catch(error => {
        console.error('[CSS Snippets] failed to open:', error);
        globalThis.toastr?.error(tr('Could not open CSS Snippets.'));
    });
}

function ensureButton() {
    const toolbar = document.querySelector(TOOLBAR_SELECTOR);
    if (!toolbar) {
        return;
    }
    let button = document.getElementById(BUTTON_ID);
    if (!button) {
        const label = tr('Snippets');
        const title = tr('Manage CSS snippets');
        button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.className = 'menu_button menu_button_icon margin0 csss-trigger';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.setAttribute('aria-haspopup', 'dialog');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-list-check';
        icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'csss-trigger-label';
        text.textContent = label;
        button.append(icon, text);
        button.addEventListener('click', onOpen);
    }
    if (button.parentElement !== toolbar) {
        toolbar.prepend(button);
    }
}

function install() {
    ensureButton();
    if (!observer) {
        observer = new MutationObserver(() => {
            if (pending !== null || document.getElementById(BUTTON_ID)?.isConnected) {
                return;
            }
            pending = setTimeout(() => {
                pending = null;
                if (active) {
                    ensureButton();
                }
            }, OBSERVER_DEBOUNCE_MS);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
}

async function init() {
    const generation = ++lifecycleGeneration;
    if (closing) {
        await closing;
    }
    if (generation !== lifecycleGeneration || active) {
        return;
    }
    active = true;
    const ctx = getCtx();
    loadSettings();
    applyCss();
    startWatching();
    registerCommands({ isActive: () => active, openManager: () => openManager() });
    readyHandler = () => {
        applyCss();
        install();
    };
    ctx.eventSource.on(ctx.eventTypes.APP_READY, readyHandler);
    install();
}

async function deactivate() {
    lifecycleGeneration++;
    if (!active) {
        return closing;
    }
    active = false;
    const ctx = getCtx();
    if (readyHandler) {
        ctx.eventSource.removeListener(ctx.eventTypes.APP_READY, readyHandler);
        readyHandler = null;
    }
    if (pending !== null) {
        clearTimeout(pending);
        pending = null;
    }
    observer?.disconnect();
    observer = null;
    stopWatching();
    removeCss();
    document.getElementById(BUTTON_ID)?.remove();
    const operation = closeManager();
    closing = operation;
    try {
        await operation;
    } finally {
        if (closing === operation) {
            closing = null;
        }
    }
}

export function activate() {
    return init();
}

export function enable() {
    return init();
}

export function disable() {
    return deactivate();
}
