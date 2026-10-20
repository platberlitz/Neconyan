import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';

import crc32 from 'crc/crc32';

import encode from './png/encode.js';
import extractChunks from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

function extract(image) {
    // The dependency allocates each declared chunk before checking for truncated input.
    for (let offset = 8; offset < image.length;) {
        if (image.length - offset < 12) throw new Error('Truncated PNG chunk.');
        const length = image[offset] * 0x1000000 + image[offset + 1] * 0x10000 + image[offset + 2] * 0x100 + image[offset + 3];
        if (length > image.length - offset - 12) throw new Error('Truncated PNG chunk.');
        if (image[offset + 4] === 73 && image[offset + 5] === 69 && image[offset + 6] === 78 && image[offset + 7] === 68) break;
        offset += length + 12;
    }
    return extractChunks(image);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const PNG_LINE_ENDING_BYTES = new Set([4, 5, 7]);
const PNG_READ_WINDOW = 64 * 1024;
const checksum = zlib.crc32 ?? crc32;
const asBuffer = bytes => Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * Splits a tEXt chunk like png-chunk-text, but leaves the text as bytes until a card needs it:
 * lorebook-heavy cards carry megabytes of text, twice.
 * @param {Buffer} data Chunk data
 * @returns {{ keyword: string, bytes: Buffer }}
 */
function textChunk(data) {
    const separator = data.indexOf(0);
    if (separator === -1) return { keyword: data.toString('latin1'), bytes: Buffer.alloc(0) };
    if (data.indexOf(0, separator + 1) !== -1) {
        throw new Error('Invalid NULL character found. 0x00 character is not permitted in tEXt content');
    }
    return { keyword: data.toString('latin1', 0, separator), bytes: data.subarray(separator + 1) };
}

/**
 * Lists a PNG's text chunks without copying or checksumming the image data, which is nearly all of a
 * card's bytes; listing a large library spent most of its time on pixels it never used. Every other
 * chunk is still bounds-checked and checksummed.
 * @param {number} size File size in bytes
 * @param {(offset: number, length: number) => Uint8Array} bytesAt Returns exactly `length` bytes
 * @returns {{ keyword: string, bytes: Buffer }[]}
 */
function readTextChunks(size, bytesAt) {
    const signature = bytesAt(0, Math.min(8, size));
    PNG_SIGNATURE.forEach((byte, index) => {
        if (signature[index] === byte) return;
        throw new Error(`Invalid .png file header${PNG_LINE_ENDING_BYTES.has(index) ? ': possibly caused by DOS-Unix line ending conversion?' : ''}`);
    });

    const texts = [];
    for (let offset = 8, first = true; offset < size; first = false) {
        if (size - offset < 12) throw new Error('Truncated PNG chunk.');
        const header = asBuffer(bytesAt(offset, 8));
        const length = header.readUInt32BE(0);
        if (length > size - offset - 12) throw new Error('Truncated PNG chunk.');
        const name = header.toString('latin1', 4, 8);
        if (first && name !== 'IHDR') throw new Error('IHDR header missing');
        if (name === 'IEND') return texts;
        if (name !== 'IDAT') {
            const chunk = asBuffer(bytesAt(offset + 4, length + 8));
            if (checksum(chunk.subarray(0, length + 4)) !== chunk.readUInt32BE(length + 4)) {
                throw new Error(`CRC values for ${name} header do not match, PNG file is likely corrupted`);
            }
            if (name === 'tEXt') texts.push(textChunk(chunk.subarray(4, length + 4)));
        }
        offset += length + 12;
    }
    throw new Error('.png file ended prematurely: no IEND header was found');
}

/**
 * Picks the card from a PNG's text chunks. V3 (ccv3) takes precedence over V2 (chara).
 * @param {{ keyword: string, bytes: Buffer }[]} textChunks
 * @returns {string} Character data
 */
function cardFromTextChunks(textChunks) {
    if (textChunks.length === 0) {
        console.error('PNG metadata does not contain any text chunks.');
        throw new Error('No PNG metadata.');
    }

    const card = textChunks.find((chunk) => chunk.keyword.toLowerCase() === 'ccv3')
        ?? textChunks.find((chunk) => chunk.keyword.toLowerCase() === 'chara');

    if (card) {
        return Buffer.from(card.bytes.toString('latin1'), 'base64').toString('utf8');
    }

    console.error('PNG metadata does not contain any character data.');
    throw new Error('No PNG metadata.');
}

/**
 * Reads the card from a PNG file, skipping over the image data instead of loading it.
 * @param {string} filename
 * @returns {string} Character data
 */
function readCardFile(filename) {
    const fd = fs.openSync(filename, 'r');
    try {
        const { size } = fs.fstatSync(fd);
        let windowStart = 0;
        let window = Buffer.alloc(0);
        return cardFromTextChunks(readTextChunks(size, (offset, length) => {
            if (offset < windowStart || offset + length > windowStart + window.length) {
                window = Buffer.allocUnsafe(Math.min(Math.max(length, PNG_READ_WINDOW), size - offset));
                windowStart = offset;
                let filled = 0;
                while (filled < window.length) {
                    const read = fs.readSync(fd, window, filled, window.length - filled, offset + filled);
                    if (!read) throw new Error('Truncated PNG chunk.');
                    filled += read;
                }
            }
            return window.subarray(offset - windowStart, offset - windowStart + length);
        }));
    } finally {
        fs.closeSync(fd);
    }
}

const MIRRORED_FIELD_MAPPINGS = {
    name: 'name',
    description: 'description',
    personality: 'personality',
    scenario: 'scenario',
    first_mes: 'first_mes',
    mes_example: 'mes_example',
    tags: 'tags',
    talkativeness: 'extensions.talkativeness',
    fav: 'extensions.fav',
};

/**
 * @param {object} obj
 * @param {string} path
 * @returns {any}
 */
function getPath(obj, path) {
    return path.split('.').reduce((value, key) => value?.[key], obj);
}

/**
 * @param {object} obj
 * @param {string} path
 * @param {any} value
 */
function setPath(obj, path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    let current = obj;

    for (const key of keys) {
        current[key] = current[key] ?? {};
        current = current[key];
    }

    current[lastKey] = value;
}

/**
 * Keeps root-level legacy fields synchronized with the V2/V3 data block.
 * @param {object} card
 * @returns {object}
 */
function normalizeCard(card) {
    const normalized = JSON.parse(JSON.stringify(card));
    normalized.data = normalized.data ?? {};
    normalized.data.extensions = normalized.data.extensions ?? {};

    for (const [legacyField, dataPath] of Object.entries(MIRRORED_FIELD_MAPPINGS)) {
        const rootValue = normalized[legacyField];
        const dataValue = getPath(normalized.data, dataPath);

        if (typeof dataValue !== 'undefined') {
            normalized[legacyField] = dataValue;
            continue;
        }

        if (typeof rootValue !== 'undefined') {
            setPath(normalized.data, dataPath, rootValue);
        }
    }

    if (typeof normalized.data.creator_notes !== 'undefined') {
        normalized.creatorcomment = normalized.data.creator_notes;
    } else if (typeof normalized.creatorcomment !== 'undefined') {
        normalized.data.creator_notes = normalized.creatorcomment;
    }

    return normalized;
}

/**
 * Writes Character metadata to a PNG image buffer.
 * Keeps the legacy root fields mirrored with the V2/V3 data block to avoid spec mismatches.
 * @param {Buffer} image PNG image buffer
 * @param {string} data Character data to write
 * @returns {Buffer} PNG image buffer with metadata
 */
export const write = (image, data) => {
    const chunks = extract(new Uint8Array(image));
    const tEXtChunks = chunks.filter(chunk => chunk.name === 'tEXt');

    // Remove existing tEXt chunks
    for (const tEXtChunk of tEXtChunks) {
        const data = PNGtext.decode(tEXtChunk.data);
        if (data.keyword.toLowerCase() === 'chara' || data.keyword.toLowerCase() === 'ccv3') {
            chunks.splice(chunks.indexOf(tEXtChunk), 1);
        }
    }

    let v2Json = data;
    let v3Json = null;

    try {
        const normalizedCard = normalizeCard(JSON.parse(data));

        const v2Data = JSON.parse(JSON.stringify(normalizedCard));
        v2Data.spec = 'chara_card_v2';
        v2Data.spec_version = '2.0';
        v2Json = JSON.stringify(v2Data);

        const v3Data = JSON.parse(JSON.stringify(normalizedCard));
        v3Data.spec = 'chara_card_v3';
        v3Data.spec_version = '3.0';
        v3Json = JSON.stringify(v3Data);
    } catch (error) {
        // Ignore JSON errors and fall back to writing the raw metadata as-is.
    }

    // Add new v2 chunk before the IEND chunk
    const base64EncodedV2Data = Buffer.from(v2Json, 'utf8').toString('base64');
    chunks.splice(-1, 0, PNGtext.encode('chara', base64EncodedV2Data));

    // Try adding v3 chunk before the IEND chunk
    if (v3Json) {
        const base64EncodedV3Data = Buffer.from(v3Json, 'utf8').toString('base64');
        chunks.splice(-1, 0, PNGtext.encode('ccv3', base64EncodedV3Data));
    }

    const newBuffer = Buffer.from(encode(chunks));
    return newBuffer;
};

/**
 * Reads Character metadata from a PNG image buffer.
 * Supports both V2 (chara) and V3 (ccv3). V3 (ccv3) takes precedence.
 * @param {Buffer} image PNG image buffer
 * @returns {string} Character data
 */
export const read = (image) => {
    const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
    return cardFromTextChunks(readTextChunks(bytes.length, (offset, length) => bytes.subarray(offset, offset + length)));
};

/**
 * Parses a card image and returns the character metadata.
 * @param {string} cardUrl Path to the card image
 * @param {string} format File format
 * @returns {Promise<string>} Character data
 */
export const parse = async (cardUrl, format) => {
    let fileFormat = format === undefined ? 'png' : format;

    switch (fileFormat) {
        case 'png':
            return readCardFile(cardUrl);
    }

    throw new Error('Unsupported format');
};
