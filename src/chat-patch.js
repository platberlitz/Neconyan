import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { FINGERPRINT_WIDTH, fingerprintText } from '../public/scripts/chat-patch-fingerprint.js';
import { registerMemoryReclaimer } from './memory-pressure.js';
import { isConstrainedMobileRuntime } from './runtime.js';
import { roleplayError } from './roleplay-store.js';

/**
 * Saving one changed message must not rebuild, rehash or reparse the whole chat. The page sends the
 * messages between the unchanged start and the unchanged end of the chat it last saw; this module holds
 * what the server needs to build and check the result from those pieces:
 *
 *  - an index of the saved file: where each line is, a fingerprint of each line (the same function the
 *    page uses, so the page's claim about the unchanged lines can be checked against the file itself),
 *    and the canonical text of each message, which is what the chat's content hash is made of;
 *  - the bytes of the new file, joined from the base file's own bytes for the unchanged lines and the
 *    new text for the rest.
 *
 * The index describes exact bytes and is keyed by their SHA-256, so it can only ever be used for the
 * bytes it was built from.
 */

export const PATCH_BASE_ERROR = 'ROLEPLAY_PATCH_BASE';

/** Nothing was written. The page answers by sending the whole chat. */
export function chatPatchMismatch(reason) {
    return Object.assign(roleplayError(PATCH_BASE_ERROR, 'The saved chat no longer matches this change. Sending the whole chat instead.', 409), { reason });
}

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const headerDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * The text `canonical(value)` gives, for a value from `JSON.parse`; null for the few parsed values
 * (-0 and numbers beyond double range) that the hash of a chat treats through its checked legacy path.
 */
export function canonicalText(value) {
    const out = [];
    const walk = node => {
        if (node === null) { out.push('null'); return true; }
        switch (typeof node) {
            case 'string': out.push(JSON.stringify(node)); return true;
            case 'boolean': out.push(node ? 'true' : 'false'); return true;
            case 'number':
                if (!Number.isFinite(node) || Object.is(node, -0)) return false;
                out.push(String(node));
                return true;
            case 'object': break;
            default: return false;
        }
        if (Array.isArray(node)) {
            out.push('[');
            for (let index = 0; index < node.length; index++) {
                if (index > 0) out.push(',');
                if (!walk(node[index])) return false;
            }
            out.push(']');
            return true;
        }
        out.push('{');
        const keys = Object.keys(node).sort();
        for (let index = 0; index < keys.length; index++) {
            if (index > 0) out.push(',');
            out.push(JSON.stringify(keys[index]), ':');
            if (!walk(node[keys[index]])) return false;
        }
        out.push('}');
        return true;
    };
    try {
        return walk(value) ? out.join('') : null;
    } catch {
        return null;
    }
}

/** The header record exactly as `parseChatJsonl` gives it, from the first line of a chat file. Null when it is not a usable header. */
export function parseChatHeaderBytes(bytes, end) {
    try {
        const record = JSON.parse(headerDecoder.decode(bytes.subarray(0, end)));
        if (!isPlain(record)) return null;
        const recognised = record.chat_metadata !== undefined ? isPlain(record.chat_metadata) : record.user_name !== undefined || record.name !== undefined;
        if (!recognised) return null;
        return isPlain(record.chat_metadata) ? record : { ...record, chat_metadata: {} };
    } catch {
        return null;
    }
}

/**
 * @typedef {object} ChatPatchIndex
 * @property {number} count Messages (lines after the header)
 * @property {Uint32Array} starts First byte of each line, header first
 * @property {Uint32Array} ends One past the last byte of each line
 * @property {Uint32Array} fingerprints `FINGERPRINT_WIDTH` words per message
 * @property {Buffer[]} canonical Canonical text of each message
 * @property {number} size Bytes held, for the cache limit
 */

/**
 * Indexes a chat file in the exact shape a patch can build on: valid UTF-8, no byte order mark, a usable header,
 * and one non-blank JSON object per line. Anything else returns null and is saved the whole way.
 * Reads every line once; this is the one-off cost of the first patch of a file version.
 * @param {Buffer} bytes
 * @returns {ChatPatchIndex|null}
 */
