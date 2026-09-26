import { Worker } from 'node:worker_threads';
import { labError } from './store.js';

/** Bounded native computation also bounds user regular expressions. */
export function computeLab(kind, plan, signal, { timeout = 30000, tokenCount, prepareMemory } = {}) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./compute-worker.js', import.meta.url), { workerData: { kind, plan },
            resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
        let settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            void worker.terminate();
            if (error) reject(error); else resolve(result);
        };
        const abort = () => finish(new DOMException('Stopped the Labs computation.', 'AbortError'));
        const timer = setTimeout(() => finish(labError('The Labs computation exceeded its time limit. Nothing was applied.', 422)), timeout);
        signal?.addEventListener('abort', abort, { once: true });
        worker.on('message', async message => {
            if (message.memoryRequest !== undefined) {
                try {
                    if (!prepareMemory) throw labError('The saved memory snapshot is unavailable.');
                    const memory = await prepareMemory(message.input);
                    if (!settled) worker.postMessage({ memoryResponse: message.memoryRequest, memory });
                } catch (error) { finish(error); }
                return;
            }
            if (message.tokenRequest !== undefined) {
                try {
                    if (!tokenCount) throw labError('The Labs tokenizer is unavailable.');
                    const count = await tokenCount(message.text);
                    if (!settled) worker.postMessage({ tokenResponse: message.tokenRequest, count });
                } catch (error) { finish(error); }
                return;
            }
            finish(message.error ? labError(message.error, 422) : null, message.result);
        });
        worker.once('error', error => finish(error));
        worker.once('exit', code => { if (!settled) finish(labError(`The Labs computation stopped before saving a result (${code}).`, 503)); });
        if (signal?.aborted) abort();
    });
}
