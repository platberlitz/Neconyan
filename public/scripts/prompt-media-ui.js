import { chat, characters, this_chid, getCurrentChatId, getRequestHeaders, saveSettings, saveChatConditional, refreshCurrentChatFromSaved } from '../script.js';
import { power_user } from './power-user.js';
import { selected_group } from './group-chats.js';
import { getCurrentUserHandle } from './user.js';
import { roleplayAccountStamp } from './roleplay-save-chain.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { t, translate } from './i18n.js';
import { escapeToastText, twoLineToastHtml } from './toast-lines.js';
import { IMAGE_INPUT_SETTINGS_CHANGED } from './prompt-media-policy.js';
import { batchResultText, conversationContextLegend, conversationImageLegend, conversationQuoteLegend, descriptionSourceOptions, fillTemplate, formatChangeDate,
    historyStageLabel, reviewLegend, reviewStatusLabel, savedDescriptionLabel, splitAtHole, workerErrorMessage } from './prompt-media-labels.js';

// Looked up when a dialog is built, so the names follow the interface language chosen by then.
const choiceName = mode => ({
    include: translate('Send the image', 'scoped.prompt_media.QIG-03'),
    'display-only': translate('Show only', 'scoped.prompt_media.QIG-02'),
    caption: translate('Use a description', 'scoped.prompt_media.QIG-04'),
    detach: translate('Remove from message', 'scoped.prompt_media.RVW-47'),
})[mode];
// Text already looked up by its key. Marked so the run-time localiser cannot match it again or capture a word of it.
function final(node) { node.setAttribute('data-i18n-ignore', ''); return node; }
// Every piece of text given here has been looked up by the caller, so its element is final. A name, a description, a path or a
// server detail goes through authored() instead.
function element(tag, text = '', className = '') {
    const node = document.createElement(tag); node.textContent = text; node.className = className;
    if (text !== '') final(node);
    return node;
}
// A value somebody wrote (a chat name, a character file name, an image description, a path, a server detail) in its own
// element, so no translation reaches it and it is never part of a phrase that could be translated around it.
function authored(tag, text, className = '') {
    const node = document.createElement(tag); node.textContent = String(text ?? ''); node.className = className; node.setAttribute('translate', 'no'); return node;
}
// A toast whose text is already final.
function toast(kind, message) {
    const shown = toastr[kind](String(message ?? ''));
    shown?.find?.('.toast-message, .toast-title').attr('data-i18n-ignore', '');
    return shown;
}
// Quick Image Gen's 'Right now' line listens for this, so it follows the account, chat and branch choices made here.
const announceSettingsChanged = () => globalThis.dispatchEvent(new CustomEvent(IMAGE_INPUT_SETTINGS_CHANGED));
function choiceOption(mode) {
    const option = element('option', choiceName(mode)); option.value = mode;
    return option;
}
function button(text, action) {
    const node = element('button', text, 'menu_button'); node.type = 'button'; node.addEventListener('click', action); return node;
}
// A button with a short label and, directly beneath it, one brief line that is its accessible description. The caller looks up both texts. The block
// wrapper keeps the dialog's column gap between pairs, not inside one.
let noteCounter = 0;
function buttonWithNote(text, note, action) {
    const node = button(text, action), line = element('p', note, 'prompt-media-note'), id = `prompt-media-note-${++noteCounter}`;
    line.id = id; node.setAttribute('aria-describedby', id);
    const pair = element('div'); pair.append(node, line);
    return pair;
}
function locator() {
    const name = getCurrentChatId();
    if (!name) return null;
    return { group: Boolean(selected_group), chat: String(name).replace(/\.jsonl$/, ''), ...(!selected_group ? { avatar: characters[this_chid]?.avatar } : {}) };
}
const sameLocator = value => JSON.stringify(value) === JSON.stringify(locator());
const currentAccount = () => ({ owner: getCurrentUserHandle(), account: roleplayAccountStamp().account });
function requireAccount(captured) {
    if (captured.owner !== getCurrentUserHandle() || JSON.stringify(captured.account) !== JSON.stringify(roleplayAccountStamp().account)) throw new Error(t`You switched accounts. Close this window and open it again.`);
}
async function request(action, body, captured, { binary = false } = {}) {
    requireAccount(captured);
    const response = await fetch(`/api/roleplay/images/${action}`, { method: 'POST', headers: { ...getRequestHeaders(),
        'Content-Type': 'application/json', 'X-Neconyan-Account': captured.owner }, body: JSON.stringify({ ...body, account: captured.account }) });
    requireAccount(captured);
    if (!response.ok) throw requestFailure(await response.json().catch(() => ({})));
    return binary ? response.blob() : response.json();
}
/**
 * The error for a reply the server refused. Its reason is shown whole, so it is looked up by its exact text and never by the
 * ${n} patterns. An integrity failure (D12) keeps the server's English text as written, and the mark that tells showFailure to
 * explain it first. The server's code is kept on the error, so a caller can tell a missing chat from other failures.
 */
function requestFailure(body) {
    const reason = typeof body?.error === 'string' ? body.error.trim() : '';
    const integrity = body?.integrity === true;
    const error = new Error(!reason ? t`That did not finish. Try again.` : integrity ? reason : translate(reason));
    if (integrity) error.integrity = true;
    error.code = body?.code;
    return error;
}
/**
 * Shows why something failed in a status element, as final text. An integrity failure shows the sentence that says what it
 * means, then the server's English detail in an element of its own that nothing translates.
 */
