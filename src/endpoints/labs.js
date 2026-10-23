import express from 'express';
import { acceptLabJob, labAccount, replaceDistillation } from '../labs/jobs.js';
import { listLabRecords, readLabRecord, refuseLabSubmission, reconcileDistillations } from '../labs/store.js';
import { listWorldInfoCases } from '../labs/world-info-cases.js';
import { readPromptingStorage } from '../labs/prompting-storage.js';
import { listLabRecovery, recoverLabPublication } from '../labs/recovery.js';

export const router = express.Router();
const publicRecord = record => record && ({ key: record.key, kind: record.kind, label: record.label, state: record.state,
    jobId: record.jobId, resultHash: record.resultHash ?? null, result: record.result ?? null,
    review: record.review ?? null, partial: record.partial ?? null, display: record.plan.display ?? null,
    error: record.error ?? null, createdAt: record.createdAt, lifecycle: record.lifecycle ?? null });
const route = action => async (request, response) => {
    try {
        response.set('Cache-Control', 'no-store');
        await action(request, response);
    } catch (error) { response.status(error.status ?? 500).json({ error: error.message, code: error.code ?? null, notAccepted: error.notAccepted === true }); }
};

const submit = replace => route(async (request, response) => {
    let accepted;
    try { accepted = await (replace ? replaceDistillation : acceptLabJob)(request, request.body); } catch (error) {
        let notAccepted = error.notAccepted === true;
        try {
            const { base, account } = labAccount(request);
            if (typeof request.body?.key === 'string' && request.body.key.length <= 200) {
                const submission = { ...request.body };
                for (const field of ['previousKey', 'previousRevision', 'previousBody', 'consent']) delete submission[field];
                notAccepted = refuseLabSubmission(base, account, replace ? submission : request.body, error.message) || notAccepted;
            }
        } catch { /* Retain the request when admission evidence cannot be read. */ }
        return response.status(error.status ?? 500).json({ error: error.message, code: error.code ?? null, notAccepted,
            recordKey: error.recordKey ?? null, replacementKey: error.replacementKey ?? null });
    }
    if (accepted.job) response.set('X-Neconyan-Job', accepted.job.id);
    response.status(accepted.created ? 202 : 200).json({ ...accepted, record: publicRecord(accepted.record) });
});
router.post('/submit', submit(false));
router.post('/distill/replace', submit(true));
router.post('/distill/:key/resume', route(async (request, response) => {
    const { base } = labAccount(request);
    const record = readLabRecord(base, request.params.key);
    if (!record || record.kind !== 'distill' || !record.requestInput) return response.status(404).json({ error: 'That retained distillation could not be resumed.' });
    const accepted = await acceptLabJob(request, { ...record.requestInput, key: record.key, kind: 'distill' });
    if (accepted.job) response.set('X-Neconyan-Job', accepted.job.id);
    response.status(accepted.created ? 202 : 200).json({ ...accepted, record: publicRecord(accepted.record) });
}));
router.get('/records', route((request, response) => {
    const { base, account } = labAccount(request);
    if (!request.query.kind || request.query.kind === 'distill') reconcileDistillations(base, account);
    response.json(listLabRecords(base, String(request.query.kind || '')));
}));
router.get('/recovery', route((request, response) => {
    const { base } = labAccount(request);
    response.json(listLabRecovery(base));
}));
router.post('/records/:key/recover', route((request, response) => {
    const { base } = labAccount(request);
    response.json(publicRecord(recoverLabPublication(base, request.params.key)));
}));
router.post('/world-info/cases', route((request, response) => {
    const { base, account } = labAccount(request);
    response.json(listWorldInfoCases(base, account, request.body.bookNames));
}));
router.post('/prompting/read', route(async (request, response) => {
    const { base, account } = labAccount(request);
    response.json(await readPromptingStorage(base, account, request.body.method, request.body.args));
}));
router.get('/records/:key', route((request, response) => {
    const { base } = labAccount(request);
    const record = readLabRecord(base, request.params.key);
    if (!record) return response.status(404).json({ error: 'That Labs result could not be found.' });
    response.json(publicRecord(record));
}));
