/**
 * Browser observer for server-owned jobs. It never runs generation, schedules
 * work or performs workflow effects: it submits an intent, then reads the
 * authoritative saved snapshot. Polling is the fallback transport; a streaming
 * transport can be added later without changing this contract.
 */
import { getRequestHeaders } from '../script.js';
import { getCurrentUserHandle } from './user.js';

const DEFAULT_INTERVAL_MS = 1500;
const MAX_INTERVAL_MS = 15000;

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

    // stop(reason) tells the caller why polling ended; 'missing' means the job
    // record was pruned before a terminal snapshot could be read back.
    const stop = (reason = 'stopped') => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        onStop?.(reason);
    };

    const onAbort = () => stop('aborted');

    const schedule = () => { if (!stopped && !signal?.aborted) timer = setTimeout(tickOnce, delay); };

    const tickOnce = async () => {
        if (stopped || signal?.aborted) return;
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
            }
            delay = Math.min(MAX_INTERVAL_MS, Math.round(delay * 1.3));
        } catch (error) {
            if (error.message === 'account_changed') { stop('account_changed'); return; }
            // A job record that no longer exists can never complete, so retrying
            // it forever only leaks an observer and blocks callers that wait on it.
            if (error.status === 404) { stop('missing'); return; }
            delay = Math.min(MAX_INTERVAL_MS, Math.round(delay * 1.5));
        }
        schedule();
    };

    if (signal?.aborted) return stop;
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    void tickOnce();
    return stop;
}
