import { chat, characters, this_chid, getCurrentChatId, getRequestHeaders, saveSettings, saveChatConditional, refreshCurrentChatFromSaved } from '../script.js';
import { power_user } from './power-user.js';
import { selected_group } from './group-chats.js';
import { getCurrentUserHandle } from './user.js';
import { roleplayAccountStamp } from './roleplay-save-chain.js';
import { Popup, POPUP_TYPE } from './popup.js';

const label = { include: 'Send the image', 'display-only': 'Show only', caption: 'Use a description', detach: 'Detach from message' };
function element(tag, text = '', className = '') {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function button(text, action) {
    const node = element('button', text, 'menu_button'); node.type = 'button'; node.addEventListener('click', action); return node;
}
function locator() {
    const name = getCurrentChatId();
    if (!name) return null;
    return { group: Boolean(selected_group), chat: String(name).replace(/\.jsonl$/, ''), ...(!selected_group ? { avatar: characters[this_chid]?.avatar } : {}) };
}
const sameLocator = value => JSON.stringify(value) === JSON.stringify(locator());
const currentAccount = () => ({ owner: getCurrentUserHandle(), account: roleplayAccountStamp().account });
function requireAccount(captured) {
    if (captured.owner !== getCurrentUserHandle() || JSON.stringify(captured.account) !== JSON.stringify(roleplayAccountStamp().account)) throw new Error('The account changed. Reopen image review.');
}
async function request(action, body, captured, { binary = false } = {}) {
    requireAccount(captured);
    const response = await fetch(`/api/roleplay/images/${action}`, { method: 'POST', headers: { ...getRequestHeaders(),
        'Content-Type': 'application/json', 'X-Neconyan-Account': captured.owner }, body: JSON.stringify({ ...body, account: captured.account }) });
    requireAccount(captured);
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || 'Image review could not finish.'); }
    return binary ? response.blob() : response.json();
}
async function setAccountChoice(checked) {
    const account = getCurrentUserHandle(), before = power_user.neconyan_prompt_media;
    const choice = { version: 1, images: checked ? 'display-only' : 'include' };
    power_user.neconyan_prompt_media = choice;
    try {
        if (!await saveSettings(0, { returnResult: true })) throw new Error('The image preference was not saved.');
        if (account !== getCurrentUserHandle()) throw new Error('The account changed.');
        document.querySelectorAll('[data-prompt-images-account]').forEach(node => { node.checked = checked; });
    } catch (error) {
        if (account === getCurrentUserHandle() && power_user.neconyan_prompt_media === choice) {
            if (before === undefined) delete power_user.neconyan_prompt_media; else power_user.neconyan_prompt_media = before;
        }
        throw error;
    }
}
function checkbox(text, checked, action) {
    const row = element('label', '', 'checkbox_label');
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked;
    input.addEventListener('change', async () => {
        input.disabled = true;
        try { await action(input.checked); } catch (error) { input.checked = !input.checked; toastr.error(error.message); } finally { input.disabled = false; }
    });
    row.append(input, element('span', text)); return { row, input };
}
function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function compatibleCopy(blob) {
    if (blob.size > 16 * 1024 * 1024) throw new Error('Choose an image smaller than 16 MiB.');
    const bytes = await blob.arrayBuffer();
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./prompt-image-conversion-worker.js', import.meta.url), { type: 'module' });
        const finish = () => { clearTimeout(timer); worker.terminate(); };
        const timer = setTimeout(() => { finish(); reject(new Error('Image conversion exceeded 15 seconds. Choose a smaller file.')); }, 15000);
        worker.onerror = () => { finish(); reject(new Error('This browser could not convert the image. Choose a compatible replacement.')); };
        worker.onmessage = ({ data }) => { finish(); if (data.error) reject(new Error(data.error)); else resolve(data); };
        worker.postMessage({ bytes }, [bytes]);
    });
}
async function remoteBlob(url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Choose a normal HTTP image link or a local replacement.');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(parsed.href, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal });
        if (!response.ok || !response.body || Number(response.headers.get('Content-Length')) > 16 * 1024 * 1024) throw new Error('The external image could not be downloaded within the size limit. Choose a local replacement.');
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
            while (true) {
                const { value, done } = await reader.read(); if (done) break;
                size += value.byteLength;
                if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new Error('The external image exceeds 16 MiB.'); }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
        return new Blob(chunks);
    } finally { clearTimeout(timer); }
}
function blobData(blob) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
}
/** No image is fetched simply by opening this screen. */
export async function showPromptMediaReview(initialLocator = locator()) {
    if (document.body.classList.contains('neconyan-conversation-active')) return showConversationPromptMediaReview();
    const captured = currentAccount();
    const panel = element('div', '', 'flex-container flexFlowColumn'); panel.id = 'prompt-media-review';
    panel.append(element('h3', 'Images in replies'), element('p', 'Show only keeps pictures visible and leaves their files and attachment descriptions out of new replies.'));
    const explanation = element('details'); explanation.append(element('summary', 'What this choice covers'), element('p', 'Existing message text and memory are unchanged. Accepted work keeps its original input; use Stop to cancel it. Manual image descriptions and explicit tool reference images are separate actions. Independent extensions may have their own input controls.')); panel.append(explanation);
    const accountChoice = checkbox('Keep chat images display-only across this account', power_user.neconyan_prompt_media?.images === 'display-only', setAccountChoice);
    accountChoice.input.dataset.promptImagesAccount = 'true'; panel.append(accountChoice.row);
    const status = element('p'); status.setAttribute('role', 'status'); panel.append(status);
    const navigation = element('div', '', 'flex-container flexWrap'), content = element('div', '', 'flex-container flexFlowColumn'); panel.append(navigation, content);
    let busy = false, closed = false, page = null, pending = null;
    const run = async action => {
        if (busy || closed) return; busy = true; status.textContent = 'Working…';
        panel.querySelectorAll('button').forEach(node => { node.disabled = true; });
        try { requireAccount(captured); await action(); } catch (error) { status.textContent = error.message; } finally { busy = false; panel.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
    };
    const apply = async (actions, extra = {}) => {
        if (!page) return;
        const requestBody = { observation: page.observation, actions, ...extra };
        const signature = JSON.stringify(requestBody);
        if (!pending || pending.signature !== signature) pending = { signature, body: { ...requestBody, key: crypto.randomUUID() } };
        const beforeLocal = JSON.stringify(chat);
        const result = await request(extra.materialisedImage ? 'materialise' : 'apply', pending.body, captured);
        pending = null;
        if (sameLocator(page.observation.locator) && beforeLocal === JSON.stringify(chat)) await refreshCurrentChatFromSaved();
        status.textContent = 'Saved. The original chat is backed up; Recovery history offers export and undo.';
        await showChat(page.observation.locator, 0, false);
        return result;
    };
    const prepare = async (issue, file) => {
        let blob = file;
        if (!blob) {
            const source = await request('source', { observation: page.observation, identity: issue.identity }, captured);
            if (source.base64) blob = new Blob([Uint8Array.from(atob(source.base64), char => char.charCodeAt(0))]);
            else if (source.url.startsWith('data:')) {
                const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(source.url);
                if (!match || match[1].length > 4 * Math.ceil(16 * 1024 * 1024 / 3)) throw new Error('This embedded image needs a local replacement.');
                blob = new Blob([Uint8Array.from(atob(match[1]), char => char.charCodeAt(0))]);
            } else {
                if (!await Popup.show.confirm('Download this external image?', 'Your browser will contact its website without account credentials or a referrer. If the website refuses access, choose a local replacement.')) return;
                blob = await remoteBlob(source.url);
            }
        }
        const converted = await compatibleCopy(blob), preview = element('div');
        const img = document.createElement('img'), url = URL.createObjectURL(converted.blob); img.src = url; img.alt = 'Prepared prompt copy'; img.className = 'wide100p';
        const adopt = checkbox('Use this copy as the new displayed image and source', false, () => {});
        preview.append(adopt.row, img, element('p', `${converted.originalWidth} × ${converted.originalHeight} → ${converted.width} × ${converted.height}; ${converted.blob.type}; ${Math.ceil(converted.blob.size / 1024)} KiB. The original picture remains displayed.`));
        try {
            preview.prepend(element('h3', 'Save this prompt copy?'));
            if (!await new Popup(preview, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true, okButton: 'Save copy', cancelButton: 'Cancel' }).show()) return;
            await apply([{ ...issue, mode: issue.mode, saveCopy: true, adoptCopy: adopt.input.checked, ...(issue.caption ? { caption: issue.caption } : {}) }], { materialisedImage: { identity: issue.identity, data: await blobData(converted.blob) } });
        } finally { URL.revokeObjectURL(url); }
    };
    const showChat = async (target, offset = 0, save = true) => {
        if (save && sameLocator(target) && !await saveChatConditional()) throw new Error('Save the current chat before reviewing its images.');
        const next = await request('scan', { locator: target, offset, ...(offset && page ? { observation: page.observation } : {}) }, captured);
        if (closed) return; page = next; content.replaceChildren();
        content.append(element('h4', target.chat), element('p', `${next.total} attachment locations. ${next.limited ? 'The report is limited to 10,000 locations.' : 'The inventory does not contact image websites.'}`));
        const chatChoice = checkbox('Keep images display-only in this chat', next.chatPreference?.images === 'display-only', checked => run(() => apply([], { chatPreference: { version: 1, images: checked ? 'display-only' : 'include' } })));
        content.append(chatChoice.row);
        if (power_user.neconyan_prompt_media?.images === 'display-only') content.append(element('p', 'The account setting keeps these images display-only, whatever their individual choices.'));
        content.append(element('p', 'An unrelated message title, text already copied into a message, and saved memory remain text. Sending an image also requires Send inline media and a compatible connection.'));
        const chosen = new Map();
        for (const issue of next.issues) {
            const row = element('fieldset', '', 'flex-container flexFlowColumn');
            row.append(element('legend', `Message ${issue.index + 1}${issue.swipe === null ? '' : `, alternative ${issue.swipe + 1}`}${issue.mediaIndex < 0 ? '' : `, image ${issue.mediaIndex + 1}`}`));
            row.append(element('p', issue.status.replaceAll('-', ' ') + (issue.title ? `: ${issue.title}` : '')));
            if (!issue.actions.length) { row.append(element('p', 'Audio and video retain their existing controls.')); content.append(row); continue; }
            const select = element('select', '', 'text_pole'); select.setAttribute('aria-label', 'Image input choice');
            for (const mode of issue.actions) { const option = element('option', label[mode]); option.value = mode; select.append(option); }
            select.value = issue.actions.includes(issue.mode) ? issue.mode : issue.actions[0];
            const captionSource = element('select', '', 'text_pole'); captionSource.setAttribute('aria-label', 'Description source');
            for (const [value, name] of [['custom', 'Enter a description'], ['media-title', 'Saved image description'], ['message-title', 'Saved message title']]) {
                const option = element('option', name); option.value = value; captionSource.append(option);
            }
            const text = element('textarea', '', 'text_pole'); text.placeholder = 'Description to use in future replies'; text.setAttribute('aria-label', text.placeholder);
            if (issue.caption) { captionSource.value = issue.caption.source; text.value = issue.caption.text ?? ''; }
            const describe = () => { captionSource.hidden = text.hidden = select.value !== 'caption'; };
            select.addEventListener('change', describe); describe();
            const action = () => ({ index: issue.index, swipe: issue.swipe, mediaIndex: issue.mediaIndex, identity: issue.identity, mode: select.value,
                ...(select.value === 'caption' ? { caption: { source: captionSource.value, ...(captionSource.value === 'custom' ? { text: text.value } : {}) } } : {}) });
            const selection = checkbox('Select for batch change', false, checked => { if (checked) chosen.set(issue.identity, action); else chosen.delete(issue.identity); });
            row.append(selection.row, select, captionSource, text, button('Save choice', () => run(async () => {
                if (select.value === 'detach' && !await Popup.show.confirm('Detach this attachment?', 'The saved original image file is retained. The chat backup can restore the reference.')) return;
                await apply([action()]);
            })));
            if (issue.status === 'embedded-image') row.append(button('Save exact compatible copy', () => run(() => apply([{ ...action(), saveCopy: true }]))));
            if (issue.hasPromptCopy) row.append(button('Use saved copy as the new source', () => run(async () => {
                if (!await Popup.show.confirm('Use the saved copy as this image?', 'This explicitly replaces the displayed reference. The original file is retained, and the chat backup can restore its reference.')) return;
                await apply([{ ...action(), adoptCopy: true }]);
            })));
            if (issue.status === 'invalid-gallery-selection') row.append(button('Select this gallery image', () => run(() => apply([{ ...action(), selectGallery: true }]))));
            if (issue.proposedSource) {
                let proposed;
                try { proposed = new URL(issue.proposedSource); } catch { proposed = null; }
                if (proposed?.origin === location.origin && !proposed.username && !proposed.password && !proposed.search && !proposed.hash && proposed.pathname.startsWith('/user/images/')) {
                    row.append(button('Use the matching image on this server', () => run(async () => {
                        if (!await Popup.show.confirm('Use this account image?', `Replace the saved full address with ${proposed.pathname}? The server checks that this account file exists and is compatible.`)) return;
                        await apply([{ ...action(), localUrl: proposed.pathname }]);
                    })));
                }
            }
            if (issue.mediaIndex >= 0) {
                row.append(button('Preview compatible copy', () => run(() => prepare(issue))));
                const uploadLabel = element('label', 'Or choose a replacement for the prompt copy');
                const upload = document.createElement('input'); upload.type = 'file'; upload.accept = 'image/png,image/jpeg,image/webp';
                upload.addEventListener('change', () => { if (upload.files[0]) void run(() => prepare(issue, upload.files[0])); }); uploadLabel.append(upload); row.append(uploadLabel);
            }
            content.append(row);
        }
        content.append(button('Save selected choices', () => run(async () => {
            const actions = [...chosen.values()].map(action => action());
            if (!actions.length) throw new Error('Select at least one image.');
            if (actions.some(action => action.mode === 'detach') && !await Popup.show.confirm('Detach selected attachments?', 'Original image files are retained.')) return;
            await apply(actions);
        })));
        content.append(button('Save exact copies of selected embedded images', () => run(async () => {
            const actions = [...chosen.entries()].map(([identity, action]) => {
                if (next.issues.find(issue => issue.identity === identity)?.status !== 'embedded-image') throw new Error('For this action, select only embedded images. Other images need an individual preview.');
                return { ...action(), saveCopy: true };
            });
            if (!actions.length) throw new Error('Select at least one embedded image.');
            await apply(actions);
        })));
        status.textContent = 'Review ready.';
        if (next.next !== null) content.append(button('Next images', () => run(() => showChat(target, next.next, false))));
    };
    const showLibrary = async (offset = 0) => {
        const list = await request('chats', { offset }, captured); content.replaceChildren();
        content.append(element('h4', 'Selected chats'), element('p', 'Each selected chat is saved separately with its own backup. A failed chat does not undo completed chats.'));
        const chosen = new Map();
        for (const target of list.chats) {
            const key = JSON.stringify(target), row = element('div', '', 'flex-container flexWrap');
            row.append(checkbox(`${target.group ? 'Group' : target.avatar.replace(/\.png$/, '')}: ${target.chat}`, false, checked => { if (checked) chosen.set(key, target); else chosen.delete(key); }).row,
                button('Review', () => run(() => showChat(target)))); content.append(row);
        }
        content.append(button('Keep selected chats display-only', () => run(async () => {
            if (!chosen.size) throw new Error('Select at least one chat.');
            if (!await Popup.show.confirm('Keep images display-only in these chats?', `${chosen.size} chats will receive a reversible preference. Their image files and attachment descriptions will not enter new automatic replies.`)) return;
            const results = [];
            for (const target of chosen.values()) {
                if (closed) break;
                try {
                    if (sameLocator(target) && !await saveChatConditional()) throw new Error('Current chat could not be saved.');
                    const beforeLocal = JSON.stringify(chat);
                    const scan = await request('scan', { locator: target }, captured);
                    await request('apply', { key: crypto.randomUUID(), observation: scan.observation, actions: [], chatPreference: { version: 1, images: 'display-only' } }, captured);
                    if (sameLocator(target) && beforeLocal === JSON.stringify(chat)) await refreshCurrentChatFromSaved();
                    results.push(`${target.chat}: saved`);
                } catch (error) { results.push(`${target.chat}: ${error.message}`); }
                status.textContent = results.join(' / ');
            }
        })));
        content.append(button('Save exact embedded-image copies in selected chats', () => run(async () => {
            if (!chosen.size) throw new Error('Select at least one chat.');
            if (!await Popup.show.confirm('Save compatible copies in these chats?', 'Each chat is saved separately with a backup. Existing image input choices and displayed originals are kept. A chat containing unsupported images or more than 128 embedded images needs individual review.')) return;
            const results = [];
            for (const target of chosen.values()) {
                if (closed) break;
                try {
                    if (sameLocator(target) && !await saveChatConditional()) throw new Error('Current chat could not be saved.');
                    const beforeLocal = JSON.stringify(chat);
                    let scan = await request('scan', { locator: target }, captured);
                    const observation = scan.observation, actions = [];
                    if (scan.limited) throw new Error('Too many attachments for collection repair. Review this chat individually.');
                    while (true) {
                        for (const issue of scan.issues) if (issue.status === 'embedded-image') {
                            actions.push({ index: issue.index, swipe: issue.swipe, mediaIndex: issue.mediaIndex, identity: issue.identity,
                                mode: issue.mode, ...(issue.caption ? { caption: issue.caption } : {}), saveCopy: true });
                        }
                        if (actions.length > 128) throw new Error('More than 128 embedded images. Select a smaller group in this chat.');
                        if (scan.next === null) break;
                        scan = await request('scan', { locator: target, observation, offset: scan.next }, captured);
                    }
                    if (!actions.length) { results.push(`${target.chat}: no embedded images selected`); continue; }
                    await request('apply', { key: crypto.randomUUID(), observation, actions }, captured);
                    if (sameLocator(target) && beforeLocal === JSON.stringify(chat)) await refreshCurrentChatFromSaved();
                    results.push(`${target.chat}: ${actions.length} copies saved`);
                } catch (error) { results.push(`${target.chat}: ${error.message}`); }
                status.textContent = results.join(' / ');
            }
        })));
        if (list.next !== null) content.append(button('Next chats', () => run(() => showLibrary(list.next))));
    };
    const showHistory = async (offset = 0) => {
        const history = await request('history', { offset }, captured); content.replaceChildren(element('h4', 'Recovery history'));
        for (const operation of history.operations) {
            const row = element('fieldset'); row.append(element('legend', operation.locator?.chat ?? 'Unfinished staging'), element('p', `${operation.createdAt ?? ''} ${operation.stage}`));
            if (operation.phase === 'prepared' && operation.stage !== 'committed') row.append(button('Resume saved repair', () => run(async () => {
                await request('resume', { id: operation.id }, captured); await showHistory(offset);
                status.textContent = 'The saved repair result was recovered. Reopen the chat to see its saved state.';
            })));
            if (['staging', 'aborting'].includes(operation.phase)) row.append(button('Discard unstarted repair', () => run(async () => {
                if (!await Popup.show.confirm('Discard this unstarted repair?', 'Only verified preparation files will be removed. Your chat and its original images are kept. Start a new repair afterwards if needed.')) return;
                await request('discard', { id: operation.id }, captured); await showHistory(offset);
                status.textContent = 'Unstarted repair discarded.';
            })));
            if (operation.backupAvailable) {
                row.append(button('Export original chat', () => run(async () => download(await request('backup/export', { id: operation.id }, captured, { binary: true }), 'chat-before-image-repair.jsonl'))),
                    button('Undo repair', () => run(async () => {
                        if (!await Popup.show.confirm('Restore the original references?', 'Undo is refused if this chat has changed since the repair. Missing original images may still be missing.')) return;
                        const beforeLocal = JSON.stringify(chat);
                        const scan = await request('scan', { locator: operation.locator }, captured);
                        await request('apply', { key: `undo:${operation.id}`, observation: scan.observation, undoOf: operation.id }, captured);
                        if (sameLocator(operation.locator) && beforeLocal === JSON.stringify(chat)) await refreshCurrentChatFromSaved();
                        status.textContent = 'Original references restored.'; await showHistory(offset);
                    })), button('Remove backup', () => run(async () => {
                        if (!await Popup.show.confirm('Remove this completed backup?', 'This ends undo availability. Original and published image files are retained. Export first if you need a copy.')) return;
                        await request('backup/remove', { id: operation.id }, captured); await showHistory(offset);
                    })));
            }
            content.append(row);
        }
        if (history.next !== null) content.append(button('Next repairs', () => run(() => showHistory(history.next))));
    };
    if (initialLocator) navigation.append(button('Current chat', () => run(() => showChat(initialLocator))));
    navigation.append(button('Choose chats', () => run(() => showLibrary())), button('Recovery history', () => run(() => showHistory())));
    const popup = new Popup(panel, POPUP_TYPE.TEXT, '', { wide: true, large: true, leftAlign: true, allowVerticalScrolling: true,
        okButton: 'Close', onClose: () => { closed = true; } });
    const shown = popup.show();
    if (initialLocator) void run(() => showChat(initialLocator)); else status.textContent = 'Choose chats to review, or change the account preference above.';
    await shown;
}
export function initPromptMediaControls() {
    const input = document.getElementById('prompt-images-account');
    if (input) {
        input.checked = power_user.neconyan_prompt_media?.images === 'display-only'; input.dataset.promptImagesAccount = 'true';
        input.addEventListener('change', async () => { input.disabled = true; try { await setAccountChoice(input.checked); } catch (error) { input.checked = !input.checked; toastr.error(error.message); } finally { input.disabled = false; } });
    }
    document.getElementById('prompt-images-review')?.addEventListener('click', () => { void showPromptMediaReview().catch(error => toastr.error(error.message)); });
    globalThis.addEventListener('neconyan:image-input-refused', () => {
        toastr.warning('Review image input choices to keep pictures display-only, use a description, or prepare a compatible copy.', 'Image input needs attention', {
            onclick: () => { void showPromptMediaReview().catch(error => toastr.error(error.message)); }, timeOut: 12000,
        });
    });
}

