const listeners = new Set();

/** Hints only: callers must read the saved ledger before acting. */
export function subscribeJobsChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function notifyJobsChanged(change) {
    for (const listener of listeners) {
        try { listener(change); } catch (error) {
            // A failed observer must never turn an acknowledged disk write into a failure.
            console.error('[Jobs] Observer failed:', error);
        }
    }
}
