// Follow-ups typed while a Scratchpad reply is still being written. Kept free of the DOM so the rules can be tested alone.

export const MAX_QUEUED_FOLLOW_UPS = 5;

const HOLDS = new Set(['stopped', 'failed', 'context', 'reopened']);

let sequence = 0;

export function followUpKey(source, sessionId) {
    const bucketKey = JSON.stringify([source?.kind || '', source?.key || '']);
    return `${bucketKey}:${sessionId || ''}`;
}

export function createFollowUpQueues() {
    return new Map();
}

export function followUpState(queues, key) {
    return queues.get(key) || { items: [], held: null };
}

function save(queues, key, state) {
    if (!state.items.length) queues.delete(key);
    else queues.set(key, state);
    return followUpState(queues, key);
}

export function createFollowUp({ text = '', attachments = [], source = null, sourceKey = '', createdAt = Date.now(), id = '' } = {}) {
    sequence += 1;
    return {
        id: id || `follow-up-${createdAt}-${sequence}`,
        text: String(text || ''),
        attachments: [...attachments],
        sourceKey: String(sourceKey || ''),
        source,
        createdAt,
    };
}

export function enqueueFollowUp(queues, key, item) {
    const state = followUpState(queues, key);
    if (state.items.length >= MAX_QUEUED_FOLLOW_UPS) return { added: false, state };
    return { added: true, state: save(queues, key, { ...state, items: [...state.items, item] }) };
}

// Puts an item back at the front, as when a queued send could not go out.
export function restoreFollowUp(queues, key, item) {
    const state = followUpState(queues, key);
    return save(queues, key, { ...state, items: [item, ...state.items.filter(entry => entry.id !== item.id)] });
}

export function dequeueFollowUp(queues, key) {
    const state = followUpState(queues, key);
    const [item = null, ...rest] = state.items;
    return { item, state: save(queues, key, { items: rest, held: rest.length ? state.held : null }) };
}

export function removeFollowUp(queues, key, id) {
    const state = followUpState(queues, key);
    const items = state.items.filter(item => item.id !== id);
    return save(queues, key, { items, held: items.length ? state.held : null });
}

export function takeFollowUpForEdit(queues, key, id) {
    const state = followUpState(queues, key);
    const item = state.items.find(entry => entry.id === id) || null;
    return { item, state: item ? removeFollowUp(queues, key, id) : state };
}

export function holdFollowUps(queues, key, reason) {
    if (!HOLDS.has(reason)) throw new TypeError(`Unknown follow-up hold: ${reason}`);
    const state = followUpState(queues, key);
    if (!state.items.length) return state;
    return save(queues, key, { ...state, held: reason });
}

export function clearHold(queues, key) {
    const state = followUpState(queues, key);
    if (!state.items.length) return state;
    return save(queues, key, { ...state, held: null });
}

export function clearFollowUps(queues) {
    queues.clear();
}

// Decides what a queue does when the session's pending state is next seen. settledStates are the
// states of the replies to the latest user message: 'done', 'failed', 'cancelled' or 'pending'.
export function reconcilePendingTransition({ wasPending = false, isPending = false, settledStates = [], visible = true, sameSource = true } = {}) {
    if (isPending || settledStates.includes('pending')) return 'wait';
    if (!wasPending) return 'idle';
    if (settledStates.includes('cancelled')) return 'hold-stopped';
    if (settledStates.includes('failed')) return 'hold-failed';
    if (!visible) return 'hold-reopened';
    if (!sameSource) return 'hold-context';
    return 'send';
}
