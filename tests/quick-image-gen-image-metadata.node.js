import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import {
    detectImageFormat,
    embedPngMetadataBundle,
    MAX_PNG_FILE_BYTES,
    readPngMetadataBundle,
    validateImageData,
} from '../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';

// Keep the bitwise checksum independent of the production lookup table.
function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = new Uint8Array()) {
    const result = new Uint8Array(data.length + 12);
    const view = new DataView(result.buffer);
    view.setUint32(0, data.length);
    result.set(new TextEncoder().encode(type), 4);
    result.set(data, 8);
    view.setUint32(8 + data.length, crc32(result.subarray(4, 8 + data.length)));
    return result;
}

function joinBytes(...parts) {
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}

function pngWithImageData({ width = 1, height = 1, interlace = 0, raw = Uint8Array.from([0, 255, 255, 255, 255]) } = {}) {
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;
    header[9] = 6;
    header[12] = interlace;
    return joinBytes(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
        chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND'));
}

test('QIG validates row filters across decompression output boundaries', async (t) => {
    const NativeDecompressionStream = global.DecompressionStream;
    t.mock.method(global, 'DecompressionStream', function (format) {
        const stream = new NativeDecompressionStream(format);
        return {
            writable: stream.writable,
            readable: stream.readable.pipeThrough(new TransformStream({
                transform(bytes, controller) {
                    for (let offset = 0; offset < bytes.length; offset += 7) {
                        controller.enqueue(bytes.subarray(offset, offset + 7));
                    }
                },
            })),
        };
    });
    const raw = new Uint8Array(16 * 9).fill(255);
    for (let row = 0; row < 16; row++) raw[row * 9] = row % 5;
    const image = (bytes) => pngWithImageData({ width: 2, height: 16, raw: bytes });
    assert.equal((await validateImageData(image(raw)))?.ext, 'png');
    for (const row of [1, 7, 15]) {
        const invalid = raw.slice();
        invalid[row * 9] = 5;
        assert.equal(await validateImageData(image(invalid)), null, `filter in row ${row}`);
    }
    assert.equal(await validateImageData(image(raw.subarray(0, raw.length - 1))), null);
    assert.equal(await validateImageData(image(joinBytes(raw, Uint8Array.of(0)))), null);
});

test('QIG validates changing row lengths across Adam7 interlace passes', async () => {
    // A 5x5 RGBA image has these filter-inclusive row lengths across its seven passes.
    const rowLengths = [5, 5, 9, 5, 5, 13, 9, 9, 9, 21, 21];
    const raw = joinBytes(...rowLengths.map((length, index) => {
        const row = new Uint8Array(length).fill(255);
        row[0] = index % 5;
        return row;
    }));
    const image = (bytes) => pngWithImageData({ width: 5, height: 5, interlace: 1, raw: bytes });
    assert.equal((await validateImageData(image(raw)))?.ext, 'png');
    let offset = 0;
    for (const length of rowLengths) {
        const invalid = raw.slice();
        invalid[offset] = 5;
        assert.equal(await validateImageData(image(invalid)), null, `filter at byte ${offset}`);
        offset += length;
    }
});

test('QIG validates split IDAT data and byte views without accepting corrupt CRCs', async () => {
    const source = pngWithImageData();
    const length = new DataView(source.buffer).getUint32(33);
    const compressed = source.subarray(41, 41 + length);
    const split = joinBytes(source.subarray(0, 33), chunk('IDAT', compressed.subarray(0, 1)),
        chunk('IDAT', compressed.subarray(1)), chunk('IEND'));
    const padded = joinBytes(Uint8Array.of(99), split, Uint8Array.of(99));
    for (const value of [split.buffer, padded.subarray(1, 1 + split.length), new DataView(padded.buffer, 1, split.length)]) {
        assert.deepEqual(await validateImageData(value), { ext: 'png', mime: 'image/png', isPng: true });
    }
    const corrupt = split.slice();
    corrupt[42] ^= 1; // First IDAT checksum, leaving its data intact.
    assert.equal(await validateImageData(corrupt), null);

    const metadata = { parameters: 'CRC round-trip: café', structured: { prompt: 'portrait', seed: 42 } };
    const embedded = new Uint8Array(embedPngMetadataBundle(split, metadata));
    const view = new DataView(embedded.buffer);
    for (let offset = 8; offset < embedded.length;) {
        const dataEnd = offset + 8 + view.getUint32(offset);
        assert.equal(view.getUint32(dataEnd), crc32(embedded.subarray(offset + 4, dataEnd)));
        offset = dataEnd + 4;
    }
    const restored = await readPngMetadataBundle(embedded);
    assert.equal(restored.parameters, metadata.parameters);
    assert.deepEqual(restored.structured.data, metadata.structured);
    assert.equal((await validateImageData(embedded))?.ext, 'png');
});

test('QIG rejects broken compressed data even when its PNG checksum is valid', async () => {
    const image = pngWithImageData();
    const length = new DataView(image.buffer).getUint32(33);
    image[41 + length - 1] ^= 0xff; // Corrupt the zlib checksum, then repair the outer PNG checksum.
    image.set(chunk('IDAT', image.subarray(41, 41 + length)), 33);
    assert.equal(await validateImageData(image), null);
});

test('QIG retains PNG resource limits without a decompressor', async (t) => {
    const NativeDecompressionStream = global.DecompressionStream;
    global.DecompressionStream = undefined;
    t.after(() => { global.DecompressionStream = NativeDecompressionStream; });
    assert.equal((await validateImageData(pngWithImageData()))?.ext, 'png');
    const oversized = new Uint8Array(MAX_PNG_FILE_BYTES + 1);
    oversized.set(pngWithImageData());
    assert.equal(await validateImageData(oversized), null);
    assert.equal(await validateImageData(pngWithImageData({ width: 16_385 })), null);
    assert.equal(await validateImageData(pngWithImageData({ width: 10_000, height: 5_000 })), null);
    assert.equal(await validateImageData(pngWithImageData({ width: 8_000, height: 5_000 })), null);
    assert.equal(await validateImageData(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)), null);
});

