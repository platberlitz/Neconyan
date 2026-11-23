import { createOperationRecords } from '../jobs/operation-records.js';
import { getJob, listJobs } from '../jobs/store.js';
import { isJobRunning } from '../jobs/runner.js';
import { roleplayHash } from '../roleplay-store.js';
import { reconcileAccountReset } from './account-reset-proof.js';

const OPERATION_RECORD_LIMIT = 64 * 1024 * 1024;
const OPERATION_PLAN_LIMIT = 24 * 1024 * 1024;
const RAW_GENERATION_RECORD_LIMIT = 16 * 1024 * 1024;
const RAW_GENERATION_PLAN_LIMIT = 8 * 1024 * 1024;
const LIVE_JOB_STATES = new Set(['queued', 'running', 'waiting']);

function operationJobStates(base, context) {
    if (!base?.directories) return null;
    if (context && context.jobStates !== undefined) return context.jobStates;
    const states = new Map(listJobs(base.directories, { includeDismissed: true }).map(job => [job.id, job.state]));
    if (context) context.jobStates = states;
    return states;
}

/** Only active or mid-admission operations reserve their full output budget; failed, cancelled, interrupted or pruned jobs keep their on-disk size only. */
function operationReserves(value, base, context) {
    if (value?.state === 'preparing') return true;
    if (value?.state !== 'accepted') return false;
    if (!value.jobId || isJobRunning(value.jobId)) return true;
    const states = operationJobStates(base, context);
    if (!states) return true;
    return LIVE_JOB_STATES.has(states.get(value.jobId));
}

const records = createOperationRecords({ namespace: 'operations', label: 'Application', errorCode: 'APPLICATION_WORK_CHANGED',
    recordLimit: kind => kind === 'raw-generation' ? RAW_GENERATION_RECORD_LIMIT : OPERATION_RECORD_LIMIT,
    planLimit: kind => kind === 'raw-generation' ? RAW_GENERATION_PLAN_LIMIT : OPERATION_PLAN_LIMIT,
    reserves: operationReserves,
    survivesReset: kind => kind === 'account-reset', reconcile: reconcileAccountReset,
    canRelease: ({ job, directories }, value) => {
        if (!value.plan.ownerJob) return true;
        const parent = getJob(directories, value.plan.ownerJob.id);
        const child = getJob(directories, job.id);
        return Boolean(parent && child?.parentId === parent.id && parent.children.includes(child.id)
            && !parent.cancellation?.requested && roleplayHash(parent.intent) === value.plan.ownerJob.intentHash);
    } });

export const { error: operationError, assertTargetIdle: assertOperationTargetIdle,
    reserveLocked: reserveOperationLocked, read: readOperation,
    refuse: refuseOperation, list: listOperations, withRecord: withOperation,
    mutateLocked: mutateOperationLocked, admit: admitOperation, finalize: finalizeOperation,
    finish: finishOperation } = records;
