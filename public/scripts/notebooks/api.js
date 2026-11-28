import { getRequestHeaders } from '../../script.js';
import { getCurrentUserHandle } from '../user.js';

const BASE = '/api/notebooks';

export function newOperationId(prefix = 'ui') {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `${prefix}:${random}`.replace(/[^A-Za-z0-9:_.-]/g, '').slice(0, 120);
}

function accountHeaders(extra = {}) {
    return { ...extra, 'X-Neconyan-Account': getCurrentUserHandle() };
}

async function parse(response) {
    let body = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }
    if (body && typeof body.status === 'string') return { ...body, http: response.status };
    if (response.ok && body && typeof body === 'object' && !Array.isArray(body)) return { ...body, status: 'success', http: response.status };
    return {
        status: response.ok ? 'success' : 'failure',
        http: response.status,
        message: response.ok ? '' : `Notes could not be reached (${response.status}).`,
    };
}

export async function notesRequest(route, body = {}, { signal } = {}) {
    try {
        const response = await fetch(`${BASE}${route}`, {
            method: 'POST',
            headers: accountHeaders({ ...getRequestHeaders(), 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
            signal,
        });
        return await parse(response);
    } catch (error) {
        if (error?.name === 'AbortError') return { status: 'cancelled', network: true, message: 'Cancelled.' };
        return { status: 'failure', network: true, message: 'Notes could not be reached. Check your connection.' };
    }
}

export async function notesUpload(route, fields, file) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    form.append('avatar', file, file.name);
    try {
        const response = await fetch(`${BASE}${route}`, {
            method: 'POST',
            headers: accountHeaders(getRequestHeaders({ omitContentType: true })),
            body: form,
        });
        return await parse(response);
    } catch {
        return { status: 'failure', network: true, message: 'The upload could not reach Notes.' };
    }
}

export async function notesDownload(route, body) {
    const response = await fetch(`${BASE}${route}`, {
        method: 'POST',
        headers: accountHeaders({ ...getRequestHeaders(), 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
    });
    if (!response.ok) return { status: 'failure', ...(await parse(response)) };
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const match = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/i.exec(disposition);
    const filename = match ? decodeURIComponent(match[1] ?? match[2]) : 'notebook.zip';
    return { status: 'success', blob: await response.blob(), filename };
}

export function attachmentUrl(notebookId, relative) {
    const query = new URLSearchParams({ notebookId, path: relative });
    return `${BASE}/attachments/file?${query}`;
}

// Neconyan: a stream that keeps failing is retried after 5 s, 10 s, 20 s and so on, up to five minutes,
// each wait shortened at random by up to half so open tabs do not reconnect together. A hidden or
// offline page waits instead, and showing it again or coming back online reconnects at once.
const EVENTS_RETRY_MS = 5000;
const EVENTS_RETRY_MAX_MS = 5 * 60 * 1000;

export function subscribeNotes(listener) {
    if (typeof EventSource !== 'function') return () => {};
    let source = null;
    let closed = false;
    let retry = null;
    let failures = 0;
    const paused = () => globalThis.document?.visibilityState === 'hidden' || globalThis.navigator?.onLine === false;
    const open = () => {
        retry = null;
        if (closed || source || paused()) return;
        source = new EventSource(`${BASE}/events`);
        source.onopen = () => {
            failures = 0;
        };
        source.onmessage = event => {
            try {
                const change = JSON.parse(event.data);
                if (change && typeof change === 'object' && change.notebookId) listener(change);
            } catch {
                /* ignore malformed keepalives */
            }
        };
        source.onerror = () => {
            source?.close();
            source = null;
            if (closed) return;
            const ceiling = Math.min(EVENTS_RETRY_MAX_MS, EVENTS_RETRY_MS * 2 ** failures++);
            retry = setTimeout(open, Math.round(ceiling * (1 - Math.random() / 2)));
        };
    };
    const wake = () => {
        if (closed || source || paused()) return;
        clearTimeout(retry);
        open();
    };
    globalThis.document?.addEventListener?.('visibilitychange', wake);
    globalThis.window?.addEventListener?.('online', wake);
    open();
    return () => {
        closed = true;
        clearTimeout(retry);
        source?.close();
        source = null;
        globalThis.document?.removeEventListener?.('visibilitychange', wake);
        globalThis.window?.removeEventListener?.('online', wake);
    };
}
