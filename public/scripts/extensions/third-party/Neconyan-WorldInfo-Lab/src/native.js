import { getLabClient, mountLabRecovery } from '../../../../labs-client.js';
import { getContext } from './host.js';
import { entryId } from './constants.js';

export function savedChatLocator(context = getContext()) {
    const chat = context?.getCurrentChatId?.();
    if (!chat) return null;
    if (context.groupId != null) return { group: true, chat };
    const avatar = context.characters?.[context.characterId]?.avatar;
    return avatar ? { group: false, avatar, chat } : null;
}

export async function runWorldInfoLab(kind, input, { signal, onProgress } = {}) {
    const client = await getLabClient();
    const record = await client.run(`world-info.${kind}`, input, { scope: `world-info.${kind}:${input.book || 'active'}`, signal,
        onProgress, prepareInput: async value => {
            if (!['scan', 'health'].includes(kind)) return value;
            const context = getContext();
            const locator = value.locator ?? savedChatLocator(context);
            if (locator) await context.saveChat?.();
            return { ...value, ...(locator ? { locator } : {}) };
        } });
    return { ...record.result, labRecord: { key: record.key, resultHash: record.resultHash } };
}

export async function applyWorldInfoLab(preview, { signal } = {}) {
    if (!preview?.labRecord) throw new Error('Reload the saved native preview before applying it.');
    const client = await getLabClient();
    const record = await client.run('apply', { proposalKey: preview.labRecord.key, resultHash: preview.labRecord.resultHash },
        { scope: `apply:${preview.labRecord.key}`, signal });
    const context = getContext();
    let refreshWarning = '';
    try {
        await context.reloadWorldInfoEditor?.(record.result.name, true);
        await context.updateWorldInfoList?.();
    } catch (error) { refreshWarning = `The changes were saved. Reload the lorebook to see them. ${error.message}`; }
    return { count: preview.count, message: 'Reviewed changes saved.', refreshWarning };
}

export function restoredSnapshot(result) {
    const snapshot = result.snapshot;
    return snapshot ? { ...snapshot, books: new Map(Object.entries(snapshot.books)), entryIndex: snapshot.entries.reduce((index, entry, position) => {
        const id = entryId(entry);
        index.set(id, [...(index.get(id) ?? []), position]);
        return index;
    }, new Map()) } : null;
}

/** Reopen server-owned results, including work accepted in another browser. */
export async function mountSavedWorldInfoResults(container, { kinds, onResult, signal, onError }) {
    mountLabRecovery(container, { signal, onError });
    const client = await getLabClient();
    const label = document.createElement('label');
    label.className = 'sbwil-field';
    label.append('Saved server results');
    const select = document.createElement('select');
    select.className = 'text_pole sbwil-select';
    select.setAttribute('aria-label', 'Saved server results');
    label.append(select);
    container.prepend(label);
    const refresh = async () => {
        const records = (await client.list('')).filter(record => kinds.includes(record.kind));
        if (signal?.aborted) return;
        const selected = select.value;
        select.replaceChildren(new Option('Choose a saved result', ''));
        for (const record of records) select.add(new Option(`${record.label} · ${record.book || ''} · ${new Date(record.createdAt).toLocaleString()} · ${record.state}`, record.key));
        if ([...select.options].some(option => option.value === selected)) select.value = selected;
    };
    select.addEventListener('focus', () => { void refresh().catch(onError); }, { signal });
    select.addEventListener('change', async () => {
        if (!select.value) return;
        select.disabled = true;
        try {
            const record = await client.observe(await client.read(select.value), { signal });
            if (!signal?.aborted) await onResult({ ...record.result, labRecord: { key: record.key, resultHash: record.resultHash } }, record);
        } catch (error) { if (!signal?.aborted) onError(error); }
        finally { select.disabled = false; }
    }, { signal });
    await refresh();
    return refresh;
}
