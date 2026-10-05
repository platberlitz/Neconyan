// Display-only streaming text. It never supplies a prompt, a recovery proof or a saved reply.
const previews = new Map();
const listeners = new Map();
const keyFor = (owner, id) => JSON.stringify([owner, id]);
const MAX_TEXT = 256 * 1024;
const MAX_PREVIEWS = 64;

export function publishScratchpadPreview(owner, id, update) {
    const key = keyFor(owner, id);
    const value = { ...previews.get(key), ...update, updatedAt: Date.now() };
    for (const field of ['text', 'reasoning']) {
        if (typeof value[field] !== 'string') value[field] = '';
        if (value[field].length > MAX_TEXT) value[field] = value[field].slice(0, MAX_TEXT);
    }
    previews.delete(key);
    previews.set(key, value);
    while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value);
    for (const listener of listeners.get(key) ?? []) {
        try { listener(value); } catch { /* A disconnected viewer does not own the reply. */ }
    }
}

export function readScratchpadPreview(owner, id) {
    return previews.get(keyFor(owner, id)) ?? null;
}

export function clearScratchpadPreview(owner, id) {
    previews.delete(keyFor(owner, id));
}

export function subscribeScratchpadPreview(owner, id, listener) {
    const key = keyFor(owner, id);
    const set = listeners.get(key) ?? new Set();
    set.add(listener);
    listeners.set(key, set);
    return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(key);
    };
}
