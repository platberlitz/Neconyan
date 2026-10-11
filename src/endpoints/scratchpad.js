import express from 'express';
import { getJob } from '../jobs/store.js';
import {
    activateSession,
    clearSession,
    createSession,
    findSession,
    deleteMessage,
    deleteSession,
    markProposal,
    mutateBucket,
    normaliseSource,
    projectPending,
    publicBucket,
    readBucketLocked,
    requireId,
    scratchpadAccountBase,
    updateCleanupLocked,
    updateMessage,
    updateSession,
    withScratchpad,
} from '../scratchpad/store.js';
import { SCRATCHPAD_JOB_TYPE, acceptScratchpadReply } from '../scratchpad/jobs.js';
import { readScratchpadPreview, subscribeScratchpadPreview } from '../scratchpad/preview.js';
import { buildScratchpadSystemPrompt } from '../scratchpad/prompt.js';
import { readInstructionsLocked, updateInstructionsLocked } from '../scratchpad/instructions.js';
import { assistantPortrait, deleteAssistantLocked, readAssistantCardLocked, readAssistantsLocked, refreshSessionAssistants, resolveAssistant, saveAssistantLocked } from '../scratchpad/assistants.js';
import { normaliseAssistantProfile } from '../scratchpad/assistant-profiles.js';
import { notebookContextLocked, withNotebookPreparation, prepareNotebookProposalLocked, decideNotebookProposalLocked,
    projectNotebookProposalsLocked, notifyScratchpadNotebookResult } from '../scratchpad/notebooks.js';

export const router = express.Router();

const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'conflict']);

function sendError(response, error) {
    if (response.headersSent) return;
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500 && status !== 503) console.warn('Scratchpad request failed:', error);
    response.status(status).json({
        status,
        code: error?.code || 'SCRATCHPAD_FAILED',
        message: status >= 500 && status !== 503 && !error?.code?.startsWith?.('SCRATCHPAD_') ? 'Scratchpad could not finish that request.' : (error?.message || 'Scratchpad could not finish that request.'),
    });
}

/** Run one change against the chat's Scratchpad and answer with the saved state. */
function change(request, response, operation) {
    try {
        const base = scratchpadAccountBase(request);
        const source = normaliseSource(request.body?.source);
        const bucket = mutateBucket(base, source, (bucket, lease) => {
            projectPending(bucket, id => getJob(base.directories, id));
            operation(bucket, request.body ?? {}, lease);
            return bucket;
        });
        response.json({ bucket: publicBucket(bucket) });
    } catch (error) {
        sendError(response, error);
    }
}

router.post('/bucket', (request, response) => {
    try {
        const base = scratchpadAccountBase(request);
        const source = normaliseSource(request.body?.source);
        const bucket = withScratchpad(base, lease => projectNotebookProposalsLocked(lease, readBucketLocked(lease, source)));
        response.json({ bucket: publicBucket(projectPending(bucket, id => getJob(base.directories, id))) });
    } catch (error) {
        sendError(response, error);
    }
});

function sessionSettings(lease, input, assistant) {
    const settings = { ...input };
    const library = readAssistantsLocked(lease);
    const snapshots = { ...settings.assistants };
    for (const id of [assistant, ...(settings.participants ?? [])]) {
        const profile = resolveAssistant(library, id, snapshots);
        if (profile) snapshots[id] = profile;
    }
    return { ...settings, assistants: snapshots };
}

router.post('/session/create', (request, response) => change(request, response, (bucket, body, lease) => {
    const previous = bucket.sessions.find(item => item.id === bucket.activeSessionId);
    const session = createSession(bucket, { assistant: body.assistant, gender: body.gender, name: body.name, temporary: body.temporary,
        settings: sessionSettings(lease, { assistants: previous?.settings.assistants, ...body.settings }, body.assistant) });
    // New sessions inherit the previous session's copies; drop the ones the library can supply again, so copies do not pile up towards the session limit.
    const saved = new Set(readAssistantsLocked(lease).assistants.map(item => item.id));
    const used = new Set([session.assistant, ...session.settings.participants]);
    for (const id of Object.keys(session.settings.assistants)) {
        if (saved.has(id) && !used.has(id)) delete session.settings.assistants[id];
    }
}));

