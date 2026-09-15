/**
 * Puts a "Find cards online" entry point into the UI.
 *
 * Primary placement is a third button in Neconyan's Characters > Import panel,
 * next to "Import from file" and "Import from URL" (public/index.html:6628).
 * Reusing the sibling markup and the `.sb-character-import-action` class means
 * it inherits the icon tile, hover lift and focus ring from
 * public/css/neconyan-tabs.css:2716. It needs no CSS of its own and stays correct
 * when the fork restyles that panel.
 *
 * Fallback is the wand menu, for stock SillyTavern or a fork that renamed the
 * panel. The fallback only appears after a grace period, so a slow-building
 * panel does not produce both entry points.
 */

import { DOM_IDS, LOG_TAG } from './constants.js';

const PANEL_SELECTOR = '#sb_character_import_panel';
const ACTIONS_SELECTOR = '.sb-character-import-actions';
const FALLBACK_GRACE_MS = 3000;
const OBSERVER_DEBOUNCE_MS = 150;

const LABEL = 'Find cards online';
const SUBLABEL = 'Search supported card sites and import a card.';

/**
 * @param {() => void} onOpen
 */
export function installEntryPoints(onOpen) {
    let fallbackTimer = null;

    const ensure = () => {
        if (ensureImportButton(onOpen)) {
            if (fallbackTimer !== null) {
                clearTimeout(fallbackTimer);
                fallbackTimer = null;
            }
            return true;
        }
        return false;
    };

    if (!ensure()) {
        fallbackTimer = setTimeout(() => {
            fallbackTimer = null;
            if (!ensure()) {
                ensureWandItem(onOpen);
            }
        }, FALLBACK_GRACE_MS);
    }

    // The fork re-renders the character shell in places; re-assert cheaply.
    // ensureImportButton() is idempotent, so a spurious call costs one querySelector.
    let pending = null;
    const observer = new MutationObserver(() => {
        if (pending !== null) {
            return;
        }
        pending = setTimeout(() => {
            pending = null;
            ensure();
        }, OBSERVER_DEBOUNCE_MS);
    });

    const target = document.querySelector(PANEL_SELECTOR) ?? document.body;
    observer.observe(target, { childList: true, subtree: true });
}

/**
 * @param {() => void} onOpen
 * @returns {boolean} true once the button exists
 */
function ensureImportButton(onOpen) {
    const actions = document.querySelector(`${PANEL_SELECTOR} ${ACTIONS_SELECTOR}`);
    if (!actions) {
        return false;
    }

    const existing = document.getElementById(DOM_IDS.importAction);
    if (existing) {
        // Re-append if the panel rebuilt around it and dropped us out of order.
        if (existing.parentElement !== actions) {
            actions.append(existing);
        }
        return true;
    }

    const button = document.createElement('button');
    button.id = DOM_IDS.importAction;
    button.className = 'sb-character-import-action';
    button.type = 'button';

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-magnifying-glass';
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = LABEL;
    const small = document.createElement('small');
    small.textContent = SUBLABEL;
    text.append(strong, small);

    button.append(icon, text);

    // The fork's own convention for "this node already has its handler".
    if (button.dataset.sbBound !== 'true') {
        button.dataset.sbBound = 'true';
        button.addEventListener('click', (event) => {
            event.preventDefault();
            onOpen();
        });
    }

    actions.append(button);
    console.debug(`[${LOG_TAG}] import panel button installed`);
    return true;
}

/**
 * @param {() => void} onOpen
 */
function ensureWandItem(onOpen) {
    if (document.getElementById(DOM_IDS.wandItem)) {
        return;
    }

    const menu = document.getElementById('sbbs_wand_container') ?? document.getElementById('extensionsMenu');
    if (!menu) {
        console.debug(`[${LOG_TAG}] no import panel and no wand menu; no entry point installed`);
        return;
    }

    const item = document.createElement('button');
    item.id = DOM_IDS.wandItem;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.type = 'button';

    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-magnifying-glass extensionsMenuExtensionButton';
    icon.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.textContent = LABEL;

    item.append(icon, label);
    item.addEventListener('click', () => onOpen());

    menu.append(item);
    console.debug(`[${LOG_TAG}] wand menu fallback installed`);
}
