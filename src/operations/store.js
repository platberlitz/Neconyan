import { createOperationRecords } from '../jobs/operation-records.js';
import { getJob } from '../jobs/store.js';
import { roleplayHash } from '../roleplay-store.js';
import { reconcileAccountReset } from './account-reset-proof.js';

const records = createOperationRecords({ namespace: 'operations', label: 'Application', errorCode: 'APPLICATION_WORK_CHANGED',
    recordLimit: () => 64 * 1024 * 1024, planLimit: () => 24 * 1024 * 1024,
    survivesReset: kind => kind === 'account-reset', reconcile: reconcileAccountReset,
    canRelease: ({ job, directories }, value) => {
        if (!value.plan.ownerJob) return true;
        const parent = getJob(directories, value.plan.ownerJob.id);
        const child = getJob(directories, job.id);
        return Boolean(parent && child?.parentId === parent.id && parent.children.includes(child.id)
            && !parent.cancellation?.requested && roleplayHash(parent.intent) === value.plan.ownerJob.intentHash);
    } });

export const { error: operationError, assertTargetIdle: assertOperationTargetIdle, read: readOperation,
    refuse: refuseOperation, list: listOperations, withRecord: withOperation,
    mutateLocked: mutateOperationLocked, admit: admitOperation, finalize: finalizeOperation,
    finish: finishOperation } = records;
