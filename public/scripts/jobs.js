/**
 * Browser observer for server-owned jobs. It never runs generation, schedules
 * work or performs workflow effects: it submits an intent, then reads the
 * authoritative saved snapshot. Polling is the fallback transport; a streaming
 * transport can be added later without changing this contract.
 */
import { getRequestHeaders } from '../script.js';

const DEFAULT_INTERVAL_MS = 1500;
const MAX_INTERVAL_MS = 15000;

function endpoint(base, suffix) {
    return `${base}/api/jobs${suffix}`;
}

async function requestJson(url, options = {}) {
    const { headers: extra, ...rest } = options;
    const headers = { ...getRequestHeaders(), ...(extra ?? {}) };
    const response = await fetch(url, { credentials: 'same-origin', headers, ...rest });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) {
        const error = new Error(body?.error ?? `Job request failed with ${response.status}.`);
        error.status = response.status;
        error.body = body;
        throw error;
    }
    return body;
}

export async function submitJob({ type, intent, submissionKey, target = null, label = null, mutating = true, automatic = false, base = '' }) {
    if (!type || intent === undefined || !submissionKey) throw new Error('A job needs a type, an intent and a submission key.');
    return requestJson(endpoint(base, '/submit'), {
        method: 'POST',
        body: JSON.stringify({ type, intent, submissionKey, target, label, mutating, automatic }),
    });
}

export async function listJobs({ base = '', includeDismissed = false } = {}) {
    const body = await requestJson(endpoint(base, `/list?includeDismissed=${includeDismissed}`));
    return body?.jobs ?? [];
}

export async function getJob(id, { base = '' } = {}) {
    return requestJson(endpoint(base, `/${encodeURIComponent(id)}`));
}

export async function cancelJob(id, { base = '', reason = null } = {}) {
    return requestJson(endpoint(base, `/${encodeURIComponent(id)}/cancel`), { method: 'POST', body: JSON.stringify({ reason }) });
}

export async function dismissJob(id, { base = '' } = {}) {
    return requestJson(endpoint(base, `/${encodeURIComponent(id)}/dismiss`), { method: 'POST', body: JSON.stringify({}) });
}

export async function retryJob(id, { base = '' } = {}) {
    return requestJson(endpoint(base, `/${encodeURIComponent(id)}/retry`), { method: 'POST', body: '{}' });
}

const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'conflict']);

/**
 * Observe a job until it reaches a terminal state. onUpdate receives the
 * authoritative job snapshot on every change. Stop observing with the returned
 * function; that is not cancellation.
 */
export function observeJob(id, { onUpdate, base = '', intervalMs = DEFAULT_INTERVAL_MS, signal } = {}) {
    let stopped = false;
    let timer = null;
    let delay = intervalMs;
    let previous = null;

    const stop = () => { stopped = true; if (timer) clearTimeout(timer); };

    const schedule = () => { if (!stopped) timer = setTimeout(tickOnce, delay); };

    const tickOnce = async () => {
        if (stopped) return;
        try {
            const body = await getJob(id, { base });
            const job = body?.job ?? null;
            if (job && JSON.stringify(job) !== JSON.stringify(previous)) {
                previous = job;
                onUpdate?.(job);
            }
            if (job && TERMINAL.has(job.state)) { stop(); return; }
            delay = Math.min(MAX_INTERVAL_MS, Math.round(delay * 1.3));
        } catch {
            delay = Math.min(MAX_INTERVAL_MS, Math.round(delay * 1.5));
        }
        schedule();
    };

    if (signal) signal.addEventListener('abort', stop, { once: true });
    void tickOnce();
    return stop;
}
