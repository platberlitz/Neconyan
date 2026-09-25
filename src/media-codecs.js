import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { imageSize } from 'image-size';

const codecs = new Map();
const paths = { png: { decode: 'codec/pkg/squoosh_png_bg.wasm', encode: 'codec/pkg/squoosh_png_bg.wasm' },
    jpeg: { decode: 'codec/dec/mozjpeg_dec.wasm', encode: 'codec/enc/mozjpeg_enc.wasm' },
    webp: { decode: 'codec/dec/webp_dec.wasm', encode: 'codec/enc/webp_enc.wasm' } };

async function codec(format, operation) {
    const key = `${format}:${operation}`;
    if (!codecs.has(key)) codecs.set(key, (async () => {
        // Resolve through the installed Jimp format dependency so this also works without hoisted packages.
        const require = createRequire(import.meta.resolve(`@jimp/wasm-${format}`));
        const script = pathToFileURL(require.resolve(`@jsquash/${format}/${operation}.js`));
        const module = await import(script.href);
        const wasm = await WebAssembly.compile(await readFile(new URL(paths[format][operation], script)));
        await module.init(wasm);
        return module.default;
    })().catch(error => { codecs.delete(key); throw error; }));
    return codecs.get(key);
}

/** Use local codec bytes on Node; the browser-oriented default loader tries to fetch file: URLs. */
export async function decodeServerImage(bytes, maxPixels = 16 * 1024 * 1024) {
    const dimensions = imageSize(bytes);
    const format = dimensions.type === 'jpg' ? 'jpeg' : dimensions.type;
    if (!paths[format] || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
        || dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > maxPixels) {
        throw new Error('The saved image dimensions or format are unsupported.');
    }
    const decoded = await (await codec(format, 'decode'))(bytes);
    if (decoded.width !== dimensions.width || decoded.height !== dimensions.height
        || decoded.data?.length !== dimensions.width * dimensions.height * 4) throw new Error('The saved image data is invalid.');
    return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) };
}

export async function encodeServerImage(bitmap, format = 'png', options = {}) {
    if (!paths[format] || !Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height)
        || bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > 16 * 1024 * 1024
        || bitmap.data?.length !== bitmap.width * bitmap.height * 4) throw new Error('The output image data is invalid.');
    return Buffer.from(await (await codec(format, 'encode'))({ width: bitmap.width, height: bitmap.height,
        data: new Uint8ClampedArray(bitmap.data) }, options));
}
