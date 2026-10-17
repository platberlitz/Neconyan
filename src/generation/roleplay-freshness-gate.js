/**
 * Share one synchronous freshness check between every caller that arrives in
 * the same event-loop turn, then give each caller its own copy of any failure.
 * Success is never reused across turns: a later caller schedules a new check,
 * so an edit between two dispatches is still refused by the second one.
 *
 * The check itself runs on `setImmediate`, after the current turn's callers
 * have queued. That is what makes a group of parallel Agent steps share a
 * single check instead of running one after another.
 */
export function createFreshnessGate(check) {
    if (typeof check !== 'function') throw new TypeError('A freshness gate needs a check function.');
    let scheduled = null;
    const copyError = error => {
        const source = error && (typeof error === 'object' || typeof error === 'function') ? error : new Error(String(error));
        const copy = new Error(source.message);
        copy.name = source.name;
        for (const key of ['code', 'status', 'providerStatus']) {
            if (source[key] !== undefined) copy[key] = source[key];
        }
        if (source.imageIssue !== undefined) copy.imageIssue = structuredClone(source.imageIssue);
        if (source.current !== undefined) copy.current = structuredClone(source.current);
        return copy;
    };
    return function freshness() {
        if (!scheduled) {
            const state = { settled: false, resolve: null, reject: null };
            state.promise = new Promise((resolve, reject) => {
                state.resolve = resolve;
                state.reject = reject;
            });
            scheduled = state;
            setImmediate(() => {
                if (scheduled === state) scheduled = null;
                if (state.settled) return;
                try {
                    check();
                    state.settled = true;
                    state.resolve();
                } catch (error) {
                    state.settled = true;
                    state.reject(error);
                }
            });
        }
        return scheduled.promise.then(value => value, error => { throw copyError(error); });
    };
}
