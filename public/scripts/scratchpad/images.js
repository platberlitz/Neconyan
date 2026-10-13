import { characters, getOneCharacter, getRequestHeaders, printCharactersDebounced, refreshCharacterAvatar, select_selected_character, this_chid } from '../../script.js';
import { event_types, eventSource } from '../events.js';
import { t } from '../i18n.js';
import { cancelJob, getJobApproval, decideJobApproval, retryJob } from '../jobs.js';
import { getExtensionCapability } from '../neconyan-conversation/extension-capabilities.js';
import { h } from '../notebooks/dom.js';
import { getCurrentUserHandle } from '../user.js';
import * as api from './api.js';

const safeImage = url => /^\/?user\/images\/Scratchpad\/scratchpad-[a-z0-9-]+\.(?:png|jpe?g|webp|gif)$/.test(url || '');

export async function imageAvailability() {
    const server = await api.readImageAvailability();
    if (!server.image) return server;
    const capability = getExtensionCapability('quick-image-gen');
    if (!capability) return { image: false, reason: t`Quick Image Gen is still loading or disabled. Open it to check its settings.` };
    try { await capability.ensureReady?.(); return server; } catch { return { image: false, reason: t`Quick Image Gen is not ready. Open it to check its settings.` }; }
}

export async function generateProposal({ source, session, message, part, guard, acknowledge }) {
    guard();
    const ready = await imageAvailability();
    guard();
    if (!ready.image) throw new Error(ready.reason);
    const acknowledgement = await acknowledge();
    guard();
    return api.generateImage({ source, sessionId: session.id, messageId: message.id, index: part.index, submissionKey: api.newSubmissionKey(), acknowledgement });
}

export function renderImageCard({ session, message, part, button, availability, job, error = '', onGenerate, onReview, onPromptReview, onDismiss, onRestore, onRetried, onError }) {
    const image = message.images?.[part.index];
    const applied = message.proposals?.[part.index] === 'applied';
    const dismissed = message.proposals?.[part.index] === 'rejected';
    const card = h('div', { class: 'scratchpad-change scratchpad-image-card', dataset: { imageIndex: part.index } },
        h('p', { class: 'scratchpad-change-title', text: part.change.target === 'avatar' ? t`New avatar for ${part.change.character}` : t`Image suggestion` }),
        h('p', { class: 'scratchpad-image-prompt', text: part.change.prompt, 'data-i18n-ignore': '' }),
        part.change.negative ? h('p', { class: 'scratchpad-muted', text: t`Exclude: ${part.change.negative}` }) : null,
        part.change.reason ? h('p', { class: 'scratchpad-change-reason', text: part.change.reason, 'data-i18n-ignore': '' }) : null);
    const actions = h('div', { class: 'scratchpad-change-actions' });
    if (image?.url && safeImage(image.url)) {
        card.append(h('img', { class: 'scratchpad-generated-image', src: image.url, alt: t`Generated image: ${image.prompt}`, loading: 'lazy',
            ...(image.width && image.height ? { width: image.width, height: image.height } : {}) }));
        actions.append(h('a', { class: 'scratchpad-button scratchpad-image-link', href: image.url, target: '_blank', rel: 'noopener', text: t`Open image` }),
            h('a', { class: 'scratchpad-button scratchpad-image-link', href: image.url, download: '', text: t`Download` }));
        if (image.target === 'avatar' && !dismissed) actions.append(button(applied ? t`Avatar saved` : t`Review avatar`, onReview, { primary: true, disabled: applied }));
        if (safeImage(image.previousAvatarUrl)) actions.append(h('a', { class: 'scratchpad-button scratchpad-image-link', href: image.previousAvatarUrl, target: '_blank', rel: 'noopener', text: t`Previous avatar` }));
        card.append(h('p', { class: 'scratchpad-change-state', text: applied ? t`Avatar saved` : image.target === 'avatar' ? t`Image saved. The character card is unchanged.` : t`Image saved to your user images.` }));
    } else if (image?.state === 'pending') {
        const reviewing = Boolean(job?.result?.approval);
        card.append(h('p', { class: 'scratchpad-stage', role: 'status', text: reviewing ? t`Review the processed image prompt before generation.` : t`Generating image...` }));
        if (reviewing) actions.append(button(t`Review image prompt`, onPromptReview, { primary: true }));
        else actions.append(button(t`Stop image`, () => void cancelJob(image.jobId).catch(onError), { icon: 'fa-stop' }));
    } else if (image?.jobId) {
        card.append(h('p', { class: 'scratchpad-error', role: 'status', text: image.error || t`This image did not finish.` }));
        if (image.state === 'failed') actions.append(button(t`Retry saved job`, () => void retryJob(image.jobId).then(() => onRetried?.()).catch(onError)));
        else if (image.state === 'cancelled' && !dismissed) actions.append(button(t`Generate image`, onGenerate, { primary: true }));
    } else if (!dismissed) {
        actions.append(button(t`Generate image`, onGenerate, { primary: true }));
    }
    const reason = error || (!image?.url && !availability.image ? availability.reason : '');
    if (reason) card.append(h('p', { class: 'scratchpad-error', role: 'status', text: reason }));
    if (reason || !availability.image) actions.append(button(t`Open Quick Image Gen`, () => {
        if (!globalThis.NeconyanShell?.openIncludedTool?.('quick-image-gen')) globalThis.toastr?.info?.(t`Quick Image Gen is turned off. Turn it on under Included tools, then try again.`);
    }));
    if (dismissed) actions.append(h('span', { text: t`Dismissed` }), button(t`Undo`, onRestore));
    else if (image?.state !== 'pending' && !applied) actions.append(button(t`Dismiss`, onDismiss));
    card.append(actions);
    return card;
}

