import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { matteSprite, upscaleSprite } from './sprite-model-pixels.js';

try {
    // Resolve the runtime from its declared owner, including nested installations.
    const require = createRequire(import.meta.url);
    const runtimeRequire = createRequire(require.resolve('sillytavern-transformers'));
    const ort = runtimeRequire('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    if (process.env.NECONYAN_IOS_APP === '1') ort.env.wasm.simd = false;
    ort.env.wasm.wasmPaths = path.dirname(runtimeRequire.resolve('onnxruntime-web')) + path.sep;
    const session = await ort.InferenceSession.create(fs.readFileSync(workerData.filename), { executionProviders: ['wasm'] });
    const infer = async (input, width, height) => {
        const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, height, width]) });
        return output[session.outputNames[0]].data;
    };
    const result = await (workerData.kind === 'matting' ? matteSprite : upscaleSprite)(workerData, infer);
    parentPort.postMessage(result, [result.data.buffer]);
} catch (error) {
    parentPort.postMessage({ error: `Sprite model failed: ${String(error?.message || error).slice(0, 300)}` });
}
