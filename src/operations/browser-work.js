import { getJob, updateJob } from '../jobs/store.js';
import { noteOwner } from '../jobs/runner.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayHash } from '../roleplay-store.js';
import { operationError, readOperation, withOperation } from './store.js';

const artifact = id => `browser-result:${id}`;
const waiting = () => Object.assign(operationError('This WebLLM step needs an open browser.'), { operationWaiting: true });

/** Only explicitly browser-local model steps may suspend an otherwise server-owned workflow. */
export function requestBrowserWork(context, step, kind, input) {
    if (!['webllm.embedding', 'webllm.summary'].includes(kind)) throw operationError('This browser computation is unsupported.');
    const id = roleplayHash({ step, kind, input });
    const saved = readArtifact(context.directories, context.job.id, artifact(id));
    if (saved !== undefined) {
        if (saved.id !== id || saved.hash !== roleplayHash(saved.result)) throw operationError('The saved browser result needs recovery.');
        return saved.result;
    }
    context.signal.throwIfAborted();
    withOperation(context, ({ value, save }) => {
        if (value.browserWork && value.browserWork.id !== id) throw operationError('Another browser computation is still waiting.');
        value.browserWork = { id, kind, input };
        save();
        updateJob(context.directories, context.job.id, current => {
            if (current.cancellation?.requested) throw operationError('This operation has been stopped.');
            return { ...current, state: 'waiting', stage: 'Waiting for WebLLM in the browser', resume: { browserId: id } };
        });
    });
    throw waiting();
}

function validateResult(work, result) {
    if (work.kind === 'webllm.summary') {
        if (typeof result !== 'string' || !result.trim() || Buffer.byteLength(result) > 1024 * 1024) throw operationError('WebLLM returned an invalid summary.', 400);
    } else {
        if (!Array.isArray(result) || result.length !== work.input.texts.length) throw operationError('WebLLM returned the wrong number of vectors.', 400);
        const width = result[0]?.length;
        if (!width || width > 65536 || result.some(vector => !Array.isArray(vector) || vector.length !== width
            || vector.some(number => typeof number !== 'number' || !Number.isFinite(number))
            || !vector.some(number => number !== 0))) throw operationError('WebLLM returned invalid vectors.', 400);
    }
    return result;
}

/** Persist the local result before making the same accepted server job runnable again. */
export function completeBrowserWork(base, key, { id, result }) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw operationError('The browser computation identifier is invalid.', 400);
    const record = readOperation(base, key);
    const job = record?.jobId && getJob(base.directories, record.jobId);
    if (!job) throw operationError('The accepted browser computation is unavailable.');
    withOperation({ ...base, job }, ({ value, save }) => {
        if (job.cancellation?.requested || ['cancelled', 'failed', 'interrupted'].includes(job.state)) throw operationError('This browser computation has been stopped.');
        const previous = readArtifact(base.directories, job.id, artifact(id));
        if (previous !== undefined) {
            if (previous.id !== id || previous.hash !== roleplayHash(result)) throw operationError('A different browser result was already saved.');
        } else {
            if (!value.browserWork || value.browserWork.id !== id) throw operationError('This is not the waiting browser computation.');
            validateResult(value.browserWork, result);
            writeArtifact(base.directories, job.id, artifact(id), { id, result, hash: roleplayHash(result) });
        }
        if (value.browserWork?.id === id) { value.browserWork = null; save(); }
        updateJob(base.directories, job.id, current => current.state === 'waiting' && current.resume?.browserId === id
            ? { ...current, state: 'queued', resume: null, stage: 'Continuing saved vector work' } : current);
    });
    noteOwner(base.owner);
    return readOperation(base, key);
}

/** Recover only an already-saved local result after a process stopped between its two writes. */
export function finalizeBrowserWork(context) {
    if (context.job.state !== 'waiting' || !context.job.resume?.browserId || !context.job.intent?.operations) return false;
    const saved = readArtifact(context.directories, context.job.id, artifact(context.job.resume.browserId));
    if (saved === undefined) return false;
    completeBrowserWork(context, context.job.intent.operations.key, saved);
    return true;
}
