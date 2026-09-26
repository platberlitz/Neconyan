import express from 'express';
import { acceptLabJob, labAccount } from '../labs/jobs.js';
import { listLabRecords, readLabRecord, refuseLabSubmission } from '../labs/store.js';
import { listWorldInfoCases } from '../labs/world-info-cases.js';
import { readPromptingStorage } from '../labs/prompting-storage.js';
import { listLabRecovery, recoverLabPublication } from '../labs/recovery.js';

export const router = express.Router();
const publicRecord = record => record && ({ key: record.key, kind: record.kind, label: record.label, state: record.state,
    jobId: record.jobId, resultHash: record.resultHash ?? null, result: record.result ?? null,
    review: record.review ?? null, partial: record.partial ?? null, display: record.plan.display ?? null,
    error: record.error ?? null, createdAt: record.createdAt });
const route = action => async (request, response) => {
    try {
        response.set('Cache-Control', 'no-store');
        await action(request, response);
    } catch (error) { response.status(error.status ?? 500).json({ error: error.message, code: error.code ?? null }); }
};

router.post('/submit', route(async (request, response) => {
    let accepted;
    try { accepted = await acceptLabJob(request, request.body); } catch (error) {
        let notAccepted = false;
        try {
            const { base, account } = labAccount(request);
            if (typeof request.body?.key === 'string' && request.body.key.length <= 200) {
                notAccepted = refuseLabSubmission(base, account, request.body, error.message);
            }
        } catch { /* Retain the request when admission evidence cannot be read. */ }
        return response.status(error.status ?? 500).json({ error: error.message, code: error.code ?? null, notAccepted });
    }
    if (accepted.job) response.set('X-Neconyan-Job', accepted.job.id);
    response.status(accepted.created ? 202 : 200).json({ ...accepted, record: publicRecord(accepted.record) });
}));
router.get('/records', route((request, response) => {
    const { base } = labAccount(request);
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
    if (!record) return response.status(404).json({ error: 'The saved Labs result was not found.' });
    response.json(publicRecord(record));
}));
