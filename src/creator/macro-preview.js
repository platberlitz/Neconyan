import { Worker } from 'node:worker_threads';

const RUN_LIMIT_MS = 2000;
// Loading the macro modules is most of a preview's cost and a busy phone can take seconds, so only a worker that never loads at all is cut off, and only after a long wait.
const START_LIMIT_MS = 30000;

/**
 * A disposable worker has no account paths, callbacks or shared random state. The 2 s running limit starts when the worker reports it is ready.
 * `options` is for tests only (a stand-in worker, a short start-up bound, a look at the worker); the endpoint passes only the request body as `input`.
 */
export function previewCreatorMacros(input, { workerUrl = new URL('./macro-worker.js', import.meta.url), startupTimeoutMs = START_LIMIT_MS, onWorker } = {}) {
    const { text, user = 'Interviewer', character = 'Character', variables = {} } = input;
    if (typeof text !== 'string' || text.length > 20000 || typeof user !== 'string' || typeof character !== 'string' || user.length > 200 || character.length > 200 || !variables || typeof variables !== 'object' || Array.isArray(variables) || JSON.stringify(variables).length > 20000) {
        throw Object.assign(new Error('Keep preview text and variables within 20,000 characters.'), { status: 400 });
    }
    return new Promise((resolve, reject) => {
        const worker = new Worker(workerUrl, { workerData: { text, user, character, variables }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
        onWorker?.(worker);
        let settled = false;
        let ready = false;
        let timer = setTimeout(() => finish(new Error('The macro preview could not start. Try again.'), undefined, 503), startupTimeoutMs);
        const finish = (error, result, status = 400) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void worker.terminate();
            if (error) reject(Object.assign(error, { status })); else resolve(result);
        };
        worker.on('message', result => {
            if (result.ready) {
                if (ready) return;
                ready = true;
                clearTimeout(timer);
                timer = setTimeout(() => finish(new Error('The macro preview exceeded its time limit.')), RUN_LIMIT_MS);
                return;
            }
            finish(result.error ? new Error(result.error) : null, result);
        });
        worker.once('error', error => finish(error));
        worker.once('exit', code => { if (code) finish(new Error('The macro preview stopped.')); });
    });
}
