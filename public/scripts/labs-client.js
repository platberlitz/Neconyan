/** Retained submissions and read-only observation of native Labs work. */
import { fetchWithCsrfRetry } from './csrf-token-refresh.js';

export function createLabClient({ request, observeJob, account, storage, uuid = () => crypto.randomUUID(),
    basePath = '/api/labs', storagePrefix = 'neconyan-labs', label = 'Labs' }) {
    const read = (key, options) => request(`${basePath}/records/${encodeURIComponent(key)}`, options);
    const hasPending = scope => {
        const raw = storage.getItem(`${storagePrefix}:${account}:${scope}`);
        try { return Boolean(raw && !JSON.parse(raw).retired); } catch { return Boolean(raw); }
    };
    const pendingKey = scope => {
        const raw = storage.getItem(`${storagePrefix}:${account}:${scope}`);
        if (!raw) return null;
        try {
            const pending = JSON.parse(raw);
            return typeof pending?.key === 'string' && pending.key ? pending.key : null;
        } catch {
            return null;
        }
    };
    const list = (kind = '') => request(`${basePath}/records?kind=${encodeURIComponent(kind)}`);
    const refusal = record => Object.assign(new Error(record.error || 'This reviewed change was refused. Review the current records before trying again.'), { refused: true });

    async function observationClosed(record, signal) {
        let cancelled = false;
        if (signal?.reason === 'user-stop' && record.state === 'completed') return record;
        if (signal?.reason === 'user-stop' && record.jobId && record.state !== 'completed') {
            try {
                const response = await request(`/api/jobs/${encodeURIComponent(record.jobId)}/cancel`, { method: 'POST', body: '{}' });
                if (response.job?.state === 'completed' || response.job?.result) {
                    const saved = await read(record.key);
                    if (saved.state === 'completed') return saved;
                }
                cancelled = true;
            } catch (cause) {
                throw Object.assign(new Error('Stop could not be saved. The server may still be working.', { cause }), { code: 'LABS_STOP_FAILED' });
            }
        }
        throw Object.assign(new DOMException(cancelled ? 'Stopped.' : 'Observation closed', 'AbortError'), { cancelled });
    }

    const distillError = (record, job = {}) => Object.assign(new Error(record.lifecycle?.uncertain
        ? 'The previous request may still be processing, or its reply may have been lost. Trying again may use tokens again.'
        : record.lifecycle?.removed ? record.lifecycle.reason === 'cleared' ? 'The previous job was cleared.' : 'The previous job is no longer available.'
            : `Previous distillation: ${record.error || job.error?.message || job.state || 'failed'}. You can distill with current selections.`),
    { code: record.lifecycle?.uncertain ? 'DISTILL_UNCERTAIN' : 'DISTILL_PREVIOUS', record, jobId: record.jobId, requestKey: record.key,
        status: job.error?.status ?? record.lifecycle?.error?.status, serverCode: job.error?.code ?? record.lifecycle?.error?.code,
        phase: 'previous', uncertain: record.lifecycle?.uncertain === true });

    async function observe(record, { signal, onProgress, lifecycle } = {}) {
        if (signal?.aborted) return observationClosed(record, signal);
        if (record.state === 'completed') return record;
        if (lifecycle === 'distill' && record.lifecycle?.retired) throw distillError(record);
        if (record.state === 'refused') throw refusal(record);
        if (!record.jobId) throw new Error(`${label} acceptance is incomplete. Submit the retained request again.`);
        return new Promise((resolve, reject) => {
            let completed;
            observeJob(record.jobId, { account, signal, intervalMs: 750,
                onSnapshot: async job => {
                    await onProgress?.({ ...job.progress, stage: job.stage ?? job.progress?.stage }, job);
                    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(job.state)) completed = await read(record.key);
                },
                onDone: job => completed?.state === 'completed' ? resolve(completed)
                    : reject(completed?.state === 'refused' ? refusal(completed)
                        : lifecycle === 'distill' && completed ? Object.assign(distillError(completed, job), { phase: 'generation', generationMessage: job.error?.message })
                            : Object.assign(new Error(job.error?.message || `${label} work is ${job.state}. Review it in Jobs before retrying.`),
                                { phase: 'generation', jobId: record.jobId, requestKey: record.key, status: job.error?.status, code: job.error?.code })),
                onStop: async reason => {
                    if (reason === 'done') return;
                    if (reason === 'missing') {
                        read(record.key).then(saved => saved.state === 'completed' ? resolve(saved)
                            : reject(lifecycle === 'distill' ? distillError(saved)
                                : new Error(`The job is unavailable. Its saved ${label} record has been retained.`)), reject);
                    } else if (reason === 'aborted') {
                        try { resolve(await observationClosed(record, signal)); } catch (error) { reject(error); }
                    } else reject(new Error(reason));
                },
            });
        });
    }

    const distillFlights = new Map();
    const storageName = scope => `${storagePrefix}:${account}:${scope}`;
    const retained = scope => {
        const raw = storage.getItem(storageName(scope));
        return raw ? JSON.parse(raw) : null;
    };
    const replaceRetained = (scope, expected, value) => {
        if (JSON.stringify(retained(scope)) !== JSON.stringify(expected)) return false;
        if (value) storage.setItem(storageName(scope), JSON.stringify(value));
        else storage.removeItem(storageName(scope));
        return true;
    };
    async function distillStatus({ scope = 'distill' } = {}) {
        const pending = retained(scope);
        if (!pending) return null;
        let record;
        try { record = await read(pending.key); } catch (error) {
            if (error.status !== 404) throw Object.assign(error, { phase: 'observation', requestKey: pending.key });
            record = { key: pending.key, kind: 'distill', state: 'missing', lifecycle: { retired: true, uncertain: true, reason: 'missing', revision: 0, removed: true } };
        }
        if (retained(scope)?.key !== pending.key) return distillStatus({ scope });
        if (record.lifecycle?.replacement?.key && record.lifecycle.replacement.key !== pending.key) {
            const winner = await read(record.lifecycle.replacement.key);
            if (winner.state !== 'refused') {
                const next = { key: winner.key, ...(winner.state === 'preparing' ? { resume: true, resumePreviousKey: pending.key } : {}) };
                if (replaceRetained(scope, pending, next)) return winner;
                return distillStatus({ scope });
            }
        }
        if (record.state === 'preparing' && !pending.body && !pending.resume) replaceRetained(scope, pending, { ...pending, resume: true });
        if (record.lifecycle?.retired && !pending.retired) replaceRetained(scope, pending, { ...pending, retired: true });
        return record;
    }

    function runDistill(input, options = {}) {
        const scope = options.scope ?? 'distill';
        if (distillFlights.has(scope)) return distillFlights.get(scope);
        const promise = performDistill(input, { ...options, scope }).finally(() => distillFlights.delete(scope));
        distillFlights.set(scope, promise);
        return promise;
    }

    async function performDistill(input, { scope, retryUncertain = false, expectedPreviousKey, prepareInput = value => value, ...options }) {
        options.signal?.throwIfAborted();
        let pending = retained(scope);
        const actionKey = expectedPreviousKey ?? pending?.key;
        let previous;
        try { previous = pending ? await distillStatus({ scope }) : null; } catch (error) {
            if (!retryUncertain || !pending) throw error;
            previous = { key: pending.key, kind: 'distill', lifecycle: { revision: 0, uncertain: true } };
        }
        pending = retained(scope);
        if (previous && previous.key !== pending?.key) {
            if (!pending && previous.state === 'completed') return previous;
            if (!pending) throw Object.assign(new Error('The retained distillation changed. Check its current status.'), { code: 'DISTILL_CHANGED', phase: 'observation' });
            return performDistill(input, { ...options, scope, retryUncertain, expectedPreviousKey: actionKey, prepareInput });
        }
        // A competing tab's winning attempt is observed, never replaced by this stale consent.
        if (retryUncertain && previous?.key !== actionKey) retryUncertain = false;
        // A lost acceptance is retried with its exact identity/body unless the owner deliberately replaces it.
        if (previous?.state === 'completed' && !retryUncertain) {
            replaceRetained(scope, pending, null);
            return previous;
        }
        if (previous && !pending?.body && !pending?.resume && !previous.lifecycle?.retired && !retryUncertain) {
            return observe(previous, { ...options, lifecycle: 'distill' }).then(result => { replaceRetained(scope, pending, null); return result; });
        }
        const replacement = previous && (previous.lifecycle?.retired && !pending?.body || retryUncertain && !pending?.replacement);
        if (replacement && previous.lifecycle?.uncertain && !retryUncertain) throw distillError(previous);
        if (!pending || replacement) {
            const captured = await prepareInput(input);
            options.signal?.throwIfAborted();
            if (JSON.stringify(retained(scope)) !== JSON.stringify(pending)) return performDistill(input, { ...options, scope, retryUncertain, expectedPreviousKey: actionKey, prepareInput });
            const body = { ...captured, kind: 'distill', key: uuid() };
            const next = { key: body.key, body };
            if (replacement) next.replacement = { previousKey: previous.key, previousRevision: previous.lifecycle?.revision ?? 0,
                ...(pending.body ? { previousBody: pending.body } : {}), consent: retryUncertain };
            replaceRetained(scope, pending, next);
            pending = next;
        }
        let record;
        try {
            const accepted = await request(`${basePath}/${pending.resume ? `distill/${encodeURIComponent(pending.key)}/resume` : pending.replacement ? 'distill/replace' : 'submit'}`,
                { method: 'POST', body: JSON.stringify({ ...pending.body, ...pending.replacement }) });
            record = accepted.record;
            const next = { key: record.key };
            replaceRetained(scope, pending, next);
            pending = next;
        } catch (error) {
            if (error.notAccepted === true) replaceRetained(scope, pending,
                pending.replacement || pending.resumePreviousKey ? { key: pending.replacement?.previousKey ?? pending.resumePreviousKey, retired: true } : null);
            throw Object.assign(error, { phase: 'submission', requestKey: pending.key, uncertain: error.notAccepted !== true });
        }
        try {
            const result = await observe(record, { ...options, lifecycle: 'distill' });
            replaceRetained(scope, pending, null);
            return result;
        } catch (error) {
            // Re-read classifies Stop and failed work from durable provider evidence.
            try { await distillStatus({ scope }); } catch { /* Keep the exact accepted identity for a later read. */ }
            throw error;
        }
    }

    async function run(kind, input, { scope = kind, prepareInput = value => value, key: presetKey, ...options } = {}) {
        options.signal?.throwIfAborted();
        const storageKey = `${storagePrefix}:${account}:${scope}`;
        const raw = storage.getItem(storageKey);
        let pending = raw ? JSON.parse(raw) : null;
        if (pending && (typeof pending.key !== 'string' || !pending.key || (pending.body && pending.body.kind !== kind))) {
            throw new Error(`The retained ${label} request is invalid. It has not been repeated.`);
        }
        let record;
        if (pending && !pending.body) record = await read(pending.key);
        else {
            if (!pending) {
                const body = { ...await prepareInput(input), kind, key: presetKey ?? uuid() };
                options.signal?.throwIfAborted();
                pending = { key: body.key, body };
                storage.setItem(storageKey, JSON.stringify(pending));
            }
            try {
                const accepted = await request(`${basePath}/submit`, { method: 'POST', body: JSON.stringify(pending.body) });
                record = accepted.record;
            } catch (error) {
                if (error.notAccepted === true) storage.removeItem(storageKey);
                throw error;
            }
            storage.setItem(storageKey, JSON.stringify({ key: pending.key }));
        }
        try {
            const result = await observe(record, options);
            storage.removeItem(storageKey);
            return result;
        } catch (error) {
            if (error.cancelled || error.refused) storage.removeItem(storageKey);
            throw error;
        }
    }
    const recover = async (key, options) => observe(await request(`${basePath}/records/${encodeURIComponent(key)}/recover`, { method: 'POST', body: '{}' }), options);
    return { run, runDistill, distillStatus, read, list, observe, request, recover, hasPending, pendingKey };
}

