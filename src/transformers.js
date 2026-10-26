import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';

import { pipeline, env, RawImage } from 'sillytavern-transformers';
import { getConfigValue } from './util.js';
import { serverDirectory } from './server-directory.js';

configureTransformers();

function configureTransformers() {
    // Limit the number of threads to 1 to avoid issues on Android
    env.backends.onnx.wasm.numThreads = 1;
    // The iOS interpreter accepts the feature probe but cannot execute SIMD instructions.
    if (process.env.NECONYAN_IOS_APP === '1') env.backends.onnx.wasm.simd = false;
    // Use WASM from a local folder to avoid CDN connections
    env.backends.onnx.wasm.wasmPaths = path.join(serverDirectory, 'node_modules', 'sillytavern-transformers', 'dist') + path.sep;
}

// The server-side RawImage reader decodes images with Jimp 0.22, which supports these formats.
// Checking the signature and the header length first keeps malformed non-images, including ASF
// headers that make the file-type 16.5.4 parser loop forever, away from the image parser.
// file-type reads the first PNG chunk header (16 bytes) and peeks 24 bytes at a little-endian
// TIFF; shorter buffers make it reject with an unhandled promise rejection inside Jimp.
const SUPPORTED_IMAGE_HEADERS = [
    { bytes: [0xff, 0xd8, 0xff], minimumLength: 3 }, // JPEG
    { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], minimumLength: 16 }, // PNG
    { bytes: [0x47, 0x49, 0x46, 0x38], minimumLength: 4 }, // GIF
    { bytes: [0x42, 0x4d], minimumLength: 2 }, // BMP
    { bytes: [0x49, 0x49, 0x2a, 0x00], minimumLength: 24 }, // TIFF, little endian
    { bytes: [0x4d, 0x4d, 0x00, 0x2a], minimumLength: 4 }, // TIFF, big endian
];

function isSupportedImageBuffer(buffer) {
    return SUPPORTED_IMAGE_HEADERS.some(({ bytes, minimumLength }) =>
        buffer.length >= minimumLength && bytes.every((byte, index) => buffer[index] === byte));
}

const tasks = {
    'text-classification': {
        defaultModel: 'Cohee/distilbert-base-uncased-go-emotions-onnx',
        pipeline: null,
        configField: 'extensions.models.classification',
        quantized: true,
    },
    'image-to-text': {
        defaultModel: 'Xenova/vit-gpt2-image-captioning',
        pipeline: null,
        configField: 'extensions.models.captioning',
        quantized: true,
    },
    'feature-extraction': {
        defaultModel: 'Xenova/all-mpnet-base-v2',
        pipeline: null,
        configField: 'extensions.models.embedding',
        quantized: true,
    },
    'automatic-speech-recognition': {
        defaultModel: 'Xenova/whisper-small',
        pipeline: null,
        configField: 'extensions.models.speechToText',
        quantized: true,
    },
    'text-to-speech': {
        defaultModel: 'Xenova/speecht5_tts',
        pipeline: null,
        configField: 'extensions.models.textToSpeech',
        quantized: false,
    },
};

/**
 * Gets a RawImage object from a base64-encoded image.
 * @param {string} image Base64-encoded image
 * @returns {Promise<RawImage|null>} Object representing the image
 */
export async function getRawImage(image) {
    try {
        const buffer = Buffer.from(image, 'base64');
        if (!isSupportedImageBuffer(buffer)) {
            return null;
        }
        const byteArray = new Uint8Array(buffer);
        const blob = new Blob([byteArray]);

        const rawImage = await RawImage.fromBlob(blob);
        return rawImage;
    } catch {
        return null;
    }
}

/**
 * Gets the model to use for a given transformers.js task.
 * @param {string} task The task to get the model for
 * @returns {string} The model to use for the given task
 */
function getModelForTask(task) {
    const defaultModel = tasks[task].defaultModel;

    try {
        const model = getConfigValue(tasks[task].configField, null);
        return model || defaultModel;
    } catch (error) {
        console.warn('Failed to read config.yaml, using default classification model.');
        return defaultModel;
    }
}

async function migrateCacheToDataDir() {
    const oldCacheDir = path.join(process.cwd(), 'cache');
    const newCacheDir = path.join(globalThis.DATA_ROOT, '_cache');

    if (!fs.existsSync(newCacheDir)) {
        fs.mkdirSync(newCacheDir, { recursive: true });
    }

    if (fs.existsSync(oldCacheDir) && fs.statSync(oldCacheDir).isDirectory()) {
        const files = fs.readdirSync(oldCacheDir);

        if (files.length === 0) {
            return;
        }

        console.log('Migrating model cache files to data directory. Please wait...');

        for (const file of files) {
            try {
                const oldPath = path.join(oldCacheDir, file);
                const newPath = path.join(newCacheDir, file);
                fs.cpSync(oldPath, newPath, { recursive: true, force: true });
                fs.rmSync(oldPath, { recursive: true, force: true });
            } catch (error) {
                console.warn('Failed to migrate cache file. The model will be re-downloaded.', error);
            }
        }
    }
}

/**
 * Gets the transformers.js pipeline for a given task.
 * @param {import('sillytavern-transformers').PipelineType} task The task to get the pipeline for
 * @param {string} forceModel The model to use for the pipeline, if any
 * @returns {Promise<import('sillytavern-transformers').Pipeline>} The transformers.js pipeline
 */
export async function getPipeline(task, forceModel = '') {
    if (!Object.hasOwn(tasks, task)) throw new Error('Unsupported local model task.');
    await migrateCacheToDataDir();

    const model = forceModel || getModelForTask(task);
    if (tasks[task].pipeline) {
        if (tasks[task].currentModel === model) {
            return tasks[task].pipeline;
        }
        console.log('Disposing transformers.js pipeline for for task', task, 'with model', tasks[task].currentModel);
        const previous = tasks[task].pipeline;
        tasks[task].pipeline = null;
        tasks[task].currentModel = undefined;
        await previous.dispose();
    }

    const cacheDir = path.join(globalThis.DATA_ROOT, '_cache');
    const localOnly = !getConfigValue('extensions.models.autoDownload', true, 'boolean');
    console.log('Initializing transformers.js pipeline for task', task, 'with model', model);
    const instance = await pipeline(task, model, { cache_dir: cacheDir, quantized: tasks[task].quantized ?? true, local_files_only: localOnly });
    tasks[task].pipeline = instance;
    tasks[task].currentModel = model;
    // @ts-ignore
    return instance;
}

const taskOperations = new Map();

/** Keep a task's model alive until its current operation settles, including after cancellation. */
export function runPipeline(task, forceModel, operation, { signal } = {}) {
    const previous = taskOperations.get(task) ?? Promise.resolve();
    const work = previous.then(async () => {
        signal?.throwIfAborted();
        const pipe = await getPipeline(task, forceModel);
        signal?.throwIfAborted();
        const result = await operation(pipe);
        signal?.throwIfAborted();
        return result;
    });
    const settled = work.then(() => {}, () => {});
    taskOperations.set(task, settled);
    void settled.then(() => { if (taskOperations.get(task) === settled) taskOperations.delete(task); });
    return work;
}

export default {
    getRawImage,
    getPipeline,
    runPipeline,
};
