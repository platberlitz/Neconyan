/**
 * Validation for character-card bytes fetched on the user's behalf.
 *
 * This is the one place where this plugin hands the browser something it will
 * feed straight into Neconyan's importer, so it is the only genuinely new
 * trust surface the project adds. Everywhere else the download is done by the
 * fork's own hardened code (content-manager.js) and we only supply a URL.
 *
 * What this proves: the bytes are a structurally well-formed PNG that actually
 * carries embedded character data, or a JSON document in a recognised card
 * format. What it cannot prove — and no amount of parsing could — is that the
 * card is benign. A card is a document written by a stranger and the format
 * exists to be partially executed. That is why the UI shows what is inside
 * before the user commits, rather than pretending validation makes it safe.
 *
 * The PNG walk deliberately never allocates based on a declared length before
 * checking it against what is actually present: a four-byte length field is
 * attacker-controlled and 0xFFFFFFFF is free to write.
 */

import { hasForbiddenKey, isPlainObject, own } from './validate.js';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** A real card has a few dozen chunks; this only bounds a hostile file. */
const MAX_CHUNKS = 4096;

/** Card JSON larger than this is not a card. */
const MAX_JSON_BYTES = 2 * 1024 * 1024;

/** Card metadata remains bounded before Base64 decoding. */
const MAX_CARD_METADATA_BYTES = 4 * 1024 * 1024;

/** Bounds the image decoder work a tiny compressed PNG can request. */
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES = 64 * 1024 * 1024;

/** Legal PNG bit depths for each colour type from the PNG specification. */
const BIT_DEPTHS_BY_COLOR_TYPE = Object.freeze({
    0: Object.freeze([1, 2, 4, 8, 16]),
    2: Object.freeze([8, 16]),
    3: Object.freeze([1, 2, 4, 8]),
    4: Object.freeze([8, 16]),
    6: Object.freeze([8, 16]),
});

const CHANNELS_BY_COLOR_TYPE = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });
const KNOWN_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const ADAM7_PASSES = Object.freeze([
    Object.freeze([0, 0, 8, 8]),
    Object.freeze([4, 0, 8, 8]),
    Object.freeze([0, 4, 4, 8]),
    Object.freeze([2, 0, 4, 4]),
    Object.freeze([0, 2, 2, 4]),
    Object.freeze([1, 0, 2, 2]),
    Object.freeze([0, 1, 1, 2]),
]);

/** Keywords SillyTavern and the card specs use for embedded card data. */
export const CARD_KEYWORDS = new Set(['chara', 'ccv3']);

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let value = n;
        for (let bit = 0; bit < 8; bit++) {
            value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
        }
        table[n] = value >>> 0;
    }
    return table;
})();

/**
 * CRC32 over a byte range, as PNG defines it (type field through data).
 * Exported for cardclean.js, which has to re-checksum the one chunk it rewrites.
 */
