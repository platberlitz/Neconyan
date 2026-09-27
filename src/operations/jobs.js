import { validateOwner, getJob, updateJob } from '../jobs/store.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { admitOperation, finalizeOperation, finishOperation, operationError, readOperation, listOperations, withOperation } from './store.js';

const definitions = new Map();
function localPublication(base, key) {
    const record = readOperation(base, key);
    if (!record?.jobId || ['completed', 'refused'].includes(record.state)) return null;
    const job = getJob(base.directories, record.jobId);
    if (!job || !['cancelled', 'failed', 'interrupted'].includes(job.state)) return null;
    return withOperation({ ...base, job }, ({ value }) => definitions.get(value.kind)?.canRecover?.(value) ? job : null);
}

export function listApplicationRecovery(base) {
    return listOperations(base).filter(record => localPublication(base, record.key)).map(({ key, label }) => ({ key, label }));
}

/** Explicit recovery only finishes recorded local publications, preserving provider uncertainty. */
export function recoverApplicationPublication(base, key) {
    const job = localPublication(base, key);
    if (!job) throw operationError('No interrupted local publication with saved evidence was found.');
    updateJob(base.directories, job.id, current => {
        if (!['cancelled', 'failed', 'interrupted'].includes(current.state)) throw operationError('This operation is already active.');
        return { ...current, state: 'queued', finishedAt: null, error: null, dismissed: false,
            cancellation: { requested: false, requestedAt: null, reason: null } };
    });
    noteOwner(base.owner);
    return readOperation(base, key);
}

export function registerOperation(kind, definition) {
    if (definitions.has(kind)) throw new Error(`Duplicate application workflow: ${kind}`);
    definitions.set(kind, definition);
    registerHandler(`operations.${kind}`, context => runOperation(context));
}

export function operationAccount(request) {
    const owner = validateOwner(request.user?.profile?.handle);
    if (request.get?.('X-Neconyan-Account') && request.get('X-Neconyan-Account') !== owner) throw operationError('The signed-in account changed.');
    const base = { owner, directories: request.user.directories };
    return { base, account: withRoleplayAccount(base, null, (_lease, account) => account) };
}

export async function acceptApplicationOperation(request, body = {}) {
    const { key, kind, ...input } = body;
    if (typeof key !== 'string' || !key || key.length > 200) throw operationError('An operation key is required.', 400);
    const definition = definitions.get(kind);
    if (!definition) throw operationError('The requested application workflow is unavailable.', 400);
    await definition.authorize?.(request, input);
    const { base, account } = operationAccount(request);
    const existing = readOperation(base, key);
    if (existing) {
        if (existing.requestHash !== roleplayHash({ kind, input })) throw operationError('This key names different application work.');
        if (existing.state !== 'preparing') {
            const job = existing.jobId ? getJob(base.directories, existing.jobId) : null;
            if (job) finalizeOperation({ ...base, job });
            noteOwner(base.owner);
            return { created: false, record: existing, job: job && getJob(base.directories, job.id) };
        }
    }
    const plan = existing?.plan ?? await definition.capture(base, account, input);
    const accepted = admitOperation(base, account, { key, kind, input, plan, label: definition.label,
        applyTarget: definition.target?.(plan) ?? null });
    if (accepted.job) finalizeOperation({ ...base, job: accepted.job });
    noteOwner(base.owner);
    return { ...accepted, job: accepted.job && getJob(base.directories, accepted.job.id) };
}

export async function runOperation(context, dependencies = {}) {
    const record = withOperation(context, ({ value }) => value);
    if (record.state === 'completed') return { result: { key: record.key, resultHash: record.resultHash } };
    if (record.state === 'refused') throw operationError(record.error || 'The application change was refused.');
    context.signal.throwIfAborted();
    const definition = definitions.get(record.kind);
    if (!definition) throw operationError('The accepted workflow is unavailable.');
    let result = definition.resultInRecord ? undefined : readArtifact(context.directories, context.job.id, 'result');
    if (result === undefined) {
        try { result = JSON.parse(JSON.stringify(await definition.run(context, record.plan, dependencies))); } catch (error) {
            if (error.operationWaiting === true) return { waiting: true };
            if (error.operationRefused === true) withOperation(context, ({ value, save }) => {
                if (!Object.keys(value.effects).length || definition.canRefuse?.(value)) { value.state = 'refused'; value.error = error.message; save(); }
            });
            throw error;
        }
        if (!definition.resultInRecord) writeArtifact(context.directories, context.job.id, 'result', result);
    }
    finishOperation(context, result);
    return { result: { key: record.key, resultHash: roleplayHash(result) } };
}
