export function creatorConnection(draft) {
    const value = draft.writing?.connection ?? {};
    const maxTokens = Number(value.maxTokens ?? 64000);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('Maximum output tokens must be a positive whole number.');
    return { profiles: [...new Set([value.profile || '', ...(value.fallbacks ?? []).filter(Boolean)])], maxTokens };
}

export async function requestCreatorConnection(draft, { send, validate, signal }) {
    const { profiles, maxTokens } = creatorConnection(draft);
    let failure;
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
            if (signal?.aborted || error?.name === 'AbortError') throw error;
            failure = error;
        }
    }
    throw failure;
}
