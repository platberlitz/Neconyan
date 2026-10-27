import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import { acceptApplicationOperation, operationAccount, listApplicationRecovery, recoverApplicationPublication } from '../operations/jobs.js';
import { listOperations, readOperation, refuseOperation } from '../operations/store.js';
import { completeBrowserWork } from '../operations/browser-work.js';
import '../operations/translation.js';
import '../operations/vectors.js';
import '../operations/vector-purge.js';
import { readMaintenanceView } from '../operations/maintenance.js';
import { readArchiveFile, readArchiveOrganization } from '../operations/archive.js';
import { openSavedBinary } from '../operations/binary-files.js';
import '../operations/account-backup.js';
import '../operations/account-import.js';
import '../operations/backup-deletion.js';
import '../operations/custom-css.js';
import '../operations/quiet-generation.js';
import '../operations/raw-generation.js';
import '../operations/time-machine.js';
import { readUploadedArchive, retainUploadedArchive } from '../operations/input-files.js';
import { beginServerWork } from '../android-wake.js';

export const router = express.Router();
export const publicRecord = value => value && ({ key: value.key, kind: value.kind, label: value.label, state: value.state,
    jobId: value.jobId, result: value.result ?? null, resultHash: value.resultHash ?? null,
    error: value.error ?? null, browserWork: value.browserWork ?? null, createdAt: value.createdAt });
const route = action => async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try { await action(request, response); } catch (error) { response.status(error.status ?? 500).json({ error: error.message, code: error.code }); }
};
router.post('/submit', route(async (request, response) => {
    try {
        const accepted = await acceptApplicationOperation(request, request.body);
        if (accepted.job) response.set('X-Neconyan-Job', accepted.job.id);
        response.status(accepted.created ? 202 : 200).json({ ...accepted, record: publicRecord(accepted.record) });
    } catch (error) {
        let notAccepted = false;
        try {
            const { base, account } = operationAccount(request);
            if (typeof request.body?.key === 'string' && request.body.key.length <= 200) notAccepted = refuseOperation(base, account, request.body, error.message);
        } catch { /* Without durable refusal proof, the caller must retain its request. */ }
        response.status(error.status ?? 500).json({ error: error.message, code: error.code ?? null, notAccepted });
    }
}));
router.post('/import-input', route(async (request, response) => {
    const filename = request.file?.path;
    try {
        const { base, account } = operationAccount(request);
        if (!filename || typeof request.body?.key !== 'string' || !request.body.key || request.body.key.length > 200) {
            return response.status(400).json({ error: 'A ZIP file and upload identity are required.' });
        }
        const input = await retainUploadedArchive(base, account, request.body.key, filename);
        response.json({ inputId: input.id, size: input.size });
    } finally {
        if (filename) await fs.promises.rm(filename, { force: true });
    }
}));
// The iPhone app's own file picker leaves the chosen ZIP in its private inbox. Retaining it from there
// skips a browser upload that iOS would pause the moment the app leaves the screen.
router.post('/import-input-local', route(async (request, response) => {
    const { base, account } = operationAccount(request);
    const inbox = process.env.NECONYAN_LOCAL_IMPORT_DIR;
    const { key, token, submission } = request.body ?? {};
    if (!inbox) return response.status(404).json({ error: 'Local ZIP handoff is only available in the iPhone app.' });
    if (typeof key !== 'string' || !key || key.length > 200 || typeof token !== 'string' || !/^[A-Fa-f0-9-]{36}$/.test(token)) {
        return response.status(400).json({ error: 'A picked ZIP and upload identity are required.' });
    }
    if (submission !== undefined && (submission?.kind !== 'account-import' || typeof submission.key !== 'string' || !submission.key
        || submission.key.length > 200 || !submission.input || typeof submission.input !== 'object' || Array.isArray(submission.input))) {
        return response.status(400).json({ error: 'The planned import is unreadable.' });
    }
    // The page can be paused, and its connection dropped, long before this finishes.
    const endWork = beginServerWork();
    try {
        const filename = path.join(inbox, `${token}.zip`);
        let input;
        try {
            input = await retainUploadedArchive(base, account, key, filename);
        } catch (error) {
            // A repeated request after the page was paused finds its ZIP already retained and removed.
            if (fs.existsSync(filename) || error.code === 'IMPORT_UPLOAD_CONFLICT') throw error;
            input = readUploadedArchive(base, account, key);
            if (!input) throw error;
        }
        await fs.promises.rm(filename, { force: true });
        let submitError = null;
        if (submission) {
            // Same body, in the same order, as the page submits later, so its own submit finds this one.
            try {
                await acceptApplicationOperation(request, { ...submission.input, inputId: input.id, kind: submission.kind, key: submission.key });
            } catch (error) {
                submitError = error.message;
            }
        }
        response.json({ inputId: input.id, size: input.size, submitError });
    } finally {
        endWork();
    }
}));
router.get('/import-input/:key', route((request, response) => {
    const { base, account } = operationAccount(request);
    const saved = readUploadedArchive(base, account, request.params.key);
    if (!saved) return response.status(404).json({ error: 'The ZIP upload has not finished.' });
    return response.json({ inputId: saved.id, size: saved.size });
}));

router.get('/records', route((request, response) => {
    const { base } = operationAccount(request);
    response.json(listOperations(base, String(request.query.kind || '')));
}));
router.get('/recovery', route((request, response) => response.json(listApplicationRecovery(operationAccount(request).base))));
router.get('/archive/organization', route((request, response) => {
    const { base, account } = operationAccount(request);
    const { organization, revision } = readArchiveOrganization(base, account);
    response.json({ organization, revision });
}));
router.get('/records/:key/archive/:hash', route((request, response) => {
    const { bytes } = readArchiveFile(operationAccount(request).base, request.params.key, request.params.hash);
    response.set('X-Content-Type-Options', 'nosniff').type('text/plain').send(bytes);
}));
router.post('/records/:key/recover', route((request, response) => {
    response.json(publicRecord(recoverApplicationPublication(operationAccount(request).base, request.params.key)));
}));
router.post('/records/:key/browser-result', route((request, response) => {
    response.json(publicRecord(completeBrowserWork(operationAccount(request).base, request.params.key, request.body)));
}));
router.get('/records/:key', route((request, response) => {
    const { base } = operationAccount(request);
    const value = readOperation(base, request.params.key);
    if (!value) return response.status(404).json({ error: 'The saved application result was not found.' });
    response.json(publicRecord(value));
}));
router.get('/records/:key/download', route((request, response) => {
    const file = openSavedBinary(operationAccount(request).base, request.params.key);
    response.set('X-Content-Type-Options', 'nosniff').set('Content-Length', String(file.size)).type(file.type).attachment(file.name);
    const stream = fs.createReadStream(file.filename, { fd: file.fd, autoClose: true });
    response.on('close', () => stream.destroy());
    stream.on('error', error => response.destroy(error));
    stream.pipe(response);
}));
router.get('/records/:key/file/:hash', route((request, response) => {
    const { bytes, name } = readMaintenanceView(operationAccount(request).base, request.params.key, request.params.hash);
    response.set('Content-Security-Policy', 'sandbox').set('X-Content-Type-Options', 'nosniff');
    response.type(mime.lookup(name) || 'application/octet-stream').send(bytes);
}));
