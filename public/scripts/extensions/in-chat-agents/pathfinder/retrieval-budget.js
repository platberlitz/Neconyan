function getContext() {
    return globalThis.window?.SillyTavern?.getContext?.() ?? {};
}

export async function countRetrievalTokens(text) {
    const context = getContext();
    const count = context.getTokenCountAsync
        ? await context.getTokenCountAsync(text)
        : context.getTokenCount?.(text);
    // Older hosts without a tokenizer use a conservative byte count, never a four-character estimate.
    return Number.isFinite(count) && count >= 0 ? count : new TextEncoder().encode(text).length;
}

export function getRetrievalContextLimit(profileId = '') {
    const context = getContext();
    const profile = profileId ? context.ConnectionManagerRequestService?.getProfile?.(profileId) : null;
    const api = context.CONNECT_API_MAP?.[profile?.api]?.selected ?? context.mainApi;
    const preset = profile?.preset ? context.getPresetManager?.(api)?.getCompletionPresetByName?.(profile.preset) : null;
    const limit = Number(preset?.openai_max_context ?? preset?.max_context ?? context.getMaxContextTokens?.() ?? context.maxContext ?? 8192);
    return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8192;
}

export async function getRetrievalOutputLimit(messages, requested, profileId = '') {
    const inputTokens = await countRetrievalTokens(messages.map(message => message.content).join('\n\n'));
    const available = getRetrievalContextLimit(profileId) - inputTokens - 64;
    if (available < 1) throw new Error('The retrieval request exceeds the connection\'s context limit. Shorten its history or entry list.');
    return Math.max(1, Math.min(Math.floor(Number(requested) || 2048), available));
}

export function formatRetrievalContext(entries) {
    return entries.length ? `<pathfinder_context>\n${entries.map(entry => `[${entry.name}]\n${entry.content}`).join('\n\n')}\n</pathfinder_context>` : '';
}

export async function fitRetrievalEntries(entries, nativeEntries = []) {
    const context = getContext();
    const promptLimit = Number(context.getMaxPromptTokens?.() ?? getRetrievalContextLimit() - 1024);
    const fields = context.getCharacterCardFields?.() ?? {};
    const reservedText = [
        ...Object.values(fields).filter(value => typeof value === 'string'),
        ...(context.chat ?? []).filter(message => !message.is_system).slice(-10).map(message => String(message.mes ?? message.content ?? '')),
        ...Object.entries(context.extensionPrompts ?? {}).filter(([key]) => !key.startsWith('pathfinder_')).map(([, prompt]) => prompt.value ?? ''),
        ...(context.chatCompletionSettings?.prompts ?? []).filter(prompt => prompt.enabled !== false).map(prompt => prompt.content ?? ''),
        ...nativeEntries.map(entry => entry.content ?? ''),
    ].join('\n\n');
    // Keep room for the main reply's recent conversation and mandatory context; retrieval gets at most a quarter.
    const budget = Math.max(0, Math.min(Math.floor(promptLimit / 4), promptLimit - await countRetrievalTokens(reservedText) - 128));
    const selected = [];
    const skipped = [];
    for (const entry of entries) {
        if (await countRetrievalTokens(formatRetrievalContext([...selected, entry])) <= budget) selected.push(entry);
        else skipped.push({ bookName: entry.bookName, uid: entry.uid, name: entry.name });
    }
    return { selected, skipped, budget };
}
