/**
 * Content-type detection for proxied thumbnails, by magic bytes only.
 *
 * The upstream Content-Type header is not trusted: it is attacker-influenced in
 * exactly the case that matters. A site could label an SVG as image/png, and an
 * SVG is XML that can carry script — so SVG is refused outright rather than
 * sniffed, labelled or sanitized. Raster formats cannot execute.
 */

/** @type {Array<{ type: string, test: (b: Buffer) => boolean }>} */
const SIGNATURES = [
    {
        type: 'image/png',
        test: (b) => b.length >= 8
            && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
            && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A,
    },
    {
        type: 'image/jpeg',
        test: (b) => b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
    },
    {
        type: 'image/gif',
        test: (b) => b.length >= 6 && b.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/) !== null,
    },
    {
        type: 'image/webp',
        test: (b) => b.length >= 12
            && b.subarray(0, 4).toString('latin1') === 'RIFF'
            && b.subarray(8, 12).toString('latin1') === 'WEBP',
    },
    {
        type: 'image/avif',
        test: (b) => b.length >= 12
            && b.subarray(4, 8).toString('latin1') === 'ftyp'
            && ['avif', 'avis'].includes(b.subarray(8, 12).toString('latin1')),
    },
];

/**
 * @param {Buffer} buffer
 * @returns {string | null} a safe content type, or null if it is not a raster image we accept
 */
export function detectImageType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
        return null;
    }

    for (const signature of SIGNATURES) {
        if (signature.test(buffer)) {
            return signature.type;
        }
    }

    return null;
}
