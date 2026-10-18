/**
 * Per-chat persistent state, stored under chat_metadata.MacroEnhanced and saved
 * inside the chat file by the host. The metadata object is reassigned by the host
 * on chat switches, so it is re-read from the context on every call. Never cache
 * the returned state across events.
 *
 * Reading is not writing: `peekChatState()` never creates the metadata block, and
 * `resolveMacroState()` gives previews a throwaway copy so a prompt preview, a
 * dry run or the Playground cannot store a value or queue a metadata save.
 */
import { MODULE_NAME } from './settings.js';
import { areVariablesReadOnly } from '../../../../variable-read-only.js';
import { notifyMacroDataChanged } from './data-events.js';

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

/** Whether there is a chat the state could belong to. */
function hasChatContext() {
    const ctx = SillyTavern.getContext();
    return !!ctx.chatMetadata && ctx.chatId !== undefined && ctx.chatId !== null;
}

/**
 * The stored state when it already exists, without creating anything. Never
 * mutates the returned object; callers that need a normalised shape should use
 * `getChatState()` (writers) or clone it first (previews).
 *
 * @returns {object|null}
 */
export function peekChatState() {
    const ctx = SillyTavern.getContext();
    const meta = ctx.chatMetadata;
    if (!meta || ctx.chatId === undefined || ctx.chatId === null) {
        return null;
    }
    const state = meta[MODULE_NAME];
    return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
}

/**
 * The live per-chat state object, created lazily inside the current chat's
 * metadata. Returns null when no chat is loaded (there is nowhere to persist).
 * Every call is a write, so macro readers must use `peekChatState()` instead.
 *
 * @returns {object|null}
 */
export function getChatState() {
    const ctx = SillyTavern.getContext();
    const meta = ctx.chatMetadata;
    if (!meta || ctx.chatId === undefined || ctx.chatId === null) {
        return null;
    }
    if (!meta[MODULE_NAME] || typeof meta[MODULE_NAME] !== 'object' || Array.isArray(meta[MODULE_NAME])) {
        meta[MODULE_NAME] = emptyState();
    }
    const state = meta[MODULE_NAME];
    if (state.version !== CHAT_STATE_VERSION) {
        migrate(state);
    }
    // A real write starts a new preview generation; never keep serving a clone.
    readOnlySession = null;
    return repair(state);
}

/** Queues a background save of the chat metadata (safe across chat switches). */
export function touchChatState(kind = 'values') {
    SillyTavern.getContext().saveMetadataDebounced?.();
    notifyMacroDataChanged(kind);
}

/**
 * Read-only previews run one synchronous macro build. Writes inside that build
 * must be visible to later macros in the same build (so a `{{setchatvar}}`
 * followed by `{{getchatvar}}` behaves as it would for real), then vanish. One
 * clone is kept for the synchronous build and cleared in a microtask.
 */
let readOnlySession = null;
let readOnlyResetQueued = false;

function beginReadOnlySession() {
    if (!readOnlyResetQueued) {
        readOnlyResetQueued = true;
        queueMicrotask(() => {
            readOnlySession = null;
            readOnlyResetQueued = false;
        });
    }
    if (readOnlySession) {
        return readOnlySession;
    }
    const live = peekChatState();
    if (live) {
        readOnlySession = { state: repair(structuredClone(live)) };
    } else if (hasChatContext()) {
        readOnlySession = { state: emptyState() };
    } else {
        readOnlySession = { state: null };
    }
    return readOnlySession;
}

/**
 * The state a macro may use.
 *
 * - `sandbox`: the Playground overlay, shared by every evaluation in the session.
 * - `readonly`: a throwaway clone for a prompt preview or dry run. Reads see real
 *   values and sequential writes work inside the build, but nothing is stored,
 *   saved or announced.
 * - `live`: the real chat state. Only writers ask for this, and only they create
 *   the empty block.
 *
 * @param {object} [env] - Macro execution environment (`ctx.env`).
 * @param {object} [options]
 * @param {boolean} [options.write] - The caller will store a value.
 * @returns {{state: object|null, mode: 'sandbox'|'readonly'|'live', chatOpen: boolean}}
 */
export function resolveMacroState(env, { write = false } = {}) {
    const sandboxState = env?.extra?.meSandboxState;
    if (sandboxState) {
        return { state: sandboxState, mode: 'sandbox', chatOpen: true };
    }
    if (areVariablesReadOnly()) {
        return { state: beginReadOnlySession().state, mode: 'readonly', chatOpen: hasChatContext() };
    }
    readOnlySession = null;
    return {
        state: write ? getChatState() : peekChatState(),
        mode: 'live',
        chatOpen: hasChatContext(),
    };
}

function bumpCounter(key) {
    const state = getChatState();
    if (!state) {
        return;
    }
    state.counters[key] += 1;
    touchChatState('values');
}

// Counters are maintained ONLY from chat events (index.js), never from macro
// handlers. Prompt builds and token-count dry runs must not drift them.
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