router.post('/assistants', (request, response) => {
    try {
        response.json({ library: withScratchpad(scratchpadAccountBase(request), readAssistantsLocked) });
    } catch (error) { sendError(response, error); }
});

router.post('/assistants/save', async (request, response) => {
    try {
        const base = scratchpadAccountBase(request);
        let input = { ...request.body?.assistant };
        if (request.body?.card) {
            const card = withScratchpad(base, lease => readAssistantCardLocked(lease, request.body.card));
            input = { ...card.profile, avatar: await assistantPortrait(card.bytes) };
        } else {
            // Validate encoded size and MIME before decoding any browser-supplied picture.
            normaliseAssistantProfile({ ...input, id: input.id || 'assistant_000000000000000000000000' });
            if (input.avatar) input.avatar = await assistantPortrait(Buffer.from(input.avatar.split(',')[1], 'base64'));
        }
        response.json(withScratchpad(base, lease => saveAssistantLocked(lease, input, request.body?.expectedRevision)));
    } catch (error) { sendError(response, error); }
});

router.post('/assistants/delete', (request, response) => {
    try {
        response.json(withScratchpad(scratchpadAccountBase(request), lease => deleteAssistantLocked(lease, request.body?.id, request.body?.expectedRevision)));
    } catch (error) { sendError(response, error); }
});

router.post('/instructions', (request, response) => {
    try {
        const instructions = withScratchpad(scratchpadAccountBase(request), readInstructionsLocked);
        response.json({ instructions });
    } catch (error) {
        sendError(response, error);
    }
});

router.post('/instructions/update', (request, response) => {
    try {
        const instructions = withScratchpad(scratchpadAccountBase(request), lease =>
            updateInstructionsLocked(lease, request.body?.instructions, request.body?.expectedRevision));
        response.json({ instructions });
    } catch (error) {
        sendError(response, error);
    }
});

router.post('/prompt', (request, response) => {
    try {
        const base = scratchpadAccountBase(request);
        const body = request.body ?? {};
        const profiles = withScratchpad(base, lease => {
            const library = readAssistantsLocked(lease);
            const session = body.sessionId ? findSession(readBucketLocked(lease, normaliseSource(body.source)), requireId(body.sessionId, 'session')) : null;
            const ids = [body.assistant, ...(Array.isArray(body.participants) ? body.participants.slice(0, 3) : [])];
            return Object.fromEntries(ids.map(id => [id, resolveAssistant(library, id, session?.settings.assistants)]));
        });
        response.json(buildScratchpadSystemPrompt({ assistant: body.assistant, gender: body.gender,
            persona: profiles[body.assistant], assistantNames: Object.fromEntries(Object.entries(profiles).map(([id, profile]) => [id, profile?.name])),
            userName: body.names?.user, characterName: body.names?.character, capabilities: body.capabilities ?? {},
            participants: Array.isArray(body.participants) ? body.participants.slice(0, 3) : [], randomReply: body.randomReply === true }));
    } catch (error) {
        sendError(response, error);
    }
});

router.post('/session/import', (request, response) => change(request, response, (bucket, body, lease) => {
    const session = body.session && typeof body.session === 'object' ? body.session : {};
    const settings = { ...session.settings, notes: [], picked: [], pickedSource: null };
    const imported = createSession(bucket, { assistant: session.assistant, gender: session.gender, name: session.name, settings,
        messages: Array.isArray(session.messages) ? session.messages : [] });
    refreshSessionAssistants(imported, readAssistantsLocked(lease));
}));

router.post('/session/update', (request, response) => change(request, response, (bucket, body, lease) => {
    const session = findSession(bucket, requireId(body.sessionId, 'session'));
    const changes = body.changes ?? {};
    const settings = sessionSettings(lease, { ...session.settings, ...changes.settings }, changes.assistant ?? session.assistant);
    updateSession(bucket, session.id, { ...changes, settings });
    refreshSessionAssistants(session, readAssistantsLocked(lease));
}));

router.post('/session/delete', (request, response) => change(request, response, (bucket, body) => {
    deleteSession(bucket, requireId(body.sessionId, 'session'));
}));

router.post('/cleanup', (request, response) => change(request, response, (bucket, body, lease) => {
    updateCleanupLocked(lease, body.cleanup);
}));

