import { reloadCurrentChat, saveChatConditional, saveSettings } from '../../../script.js';
import { getContext } from '../../extensions.js';
import { getCurrentUserHandle } from '../../user.js';
import { getOperationClient, mountOperationRecovery } from '../../operations-client.js';

let refreshing = 0;
const active = new Map();
export const isTranslationRefresh = () => refreshing > 0;

function locator(context) {
    const chat = context.getCurrentChatId();
    if (!chat) throw new Error('Open a saved chat before translating messages.');
    if (context.groupId != null) return { group: true, chat };
    const avatar = context.characters?.[context.characterId]?.avatar;
    if (!avatar) throw new Error('The selected character is unavailable.');
    return { group: false, avatar, chat };
}

function selectedMessage(context, index) {
    const row = context.chat[index];
    if (!row) throw new Error('The selected message no longer exists.');
    return { index, original: row.mes, swipeId: row.swipe_id ?? null, reasoning: row.extra?.reasoning ?? null };
}

async function displaySaved(record, owner, observedChat) {
    if (getCurrentUserHandle() !== owner) return;
    let current;
    try { current = locator(getContext()); } catch { return; }
    if (JSON.stringify(current) !== JSON.stringify(record.result?.locator)) return;
    if (document.querySelector('#chat .mes_edit_textarea') || observedChat !== undefined && JSON.stringify(getContext().chat) !== observedChat) {
        toastr.info('The translation is saved. Your newer chat edits are still open.');
        return;
    }
    refreshing++;
    try { await reloadCurrentChat(); } finally { refreshing--; }
}

export async function translateSaved(input, { signal, automatic = false } = {}) {
    const owner = getCurrentUserHandle();
    const context = getContext();
    const capturedLocator = locator(context);
    const selected = input.index == null ? null : selectedMessage(context, Number(input.index));
    const body = { ...input, locator: capturedLocator, ...(selected ? { message: selected } : {}) };
    delete body.index;
    const scope = `translation:${JSON.stringify(capturedLocator)}:${selected?.index ?? 'chat'}:${input.mode}:${(input.fields ?? []).join(',')}`;
    const activeKey = `${owner}:${scope}`;
    if (active.has(activeKey)) return active.get(activeKey);
    const promise = (async () => {
        const client = await getOperationClient();
        let observedChat = JSON.stringify(getContext().chat);
        const record = await client.run('translation', body, { scope, signal, prepareInput: async value => {
            if (getCurrentUserHandle() !== owner || JSON.stringify(locator(getContext())) !== JSON.stringify(capturedLocator)
                || selected && JSON.stringify(selectedMessage(getContext(), selected.index)) !== JSON.stringify(selected)) {
                throw new Error('The selected chat, message or swipe changed before translation was accepted.');
            }
            if (!automatic && !await saveSettings(0, { returnResult: true })) throw new Error('Save the translation settings before translating.');
            await saveChatConditional({ throwOnError: true, throwOnPromptError: true });
            if (getCurrentUserHandle() !== owner || JSON.stringify(locator(getContext())) !== JSON.stringify(capturedLocator)
                || selected && JSON.stringify(selectedMessage(getContext(), selected.index)) !== JSON.stringify(selected)) {
                throw new Error('The selected chat, message or swipe changed while it was being saved.');
            }
            observedChat = JSON.stringify(getContext().chat);
            return value;
        } });
        await displaySaved(record, owner, observedChat);
        return record.result;
    })();
    active.set(activeKey, promise);
    try { return await promise; } finally { active.delete(activeKey); }
}

export async function translateText(text, target, provider, { signal } = {}) {
    if (!text) return '';
    const client = await getOperationClient();
    const record = await client.run('translation', { mode: 'text', text, target, ...(provider ? { provider } : {}) }, {
        scope: 'translation:text', signal,
        prepareInput: async value => {
            if (!await saveSettings(0, { returnResult: true })) throw new Error('Save the translation settings before translating.');
            return value;
        },
    });
    return record.result.text;
}

/** Completed results and interrupted observations remain available after reopening the application. */
export function mountSavedTranslations(container) {
    const wrapper = document.createElement('div');
    const label = document.createElement('label'); label.textContent = 'Saved translations';
    const select = document.createElement('select'); select.className = 'text_pole'; select.setAttribute('aria-label', 'Saved translations');
    const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'menu_button'; stop.textContent = 'Stop translation'; stop.style.display = 'none';
    const output = document.createElement('textarea'); output.className = 'text_pole'; output.readOnly = true; output.setAttribute('aria-label', 'Saved translation result');
    const status = document.createElement('span'); status.setAttribute('role', 'status');
    label.append(select); wrapper.append(label, stop, output, status); container.append(wrapper);
    const owner = getCurrentUserHandle();
    const ready = getOperationClient();
    mountOperationRecovery(wrapper, { onError: error => { status.textContent = error.message; } });
    let controller;
    let listing = false;
    const refresh = async () => {
        if (listing || controller) return;
        listing = true;
        try {
            const records = await (await ready).list('translation');
            const selected = select.value;
            select.replaceChildren(new Option('Choose saved work', ''), ...records.map(record =>
                new Option(`${new Date(record.createdAt).toLocaleString()} · ${record.state}`, record.key)));
            select.value = selected;
        } catch (error) { status.textContent = error.message; } finally { listing = false; }
    };
    stop.addEventListener('click', () => controller?.abort('user-stop'));
    select.addEventListener('focus', () => { void refresh(); });
    select.addEventListener('change', async () => {
        if (!select.value || controller) return;
        controller = new AbortController(); select.disabled = true; stop.style.display = '';
        try {
            const client = await ready;
            const record = await client.observe(await client.read(select.value), { signal: controller.signal,
                onProgress: progress => { status.textContent = progress?.stage || 'Translation is running on the server.'; } });
            output.value = record.result.text ?? `${record.result.count} saved messages updated.`;
            status.textContent = 'Saved translation loaded.';
            await displaySaved(record, owner);
        } catch (error) { status.textContent = error.cancelled ? 'Translation stopped.' : error.message; } finally { controller = null; select.disabled = false; stop.style.display = 'none'; }
    });
    void refresh();
}
