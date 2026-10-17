/* global globalThis */
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { loadDialog, scanIssue, scanResult } from './prompt-media-dialog-harness.js';
import { buttonsNamed, byTag, settle } from './prompt-media-dom-stub.js';

// The still-image conversion worker (public/scripts/prompt-image-conversion-worker.js) run in Node with small stand-ins for the browser's image
// functions. Each failure is posted as an error code, and the page maps the code to its ledger sentence (C-5). The worker's image parsing runs
// for real; only decoding and drawing are replaced.

let env;
const posted = [];
const pngChunk = (type, length = 0, data = Buffer.alloc(length)) => Buffer.concat([Buffer.from([length >>> 24, length >>> 16 & 255, length >>> 8 & 255, length & 255]), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (width = 10, height = 10) => { const data = Buffer.alloc(13); data.writeUInt32BE(width, 0); data.writeUInt32BE(height, 4); return pngChunk('IHDR', 13, data); };
const riff = (...chunks) => { const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]); const head = Buffer.alloc(8); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length, 4); return Buffer.concat([head, body]); };
const webpChunk = (type, size, body = Buffer.alloc(size)) => { const head = Buffer.alloc(8); head.write(type, 0, 'latin1'); head.writeUInt32LE(size, 4); return Buffer.concat([head, body]); };
const jpeg = (...middle) => Buffer.from([255, 216, ...middle, 255, 217]);
const sof = (width, height) => [255, 192, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, ...new Array(10).fill(0)];
const validJpeg = (width = 100, height = 100) => jpeg(...sof(width, height));
const toBuffer = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

beforeAll(async () => {
    env = await loadDialog(jest);
    globalThis.self = { postMessage: message => posted.push(message) };
    await import('../public/scripts/prompt-image-conversion-worker.js');
});
beforeEach(() => {
    posted.length = 0;
    globalThis.stub = { first: { width: 100, height: 100 }, decoded: { width: 100, height: 100 }, blobSize: 1000, reject: false, encodeFails: false, encodeError: undefined };
    globalThis.createImageBitmap = async () => {
        if (globalThis.stub.reject) throw new Error('The source image could not be decoded.');
        const size = globalThis.stub.calls++ ? globalThis.stub.decoded : globalThis.stub.first;
        return { ...size, close() {} };
    };
    globalThis.stub.calls = 0;
    globalThis.OffscreenCanvas = class { constructor(width, height) { this.width = width; this.height = height; } getContext() { return { drawImage() {} }; } async convertToBlob({ type }) { if (globalThis.stub.encodeFails) throw globalThis.stub.encodeError; return { size: globalThis.stub.blobSize, type }; } };
});

const run = async buffer => { posted.length = 0; await globalThis.self.onmessage({ data: { bytes: toBuffer(buffer) } }); return posted[0]; };

describe('failures that are found by reading the file', () => {
    const cases = [
        ['too-large', Buffer.alloc(0), 'an empty file'],
        ['animated', Buffer.concat([PNG_SIGNATURE, ihdr(), pngChunk('acTL', 8)]), 'a PNG with an animation chunk'],
        ['png-incomplete', Buffer.concat([PNG_SIGNATURE, ihdr(), pngChunk('IDAT', 1000, Buffer.alloc(0))]), 'a PNG whose last chunk runs past the end'],
        ['png-incomplete', Buffer.concat([PNG_SIGNATURE, ihdr(), pngChunk('IDAT', 0)]), 'a PNG with no end chunk'],
        ['animated', riff(webpChunk('VP8X', 10, Buffer.from([2, 0, 0, 0, 9, 0, 0, 9, 0, 0]))), 'a WebP with the animation flag'],
        ['animated', riff(webpChunk('VP8X', 10, Buffer.alloc(10)), webpChunk('ANIM', 6)), 'a WebP with an animation chunk'],
        ['webp-incomplete', riff(webpChunk('VP8X', 10, Buffer.alloc(10)), webpChunk('VP8L', 100, Buffer.alloc(4))), 'a WebP whose last chunk runs past the end'],
        ['webp-incomplete', Buffer.concat([riff(webpChunk('VP8X', 10, Buffer.alloc(10))), Buffer.alloc(3)]), 'a WebP whose size field does not match the file'],
        ['jpeg-damaged', Buffer.from([255, 216, 0, 0, 0, 0, 255, 217]), 'a JPEG with a bad marker'],
        ['jpeg-incomplete', Buffer.from([255, 216, 255, 224, 255, 255, 0, 0, 255, 217]), 'a JPEG whose segment runs past the end'],
        ['unsupported', Buffer.from('this is not an image at all, only text that is long enough'), 'a file that is not an image'],
        ['unsupported', validJpeg(5000, 5000), 'a JPEG over 16 million pixels'],
    ];
    for (const [code, buffer, description] of cases) {
        test(`${description} is posted as ${code}`, async () => {
            expect(await run(buffer)).toEqual({ errorCode: code });
        });
    }

    test('a file over 16 MiB is too large', async () => {
        expect(await run(Buffer.alloc(16 * 1024 * 1024 + 1))).toEqual({ errorCode: 'too-large' });
    });
});

