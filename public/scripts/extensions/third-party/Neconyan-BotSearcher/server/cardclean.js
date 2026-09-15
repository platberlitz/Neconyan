/**
 * Clean import: the same card with the parts that act on their own removed.
 *
 * The profile is fixed. What goes: regex scripts, extension blocks Neconyan
 * does not read, fields outside the card format, and details the author almost
 * certainly did not mean to publish. What stays: the lorebook, the greetings and
 * the prompts — strip those and what imports is not the card the user chose.
 *
 * Each removal is reported by kind, and the interface itemises those before the
 * user commits, so the policy is stated where it is applied rather than only
 * here. `cleanPlan()` in client/copy.js is the other half of that contract.
 *
 * A PNG is SPLICED, never re-encoded. Only the tEXt chunks carrying card data
 * are rebuilt; IHDR, IDAT and IEND are copied through byte for byte. Re-encoding
 * would discard the embedded card, which is the character.
 */

import {
    CARD_KEYWORDS,
    CardBytesError,
    KNOWN_DATA_FIELDS,
    KNOWN_EXTENSIONS,
    PNG_SIGNATURE,
    PRIVATE_PATTERNS,
    parseCardJson,
    textChunk,
    validateCardBytes,
} from './cardbytes.js';
import { isPlainObject, own } from './validate.js';

/** Matches the walk budget in cardbytes.js; the input is the same stranger's file. */
const MAX_NODES = 10_000;
const MAX_CHILDREN = 256;

/**
 * @param {Buffer} buffer validated card bytes
 * @returns {{ buffer: Buffer, removed: {kind: string, detail: string}[] }}
 */
export function cleanCard(buffer) {
    // Validate before touching anything: the splice below trusts the chunk table.
    validateCardBytes(buffer);

    const looksPng = buffer.length >= PNG_SIGNATURE.length
        && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

    if (!looksPng) {
        const parsed = parseCardJson(buffer);
        const { card, removed } = stripCard(parsed);
        const cleaned = Buffer.from(JSON.stringify(card), 'utf8');
        validateCardBytes(cleaned);
        return { buffer: cleaned, removed };
    }

    const chunks = readChunkTable(buffer);
    const cardChunks = chunks.filter((chunk) => chunk.cardKeyword !== null);
    if (cardChunks.length === 0) {
        throw new CardBytesError('card_invalid', 'png carries no embedded card');
    }

    // Every card chunk is rewritten from ONE cleaned card, not cleaned
    // individually. The host writes `chara` and `ccv3` as a pair and prefers
    // `ccv3` on read, so leaving either one stale would let the uncleaned card
    // survive through the other reader.
    const source = cardChunks.find((chunk) => chunk.cardKeyword === 'ccv3') ?? cardChunks[0];
    const parsed = parseCardJson(decodeChunkPayload(source, buffer));
    const { card, removed } = stripCard(parsed);
    const payload = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');

    const pieces = [buffer.subarray(0, PNG_SIGNATURE.length)];
    for (const chunk of chunks) {
        pieces.push(chunk.cardKeyword === null
            ? buffer.subarray(chunk.start, chunk.end)
            : textChunk(chunk.cardKeyword, payload));
    }

    const cleaned = Buffer.concat(pieces);
    // Proves the splice produced a file this plugin would itself accept.
    validateCardBytes(cleaned);
    return { buffer: cleaned, removed };
}

/**
 * Applies the fixed profile to a parsed card.
 * @param {{ spec: string, card: Record<string, unknown> }} parsed
 */