export function buildChatPatchIndex(bytes) {
    if (!isUtf8(bytes) || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) return null;
    const startList = [];
    const endList = [];
    for (let start = 0; ;) {
        const end = bytes.indexOf(0x0a, start);
        startList.push(start);
        endList.push(end === -1 ? bytes.length : end);
        if (end === -1) break;
        start = end + 1;
    }
    const count = startList.length - 1;
    const starts = Uint32Array.from(startList);
    const ends = Uint32Array.from(endList);
    if (!parseChatHeaderBytes(bytes, ends[0])) return null;
    const fingerprints = new Uint32Array(count * FINGERPRINT_WIDTH);
    const canonical = new Array(count);
    let size = 0;
    for (let line = 1; line <= count; line++) {
        const text = bytes.toString('utf8', starts[line], ends[line]);
        if (text.trim() === '') return null;
        let record;
        try { record = JSON.parse(text); } catch { return null; }
        if (!isPlain(record)) return null;
        const canon = canonicalText(record);
        if (canon === null) return null;
        fingerprintText(text, fingerprints, (line - 1) * FINGERPRINT_WIDTH);
        canonical[line - 1] = Buffer.from(canon, 'utf8');
        size += canonical[line - 1].length;
    }
    return { count, starts, ends, fingerprints, canonical, size: size + count * 16 };
}

// The newest few file versions. Entries are only memory and are rebuilt from the file when missing.
// An index holds about as many bytes as its chat (the canonical text of every message): 37 MB for the 36.6 MB test chat, and at
// most about 64 MB, the largest chat the store accepts. A phone or Termux server keeps one index, which is the open chat, and
// gives it room for a chat of that largest size; everything else keeps the newest three within 192 MiB.
const MAX_INDEXES = 3;
const MAX_INDEX_BYTES = 192 * 1024 * 1024;
const CONSTRAINED_MAX_INDEXES = 1;
const CONSTRAINED_MAX_INDEX_BYTES = 72 * 1024 * 1024;
const maxIndexes = () => (isConstrainedMobileRuntime() ? CONSTRAINED_MAX_INDEXES : MAX_INDEXES);
const maxIndexBytes = () => (isConstrainedMobileRuntime() ? CONSTRAINED_MAX_INDEX_BYTES : MAX_INDEX_BYTES);
/** @type {Map<string, ChatPatchIndex>} */
const indexes = new Map();
registerMemoryReclaimer(() => indexes.clear());

export function clearChatPatchIndexes() {
    indexes.clear();
}

export function rememberChatPatchIndex(rawHash, index) {
    indexes.delete(rawHash);
    indexes.set(rawHash, index);
    let total = 0;
    for (const entry of indexes.values()) total += entry.size;
    while (indexes.size > maxIndexes() || (total > maxIndexBytes() && indexes.size > 1)) {
        const oldest = indexes.keys().next().value;
        total -= indexes.get(oldest).size;
        indexes.delete(oldest);
    }
}

/** The index of the file whose SHA-256 is `rawHash`, built from `bytes` when no earlier save kept it. */
export function chatPatchIndex(bytes, rawHash) {
    const known = indexes.get(rawHash);
    if (known) {
        indexes.delete(rawHash);
        indexes.set(rawHash, known);
        return known;
    }
    const built = buildChatPatchIndex(bytes);
    if (built) rememberChatPatchIndex(rawHash, built);
    return built;
}

/** The parsed messages of base lines `from` to `to` (message numbers, zero based). */
export function parseBaseMessages(bytes, index, from, to) {
    const records = [];
    for (let message = from; message < to; message++) records.push(JSON.parse(bytes.toString('utf8', index.starts[message + 1], index.ends[message + 1])));
    return records;
}

/**
 * The bytes of the new file: the header line, the base lines kept at the start, the new lines, the base lines kept at the end.
 * Also the index of that file, which the caller keeps once the file is written.
 * @param {ChatPatchIndex} base
 * @param {Buffer} baseBytes
 * @param {{prefix: number, suffix: number, headerText: string, middleTexts: string[], middleCanonical: string[]}} parts
 */