test('QIG preserves non-PNG format validation', async () => {
    const images = {
        jpg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
        avif: 'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACgAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgUBsAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwwMDAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAwbWRhdBIACghYAAa0BDQbhDIaGUeHhiGJpppmgAAAkD+bDGFLK02PUUVOpCA=',
        bmp: 'Qk2OAAAAAAAAAIoAAAB8AAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/AAAAAAAA/0JHUnOPwvUoUbgeFR6F6wEzMzMTZmZmJmZmZgaZmZkJPQrXAyhcjzIAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAD/AA==',
        gif: 'R0lGODlhAQABAPAAAP8AAAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==',
        tiff: 'SUkqAA4AAAD//wAAAAAPAAABAwABAAAAAQAAAAEBAwABAAAAAQAAAAIBAwADAAAAyAAAAAMBAwABAAAAAQAAAAYBAwABAAAAAgAAAAoBAwABAAAAAQAAABEBBAABAAAACAAAABIBAwABAAAAAQAAABUBAwABAAAAAwAAABYBAwABAAAAAQAAABcBBAABAAAABgAAABwBAwABAAAAAQAAACkBAwACAAAAAAABAD4BBQACAAAA/gAAAD8BBQAGAAAAzgAAAAAAAAAQABAAEACF61EAAACAAMP1qAAAAAACzcxMAAAAAAHNzEwAAACAAM3MTAAAAAACj8L1AAAAABA3GqAAAAAAAiuHCgAAACAA',
        webp: 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=',
    };
    for (const [ext, base64] of Object.entries(images)) {
        const bytes = Buffer.from(base64, 'base64');
        assert.equal((await validateImageData(bytes))?.ext, ext);
        assert.deepEqual(await validateImageData(bytes), detectImageFormat(bytes));
        assert.equal(await validateImageData(bytes.subarray(0, 8)), null);
    }
    assert.equal(await validateImageData(new Uint8Array()), null);
    assert.equal(await validateImageData(new TextEncoder().encode('<html>not an image</html>')), null);
});