function showFailure(target, error) {
    target.replaceChildren();
    if (error?.integrity === true) {
        target.append(element('span', t`Neconyan stopped because its saved change records are not as expected. Some steps may already have completed and have not been reversed. Check Change history before trying again, and show the details below to whoever runs this server.`));
        if (error.message) target.append(document.createElement('br'), authored('span', error.message));
    } else target.textContent = String(error?.message ?? '');
}
export async function setAccountChoice(checked) {
    const account = getCurrentUserHandle(), before = power_user.neconyan_prompt_media;
    const choice = { version: 1, images: checked ? 'display-only' : 'include' };
    power_user.neconyan_prompt_media = choice;
    try {
        if (!await saveSettings(0, { returnResult: true })) throw new Error(t`Your setting was not saved. Try again.`);
        if (account !== getCurrentUserHandle()) throw new Error(t`You switched accounts, so the setting was not saved.`);
        document.querySelectorAll('[data-prompt-images-account]').forEach(node => { node.checked = checked; });
    } catch (error) {
        if (account === getCurrentUserHandle() && power_user.neconyan_prompt_media === choice) {
            if (before === undefined) delete power_user.neconyan_prompt_media; else power_user.neconyan_prompt_media = before;
        }
        throw error;
    } finally {
        announceSettingsChanged();
    }
}
// content is the label's text, or its parts when a name sits in the middle of it.
function checkbox(content, checked, action) {
    const row = element('label', '', 'checkbox_label');
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked;
    input.addEventListener('change', async () => {
        input.disabled = true;
        try { await action(input.checked); } catch (error) { input.checked = !input.checked; toast('error', error.message); } finally { input.disabled = false; }
    });
    const caption = final(element('span', typeof content === 'string' ? content : ''));
    if (typeof content !== 'string') caption.append(...content);
    row.append(input, caption); return { row, input };
}
// A confirmation whose text is final, so it is shown exactly as it was looked up. The body is a sentence, or an element when a
// value of somebody's sits inside it.
function confirmChange(title, body) {
    const content = final(document.createElement('div'));
    content.append(element('h3', title), typeof body === 'string' ? element('p', body) : body);
    return Popup.show.confirm(null, content);
}
function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function compatibleCopy(blob) {
    if (blob.size > 16 * 1024 * 1024) throw new Error(t`Choose an image smaller than 16 MiB.`);
    const bytes = await blob.arrayBuffer();
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./prompt-image-conversion-worker.js', import.meta.url), { type: 'module' });
        const finish = () => { clearTimeout(timer); worker.terminate(); };
        const timer = setTimeout(() => { finish(); reject(new Error(t`Converting took longer than 15 seconds. Choose a smaller image.`)); }, 15000);
        worker.onerror = () => { finish(); reject(new Error(workerErrorMessage('failed'))); };
        // The worker has no translation: it posts a code, and this page picks the sentence.
        worker.onmessage = ({ data }) => { finish(); if (data.errorCode || data.error) reject(new Error(workerErrorMessage(data.errorCode))); else resolve(data); };
        worker.postMessage({ bytes }, [bytes]);
    });
}
async function remoteBlob(url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(t`Only ordinary web links (http or https) can be downloaded. Choose an image file instead.`);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(parsed.href, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal });
        if (!response.ok || !response.body || Number(response.headers.get('Content-Length')) > 16 * 1024 * 1024) throw new Error(t`The image could not be downloaded from its website, or is larger than 16 MiB. Choose an image file instead.`);
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
            while (true) {
                const { value, done } = await reader.read(); if (done) break;
                size += value.byteLength;
                if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new Error(t`The image on the website is larger than 16 MiB. Choose an image file instead.`); }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
        return new Blob(chunks);
    } finally { clearTimeout(timer); }
}
function blobData(blob) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
}
/**
 * No image is fetched simply by opening this screen.
 * With no origin it reviews whatever is open now: the Conversation thread when Conversation is active, otherwise the Roleplay chat.
 * With the origin of a refusal (see roleplayImageOrigin and conversationImageOrigin) it reviews that chat, whatever is open now,
 * or explains why it cannot be opened.
 * @param {object} [origin] detail.origin of an image refusal
 */