export function composePatchedChat(base, baseBytes, { prefix, suffix, headerText, middleTexts, middleCanonical }) {
    const count = prefix + middleTexts.length + suffix;
    const pieces = [];
    const starts = new Uint32Array(count + 1);
    const ends = new Uint32Array(count + 1);
    const fingerprints = new Uint32Array(count * FINGERPRINT_WIDTH);
    const canonical = new Array(count);
    const newline = Buffer.from('\n');
    let at = 0;
    const header = Buffer.from(headerText, 'utf8');
    pieces.push(header);
    starts[0] = 0;
    ends[0] = at = header.length;
    const keep = (baseFrom, toLine, lines) => {
        // `lines` base lines starting at message number baseFrom go to new message numbers starting at toLine.
        if (lines === 0) return;
        const from = base.starts[baseFrom + 1];
        const to = base.ends[baseFrom + lines];
        pieces.push(newline, baseBytes.subarray(from, to));
        at += 1;
        const shift = at - from;
        for (let line = 0; line < lines; line++) {
            starts[toLine + line + 1] = base.starts[baseFrom + line + 1] + shift;
            ends[toLine + line + 1] = base.ends[baseFrom + line + 1] + shift;
            canonical[toLine + line] = base.canonical[baseFrom + line];
        }
        fingerprints.set(base.fingerprints.subarray(baseFrom * FINGERPRINT_WIDTH, (baseFrom + lines) * FINGERPRINT_WIDTH), toLine * FINGERPRINT_WIDTH);
        at += to - from;
    };
    keep(0, 0, prefix);
    for (let index = 0; index < middleTexts.length; index++) {
        const line = Buffer.from(middleTexts[index], 'utf8');
        pieces.push(newline, line);
        at += 1;
        const message = prefix + index;
        starts[message + 1] = at;
        at += line.length;
        ends[message + 1] = at;
        fingerprintText(middleTexts[index], fingerprints, message * FINGERPRINT_WIDTH);
        canonical[message] = Buffer.from(middleCanonical[index], 'utf8');
    }
    keep(base.count - suffix, prefix + middleTexts.length, suffix);
    const bytes = Buffer.concat(pieces, at);
    let held = 0;
    for (const entry of canonical) held += entry.length;
    return { bytes, index: { count, starts, ends, fingerprints, canonical, size: held + count * 16 } };
}

/** The SHA-256 of `[header,message,...]` in canonical form, which is the content hash of a chat, from canonical pieces. */
export function chatContentHash(headerCanonical, canonical) {
    const hash = crypto.createHash('sha256');
    hash.update('[');
    hash.update(headerCanonical);
    for (const piece of canonical) {
        hash.update(',');
        hash.update(piece);
    }
    return hash.update(']').digest('hex');
}

/**
 * Whether `bytes` is the file this patch describes: the line count, the header and the new lines parse to
 * the records that were prepared, and the lines kept at each end are the base file's own bytes.
 * @returns {boolean}
 */
export function patchedBytesMatch(bytes, { count, prefix, suffix, header, messages, baseBytes, base }) {
    const starts = [];
    const ends = [];
    for (let start = 0; ;) {
        const end = bytes.indexOf(0x0a, start);
        starts.push(start);
        ends.push(end === -1 ? bytes.length : end);
        if (end === -1) break;
        start = end + 1;
    }
    if (starts.length !== count + 1) return false;
    try {
        if (!isDeepStrictEqual(parseChatHeaderBytes(bytes, ends[0]), header)) return false;
        for (let index = 0; index < messages.length; index++) {
            if (!isDeepStrictEqual(JSON.parse(bytes.toString('utf8', starts[prefix + index + 1], ends[prefix + index + 1])), messages[index])) return false;
        }
    } catch {
        return false;
    }
    if (prefix > 0 && !bytes.subarray(starts[1], ends[prefix]).equals(baseBytes.subarray(base.starts[1], base.ends[prefix]))) return false;
    if (suffix > 0 && !bytes.subarray(starts[count - suffix + 1], ends[count]).equals(baseBytes.subarray(base.starts[base.count - suffix + 1], base.ends[base.count]))) return false;
    return true;
}
