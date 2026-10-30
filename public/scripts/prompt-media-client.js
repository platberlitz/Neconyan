import { conversationState } from './neconyan-conversation/state.js';
import { roleplayAccountStamp } from './roleplay-save-chain.js';
import { getCurrentUserHandle } from './user.js';
import { sha256 } from '../lib.js';
import { chat_metadata, main_api, getRequestHeaders } from '../script.js';
import { power_user } from './power-user.js';
import { oai_settings } from './openai.js';
import { extension_settings } from './extensions.js';
import { attachmentIdentity, canonicalPromptMedia, createPromptMediaContext, imageInputIssueDetail, roleplayImageOrigin, selectPromptMedia } from './prompt-media-policy.js';
import { t, translate } from './i18n.js';

/**
 * An error whose text this feature has already put into the reader's language. Display code shows it as given: no second
 * lookup, and its toast is marked for the run-time localiser to leave alone (group chats and Conversation do both).
 * @param {string} message
 * @returns {Error & {localized: true}}
 */
export const localizedError = message => Object.assign(new Error(message), { localized: true });

/** The sentence shown above the server's own wording when a saved change record is not as expected (an integrity failure, INT-01). The review window says the same words. */
const integrityExplanation = () => t`Neconyan stopped because its saved change records are not as expected. Some steps may already have completed and have not been reversed. Check Change history before trying again, and show the details below to whoever runs this server.`;

export const promptAttachmentHash = value => sha256(canonicalPromptMedia(value));

// A refusal the browser raised is reported once per error object. A server reply was already reported by the route that read it, so its
// error carries the code only on error.body and is left alone here.
const reportedImageRefusals = new WeakSet();
export function reportBrowserImageRefusal(error, locator, account) {
    if (error === null || typeof error !== 'object' || error.code !== 'ROLEPLAY_IMAGE_INPUT' || reportedImageRefusals.has(error)) return false;
    reportedImageRefusals.add(error);
    globalThis.dispatchEvent(new CustomEvent('neconyan:image-input-refused', { detail: imageInputIssueDetail(error, roleplayImageOrigin(locator, account)) }));
    return true;
}
/** Whether this page already reported this refusal, so a caller may treat it as shown. */
export const isReportedImageRefusal = error => error !== null && typeof error === 'object' && reportedImageRefusals.has(error);

// The review window loads on first use so it stays out of every cold start.
const promptMediaUi = () => import('./prompt-media-ui.js');
// A toast whose text is already final, as the review window shows its own errors: the run-time localiser leaves it alone.
const finalErrorToast = error => { toastr.error(String(error?.message ?? ''))?.find?.('.toast-message, .toast-title').attr('data-i18n-ignore', ''); };
const openPromptMediaReview = () => { void promptMediaUi().then(ui => ui.showPromptMediaReview()).catch(finalErrorToast); };
// A refusal is copied when it is raised, so the chat, account and branch it names are the ones it came from, whatever changes while the
// review window loads. Notices wait on one chain, so refusals that arrive before the window has loaded are shown one after another, in
// the order they were raised. One that fails is told, and the next still goes through.
let refusalNotices = Promise.resolve();
const refusalSnapshot = detail => { try { return structuredClone(detail); } catch { return detail; } };
const showRefusalNotice = detail => {
    refusalNotices = refusalNotices.then(promptMediaUi).then(ui => ui.showImageChoiceNotice(detail))
        .catch(finalErrorToast).catch(() => {});
};

