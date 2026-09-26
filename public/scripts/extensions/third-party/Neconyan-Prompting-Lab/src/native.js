import { getLabClient, mountLabRecovery } from '../../../../labs-client.js';

/** The page observes one accepted operation; closing it only detaches this observer. */
export async function runPromptingLab(kind, input, { signal = null, onProgress = null, onUpdate = null, returnRecord = false } = {}) {
    const client = await getLabClient();
    const record = await client.run(`prompting.${kind}`, input, {
        scope: `prompting:${kind}:${input.operation || input.suiteId || ''}`, signal,
        onProgress: async (progress, job) => {
            await onProgress?.(progress);
            if (onUpdate && job.intent?.labs?.key) {
                const saved = await client.read(job.intent.labs.key);
                if (saved.partial) await onUpdate(saved.partial);
            }
        },
    });
    return returnRecord ? record : record.result;
}

/** Reopen a permanent result without starting a new comparison or generation. */
export function mountSavedPromptingResults(container, { kind, operation, label = 'Saved server results', onResult, onBusy, isBusy, onError }) {
    const lifetime = new AbortController();
    mountLabRecovery(container, { signal: lifetime.signal, onError });
    const wrapper = document.createElement('div');
    wrapper.className = 'sbpl-controls';
    const select = document.createElement('select');
    select.className = 'text_pole sbpl-select';
    select.setAttribute('aria-label', label);
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'menu_button sbpl-button';
    stop.textContent = 'Stop saved work';
    stop.hidden = true;
    stop.style.display = 'none';
    wrapper.append(select, stop);
    container.prepend(wrapper);
    let controller;
    stop.addEventListener('click', () => controller?.abort('user-stop'));
    const ready = getLabClient();
    const refresh = async () => {
        const client = await ready;
        const records = await client.list(`prompting.${kind}`);
        if (lifetime.signal.aborted) return;
        const previous = select.value;
        select.replaceChildren(new Option(label, ''));
        for (const record of records.filter(record => !operation || record.operation === operation)) {
            select.append(new Option(`${record.label} · ${new Date(record.createdAt).toLocaleString()} · ${record.state}`, record.key));
        }
        select.value = previous;
    };
    const report = error => { if (!lifetime.signal.aborted) onError?.(error); };
    select.addEventListener('focus', () => { if (!controller) void refresh().catch(report); });
    select.addEventListener('change', async () => {
        if (!select.value || controller || isBusy?.()) return;
        const observing = new AbortController();
        controller = observing;
        select.disabled = true;
        stop.hidden = false;
        stop.style.display = '';
        onBusy?.(observing);
        try {
            const client = await ready;
            const saved = await client.read(select.value);
            const show = record => {
                if (!observing.signal.aborted && !lifetime.signal.aborted && (record.result || record.partial)) {
                    return onResult(record.result ?? record.partial, record);
                }
            };
            await show(saved);
            const completed = await client.observe(saved, { signal: observing.signal, onProgress: async () => show(await client.read(saved.key)) });
            await show(completed);
        } catch (error) { report(error); }
        finally {
            onBusy?.(null, observing);
            if (controller === observing) controller = null;
            select.disabled = false;
            stop.hidden = true;
            stop.style.display = 'none';
        }
    });
    void refresh().catch(report);
    return () => { lifetime.abort(); controller?.abort(); wrapper.remove(); };
}
