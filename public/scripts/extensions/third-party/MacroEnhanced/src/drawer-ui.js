/**
 * The host contract: one `#me-settings-drawer.inline-drawer` with an
 * `.inline-drawer-content`. The shell moves this whole unit into the Included
 * tool page and back, so the app inside keeps its DOM and state.
 */
import { el } from './dom.js';
import { mountApp, unmountApp } from './ui/app.js';

const DRAWER_ID = 'me-settings-drawer';

function findHost() {
    return document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
}

function ensureDrawer() {
    let drawer = document.getElementById(DRAWER_ID);
    if (drawer) {
        return drawer;
    }
    const host = findHost();
    if (!host) {
        return null;
    }
    drawer = el('div', 'inline-drawer');
    drawer.id = DRAWER_ID;

    const toggle = el('div', 'inline-drawer-toggle inline-drawer-header');
    toggle.appendChild(el('b', undefined, 'Macro Enhanced'));
    toggle.appendChild(el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    drawer.appendChild(toggle);

    drawer.appendChild(el('div', 'inline-drawer-content'));
    host.appendChild(drawer);
    return drawer;
}

/**
 * Mounts or refreshes the page. The header is hidden by CSS only while the
 * shell is showing the tool page.
 *
 * @param {object} state
 * @param {boolean} state.engineAvailable
 */
export function renderDrawer({ engineAvailable }) {
    const drawer = ensureDrawer();
    if (!drawer) {
        return;
    }
    const content = drawer.querySelector('.inline-drawer-content');
    if (!(content instanceof HTMLElement)) {
        return;
    }
    mountApp(content, { engineAvailable });
}

export function removeDrawer() {
    unmountApp();
    document.getElementById(DRAWER_ID)?.remove();
}