export function crc32Range(buffer, start, end) {
    let crc = 0xFFFFFFFF;
    for (let index = start; index < end; index++) {
        crc = CRC_TABLE[(crc ^ buffer[index]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

export class CardBytesError extends Error {
    constructor(code, detail) {
        super(code);
        this.name = 'CardBytesError';
        this.code = code;
        this.detail = detail;
    }
}

function validateImageBudget(width, height, bitDepth, colorType, interlace) {
    const channels = CHANNELS_BY_COLOR_TYPE[colorType];
    const passes = imagePasses(width, height, channels, bitDepth, interlace);
    const decodedBytes = passes.reduce((total, pass) => total + (pass.rowBytes + 1) * pass.height, 0);
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_DECODED_IMAGE_BYTES) {
        throw new CardBytesError('png_malformed', 'decoded image exceeds budget');
    }
    return { decodedBytes, passes, bitDepth, colorType };
}

function imagePasses(width, height, channels, bitDepth, interlace) {
    if (interlace === 0) {
        return [{ width, height, rowBytes: Math.ceil((width * channels * bitDepth) / 8) }];
    }

    return ADAM7_PASSES.flatMap(([x, y, xStep, yStep]) => {
        const passWidth = width <= x ? 0 : Math.ceil((width - x) / xStep);
        const passHeight = height <= y ? 0 : Math.ceil((height - y) / yStep);
        return passWidth > 0 && passHeight > 0
            ? [{ width: passWidth, height: passHeight, rowBytes: Math.ceil((passWidth * channels * bitDepth) / 8) }]
            : [];
    });
}

function validateImageData(chunks, layout, paletteEntries) {
    let inflated;
    try {
        inflated = inflateSync(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks), {
            maxOutputLength: layout.decodedBytes,
        });
    } catch {
        throw new CardBytesError('png_malformed', 'invalid or oversized IDAT');
    }

    if (inflated.length !== layout.decodedBytes) {
        throw new CardBytesError('png_malformed', 'IDAT scanline length mismatch');
    }

    const checkIndices = layout.colorType === 3 && paletteEntries < 2 ** layout.bitDepth;
    let offset = 0;
    for (const pass of layout.passes) {
        let previous = null;
        for (let row = 0; row < pass.height; row++) {
            const filter = inflated[offset];
            if (filter > 4) {
                throw new CardBytesError('png_malformed', 'invalid PNG filter type');
            }
            if (checkIndices) {
                const bytes = inflated.subarray(offset + 1, offset + 1 + pass.rowBytes);
                for (let index = 0; index < bytes.length; index++) {
                    const left = bytes[index - 1] ?? 0;
                    const up = previous?.[index] ?? 0;
                    const upperLeft = previous?.[index - 1] ?? 0;
                    let predictor = 0;
                    if (filter === 1) {
                        predictor = left;
                    } else if (filter === 2) {
                        predictor = up;
                    } else if (filter === 3) {
                        predictor = Math.floor((left + up) / 2);
                    } else if (filter === 4) {
                        const p = left + up - upperLeft;
                        const a = Math.abs(p - left);
                        const b = Math.abs(p - up);
                        const c = Math.abs(p - upperLeft);
                        predictor = a <= b && a <= c ? left : (b <= c ? up : upperLeft);
                    }
                    bytes[index] = (bytes[index] + predictor) & 0xFF;
                }
                for (let pixel = 0; pixel < pass.width; pixel++) {
                    const bit = pixel * layout.bitDepth;
                    const index = (bytes[bit >>> 3] >>> (8 - layout.bitDepth - (bit & 7))) & ((1 << layout.bitDepth) - 1);
                    if (index >= paletteEntries) {
                        throw new CardBytesError('png_malformed', 'palette index out of range');
                    }
                }
                previous = bytes;
            }
            offset += pass.rowBytes + 1;
        }
    }
}

/**
 * Walks a PNG's chunk table, returning the decoded text chunks that carry card
 * data. Rejects rather than repairs: a malformed table means we do not
 * understand the file, and guessing is how parsers become exploits.
 *
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>} keyword -> raw text bytes
 */
function readPngTextChunks(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length + 12) {
        throw new CardBytesError('not_a_png', 'too short');
    }
    if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new CardBytesError('not_a_png', 'bad signature');
    }

    const found = new Map();
    let offset = PNG_SIGNATURE.length;
    let chunks = 0;
    let sawEnd = false;
    let sawHeader = false;
    let sawImageData = false;
    let imageDataEnded = false;
    let cardMetadataBytes = 0;
    let imageLayout = null;
    let paletteEntries = 0;
    const paletteChunks = new Set();
    const imageDataChunks = [];

    while (offset + 8 <= buffer.length) {
        if (++chunks > MAX_CHUNKS) {
            throw new CardBytesError('png_malformed', 'too many chunks');
        }

        const length = buffer.readUInt32BE(offset);

        // The PNG spec caps a chunk at 2^31-1. Anything above that, or anything
        // that would run past the end, is refused BEFORE a read is attempted.
        if (length > 0x7FFFFFFF) {
            throw new CardBytesError('png_malformed', 'chunk length out of range');
        }
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        // +4 for the trailing CRC. Computed in a way that cannot overflow.
        if (dataEnd > buffer.length - 4) {
            throw new CardBytesError('png_malformed', 'chunk length exceeds file');
        }

        const type = buffer.toString('latin1', offset + 4, offset + 8);
        if (!/^[A-Za-z]{4}$/.test(type)) {
            throw new CardBytesError('png_malformed', 'invalid chunk type');
        }
        if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90 && !KNOWN_CRITICAL_CHUNKS.has(type)) {
            throw new CardBytesError('png_malformed', `unknown critical chunk ${type}`);
        }
        if (type === 'acTL') {
            throw new CardBytesError('png_malformed', 'animated PNGs are not supported');
        }

        const expectedCrc = buffer.readUInt32BE(dataEnd);
        const actualCrc = crc32Range(buffer, offset + 4, dataEnd);
        if (expectedCrc !== actualCrc) {
            throw new CardBytesError('png_malformed', `${type} CRC mismatch`);
        }

        if (!sawHeader) {
            if (type !== 'IHDR' || length !== 13) {
                throw new CardBytesError('png_malformed', 'IHDR must be first and 13 bytes');
            }
            const width = buffer.readUInt32BE(dataStart);
            const height = buffer.readUInt32BE(dataStart + 4);
            const bitDepth = buffer[dataStart + 8];
            const colorType = buffer[dataStart + 9];
            const legalBitDepths = BIT_DEPTHS_BY_COLOR_TYPE[colorType];
            if (width === 0 || height === 0
                || width > MAX_IMAGE_DIMENSION
                || height > MAX_IMAGE_DIMENSION
                || width * height > MAX_IMAGE_PIXELS
                || !legalBitDepths?.includes(bitDepth)
                || buffer[dataStart + 10] !== 0
                || buffer[dataStart + 11] !== 0
                || buffer[dataStart + 12] > 1) {
                throw new CardBytesError('png_malformed', 'invalid IHDR');
            }
            imageLayout = validateImageBudget(width, height, bitDepth, colorType, buffer[dataStart + 12]);
            sawHeader = true;
        } else if (type === 'IHDR') {
            throw new CardBytesError('png_malformed', 'duplicate IHDR');
        }

        if (type === 'PLTE') {
            if (paletteEntries > 0 || sawImageData || paletteChunks.size > 0
                || imageLayout.colorType === 0 || imageLayout.colorType === 4
                || length === 0 || length % 3 !== 0 || length > 256 * 3
                || (imageLayout.colorType === 3 && length / 3 > 2 ** imageLayout.bitDepth)) {
                throw new CardBytesError('png_malformed', 'invalid PLTE');
            }
            paletteEntries = length / 3;
        }
        if (type === 'tRNS' || type === 'bKGD' || type === 'hIST') {
            if (sawImageData || paletteChunks.has(type)) {
                throw new CardBytesError('png_malformed', 'invalid palette chunk order');
            }
            if ((type === 'hIST' && (paletteEntries === 0 || length !== paletteEntries * 2))
                || (imageLayout.colorType === 3 && (paletteEntries === 0
                    || (type === 'tRNS' && length > paletteEntries)
                    || (type === 'bKGD' && (length !== 1 || buffer[dataStart] >= paletteEntries))))) {
                throw new CardBytesError('png_malformed', 'invalid palette chunk');
            }
            paletteChunks.add(type);
        }

        if (type === 'IDAT') {
            if (imageLayout.colorType === 3 && paletteEntries === 0) {
                throw new CardBytesError('png_malformed', 'missing PLTE');
            }
            if (imageDataEnded) {
                throw new CardBytesError('png_malformed', 'non-consecutive IDAT');
            }
            sawImageData = true;
            imageDataChunks.push(buffer.subarray(dataStart, dataEnd));
        } else if (sawImageData) {
            imageDataEnded = true;
        }

        if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
            const data = buffer.subarray(dataStart, dataEnd);
            const separator = data.indexOf(0);

            // A keyword is 1-79 bytes and must be followed by a null.
            if (separator > 0 && separator <= 79) {
                const keyword = data.toString('latin1', 0, separator);
                const normalizedKeyword = keyword.toLowerCase();

                if (CARD_KEYWORDS.has(normalizedKeyword)) {
                    // Neconyan reads only case-insensitive tEXt carriers. A
                    // zTXt/iTXt or mixed-case twin could make our inspection and
                    // its import select different card data, so reject it.
                    if (type !== 'tEXt' || keyword !== normalizedKeyword) {
                        throw new CardBytesError('png_malformed', 'ambiguous card metadata');
                    }
                    const text = data.subarray(separator + 1);
                    cardMetadataBytes += text.length;
                    if (cardMetadataBytes > MAX_CARD_METADATA_BYTES) {
                        throw new CardBytesError('png_malformed', 'card metadata exceeds budget');
                    }
                    if (found.has(normalizedKeyword)) {
                        throw new CardBytesError('png_malformed', 'duplicate card metadata');
                    }
                    found.set(normalizedKeyword, text);
                }
            }
        }

        if (type === 'IEND') {
            if (length !== 0 || !sawImageData) {
                throw new CardBytesError('png_malformed', 'invalid IEND or missing IDAT');
            }
            if (dataEnd + 4 !== buffer.length) {
                throw new CardBytesError('png_malformed', 'trailing bytes after IEND');
            }
            sawEnd = true;
            break;
        }

        offset = dataEnd + 4;
    }

    // Every PNG ends with IEND. Without it the download was cut short: the card
    // chunk may still have arrived intact, but the image data behind it has not,
    // and importing half a file gives the user a corrupt avatar.
    if (!sawEnd) {
        throw new CardBytesError('png_malformed', 'truncated: no IEND chunk');
    }

    validateImageData(imageDataChunks, imageLayout, paletteEntries);

    return found;
}

