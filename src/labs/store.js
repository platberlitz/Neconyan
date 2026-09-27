import { createOperationRecords } from '../jobs/operation-records.js';

export const LAB_RECORD_LIMIT = 16 * 1024 * 1024;
export const LAB_STORE_LIMIT = 512 * 1024 * 1024;
const records = createOperationRecords({ namespace: 'labs', label: 'Labs', errorCode: 'LAB_WORK_CHANGED',
    recordLimit: kind => kind === 'prompting.transfer' ? 64 * 1024 * 1024 : LAB_RECORD_LIMIT,
    planLimit: kind => kind === 'prompting.transfer' ? 24 * 1024 * 1024 : 8 * 1024 * 1024,
    storeLimit: LAB_STORE_LIMIT });

export const { error: labError, assertTargetIdle: assertLabsTargetIdle, read: readLabRecord,
    refuse: refuseLabSubmission, list: listLabRecords, withRecord: withLabRecord,
    mutateLocked: mutateLabRecordLocked, admit: admitLabJob, finalize: finalizeLabSubmission,
    finish: finishLabJob } = records;
