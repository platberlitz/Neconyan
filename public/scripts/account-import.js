import { getCurrentChatId, getRequestHeaders, pauseSettingsForAccountImport, saveChatConditional } from '../script.js';
import { getCurrentUserHandle } from './user.js';
import { getOperationClient, mountOperationRecovery } from './operations-client.js';
import { accountImportScope, createAccountImportClient } from './account-import-client.js';

const SKIPPED_SHOWN = 20;

/** Keep intentional exclusions separate from files that could not be imported. */
export function describeAccountImportSkips(result) {
    const count = Number(result?.skippedCount) || 0;
    const excluded = Number(result?.excludedCount) || 0;
    if (!count && !excluded && !result?.personaSettingsOnly) return '';
    const sections = [];
    if (excluded) {
        const listed = (Array.isArray(result.excluded) ? result.excluded : []).slice(0, SKIPPED_SHOWN).map(item => `• ${item.file}: ${item.reason}`);
        sections.push([`${excluded === 1 ? '1 file was' : `${excluded} files were`} left out on purpose:`, ...listed,
            ...(excluded > listed.length ? [`…and ${excluded - listed.length} more. Download the report for the full list.`] : []),
            'Only the selected libraries were imported. Chats include group chats and attachments. Your other settings are kept.'].join('\n'));
    }
    if (count) {
        const listed = (Array.isArray(result.skipped) ? result.skipped : []).slice(0, SKIPPED_SHOWN).map(item => `• ${item.reason}`);
        sections.push([`${count === 1 ? '1 file could' : `${count} files could`} not be imported:`, ...listed,
            ...(count > listed.length ? [`…and ${count - listed.length} more. Download the report for the full list.`] : []),
            'Other selected files were imported. Check the reasons above before retrying.'].join('\n'));
    }
    if (result.personaSettingsOnly) sections.push('Only persona names and descriptions were read from settings.json. Other settings in that file were not imported.');
    if (result.parts) sections.unshift(`Selected libraries: ${result.parts.map(part => ({ chats: 'Chats', personas: 'Personas', characters: 'Character cards' })[part]).join(', ')}.`);
    return sections.join('\n\n');
}

/** The screen shows a short list; this download includes every excluded or skipped file. */
export function mountAccountImportReportDownload(container, result) {
    if (!(result?.excludedCount || result?.skippedCount || result?.personaSettingsOnly)) return null;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'menu_button'; button.textContent = 'Download skipped-files report';
    button.addEventListener('click', () => {
        const lines = [`${result.imported} imported files saved.`, 'Files left out on purpose:',
            ...(result.excluded ?? []).map(item => `${item.file}: ${item.reason}`),
            ...(result.personaSettingsOnly ? ['settings.json: Only persona names and descriptions were imported; other settings were kept.'] : []),
            'Files that could not be imported:', ...(result.skipped ?? []).map(item => item.reason)];
        const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = 'Neconyan-import-report.txt';
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
    container.append(button);
    return button;
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
    let resumeSettings;
    try {
        if (client.hasPending(accountImportScope(input))) resumeSettings = await pauseSettingsForAccountImport({ flush: false });
        const record = await createAccountImportClient({ client, owner, storage: localStorage, upload })(input, { ...options, prepareInput: async value => {
            assertOwner();
            if (getCurrentChatId()) await saveChatConditional({ throwOnError: true, throwOnPromptError: true });
            resumeSettings = await pauseSettingsForAccountImport();
            assertOwner();
            return value;
        } });
        // Extension-only imports do not replace settings. Account imports need a reload first.
        if (input.mode === 'extensions') resumeSettings?.();
        return record;
    } catch (error) {
        if (error.refused || error.notAccepted) resumeSettings?.();
        throw error;
    }
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
    let reportDownload;
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
        reportDownload?.remove();
        let resumeSettings;
        try {
            resumeSettings = await pauseSettingsForAccountImport({ flush: false });
            const record = await client.observe(await client.read(select.value), { signal: controller.signal,
                onProgress: progress => { status.textContent = progress?.stage || 'Importing retained files'; } });
            const skips = describeAccountImportSkips(record.result);
            status.textContent = `${record.result.imported} imported files are saved. Reload to use the imported data.${skips ? `\n\n${skips}` : ''}`;
            reportDownload = mountAccountImportReportDownload(wrapper, record.result);
            reload.style.display = '';
            onResult?.(record.result);
        } catch (error) {
            if (error.refused || error.notAccepted) resumeSettings?.();
            status.textContent = error.cancelled ? 'Import stopped. Saved local changes remain available for recovery.' : error.message;
        } finally { controller = null; select.disabled = false; stop.style.display = 'none'; onBusy?.(false); }
    });
    await refresh();
}
