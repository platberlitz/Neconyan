import express from 'express';
import { getJob } from '../jobs/store.js';
import {
    activateSession,
    clearSession,
    createSession,
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
    updateMessage,
    updateSession,
    withScratchpad,
} from '../scratchpad/store.js';
import { SCRATCHPAD_JOB_TYPE, acceptScratchpadReply } from '../scratchpad/jobs.js';
import { readScratchpadPreview, subscribeScratchpadPreview } from '../scratchpad/preview.js';

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
        const bucket = mutateBucket(base, source, bucket => {
            projectPending(bucket, id => getJob(base.directories, id));
            operation(bucket, request.body ?? {});
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
        const bucket = withScratchpad(base, lease => readBucketLocked(lease, source));
        response.json({ bucket: publicBucket(projectPending(bucket, id => getJob(base.directories, id))) });
    } catch (error) {
        sendError(response, error);
    }
});

router.post('/session/create', (request, response) => change(request, response, (bucket, body) => {
    createSession(bucket, { assistant: body.assistant, gender: body.gender, name: body.name, temporary: body.temporary, settings: body.settings });
}));

router.post('/session/import', (request, response) => change(request, response, (bucket, body) => {
    const session = body.session && typeof body.session === 'object' ? body.session : {};
    createSession(bucket, { assistant: session.assistant, gender: session.gender, name: session.name, settings: session.settings,
        messages: Array.isArray(session.messages) ? session.messages : [] });
}));

router.post('/session/update', (request, response) => change(request, response, (bucket, body) => {
    updateSession(bucket, requireId(body.sessionId, 'session'), body.changes ?? {});
}));

router.post('/session/delete', (request, response) => change(request, response, (bucket, body) => {
    deleteSession(bucket, requireId(body.sessionId, 'session'));
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
        response.once('close', () => { clearInterval(timer); clearTimeout(previewTimer); unsubscribe(); });
        check();
    } catch (error) {
        sendError(response, error);
    }
});
