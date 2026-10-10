import { getRequestHeaders } from '../../script.js';
import { getCurrentUserHandle } from '../user.js';

const BASE = '/api/scratchpad';
const unconfirmedSends = new Map();
const MAX_UNCONFIRMED_SENDS = 32;

export class ScratchpadRequestError extends Error {
    constructor(message, { status = 0, code = '', network = false } = {}) {
        super(message);
        this.name = 'ScratchpadRequestError';
        this.status = status;
        this.code = code;
        this.network = network;
    }
}

export function newSubmissionKey() {
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `scratchpad:${id}`.replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 120);
}

function headers() {
    return {
        ...getRequestHeaders(),
        'Content-Type': 'application/json',
        'X-Neconyan-Account': getCurrentUserHandle(),
    };
}

async function post(path, body, { signal } = {}) {
    let response;
    try {
        response = await fetch(`${BASE}${path}`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(body ?? {}),
            cache: 'no-store',
            signal,
        });
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new ScratchpadRequestError('Scratchpad could not reach the server. Check your connection and try again.', { network: true });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        throw new ScratchpadRequestError(payload?.message || `Scratchpad request failed (${response.status}).`, {
            status: response.status,
            code: payload?.code || '',
        });
    }
    return payload ?? {};
}

export const readBucket = (source, options) => post('/bucket', { source }, options);
export const readNotebookContext = (source, sessionId) => post('/notes/context', { source, sessionId });
export const readNotebookProposal = (source, sessionId, messageId, index) => post('/notes/proposal', { source, sessionId, messageId, index });
export const decideNotebookProposal = (source, sessionId, messageId, index, proposalHash, decision) => post('/notes/decide', { source, sessionId, messageId, index, proposalHash, decision });
export const readPrompt = body => post('/prompt', body);
export const createSession = (source, input) => post('/session/create', { source, ...input });
export const importSession = (source, session) => post('/session/import', { source, session });
export const updateSession = (source, sessionId, changes) => post('/session/update', { source, sessionId, changes });
export const deleteSession = (source, sessionId) => post('/session/delete', { source, sessionId });
export const activateSession = (source, sessionId) => post('/session/activate', { source, sessionId });
export const updateCleanup = (source, cleanup) => post('/cleanup', { source, cleanup });
export const clearSession = (source, sessionId) => post('/session/clear', { source, sessionId });
export const updateMessage = (source, sessionId, messageId, text) => post('/message/update', { source, sessionId, messageId, text });
export const deleteMessage = (source, sessionId, messageId) => post('/message/delete', { source, sessionId, messageId });
export const markProposal = (source, sessionId, messageId, index, state) => post('/proposal/mark', { source, sessionId, messageId, index, state });
/** Retry an uncertain acceptance with its original identity and context. */
export async function sendReply(body) {
    const key = JSON.stringify([getCurrentUserHandle(), body.source?.kind, body.source?.key, body.sessionId, body.regenerate || '', body.text || '']);
    let request = unconfirmedSends.get(key);
    if (!request) {
        if (unconfirmedSends.size >= MAX_UNCONFIRMED_SENDS) {
            throw new ScratchpadRequestError('Several replies could not be confirmed. Reload the page and check those sessions before sending more.');
        }
        request = structuredClone(body);
        unconfirmedSends.set(key, request);
    }
    const forget = () => {
        if (unconfirmedSends.get(key) === request) unconfirmedSends.delete(key);
    };
    try {
        const result = await post('/send', request);
        if (!result?.job?.id || !result?.bucket) {
            throw new ScratchpadRequestError('Scratchpad could not confirm the reply. Try sending again to check the original request.', { network: true });
        }
        forget();
        return result;
    } catch (error) {
        if (error.status >= 400 && error.status < 500) forget();
        throw error;
    }
}

export async function cancelReply(jobId) {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ reason: 'Stopped from Scratchpad.' }),
        cache: 'no-store',
    }).catch(() => null);
    return Boolean(response?.ok);
}

/**
 * Follows the live text of one reply. Calls onPreview with { stage, text, reasoning }
 * and onDone with { state, error } once the reply settles. Returns a stop function.
 */
export function watchReply(jobId, { onPreview, onDone } = {}) {
    const controller = new AbortController();
    let finished = false;
    const finish = value => {
        if (finished) return;
        finished = true;
        onDone?.(value);
    };
    (async () => {
        try {
            const response = await fetch(`${BASE}/preview/${encodeURIComponent(jobId)}`, {
                headers: headers(),
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!response.ok || !response.body) {
                finish({ state: 'unknown' });
                return;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let split;
                while ((split = buffer.indexOf('\n\n')) >= 0) {
                    const frame = buffer.slice(0, split);
                    buffer = buffer.slice(split + 2);
                    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
                    if (!data) continue;
                    let event;
                    try {
                        event = JSON.parse(data);
                    } catch {
                        continue;
                    }
                    if (event.preview) onPreview?.(event.preview);
                    else if (event.stage) onPreview?.(event);
                    if (event.state) finish(event);
                }
            }
            finish({ state: 'unknown' });
        } catch (error) {
            if (error?.name !== 'AbortError') finish({ state: 'unknown' });
        }
    })();
    return () => {
        finished = true;
        controller.abort();
    };
}