export async function showPromptMediaReview(origin = null) {
    if (origin) return openRefusalOrigin(origin);
    if (document.body.classList.contains('neconyan-conversation-active')) return showConversationPromptMediaReview();
    return showRoleplayPromptMediaReview(locator());
}
/** The Roleplay dialog, opened on initialLocator. From a refusal's origin, the chat is read first and a chat that cannot be read gets no dialog. */
async function showRoleplayPromptMediaReview(initialLocator, { fromOrigin = false } = {}) {
    const captured = currentAccount();
    const panel = element('div', '', 'flex-container flexFlowColumn'); panel.id = 'prompt-media-review';
    panel.append(element('h3', translate('Chat images', 'scoped.prompt_media.RVW-10')),
        element('p', t`Choose what the model receives from each image when it writes new replies. Show only keeps an image in the chat but sends the model neither the image nor its saved description.`));
    const explanation = element('details');
    explanation.append(element('summary', t`What these choices do not change`),
        element('p', t`These choices do not change message text, descriptions already copied into it, or saved memories.`),
        element('p', t`Replies that are already being written keep the images they started with. Press Stop to cancel one.`),
        element('p', t`Using the caption service to describe an image, and reference images you give a tool, still send the image when you use them.`),
        element('p', t`Other extensions may send images by their own rules.`));
    panel.append(explanation);
    const accountChoice = checkbox(t`Don't send chat images to the model`, power_user.neconyan_prompt_media?.images === 'display-only', setAccountChoice);
    accountChoice.input.dataset.promptImagesAccount = 'true'; panel.append(accountChoice.row);
    // The status line only ever holds final text: a sentence looked up here, or a server reason looked up by its exact text.
    const status = final(element('p')); status.setAttribute('role', 'status'); panel.append(status);
    const say = text => { status.replaceChildren(); status.textContent = text; };
    const navigation = element('div', '', 'flex-container flexWrap'), content = element('div', '', 'flex-container flexFlowColumn'); panel.append(navigation, content);
    let busy = false, closed = false, page = null, pending = null;
    const run = async action => {
        if (busy || closed) return; busy = true; say(translate('Working…', 'scoped.prompt_media.RVW-14'));
        panel.querySelectorAll('button').forEach(node => { node.disabled = true; });
        try { requireAccount(captured); await action(); } catch (error) { showFailure(status, error); } finally { busy = false; panel.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
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
        announceSettingsChanged();
        await showChat(page.observation.locator, 0, false);
        say(t`Saved. Change history keeps a backup of the chat from before this change: you can download it, or undo the change while the chat stays unchanged.`);
        return result;
    };
    const prepare = async (issue, file) => {
        if (issue.mode === 'detach') throw new Error(t`To remove the image, use Save choice. To prepare a copy, first choose Send the image, Show only or Use a description.`);
        let blob = file;
        if (!blob) {
            const source = await request('source', { observation: page.observation, identity: issue.identity }, captured);
            if (source.base64) blob = new Blob([Uint8Array.from(atob(source.base64), char => char.charCodeAt(0))]);
            else if (source.url.startsWith('data:')) {
                const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(source.url);
                if (!match || match[1].length > 4 * Math.ceil(16 * 1024 * 1024 / 3)) throw new Error(t`This image stored in the chat cannot be converted here. Choose an image file instead.`);
                blob = new Blob([Uint8Array.from(atob(match[1]), char => char.charCodeAt(0))]);
            } else {
                if (!await confirmChange(t`Download this image from its website?`, t`Your browser fetches it directly, without your sign-in details or the address of this page. If the website refuses, choose an image file instead.`)) return;
                blob = await remoteBlob(source.url);
            }
        }
        const converted = await compatibleCopy(blob), preview = element('div');
        const img = document.createElement('img'), url = URL.createObjectURL(converted.blob); img.src = url; img.alt = translate('Prepared compatible copy', 'scoped.prompt_media.CPY-04'); img.className = 'wide100p';
        const adopt = checkbox(t`Also show this copy in the chat instead of the original`, false, () => {});
        // The sizes are technical values in an element of their own; the sentence under them is looked up.
        preview.append(adopt.row, img, authored('p', `${converted.originalWidth} × ${converted.originalHeight} → ${converted.width} × ${converted.height} · ${converted.blob.type} · ${Math.ceil(converted.blob.size / 1024)} KiB`),
            element('p', t`Unless you tick the box above, the chat keeps showing the original image.`));
        try {
            preview.prepend(element('h3', t`Save this compatible copy?`));
            if (!await new Popup(preview, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true, okButton: translate('Save copy', 'scoped.prompt_media.CPY-08'), cancelButton: t`Cancel` }).show()) return;
            await apply([{ ...issue, mode: issue.mode, saveCopy: true, adoptCopy: adopt.input.checked, ...(issue.caption ? { caption: issue.caption } : {}) }], { materialisedImage: { identity: issue.identity, data: await blobData(converted.blob) } });
        } finally { URL.revokeObjectURL(url); }
    };
    const showChat = async (target, offset = 0, save = true) => {
        if (save && sameLocator(target) && !await saveChatConditional()) throw new Error(t`The open chat could not be saved, so its images cannot be listed yet. Try again in a moment.`);
        const next = await request('scan', { locator: target, offset, ...(offset && page ? { observation: page.observation } : {}) }, captured);
        if (closed) return; page = next; content.replaceChildren();
        // The chat's name is the person's own text. The count and the sentence under it are looked up and each is a final element of its
        // own, on its own line, so they never read as one run of words.
        const counts = final(element('p'));
        counts.append(element('span', fillTemplate(translate('Attachments found: ${0}', 'scoped.prompt_media.RVW-31'), next.total)), document.createElement('br'),
            element('span', next.limited ? t`Only the first 10,000 are listed.` : t`Listing does not download anything from websites.`));
        content.append(authored('h4', target.chat), counts);
        const chatChoice = checkbox(t`Don't send this chat's images to the model`, next.chatPreference?.images === 'display-only', checked => run(() => apply([], { chatPreference: { version: 1, images: checked ? 'display-only' : 'include' } })));
        content.append(chatChoice.row);
        if (power_user.neconyan_prompt_media?.images === 'display-only') content.append(final(element('p', t`'Don't send chat images to the model' is on for your account, so it applies here whatever you choose below.`)));
        content.append(element('p', t`Show only does not change text: a message's own title, descriptions already copied into the message and saved memories are used as before.`),
            element('p', t`To send an image, use Chat Completion with 'Send inline media' turned on, and a model that can see images.`));
        const chosen = new Map();
        for (const issue of next.issues) {
            const row = element('fieldset', '', 'flex-container flexFlowColumn');
            row.append(element('legend', reviewLegend(issue)));
            // What the attachment is, then the image's own saved description, which is the person's text and sits in its own element.
            const state = final(element('p'));
            state.append(element('span', reviewStatusLabel(issue.status)));
            if (issue.title) state.append(document.createElement('br'), element('span', savedDescriptionLabel()), ': ', authored('span', issue.title));
            row.append(state);
            if (!issue.actions.length) { row.append(element('p', t`Audio and video are not changed here.`)); content.append(row); continue; }
            const select = element('select', '', 'text_pole'); select.setAttribute('aria-label', t`What the model receives from this image`);
            for (const mode of issue.actions) select.append(choiceOption(mode));
            select.value = issue.actions.includes(issue.mode) ? issue.mode : issue.actions[0];
            // D20: a saved source is offered only when it has text, typing is always offered, and a saved choice of a source that
            // has none stays selected and explained. Nothing here picks another source or saves anything.
            const sources = descriptionSourceOptions(issue);
            const captionSource = element('select', '', 'text_pole'); captionSource.setAttribute('aria-label', t`Where the description comes from`);
            for (const { value, label } of sources.options) { const option = element('option', label); option.value = value; captionSource.append(option); }
            captionSource.value = sources.selected;
            const sourceHelp = element('p', t`An image's saved description comes from the caption service, from the prompt that made it, or from the image library.`);
            const sourceGone = element('p', t`The saved description source for this image is empty or longer than 16 KiB, so it cannot be used. To use a description, choose another source or type one, then save.`);
            const text = element('textarea', '', 'text_pole');
            const typePrompt = t`Type the description the model receives`;
            text.setAttribute('placeholder', typePrompt); text.setAttribute('aria-label', typePrompt);
            if (issue.caption) text.value = issue.caption.text ?? '';
            const describe = () => {
                const describing = select.value === 'caption';
                captionSource.hidden = sourceHelp.hidden = text.hidden = !describing;
                sourceGone.hidden = !describing || sources.unavailable === null || captionSource.value !== sources.unavailable;
            };
            select.addEventListener('change', describe); captionSource.addEventListener('change', describe); describe();
            const action = () => ({ index: issue.index, swipe: issue.swipe, mediaIndex: issue.mediaIndex, identity: issue.identity, mode: select.value,
                ...(select.value === 'caption' ? { caption: { source: captionSource.value, ...(captionSource.value === 'custom' ? { text: text.value } : {}) } } : {}) });
            const selection = checkbox(translate('Select this image', 'scoped.prompt_media.RVW-45'), false, checked => { if (checked) chosen.set(issue.identity, action); else chosen.delete(issue.identity); });
            row.append(selection.row, select, captionSource, sourceHelp, sourceGone, text, button(translate('Save choice', 'scoped.prompt_media.RVW-46'), () => run(async () => {
                if (select.value === 'detach' && !await confirmChange(t`Remove this image from the message?`, t`Its file stays on the server. You can undo this in Change history while the chat stays unchanged.`)) return;
                await apply([action()]);
            })));
            if (issue.status === 'embedded-image') row.append(button(t`Save a copy as it is`, () => run(() => apply([{ ...action(), saveCopy: true }]))));
            if (issue.hasPromptCopy) row.append(button(t`Show the compatible copy in the chat`, () => run(async () => {
                if (!await confirmChange(t`Show the compatible copy instead of the original?`, t`The copy replaces the image shown in the chat. Your choices for what the model receives still apply. The original file stays on the server. You can undo this in Change history while the chat stays unchanged.`)) return;
                await apply([{ ...action(), adoptCopy: true }]);
            })));
            if (issue.status === 'invalid-gallery-selection') row.append(button(t`Make this the gallery's chosen image`, () => run(() => apply([{ ...action(), selectGallery: true }]))));
            if (issue.proposedSource) {
                let proposed;
                try { proposed = new URL(issue.proposedSource); } catch { proposed = null; }
                if (proposed?.origin === location.origin && !proposed.username && !proposed.password && !proposed.search && !proposed.hash && proposed.pathname.startsWith('/user/images/')) {
                    row.append(button(t`Use the copy already on this server`, () => run(async () => {
                        // The path is not translatable text: it sits in an element of its own, between the two halves of the sentence.
                        const [before, after] = splitAtHole(translate('The message will point to ${0} instead of its full web address. The server first checks that this file exists in your account and is compatible.', 'scoped.prompt_media.CPY-15'));
                        const body = final(element('p'));
                        body.append(before, authored('code', proposed.pathname), after);
                        if (!await confirmChange(t`Use the image already on this server?`, body)) return;
                        await apply([{ ...action(), localUrl: proposed.pathname }]);
                    })));
                }
            }
            if (issue.mediaIndex >= 0) {
                row.append(button(t`Prepare a converted copy`, () => run(() => prepare(action()))));
                const upload = document.createElement('input'); upload.type = 'file'; upload.accept = 'image/png,image/jpeg,image/webp';
                // Dismissing the picker fires 'cancel' at the input. It bubbles, and the dialog would take it for its own cancel and close the whole review.
                upload.addEventListener('cancel', event => event.stopPropagation());
                // The file is read first and the input emptied, so choosing the same file again fires 'change' again.
                upload.addEventListener('change', () => { const file = upload.files[0]; upload.value = ''; if (file) void run(() => prepare(action(), file)); });
                // Import opens the hidden input's picker; the existing sentence is its line. The handler stays synchronous and outside run(): a picker opens only inside the
                // person's own click or key press. The input follows the pair, so the pair holds only the button and its line.
                row.append(buttonWithNote(t`Import`, t`Or choose an image file to use as the compatible copy`, () => upload.click()), upload);
            }
            content.append(row);
        }
        content.append(button(t`Save choices for selected images`, () => run(async () => {
            const actions = [...chosen.values()].map(action => action());
            if (!actions.length) throw new Error(t`Select at least one image.`);
            if (actions.some(action => action.mode === 'detach') && !await confirmChange(t`Remove the selected images from their messages?`, t`Their files stay on the server.`)) return;
            await apply(actions);
        })));
        content.append(buttonWithNote(t`Save copies of selected images`, t`Only images stored in the chat.`, () => run(async () => {
            const actions = [...chosen.entries()].map(([identity, action]) => {
                if (next.issues.find(issue => issue.identity === identity)?.status !== 'embedded-image') throw new Error(t`Select only images stored in the chat. Other images need a converted copy, prepared one at a time.`);
                return { ...action(), saveCopy: true };
            });
            if (!actions.length) throw new Error(t`Select at least one image stored in the chat.`);
            await apply(actions);
        })));
        say(translate('Images listed.', 'scoped.prompt_media.RVW-54'));
        if (next.next !== null) content.append(button(translate('More images', 'scoped.prompt_media.RVW-55'), () => run(() => showChat(target, next.next, false))));
    };
    const showLibrary = async (offset = 0) => {
        const list = await request('chats', { offset }, captured); content.replaceChildren();
        content.append(element('h4', translate('Choose chats', 'scoped.prompt_media.RVW-17')), element('p', t`Each chat is changed and backed up separately. If one chat fails, the others keep their changes.`));
        const chosen = new Map();
        // One row per chat in the result list: its name in an element of its own, and what happened to it.
        // A list by role rather than by tag, so the rows take the dialog's existing paragraph rules (wrapping a long name) and need no new style.
        const outcomes = document.createElement('div'); outcomes.className = 'flex-container flexFlowColumn'; outcomes.setAttribute('role', 'list'); outcomes.setAttribute('aria-live', 'polite');
        const record = (target, result) => {
            const item = final(document.createElement('p')), outcome = final(document.createElement('span'));
            item.setAttribute('role', 'listitem');
            if (typeof result === 'string') outcome.textContent = result; else showFailure(outcome, result);
            item.append(authored('span', target.chat), ': ', outcome); outcomes.append(item);
        };
        for (const target of list.chats) {
            const key = JSON.stringify(target), row = element('div', '', 'flex-container flexWrap');
            // A group is a word we say; the character's file name and the chat's name are the person's own, each in its own element.
            const label = target.group ? [element('span', t`Group chat`), ': ', authored('span', target.chat)]
                : [authored('span', target.avatar.replace(/\.png$/, '')), ': ', authored('span', target.chat)];
            row.append(checkbox(label, false, checked => { if (checked) chosen.set(key, target); else chosen.delete(key); }).row,
                button(t`Review`, () => run(() => showChat(target)))); content.append(row);
        }
        content.append(button(t`Stop sending images in selected chats`, () => run(async () => {
            if (!chosen.size) throw new Error(t`Select at least one chat.`);
            if (!await confirmChange(t`Stop sending images in the selected chats?`, fillTemplate(translate('Chats selected: ${0}. In new replies, the model will receive neither their images nor the images\' saved descriptions. You can turn this off again for each chat.', 'scoped.prompt_media.BAT-07'), chosen.size))) return;
            outcomes.replaceChildren();
            for (const target of chosen.values()) {
                if (closed) break;
                try {
                    if (sameLocator(target) && !await saveChatConditional()) throw new Error(t`The open chat could not be saved.`);
                    const beforeLocal = JSON.stringify(chat);
                    const scan = await request('scan', { locator: target }, captured);
                    await request('apply', { key: crypto.randomUUID(), observation: scan.observation, actions: [], chatPreference: { version: 1, images: 'display-only' } }, captured);
                    if (sameLocator(target) && beforeLocal === JSON.stringify(chat)) await refreshCurrentChatFromSaved();
                    record(target, batchResultText.saved());
                } catch (error) { record(target, error); }
            }
            say('');
            announceSettingsChanged();
        })));
        content.append(buttonWithNote(t`Save copies in selected chats`, t`Only images stored in the chat.`, () => run(async () => {
            if (!chosen.size) throw new Error(t`Select at least one chat.`);
            if (!await confirmChange(t`Save copies of images stored in the selected chats?`, t`Images stored inside each chat file are saved as compatible copies, as they are. The chat keeps showing the originals, and your choices are kept. Each chat is backed up separately. A chat with more than 128 such images, or with images that need converting, must be reviewed on its own.`)) return;
            outcomes.replaceChildren();
            for (const target of chosen.values()) {
                if (closed) break;
                try {
                    if (sameLocator(target) && !await saveChatConditional()) throw new Error(t`The open chat could not be saved.`);
                    const beforeLocal = JSON.stringify(chat);
                    let scan = await request('scan', { locator: target }, captured);
                    const observation = scan.observation, actions = [];
                    if (scan.limited) throw new Error(t`This chat has too many attachments to change with others. Review it on its own.`);
                    while (true) {
                        for (const issue of scan.issues) if (issue.status === 'embedded-image') {
                            actions.push({ index: issue.index, swipe: issue.swipe, mediaIndex: issue.mediaIndex, identity: issue.identity,
                                mode: issue.mode, ...(issue.caption ? { caption: issue.caption } : {}), saveCopy: true });
                        }
                        if (actions.length > 128) throw new Error(t`This chat has more than 128 images stored in it. Review it on its own and select fewer at a time.`);
                        if (scan.next === null) break;
                        scan = await request('scan', { locator: target, observation, offset: scan.next }, captured);
                    }
                    if (!actions.length) { record(target, batchResultText.noImages()); continue; }
                    await request('apply', { key: crypto.randomUUID(), observation, actions }, captured);
                    if (sameLocator(target) && beforeLocal === JSON.stringify(chat)) await refreshCurrentChatFromSaved();
                    record(target, batchResultText.copiesSaved(actions.length));
                } catch (error) { record(target, error); }
            }
            say('');
        })));
        if (list.next !== null) content.append(button(translate('More chats', 'scoped.prompt_media.BAT-15'), () => run(() => showLibrary(list.next))));
        content.append(outcomes);
        // Loaded: the status line no longer says 'Working…'. (Errors are shown by run() and never reach this line.)
        say('');
    };
    const showHistory = async (offset = 0) => {
        const history = await request('history', { offset }, captured); content.replaceChildren(element('h4', translate('Change history', 'scoped.prompt_media.RVW-18')));
        for (const operation of history.operations) {
            const row = element('fieldset');
            // A chat's name is the person's own; a change with no chat yet is a word we say.
            row.append(operation.locator?.chat != null ? authored('legend', operation.locator.chat) : element('legend', translate('Unfinished change', 'scoped.prompt_media.HIS-01')));
            // The date is formatted for the interface language and is not text anyone translates; the stage is a label from a map.
            const when = formatChangeDate(operation.createdAt, document.documentElement.lang || 'en');
            const state = final(element('p'));
            if (when) state.append(authored('span', when), ' · ');
            state.append(element('span', historyStageLabel(operation)));
            row.append(state);
            if (operation.phase === 'prepared' && operation.stage !== 'committed') row.append(button(translate('Finish this change', 'scoped.prompt_media.HIS-03'), () => run(async () => {
                await request('resume', { id: operation.id }, captured); await showHistory(offset);
                say(t`Change finished. Reopen the chat to see it.`);
            })));
            if (['staging', 'aborting'].includes(operation.phase)) row.append(button(translate('Discard unfinished change', 'scoped.prompt_media.HIS-05'), () => run(async () => {
                if (!await confirmChange(t`Discard this unfinished change?`, t`Its preparation files are deleted; anything unexpected is kept. Your chat and its images are not changed. You can make the change again afterwards.`)) return;
                await request('discard', { id: operation.id }, captured); await showHistory(offset);
                say(translate('Unfinished change discarded.', 'scoped.prompt_media.HIS-08'));
            })));
            if (operation.backupAvailable) {
                row.append(button(translate('Download backup', 'scoped.prompt_media.HIS-09'), () => run(async () => download(await request('backup/export', { id: operation.id }, captured, { binary: true }), 'chat-before-image-repair.jsonl'))),
                    button(translate('Undo change', 'scoped.prompt_media.HIS-10'), () => run(async () => {
                        if (!await confirmChange(translate('Undo this change?', 'scoped.prompt_media.HIS-11'), t`The chat goes back to how it was before this change. This works only if the chat has not changed since. Images that were missing stay missing.`)) return;
                        const beforeLocal = JSON.stringify(chat);
                        const scan = await request('scan', { locator: operation.locator }, captured);
                        await request('apply', { key: `undo:${operation.id}`, observation: scan.observation, undoOf: operation.id }, captured);
                        if (sameLocator(operation.locator) && beforeLocal === JSON.stringify(chat)) await refreshCurrentChatFromSaved();
                        await showHistory(offset); say(translate('Change undone.', 'scoped.prompt_media.HIS-13'));
                    })), button(t`Delete backup`, () => run(async () => {
                        if (!await confirmChange(translate('Delete this backup?', 'scoped.prompt_media.HIS-15'), t`You will no longer be able to undo this change. Image files, including compatible copies, are kept. Download the backup first if you might need it.`)) return;
                        await request('backup/remove', { id: operation.id }, captured); await showHistory(offset);
                    })));
            }
            content.append(row);
        }
        if (history.next !== null) content.append(button(t`More changes`, () => run(() => showHistory(history.next))));
        // Loaded: clear 'Working…'. The callers above that follow with a message of their own (finished, discarded, undone) set it afterwards.
        say('');
    };
    // The chat that is actually open now, which is not always the chat this dialog opens on.
    const openChat = locator();
    if (openChat) navigation.append(button(t`Current chat`, () => run(() => showChat(openChat))));
    navigation.append(button(translate('Choose chats', 'scoped.prompt_media.RVW-17'), () => run(() => showLibrary())), button(translate('Change history', 'scoped.prompt_media.RVW-18'), () => run(() => showHistory())));
    if (fromOrigin) {
        try { await showChat(initialLocator); } catch (error) {
            // The server answers a missing chat file, a chat folder that is gone and an unreadable file alike (ROLEPLAY_IMAGE_RECOVERY). ENOENT is kept for any other missing path.
            if (!['ROLEPLAY_IMAGE_RECOVERY', 'ENOENT'].includes(error?.code)) throw error;
            explainOriginUnavailable();
            return;
        }
    }
    const popup = new Popup(panel, POPUP_TYPE.TEXT, '', { wide: true, large: true, leftAlign: true, allowVerticalScrolling: true,
        okButton: t`Close`, onClose: () => { closed = true; } });
    const shown = popup.show();
    if (!fromOrigin && initialLocator) void run(() => showChat(initialLocator)); else if (!initialLocator) say(t`No chat is open. Choose chats to review, or change the setting for all chats above.`);
    await shown;
}
const IMAGE_NOTICE_WINDOW_MS = 4000;
const imageNoticeTimes = new Map();
/** The origin carried by a refusal event, or null for an event that carries none or one this page does not know. */
const noticeOrigin = detail => ['roleplay', 'conversation'].includes(detail?.origin?.workspace) ? detail.origin : null;
/** What makes two refusals the same one: the reason and the place it came from. */
const originIdentity = origin => origin?.workspace === 'roleplay'
    ? ['roleplay', origin.account, origin.locator?.group, origin.locator?.chat, origin.locator?.avatar]
    : origin ? ['conversation', origin.account, origin.avatar, origin.groupId, origin.personaId, origin.branchId] : null;
