import { getCurrentChatId, getRequestHeaders, saveChatConditional, saveSettings } from '../script.js';
import { getCurrentUserHandle } from './user.js';
import { getOperationClient, mountOperationRecovery } from './operations-client.js';
import { createAccountImportClient } from './account-import-client.js';

const SKIPPED_SHOWN = 20;

/** Lists the damaged files a finished import left out, or returns an empty string when nothing was skipped. */
export function describeAccountImportSkips(result) {
    const count = Number(result?.skippedCount) || 0;
    if (!count) return '';
    const listed = (Array.isArray(result.skipped) ? result.skipped : []).slice(0, SKIPPED_SHOWN).map(item => `• ${item.reason}`);
    const more = count - listed.length;
    return [`${count === 1 ? '1 file was' : `${count} files were`} damaged and could not be imported:`, ...listed,
        ...(more > 0 ? [`…and ${more} more.`] : []),
        'Everything else was imported. To bring a skipped item back, re-export it from the original app and import it again.'].join('\n');
}

export async function importAccountData(input, options = {}) {
    const owner = getCurrentUserHandle();
    const client = await getOperationClient();
    const assertOwner = () => { if (owner !== getCurrentUserHandle()) throw new Error('account_changed'); };
    const upload = async (key, file) => {
        assertOwner();
        const body = new FormData(); body.append('key', key); body.append('avatar', file, file.name);
        const response = await fetch('/api/operations/import-input', { method: 'POST', body,
            headers: { ...getRequestHeaders({ omitContentType: true }), 'X-Neconyan-Account': owner } });
        const text = await response.text();
        assertOwner();
        let value;
        try { value = JSON.parse(text); } catch { throw new Error('The ZIP upload response was unreadable. Its request has been retained.'); }
        if (!response.ok) throw Object.assign(new Error(value.error || 'The ZIP upload failed.'), { status: response.status });
        return value;
    };
    return createAccountImportClient({ client, owner, storage: localStorage, upload })(input, { ...options, prepareInput: async value => {
        assertOwner();
        if (getCurrentChatId()) await saveChatConditional({ throwOnError: true, throwOnPromptError: true });
        if (!await saveSettings(0, { returnResult: true })) throw new Error('Save the current settings before importing account data.');
        assertOwner();
        return value;
    } });
}

export async function mountSavedAccountImports(container, { onResult, onBusy, signal } = {}) {
    const owner = getCurrentUserHandle();
    const client = await getOperationClient();
    const wrapper = document.createElement('div'); wrapper.className = 'flex-container flexFlowColumn';
    const select = document.createElement('select'); select.className = 'text_pole'; select.setAttribute('aria-label', 'Saved account imports');
    const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'menu_button'; stop.textContent = 'Stop import'; stop.style.display = 'none';
    const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'menu_button'; reload.textContent = 'Reload imported account'; reload.style.display = 'none';
    const status = document.createElement('div'); status.setAttribute('role', 'status'); status.style.whiteSpace = 'pre-line'; status.style.overflowWrap = 'anywhere';
    wrapper.append(select, stop, reload, status); container.append(wrapper);
    mountOperationRecovery(wrapper, { signal, onError: error => { status.textContent = error.message; } });
    let controller;
    const refresh = async () => {
        if (controller || signal?.aborted) return;
        const records = await client.list('account-import');
        const current = select.value;
        select.replaceChildren(new Option('Choose a saved account import', ''), ...records.map(record => new Option(`${new Date(record.createdAt).toLocaleString()} · ${record.state}`, record.key)));
        select.value = current;
    };
    signal?.addEventListener('abort', () => controller?.abort(), { once: true });
    select.addEventListener('focus', () => { void refresh().catch(error => { status.textContent = error.message; }); });
    stop.addEventListener('click', () => controller?.abort('user-stop'));
    reload.addEventListener('click', () => { if (owner === getCurrentUserHandle()) location.reload(); });
    select.addEventListener('change', async () => {
        if (controller || !select.value) return;
        controller = new AbortController(); select.disabled = true; stop.style.display = ''; reload.style.display = 'none'; onBusy?.(true);
        try {
            const record = await client.observe(await client.read(select.value), { signal: controller.signal,
                onProgress: progress => { status.textContent = progress?.stage || 'Importing retained files'; } });
            const skips = describeAccountImportSkips(record.result);
            status.textContent = `${record.result.imported} imported files are saved. Reload to use the imported settings.${skips ? `\n\n${skips}` : ''}`;
            reload.style.display = '';
            onResult?.(record.result);
        } catch (error) { status.textContent = error.cancelled ? 'Import stopped. Saved local changes remain available for recovery.' : error.message; } finally { controller = null; select.disabled = false; stop.style.display = 'none'; onBusy?.(false); }
    });
    await refresh();
}
