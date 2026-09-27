import { readArtifact, writeArtifact } from '../jobs/artifacts.js';

// Display-only state. It never supplies a prompt, a recovery proof or a chat write.
const previews = new Map();
const listeners = new Map();
const keyFor = (owner, id) => JSON.stringify([owner, id]);
const MAX_TEXT = 256 * 1024;

export function publishRoleplayPreview(context, update) {
    const { job, owner, directories } = context;
    const id = job.intent?.request?.workflowCandidate?.parentJobId;
    if (!id) return;
    const key = keyFor(owner, id);
    const previous = previews.get(key);
    const sameChild = previous?.childId === job.id;
    const value = { ...(sameChild ? previous : {}), ...update, childId: job.id,
        name: job.intent.request.characterName, avatar: job.intent.request.worldInfo?.avatar,
        updatedAt: Date.now() };
    for (const field of ['text', 'reasoning']) {
        if (typeof value[field] !== 'string') value[field] = '';
        if (Buffer.byteLength(value[field]) > MAX_TEXT) value[field] = value[field].slice(0, MAX_TEXT / 4);
    }
    previews.delete(key);
    previews.set(key, value);
    while (previews.size > 128) previews.delete(previews.keys().next().value);
    // Completed model text survives a browser or server reconnect. Token updates
    // stay in memory so a disk flush cannot delay each incoming token.
    if (update.stage && update.stage !== 'generating') {
        try { writeArtifact(directories, id, 'roleplay-preview', value); } catch { /* A display failure cannot invalidate a paid reply. */ }
    }
    for (const listener of listeners.get(key) ?? []) {
        try { listener(value); } catch { /* A disconnected viewer does not own the job. */ }
    }
}

export function readRoleplayPreview({ owner, directories, job }) {
    return previews.get(keyFor(owner, job.id)) ?? readArtifact(directories, job.id, 'roleplay-preview') ?? null;
}

export function subscribeRoleplayPreview(owner, id, listener) {
    const key = keyFor(owner, id);
    const set = listeners.get(key) ?? new Set();
    set.add(listener);
    listeners.set(key, set);
    return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
}
