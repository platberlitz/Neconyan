let activeLease = null;
const activeTasks = new Set();
const idleWaiters = new Set();
let accepting = true;

function assertAccepting() {
    if (accepting) {
        return;
    }
    const error = new Error('Prompting Lab is not active.');
    error.code = 'SBPL_INACTIVE';
    throw error;
}

function reportIdle() {
    if (activeLease || activeTasks.size) {
        return;
    }
    for (const resolve of idleWaiters) {
        resolve();
    }
    idleWaiters.clear();
}

/** Acquires the single host-state lease, failing immediately when it is busy. */
export function acquireHostOperation(name, { signal = null } = {}) {
    assertAccepting();
    if (activeLease) {
        const error = new Error(`Prompting Lab is busy with ${activeLease.name}.`);
        error.code = 'SBPL_BUSY';
        throw error;
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
        forwardAbort();
    } else {
        signal?.addEventListener?.('abort', forwardAbort, { once: true });
    }

    let released = false;
    const lease = {
        name: String(name || 'an operation'),
        controller,
        signal: controller.signal,
        abort: reason => controller.abort(reason),
        release() {
            if (released) {
                return;
            }
            released = true;
            signal?.removeEventListener?.('abort', forwardAbort);
            if (activeLease === lease) {
                activeLease = null;
            }
            reportIdle();
        },
    };
    activeLease = lease;
    return lease;
}

export function abortActiveOperations(reason = new Error('Prompting Lab was deactivated.')) {
    activeLease?.abort(reason);
    for (const task of activeTasks) {
        task.abort(reason);
    }
}

export function closeOperationRegistry() {
    accepting = false;
}

export function openOperationRegistry() {
    accepting = true;
}

export function activeOperation() {
    return activeLease ? { name: activeLease.name, aborted: activeLease.signal.aborted } : null;
}

/** Tracks non-exclusive async work so cleanup can wait for its final writes. */
export function registerActiveTask(name, { signal = null } = {}) {
    assertAccepting();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
        forwardAbort();
    } else {
        signal?.addEventListener?.('abort', forwardAbort, { once: true });
    }
    let released = false;
    const task = {
        name: String(name || 'a task'),
        signal: controller.signal,
        abort: reason => controller.abort(reason),
        release() {
            if (released) return;
            released = true;
            signal?.removeEventListener?.('abort', forwardAbort);
            activeTasks.delete(task);
            reportIdle();
        },
    };
    activeTasks.add(task);
    return task;
}

export function activeTaskNames() {
    return [...activeTasks].map(task => task.name);
}

export function waitForQuiescence() {
    if (!activeLease && !activeTasks.size) {
        return Promise.resolve();
    }
    return new Promise(resolve => idleWaiters.add(resolve));
}