/**
 * Card data is stored base64-encoded inside the text chunk.
 * @param {Buffer} raw
 */
function decodeCardPayload(raw) {
    const text = raw.toString('latin1').trim().replace(/[\r\n]/g, '');
    if (text === '') {
        throw new CardBytesError('card_invalid', 'empty card chunk');
    }

    // Strict Base64: Buffer.from otherwise skips junk silently and could allocate
    // before we know whether the decoded payload fits the card budget.
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2,3})?$/.test(text)) {
        throw new CardBytesError('card_invalid', 'card chunk is not base64');
    }

    const padding = text.endsWith('==') ? 2 : (text.endsWith('=') ? 1 : 0);
    const unpaddedLength = text.length - padding;
    const remainder = unpaddedLength % 4;
    const decodedLength = Math.floor(unpaddedLength / 4) * 3 + (remainder === 2 ? 1 : (remainder === 3 ? 2 : 0));
    if (decodedLength === 0 || decodedLength > MAX_JSON_BYTES) {
        throw new CardBytesError('card_invalid', 'card payload size out of range');
    }

    const decoded = Buffer.from(text, 'base64');
    if (decoded.length !== decodedLength) {
        throw new CardBytesError('card_invalid', 'card payload size out of range');
    }

    return parseCardJson(decoded);
}

