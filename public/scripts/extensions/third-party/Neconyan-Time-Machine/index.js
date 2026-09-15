/**
 * Card & Lorebook Time Machine.
 *
 * Automatic snapshots of the things Neconyan does not back up: characters,
 * lorebooks and presets, with comparison and deliberate restore controls.
 */
import { captureCharacter, captureLorebook, capturePresets } from './src/api.js';
import { reconcile, renameTarget } from './src/store.js';
import { closeTimeMachine, openTimeMachine, renderDrawer } from './src/ui.js';

const MENU_ITEM_ID = 'sbctm-menu-item';
const DRAWER_ID = 'sbctm-settings-drawer';

const subscriptions = [];
const pendingOperations = new Set();
let active = false;
let prepared = false;
let preparing = false;
let lastWarningAt = 0;
let lifecycle = 0;

function ctx() {
    return globalThis.SillyTavern.getContext();
}

function subscribe(context, eventType, handler) {
    if (!eventType) {
        return;
    }
    context.eventSource.on(eventType, handler);
    subscriptions.push({ eventSource: context.eventSource, eventType, handler });
}

/** A capture must never take the app down with it. */
function guard(promise, label = 'automatic snapshot') {
    const operation = Promise.resolve(promise).then((result) => {
        if (result?.failed > 0) {
            warn(`${result.failed} ${label}${result.failed === 1 ? '' : 's'} failed`);
        }
        return result;
    }).catch((error) => {
        warn(`${label} failed`, error);
    });
    pendingOperations.add(operation);
    void operation.finally(() => pendingOperations.delete(operation));
    return operation;
}

function warn(message, error) {
    console.error(`[Time Machine] ${message}`, error ?? '');
    // Unconfirmed is not failed: the row stays indexed and the pending flush lands it.
    if (error?.code === 'COMMIT_UNCONFIRMED') {
        return;
    }
    const now = Date.now();
    if (now - lastWarningAt >= 60_000) {
        lastWarningAt = now;
        globalThis.toastr?.warning('Time Machine could not protect every change. Check the console before relying on its history.');
    }
}

function assertCapabilities(context) {
    const missing = [];
    for (const [name, available] of [
        ['extension settings', context.extensionSettings && typeof context.saveSettingsDebounced === 'function'],
        ['event source', typeof context.eventSource?.on === 'function' && typeof context.eventSource?.removeListener === 'function'],
        ['request headers', typeof context.getRequestHeaders === 'function'],
        ['character loading', typeof context.getCharacters === 'function' && typeof context.unshallowCharacter === 'function'],
        ['character tags', context.tagMap && typeof context.tagMap === 'object'],
        ['exact character restore', context.constants?.unset !== undefined],
        ['lorebook access', typeof context.getWorldInfoNames === 'function'
            && typeof context.loadWorldInfo === 'function'
            && typeof context.saveWorldInfo === 'function'],
        ['preset access', typeof context.getPresetManager === 'function'],
        ['popup API', typeof context.Popup === 'function'
            && context.POPUP_TYPE?.TEXT !== undefined
            && context.POPUP_TYPE?.CONFIRM !== undefined],
    ]) {
        if (!available) {
            missing.push(name);
        }
    }
    for (const event of [
        'APP_READY',
        'CHARACTER_EDITOR_OPENED',
        'CHARACTER_EDITED',
        'CHARACTER_RENAMED',
        'WORLDINFO_UPDATED',
        'PRESET_CHANGED',
        'PRESET_RENAMED',
    ]) {
        if (!context.eventTypes?.[event]) {
            missing.push(`event ${event}`);
        }
    }
    if (missing.length > 0) {
        throw new Error(`Unsupported Neconyan context; missing ${missing.join(', ')}`);
    }
}

function prepareHistory() {
    if (prepared || preparing) {
        return;
    }
    preparing = true;
    const generation = lifecycle;
    const operation = reconcile()
        .then(() => capturePresets())
        .then((result) => {
            if (active && generation === lifecycle) {
                prepared = result.failed === 0;
            }
            return result;
        })
        .finally(() => {
            if (generation === lifecycle) {
                preparing = false;
            }
        });
    guard(operation, 'startup history check');
}

function unsubscribeAll() {
    while (subscriptions.length) {
        const { eventSource, eventType, handler } = subscriptions.pop();
        eventSource.removeListener(eventType, handler);
    }
}

function removeUi() {
    document.getElementById(MENU_ITEM_ID)?.remove();
    document.getElementById(DRAWER_ID)?.remove();
}

function setupUi() {
    ensureMenuItem();
    ensureDrawer();
    prepareHistory();
}

function reportActivationFailure(error) {
    console.error('[Time Machine] could not activate', error);
    globalThis.toastr?.error('Time Machine is not compatible with this Neconyan version and was not enabled.');
    throw error;
}

