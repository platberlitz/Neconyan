/**
 * The Android and iPhone apps tell the page when they leave and return to the screen. A page in a
 * plain browser never hears from them and stays 'resumed', so nothing here changes how it behaves.
 */

export const NATIVE_APP_LIFECYCLE_EVENT = 'neconyan:app-lifecycle';

/** @typedef {'paused'|'stopped'|'resumed'} NativeAppState */

const STATES = new Set(['paused', 'stopped', 'resumed']);

/**
 * @param {{ host?: EventTarget|null }} [options]
 */
export function createNativeAppLifecycle({ host = typeof window === 'undefined' ? null : window } = {}) {
    /** @type {NativeAppState} */
    let state = 'resumed';
    /** @type {Set<(change: { state: NativeAppState, previous: NativeAppState }) => void>} */
    const listeners = new Set();

    /** @param {Event} event */
    function handleEvent(event) {
        const next = /** @type {CustomEvent} */ (event)?.detail?.state;
        if (!STATES.has(next) || next === state) {
            return;
        }
        const previous = state;
        state = next;
        for (const listener of [...listeners]) {
            try {
                listener({ state, previous });
            } catch (error) {
                console.warn('App lifecycle listener failed:', error);
            }
        }
    }

    host?.addEventListener?.(NATIVE_APP_LIFECYCLE_EVENT, handleEvent);

    return {
        get state() {
            return state;
        },
        /** True while the app is off the screen, when the system may freeze the page at any moment. */
        isBackgrounded() {
            return state === 'stopped';
        },
        /**
         * @param {(change: { state: NativeAppState, previous: NativeAppState }) => void} listener
         * @returns {() => void}
         */
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        dispose() {
            listeners.clear();
            host?.removeEventListener?.(NATIVE_APP_LIFECYCLE_EVENT, handleEvent);
        },
    };
}

/** @type {ReturnType<typeof createNativeAppLifecycle>|null} */
let shared = null;

export function getNativeAppLifecycle() {
    shared ??= createNativeAppLifecycle();
    return shared;
}

export function isNativeAppBackgrounded() {
    return getNativeAppLifecycle().isBackgrounded();
}

/**
 * @param {(change: { state: NativeAppState, previous: NativeAppState }) => void} listener
 */
export function onNativeAppLifecycle(listener) {
    return getNativeAppLifecycle().subscribe(listener);
}