export async function prepareAvatarChange({ source, session, message, part, guard }) {
    const owner = getCurrentUserHandle();
    const check = () => { guard(); if (getCurrentUserHandle() !== owner) throw new Error(t`The account changed. Reopen the avatar review.`); };
    check();
    const review = await api.readAvatarReview(source, session.id, message.id, part.index);
    check();
    if (!safeImage(review.currentUrl) || !safeImage(review.proposedUrl) || !/^[a-f0-9]{64}$/.test(review.revision)) throw new Error(t`The avatar review could not verify its saved pictures.`);
    const image = message.images?.[part.index];
    if (image?.avatar !== review.avatar) throw new Error(t`The avatar target changed. Request a new suggestion.`);
    const picture = (label, url) => h('figure', {}, h('figcaption', { text: label }), h('img', { src: url, alt: label, loading: 'eager' }));
    return { target: review.name, field: t`Character avatar`, editable: false, before: '', after: '', bucket: review.bucket,
        visual: h('div', { class: 'scratchpad-avatar-review' }, picture(t`Current avatar`, review.currentUrl), picture(t`Proposed avatar`, review.proposedUrl)),
        hint: t`The previous picture, including its card data, is kept in your user images. Save change replaces only this card's portrait.`,
        async commit() {
            check();
            const form = new FormData();
            form.set('avatar_url', review.avatar);
            form.set('expected_revision', review.revision);
            form.set('scratchpad_avatar_review', JSON.stringify({ source, sessionId: session.id, messageId: message.id, index: part.index }));
            // The server installs its own saved reviewed picture; no image bytes are uploaded from the browser.
            const written = await fetch('/api/characters/edit-avatar', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
            if (!written.ok) {
                const body = await written.json().catch(() => ({}));
                throw new Error(body.message || t`The avatar was not saved. Review the current card again.`);
            }
            let refreshFailed = false;
            try {
                check();
                await getOneCharacter(review.avatar);
                printCharactersDebounced();
                const index = characters.findIndex(card => card.avatar === review.avatar);
                if (index >= 0) {
                    await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: index, character: characters[index] } });
                    if (String(index) === String(this_chid)) select_selected_character(this_chid, { switchMenu: false });
                }
                await refreshCharacterAvatar(review.avatar);
            } catch { refreshFailed = true; }
            return { committed: true, refreshFailed, avatar: review.avatar };
        } };
}

export async function reviewImagePrompt(job, { guard, popup, type, affirmative }) {
    guard();
    const approval = await getJobApproval(job.id, job.result.approval.id);
    guard();
    const content = h('div', { class: 'scratchpad-review' }, h('h3', { text: t`Processed image prompt` }),
        h('pre', { class: 'scratchpad-image-prompt', text: approval.proposal.prompt, 'data-i18n-ignore': '' }),
        h('p', { text: t`Exclude: ${approval.proposal.negative || ''}` }));
    const choice = await popup(content, type, '', { wide: true, okButton: t`Generate reviewed image`, cancelButton: t`Stop image` });
    guard();
    return decideJobApproval(job.id, { ...approval, decision: choice === affirmative ? 'allow' : 'deny' });
}
