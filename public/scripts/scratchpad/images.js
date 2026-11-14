import { characters, getOneCharacter, getRequestHeaders, printCharactersDebounced, refreshCharacterAvatar, select_selected_character, this_chid } from '../../script.js';
import { event_types, eventSource } from '../events.js';
import { t } from '../i18n.js';
import { cancelJob, getJobApproval, decideJobApproval, retryJob } from '../jobs.js';
import { getExtensionCapability } from '../neconyan-conversation/extension-capabilities.js';
import { h } from '../notebooks/dom.js';
import { getCurrentUserHandle } from '../user.js';
import { getUserAvatars, refreshPersonaAvatar } from '../personas.js';
import { normalizeScenarioAvatar } from '../persona-appendix-avatar.js';
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
    if (part.change.action === 'edit' && !ready.edit && !part.change.character) throw new Error(ready.editReason);
    const acknowledgement = await acknowledge();
    guard();
    return api.generateImage({ source, sessionId: session.id, messageId: message.id, index: part.index, submissionKey: api.newSubmissionKey(), acknowledgement });
}

export function renderImageCard({ session, message, part, button, availability, job, error = '', onGenerate, onReview, onPromptReview, onDismiss, onRestore, onRetried, onError }) {
    const image = message.images?.[part.index];
    const applied = message.proposals?.[part.index] === 'applied';
    const dismissed = message.proposals?.[part.index] === 'rejected';
    const editing = part.change.action === 'edit';
    const editUnavailable = editing && !part.change.character && availability.image && availability.edit === false;
    const generateLabel = editing ? t`Edit image` : t`Generate image`;
    const card = h('div', { class: 'scratchpad-change scratchpad-image-card', dataset: { imageIndex: part.index } },
        h('p', { class: 'scratchpad-change-title', text: part.change.target === 'persona-note-avatar' ? t`New Scenario Note avatar for ${part.change.persona}` : part.change.target === 'persona-avatar' ? t`New persona avatar for ${part.change.persona}` : part.change.target === 'avatar' ? t`New avatar for ${part.change.character}` : editing ? t`Image edit suggestion` : t`Image suggestion` }),
        h('p', { class: 'scratchpad-image-prompt', text: part.change.prompt, 'data-i18n-ignore': '' }),
        part.change.negative ? h('p', { class: 'scratchpad-muted', text: t`Exclude: ${part.change.negative}` }) : null,
        part.change.reason ? h('p', { class: 'scratchpad-change-reason', text: part.change.reason, 'data-i18n-ignore': '' }) : null);
    if (editing) {
        const source = session.messages.find(item => item.id === part.change.source.messageId);
        const attachment = part.change.source.kind === 'attachment' ? source?.attachments?.[part.change.source.index] : null;
        card.append(h('p', { class: 'scratchpad-change-state', text: part.change.source.kind === 'attachment' ? t`Edit attached image: ${attachment?.name || t`Unavailable image`}` : t`Edit saved image from proposal ${part.change.source.index + 1}. The original is kept.` }));
    }
    const actions = h('div', { class: 'scratchpad-change-actions' });
    const original = editing && part.change.source.kind === 'generated' ? session.messages.find(item => item.id === part.change.source.messageId)?.images?.[part.change.source.index] : null;
    if (original && safeImage(original.url)) actions.append(h('a', { class: 'scratchpad-button scratchpad-image-link', href: original.url, target: '_blank', rel: 'noopener', text: t`View source image` }));
    if (image?.url && safeImage(image.url)) {
        card.append(h('img', { class: 'scratchpad-generated-image', src: image.url, alt: t`Generated image: ${image.prompt}`, loading: 'lazy',
            ...(image.width && image.height ? { width: image.width, height: image.height } : {}) }));
        actions.append(h('a', { class: 'scratchpad-button scratchpad-image-link', href: image.url, target: '_blank', rel: 'noopener', text: t`Open image` }),
            h('a', { class: 'scratchpad-button scratchpad-image-link', href: image.url, download: '', text: t`Download` }));
        if (['avatar', 'persona-avatar', 'persona-note-avatar'].includes(image.target) && !dismissed) actions.append(button(applied ? t`Avatar saved` : t`Review avatar`, onReview, { primary: true, disabled: applied }));
        if (safeImage(image.previousAvatarUrl)) actions.append(h('a', { class: 'scratchpad-button scratchpad-image-link', href: image.previousAvatarUrl, target: '_blank', rel: 'noopener', text: t`Previous avatar` }));
        card.append(h('p', { class: 'scratchpad-change-state', text: applied ? t`Avatar saved` : image.target === 'persona-note-avatar' ? t`Image saved. The Scenario Note is unchanged.` : image.target === 'persona-avatar' ? t`Image saved. The persona is unchanged.` : image.target === 'avatar' ? t`Image saved. The character card is unchanged.` : t`Image saved to your user images.` }));
    } else if (image?.state === 'pending') {
        const approval = Boolean(job?.result?.approval);
        const reviewing = approval || (Boolean(image.review) && job?.stage !== 'approved');
        card.append(h('p', { class: 'scratchpad-stage', role: 'status', text: reviewing ? t`Review the processed image prompt before generation.` : t`Generating image...` }));
        if (approval) actions.append(button(t`Review image prompt`, onPromptReview, { primary: true }));
        else if (!reviewing) actions.append(button(t`Stop image`, () => void cancelJob(image.jobId).catch(onError), { icon: 'fa-stop' }));
    } else if (image?.jobId) {
        card.append(h('p', { class: 'scratchpad-error', role: 'status', text: image.error || t`This image did not finish.` }));
        if (image.state === 'failed') actions.append(button(t`Retry saved job`, () => void retryJob(image.jobId).then(() => onRetried?.()).catch(onError)));
        else if (image.state === 'cancelled' && !dismissed) actions.append(button(generateLabel, onGenerate, { primary: true, disabled: editUnavailable }));
    } else if (!dismissed) {
        actions.append(button(generateLabel, onGenerate, { primary: true, disabled: editUnavailable }));
    }
    const reason = error || (!image?.url && editUnavailable ? availability.editReason : !image?.url && !availability.image ? availability.reason : '');
    if (reason) card.append(h('p', { class: 'scratchpad-error', role: 'status', text: reason }));
    if (reason || !availability.image) actions.append(button(t`Open Quick Image Gen`, () => {
        if (!globalThis.NeconyanShell?.openIncludedTool?.('quick-image-gen')) globalThis.toastr?.info?.(t`Quick Image Gen is turned off. Turn it on in Manage extensions, then try again.`);
    }));
    if (dismissed) actions.append(h('span', { text: t`Dismissed` }), button(t`Undo`, onRestore));
    else if (image?.state !== 'pending' && !applied) actions.append(button(t`Dismiss`, onDismiss));
    card.append(actions);
    return card;
}