router.post('/session/activate', (request, response) => change(request, response, (bucket, body) => {
    activateSession(bucket, requireId(body.sessionId, 'session'));
}));

router.post('/session/clear', (request, response) => change(request, response, (bucket, body) => {
    clearSession(bucket, requireId(body.sessionId, 'session'));
}));

router.post('/message/update', (request, response) => change(request, response, (bucket, body) => {
    updateMessage(bucket, requireId(body.sessionId, 'session'), requireId(body.messageId, 'message'), body.text);
}));

router.post('/message/delete', (request, response) => change(request, response, (bucket, body) => {
    deleteMessage(bucket, requireId(body.sessionId, 'session'), requireId(body.messageId, 'message'));
}));

router.post('/proposal/mark', (request, response) => change(request, response, (bucket, body) => {
    markProposal(bucket, requireId(body.sessionId, 'session'), requireId(body.messageId, 'message'), body.index, body.state ?? null);
}));

router.post('/notes/context', async (request, response) => {
    try {
        const base = scratchpadAccountBase(request);
        const body = request.body ?? {};
        const source = normaliseSource(body.source);
        const context = await withNotebookPreparation(base, lease => {
            const bucket = readBucketLocked(lease, source);
            const settings = body.sessionId ? findSession(bucket, requireId(body.sessionId, 'session')).settings : { notes: [] };
            return notebookContextLocked(lease, settings);
        });
        response.json(context);
    } catch (error) { sendError(response, error); }
});

for (const decision of [false, true]) {
    router.post(decision ? '/notes/decide' : '/notes/proposal', async (request, response) => {
        try {
            const base = scratchpadAccountBase(request);
            const body = request.body ?? {};
            const source = normaliseSource(body.source);
            requireId(body.sessionId, 'session');
            requireId(body.messageId, 'message');
            const result = await withNotebookPreparation(base, lease => decision
                ? decideNotebookProposalLocked(lease, source, body, { kind: 'user', handle: base.owner })
                : prepareNotebookProposalLocked(lease, source, body));
            notifyScratchpadNotebookResult(base, result);
            response.json({ ...result, bucket: publicBucket(result.bucket) });
        } catch (error) { sendError(response, error); }
    });
}

router.post('/send', async (request, response) => {
    try {
        const { created, job, bucket } = await acceptScratchpadReply(request, request.body ?? {});
        response.status(created ? 202 : 200).json({ job, bucket });
    } catch (error) {
        sendError(response, error);
    }
});

router.get('/preview/:id', (request, response) => {
    try {
        const base = scratchpadAccountBase(request);
        const job = getJob(base.directories, String(request.params.id || ''));
        if (!job || job.owner !== base.owner || job.type !== SCRATCHPAD_JOB_TYPE) return response.sendStatus(404);
        response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
        const send = value => {
            if (response.destroyed || response.writableEnded) return;
            if (response.writableLength > 1024 * 1024) { response.end(); return; }
            try { response.write(`data: ${JSON.stringify(value)}\n\n`); } catch { response.end(); }
        };
        let nextPreview = null;
        let previewTimer = null;
        const flush = () => {
            clearTimeout(previewTimer);
            previewTimer = null;
            if (nextPreview) send({ preview: nextPreview });
            nextPreview = null;
        };
        const unsubscribe = subscribeScratchpadPreview(base.owner, job.id, preview => {
            nextPreview = preview;
            if (!previewTimer) previewTimer = setTimeout(flush, 50);
        });
        send({ preview: readScratchpadPreview(base.owner, job.id) ?? { stage: job.state === 'running' ? 'generating' : 'queued', text: '', reasoning: '' } });
        const check = () => {
            try {
                const current = getJob(base.directories, job.id);
                if (!current || TERMINAL.has(current.state)) {
                    flush();
                    send({ state: current?.state ?? 'missing', error: current?.error?.message ?? null });
                    response.end();
                } else {
                    response.write(': keepalive\n\n');
                }
            } catch {
                response.end();
            }
        };
        const timer = setInterval(check, 1000);
        const cleanup = () => { clearInterval(timer); clearTimeout(previewTimer); unsubscribe(); };
        request.once('aborted', cleanup);
        response.once('finish', cleanup);
        response.once('close', cleanup);
        check();
    } catch (error) {
        sendError(response, error);
    }
});
