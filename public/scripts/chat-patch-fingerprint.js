/**
 * Fingerprints of chat message text, shared by the page and the server so that both compute the same
 * value for the same JSON text. Dependency-free on purpose: the server imports this file too.
 *
 * A fingerprint is three unsigned 32-bit words: two independent hashes of the UTF-16 code units
 * (read two at a time) and the text length. Fingerprints are stored flat, `FINGERPRINT_WIDTH` words
 * per message, in a Uint32Array.
 */

export const FINGERPRINT_WIDTH = 3;

/**
 * @param {string} text JSON text of one message
 * @param {Uint32Array} words Destination array
 * @param {number} at Index of the first destination word
 */
export function fingerprintText(text, words, at = 0) {
    const length = text.length;
    let h1 = 0x9747b28c ^ length;
    let h2 = (0x85ebca77 + length) | 0;
    let index = 0;
    for (; index + 1 < length; index += 2) {
        const unit = text.charCodeAt(index) | (text.charCodeAt(index + 1) << 16);
        let k = Math.imul(unit, 0xcc9e2d51);
        k = (k << 15) | (k >>> 17);
        h1 ^= Math.imul(k, 0x1b873593);
        h1 = (h1 << 13) | (h1 >>> 19);
        h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
        h2 = (h2 + Math.imul(unit, 0x85ebca77)) | 0;
        h2 = (h2 << 13) | (h2 >>> 19);
        h2 = Math.imul(h2, 0x9e3779b1);
    }
    if (index < length) {
        const unit = text.charCodeAt(index);
        h1 = Math.imul(h1 ^ unit, 0xcc9e2d51);
        h2 = Math.imul(h2 ^ unit, 0x85ebca77);
    }
    h1 ^= length;
    h1 ^= h1 >>> 16;
    h1 = Math.imul(h1, 0x85ebca6b);
    h1 ^= h1 >>> 13;
    h1 = Math.imul(h1, 0xc2b2ae35);
    h1 ^= h1 >>> 16;
    h2 ^= h2 >>> 15;
    h2 = Math.imul(h2, 0x85ebca77);
    h2 ^= h2 >>> 13;
    h2 = Math.imul(h2, 0xc2b2ae3d);
    h2 ^= h2 >>> 16;
    words[at] = h1;
    words[at + 1] = h2;
    words[at + 2] = length;
}

/**
 * How many leading and trailing messages two fingerprint lists share. The two never overlap:
 * `prefix + suffix <= min(baseCount, nextCount)`.
 * @param {Uint32Array} base
 * @param {number} baseCount
 * @param {Uint32Array} next
 * @param {number} nextCount
 */
export function commonAffixLengths(base, baseCount, next, nextCount) {
    const limit = Math.min(baseCount, nextCount);
    const same = (left, right) => base[left * FINGERPRINT_WIDTH] === next[right * FINGERPRINT_WIDTH]
        && base[left * FINGERPRINT_WIDTH + 1] === next[right * FINGERPRINT_WIDTH + 1]
        && base[left * FINGERPRINT_WIDTH + 2] === next[right * FINGERPRINT_WIDTH + 2];
    let prefix = 0;
    while (prefix < limit && same(prefix, prefix)) prefix++;
    let suffix = 0;
    while (suffix < limit - prefix && same(baseCount - 1 - suffix, nextCount - 1 - suffix)) suffix++;
    return { prefix, suffix };
}

/**
 * One digest of the fingerprints of the messages a patch keeps: the first `prefix` and the last
 * `suffix` of `count` messages. Four independent 32-bit lanes, printed as 32 hex digits.
 * @param {Uint32Array} words Fingerprints of all `count` messages
 * @param {number} count
 * @param {number} prefix
 * @param {number} suffix
 */
export function digestKeptFingerprints(words, count, prefix, suffix) {
    let a = 0x243f6a88 ^ prefix;
    let b = 0x85a308d3 ^ suffix;
    let c = 0x13198a2e ^ count;
    let d = 0x03707344;
    const feed = (from, to) => {
        for (let index = from * FINGERPRINT_WIDTH; index < to * FINGERPRINT_WIDTH; index++) {
            const word = words[index];
            a = Math.imul(a ^ word, 0x85ebca6b);
            a ^= a >>> 15;
            b = (b + Math.imul(word, 0xcc9e2d51)) | 0;
            b = (b << 13) | (b >>> 19);
            b = Math.imul(b, 0x9e3779b1);
            c = Math.imul(c ^ (word + index), 0xc2b2ae35);
            c ^= c >>> 13;
            d = Math.imul(d + word + 0x7f4a7c15 | 0, 0x1b873593);
            d = (d << 11) | (d >>> 21);
        }
    };
    feed(0, prefix);
    a ^= 0x9e3779b9;
    b ^= 0x7f4a7c15;
    feed(count - suffix, count);
    const finish = value => {
        value ^= value >>> 16;
        value = Math.imul(value, 0x85ebca6b);
        value ^= value >>> 13;
        value = Math.imul(value, 0xc2b2ae35);
        value ^= value >>> 16;
        return (value >>> 0).toString(16).padStart(8, '0');
    };
    return finish(a) + finish(b ^ a) + finish(c ^ b) + finish(d ^ c);
}
