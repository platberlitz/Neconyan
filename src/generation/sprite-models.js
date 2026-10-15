import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { getConfigValue } from '../util.js';
import { termuxWorkerOptions } from '../termux-file-identity.js';

export const SPRITE_MODELS = Object.freeze({
    matting: {
        filename: 'anime-seg.onnx', bytes: 176069933,
        sha256: 'f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99',
        url: 'https://huggingface.co/skytnt/anime-seg/resolve/493cb60893f47441b26ec4fb9a306bce9e342982/isnetis.onnx',
    },
    upscale: {
        filename: 'anime-upscale.onnx', bytes: 2492908,
        sha256: '78baa685a1a92cac6e14ab2af2a8ad0ef56fa48629563b1414e3a7acc54d86e2',
        url: 'https://huggingface.co/skillsafe-ai/realesr-animevideov3/resolve/185e9142d439d17e3fb99395600fb7d08af09de5/model.onnx',
    },
});
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const directory = () => path.join(globalThis.DATA_ROOT, '_cache', 'sprite-models');
const downloads = new Map();
let pending = 0, queue = Promise.resolve();

function modelFor(kind) {
    if (!Object.hasOwn(SPRITE_MODELS, kind)) throw fail('Unknown sprite model.');
    return SPRITE_MODELS[kind];
}

export async function verifySpriteModel(filename, model) {
    try {
        const stat = await fs.promises.lstat(filename);
        if (!stat.isFile() || stat.size !== model.bytes) return false;
        const hash = createHash('sha256');
        for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
        return hash.digest('hex') === model.sha256;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

export async function spriteModelStatus() {
    return {
        downloadAllowed: getConfigValue('extensions.models.autoDownload', true, 'boolean'),
        models: Object.fromEntries(await Promise.all(Object.entries(SPRITE_MODELS).map(async ([kind, model]) => [kind, {
            installed: await verifySpriteModel(path.join(directory(), model.filename), model), bytes: model.bytes,
        }]))),
    };
}

/** Explicit opt-in only. A partial or unverified file is never used for inference. */
export async function installSpriteModel(kind, { fetchImpl = fetch, signal } = {}) {
    const model = modelFor(kind), folder = directory(), filename = path.join(folder, model.filename);
    if (await verifySpriteModel(filename, model)) return;
    if (!getConfigValue('extensions.models.autoDownload', true, 'boolean')) throw fail('Model downloads are disabled in the server configuration.', 403);
    if (downloads.has(kind)) return downloads.get(kind);
    const job = (async () => {
        await fs.promises.mkdir(folder, { recursive: true });
        const temporary = path.join(folder, `${model.filename}.${randomUUID()}.part`);
        try {
            const response = await fetchImpl(model.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000) });
            if (!response.ok || !response.body) throw fail('The sprite model download failed. Try again.', 502);
            const file = await fs.promises.open(temporary, 'wx', 0o600);
            const hash = createHash('sha256');
            let size = 0;
            try {
                for await (const chunk of response.body) {
                    size += chunk.length;
                    if (size > model.bytes) throw fail('The downloaded sprite model has an unexpected size.', 502);
                    hash.update(chunk);
                    await file.writeFile(chunk);
                }
                await file.sync();
            } finally { await file.close(); }
            if (size !== model.bytes || hash.digest('hex') !== model.sha256) throw fail('The sprite model download could not be verified. Try again.', 502);
            await fs.promises.rename(temporary, filename);
        } finally { await fs.promises.rm(temporary, { force: true }); }
    })();
    downloads.set(kind, job);
    try { await job; } finally { downloads.delete(kind); }
}

export function validateSpriteModelInput(kind, { width, height, data, scale = 2 }) {
    modelFor(kind);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
        || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw fail('Invalid sprite pixels.');
    if (width * height > 4 * 1024 * 1024 || (kind === 'upscale' && (![2, 4].includes(scale)
        || width * height * scale * scale > 16 * 1024 * 1024))) throw fail('This image is too large for the selected sprite model. Use a smaller image or 2x enlargement.', 413);
}

/** One worker at a time, released after every image. Stop also releases its model memory. */
export async function processSpriteModel(kind, bitmap, { signal } = {}) {
    validateSpriteModelInput(kind, bitmap);
    if (pending >= 4) throw fail('Sprite models are busy. Try again when the current images finish.', 429);
    pending++;
    const previous = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    try {
        await previous;
        signal?.throwIfAborted();
        const model = modelFor(kind), filename = path.join(directory(), model.filename);
        if (!await verifySpriteModel(filename, model)) throw fail('Download this sprite model in Image generation and cleanup first.', 409);
        signal?.throwIfAborted();
        const pixels = new Uint8Array(bitmap.data);
        const worker = new Worker(new URL('./sprite-model-worker.js', import.meta.url), {
            ...termuxWorkerOptions(), workerData: { ...bitmap, data: pixels, kind, filename }, transferList: [pixels.buffer],
        });
        try {
            return await new Promise((resolve, reject) => {
                const abort = () => reject(signal.reason);
                const timeout = setTimeout(() => reject(fail('Sprite processing timed out. Try a smaller image.', 504)), 600000);
                const clear = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
                signal?.addEventListener('abort', abort, { once: true });
                worker.once('message', result => { clear(); result.error ? reject(fail(result.error, 500)) : resolve(result); });
                worker.once('error', error => { clear(); reject(error); });
                worker.once('exit', () => { clear(); reject(fail('Sprite processing stopped before it finished.', 500)); });
                if (signal?.aborted) abort();
            });
        } finally { await worker.terminate(); }
    } finally { pending--; release(); }
}
