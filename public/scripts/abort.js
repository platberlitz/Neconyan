/** Stop waiting even when a suspended browser request ignores cancellation. */
export async function withAbortSignal(promise, signal) {
    if (!signal) return promise;
    let onAbort;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const result = await Promise.race([promise, aborted]);
        signal.throwIfAborted();
        return result;
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}
