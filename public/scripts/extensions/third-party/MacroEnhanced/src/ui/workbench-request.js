/**
 * A one-slot request queue between slash commands / help buttons and the page
 * application. The app may not be mounted yet when a request arrives, so the
 * request waits until it is.
 */
const listeners = new Set();
let pending = null;

export function requestWorkbench(request) {
    pending = { ...request };
    for (const listener of [...listeners]) {
        try {
            listener(pending);
        } catch (error) {
            console.error('[MacroEnhanced] workbench request listener failed', error);
        }
    }
}

export function consumeWorkbenchRequest() {
    const request = pending;
    pending = null;
    return request;
}

export function onWorkbenchRequest(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
