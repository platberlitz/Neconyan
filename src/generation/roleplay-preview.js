import { readArtifact, writeArtifact } from '../jobs/artifacts.js';

// Display state. It never supplies a prompt or a recovery proof. The terminal
// keeper may capture its text as a paid partial before it writes the chat.
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
    // Tell every connected viewer before touching the disk. The stage label and
    // pending Companion cards are what the reader is waiting for, and a slow or
    // failed display write must never delay or invalidate that frame.
    for (const listener of listeners.get(key) ?? []) {
        try { listener(value); } catch { /* A disconnected viewer does not own the job. */ }
    }
    // Completed model text survives a browser or server reconnect. The write is
    // display-only and not fsynced. A crash can lose a stopped partial frame
    // before the terminal keeper captures it, but never a saved paid result.
    if ((update.stage && update.stage !== 'generating') || update.inChatAgentCompanionResults) {
        try { writeArtifact(directories, id, 'roleplay-preview', value, { durable: false }); } catch { /* A display failure cannot invalidate a paid reply. */ }
    }
}

export function readRoleplayPreview({ owner, directories, job }) {
    const value = previews.get(keyFor(owner, job.id)) ?? readArtifact(directories, job.id, 'roleplay-preview') ?? null;
    const startedAt = Date.parse(value?.gen_started);
    if (value?.stage === 'generating' && value.reasoning && !value.reasoning_finished && Number.isFinite(startedAt)) {
        return { ...value, reasoning_duration: Math.max(0, Date.now() - startedAt) };
    }
    return value;
}

const TEXT_INTERVAL_MS = 33;
const COUNT_INTERVAL_MS = 500;

/**
 * Publish stream text on a ~33ms leading/trailing limit, independent of token
 * counting. Counts run with the accepted reply's tokenizer at most every 500ms,
 * stretch proportionally when the tokenizer measures slow on this server,
 * recount only fields whose CONTENT changed (a same-length rewrite still moves
 * token counts), and include a paused stream's last chunk. Stop ends every
 * publication and timer.
 */
export function createRoleplayStreamPreview(context, count) {
    let latest;
    let stopped = false;
    let textTimer = null;
    let countTimer = null;
    let lastTextAt = 0;
    let lastCountAt = 0;
    let countInterval = COUNT_INTERVAL_MS;
    const counted = { text: null, reasoning: null, token_count: 0, reasoning_tokens: 0 };
    const publishText = () => {
        clearTimeout(textTimer);
        textTimer = null;
        if (!latest || stopped || context.signal.aborted) return;
        lastTextAt = Date.now();
        publishRoleplayPreview(context, { ...latest, stage: 'generating' });
    };
    const publishCounts = () => {
        clearTimeout(countTimer);
        countTimer = null;
        if (!latest || stopped || context.signal.aborted) return;
        const started = Date.now();
        if (latest.text !== counted.text) { counted.text = latest.text; counted.token_count = count(latest.text || ''); }
        if (latest.reasoning !== counted.reasoning) { counted.reasoning = latest.reasoning; counted.reasoning_tokens = count(latest.reasoning || ''); }
        lastCountAt = Date.now();
        // A slow tokenizer shares the small server with the stream itself: back
        // off proportionally, but never count more often than the 500ms cap.
        countInterval = Math.max(COUNT_INTERVAL_MS, 10 * (lastCountAt - started));
        publishRoleplayPreview(context, { ...latest, stage: 'generating',
            token_count: counted.token_count, reasoning_tokens: counted.reasoning_tokens });
    };
    return {
        publish(value) {
            if (stopped) return;
            latest = value;
            const textRemaining = TEXT_INTERVAL_MS - (Date.now() - lastTextAt);
            if (textRemaining <= 0) publishText();
            else if (!textTimer) textTimer = setTimeout(publishText, textRemaining);
            const countRemaining = countInterval - (Date.now() - lastCountAt);
            if (countRemaining <= 0) publishCounts();
            else if (!countTimer) countTimer = setTimeout(publishCounts, countRemaining);
        },
        stop() {
            stopped = true;
            clearTimeout(textTimer);
            clearTimeout(countTimer);
            textTimer = null;
            countTimer = null;
            latest = null;
        },
    };
}

export function subscribeRoleplayPreview(owner, id, listener) {
    const key = keyFor(owner, id);
    const set = listeners.get(key) ?? new Set();
    set.add(listener);
    listeners.set(key, set);
    return () => { set.delete(listener); if (!set.size && listeners.get(key) === set) listeners.delete(key); };
}
