// Transient display data only. Never used for delivery, prompts or recovery.
const previews = new Map();
const listeners = new Map();
const keyFor = (owner, id) => JSON.stringify([owner, id]);

export function readConversationPreview(owner, id) {
    return { participants: [...(previews.get(keyFor(owner, id))?.values() ?? [])] };
}

export function publishConversationPreview(context, snapshot, value) {
    const { owner, job } = context;
    const id = job.parentId || job.id;
    const key = keyFor(owner, id);
    const participants = previews.get(key) ?? new Map();
    if (value) {
        participants.set(job.id, { id: job.id, target: snapshot.target, ...snapshot.speaker,
            token_count: value.token_count, reasoning_tokens: value.reasoning_tokens,
            text: String(value.text || '').slice(0, 256 * 1024) });
        previews.set(key, participants);
        while (previews.size > 128) previews.delete(previews.keys().next().value);
    } else {
        participants.delete(job.id);
        if (!participants.size) previews.delete(key);
    }
    const preview = readConversationPreview(owner, id);
    for (const listener of listeners.get(key) ?? []) {
        try { listener(preview); } catch { /* Viewers cannot affect the worker. */ }
    }
}

export function subscribeConversationPreview(owner, id, listener) {
    const key = keyFor(owner, id);
    const set = listeners.get(key) ?? new Set();
    set.add(listener);
    listeners.set(key, set);
    return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
}