/**
 * Parses and shape-checks card JSON, in either the v1 flat form or the
 * v2/v3 `{ spec, data }` form.
 *
 * @param {Buffer} buffer
 * @returns {{ spec: string, card: Record<string, unknown> }}
 */
export function parseCardJson(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new CardBytesError('card_invalid', 'empty');
    }
    if (buffer.length > MAX_JSON_BYTES) {
        throw new CardBytesError('too_large', 'card json');
    }

    let parsed;
    try {
        parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
        throw new CardBytesError('card_invalid', 'not json');
    }

    if (!isPlainObject(parsed)) {
        throw new CardBytesError('card_invalid', 'not an object');
    }
    if (hasForbiddenKey(parsed)) {
        throw new CardBytesError('card_invalid', 'unsafe keys');
    }

    const spec = own(parsed, 'spec');

    if (spec === 'chara_card_v2' || spec === 'chara_card_v3') {
        const data = own(parsed, 'data');
        if (!isPlainObject(data)) {
            throw new CardBytesError('card_invalid', `${spec} without a data object`);
        }
        if (typeof own(data, 'name') !== 'string') {
            throw new CardBytesError('card_invalid', `${spec} without a name`);
        }
        return { spec, card: parsed };
    }

    // v1: a flat object with at least a name and a description.
    if (typeof own(parsed, 'name') === 'string' && typeof own(parsed, 'description') === 'string') {
        return { spec: 'chara_card_v1', card: parsed };
    }

    throw new CardBytesError('card_invalid', 'unrecognised card format');
}

/**
 * Fields the v3 card specification defines under `data`. Anything else is
 * reported as unrecognised — not refused, because the specs gain fields and a
 * card written against a newer one is not malformed, only unaccounted for.
 */
export const KNOWN_DATA_FIELDS = new Set([
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings',
    'character_book', 'tags', 'creator', 'character_version', 'extensions',
    'group_only_greetings', 'nickname', 'creator_notes_multilingual', 'source', 'assets',
]);

/** Extension blocks Neconyan itself reads. The rest are ones nobody here can vouch for. */
export const KNOWN_EXTENSIONS = new Set(['depth_prompt', 'talkativeness', 'fav', 'world', 'regex_scripts']);

/** Fields that go into the model's permanent prompt, in the order they are shown. */
const PROMPT_FIELDS = Object.freeze([
    ['description', 'description'],
    ['personality', 'personality'],
    ['scenario', 'scenario'],
    ['firstMessage', 'first_mes'],
    ['messageExample', 'mes_example'],
    ['systemPrompt', 'system_prompt'],
    ['postHistoryInstructions', 'post_history_instructions'],
]);

/** Above this the client is told the footprint could not be measured, not a guess. */
const MAX_PROMPT_TEXT_BYTES = 1024 * 1024;

/**
 * The lorebook gets its own budget rather than sharing the one above.
 *
 * A card with a large embedded lorebook is common and its card fields are
 * usually ordinary. One shared cap would let the lorebook push the whole
 * measurement over the edge, so a number that works today would start reporting
 * "could not be measured" for reasons the user cannot see.
 */
const MAX_LOREBOOK_TEXT_BYTES = 1024 * 1024;

