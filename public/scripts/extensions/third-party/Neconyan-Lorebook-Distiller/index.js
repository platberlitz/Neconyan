import { closeDistiller, openDistiller } from './src/ui.js';

const MENU_ITEM_ID = 'sbld-menu-item';

let active = false;
let readyHandler = null;

function onOpen(event) {
    event.preventDefault();
    event.stopPropagation();
    const ctx = globalThis.SillyTavern.getContext();
    void openDistiller(ctx, event.currentTarget).catch((error) => {
        console.error('[Lorebook Distiller] failed to open:', error);
        globalThis.toastr?.error('Could not open Lorebook Distiller.');
    });
}

function ensureMenuItem() {
    const host = document.getElementById('extensionsMenu');
    if (!host) {
        return;
    }
    let item = document.getElementById(MENU_ITEM_ID);
    if (!item) {
        // Wand entries must be divs: the host styles `#extensionsMenu > div`,
        // and a <button> falls back to browser chrome.
        item = document.createElement('div');
        item.id = MENU_ITEM_ID;
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.title = 'Turn this chat into lorebook entries you approve one by one';
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        const icon = document.createElement('span');
        icon.className = 'fa-solid fa-book-medical extensionsMenuExtensionButton';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = 'Lorebook Distiller';
        item.append(icon, label);
        item.addEventListener('click', onOpen);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                onOpen(event);
            }
        });
    }
    if (item.parentElement !== host) {
        host.append(item);
    }
}

function init() {
    if (active) {
        return;
    }
    active = true;
    const ctx = globalThis.SillyTavern.getContext();
    readyHandler = () => ensureMenuItem();
    ctx.eventSource.on(ctx.eventTypes.APP_READY, readyHandler);
    ensureMenuItem();
}

async function deactivate() {
    if (!active) {
        return;
    }
    active = false;
    const ctx = globalThis.SillyTavern.getContext();
    if (readyHandler) {
        ctx.eventSource.removeListener(ctx.eventTypes.APP_READY, readyHandler);
        readyHandler = null;
    }
    document.getElementById(MENU_ITEM_ID)?.remove();
    await closeDistiller();
}

export function activate() {
    init();
}

export function enable() {
    init();
}

export function disable() {
    return deactivate();
}