describe('failures that are found by decoding', () => {
    test('a decoded image over 16 million pixels', async () => {
        globalThis.stub.first = { width: 5000, height: 4000 };
        expect(await run(validJpeg())).toEqual({ errorCode: 'too-many-pixels' });
    });

    test('a converted image still over 1 MiB', async () => {
        globalThis.stub.blobSize = 2 * 1024 * 1024;
        expect(await run(validJpeg())).toEqual({ errorCode: 'still-too-large' });
    });

    test('a converted image that decodes larger than allowed', async () => {
        globalThis.stub.first = { width: 3000, height: 1000 };
        globalThis.stub.decoded = { width: 3000, height: 1000 };
        expect(await run(validJpeg())).toEqual({ errorCode: 'result-too-large' });
    });

    test('anything the worker did not expect is posted as failed, not as a sentence', async () => {
        globalThis.stub.reject = true;
        expect(await run(validJpeg())).toEqual({ errorCode: 'failed' });
    });

    test('a good image is posted with its sizes and no error', async () => {
        globalThis.stub.first = { width: 4000, height: 2000 };
        globalThis.stub.decoded = { width: 2048, height: 1024 };
        const answer = await run(validJpeg(100, 100));
        expect(answer).toMatchObject({ width: 2048, height: 1024, originalWidth: 100, originalHeight: 100 });
        expect(answer.errorCode).toBeUndefined();
        expect(answer.error).toBeUndefined();
    });
});

describe('a browser error with a numeric code is posted as failed (W-1)', () => {
    // A browser DOMException has a legacy numeric code, and it is 0 for EncodingError, OperationError, NotReadableError and DataError. The page reads a
    // falsy errorCode as success, so only a string code is one of ours: anything else is posted as 'failed'.
    const failures = [
        ['an EncodingError DOMException (code 0)', () => new DOMException('The source image could not be encoded.', 'EncodingError'), 0],
        ['an OperationError DOMException (code 0)', () => new DOMException('The operation failed.', 'OperationError'), 0],
        ['an InvalidStateError DOMException (code 11)', () => new DOMException('The canvas cannot be read.', 'InvalidStateError'), 11],
        ['an error named EncodingError with code 0', () => Object.assign(new Error('The source image could not be encoded.'), { name: 'EncodingError', code: 0 }), 0],
        ['a rejection that is not an object', () => null, undefined],
    ];
    test.each(failures)('the encoder failing with %s', async (_description, make, numericCode) => {
        const error = make();
        expect(error?.code).toBe(numericCode);
        globalThis.stub.encodeFails = true; globalThis.stub.encodeError = error;
        expect(await run(validJpeg())).toEqual({ errorCode: 'failed' });
    });

    test('the page rejects with the sentence for failed, and offers no preview, when the encoder fails with code 0', async () => {
        globalThis.stub.encodeFails = true;
        globalThis.stub.encodeError = new DOMException('The source image could not be encoded.', 'EncodingError');
        const answer = await run(validJpeg());
        expect(answer).toEqual({ errorCode: 'failed' });
        // The same answer, given to the page that started the worker.
        const target = { group: false, chat: 'Review', avatar: 'Group.png' };
        env.reset(); env.workerAnswer = answer;
        env.routes.scan = () => scanResult([scanIssue({ status: 'embedded-image' })], target);
        env.routes.source = () => ({ base64: 'AAAA' });
        const { content, status } = await env.open(target);
        await buttonsNamed(byTag(content, 'fieldset')[0], 'Prepare a converted copy')[0].click(); await settle();
        expect(status.textContent).toBe('This browser could not convert the image. Choose a PNG, JPEG or WebP file instead.');
        expect(env.popups.filter(popup => popup.type === 'confirm')).toEqual([]);
    });
});

describe('the page picks the sentence', () => {
    test('every code the worker posted above maps to a different, final-ready ledger sentence', async () => {
        const codes = ['too-large', 'animated', 'png-incomplete', 'webp-incomplete', 'jpeg-damaged', 'jpeg-incomplete', 'unsupported', 'too-many-pixels', 'still-too-large', 'result-too-large', 'failed'];
        const sentences = codes.map(code => env.labels.workerErrorMessage(code));
        expect(new Set(sentences).size).toBe(codes.length);
        for (const sentence of sentences) expect(sentence).toMatch(/^[A-Z].*\.$/);
        expect(sentences[codes.indexOf('animated')]).toBe('Animated images cannot be converted. Choose a still image.');
    });
});
