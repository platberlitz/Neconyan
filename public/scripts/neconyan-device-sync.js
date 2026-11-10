import { getCurrentChatId, getRequestHeaders, pauseSettingsForAccountImport, saveChatConditional } from '../script.js';
import { getCurrentUserHandle } from './user.js';
import { t, translate } from './i18n.js';
import { callGenericPopup, Popup, POPUP_TYPE } from './popup.js';

const categoryLabels = { characters: 'Character cards and solo chats', lorebooks: 'Lorebooks', presets: 'Prompt templates', personas: 'Personas and avatars', backgrounds: 'Backgrounds', appearance: 'Text size, chat width and blur' };
const methodLabels = { file: 'Encrypted file', webdav: 'WebDAV', gist: 'Secret GitHub Gist', pairing: 'Direct pairing' };
const categoryNames = Object.keys(categoryLabels);
const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) { node.textContent = translate(text); node.setAttribute('data-i18n', text); }
    if (className) node.className = className;
    return node;
};

export async function mountDeviceSync(root) {
    if (root.dataset.mounted) return;
    root.dataset.mounted = 'true';
    const owner = getCurrentUserHandle();
    let state, busy = false;
    const status = element('p', 'Loading device sync…', 'nn-sync-status');
    status.removeAttribute('data-i18n');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const content = element('div');
    root.replaceChildren(status, content);

    const request = async (route, data) => {
        if (getCurrentUserHandle() !== owner) throw new Error(t`The account changed. Reload before syncing.`);
        const response = await fetch('/api/device-sync/' + route, { method: data === undefined ? 'GET' : 'POST', cache: 'no-store',
            headers: { ...getRequestHeaders(), 'X-Neconyan-Account': owner }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ? translate(value.error) : t`Device sync could not finish. Try again.`);
        return value;
    };
    const coordinatedWrite = async (route, data) => {
        const message = element('p', 'Saving current work before syncing. Keep this page open.');
        const reload = element('button', 'Reload imported data', 'menu_button menu_button_primary');
        reload.type = 'button'; reload.hidden = true;
        reload.addEventListener('click', () => { if (getCurrentUserHandle() === owner) location.reload(); });
        const controls = element('div', '', 'popup-controls'); controls.append(reload);
        const panel = element('div'); panel.id = 'nn-sync-protected-reload'; panel.append(message, controls);
        let closable = false, resume, dispatched = false;
        const popup = new Popup(panel, POPUP_TYPE.DISPLAY, '', { allowEscapeClose: false, onClosing: () => closable });
        void popup.show();
        const close = async () => { closable = true; await popup.completeAffirmative(); resume?.(); };
        try {
            if (getCurrentChatId()) await saveChatConditional({ throwOnError: true, throwOnPromptError: true });
            resume = await pauseSettingsForAccountImport();
            if (getCurrentUserHandle() !== owner) throw new Error(t`The account changed. Reload before syncing.`);
            dispatched = true;
            const result = await request(route, data);
            if (!result.imported && !result.resolved) { await close(); return result; }
            message.textContent = t`The transferred data is saved. Reload to use the refreshed settings and libraries. Current work was saved first; settings stay protected until reload.`;
            message.removeAttribute('data-i18n'); reload.hidden = false; reload.focus();
            return { ...result, keepForm: true };
        } catch (error) {
            if (!dispatched) await close();
            else {
                // A failed response can follow a partial, recoverable publication.
                // Never resume stale whole-settings saves on an uncertain result.
                message.textContent = t`Sync stopped. Reload before continuing so this page cannot overwrite transferred data. Current work was saved first.`;
                message.removeAttribute('data-i18n'); reload.hidden = false; reload.focus();
            }
            throw error;
        }
    };
    const api = (route, data) => ['import', 'now', 'resolve', 'recover'].includes(route) ? coordinatedWrite(route, data) : request(route, data);
    const refresh = async () => { state = await api('status'); render(); };
    const run = async action => {
        if (busy) return;
        busy = true; root.setAttribute('aria-busy', 'true');
        root.querySelectorAll('button,input').forEach(control => { control.disabled = true; });
        status.textContent = t`Working… Keep this page open.`;
        status.removeAttribute('data-error');
        try {
            const result = await action();
            if (!result?.keepForm) await refresh();
            status.textContent = result?.imported !== undefined ? t`${result.imported} imported · ${result.conflicts || 0} conflicts · ${result.unchanged || 0} unchanged`
                : t`Saved. Nothing runs in the background.`;
        } catch (error) {
            status.textContent = error.message; status.dataset.error = 'true';
            for (const section of root.querySelectorAll('.nn-sync-method')) {
                const enabled = state.methods[section.dataset.method].enabled;
                section.querySelector('.nn-sync-toggle input').checked = enabled;
                section.querySelector('.nn-sync-method-body').hidden = !enabled;
            }
        } finally { busy = false; root.removeAttribute('aria-busy'); root.querySelectorAll('button,input').forEach(control => { control.disabled = false; }); }
    };
    const button = (label, action, primary = false) => {
        const node = element('button', label, 'menu_button' + (primary ? ' menu_button_primary' : ''));
        node.type = 'button'; node.addEventListener('click', () => void run(action)); return node;
    };
    const field = (parent, label, type = 'text', name = '') => {
        const wrapper = element('label', label, 'nn-sync-field');
        const input = element('input', '', 'text_pole'); input.type = type; input.name = name;
        if (type === 'password') { input.autocomplete = 'new-password'; input.spellcheck = false; }
        if (type === 'url') { input.autocomplete = 'off'; input.spellcheck = false; }
        wrapper.append(input); parent.append(wrapper); return input;
    };
    const download = (value, name) => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
        const link = element('a'); link.href = url; link.download = name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    function render() {
        content.replaceChildren(); content.id = 'nn-device-sync-ready';
        content.append(element('p', 'For separate Neconyan installations. Browsers using the same server already share their saved data.'));
        content.append(element('p', 'Every method starts off. Enabling one only permits manual transfers; nothing syncs automatically. Deletions never travel to another installation.', 'nn-sync-note'));

        const selection = element('fieldset'); selection.append(element('legend', 'What to share'));
        const checks = categoryNames.map(category => {
            const label = element('label', '', 'nn-sync-check');
            const input = element('input'); input.type = 'checkbox'; input.checked = state.categories.includes(category); input.value = category;
            label.append(input, element('span', categoryLabels[category])); selection.append(label); return input;
        });
        selection.append(element('p', 'Prompt templates: Instruct, Context, System Prompt and Reasoning only. Connection presets, API keys, passwords, Conversation, group chats and local attachments are not transferred.', 'nn-sync-note'));
        selection.append(button('Save categories', () => api('configure', { categories: checks.filter(input => input.checked).map(input => input.value) })));
        content.append(selection);

        const secrets = element('details'); secrets.open = !state.hasPassphrase;
        secrets.append(element('summary', state.hasPassphrase ? 'Shared passphrase saved' : 'Set a shared passphrase'));
        secrets.append(element('p', 'Use the same passphrase on both installations, at least 12 characters. Keep a copy somewhere safe; there is no recovery. It is saved privately on this server, never in ordinary settings or exported data.'));
        const passphrase = field(secrets, 'Shared passphrase', 'password', 'sync-passphrase');
        secrets.append(button('Save passphrase', async () => { await api('configure', { passphrase: passphrase.value }); passphrase.value = ''; }));
        content.append(secrets);

        for (const [method, label] of Object.entries(methodLabels)) {
            const section = element('section', '', 'nn-sync-method'); section.dataset.method = method;
            const heading = element('h4', label);
            const toggleLabel = element('label', '', 'nn-sync-check nn-sync-toggle');
            const toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = state.methods[method].enabled;
            toggle.setAttribute('aria-label', t`Enable ${translate(label)}`);
            toggle.addEventListener('change', () => void run(() => api('configure', { method, enabled: toggle.checked })));
            toggleLabel.append(toggle, element('span', toggle.checked ? 'On · manual only' : 'Off'));
            section.append(heading, toggleLabel);
            const body = element('div', '', 'nn-sync-method-body'); body.hidden = !toggle.checked;
            const configure = config => api('configure', { method, enabled: true, config });
            if (method === 'file') {
                section.append(element('p', 'Download an encrypted copy, then import it on another installation. No provider or connection between servers is needed.', 'nn-sync-note'));
                body.append(button('Download encrypted file', async () => download(await api('export', {}), 'neconyan-device-sync.json'), true));
                const file = field(body, 'Encrypted file to import', 'file', 'sync-file'); file.accept = '.json,application/json';
                body.append(button('Import encrypted file', async () => {
                    if (!file.files?.[0]) throw new Error(t`Choose an encrypted sync file first.`);
                    if (file.files[0].size > 60 * 1024 * 1024) throw new Error(t`The encrypted file exceeds 60 MiB.`);
                    let envelope;
                    try { envelope = JSON.parse(await file.files[0].text()); } catch { throw new Error(t`Choose a valid encrypted sync JSON file.`); }
                    return api('import', { envelope });
                }));
            } else if (method === 'webdav') {
                section.append(element('p', 'Both installations use one HTTPS file URL. Your server must support ETags and conditional PUT, which prevent overwriting a newer remote copy.', 'nn-sync-note'));
                const url = field(body, 'WebDAV file URL', 'url', 'sync-webdav-url');
                const username = field(body, 'WebDAV username', 'text', 'sync-webdav-username');
                const password = field(body, 'WebDAV password or app password', 'password', 'sync-webdav-password');
                body.append(button('Save WebDAV connection', () => configure({ url: url.value, username: username.value, password: password.value })));
                body.append(button('Sync now', () => api('now', { method }), true));
            } else if (method === 'gist') {
                section.append(element('p', 'Secret Gists are unlisted, not private. The content is encrypted. GitHub keeps a separate file for each transfer, including old versions; no file is overwritten or deleted.', 'nn-sync-note'));
                const token = field(body, 'GitHub token with Gist permission', 'password', 'sync-gist-token');
                const id = field(body, 'Secret Gist ID (leave empty to create one)', 'text', 'sync-gist-id');
                id.value = state.methods.gist.gistId || '';
                body.append(element('p', 'Up to 900 KiB encrypted per snapshot and 32 retained snapshots. Start a new Gist when full. Keep unrelated files out of this Gist.', 'nn-sync-note'));
                body.append(button('Save Gist connection', () => configure({ ...(token.value ? { token: token.value } : {}), gistId: id.value })));
                body.append(button('Create secret Gist', () => api('now', { method, create: true })));
                body.append(button('Sync now', () => api('now', { method }), true));
            } else {
                section.append(element('p', 'Enable pairing on both installations. Create a code on the receiving server, then paste it on the other. Codes grant encrypted sync access for 30 days, not account sign-in. HTTP is allowed only on an intentional local network.', 'nn-sync-note'));
                const address = field(body, 'This installation’s reachable URL', 'url', 'sync-pairing-url'); address.value = location.origin;
                const invitation = field(body, 'New pairing code (share privately)', 'password', 'sync-pairing-invitation'); invitation.readOnly = true;
                body.append(button('Create pairing code', async () => {
                    const grant = await api('grant', {});
                    const { owner: handle, id, token } = grant;
                    const bytes = new TextEncoder().encode(JSON.stringify({ url: address.value.replace(/\/$/, ''), owner: handle, id, token }));
                    invitation.type = 'text'; invitation.value = 'neconyan-sync:' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                    state = await api('status');
                    body.append(button(t`Revoke code expiring ${new Date(grant.expires).toLocaleDateString()}`, () => api('revoke', { id: grant.id })));
                    return { keepForm: true };
                }));
                const code = field(body, 'Pairing code from the other installation', 'password', 'sync-pairing-code');
                body.append(button('Save pairing connection', () => configure({ code: code.value })));
                body.append(button('Sync now', () => api('now', { method }), true));
                for (const grant of state.grants) body.append(button(t`Revoke code expiring ${new Date(grant.expires).toLocaleDateString()}`, () => api('revoke', { id: grant.id })));
            }
            if (method !== 'file' && state.methods[method].enabled) body.append(element('p', state.methods[method].configured ? 'Connection saved on this server. Saved credentials are never displayed.' : 'Save this connection before syncing.', 'nn-sync-note'));
            section.append(body); content.append(section);
        }

        const history = element('section', '', 'nn-sync-history'); history.append(element('h4', 'Last transfer'));
        const last = state.lastResult;
        history.append(element('p', !last ? 'No transfers yet.' : `${translate(methodLabels[last.method])} · ${new Date(last.at).toLocaleString()} · ${last.ok ? t`${last.imported || 0} imported, ${last.conflicts || 0} conflicts` : translate(last.error)}`));
        if (state.recoveryPending) {
            history.append(element('p', 'An interrupted transfer has saved recovery data. Enable its original method, then finish it before starting another.'));
            for (const method of Object.keys(methodLabels).filter(name => state.methods[name].enabled)) history.append(button(t`Recover ${translate(methodLabels[method])}`, () => api('recover', { method })));
        }
        content.append(history);
        const conflicts = element('section'); conflicts.append(element('h4', 'Conflicts and preserved copies'));
        conflicts.append(element('p', 'Different copies are never chosen by date. Both versions stay saved until you choose. Download them before replacing either version. Resolved copies remain available.'));
        if (!state.conflicts.length) conflicts.append(element('p', 'No conflicts to review.', 'nn-sync-note'));
        for (const conflict of state.conflicts) {
            const row = element('div', '', 'nn-sync-conflict'); row.append(element('strong', conflict.path));
            row.append(element('p', conflict.superseded ? 'Newer conflict available · both copies retained' : conflict.resolved ? 'Resolved · both copies retained' : 'Review required'));
            for (const side of ['local', 'remote']) if (side !== 'local' || conflict.localHash) row.append(button(side === 'local' ? 'Download my preserved copy' : 'Download incoming copy', async () => download(await api('conflict-copy', { id: conflict.id, side }), 'neconyan-conflict-copy.json')));
            if (!conflict.resolved) {
                row.append(button('Keep mine', () => api('resolve', { id: conflict.id, choice: 'local' })));
                row.append(button('Use incoming copy', () => api('resolve', { id: conflict.id, choice: 'incoming' })));
            } else {
                row.append(button('Remove preserved copies', async () => {
                    if (await callGenericPopup(t`Remove both preserved copies? Your chosen current version stays saved. Download the preserved copies first if you still need them.`, POPUP_TYPE.CONFIRM)) return api('forget-conflict', { id: conflict.id });
                }));
            }
            conflicts.append(row);
        }
        content.append(conflicts, element('p', 'Limits: 1000 files, 8 MiB per file and 32 MiB expanded per transfer. Unsupported or damaged data stops the transfer before publication. Back up both installations first.', 'nn-sync-note'));
    }
    try { await refresh(); status.textContent = t`Ready. No transfer starts until you ask.`; } catch (error) { status.textContent = error.message; status.dataset.error = 'true'; root.dataset.mounted = ''; }
}
