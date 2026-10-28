/** Wait for a captured set of older messages without owning the shared memory worker. */
export const MEWMORY_CATCH_UP_TIMEOUT_MS = 5 * 60_000;
export const MEWMORY_CATCH_UP_POLL_MS = 1_500;

function waitError(code, message) {
    return Object.assign(new Error(message), { code });
}

function throwIfStopped(signal, deadline, now) {
    if (signal?.aborted) throw waitError('MEWMORY_WAIT_ABORTED', 'Stopped waiting for memory.');
    if (now() >= deadline) throw waitError('MEWMORY_WAIT_TIMEOUT', 'Memory is still updating. Retry this reply or reply now with the extra original messages.');
}

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(waitError('MEWMORY_WAIT_ABORTED', 'Stopped waiting for memory.'));
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
        function abort() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(waitError('MEWMORY_WAIT_ABORTED', 'Stopped waiting for memory.'));
        }
        signal?.addEventListener('abort', abort, { once: true });
    });
}

async function bounded(action, signal, deadline, now) {
    throwIfStopped(signal, deadline, now);
    let timer;
    let abort;
    const limit = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(waitError('MEWMORY_WAIT_TIMEOUT', 'Memory is still updating. Retry this reply or reply now with the extra original messages.')), Math.max(0, deadline - now()));
        abort = () => reject(waitError('MEWMORY_WAIT_ABORTED', 'Stopped waiting for memory.'));
        signal?.addEventListener('abort', abort, { once: true });
    });
    try {
        return await Promise.race([Promise.resolve().then(() => {
            throwIfStopped(signal, deadline, now);
            return action();
        }), limit]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

/**
 * `check(snapshot)` must revalidate the captured chat/config identity and required refs and return
 * `{ ready, stale?, error?, processing?, pending? }`. `start` starts or reuses the ordinary worker;
 * `onInitiated` persists the attempt before that start, so a resumed attempt never starts it twice.
 * Neither callback may hold a lock while this observer sleeps. Callers persist the original
 * snapshot/deadline for durable jobs and bind retries to their existing saved message.
 */
export async function observeMewmoryCatchUp({
    snapshot, deadline, initiated = false, check, start, onInitiated = () => {}, onProgress = () => {},
    signal, now = Date.now, sleep = delay, pollMs = MEWMORY_CATCH_UP_POLL_MS,
}) {
    if (!snapshot || !Number.isFinite(deadline) || typeof check !== 'function' || typeof start !== 'function'
        || !Number.isFinite(pollMs) || pollMs <= 0) throw new TypeError('A memory wait requires a snapshot, fixed deadline and worker callbacks.');
    let started = Boolean(initiated);
    for (;;) {
        throwIfStopped(signal, deadline, now);
        const status = await bounded(() => check(snapshot, { signal, deadline }), signal, deadline, now);
        throwIfStopped(signal, deadline, now);
        if (!status || status.stale) throw waitError('MEWMORY_WAIT_STALE', 'The chat or Mewmory settings changed while waiting. Retry this reply.');
        if (status.error) throw waitError('MEWMORY_WAIT_FAILED', String(status.error));
        if (status.ready) return { ready: true, snapshot, deadline, initiated: started };
        onProgress(status);
        if (!started) {
            // Persist first: a crash after this point must not silently initiate a second job.
            await bounded(() => onInitiated({ snapshot, deadline, initiated: true }), signal, deadline, now);
            throwIfStopped(signal, deadline, now);
            started = true;
            await bounded(() => start(snapshot, { signal, deadline }), signal, deadline, now);
            throwIfStopped(signal, deadline, now);
            continue;
        }
        if (status.processing && ['failed', 'cancelled', 'complete'].includes(status.processing.status)) {
            throw waitError('MEWMORY_WAIT_FAILED', status.processing.error || 'Memory stopped before the older messages were recorded. Retry this reply or reply now.');
        }
        await sleep(Math.min(pollMs, deadline - now()), signal);
    }
}
