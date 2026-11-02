import { Worker } from 'node:worker_threads';

/** A disposable worker has no account paths, callbacks or shared random state. */
export function previewCreatorMacros(input) {
    const { text, user = 'Interviewer', character = 'Character', variables = {} } = input;
    if (typeof text !== 'string' || text.length > 20000 || typeof user !== 'string' || typeof character !== 'string' || user.length > 200 || character.length > 200 || !variables || typeof variables !== 'object' || Array.isArray(variables) || JSON.stringify(variables).length > 20000) {
        throw Object.assign(new Error('Keep preview text and variables within 20,000 characters.'), { status: 400 });
    }
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./macro-worker.js', import.meta.url), { workerData: { text, user, character, variables }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
        let settled = false;
        const timer = setTimeout(() => finish(new Error('The macro preview exceeded its time limit.')), 2000);
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void worker.terminate();
            if (error) reject(Object.assign(error, { status: 400 })); else resolve(result);
        };
        worker.once('message', result => finish(result.error ? new Error(result.error) : null, result));
        worker.once('error', error => finish(error));
        worker.once('exit', code => { if (code) finish(new Error('The macro preview stopped.')); });
    });
}
