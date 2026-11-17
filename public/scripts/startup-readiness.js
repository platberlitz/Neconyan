// Holds the startup loader until the styles and panels people see first are ready.
// Kept free of imports so extensions and tests can load it without the core graph.

export const STARTUP_READINESS_TIMEOUT_MS = 3000;

const STARTUP_TASKS_KEY = '__neconyanStartupTasks';

/** @returns {Map<string, Promise<unknown>>} */
function getStartupTasks() {
    const scope = /** @type {any} */ (globalThis);
    if (!(scope[STARTUP_TASKS_KEY] instanceof Map)) {
        scope[STARTUP_TASKS_KEY] = new Map();
    }
    return scope[STARTUP_TASKS_KEY];
}

/**
 * Registers work the startup loader should wait for, such as a panel mounting its markup.
 * Failures are swallowed: a broken task never holds startup longer than the cap.
 * @param {string} name Task name, for diagnostics
 * @param {Promise<unknown>} task Work to wait for
 */
export function registerStartupTask(name, task) {
    const settled = Promise.resolve(task).catch(error => {
        console.warn(`[Startup] ${name} did not finish cleanly.`, error);
    });
    getStartupTasks().set(String(name), settled);
}

/** @returns {string[]} */
export function getRegisteredStartupTaskNames() {
    return [...getStartupTasks().keys()];
}

function getAbsoluteUrl(href) {
    try {
        return new URL(href, document.baseURI).href;
    } catch {
        return String(href || '');
    }
}

// A preloaded sheet finishes its request a moment before it applies, so only an older
// finished request without a sheet counts as a failed or non-CSS response.
const FAILED_REQUEST_AGE_MS = 400;

function hasFailedRequest(link) {
    const href = getAbsoluteUrl(link.href);
    if (!href || typeof performance?.getEntriesByName !== 'function') return false;
    const now = performance.now();
    return performance.getEntriesByName(href, 'resource')
        .some(entry => entry.responseEnd > 0 && now - entry.responseEnd >= FAILED_REQUEST_AGE_MS);
}

function linkAppliesNow(link) {
    const media = String(link.media || '').trim();
    // loadStylesheetAsync parks low-priority sheets on 'print' until they load.
    if (!media || media === 'all' || media === 'print') return true;
    try {
        return window.matchMedia(media).matches;
    } catch {
        return true;
    }
}

/**
 * @param {HTMLLinkElement} link
 * @returns {boolean} true when the stylesheet has loaded or will never load
 */
export function isStylesheetSettled(link) {
    if (!(link instanceof HTMLLinkElement)) return true;
    if (link.disabled || !link.href) return true;
    if (link.sheet || link.dataset.loaded === 'true' || link.dataset.sbStyleFailed === 'true') return true;
    // A failed or non-CSS response leaves sheet null forever and may have fired its error already.
    return hasFailedRequest(link);
}

/**
 * @param {ParentNode} [root]
 * @returns {HTMLLinkElement[]} stylesheets on the page that apply now and have not loaded yet
 */
export function collectPendingStylesheets(root = document) {
    return [...root.querySelectorAll('link[rel~="stylesheet"]')]
        .filter(link => link instanceof HTMLLinkElement)
        .filter(link => linkAppliesNow(link) && !isStylesheetSettled(link));
}

/**
 * @param {HTMLLinkElement} link
 * @returns {Promise<void>} resolves on load or error, never rejects
 */
export function waitForStylesheet(link) {
    if (isStylesheetSettled(link)) return Promise.resolve();
    return new Promise(resolve => {
        let poll = 0;
        const done = (event) => {
            if (event?.type === 'error') link.dataset.sbStyleFailed = 'true';
            window.clearInterval(poll);
            link.removeEventListener('load', done);
            link.removeEventListener('error', done);
            resolve();
        };
        link.addEventListener('load', done);
        link.addEventListener('error', done);
        const giveUpAt = performance.now() + 30000;
        poll = window.setInterval(() => {
            if (isStylesheetSettled(link) || performance.now() > giveUpAt) done();
        }, 200);
        // The request can finish between the check above and the listeners.
        if (isStylesheetSettled(link)) done();
    });
}

function waitForFonts() {
    const fonts = /** @type {any} */ (document).fonts;
    if (!fonts?.ready || fonts.status === 'loaded') return Promise.resolve();
    return Promise.resolve(fonts.ready).catch(() => undefined);
}

/**
 * Waits until the stylesheets that apply now, pending fonts and registered startup tasks
 * are ready, or until the cap passes. Sheets added while waiting (a shell style picked
 * from settings, for example) are picked up too.
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {() => void} [options.activateDeferredStyles] Turns preloaded deferred sheets on
 * @returns {Promise<{ timedOut: boolean, elapsedMs: number, pending: string[] }>}
 */
export async function waitForStartupReadiness({ timeoutMs = STARTUP_READINESS_TIMEOUT_MS, activateDeferredStyles } = {}) {
    const startedAt = performance.now();
    try {
        activateDeferredStyles?.();
    } catch (error) {
        console.warn('[Startup] Could not turn on deferred stylesheets.', error);
    }

    let timer = 0;
    const timeout = new Promise(resolve => {
        timer = window.setTimeout(() => resolve('timeout'), Math.max(0, Number(timeoutMs) || 0));
    });

    const settle = async () => {
        // Each pass can reveal more work (a task that mounts a panel can add its own sheet).
        for (let pass = 0; pass < 4; pass++) {
            const pendingSheets = collectPendingStylesheets();
            const tasks = [...getStartupTasks().values()];
            await Promise.all([...pendingSheets.map(waitForStylesheet), ...tasks, waitForFonts()]);
            if (!collectPendingStylesheets().length) return 'ready';
        }
        return 'ready';
    };

    const result = await Promise.race([settle(), timeout]);
    window.clearTimeout(timer);
    const pending = collectPendingStylesheets().map(link => link.getAttribute('href') || link.href);
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (result === 'timeout') {
        console.warn(`[Startup] Continued after ${elapsedMs} ms without waiting for:`, pending);
    }
    return { timedOut: result === 'timeout', elapsedMs, pending };
}
