import { beforeEach, expect, jest, test } from '@jest/globals';

const fromBlob = jest.fn();
jest.unstable_mockModule('sillytavern-transformers', () => ({ pipeline: jest.fn(),
    env: { backends: { onnx: { wasm: {} } } }, RawImage: { fromBlob } }));
const { getRawImage } = await import('../src/transformers.js');

const headers = {
    jpeg: { bytes: [0xff, 0xd8, 0xff], minimumLength: 3 },
    png: { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], minimumLength: 16 },
    gif: { bytes: [0x47, 0x49, 0x46, 0x38], minimumLength: 4 },
    bmp: { bytes: [0x42, 0x4d], minimumLength: 2 },
    tiffLittleEndian: { bytes: [0x49, 0x49, 0x2a, 0x00], minimumLength: 24 },
    tiffBigEndian: { bytes: [0x4d, 0x4d, 0x00, 0x2a], minimumLength: 4 },
};

beforeEach(() => {
    fromBlob.mockReset();
});

function paddedHeader(bytes, length) {
    const buffer = Buffer.alloc(length);
    Buffer.from(bytes).copy(buffer, 0, 0, Math.min(bytes.length, length));
    return buffer;
}

function exploitBytes() {
    const bytes = Buffer.alloc(96);
    Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9]).copy(bytes, 0);
    // A zero-size ASF sub-header makes file-type 16.5.4 move backwards forever.
    return bytes;
}

test('the malformed ASF header never reaches the image parser', async () => {
    expect(await getRawImage(exploitBytes().toString('base64'))).toBeNull();
    expect(fromBlob).not.toHaveBeenCalled();
});

test('bytes without a supported image signature never reach the image parser', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('not an image'), Buffer.from('<svg></svg>')]) {
        expect(await getRawImage(bytes.toString('base64'))).toBeNull();
    }
    expect(fromBlob).not.toHaveBeenCalled();
});

test('truncated PNG and little endian TIFF headers never reach the image parser', async () => {
    const truncated = [];
    for (let length = 8; length < headers.png.minimumLength; length++) truncated.push(paddedHeader(headers.png.bytes, length));
    for (let length = 4; length < headers.tiffLittleEndian.minimumLength; length++) {
        truncated.push(paddedHeader(headers.tiffLittleEndian.bytes, length));
    }
    for (const bytes of truncated) {
        expect(await getRawImage(bytes.toString('base64'))).toBeNull();
    }
    expect(fromBlob).not.toHaveBeenCalled();
});

test('every supported image header still reaches the image parser', async () => {
    const image = { width: 1, height: 1 };
    fromBlob.mockResolvedValue(image);
    for (const { bytes, minimumLength } of Object.values(headers)) {
        expect(await getRawImage(paddedHeader(bytes, minimumLength).toString('base64'))).toBe(image);
    }
    expect(fromBlob).toHaveBeenCalledTimes(Object.keys(headers).length);
});

test('a supported image header whose image cannot be decoded still returns null', async () => {
    fromBlob.mockRejectedValueOnce(new Error('Unreadable image'));
    expect(await getRawImage(paddedHeader(headers.png.bytes, headers.png.minimumLength).toString('base64'))).toBeNull();
});