/**
 * The one notice for an image the person has to decide about, whichever route raised it. Line 1 is the refusal reason, as the
 * server or the page worded it, looked up by its exact text and escaped; line 2 says what to do. Clicking opens the review for the
 * chat that was refused (detail.origin), whatever is open when the person clicks.
 * One refusal shows one notice: the same reason from the same origin again within a few seconds is not shown twice. The same
 * reason from another origin is another notice.
 * @param {{message?: string, origin?: object}} [detail] The refusal event's detail
 * @returns {boolean} Whether a notice was shown
 */
export function showImageChoiceNotice(detail = {}) {
    const reason = String(detail?.message ?? '').trim();
    const origin = noticeOrigin(detail);
    const key = JSON.stringify([reason, originIdentity(origin)]);
    const now = Date.now();
    for (const [other, at] of imageNoticeTimes) if (now - at >= IMAGE_NOTICE_WINDOW_MS) imageNoticeTimes.delete(other);
    if (imageNoticeTimes.has(key)) return false;
    imageNoticeTimes.set(key, now);
    const shown = toastr.warning(twoLineToastHtml(t`Open Review chat images to choose what the model receives.`, reason, { reasonFirst: true }),
        escapeToastText(t`Review needed before replying`), { escapeHtml: false, timeOut: 12000, onclick: () => { void showPromptMediaReview(origin).catch(error => toast('error', error.message)); } });
    shown?.find?.('.toast-message, .toast-title').attr('data-i18n-ignore', '');
    return true;
}
/** Says why a notice cannot open its review. One toast, and no dialog. */
function explainOrigin(text) {
    toast('info', text);
}
function explainOriginUnavailable() {
    explainOrigin(t`The chat or branch this notice refers to could not be opened, so its image review is not available.`);
}
function explainOriginAccount() {
    explainOrigin(t`This notice belongs to another account. Switch back to that account to review the image.`);
}
function explainOriginBranch() {
    explainOrigin(t`This notice refers to a different branch. Switch back to that branch to review the image.`);
}
/**
 * Opens the review for the chat a refusal came from, or says why it cannot. Nothing here reads the chat that is open now, except to
 * decide whether the origin is already open.
 * - Another account: the account explanation.
 * - Roleplay: the Roleplay dialog on that chat, even while Conversation or another chat is open. A character that is gone, or a chat
 *   the server cannot find or read, gets the unavailable explanation.
 * - Conversation: the dialog works on the open thread's active branch only. If the origin is not the open thread, the thread is opened
 *   by the left rail's own path first. No branch is switched. A branch that still exists but is not the active one gets its own
 *   explanation (it says to switch back to that branch); a destination that is missing or cannot be identified gets the unavailable
 *   one: a character that is gone, a group that is gone, another persona, a branch that no longer exists (deleted, or recreated under
 *   the same id with another lifetimeSeed or createdAt), or a path the rail refuses.
 */
