import { getCurrentChatId, saveChatConditional, saveSettings } from '../script.js';
import { getCurrentUserHandle } from './user.js';
import { getOperationClient, mountOperationRecovery } from './operations-client.js';
import { createAccountResetClient } from './account-reset-client.js';

export async function resetAccountData(credentials, options) {
    const client = await getOperationClient();
    return createAccountResetClient({ client, owner: getCurrentUserHandle(), storage: localStorage })(credentials, options);
}

export async function createAccountBackup(handle, options = {}) {
    const client = await getOperationClient();
    return client.run('account-backup', { handle }, { ...options, scope: `account-backup:${handle}`, prepareInput: async input => {
        if (handle === getCurrentUserHandle()) {
            if (getCurrentChatId()) await saveChatConditional({ throwOnError: true, throwOnPromptError: true });
            if (!await saveSettings(0, { returnResult: true })) throw new Error('Save the current settings before creating a backup.');
        }
        return input;
    } });
}

export function downloadAccountBackup(record, owner = getCurrentUserHandle()) {
    if (owner !== getCurrentUserHandle() || record?.state !== 'completed' || !record.result?.binary) throw new Error('This saved backup is not available for the current account.');
    const link = document.createElement('a');
    link.href = `/api/operations/records/${encodeURIComponent(record.key)}/download`;
    link.download = record.result.fileName;
    link.click();
}

/** A reopened profile observes accepted work and downloads retained output, without submitting another backup. */
export async function mountAccountDataWork(container, { signal } = {}) {
    const client = await getOperationClient();
    const owner = getCurrentUserHandle();
    const isCurrent = () => !signal?.aborted && owner === getCurrentUserHandle();
    const showError = target => error => { if (isCurrent()) target.textContent = error.message; };
    const wrapper = document.createElement('div'); wrapper.className = 'flex-container flexFlowColumn';
    const select = document.createElement('select'); select.className = 'text_pole'; select.setAttribute('aria-label', 'Saved account backups');
    const download = document.createElement('button'); download.type = 'button'; download.className = 'menu_button'; download.textContent = 'Download saved backup'; download.style.display = 'none';
    const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'menu_button'; stop.textContent = 'Stop backup'; stop.style.display = 'none';
    const status = document.createElement('div'); status.setAttribute('role', 'status');
    wrapper.append(select, stop, download, status); container.append(wrapper);
    mountOperationRecovery(wrapper, { signal, onError: error => { status.textContent = error.message; } });
    let controller; let selected; let refreshing = false;
    const refresh = async () => {
        if (controller || refreshing || !isCurrent()) return;
        refreshing = true;
        try {
            const records = await client.list('account-backup');
            if (!isCurrent() || controller) return;
            const current = select.value;
            select.replaceChildren(new Option('Choose a saved account backup', ''), ...records.map(record => new Option(`${new Date(record.createdAt).toLocaleString()} · ${record.state}`, record.key)));
            select.value = current;
            status.textContent = '';
        } finally { refreshing = false; }
    };
    signal?.addEventListener('abort', () => controller?.abort(), { once: true });
    select.addEventListener('focus', () => { void refresh().catch(showError(status)); });
    stop.addEventListener('click', () => controller?.abort('user-stop'));
    download.addEventListener('click', () => downloadAccountBackup(selected, owner));
    select.addEventListener('change', async () => {
        if (!select.value || controller) return;
        controller = new AbortController(); select.disabled = true; download.style.display = 'none'; stop.style.display = '';
        try {
            selected = await client.observe(await client.read(select.value), { signal: controller.signal,
                onProgress: progress => { status.textContent = progress?.stage || 'Creating saved backup'; } });
            status.textContent = `${selected.result.files} files saved in ${selected.result.fileName}.`;
            download.style.display = '';
        } catch (error) { status.textContent = error.cancelled ? 'Backup stopped.' : error.message; } finally { controller = null; select.disabled = false; stop.style.display = 'none'; }
    });
    void refresh().catch(showError(status));
    const resets = document.createElement('select'); resets.className = 'text_pole'; resets.setAttribute('aria-label', 'Saved account resets');
    const resetStatus = document.createElement('div'); resetStatus.setAttribute('role', 'status');
    const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'menu_button'; reload.textContent = 'Reload reset account'; reload.style.display = 'none';
    wrapper.append(resets, resetStatus, reload);
    let refreshingResets = false;
    const refreshResets = async () => {
        if (refreshingResets || resets.disabled || !isCurrent()) return;
        refreshingResets = true;
        try {
            const records = await client.list('account-reset');
            if (!isCurrent() || resets.disabled) return;
            const current = resets.value;
            resets.replaceChildren(new Option('Choose a saved account reset', ''), ...records.map(record => new Option(`${new Date(record.createdAt).toLocaleString()} · ${record.state}`, record.key)));
            resets.value = current;
            resetStatus.textContent = '';
        } finally { refreshingResets = false; }
    };
    resets.addEventListener('focus', () => { void refreshResets().catch(showError(resetStatus)); });
    resets.addEventListener('change', async () => {
        if (!resets.value) return;
        resets.disabled = true;
        try {
            const record = await client.observe(await client.read(resets.value), { signal });
            resetStatus.textContent = record.result.reset ? 'The account reset is complete.' : 'The saved reset needs recovery.';
            reload.style.display = record.result.reset ? '' : 'none';
        } catch (error) { resetStatus.textContent = error.message; } finally { resets.disabled = false; }
    });
    reload.addEventListener('click', () => { if (owner === getCurrentUserHandle()) location.reload(); });
    void refreshResets().catch(showError(resetStatus));
}