/** Walk budget. Deliberately the same shape as the URL scan this grew out of. */
const SCAN_LIMITS = Object.freeze({
    nodes: 10_000,
    textBytes: 512 * 1024,
    urls: 256,
    urlHosts: 32,
    macroNames: 64,
    privateInfo: 32,
    htmlFields: 16,
    children: 256,
    // Per-string cap for pattern matching. Several of these patterns scan from
    // every start position, so cost grows with the square of the string they are
    // pointed at. A card field is a paragraph; a megabyte of one is either a
    // pathological card or an attempt to make this loop expensive. Bounding the
    // slice bounds all of them at once, whatever a future pattern looks like.
    scanString: 128 * 1024,
});

/**
 * Things a card can carry that act on their own once imported.
 *
 * `hasScriptOrIframe` uses the fork's own test verbatim
 * (public/scripts/card-script-detection.js), so the flag means exactly what
 * Neconyan's card-script sandbox means by it rather than a second opinion.
 */
const SCRIPT_OR_IFRAME = /<\s*(?:script|iframe)(?:\s|>)/i;
const ANY_HTML_TAG = /<\s*\/?\s*[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i;
const URL_PATTERN = /https?:\/\/[^\s)"'<>]+/gi;
const MACRO_PATTERN = /\{\{\s*[#/]?([A-Za-z_][A-Za-z0-9_]{0,63})(?=::|\s|\}\})/g;

/**
 * Details an author probably did not mean to publish.
 *
 * Deliberately excludes bare IPv4: version strings look identical to it, and a
 * report that cries wolf on `v1.2.3.4` teaches users to skip this section.
 */
export const PRIVATE_PATTERNS = Object.freeze([
    // The leading \b is load-bearing, not tidiness. Without it, a long run of
    // characters the first class accepts makes this quadratic: every position
    // consumes to the end looking for an @ that is not there. \b fails
    // immediately mid-run, so the scan stays linear on prose and on junk alike.
    ['email', /\b[A-Za-z0-9._%+-]{1,128}@[A-Za-z0-9.-]{1,128}\.[A-Za-z]{2,24}/g],
    ['apiKey', /\b(?:sk-[A-Za-z0-9_-]{16,512}|AIza[A-Za-z0-9_-]{35}|ghp_[A-Za-z0-9]{20,512}|xox[baprs]-[A-Za-z0-9-]{10,512})/g],
    ['bearer', /\bBearer\s{1,8}[A-Za-z0-9._~+/-]{20,512}={0,2}/g],
    ['homePath', /(?:[A-Za-z]:\\Users\\[^\\/:*?"<>|\r\n]{1,64}|\/home\/[A-Za-z0-9._-]{1,64}|\/Users\/[A-Za-z0-9._-]{1,64})/g],
    ['discordInvite', /\bdiscord(?:\.gg|app\.com\/invite)\/[A-Za-z0-9-]{2,32}/gi],
]);

/**
 * Summarises what an imported card will bring with it, from the validated
 * bytes rather than from whatever the listing claimed.
 *
 * @param {{ spec: string, card: Record<string, unknown> }} parsed
 * @param {Buffer} [buffer] the bytes this card was read from, for the hash
 */
export function describeCard(parsed, buffer) {
    const root = parsed.card;
    const data = parsed.spec === 'chara_card_v1' ? root : own(root, 'data');

    const book = own(data, 'character_book');
    const entries = own(book, 'entries');
    const greetings = own(data, 'alternate_greetings');
    const assets = own(data, 'assets');
    const extensions = own(data, 'extensions');

    // Regex scripts rewrite messages as they pass through. They are the closest
    // thing to executable content a card can carry, so they get counted.
    const regex = own(extensions, 'regex_scripts');

    const scan = scanCard(root, data);
    const malformed = findMalformed(parsed, data, scan.reasons);

    return {
        // --- unchanged, and shared with the source-reported shape in normalize.js ---
        lorebookEntries: Array.isArray(entries) ? entries.length : (book ? null : 0),
        alternateGreetings: Array.isArray(greetings) ? greetings.length : 0,
        hasSystemPrompt: nonEmptyString(own(data, 'system_prompt')),
        hasPostHistoryInstructions: nonEmptyString(own(data, 'post_history_instructions')),
        hasDepthPrompt: own(extensions, 'depth_prompt') !== undefined,
        regexScripts: Array.isArray(regex) ? regex.length : 0,
        embeddedAssets: Array.isArray(assets) ? assets.length : 0,
        specVersion: parsed.spec,
        originSite: null,

        // --- byte-derived identity ---
        sha256: Buffer.isBuffer(buffer) ? createHash('sha256').update(buffer).digest('hex') : null,
        byteSize: Buffer.isBuffer(buffer) ? buffer.length : null,
        name: shortString(own(data, 'name')),
        creator: shortString(own(data, 'creator')),
        characterVersion: shortString(own(data, 'character_version')),
        hasCreatorNotes: nonEmptyString(own(data, 'creator_notes')),
        tagCount: Array.isArray(own(data, 'tags')) ? own(data, 'tags').length : 0,

        // --- what the walk found ---
        scan: { complete: scan.reasons.size === 0, reasons: [...scan.reasons].sort() },
        macros: scan.macros,
        html: scan.html,
        externalUrls: scan.externalUrls,
        privateInfo: scan.privateInfo,

        extensions: describeExtensions(extensions),
        malformed,
        promptText: promptTextOf(data),
    };
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function shortString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : null;
}

/**
 * Splits `data.extensions` into blocks Neconyan reads and blocks it does not.
 *
 * An unknown block is not an accusation. It is usually another client's own
 * metadata, and saying so is more useful than either hiding it or implying it
 * is hostile.
 */
function describeExtensions(extensions) {
    const known = [];
    const unknown = [];
    if (isPlainObject(extensions)) {
        for (const key of Object.getOwnPropertyNames(extensions).slice(0, SCAN_LIMITS.children)) {
            (KNOWN_EXTENSIONS.has(key) ? known : unknown).push(key.slice(0, 64));
        }
    }
    return { known, unknown };
}

/**
 * Fields that are present but not the shape the spec calls for, plus fields
 * outside the spec entirely. Reported, never repaired: guessing what an author
 * meant is how a reader becomes a rewriter.
 */
function findMalformed(parsed, data, reasons) {
    const problems = [];
    const add = (field, problem) => {
        if (problems.length < 32) {
            problems.push({ field, problem });
        } else {
            reasons.add('finding_limit');
        }
    };

    if (!isPlainObject(data)) {
        return problems;
    }

    const specVersion = own(parsed.card, 'spec_version');
    if (parsed.spec === 'chara_card_v3' && specVersion !== undefined && !String(specVersion).startsWith('3')) {
        add('spec_version', 'does not match the declared spec');
    }
    if (parsed.spec === 'chara_card_v2' && specVersion !== undefined && !String(specVersion).startsWith('2')) {
        add('spec_version', 'does not match the declared spec');
    }

    for (const [field, expected] of [['tags', 'array'], ['alternate_greetings', 'array'], ['group_only_greetings', 'array'], ['assets', 'array']]) {
        const value = own(data, field);
        if (value !== undefined && value !== null && !Array.isArray(value)) {
            add(field, `should be an ${expected}`);
        }
    }
    for (const field of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator', 'creator_notes', 'character_version']) {
        const value = own(data, field);
        if (value !== undefined && value !== null && typeof value !== 'string') {
            add(field, 'should be text');
        }
    }
    const extensions = own(data, 'extensions');
    if (extensions !== undefined && extensions !== null && !isPlainObject(extensions)) {
        add('extensions', 'should be an object');
    }

    // v1 has no field list to check against; only the v2/v3 wrapper does.
    if (parsed.spec !== 'chara_card_v1') {
        for (const key of Object.getOwnPropertyNames(data).slice(0, SCAN_LIMITS.children)) {
            if (!KNOWN_DATA_FIELDS.has(key)) {
                add(key.slice(0, 64), 'is not a field in this card format');
            }
        }
    }

    return problems;
}

/**
 * The text that will end up in the model's prompt, returned verbatim so the
 * browser can measure it with Neconyan's own tokenizer.
 *
 * Sending it back is not a disclosure: the caller already holds the whole card.
 * It is returned to be counted and is never rendered — the intake screen reports
 * what a card contains, it does not reproduce it. Truncating instead of refusing
 * would produce a confident wrong number, so an oversized card reports that it
 * could not be measured.
 */
function promptTextOf(data) {
    const fields = {};
    let total = 0;
    for (const [name, key] of PROMPT_FIELDS) {
        const value = own(data, key);
        const text = typeof value === 'string' ? value : '';
        total += Buffer.byteLength(text);
        fields[name] = text;
    }
    const measured = total > MAX_PROMPT_TEXT_BYTES
        ? { truncated: true, fields: {} }
        : { truncated: false, fields };
    return { ...measured, lorebook: lorebookTextOf(data) };
}

/**
 * The embedded lorebook's text, split by whether it is always in context.
 *
 * A lorebook does not cost what the sum of its entries costs. Only entries
 * marked `constant` are injected on every request; the rest wait for one of
 * their keywords, and an entry that is switched off never arrives at all. One
 * lump number would overstate the permanent cost of every keyword-driven book,
 * which is most of them, so the two are measured separately and shown
 * separately.
 *
 * Keys are not included: they decide whether an entry fires, they are not sent
 * to the model.
 *
 * Returns null when the card carries no readable lorebook, which the client
 * shows as "no lorebook" rather than as zero tokens.
 */
function lorebookTextOf(data) {
    const entries = own(own(data, 'character_book'), 'entries');
    if (!Array.isArray(entries)) {
        return null;
    }

    const always = [];
    const conditional = [];
    let total = 0;

    for (const entry of entries) {
        // `enabled` is optional and defaults to on; only an explicit false is a
        // switched-off entry.
        if (own(entry, 'enabled') === false) {
            continue;
        }
        const content = own(entry, 'content');
        const text = typeof content === 'string' ? content : '';
        total += Buffer.byteLength(text);
        (own(entry, 'constant') === true ? always : conditional).push(text);
    }

    if (total > MAX_LOREBOOK_TEXT_BYTES) {
        return { truncated: true, always: '', conditional: '', alwaysEntries: always.length, conditionalEntries: conditional.length };
    }

    return {
        truncated: false,
        always: always.join('\n'),
        conditional: conditional.join('\n'),
        alwaysEntries: always.length,
        conditionalEntries: conditional.length,
    };
}

/**
 * One bounded pass over every string in the card.
 *
 * This grew out of countExternalUrls() and keeps its budget. Everything the
 * report needs from the card's text is gathered here rather than in a walker
 * per finding: the input is a stranger's file, and one traversal with one set
 * of caps is far easier to reason about than five.
 */
function scanCard(root, data) {
    const reasons = new Set();
    const urls = new Set();
    const urlHosts = new Set();
    const macroNames = new Set();
    const htmlFields = new Set();
    const privateInfo = [];
    const privateSeen = new Set();
    const seen = new Set();

    let macroCount = 0;
    let htmlCount = 0;
    let hasScriptOrIframe = false;
    let nodes = 0;
    let textBytes = 0;

    // Each entry carries the top-level field it came from, so a finding can say
    // where it is rather than only that it exists somewhere.
    const stack = [{ value: root, field: null }];

    while (stack.length > 0 && nodes < SCAN_LIMITS.nodes) {
        const { value: current, field } = stack.pop();
        nodes++;

        if (typeof current === 'string') {
            const bytes = Buffer.from(current, 'utf8');
            const remaining = SCAN_LIMITS.textBytes - textBytes;
            const length = Math.min(bytes.length, SCAN_LIMITS.scanString, remaining);
            if (bytes.length > SCAN_LIMITS.scanString) {
                reasons.add('string_limit');
            }
            if (bytes.length > remaining) {
                reasons.add('text_limit');
            }
            textBytes += length;
            if (length > 0) {
                scanText(bytes.subarray(0, length).toString('utf8'), field ?? 'card');
            }
            continue;
        }
        if (!current || typeof current !== 'object' || seen.has(current)) {
            continue;
        }
        seen.add(current);

        if (Array.isArray(current)) {
            if (current.length > SCAN_LIMITS.children) {
                reasons.add('child_limit');
            }
            for (let index = 0; index < current.length && index < SCAN_LIMITS.children; index++) {
                stack.push({ value: current[index], field });
            }
            continue;
        }

        let keys = 0;
        for (const key of Object.getOwnPropertyNames(current)) {
            if (keys++ >= SCAN_LIMITS.children) {
                reasons.add('child_limit');
                break;
            }
            // Top level names the field; deeper nodes inherit it, so a URL in a
            // lorebook entry is still reported as being in the lorebook.
            stack.push({ value: current[key], field: current === root && root !== data && key === 'data' ? null : field ?? key });
        }
    }
    if (stack.length > 0) {
        reasons.add('node_limit');
    }

    function scanText(text, field) {
        for (const match of text.match(URL_PATTERN) ?? []) {
            if (urls.has(match)) {
                continue;
            }
            if (urls.size >= SCAN_LIMITS.urls) {
                reasons.add('finding_limit');
                break;
            }
            urls.add(match);
            const host = hostOf(match);
            if (host && !urlHosts.has(host)) {
                if (urlHosts.size < SCAN_LIMITS.urlHosts) {
                    urlHosts.add(host);
                } else {
                    reasons.add('finding_limit');
                }
            }
        }

        MACRO_PATTERN.lastIndex = 0;
        let macro;
        while ((macro = MACRO_PATTERN.exec(text)) !== null) {
            macroCount++;
            if (macroNames.size < SCAN_LIMITS.macroNames) {
                macroNames.add(macro[1].toLowerCase());
            } else if (!macroNames.has(macro[1].toLowerCase())) {
                reasons.add('finding_limit');
            }
        }

        if (ANY_HTML_TAG.test(text)) {
            htmlCount++;
            if (htmlFields.size < SCAN_LIMITS.htmlFields) {
                htmlFields.add(field);
            } else if (!htmlFields.has(field)) {
                reasons.add('finding_limit');
            }
        }
        if (!hasScriptOrIframe && SCRIPT_OR_IFRAME.test(text)) {
            hasScriptOrIframe = true;
        }

        for (const [kind, pattern] of PRIVATE_PATTERNS) {
            pattern.lastIndex = 0;
            let hit;
            while ((hit = pattern.exec(text)) !== null) {
                const key = `${kind}:${field}:${hit[0]}`;
                if (privateSeen.has(key)) {
                    continue;
                }
                if (privateInfo.length >= SCAN_LIMITS.privateInfo) {
                    reasons.add('finding_limit');
                    break;
                }
                privateSeen.add(key);
                privateInfo.push({ kind, field, redacted: redact(hit[0]) });
            }
        }
    }

    return {
        reasons,
        externalUrls: { count: urls.size, hosts: [...urlHosts] },
        macros: { count: macroCount, names: [...macroNames].sort() },
        html: { count: htmlCount, fields: [...htmlFields], hasScriptOrIframe },
        privateInfo,
    };
}

function hostOf(raw) {
    try {
        return new URL(raw).hostname.toLowerCase().slice(0, 253);
    } catch {
        return null;
    }
}

/**
 * Enough of the value to recognise it, not enough to republish it. The report
 * exists to say "this is in here", not to hand the secret to the next reader.
 */
function redact(value) {
    const text = String(value);
    if (text.length <= 6) {
        return '*'.repeat(text.length);
    }
    return `${text.slice(0, 2)}${'*'.repeat(Math.min(8, text.length - 4))}${text.slice(-2)}`;
}

/**
 * The entry point: validates raw downloaded bytes.
 *
 * The upstream Content-Type is advisory only — magic bytes decide, because the
 * header is exactly the part an attacker controls for free.
 *
 * @param {Buffer} buffer
 * @param {'png' | 'json'} expect
 * @returns {{ kind: 'png' | 'json', spec: string, inside: object }}
 */
export function validateCardBytes(buffer, expect) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new CardBytesError('card_invalid', 'no bytes');
    }

    const looksPng = buffer.length >= PNG_SIGNATURE.length
        && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

    // The signature decides, not `expect`. An adapter saying "png" while the
    // site returns a perfectly good JSON card should import it, not fail — and
    // an adapter saying "json" cannot talk us into skipping the PNG checks.
    void expect;

    if (looksPng) {
        const chunks = readPngTextChunks(buffer);

        // Prefer v3 when a card carries both.
        const raw = chunks.get('ccv3') ?? chunks.get('chara');
        if (!raw) {
            // A plain picture is not a character card, however valid the PNG.
            throw new CardBytesError('card_invalid', 'png carries no embedded card');
        }

        const parsed = decodeCardPayload(raw);
        return { kind: 'png', spec: parsed.spec, inside: describeCard(parsed, buffer) };
    }

    const parsed = parseCardJson(buffer);
    return { kind: 'json', spec: parsed.spec, inside: describeCard(parsed, buffer) };
}

/** Builds a well-formed tEXt chunk: length, type, keyword\0payload, CRC. */
export function textChunk(keyword, payload) {
    const body = Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from(payload, 'latin1'),
    ]);

    const chunk = Buffer.alloc(body.length + 12);
    chunk.writeUInt32BE(body.length, 0);
    chunk.write('tEXt', 4, 'latin1');
    body.copy(chunk, 8);
    // CRC covers the type field and the data, per the PNG specification.
    chunk.writeUInt32BE(crc32Range(chunk, 4, 8 + body.length), 8 + body.length);
    return chunk;
}

/**
 * Turns a plain PNG picture into a character card by inserting the card as a
 * `chara` tEXt chunk directly before IEND. The image chunks are copied through
 * byte for byte; only the one chunk is added.
 *
 * The picture is fully validated first, so the splice below can trust that the
 * final twelve bytes are the IEND chunk and that nothing follows it.
 *
 * @param {Buffer} png a well-formed PNG with no embedded card
 * @param {object} card the card object to embed
 * @returns {Buffer}
 */
export function embedCardInPng(png, card) {
    if (readPngTextChunks(png).size > 0) {
        throw new CardBytesError('png_malformed', 'picture already carries a card');
    }
    const payload = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
    const iend = png.length - 12;
    return Buffer.concat([png.subarray(0, iend), textChunk('chara', payload), png.subarray(iend)]);
}
