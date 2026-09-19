import express from 'express';
import { randomUUID } from 'node:crypto';
import { acceptJob, dismissJob, getJob, listJobs, requestCancellation, updateJob, validateOwner } from '../jobs/store.js';
import { abortJob, capacity, noteOwner, ownerCount } from '../jobs/runner.js';
import { readArtifact } from '../jobs/artifacts.js';
import { startOperation } from '../mewmory/operations.js';

export const router = express.Router();

function directoriesFor(request) {
    // Validate before any path is built from the handle, so a malformed handle
    // can never select another account's directory.
    const owner = validateOwner(request.user?.profile?.handle);
    noteOwner(owner);
    return { owner, directories: request.user.directories };
}

function fail(response, error) {
    return response.status(error.status ?? 500).json({ error: error.message, code: error.code ?? null });
}

router.get('/list', (request, response) => {
    try {
        const { owner, directories } = directoriesFor(request);
        const includeDismissed = request.query?.includeDismissed === 'true';
        return response.json({ jobs: listJobs(directories, { owner, includeDismissed }) });
    } catch (error) {
        return fail(response, error);
    }
});

router.get('/capacity', (request, response) => {
    try {
        const { owner } = directoriesFor(request);
        // Global totals plus the caller's own count only; other account handles
        // and their job counts are not exposed.
        return response.json({ capacity: { ...capacity(), you: ownerCount(owner) } });
    } catch (error) {
        return fail(response, error);
    }
});

router.get('/:id', (request, response) => {
    try {
        const { owner, directories } = directoriesFor(request);
        const job = getJob(directories, request.params.id);
        if (job && job.owner !== owner) return response.status(404).json({ error: 'No such job.' });
        if (!job) return response.status(404).json({ error: 'No such job.' });
        response.set('X-Neconyan-Job', job.id);
        return response.json({ job });
    } catch (error) {
        return fail(response, error);
    }
});

router.get('/:id/result', (request, response) => {
    try {
        const { owner, directories } = directoriesFor(request);
        const job = getJob(directories, request.params.id);
        if (!job || job.owner !== owner) return response.status(404).json({ error: 'No such job.' });
        const result = readArtifact(directories, job.id, 'result');
        if (result === undefined) return response.status(409).json({ error: 'This job has no completed result.' });
        return response.json(result);
    } catch (error) {
        return fail(response, error);
    }
});

router.post('/submit', (request, response) => {
    try {
        const { owner, directories } = directoriesFor(request);
        const body = request.body ?? {};
        const accepted = acceptJob(directories, {
            owner,
            type: body.type,
            mutating: body.mutating,
            submissionKey: body.submissionKey,
            intent: body.intent,
            label: body.label,
            target: body.target,
            config: body.config,
            credentialRef: body.credentialRef,
            automatic: body.automatic,
        });
        response.set('X-Neconyan-Job', accepted.job.id);
        return response.status(accepted.created ? 202 : 200).json({ job: accepted.job, created: accepted.created });
    } catch (error) {
        // The body parser rejects an oversized intent before this handler; the
        // store rejects an intent that would not fit the ledger.
        return fail(response, error);
    }
});

router.post('/:id/cancel', (request, response) => {
    try {
        const { owner, directories } = directoriesFor(request);
        const job = getJob(directories, request.params.id);
        if (!job || job.owner !== owner) return response.status(404).json({ error: 'No such job.' });
        const requested = requestCancellation(directories, job.id, { reason: request.body?.reason ?? null });
        abortJob(job.id);
        return response.json({ job: requested.job });
    } catch (error) {
        return fail(response, error);
    }
});

router.post('/:id/dismiss', (request, response) => {
    try {
        const { owner, directories } = directoriesFor(request);
        const job = getJob(directories, request.params.id);
        if (!job || job.owner !== owner) return response.status(404).json({ error: 'No such job.' });
        return response.json({ job: dismissJob(directories, job.id).job });
    } catch (error) {
        return fail(response, error);
    }
});

router.post('/:id/retry', async (request, response) => {
    try {
        const { owner, directories } = directoriesFor(request);
        const job = getJob(directories, request.params.id);
        if (!job || job.owner !== owner) return response.status(404).json({ error: 'No such job.' });
        if (!['failed', 'interrupted'].includes(job.state)) return response.status(409).json({ error: 'Only failed or interrupted work can be retried.' });
        if (job.error?.status === 409 && ['mewmory.index', 'mewmory.recall'].includes(job.type)) {
            const accepted = await startOperation(directories, owner, job.type.split('.')[1], {
                ...job.intent, reset: false, submissionKey: randomUUID(),
            });
            return response.json(accepted);
        }
        return response.json({ job: updateJob(directories, job.id, { state: 'queued', finishedAt: null, error: null, dismissed: false }).job });
    } catch (error) {
        return fail(response, error);
    }
});