async function openRefusalOrigin(origin) {
    if (origin.account !== getCurrentUserHandle()) return explainOriginAccount();
    if (origin.workspace === 'roleplay') {
        // A chat that names no chat, or a solo chat whose character is gone, cannot be identified.
        if (!origin.locator?.chat || (!origin.locator.group && !characters.some(character => character?.avatar === origin.locator.avatar))) return explainOriginUnavailable();
        return showRoleplayPromptMediaReview(origin.locator, { fromOrigin: true });
    }
    const context = await import('./neconyan-conversation/context.js');
    // The origin branch is identified by its id and, where the origin knows them, its lifetimeSeed and createdAt; what is in it does not matter.
    const isOrigin = branch => Boolean(branch) && branch.id === origin.branchId && (!origin.lifetimeSeed || branch.lifetimeSeed === origin.lifetimeSeed)
        && (!origin.createdAt || String(branch.createdAt) === origin.createdAt);
    /** 'active' (the thread's active branch is the origin), 'inactive' (it still exists but another branch is active) or 'gone'. */
    const branchState = () => {
        const thread = { create: false, groupId: origin.groupId, personaId: origin.personaId };
        if (isOrigin(context.getActiveConversationBranch(origin.avatar, thread))) return 'active';
        return isOrigin(context.getActiveConversationBranch(origin.avatar, { ...thread, branchId: origin.branchId })) ? 'inactive' : 'gone';
    };
    const threadIsOrigin = async () => {
        const { isConversationActiveThread } = await import('./neconyan-conversation/notifications.js');
        return isConversationActiveThread(origin.avatar, origin.groupId, { personaId: origin.personaId });
    };
    if (!characters.some(character => character?.avatar === origin.avatar) || origin.personaId !== context.getConversationPersonaId()
        || (origin.groupId && !context.isAvatarInConversationGroup(origin.avatar, origin.groupId, { personaId: origin.personaId })) || branchState() === 'gone') {
        return explainOriginUnavailable();
    }
    if (branchState() === 'inactive') return explainOriginBranch();
    if (!await threadIsOrigin()) {
        const { selectConversationThread } = await import('./neconyan-conversation/chrome.js');
        if (!await selectConversationThread(origin.avatar, { groupId: origin.groupId || null, showToast: false }) || !await threadIsOrigin()) return explainOriginUnavailable();
        // The thread is open now; the branch can still have changed on the way.
        const state = branchState();
        if (state !== 'active') return state === 'inactive' ? explainOriginBranch() : explainOriginUnavailable();
    }
    return showConversationPromptMediaReview();
}
/** Conversation choices use its existing versioned store writer; Roleplay repair never rewrites that store. */
async function showConversationPromptMediaReview() {
    const context = await import('./neconyan-conversation/context.js');
    const sync = await import('./neconyan-conversation/store-sync.js');
    const { promptAttachmentHash, generatedImagePromptPolicy } = await import('./prompt-media-client.js');
    const captured = currentAccount(), avatar = context.getCurrentCharAvatar();
    const branch = context.getActiveConversationBranch(avatar, { create: false });
    if (!branch) throw new Error(t`Open a Conversation chat to review its images.`);
    const panel = element('div', '', 'flex-container flexFlowColumn'); panel.id = 'prompt-media-review';
    panel.append(element('h3', translate('Conversation images', 'scoped.prompt_media.CNV-02')),
        element('p', t`Choose what the model receives from each image when it writes new replies. Show only keeps an image in the Conversation but sends the model neither the image nor its saved description. It does not change message text or saved memories.`));
    const accountChoice = checkbox(t`Don't send chat images to the model`, power_user.neconyan_prompt_media?.images === 'display-only', setAccountChoice);
    accountChoice.input.dataset.promptImagesAccount = 'true'; panel.append(accountChoice.row);
    const branchIdentity = { id: branch.id, lifetimeSeed: branch.lifetimeSeed };
    const currentBranch = () => {
        const current = context.getActiveConversationBranch(avatar, { create: false });
        if (!current || current.id !== branchIdentity.id || current.lifetimeSeed !== branchIdentity.lifetimeSeed) throw new Error(t`This Conversation changed. Close this window and open it again.`);
        return current;
    };
    const currentMessage = (current, id) => {
        const matches = current.messages.filter(item => item.id === id);
        if (matches.length !== 1) throw new Error(t`This message changed. Close this window and open it again.`);
        return matches[0];
    };
    let saving = false;
    const save = async change => {
        if (saving) throw new Error(t`Wait for the current choice to finish saving.`);
        requireAccount(captured);
        saving = true; panel.setAttribute('aria-busy', 'true');
        panel.querySelectorAll('button, input, select, textarea').forEach(node => { node.disabled = true; });
        let undo;
        try {
            if (!await sync.flushConversationStore()) throw new Error(t`Earlier Conversation changes could not be saved, so this choice was not saved. Try again.`);
            requireAccount(captured);
            undo = change(currentBranch());
            context.persistConversationStore();
            if (!await sync.flushConversationStore()) throw new Error(t`Your choice was not saved. Try again.`);
            requireAccount(captured);
            announceSettingsChanged();
            toast('success', translate('Choice saved.', 'scoped.prompt_media.CNV-12'));
        } catch (error) { undo?.(); throw error; } finally {
            saving = false; panel.setAttribute('aria-busy', 'false');
            panel.querySelectorAll('button, input, select, textarea').forEach(node => { node.disabled = false; });
        }
    };
    panel.append(checkbox(t`Don't send this branch's images to the model`, branch.neconyan_prompt_media?.images === 'display-only', checked => save(current => {
        const before = current.neconyan_prompt_media, next = { version: 1, images: checked ? 'display-only' : 'include' };
        current.neconyan_prompt_media = next;
        return () => { if (current.neconyan_prompt_media === next) { if (before === undefined) delete current.neconyan_prompt_media; else current.neconyan_prompt_media = before; } };
    })).row);
    if (power_user.neconyan_prompt_media?.images === 'display-only') panel.append(final(element('p', t`'Don't send chat images to the model' is on for your account, so it applies here whatever you choose below.`)));
    for (const [index, message] of branch.messages.entries()) {
        const extra = message.extra ?? {};
        const media = [...(Array.isArray(extra.media) ? extra.media.map((item, mediaIndex) => ({ item, mediaIndex })) : []),
            ...(extra.image_url ? [{ item: { url: extra.image_url, type: 'image', title: extra.image_prompt || 'Generated image', neconyan_prompt: extra.neconyan_image_prompt }, mediaIndex: null }] : [])];
        for (const { item, mediaIndex } of media.filter(({ item }) => (item?.type ?? 'image') === 'image')) {
            const row = element('fieldset', '', 'flex-container flexFlowColumn'); row.append(element('legend', conversationImageLegend(index, mediaIndex)));
            const select = element('select', '', 'text_pole'); select.setAttribute('aria-label', t`What the model receives from this image`);
            for (const mode of ['display-only', 'caption', 'include']) select.append(choiceOption(mode));
            select.value = item.neconyan_prompt?.mode ?? 'include';
            const text = element('textarea', '', 'text_pole'); text.setAttribute('aria-label', t`Description sent to the model`); text.setAttribute('placeholder', t`Type the description the model receives`);
            text.value = item.neconyan_prompt?.caption?.text ?? item.title ?? '';
            const update = () => { text.hidden = select.value !== 'caption'; }; select.addEventListener('change', update); update();
            let originalHash = promptAttachmentHash(extra);
            row.append(select, text, button(translate('Save choice', 'scoped.prompt_media.RVW-46'), async () => {
                try {
                    await save(current => {
                        const message = currentMessage(current, branch.messages[index].id);
                        if (promptAttachmentHash(message.extra ?? {}) !== originalHash) throw new Error(t`This message changed. Close this window and open it again.`);
                        if (select.value === 'caption' && (!text.value.trim() || new TextEncoder().encode(text.value).length > 16384)) throw new Error(t`Type a description of up to 16 KiB.`);
                        const before = message.extra, next = structuredClone(before ?? {});
                        const policy = generatedImagePromptPolicy(item, select.value).neconyan_prompt;
                        if (select.value === 'caption') policy.caption = { source: 'custom', text: text.value };
                        if (mediaIndex === null) next.neconyan_image_prompt = policy; else next.media[mediaIndex].neconyan_prompt = policy;
                        message.extra = next;
                        return () => { if (message.extra === next) message.extra = before; };
                    });
                    originalHash = promptAttachmentHash(currentMessage(currentBranch(), message.id).extra ?? {});
                } catch (error) { toast('error', error.message); }
            })); panel.append(row);
        }
        if (extra.conversation_attachment_context || extra.conversation_reply_to?.attachmentSummary || extra.conversation_reply_to?.text) {
            // A row with saved attachment text is the older combined case (CNV-18, CNV-19, CNV-22, CNV-26, CNV-27). A row with only a quoted
            // reply has no file text to leave out, so it gets its own legend, explanation, error and confirmation (CNV-28 to CNV-32). CNV-30
            // reuses the existing 'This message changed' key instead of a key of its own.
            const quoteOnly = !extra.conversation_attachment_context;
            const row = element('fieldset', '', 'flex-container flexFlowColumn');
            row.append(element('legend', quoteOnly ? conversationQuoteLegend(index) : conversationContextLegend(index)),
                element('p', quoteOnly
                    ? t`This reply contains a quote. If your image settings require a review and the quote cannot be checked against its original message, the model receives what you choose here instead of the quote: your reviewed text, or nothing. The message as shown is not changed.`
                    : t`This older message saved image descriptions and file text together, so Show only cannot separate them. Choose what the model receives instead: your reviewed text, or nothing. Leaving it out also leaves out the file text. The message as shown is not changed.`));
            const text = element('textarea', '', 'text_pole'); text.setAttribute('aria-label', t`Text sent to the model instead`); text.setAttribute('placeholder', t`Type the text the model receives instead`);
            const sourceHash = promptAttachmentHash([extra.conversation_attachment_context ?? '', extra.conversation_reply_to ?? null]);
            const choose = async mode => {
                try {
                    await save(currentBranch => {
                        const message = currentMessage(currentBranch, branch.messages[index].id);
                        const current = message.extra ?? {};
                        if (promptAttachmentHash([current.conversation_attachment_context ?? '', current.conversation_reply_to ?? null]) !== sourceHash) throw new Error(quoteOnly ? t`This message changed. Close this window and open it again.` : t`This saved attachment text changed. Close this window and open it again.`);
                        if (new TextEncoder().encode(text.value).length > 16384) throw new Error(t`Keep the replacement text to at most 16 KiB.`);
                        const before = message.extra, next = { ...current, neconyan_image_context: { version: 1, source_hash: sourceHash, mode,
                            ...(mode === 'replace' ? { text: text.value } : {}) } };
                        message.extra = next; return () => { if (message.extra === next) message.extra = before; };
                    });
                } catch (error) { toast('error', error.message); }
            };
            row.append(text, button(translate('Use this text', 'scoped.prompt_media.CNV-24'), () => choose('replace')), button(translate('Leave it out', 'scoped.prompt_media.CNV-25'), async () => {
                const confirmed = quoteOnly
                    ? await confirmChange(t`Leave out the quote?`, t`If your image settings require a review and the quote cannot be checked against its original message, the model receives this reply without the quote. What was written in the message is not changed.`)
                    : await confirmChange(t`Leave out the saved attachment text?`, t`The file text saved with it is left out too. What was written in the message is not changed.`);
                if (confirmed) await choose('omit');
            })); panel.append(row);
        }
    }
    await new Popup(panel, POPUP_TYPE.TEXT, '', { wide: true, large: true, leftAlign: true, allowVerticalScrolling: true, okButton: t`Close` }).show();
}
