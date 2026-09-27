import { getOperationClient, mountOperationRecovery } from '../../../operations-client.js';

/** Observe retained work; choosing a result never submits another scan or search. */
export function mountSavedArchiveWork(container, { signal, onResult, onBusy, onError }) {
    const wrapper = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = 'Saved archive work';
    const select = document.createElement('select');
    select.className = 'text_pole';
    select.setAttribute('aria-label', 'Saved archive work');
    label.append(select);
    const stop = document.createElement('button');
    stop.type = 'button'; stop.className = 'menu_button'; stop.textContent = 'Stop archive work';
    stop.style.display = 'none';
    wrapper.append(label, stop); container.append(wrapper);
    mountOperationRecovery(wrapper, { signal, onError });
    const ready = getOperationClient();
    let observer = null;
    const refresh = async () => {
        const client = await ready;
        const records = (await client.list()).filter(record => ['archive-inventory', 'archive-search', 'archive-export'].includes(record.kind));
        if (signal.aborted || observer) return;
        const selected = select.value;
        select.replaceChildren(new Option('Choose saved archive work', ''), ...records.map(record => new Option(
            `${record.label} · ${new Date(record.createdAt).toLocaleString()} · ${record.state}`, record.key)));
        select.value = selected;
    };
    select.addEventListener('focus', () => { void refresh().catch(onError); });
    stop.addEventListener('click', () => observer?.abort('user-stop'));
    signal.addEventListener('abort', () => observer?.abort(), { once: true });
    select.addEventListener('change', async () => {
        if (!select.value || signal.aborted || observer) return;
        observer = new AbortController(); onBusy?.(true);
        select.disabled = true; stop.style.display = '';
        try {
            const client = await ready;
            const saved = await client.observe(await client.read(select.value), { signal: observer.signal });
            if (!signal.aborted) await onResult(saved);
        } catch (error) { if (!signal.aborted) onError(error); } finally { observer = null; select.disabled = false; stop.style.display = 'none'; onBusy?.(false); }
    });
    void refresh().catch(onError);
}
