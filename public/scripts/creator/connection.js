export function creatorConnection(draft) {
    const value = draft.writing?.connection ?? {};
    const maxTokens = Number(value.maxTokens ?? 64000);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('Maximum output tokens must be a positive whole number.');
    return { profiles: [...new Set([value.profile || '', ...(value.fallbacks ?? []).filter(Boolean)])], maxTokens };
}

export function creatorConnectionError(error) {
    const messages = [];
    let status;
    for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth++) {
        if (!status && Number(cause.status) >= 400) status = Number(cause.status);
        const message = String(cause.message || (typeof cause === 'string' ? cause : '')).trim();
        if (message && !/^(?:<none>|none|null|undefined|\[object Object\]|Response not OK|API request failed)$/i.test(message) && !messages.includes(message)) messages.push(message);
    }
    const detail = messages.join(': ') || 'The connection failed without an error message from the provider.';
    const advice = status === 401 || status === 403 ? 'Check the API key and access to this model in Connections.'
        : status === 429 ? 'Check your provider’s credit or request limit, then try again.'
            : status >= 500 ? 'The provider could not complete the request. Try again or choose another connection in Writing instructions.'
                : 'Check the model, address and API key in Connections, then try again.';
    return `${status ? `HTTP ${status}: ` : ''}${detail} ${advice}`;
}

export async function withCreatorAbort(action, signal) {
    if (!signal) return action();
    let abort;
    const cancelled = new Promise((resolve, reject) => {
        abort = () => reject(new Error('Request cancelled. Nothing was applied.'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
    });
    try {
        if (signal.aborted) return await cancelled;
        return await Promise.race([Promise.resolve().then(action), cancelled]);
    } finally { signal.removeEventListener('abort', abort); }
}

export async function requestCreatorConnection(draft, { send, validate, signal, profileLabel = profile => profile || 'Current connection' }) {
    const { profiles, maxTokens } = creatorConnection(draft);
    const failures = [];
    for (const profile of profiles) {
        validate();
        if (signal?.aborted) throw new Error('Request cancelled. Nothing was applied.');
        try {
            const result = await withCreatorAbort(() => send(profile, maxTokens), signal);
            validate();
            if (signal?.aborted) throw new Error('Request cancelled. Nothing was applied.');
            return result;
        } catch (error) {
            validate();
            if (signal?.aborted || error?.name === 'AbortError' || error?.message === 'Cancelled by stop event') throw error;
            failures.push(`${profileLabel(profile)}: ${creatorConnectionError(error)}`);
        }
    }
    throw new Error(`Catelier could not get a reply.\n${failures.join('\n')}`);
}
