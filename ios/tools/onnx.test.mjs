import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { WebAssembly } from 'polywasm';

test('the iOS local-model configuration executes a small ONNX graph without native WebAssembly', { timeout: 60000 }, async () => {
    const original = globalThis.WebAssembly;
    const previous = process.env.NECONYAN_IOS_APP;
    try {
        globalThis.WebAssembly = WebAssembly;
        process.env.NECONYAN_IOS_APP = '1';
        await import('../../src/transformers.js');
        const require = createRequire(import.meta.url);
        const owner = createRequire(require.resolve('sillytavern-transformers'));
        const ort = owner('onnxruntime-web');
        // A 3x2 float matrix multiplied by the constant matrix [1, 2, 3, 4, 5, 6].
        const model = Buffer.from('CAMSBmNoZW50YTpwChUKAVgKAVcSAVkaBW11bF8xIgNNdWwSCG11bCB0ZXN0KiMIAwgCEAEiGAAAgD8AAABAAABAQAAAgEAAAKBAAADAQEIBV1oTCgFYEg4KDAgBEggKAggDCgIIAmITCgFZEg4KDAgBEggKAggDCgIIAkIECgAQBw==', 'base64');
        const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
        const output = await session.run({ X: new ort.Tensor('float32', [1, 2, 3, 4, 5, 6], [3, 2]) });
        assert.deepEqual(Array.from(output.Y.data), [1, 4, 9, 16, 25, 36]);
    } finally {
        globalThis.WebAssembly = original;
        if (previous === undefined) delete process.env.NECONYAN_IOS_APP;
        else process.env.NECONYAN_IOS_APP = previous;
    }
});
