/**
 * Browser observer for server-owned jobs. It never runs generation, schedules
 * work or performs workflow effects: it submits an intent, then reads the
 * authoritative saved snapshot. A shared stream announces saved changes;
 * polling remains the fallback when streaming is unavailable.
 */
import { getRequestHeaders } from '../script.js';
import { getCurrentUserHandle } from './user.js';

const DEFAULT_INTERVAL_MS = 1500;
const MAX_INTERVAL_MS = 15000;
const changeStreams = new Map();

function subscribeJobChanges(base, account, listener) {
    const key = JSON.stringify([base, account]);
    let stream = changeStreams.get(key);
    if (!stream) {
        const controller = new AbortController();
        stream = { controller, listeners: new Set(), connected: false };
        changeStreams.set(key, stream);
        const notify = () => {
            for (const callback of stream.listeners) callback();
        };
        void (async () => {
            let reader;
            try {
                checkAccount(account);
                const response = await fetch(endpoint(base, '/events'), {
                    credentials: 'same-origin', signal: controller.signal,
                    headers: { ...getRequestHeaders(), 'X-Neconyan-Account': account, Accept: 'text/event-stream' },
                });
                checkAccount(account);
                if (!response.ok || !response.headers?.get('content-type')?.includes('text/event-stream') || !response.body?.getReader) {
                    await response.body?.cancel?.();
                    return;
                }
                stream.connected = true;
                reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                while (!controller.signal.aborted) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    checkAccount(account);
                    buffer += decoder.decode(value, { stream: true });
                    let boundary;
                    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                        const frame = buffer.slice(0, boundary);
                        buffer = buffer.slice(boundary + 2);
                        if (frame.startsWith('data:')) notify();
                    }
                    if (buffer.length > 4096) throw new Error('Invalid job change stream.');
                }
            } catch { /* Polling reads back saved state after a disconnect or unsupported stream. */ } finally {
                const shouldRefresh = stream.connected && !controller.signal.aborted;
                stream.connected = false;
                controller.abort();
                reader?.releaseLock();
                if (shouldRefresh) notify();
            }
        })();
    }
    stream.listeners.add(listener);
    return {
        connected: () => stream.connected,
        stop: () => {
            stream.listeners.delete(listener);
            if (!stream.listeners.size) {
                stream.controller.abort();
                changeStreams.delete(key);
            }
        },
    };
}

function endpoint(base, suffix) {
    return `${base}/api/jobs${suffix}`;
}

async function requestJson(url, options = {}) {
    const { headers: extra, account = getCurrentUserHandle(), ...rest } = options;
    checkAccount(account);
    const headers = { ...getRequestHeaders(), ...(extra ?? {}), 'X-Neconyan-Account': account };
    const response = await fetch(url, { credentials: 'same-origin', headers, ...rest });
    const text = await response.text();
    checkAccount(account);
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

function checkAccount(account) {
    if (account !== getCurrentUserHandle()) throw new Error('account_changed');
}

export async function submitJob({ type, intent, submissionKey, target = null, label = null, mutating = true, automatic = false, base = '', account = getCurrentUserHandle() }) {
    if (!type || intent === undefined || !submissionKey) throw new Error('A job needs a type, an intent and a submission key.');
    return requestJson(endpoint(base, '/submit'), {
        method: 'POST',
        account,
        body: JSON.stringify({ type, intent, submissionKey, target, label, mutating, automatic }),
    });
}

export async function listJobs({ base = '', includeDismissed = false, account = getCurrentUserHandle() } = {}) {
    const body = await requestJson(endpoint(base, `/list?includeDismissed=${includeDismissed}`), { account });
    return body?.jobs ?? [];
}

export async function getJob(id, { base = '', account = getCurrentUserHandle() } = {}) {
    return requestJson(endpoint(base, `/${encodeURIComponent(id)}`), { account });
}

export async function cancelJob(id, { base = '', reason = null, account = getCurrentUserHandle() } = {}) {
    return requestJson(endpoint(base, `/${encodeURIComponent(id)}/cancel`), { account, method: 'POST', body: JSON.stringify({ reason }) });
}

export async function dismissJob(id, { base = '', account = getCurrentUserHandle() } = {}) {
    return requestJson(endpoint(base, `/${encodeURIComponent(id)}/dismiss`), { account, method: 'POST', body: JSON.stringify({}) });
}

export async function retryJob(id, { base = '', account = getCurrentUserHandle() } = {}) {
    return requestJson(endpoint(base, `/${encodeURIComponent(id)}/retry`), { account, method: 'POST', body: '{}' });
}

export const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'conflict']);

/**
 * Observe a job until it reaches a terminal state. onUpdate receives the
 * authoritative job snapshot on every change; onSnapshot receives it on every
 * successful poll, because individual native effects do not necessarily change
 * the root job. Stop observing with the returned function; that is not
 * cancellation.
 */
export function observeJob(id, { onUpdate, onSnapshot, onDone, onStop, base = '', account = getCurrentUserHandle(), intervalMs = DEFAULT_INTERVAL_MS, signal } = {}) {
    let stopped = false;
    let timer = null;
    let delay = intervalMs;
    let previous = null;
    let changes = null;
    let reading = false;
    let dirty = false;

    // stop(reason) tells the caller why polling ended; 'missing' means the job
    // record was pruned before a terminal snapshot could be read back.
    const stop = (reason = 'stopped') => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        changes?.stop();
        signal?.removeEventListener('abort', onAbort);
        onStop?.(reason);
    };

    const onAbort = () => stop('aborted');

    const schedule = () => {
        if (!stopped && !signal?.aborted) timer = setTimeout(tickOnce, dirty ? 0 : delay);
    };
    const changed = () => {
        dirty = true;
        if (stopped || reading) return;
        if (timer) clearTimeout(timer);
        schedule();
    };

    const tickOnce = async () => {
        if (stopped || signal?.aborted) return;
        if (reading) { dirty = true; return; }
        reading = true;
        dirty = false;
        try {
            const body = await getJob(id, { base, account });
            if (stopped || signal?.aborted) return;
            const job = body?.job ?? null;
            if (job) {
                if (JSON.stringify(job) !== JSON.stringify(previous)) {
                    previous = job;
                    await onUpdate?.(job);
                }
                checkAccount(account);
                if (stopped || signal?.aborted) return;
                await onSnapshot?.(job);
                checkAccount(account);
                if (stopped || signal?.aborted) return;
                // A terminal job stops the job poll, but a failed readback must
                // still be retried, so only stop once the snapshot succeeded.
                if (TERMINAL.has(job.state)) { stop('done'); await onDone?.(job); return; }
                changes ??= subscribeJobChanges(base, account, changed);
            }
            delay = changes?.connected() ? MAX_INTERVAL_MS : intervalMs;
        } catch (error) {
            if (error.message === 'account_changed') { stop('account_changed'); return; }
            // A job record that no longer exists can never complete, so retrying
            // it forever only leaks an observer and blocks callers that wait on it.
            if (error.status === 404) { stop('missing'); return; }
            delay = Math.min(MAX_INTERVAL_MS, Math.round(delay * 1.5));
        } finally {
            reading = false;
            schedule();
        }
    };

    if (signal?.aborted) return stop;
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    void tickOnce();
    return stop;
}
