/**
 * Loads the macro page only when its container is first shown, so a cold start
 * does not fetch the page's modules for a page nobody has opened.
 */

/** @type {Promise<typeof import('./app.js')>|null} */
let appModulePromise = null;
/** @type {typeof import('./app.js')|null} */
let appModule = null;
/** @type {ResizeObserver|null} */
let visibilityObserver = null;
/** @type {HTMLElement|null} */
let pendingContainer = null;
let pendingOptions = { engineAvailable: false };

export function loadAppModule() {
    appModulePromise ??= import('./app.js').then(module => {
        appModule = module;
        return module;
    });
    return appModulePromise;
}

function isShown(element) {
    return element.isConnected && element.getClientRects().length > 0;
}

function stopWatching() {
    visibilityObserver?.disconnect();
    visibilityObserver = null;
}

async function mountPending() {
    stopWatching();
    const module = await loadAppModule();
    const container = pendingContainer;
    pendingContainer = null;
    if (container?.isConnected) {
        module.mountApp(container, pendingOptions);
    }
}

/**
 * Mounts the page now when it is already loaded or visible, otherwise on the
 * first frame its container has a layout box.
 * @param {HTMLElement} container
 * @param {{engineAvailable: boolean}} options
 */
export function mountAppWhenShown(container, options) {
    pendingOptions = options;
    if (appModule?.isAppMounted()) {
        appModule.mountApp(container, options);
        return;
    }
    pendingContainer = container;
    if (isShown(container) || typeof ResizeObserver !== 'function') {
        void mountPending();
        return;
    }
    stopWatching();
    visibilityObserver = new ResizeObserver(() => {
        if (pendingContainer && isShown(pendingContainer)) {
            void mountPending();
        }
    });
    visibilityObserver.observe(container);
}

export function refreshApp(kind = 'all') {
    appModule?.refreshApp(kind);
}

export function appSettingsUpdated() {
    appModule?.appSettingsUpdated();
}

export function appChatChanged() {
    appModule?.appChatChanged();
}

export function unmountApp() {
    stopWatching();
    pendingContainer = null;
    appModule?.unmountApp();
}

export function isAppMounted() {
    return !!appModule?.isAppMounted();
}