export function initPromptMediaControls() {
    const input = document.getElementById('prompt-images-account');
    if (input) {
        input.checked = power_user.neconyan_prompt_media?.images === 'display-only'; input.dataset.promptImagesAccount = 'true';
        input.addEventListener('change', async () => { input.disabled = true; try { await (await promptMediaUi()).setAccountChoice(input.checked); } catch (error) { input.checked = !input.checked; finalErrorToast(error); } finally { input.disabled = false; } });
    }
    document.getElementById('prompt-images-review')?.addEventListener('click', openPromptMediaReview);
    // Registered here, at startup, so a refusal before the review window has ever loaded is still heard. The notice itself
    // (wording, throttle, click target) lives in the review module, which loads on the first refusal.
    globalThis.addEventListener('neconyan:image-input-refused', event => { showRefusalNotice(refusalSnapshot(event.detail)); });
}
/** chatScope is 'branch' for a Conversation branch, so a damaged branch setting names the branch's own control. */
export function browserPromptMediaContext(metadata = chat_metadata, { chatScope = 'chat' } = {}) {
    return createPromptMediaContext({ power_user, extension_settings }, metadata, oai_settings,
        { backend: main_api === 'openai' ? 'chat' : 'text', chatScope });
}
export function projectBrowserPromptMedia(records, metadata = chat_metadata) {
    return selectPromptMedia(records, browserPromptMediaContext(metadata), { hash: promptAttachmentHash });
}
export function generatedImagePromptPolicy(item, mode = 'display-only') {
    if (!['display-only', 'include', 'caption'].includes(mode)) mode = 'display-only';
    const attachment_hash = promptAttachmentHash(attachmentIdentity(item));
    const previous = item.neconyan_prompt?.attachment_hash === attachment_hash ? item.neconyan_prompt : {};
    return { ...item, neconyan_prompt: { version: 1, mode, attachment_hash,
        ...(previous.image_url ? { image_url: previous.image_url, original_evidence: previous.original_evidence } : {}),
        ...(mode === 'caption' ? { caption: { source: 'media-title' } } : {}) } };
}

/** Conversation has its own branch preference; obtain it without introducing an eager module cycle. */
export async function effectiveBrowserPromptMediaContext() {
    if (conversationState.conversationWorkspaceOpen) {
        const context = await import('./neconyan-conversation/context.js');
        return browserPromptMediaContext(context.getActiveConversationBranch(context.getCurrentCharAvatar(), { create: false }) ?? {}, { chatScope: 'branch' });
    }
    return browserPromptMediaContext();
}

/** Validate included input before inserting it. Failed generation output remains in its gallery. A library image has its own wording. */
export async function preflightImageInput(url, mode, { library = false } = {}) {
    const context = await effectiveBrowserPromptMediaContext();
    if (mode !== 'include' || context.account === 'display-only' || context.chat === 'display-only' || !context.inlineImages) return url;
    const owner = getCurrentUserHandle(), stamp = roleplayAccountStamp();
    const response = await fetch('/api/roleplay/images/check', { method: 'POST', headers: { ...getRequestHeaders(),
        'Content-Type': 'application/json', 'X-Neconyan-Account': owner }, body: JSON.stringify({ url, account: stamp.account }) });
    const result = await response.json();
    if (owner !== getCurrentUserHandle() || stamp !== roleplayAccountStamp()) throw new Error(t`You switched accounts while the image was being inserted, so it was not inserted.`);
    if (!response.ok) {
        // The server's reason is a whole message, so it goes through the exact lookup before it joins the sentence.
        const reason = result.error && result.integrity === true ? `${integrityExplanation()} ${result.error}`
            : result.error ? translate(result.error) : t`This image needs a compatible copy before it can be sent.`;
        const sentence = library
            ? t`The library image cannot be sent as it is. To insert library images, choose Show only or Use a description under 'Library images in replies'.`
            : t`The image cannot be sent as it is. It stays in the gallery; to insert it now, choose Show only or Use a description.`;
        // The two lines stay apart on the error, so a toast can show them on separate lines; the message joins them for any other reader.
        throw Object.assign(new Error(sentence + '\n' + reason), { sentence, reason });
    }
    return result.url;
}

/** Account-scoped read checks, before any automatic derivative conversion. */
export async function validatePromptImageCopies(copies) {
    if (!copies.length) return;
    const owner = getCurrentUserHandle(), stamp = roleplayAccountStamp();
    if (!stamp?.account) throw localizedError(t`This page is out of date. Reload it, then try again.`);
    for (let index = 0; index < copies.length; index += 6) {
        const response = await fetch('/api/roleplay/images/check-copies', { method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json', 'X-Neconyan-Account': owner },
            body: JSON.stringify({ account: stamp.account, copies: copies.slice(index, index + 6) }) });
        const result = await response.json();
        if (owner !== getCurrentUserHandle() || stamp !== roleplayAccountStamp()) throw localizedError(t`You switched accounts while images were being checked. Try again.`);
        if (!response.ok) throw localizedError(result.error && result.integrity === true ? `${integrityExplanation()}\n${result.error}`
            : result.error ? translate(result.error) : t`Compatible copies could not be checked. Try again, or review them in Review chat images.`);
    }
}
