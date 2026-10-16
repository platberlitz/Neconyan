import { conversationState } from './neconyan-conversation/state.js';
import { roleplayAccountStamp } from './roleplay-save-chain.js';
import { getCurrentUserHandle } from './user.js';
import { sha256 } from '../lib.js';
import { chat_metadata, main_api, getRequestHeaders } from '../script.js';
import { power_user } from './power-user.js';
import { oai_settings } from './openai.js';
import { extension_settings } from './extensions.js';
import { attachmentIdentity, canonicalPromptMedia, createPromptMediaContext, selectPromptMedia } from './prompt-media-policy.js';

export const promptAttachmentHash = value => sha256(canonicalPromptMedia(value));

// The review window loads on first use so it stays out of every cold start.
const promptMediaUi = () => import('./prompt-media-ui.js');
const openPromptMediaReview = () => { void promptMediaUi().then(ui => ui.showPromptMediaReview()).catch(error => toastr.error(error.message)); };

export function initPromptMediaControls() {
    const input = document.getElementById('prompt-images-account');
    if (input) {
        input.checked = power_user.neconyan_prompt_media?.images === 'display-only'; input.dataset.promptImagesAccount = 'true';
        input.addEventListener('change', async () => { input.disabled = true; try { await (await promptMediaUi()).setAccountChoice(input.checked); } catch (error) { input.checked = !input.checked; toastr.error(error.message); } finally { input.disabled = false; } });
    }
    document.getElementById('prompt-images-review')?.addEventListener('click', openPromptMediaReview);
    globalThis.addEventListener('neconyan:image-input-refused', () => {
        toastr.warning('Review image input choices to keep pictures display-only, use a description, or prepare a compatible copy.', 'Image input needs attention', {
            onclick: openPromptMediaReview, timeOut: 12000,
        });
    });
}
export function browserPromptMediaContext(metadata = chat_metadata) {
    return createPromptMediaContext({ power_user, extension_settings }, metadata, oai_settings,
        { backend: main_api === 'openai' ? 'chat' : 'text' });
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
        return browserPromptMediaContext(context.getActiveConversationBranch(context.getCurrentCharAvatar(), { create: false }) ?? {});
    }
    return browserPromptMediaContext();
}

/** Validate included input before inserting it. Failed generation output remains in its gallery. */
export async function preflightImageInput(url, mode) {
    const context = await effectiveBrowserPromptMediaContext();
    if (mode !== 'include' || context.account === 'display-only' || context.chat === 'display-only' || !context.inlineImages) return url;
    const owner = getCurrentUserHandle(), stamp = roleplayAccountStamp();
    const response = await fetch('/api/roleplay/images/check', { method: 'POST', headers: { ...getRequestHeaders(),
        'Content-Type': 'application/json', 'X-Neconyan-Account': owner }, body: JSON.stringify({ url, account: stamp.account }) });
    const result = await response.json();
    if (owner !== getCurrentUserHandle() || stamp !== roleplayAccountStamp()) throw new Error('The image insertion account changed.');
    if (!response.ok) throw new Error(`${result.error || 'This image needs a compatible prompt copy.'} The generated image remains in the gallery. Choose Show only or Use a description to insert it.`);
    return result.url;
}

/** Account-scoped read checks, before any automatic derivative conversion. */
export async function validatePromptImageCopies(copies) {
    if (!copies.length) return;
    const owner = getCurrentUserHandle(), stamp = roleplayAccountStamp();
    if (!stamp?.account) throw new Error('Reload before checking saved image copies.');
    for (let index = 0; index < copies.length; index += 6) {
        const response = await fetch('/api/roleplay/images/check-copies', { method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json', 'X-Neconyan-Account': owner },
            body: JSON.stringify({ account: stamp.account, copies: copies.slice(index, index + 6) }) });
        const result = await response.json();
        if (owner !== getCurrentUserHandle() || stamp !== roleplayAccountStamp()) throw new Error('The image input account changed.');
        if (!response.ok) throw new Error(result.error || 'Review saved image copies before sending them.');
    }
}