function stripCard(parsed) {
    const card = structuredClone(parsed.card);
    const data = parsed.spec === 'chara_card_v1' ? card : own(card, 'data');
    const removed = [];
    const note = (kind, detail) => {
        if (removed.length < 64) {
            removed.push({ kind, detail });
        }
    };

    if (!isPlainObject(data)) {
        return { card, removed };
    }

    const extensions = own(data, 'extensions');
    if (isPlainObject(extensions)) {
        const regex = own(extensions, 'regex_scripts');
        if (Array.isArray(regex) && regex.length > 0) {
            note('regexScripts', `${regex.length}`);
        }
        if (regex !== undefined) {
            delete extensions.regex_scripts;
        }

        for (const key of Object.getOwnPropertyNames(extensions)) {
            if (!KNOWN_EXTENSIONS.has(key)) {
                note('unknownExtensions', key.slice(0, 64));
                delete extensions[key];
            }
        }
    }

    // v1 has no field list to measure against, so nothing there is "unrecognised".
    if (parsed.spec !== 'chara_card_v1') {
        for (const key of Object.getOwnPropertyNames(data)) {
            if (!KNOWN_DATA_FIELDS.has(key)) {
                note('unrecognisedFields', key.slice(0, 64));
                delete data[key];
            }
        }
    }

    const redactions = redactStrings(card);
    for (const kind of redactions) {
        note('privateInfo', kind);
    }

    return { card, removed };
}

/**
 * Replaces private-info matches in place, everywhere in the card.
 *
 * This edits the author's text, which is why it is the one part of the profile
 * that touches content rather than structure — and why the interface says how
 * many replacements it made and of what kind.
 *
 * @returns {string[]} one entry per replacement, naming its kind
 */
function redactStrings(root) {
    const kinds = [];
    const seen = new Set();
    const stack = [root];
    let nodes = 0;

    while (stack.length > 0 && nodes < MAX_NODES) {
        const current = stack.pop();
        nodes++;
        if (!current || typeof current !== 'object' || seen.has(current)) {
            continue;
        }
        seen.add(current);

        const keys = Array.isArray(current)
            ? current.keys()
            : Object.getOwnPropertyNames(current);
        if (!Array.isArray(current) && keys.length > MAX_CHILDREN) {
            throw new CardBytesError('clean_incomplete', 'child_limit');
        }

        for (const key of keys) {
            const value = current[key];
            if (typeof value === 'string') {
                let next = value;
                for (const [kind, pattern] of PRIVATE_PATTERNS) {
                    pattern.lastIndex = 0;
                    next = next.replace(pattern, () => {
                        kinds.push(kind);
                        return '[removed]';
                    });
                }
                if (next !== value) {
                    current[key] = next;
                }
                continue;
            }
            if (value && typeof value === 'object') {
                stack.push(value);
            }
        }
    }

    // A bounded clean must refuse unfinished work, never return partially redacted bytes.
    if (stack.length > 0) {
        throw new CardBytesError('clean_incomplete', 'node_limit');
    }
    return kinds;
}

/**
 * Walks the chunk table of an already-validated PNG, recording where each chunk
 * lives and whether it carries card data.
 */
function readChunkTable(buffer) {
    const chunks = [];
    let offset = PNG_SIGNATURE.length;

    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd > buffer.length - 4) {
            throw new CardBytesError('png_malformed', 'chunk length exceeds file');
        }

        const type = buffer.toString('latin1', offset + 4, offset + 8);
        let cardKeyword = null;
        if (type === 'tEXt') {
            const separator = buffer.subarray(dataStart, dataEnd).indexOf(0);
            if (separator > 0 && separator <= 79) {
                const keyword = buffer.toString('latin1', dataStart, dataStart + separator);
                if (CARD_KEYWORDS.has(keyword)) {
                    cardKeyword = keyword;
                }
            }
        }

        chunks.push({ start: offset, end: dataEnd + 4, dataStart, dataEnd, type, cardKeyword });
        offset = dataEnd + 4;
        if (type === 'IEND') {
            break;
        }
    }

    return chunks;
}

/** Reads a card chunk's base64 payload, which follows `keyword\0`. */
function decodeChunkPayload(chunk, buffer) {
    const separator = buffer.subarray(chunk.dataStart, chunk.dataEnd).indexOf(0);
    const text = buffer.toString('latin1', chunk.dataStart + separator + 1, chunk.dataEnd);
    return Buffer.from(text.replace(/[\r\n]/g, ''), 'base64');
}