const recoveryPanels = new WeakMap();
/** Explicitly finish interrupted local publications; never restart a model request. */
export function mountLabRecovery(container, { signal, onError = console.error, getClient = getLabClient,
    basePath = '/api/labs', label = 'Labs' } = {}) {
    let panel = recoveryPanels.get(container);
    if (!panel) {
        const wrapper = document.createElement('div');
        const select = document.createElement('select');
        select.className = 'text_pole';
        select.setAttribute('aria-label', `Interrupted local ${label} changes`);
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'menu_button'; button.textContent = 'Recover saved local changes';
        const status = document.createElement('span'); status.setAttribute('role', 'status');
        wrapper.append(select, button, status); wrapper.hidden = true; wrapper.style.display = 'none'; container.prepend(wrapper);
        const lifetime = new AbortController();
        let working = false;
        const ready = getClient();
        const refresh = async () => {
            if (working || lifetime.signal.aborted) return;
            working = true;
            try {
                const records = await (await ready).request(`${basePath}/recovery`);
                if (lifetime.signal.aborted) return;
                const selected = select.value;
                select.replaceChildren(...records.map(record => new Option(record.label, record.key)));
                if (records.some(record => record.key === selected)) select.value = selected;
                wrapper.hidden = !records.length;
                wrapper.style.display = records.length ? '' : 'none';
            } finally { working = false; }
        };
        const report = error => { if (!lifetime.signal.aborted) { status.textContent = error.message; onError(error); } };
        button.addEventListener('click', async () => {
            if (working || !select.value) return;
            working = true; button.disabled = true;
            try {
                await (await ready).recover(select.value, { signal: lifetime.signal });
                status.textContent = 'Saved changes recovered. Reload the saved result to view them.';
            } catch (error) { report(error); } finally { working = false; button.disabled = false; void refresh().catch(report); }
        });
        container.addEventListener('focusin', () => { void refresh().catch(report); }, { signal: lifetime.signal });
        void refresh().catch(report);
        panel = { count: 0, dispose: () => { lifetime.abort(); wrapper.remove(); recoveryPanels.delete(container); } };
        recoveryPanels.set(container, panel);
    }
    panel.count++;
    let disposed = false;
    const dispose = () => { if (!disposed) { disposed = true; if (--panel.count === 0) panel.dispose(); } };
    signal?.addEventListener('abort', dispose, { once: true });
    if (signal?.aborted) dispose();
    return dispose;
}

