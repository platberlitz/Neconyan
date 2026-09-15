/**
 * Per-chat persistent state, stored under chat_metadata.MacroEnhanced and saved
 * inside the chat file by the host. The metadata object is REASSIGNED by the host
 * on chat switches, so it is re-read from the context on every call. never cache
 * the returned state across events.
 */
import { MODULE_NAME } from './settings.js';

export const CHAT_STATE_VERSION = 3;

/** The four maps that hold stored macro values, keyed by user-chosen key. */
export const VALUE_KINDS = Object.freeze(['frozen', 'sticky', 'daily', 'rolls']);

export function emptyState() {
    return {
        version: CHAT_STATE_VERSION,
        frozen: {},
        sticky: {},
        daily: {},
        rolls: {},
        chatVars: {},
        counters: { userMessages: 0, charMessages: 0, swipes: 0, generations: 0, firstSeenAt: Date.now() },
        customMacros: [],
        pronouns: { user: '', char: '' },
    };
}

function migrate(state) {
    // v1 -> v2: added chatVars, the {{setchatvar}} namespace. Deliberately its own
    // map rather than the host's chat_metadata.variables: content routinely stores
    // scratch values with {{setvar}} under the same prefixes {{foreachChatVar}}
    // iterates, and a shared namespace would let those scratch keys show up as
    // loop items.
    //
    // v2 -> v3: added pronouns, the {{setpronouns}} per-chat override. repair()
    // creates it, so there is nothing to convert.
    state.version = CHAT_STATE_VERSION;
    return state;
}

function repair(state) {
    for (const kind of VALUE_KINDS) {
        if (!state[kind] || typeof state[kind] !== 'object' || Array.isArray(state[kind])) {
            state[kind] = {};
        }
    }
    if (!state.chatVars || typeof state.chatVars !== 'object' || Array.isArray(state.chatVars)) {
        state.chatVars = {};
    }
    if (!state.counters || typeof state.counters !== 'object') {
        state.counters = emptyState().counters;
    }
    for (const key of ['userMessages', 'charMessages', 'swipes', 'generations']) {
        if (!Number.isFinite(state.counters[key])) {
            state.counters[key] = 0;
        }
    }
    if (!Number.isFinite(state.counters.firstSeenAt)) {
        state.counters.firstSeenAt = Date.now();
    }
    if (!Array.isArray(state.customMacros)) {
        state.customMacros = [];
    }
    if (!state.pronouns || typeof state.pronouns !== 'object' || Array.isArray(state.pronouns)) {
        state.pronouns = { user: '', char: '' };
    }
    return state;
}

/**
 * The live per-chat state object, created lazily inside the current chat's
 * metadata. Returns null when no chat is loaded (there is nowhere to persist).
 */
export function getChatState() {
    const ctx = SillyTavern.getContext();
    const meta = ctx.chatMetadata;
    if (!meta || ctx.chatId === undefined || ctx.chatId === null) {
        return null;
    }
    if (!meta[MODULE_NAME] || typeof meta[MODULE_NAME] !== 'object') {
        meta[MODULE_NAME] = emptyState();
    }
    const state = meta[MODULE_NAME];
    if (state.version !== CHAT_STATE_VERSION) {
        migrate(state);
    }
    return repair(state);
}

/** Queues a background save of the chat metadata (safe across chat switches). */
export function touchChatState() {
    SillyTavern.getContext().saveMetadataDebounced?.();
}

function bumpCounter(key) {
    const state = getChatState();
    if (!state) {
        return;
    }
    state.counters[key] += 1;
    touchChatState();
}

// Counters are maintained ONLY from chat events (index.js), never from macro
// handlers. prompt builds and token-count dry runs must not drift them.
export function recordUserMessage() {
    bumpCounter('userMessages');
}

export function recordCharMessage() {
    bumpCounter('charMessages');
}

export function recordSwipe() {
    bumpCounter('swipes');
}

export function recordGeneration() {
    bumpCounter('generations');
}
