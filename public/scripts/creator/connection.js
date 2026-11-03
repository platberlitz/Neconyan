export function creatorConnection(draft) {
    const value = draft.writing?.connection ?? {};
    const maxTokens = Number(value.maxTokens ?? 64000);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('Maximum output tokens must be a positive whole number.');
    return { profiles: [...new Set([value.profile || '', ...(value.fallbacks ?? []).filter(Boolean)])], maxTokens };
}

export async function requestCreatorConnection(draft, { send, validate, signal, profileLabel = profile => profile || 'Current connection' }) {
    const { profiles, maxTokens } = creatorConnection(draft);
    const failures = [];
    for (const profile of profiles) {
        validate();
        if (signal?.aborted) throw new Error('Request cancelled. Nothing was applied.');
        try {
            const result = await send(profile, maxTokens);
            validate();
            if (signal?.aborted) throw new Error('Request cancelled. Nothing was applied.');
            return result;
        } catch (error) {
            validate();
            if (signal?.aborted || error?.name === 'AbortError' || error?.message === 'Cancelled by stop event') throw error;
            const messages = [];
            for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth++) {
                const message = cause.message || String(cause);
                if (!messages.includes(message)) messages.push(message);
            }
            failures.push(`${profileLabel(profile)}: ${messages.join(': ')}`);
        }
    }
    throw new Error(`Creator could not get a reply.\n${failures.join('\n')}`);
}
