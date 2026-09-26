import { getJob, updateJob } from '../jobs/store.js';
import { noteOwner } from '../jobs/runner.js';
import { finishLabJob, labError, listLabRecords, readLabRecord, withLabRecord } from './store.js';
import { promptingCompletion, readPromptingDatabaseLocked } from './prompting-storage.js';

const physical = new Set(['apply', 'prompting.publish', 'prompting.embed-apply']);
const database = new Set(['prompting.storage', 'prompting.suite', 'prompting.publish', 'prompting.transfer', 'prompting.embed']);

function evidence(base, key) {
    const record = readLabRecord(base, key);
    if (!record || ['completed', 'refused'].includes(record.state) || !record.jobId) return null;
    const job = getJob(base.directories, record.jobId);
    if (!job || !['cancelled', 'failed', 'interrupted'].includes(job.state)) return null;
    const context = { ...base, job };
    return withLabRecord(context, ({ lease, value }) => {
        const receipt = database.has(value.kind) ? promptingCompletion(readPromptingDatabaseLocked(lease), value) : null;
        if (receipt) return { context, record: value, receipt };
        if (physical.has(value.kind) && Object.keys(value.effects).length) return { context, record: value };
        return null;
    });
}

/** Only local writes with permanent publication evidence can use this recovery path. */
export function listLabRecovery(base) {
    return listLabRecords(base).flatMap(record => {
        const found = evidence(base, record.key);
        return found ? [{ key: record.key, label: record.label }] : [];
    });
}

export function recoverLabPublication(base, key) {
    const found = evidence(base, key);
    if (!found) throw labError('No interrupted local publication with saved recovery evidence was found.');
    if (found.receipt) {
        finishLabJob(found.context, found.receipt.result);
    } else {
        // Do not clear provider uncertainty. These handlers only finish their recorded local writes.
        updateJob(base.directories, found.context.job.id, current => {
            if (!['cancelled', 'failed', 'interrupted'].includes(current.state)) throw labError('The saved job is already active.');
            return { ...current, state: 'queued', finishedAt: null, error: null, dismissed: false,
                cancellation: { requested: false, requestedAt: null, reason: null } };
        });
        noteOwner(base.owner);
    }
    return readLabRecord(base, key);
}