export function getLabClient() {
    return getNativeOperationClient();
}

export async function getNativeOperationClient({ basePath = '/api/labs', storagePrefix = 'neconyan-labs', label = 'Labs' } = {}) {
    const [host, jobs, user] = await Promise.all([import('../script.js'), import('./jobs.js'), import('./user.js')]);
    const account = user.getCurrentUserHandle();
    const request = async (url, options = {}) => {
        const response = await fetchWithCsrfRetry(url, () => {
            if (user.getCurrentUserHandle() !== account) throw new Error('account_changed');
            return { ...options, headers: { ...host.getRequestHeaders(), 'X-Neconyan-Account': account } };
        }, { refreshCsrfToken: host.refreshCsrfToken });
        const text = await response.text();
        if (user.getCurrentUserHandle() !== account) throw new Error('account_changed');
        let body;
        try { body = JSON.parse(text); } catch { body = null; }
        if (!response.ok) throw Object.assign(new Error(body?.error || `${label} request failed with ${response.status}.`),
            { status: response.status, code: body?.code ?? null, notAccepted: body?.notAccepted === true,
                recordKey: body?.recordKey, replacementKey: body?.replacementKey });
        if (!body) throw new Error(`The ${label} response was not readable. The request has been retained.`);
        return body;
    };
    return createLabClient({ request, observeJob: jobs.observeJob, account, storage: localStorage, basePath, storagePrefix, label });
}

export async function prepareLabConnection(input) {
    if (input.profileId) return input;
    const { getActiveGenerationAcknowledgement } = await import('../script.js');
    return { ...input, acknowledgement: getActiveGenerationAcknowledgement() };
}