export async function prepareAvatarChange({ source, personaSource = source, session, message, part, guard }) {
    const owner = getCurrentUserHandle();
    const check = () => { guard(); if (getCurrentUserHandle() !== owner) throw new Error(t`The account changed. Reopen the avatar review.`); };
    check();
    const review = await api.readAvatarReview(source, session.id, message.id, part.index);
    check();
    if (!safeImage(review.currentUrl) || !safeImage(review.proposedUrl) || !/^[a-f0-9]{64}$/.test(review.revision)) throw new Error(t`The avatar review could not verify its saved pictures.`);
    const image = message.images?.[part.index];
    const persona = part.change.target === 'persona-avatar';
    if (persona && review.kind !== 'persona') throw new Error(t`The persona avatar target could not be verified.`);
    if (image?.avatar !== review.avatar) throw new Error(t`The avatar target changed. Request a new suggestion.`);
    if (part.change.target === 'persona-note-avatar') {
        if (review.kind !== 'persona-note' || review.noteId !== part.change.noteId || !normalizeScenarioAvatar(review.proposedAvatar)) throw new Error(t`The Scenario Note avatar could not be verified.`);
        const { preparePersonaChange } = await import('./persona-changes.js');
        const plan = await preparePersonaChange({ type: 'persona-note', persona: part.change.persona, noteId: part.change.noteId, field: 'avatar', value: review.proposedAvatar }, personaSource, message.sharedPersona, check);
        if (plan.before !== review.avatarValue) throw new Error(t`Save the current Scenario Note before reviewing its avatar.`);
        return { ...plan, bucket: review.bucket, async commit() {
            check();
            const fresh = await api.readAvatarReview(source, session.id, message.id, part.index);
            check();
            if (fresh.avatar !== review.avatar || fresh.noteId !== review.noteId || fresh.revision !== review.revision || fresh.avatarValue !== review.avatarValue || fresh.proposedAvatar !== review.proposedAvatar) throw new Error(t`The Scenario Note avatar changed. Review it again.`);
            return plan.commit(review.proposedAvatar);
        } };
    }
    const picture = (label, url) => h('figure', {}, h('figcaption', { text: label }), h('img', { src: url, alt: label, loading: 'eager' }));
    return { target: review.name, field: persona ? t`Persona avatar` : t`Character avatar`, editable: false, before: '', after: '', bucket: review.bucket,
        visual: h('div', { class: 'scratchpad-avatar-review' }, picture(t`Current avatar`, review.currentUrl), picture(t`Proposed avatar`, review.proposedUrl)),
        hint: persona ? t`The previous picture is kept in your user images. Save change replaces this persona's portrait across chats.` : t`The previous picture, including its card data, is kept in your user images. Save change replaces only this card's portrait.`,
        async commit() {
            check();
            const form = new FormData();
            form.set('avatar_url', review.avatar);
            form.set('expected_revision', review.revision);
            form.set('scratchpad_avatar_review', JSON.stringify({ source, sessionId: session.id, messageId: message.id, index: part.index }));
            // The server installs its own saved reviewed picture; no image bytes are uploaded from the browser.
            const written = persona
                ? await fetch('/api/scratchpad/images/persona-avatar', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ source, sessionId: session.id, messageId: message.id, index: part.index, avatar: review.avatar, revision: review.revision }) })
                : await fetch('/api/characters/edit-avatar', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
            if (!written.ok) {
                const body = await written.json().catch(() => ({}));
                throw new Error(body.message || t`The avatar was not saved. Review the current card again.`);
            }
            let refreshFailed = false;
            try {
                check();
                if (persona) {
                    await getUserAvatars();
                    await refreshPersonaAvatar(review.avatar);
                    await eventSource.emit(event_types.PERSONA_UPDATED, review.avatar);
                    return { committed: true, refreshFailed: false, avatar: review.avatar };
                }
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
    const choice = await popup(content, type, '', { wide: true, okButton: t`Generate reviewed image`, cancelButton: t`Cancel` });
    guard();
    return decideJobApproval(job.id, { ...approval, decision: choice === affirmative ? 'allow' : 'deny' });
}
