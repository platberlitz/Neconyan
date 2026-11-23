// Builds what the page sends for a patch, from the chat file a save is based on and the chat it wants saved.
import fs from 'node:fs';
import { FINGERPRINT_WIDTH, commonAffixLengths, digestKeptFingerprints, fingerprintText } from '../public/scripts/chat-patch-fingerprint.js';

export function fingerprintTexts(texts) {
    const words = new Uint32Array(texts.length * FINGERPRINT_WIDTH);
    texts.forEach((text, index) => fingerprintText(text, words, index * FINGERPRINT_WIDTH));
    return words;
}

/** The message lines of a saved chat file, header excluded. */
export function savedMessageLines(filename) {
    return fs.readFileSync(filename, 'utf8').split('\n').slice(1);
}

/**
 * @param {string[]} baseLines Message lines of the file the patch is based on
 * @param {object[]} records The whole chat to save: header, then messages
 * @param {object} [claim] Overrides, to build a patch that is wrong in a chosen way
 */
export function patchFor(baseLines, records, claim = {}) {
    const next = records.slice(1).map(record => JSON.stringify(record));
    const base = fingerprintTexts(baseLines);
    const { prefix, suffix } = commonAffixLengths(base, baseLines.length, fingerprintTexts(next), next.length);
    const patch = { header: structuredClone(records[0]), prefix, suffix, baseCount: baseLines.length, count: next.length,
        kept: digestKeptFingerprints(base, baseLines.length, prefix, suffix),
        messages: structuredClone(records.slice(1 + prefix, records.length - suffix)) };
    return { ...patch, ...claim };
}
