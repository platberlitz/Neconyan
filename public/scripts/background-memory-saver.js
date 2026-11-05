export const BACKGROUND_MEMORY_SAVER_KEY = 'neconyan:background-memory-saver:v1';

/** Only register reconstructable caches or idle views, never drafts or pending writes. */
const handlers = new Set();
let sharedSaver;

export function registerBackgroundMemoryHandler(handler) {
    handlers.add(handler);
    return () => handlers.delete(handler);
}

export function getBackgroundMemorySaver() {
    return sharedSaver ??= createBackgroundMemorySaver({ handlers });
}

/** Native hosts send the same lifecycle events as browser tabs. No hidden-page timer is required. */
export function createBackgroundMemorySaver({
    document: doc = globalThis.document,
    host = globalThis.window,
    handlers: clients = new Set(),
    storage,
    onError = error => console.warn('Background memory saving:', error),
} = {}) {
    let enabled = false;
    try {
        storage ??= globalThis.localStorage;
        enabled = storage?.getItem(BACKGROUND_MEMORY_SAVER_KEY) === 'on';
    } catch { /* Storage may be blocked; the switch still works for this page. */ }
    let nativeHidden = false;
    let pageHidden = false;
    let disposed = false;
    let restoring = false;
    const pending = new Map();
    const isHidden = () => Boolean(doc?.hidden || nativeHidden || pageHidden);
    const canRestore = () => !disposed && !isHidden();
    let wasHidden = isHidden();
    let visibilityEpoch = 0;

    function release() {
        if (!enabled || disposed || restoring) return;
        for (const handler of clients) {
            if (pending.has(handler)) continue;
            try {
                const restore = handler.release();
                if (typeof restore === 'function') pending.set(handler, restore);
            } catch (error) { onError(error); }
        }
    }

    async function restore() {
        if (restoring || !canRestore()) return;
        restoring = true;
        const epoch = visibilityEpoch;
        const isCurrent = () => canRestore() && epoch === visibilityEpoch;
        try {
            for (const [handler, resume] of pending) {
                if (!isCurrent()) break;
                if (!clients.has(handler)) { pending.delete(handler); continue; }
                try {
                    // A view interrupted by another hide keeps its original restoration target.
                    if (await resume(isCurrent) !== false) pending.delete(handler);
                } catch (error) { pending.delete(handler); onError(error); }
            }
        } finally {
            restoring = false;
            if (isHidden()) release();
            else if (!disposed && pending.size && epoch !== visibilityEpoch) void restore();
        }
    }

    function sync() {
        const hidden = isHidden();
        if (hidden !== wasHidden) { visibilityEpoch++; wasHidden = hidden; }
        if (hidden) release();
        else void restore();
    }
    const hide = () => { pageHidden = true; sync(); };
    const show = () => { pageHidden = false; sync(); };
    function nativeLifecycle(event) {
        const state = event.detail?.state;
        if (state === 'background') nativeHidden = true;
        else if (state === 'foreground') nativeHidden = false;
        else if (state !== 'pressure') return;
        // A foreground warning may evict caches, but never removes the view being used.
        if (state === 'pressure' && !isHidden()) {
            if (enabled && !disposed) {
                for (const handler of clients) {
                    try { handler.releaseCache?.(); } catch (error) { onError(error); }
                }
            }
        } else sync();
    }
    doc?.addEventListener('visibilitychange', sync);
    doc?.addEventListener('freeze', hide);
    doc?.addEventListener('resume', show);
    host?.addEventListener('pagehide', hide);
    host?.addEventListener('pageshow', show);
    host?.addEventListener('neconyan:memory-lifecycle', nativeLifecycle);
    sync();
    return {
        isEnabled: () => enabled,
        setEnabled(value) {
            enabled = Boolean(value);
            try {
                if (enabled) storage?.setItem(BACKGROUND_MEMORY_SAVER_KEY, 'on');
                else storage?.removeItem(BACKGROUND_MEMORY_SAVER_KEY);
            } catch { /* Keep the in-page preference. */ }
            sync();
        },
        dispose() {
            disposed = true;
            pending.clear();
            doc?.removeEventListener('visibilitychange', sync);
            doc?.removeEventListener('freeze', hide);
            doc?.removeEventListener('resume', show);
            host?.removeEventListener('pagehide', hide);
            host?.removeEventListener('pageshow', show);
            host?.removeEventListener('neconyan:memory-lifecycle', nativeLifecycle);
        },
    };
}
