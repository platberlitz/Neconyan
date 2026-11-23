import { FINGERPRINT_WIDTH, commonAffixLengths, digestKeptFingerprints, fingerprintText } from './chat-patch-fingerprint.js';

/**
 * A chat save sends what changed. The page keeps, for each chat file version the server confirmed, one
 * fingerprint per message. A later save compares the current messages with them and sends only the
 * messages between the unchanged start and the unchanged end. The server checks the same fingerprints
 * against its own file, so a base that is wrong in any way is refused and the page sends the whole chat.
 */

/** Below this many characters of message text a whole save is as cheap as a patch. */
export const CHAT_PATCH_MIN_CHARS = 262144;

const REMEMBERED_BASES = 8;

/** One message, serialised once when the save was queued, so later edits cannot reach it. */
export class SavedMessage {
    /**
     * @param {string} json
     * @param {number} first Fingerprint word
     * @param {number} second Fingerprint word
     * @param {number} length Text length
     */
    constructor(json, first, second, length) {
        this.json = json;
        this.first = first;
        this.second = second;
        this.length = length;
    }

    /** Anything that stringifies a snapshot like plain messages still writes the same chat. */
    toJSON() {
        return JSON.parse(this.json);
    }
}

/**
 * Serialises every message once, one at a time: no copy of the chat as one object or one string exists.
 * @param {object[]} messages
 * @returns {SavedMessage[]}
 */
export function snapshotChatMessages(messages) {
    const words = new Uint32Array(FINGERPRINT_WIDTH);
    const saved = new Array(messages.length);
    for (let index = 0; index < messages.length; index++) {
        const json = JSON.stringify(messages[index]) ?? 'null';
        fingerprintText(json, words, 0);
        saved[index] = new SavedMessage(json, words[0], words[1], words[2]);
    }
    return saved;
}

/**
 * The fingerprints of messages, without keeping their text.
 * @param {object[]} records
 * @param {number} [from] Index of the first message (1 skips a chat header)
 * @returns {Uint32Array}
 */
export function fingerprintMessages(records, from = 0) {
    const count = Math.max(0, records.length - from);
    const words = new Uint32Array(count * FINGERPRINT_WIDTH);
    for (let index = 0; index < count; index++) fingerprintText(JSON.stringify(records[from + index]) ?? 'null', words, index * FINGERPRINT_WIDTH);
    return words;
}

/** A short text that is equal for two message lists exactly when their fingerprints are equal. */
export function digestMessageFingerprints(words) {
    return digestKeptFingerprints(words, words.length / FINGERPRINT_WIDTH, words.length / FINGERPRINT_WIDTH, 0);
}

/** @param {SavedMessage[]} saved */
export function savedMessageFingerprints(saved) {
    const words = new Uint32Array(saved.length * FINGERPRINT_WIDTH);
    for (let index = 0; index < saved.length; index++) {
        words[index * FINGERPRINT_WIDTH] = saved[index].first;
        words[index * FINGERPRINT_WIDTH + 1] = saved[index].second;
        words[index * FINGERPRINT_WIDTH + 2] = saved[index].length;
    }
    return words;
}

/** The messages of a save payload's `chat` when every one of them was serialised by `snapshotChatMessages`. */
export function savedMessagesOf(chat) {
    if (!Array.isArray(chat) || chat.length < 1) return null;
    for (let index = 1; index < chat.length; index++) if (!(chat[index] instanceof SavedMessage)) return null;
    return chat.slice(1);
}

const bases = new Map();

const baseKey = source => `${source.instanceId}:${source.revision}:${source.rawHash}`;

/**
 * Records what the server holds for this exact file version. A save is only sent as a patch against
 * a base for the very version it names.
 * @param {{instanceId: string, revision: number, rawHash: string}} source
 * @param {Uint32Array} words
 */
export function rememberChatPatchBase(source, words) {
    if (!source || typeof source.instanceId !== 'string') return;
    const key = baseKey(source);
    bases.delete(key);
    bases.set(key, { words, count: words.length / FINGERPRINT_WIDTH, refused: false });
    while (bases.size > REMEMBERED_BASES) bases.delete(bases.keys().next().value);
}

/** A file version the server would not patch is not offered a patch again until it changes. */
export function refuseChatPatchBase(source) {
    const base = source && bases.get(baseKey(source));
    if (base) base.refused = true;
}

export function chatPatchBaseFor(source) {
    const base = source && typeof source.instanceId === 'string' ? bases.get(baseKey(source)) : null;
    return base && !base.refused ? base : null;
}

let routeMissing = false;

/** An older server answers a patch with 'not found'. Until the page reloads, saves go whole instead of asking again. */
export function markChatPatchUnsupported() {
    routeMissing = true;
}

export function forgetChatPatchBases() {
    bases.clear();
    routeMissing = false;
}

/**
 * @param {SavedMessage[]} saved
 * @param {{words: Uint32Array, count: number}} base
 * @returns {{prefix: number, suffix: number, kept: string, words: Uint32Array} | null} The unchanged start and end, or null when a patch would not help
 */
export function planChatPatch(saved, base) {
    if (routeMissing) return null;
    let characters = 0;
    for (const message of saved) characters += message.length;
    if (characters < CHAT_PATCH_MIN_CHARS) return null;
    const words = savedMessageFingerprints(saved);
    const { prefix, suffix } = commonAffixLengths(base.words, base.count, words, saved.length);
    if (prefix + suffix === 0) return null;
    return { prefix, suffix, words, kept: digestKeptFingerprints(base.words, base.count, prefix, suffix) };
}

/**
 * The request body of a whole save, built from the saved texts without parsing them again.
 * @param {object} rest Every field of the request except the chat
 * @param {object} header
 * @param {SavedMessage[]} saved
 */
export function composeFullBody(rest, header, saved) {
    const head = JSON.stringify(rest);
    const prefix = head === '{}' ? '{' : `${head.slice(0, -1)},`;
    const rows = [JSON.stringify(header) ?? 'null'];
    for (const message of saved) rows.push(message.json);
    return `${prefix}"chat":[${rows.join(',')}]}`;
}

/**
 * The request body of a patch: the header, the count of unchanged messages at each end, and the messages between.
 * @param {object} rest Every field of the request except the chat
 * @param {object} header
 * @param {SavedMessage[]} saved
 * @param {{prefix: number, suffix: number, kept: string}} plan
 * @param {number} baseCount
 */
export function composePatchBody(rest, header, saved, plan, baseCount) {
    const head = JSON.stringify(rest);
    const prefix = head === '{}' ? '{' : `${head.slice(0, -1)},`;
    const middle = [];
    for (let index = plan.prefix; index < saved.length - plan.suffix; index++) middle.push(saved[index].json);
    const patch = JSON.stringify({ prefix: plan.prefix, suffix: plan.suffix, baseCount, count: saved.length, kept: plan.kept });
    return `${prefix}"patch":{"header":${JSON.stringify(header) ?? 'null'},${patch.slice(1, -1)},"messages":[${middle.join(',')}]}}`;
}
