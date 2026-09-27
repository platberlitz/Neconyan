import express from 'express';
import { randomUUID } from 'node:crypto';
import { acceptJob, dismissJob, explicitRetryRecovery, getJob, listJobs, requestCancellation, retryConversationFamily, updateJob, validateOwner } from '../jobs/store.js';
import { abortJob, capacity, noteOwner, ownerCount } from '../jobs/runner.js';
import { readArtifact } from '../jobs/artifacts.js';
import { readAudioArtifact } from '../jobs/audio-artifacts.js';
import { roleplayAccountBase, withRoleplayAccount } from '../roleplay-store.js';
import { startOperation } from '../mewmory/operations.js';
import { retryConversationRoot } from '../generation/conversation-jobs.js';
import { retainConversationAutomaticAcceptance } from '../generation/conversation-effects.js';
import { decideJobApproval, readJobApproval } from '../generation/job-approvals.js';

export const router = express.Router();

function directoriesFor(request) {
    // Validate before any path is built from the handle, so a malformed handle
    // can never select another account's directory.
    const owner = validateOwner(request.user?.profile?.handle);
    const expected = request.get('X-Neconyan-Account');
    if (expected !== undefined && expected !== owner) {
        throw Object.assign(new Error('account_changed'), { status: 409 });
    }
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

router.get('/:id/audio/:name', (request, response) => {
    try {
        const { owner, directories } = directoriesFor(request);
        const job = getJob(directories, request.params.id);
        if (!job || job.owner !== owner) return response.status(404).json({ error: 'No such job.' });
        const base = roleplayAccountBase(directories);
        const read = () => readAudioArtifact(directories, job.id, request.params.name);
        const account = job.intent?.request?.account ?? job.intent?.media ?? job.intent?.roleplay
            ?? (job.type === 'conversation.participant' ? readArtifact(directories, job.id, 'request')?.speechAccount : null);
        const artifact = base ? withRoleplayAccount(base, account, read) : read();
        if (typeof artifact?.base64 !== 'string' || !/^audio\/[a-z0-9.+-]+$/i.test(artifact?.mimeType || '')) {
            return response.status(404).json({ error: 'No such audio.' });
        }
        response.set('X-Content-Type-Options', 'nosniff');
        response.type(artifact.mimeType);
        return response.send(Buffer.from(artifact.base64, 'base64'));
    } catch (error) {
        return fail(response, error);
    }
});

router.get('/:id/approval/:approval', (request, response) => {
    try {
        const { owner, directories } = directoriesFor(request);
        const job = getJob(directories, request.params.id);
        if (!job || job.owner !== owner) return response.status(404).json({ error: 'No such job.' });
        return response.json(readJobApproval({ owner, directories, job }, request.params.approval));
    } catch (error) { return fail(response, error); }
});

router.post('/:id/approval/:approval', (request, response) => {
    try {
        const { owner, directories } = directoriesFor(request);
        const job = getJob(directories, request.params.id);
        if (!job || job.owner !== owner) return response.status(404).json({ error: 'No such job.' });
        return response.json(decideJobApproval({ owner, directories, job }, { id: request.params.approval,
            proposalHash: request.body?.proposalHash, decision: request.body?.decision }));
    } catch (error) { return fail(response, error); }
});

// Source-bound work needs native preparation and permanent acceptance receipts.
// The generic route cannot create that authority from browser-supplied intent.
const RESERVED_JOB_TYPES = new Set(['conversation.reply', 'conversation.participant', 'conversation.summary', 'conversation.schedule',
    'conversation.rewrite', 'conversation.selfie', 'meower.refresh', 'meower.profile']);

router.post('/submit', (request, response) => {
    try {
        const { owner, directories } = directoriesFor(request);
        const body = request.body ?? {};
        if (RESERVED_JOB_TYPES.has(body.type) || /^(media|roleplay|meower|labs|operations)\./.test(String(body.type))) {
            return response.status(400).json({ error: 'This job type requires its native acceptance endpoint.' });
        }
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

router.post('/:id/cancel', async (request, response) => {
    try {
        const { owner, directories } = directoriesFor(request);
        const job = getJob(directories, request.params.id);
        if (!job || job.owner !== owner) return response.status(404).json({ error: 'No such job.' });
        await retainConversationAutomaticAcceptance(request, job);
        const requested = requestCancellation(directories, job.id, { reason: request.body?.reason ?? null });
        // A reply may own retrieval work below a workflow child. Stop every
        // owned controller after the complete cancellation is durable.
        const pending = [requested.job.id];
        const visited = new Set();
        for (const id of pending) {
            if (visited.has(id)) continue;
            visited.add(id);
            const current = getJob(directories, id);
            if (!current || current.owner !== owner) continue;
            pending.push(...(current.children ?? []));
            abortJob(id);
        }
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
        if (job.type === 'conversation.reply' && (job.children ?? []).length) {
            return response.json({ job: retryConversationFamily(directories, job.id).job });
        }
        if (job.type === 'conversation.reply' && job.intent?.mode === 'auto' && readArtifact(directories, job.id, 'request') === undefined) {
            return response.json({ job: await retryConversationRoot(request, job) });
        }
        if (job.error?.status === 409 && ['mewmory.index', 'mewmory.recall'].includes(job.type)) {
            const accepted = await startOperation(directories, owner, job.type.split('.')[1], {
                ...job.intent, reset: false, submissionKey: randomUUID(),
            });
            return response.json(accepted);
        }
        return response.json({ job: updateJob(directories, job.id, current => ({ state: 'queued', finishedAt: null, error: null, dismissed: false, ...explicitRetryRecovery(current) })).job });
    } catch (error) {
        return fail(response, error);
    }
});
