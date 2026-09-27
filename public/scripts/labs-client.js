/** Retained submissions and read-only observation of native Labs work. */
export function createLabClient({ request, observeJob, account, storage, uuid = () => crypto.randomUUID(),
    basePath = '/api/labs', storagePrefix = 'neconyan-labs', label = 'Labs' }) {
    const read = key => request(`${basePath}/records/${encodeURIComponent(key)}`);
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

    async function observe(record, { signal, onProgress } = {}) {
        if (signal?.aborted) return observationClosed(record, signal);
        if (record.state === 'completed') return record;
        if (record.state === 'refused') throw refusal(record);
        if (!record.jobId) throw new Error(`${label} acceptance is incomplete. Submit the retained request again.`);
        return new Promise((resolve, reject) => {
            let completed;
            observeJob(record.jobId, { account, signal, intervalMs: 750,
                onSnapshot: async job => {
                    await onProgress?.(job.progress, job);
                    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(job.state)) completed = await read(record.key);
                },
                onDone: job => completed?.state === 'completed' ? resolve(completed)
                    : reject(completed?.state === 'refused' ? refusal(completed)
                        : new Error(job.error?.message || `${label} work is ${job.state}. Review it in Jobs before retrying.`)),
                onStop: async reason => {
                    if (reason === 'done') return;
                    if (reason === 'missing') {
                        read(record.key).then(saved => saved.state === 'completed' ? resolve(saved)
                            : reject(new Error(`The job is unavailable. Its saved ${label} record has been retained.`)), reject);
                    } else if (reason === 'aborted') {
                        try { resolve(await observationClosed(record, signal)); } catch (error) { reject(error); }
                    } else reject(new Error(reason));
                },
            });
        });
    }

    async function run(kind, input, { scope = kind, prepareInput = value => value, ...options } = {}) {
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
                const body = { ...await prepareInput(input), kind, key: uuid() };
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
    return { run, read, list, observe, request, recover };
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
        if (user.getCurrentUserHandle() !== account) throw new Error('account_changed');
        const response = await fetch(url, { ...options, headers: { ...host.getRequestHeaders(), 'X-Neconyan-Account': account } });
        const text = await response.text();
        if (user.getCurrentUserHandle() !== account) throw new Error('account_changed');
        let body;
        try { body = JSON.parse(text); } catch { body = null; }
        if (!response.ok) throw Object.assign(new Error(body?.error || `${label} request failed with ${response.status}.`),
            { status: response.status, notAccepted: body?.notAccepted === true });
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
