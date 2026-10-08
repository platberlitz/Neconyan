import { Worker } from 'node:worker_threads';
import { setImmediate } from 'node:timers/promises';
import { NotebookError } from './paths.js';
import { termuxWorkerOptions } from '../termux-file-identity.js';

/** CPU work and secure file reads only. Authoring writes never run in this worker. */
export function prepareInWorker(task, input) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./preparation-worker.js', import.meta.url), { workerData: { task, input },
            ...termuxWorkerOptions() });
        worker.once('message', message => {
            if (message.error) reject(new NotebookError(message.error.code, message.error.message, message.error.status));
            else resolve(message.result);
        });
        worker.once('error', reject);
        worker.once('exit', code => { if (code !== 0) reject(new Error(`Notes preparation stopped (${code}).`)); });
    });
}

export const yieldNotebookWork = () => setImmediate();