/** Conversation choices use its existing versioned store writer; Roleplay repair never rewrites that store. */
async function showConversationPromptMediaReview() {
    const context = await import('./neconyan-conversation/context.js');
    const sync = await import('./neconyan-conversation/store-sync.js');
    const { promptAttachmentHash, generatedImagePromptPolicy } = await import('./prompt-media-client.js');
    const captured = currentAccount(), avatar = context.getCurrentCharAvatar();
    const branch = context.getActiveConversationBranch(avatar, { create: false });
    if (!branch) throw new Error('Open a Conversation chat to review its image input.');
    const panel = element('div', '', 'flex-container flexFlowColumn'); panel.id = 'prompt-media-review';
    panel.append(element('h3', 'Images in this Conversation'), element('p', 'Show only keeps pictures visible and excludes their files and attachment descriptions from new automatic replies. Existing message text and memory stay unchanged.'));
    const accountChoice = checkbox('Keep images display-only across this account', power_user.neconyan_prompt_media?.images === 'display-only', setAccountChoice);
    accountChoice.input.dataset.promptImagesAccount = 'true'; panel.append(accountChoice.row);
    const branchIdentity = { id: branch.id, lifetimeSeed: branch.lifetimeSeed };
    const currentBranch = () => {
        const current = context.getActiveConversationBranch(avatar, { create: false });
        if (!current || current.id !== branchIdentity.id || current.lifetimeSeed !== branchIdentity.lifetimeSeed) throw new Error('The Conversation chat changed. Reopen image review.');
        return current;
    };
    const currentMessage = (current, id) => {
        const matches = current.messages.filter(item => item.id === id);
        if (matches.length !== 1) throw new Error('This message changed. Reopen image review.');
        return matches[0];
    };
    let saving = false;
    const save = async change => {
        if (saving) throw new Error('Wait for the current choice to finish saving.');
        requireAccount(captured);
        saving = true; panel.setAttribute('aria-busy', 'true');
        panel.querySelectorAll('button, input, select, textarea').forEach(node => { node.disabled = true; });
        let undo;
        try {
            if (!await sync.flushConversationStore()) throw new Error('Pending Conversation changes could not be saved.');
            requireAccount(captured);
            undo = change(currentBranch());
            context.persistConversationStore();
            if (!await sync.flushConversationStore()) throw new Error('The Conversation choice was not saved.');
            requireAccount(captured);
            toastr.success('Image input choice saved.');
        } catch (error) { undo?.(); throw error; } finally {
            saving = false; panel.setAttribute('aria-busy', 'false');
            panel.querySelectorAll('button, input, select, textarea').forEach(node => { node.disabled = false; });
        }
    };
    panel.append(checkbox('Keep images display-only in this Conversation branch', branch.neconyan_prompt_media?.images === 'display-only', checked => save(current => {
        const before = current.neconyan_prompt_media, next = { version: 1, images: checked ? 'display-only' : 'include' };
        current.neconyan_prompt_media = next;
        return () => { if (current.neconyan_prompt_media === next) { if (before === undefined) delete current.neconyan_prompt_media; else current.neconyan_prompt_media = before; } };
    })).row);
    if (power_user.neconyan_prompt_media?.images === 'display-only') panel.append(element('p', 'The account setting overrides individual image choices.'));
    for (const [index, message] of branch.messages.entries()) {
        const extra = message.extra ?? {};
        const media = [...(Array.isArray(extra.media) ? extra.media.map((item, mediaIndex) => ({ item, mediaIndex })) : []),
            ...(extra.image_url ? [{ item: { url: extra.image_url, type: 'image', title: extra.image_prompt || 'Generated image', neconyan_prompt: extra.neconyan_image_prompt }, mediaIndex: null }] : [])];
        for (const { item, mediaIndex } of media.filter(({ item }) => (item?.type ?? 'image') === 'image')) {
            const row = element('fieldset', '', 'flex-container flexFlowColumn'); row.append(element('legend', `Message ${index + 1}, image ${mediaIndex === null ? 'generated' : mediaIndex + 1}`));
            const select = element('select', '', 'text_pole'); select.setAttribute('aria-label', 'Image input choice');
            for (const mode of ['display-only', 'caption', 'include']) { const option = element('option', label[mode]); option.value = mode; select.append(option); }
            select.value = item.neconyan_prompt?.mode ?? 'include';
            const text = element('textarea', '', 'text_pole'); text.setAttribute('aria-label', 'Reviewed image description'); text.placeholder = 'Enter or review the description to use';
            text.value = item.neconyan_prompt?.caption?.text ?? item.title ?? '';
            const update = () => { text.hidden = select.value !== 'caption'; }; select.addEventListener('change', update); update();
            let originalHash = promptAttachmentHash(extra);
            row.append(select, text, button('Save choice', async () => {
                try {
                    await save(current => {
                        const message = currentMessage(current, branch.messages[index].id);
                        if (promptAttachmentHash(message.extra ?? {}) !== originalHash) throw new Error('This message changed. Reopen image review.');
                        if (select.value === 'caption' && (!text.value.trim() || new TextEncoder().encode(text.value).length > 16384)) throw new Error('Enter a description of at most 16 KiB.');
                        const before = message.extra, next = structuredClone(before ?? {});
                        const policy = generatedImagePromptPolicy(item, select.value).neconyan_prompt;
                        if (select.value === 'caption') policy.caption = { source: 'custom', text: text.value };
                        if (mediaIndex === null) next.neconyan_image_prompt = policy; else next.media[mediaIndex].neconyan_prompt = policy;
                        message.extra = next;
                        return () => { if (message.extra === next) message.extra = before; };
                    });
                    originalHash = promptAttachmentHash(currentMessage(currentBranch(), message.id).extra ?? {});
                } catch (error) { toastr.error(error.message); }
            })); panel.append(row);
        }
        if (extra.conversation_attachment_context || extra.conversation_reply_to?.attachmentSummary || extra.conversation_reply_to?.text) {
            const row = element('fieldset', '', 'flex-container flexFlowColumn'); row.append(element('legend', `Message ${index + 1}: older attachment and quoted context`),
                element('p', 'Older saved context may mix image descriptions and extracted file text. If its source cannot be verified, Show only requires your review. Omitting it also omits its extracted file context; the displayed message and reference remain unchanged.'));
            const text = element('textarea', '', 'text_pole'); text.setAttribute('aria-label', 'Reviewed replacement context'); text.placeholder = 'Text to use instead of the ambiguous attachment context';
            const sourceHash = promptAttachmentHash([extra.conversation_attachment_context ?? '', extra.conversation_reply_to ?? null]);
            const choose = async mode => {
                try {
                    await save(currentBranch => {
                        const message = currentMessage(currentBranch, branch.messages[index].id);
                        const current = message.extra ?? {};
                        if (promptAttachmentHash([current.conversation_attachment_context ?? '', current.conversation_reply_to ?? null]) !== sourceHash) throw new Error('This attachment context changed. Reopen its review.');
                        if (new TextEncoder().encode(text.value).length > 16384) throw new Error('Use at most 16 KiB of replacement context.');
                        const before = message.extra, next = { ...current, neconyan_image_context: { version: 1, source_hash: sourceHash, mode,
                            ...(mode === 'replace' ? { text: text.value } : {}) } };
                        message.extra = next; return () => { if (message.extra === next) message.extra = before; };
                    });
                } catch (error) { toastr.error(error.message); }
            };
            row.append(text, button('Use reviewed context', () => choose('replace')), button('Omit this derived context', async () => {
                if (await Popup.show.confirm('Omit this saved derived context?', 'This also omits extracted file context in the same field. Authored message text is retained.')) await choose('omit');
            })); panel.append(row);
        }
    }
    await new Popup(panel, POPUP_TYPE.TEXT, '', { wide: true, large: true, leftAlign: true, allowVerticalScrolling: true, okButton: 'Close' }).show();
}
