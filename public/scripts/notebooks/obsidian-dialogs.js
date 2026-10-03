import { POPUP_TYPE, callGenericPopup } from '../popup.js';
import { newOperationId, notesDownload } from './api.js';
import { button, clear, field, formatTime, h } from './dom.js';

export function obsidianDialogCurrent(app, snapshot) {
    return app.state.open && app.state.account === snapshot.account && app.state.notebookId === snapshot.notebookId
        && app.state.notebookSelectionVersion === snapshot.notebookSelectionVersion
        && app.state.noteRequestVersion === snapshot.noteRequestVersion && app.state.workspaceVersion === snapshot.workspaceVersion;
}

export async function openObsidianSync(app, snapshot) {
    let adapter = null;
    let busy = false;
    let closed = false;
    let requestVersion = 0;
    let folderEdited = false;
    let pending = null;
    const current = () => !closed && obsidianDialogCurrent(app, snapshot);
    const status = h('div', { class: 'notes-obsidian-status', role: 'status' });
    const message = h('p', { class: 'notes-hint', role: 'status', text: 'Checking the server settings. No client has been started.' });
    const folder = h('input', { class: 'text_pole', type: 'text', autocomplete: 'off', oninput: () => { folderEdited = true; } });
    const confirmation = h('input', { type: 'checkbox' });
    const history = h('div', { class: 'notes-obsidian-history' });
    const confirmationRow = h('label', { class: 'notes-obsidian-confirm' }, confirmation,
        h('span', { text: 'Headless is already prepared for this folder. No other sync client is running for it.' }));
    const actions = new Map();

    function render() {
        clear(status);
        if (adapter) {
            status.append(h('p', { text: adapter.message || (adapter.running ? 'The client is running.' : 'The client is stopped.') }));
            if (adapter.lastCheckedAt) status.append(h('p', { class: 'notes-hint', text: `Last file check: ${formatTime(adapter.lastCheckedAt)}` }));
        }
        folder.disabled = busy || !adapter?.available || Boolean(adapter.running || adapter.busy);
        confirmation.disabled = busy || !adapter?.available || Boolean(adapter.running || adapter.busy);
        for (const [name, control] of actions) {
            control.disabled = busy || !adapter || (name === 'configure' && (!adapter.available || adapter.running || adapter.busy))
                || (name === 'start' && (!adapter.available || !adapter.configured || adapter.running || adapter.busy))
                || (name === 'stop' && !adapter.running && !adapter.busy)
                || (name === 'reconcile' && (!adapter.available || !adapter.configured));
        }
    }

    async function loadHistory(ticket) {
        const result = await app.request('/obsidian/history', { notebookId: snapshot.notebookId, limit: 30 });
        if (!current() || ticket !== requestVersion) return;
        clear(history);
        if (result?.status !== 'success') {
            history.append(h('p', { class: 'notes-hint', text: result?.message || 'Private file history could not be loaded. Refresh and try again.' }));
            return;
        }
        history.append(h('h4', { text: 'Private file history' }), h('p', { class: 'notes-hint', text: 'Download an exact saved snapshot. This does not replace a note or share it with AI.' }));
        if (!result.history?.length) history.append(h('p', { class: 'notes-hint', text: 'No files have been checked yet.' }));
        for (const event of (result.history ?? []).slice(0, 30)) {
            if (!/^oh_[a-f\d]{16}$/.test(event.id ?? '') || typeof event.path !== 'string') continue;
            const row = h('div', { class: 'notes-obsidian-history-row' },
                h('div', {}, h('strong', { text: event.path }), h('p', { class: 'notes-hint', text: `${event.kind}: ${formatTime(event.at)}` })));
            row.append(button('Download snapshot', async () => {
                if (!current() || busy || ticket !== requestVersion) return;
                busy = true;
                render();
                try {
                    const downloaded = await notesDownload('/obsidian/history/file', { notebookId: snapshot.notebookId, historyId: event.id });
                    if (!current() || ticket !== requestVersion) return;
                    if (downloaded.status !== 'success') {
                        message.textContent = downloaded.message || 'The snapshot could not be downloaded. Try again.';
                        return;
                    }
                    const url = URL.createObjectURL(downloaded.blob);
                    const link = h('a', { href: url, download: downloaded.filename });
                    document.body.append(link);
                    link.click();
                    link.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 30_000);
                } catch {
                    if (current()) message.textContent = 'The snapshot could not be downloaded. Check your connection and try again.';
                } finally {
                    if (current()) { busy = false; render(); }
                }
            }));
            history.append(row);
        }
    }

    async function run(action) {
        if (!current() || busy) return false;
        if ((action === 'configure' || action === 'start') && !confirmation.checked) {
            message.textContent = 'Confirm that the folder is prepared and no other sync client is running before continuing.';
            return false;
        }
        if (action === 'start' && !adapter?.configured) return false;
        const body = { notebookId: snapshot.notebookId };
        if (action === 'configure') Object.assign(body, { expectedRevision: adapter?.revision ?? null, folder: folder.value, singleMechanism: true });
        if (action === 'start') body.expectedRevision = adapter.revision;
        if (action === 'configure' || action === 'start') {
            const fingerprint = JSON.stringify([action, body]);
            if (pending?.fingerprint !== fingerprint) pending = { fingerprint, operationId: newOperationId(`obsidian-${action}`) };
            body.operationId = pending.operationId;
        }
        busy = true;
        const ticket = ++requestVersion;
        message.textContent = action === 'start' ? 'Checking the prepared client. No sign-in or installation will be attempted.' : 'Checking files and settings.';
        render();
        try {
            const result = await app.request(`/obsidian/${action}`, body);
            if (!current() || ticket !== requestVersion) return false;
            if (result?.status !== 'success' || !result.adapter) {
                message.textContent = result?.message || 'The request did not complete. Refresh the status or try again.';
                return false;
            }
            adapter = result.adapter;
            if (action === 'configure' || !folderEdited) {
                folder.value = adapter.folder || adapter.candidateFolder || '';
                folderEdited = false;
            }
            pending = null;
            message.textContent = action === 'configure' ? 'The folder is approved. Start client is a separate action.' : '';
            render();
            await loadHistory(ticket);
            return current();
        } catch {
            if (current() && ticket === requestVersion) message.textContent = 'The request could not reach the server. Check your connection and try again.';
            return false;
        } finally {
            if (current() && ticket === requestVersion) { busy = false; render(); }
        }
    }

    const controls = h('div', { class: 'notes-nav-actions notes-wrap' });
    for (const [name, label] of [['configure', 'Approve folder'], ['start', 'Start client'], ['stop', 'Stop client'], ['reconcile', 'Check external changes'], ['status', 'Refresh status']]) {
        const control = button(label, () => void run(name));
        actions.set(name, control);
        controls.append(control);
    }
    const content = h('div', { class: 'notes-obsidian-dialog' }, h('h3', { text: 'Obsidian sync' }),
        h('p', { text: 'Use one already prepared Obsidian Headless client on this notebook’s existing content folder. This never installs Headless, signs you in or starts a second synced copy.' }),
        h('p', { class: 'notes-hint', text: 'The server owner must enable this and approve the folder and client. New incoming notes start with AI access and roleplay context off; sync never publishes lore.' }),
        status, field('Content folder', folder, 'Choose this notebook’s existing folder inside the server owner’s approved roots.'), confirmationRow, controls, message,
        h('p', { class: 'notes-hint', text: 'External programs do not use Neconyan’s write lock. Very fast overwrites or a change during a save can still race. Observed stable versions are kept in private history; check conflicts before replacing anything.' }), history);
    render();
    return await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', {
        wide: true, okButton: 'Done', cancelButton: false,
        onOpen: () => { void run('status'); },
        onClosing: () => {
            if (busy && current()) return false;
            closed = true;
            requestVersion++;
            return true;
        },
    });
}