function start() {
    try {
        init();
    } catch (error) {
        reportActivationFailure(error);
    }
}

function onOpen(event) {
    event.preventDefault();
    event.stopPropagation();
    void openTimeMachine().catch((error) => {
        console.error('[Time Machine] failed to open:', error);
        globalThis.toastr?.error('Could not open the Time Machine.');
    });
}

function ensureMenuItem() {
    const host = document.getElementById('extensionsMenu');
    if (!host) {
        return;
    }
    let item = document.getElementById(MENU_ITEM_ID);
    if (!item) {
        // Wand entries must be divs: the host styles `#extensionsMenu > div`.
        item = document.createElement('div');
        item.id = MENU_ITEM_ID;
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.title = 'Earlier versions of your characters, lorebooks and presets';
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        const icon = document.createElement('span');
        icon.className = 'fa-solid fa-clock-rotate-left extensionsMenuExtensionButton';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = 'Time Machine';
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

function ensureDrawer() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) {
        return;
    }
    let drawer = document.getElementById(DRAWER_ID);
    if (!drawer) {
        drawer = document.createElement('div');
        drawer.id = DRAWER_ID;
        drawer.className = 'inline-drawer';

        // Plain <div>, exactly like every host drawer header: a <button> would
        // need a font/colour reset that outranks theme rules on .inline-drawer-header.
        const toggle = document.createElement('div');
        toggle.className = 'inline-drawer-toggle inline-drawer-header';
        const title = document.createElement('b');
        title.textContent = 'Time Machine';
        const chevron = document.createElement('div');
        chevron.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
        toggle.append(title, chevron);

        const content = document.createElement('div');
        content.id = `${DRAWER_ID}-content`;
        content.className = 'inline-drawer-content';
        drawer.append(toggle, content);
        host.append(drawer);
    }
    renderDrawer(drawer.querySelector('.inline-drawer-content'));
}

function init() {
    if (active) {
        return;
    }
    const context = ctx();
    assertCapabilities(context);
    const events = context.eventTypes;

    try {
        subscribe(context, events.APP_READY, () => {
            try {
                setupUi();
            } catch (error) {
                warn('startup UI refresh failed', error);
            }
        });

        // Opening the editor is the baseline: it is the last moment the card is
        // certainly as the user left it. Identical snapshots are discarded, so
        // capturing here costs nothing when nothing is changed.
        subscribe(context, events.CHARACTER_EDITOR_OPENED, (chid) => {
            const avatar = ctx().characters?.[chid]?.avatar;
            if (avatar) {
                guard(captureCharacter(avatar));
            }
        });

        subscribe(context, events.CHARACTER_EDITED, (event) => {
            const avatar = event?.detail?.character?.avatar ?? ctx().characters?.[event?.detail?.id]?.avatar;
            if (avatar) {
                guard(captureCharacter(avatar));
            }
        });

        // WORLDINFO_UPDATED fires from inside the host's own save, after the write
        // succeeded, and carries the book, so this is the complete set of
        // lorebook saves with no polling and no second read.
        subscribe(context, events.WORLDINFO_UPDATED, (name, data) => {
            if (name) {
                guard(captureLorebook(name, data));
            }
        });

        // Presets have no save event at all. Switching preset is the nearest
        // thing: the previous one has been written by then.
        subscribe(context, events.PRESET_CHANGED, () => guard(capturePresets()));
        subscribe(context, events.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
            guard(renameTarget('character', oldAvatar, newAvatar), 'character history rename');
        });
        subscribe(context, events.PRESET_RENAMED, ({ apiId, oldName, newName } = {}) => {
            if (apiId && oldName && newName) {
                guard(renameTarget('preset', `${apiId}/${oldName}`, `${apiId}/${newName}`, `${newName} (${apiId})`), 'preset history rename');
            }
        });

        ensureMenuItem();
        ensureDrawer();
        active = true;
        lifecycle++;
        prepareHistory();
    } catch (error) {
        active = false;
        unsubscribeAll();
        removeUi();
        throw error;
    }
}

async function deactivate() {
    if (!active) {
        return;
    }
    active = false;
    lifecycle++;
    unsubscribeAll();
    removeUi();
    prepared = false;
    preparing = false;
    let timer;
    const finished = Promise.allSettled([closeTimeMachine(), ...pendingOperations]).then(() => true);
    const settled = await Promise.race([
        finished,
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 2_000); }),
    ]);
    clearTimeout(timer);
    if (!settled) {
        warn('disable timed out while an operation was still finishing');
    }
}

export function activate() {
    start();
}

export function enable() {
    start();
}

export function disable() {
    return deactivate();
}
