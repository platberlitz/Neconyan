import { characters } from '../../script.js';
import { buildAssistantKnowledge, getAssistantKnowledgeBudget, isNeconyanAssistant } from '../neconyan-assistant-knowledge.js';
import { getCurrentUserHandle } from '../user.js';
import { preflightConversationBinding, requestConversationBinding } from './bindings.js';
import {
    CONVERSATION_ERROR_DETAIL_MAX_LENGTH,
    MAX_CONVERSATION_REPLY_MAX_TOKENS,
    MIN_CONVERSATION_REPLY_MAX_TOKENS,
    SAFE_TOAST_OPTIONS,
} from './constants.js';
import { getConversationGroupById, getConversationGroupIdForAvatar, getConversationPersonaId, getConversationThreadStore, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import {
    buildSelfieImagePromptTemplate,
    extractCharacterReplyCommandParts,
    normalizeConversationOutputText,
    resolveConversationScheduleUpdate,
} from './generation-utils.js';
import { buildCharacterImagePrompt, generateConversationImage, getCharacterForAvatar, getCharacterImageDetails } from './media.js';
import { appendConversationMessage } from './message-writer.js';
import { stripSpeakerPrefix } from './partners.js';
import { deliverConversationReply } from './reply-delivery.js';
import { buildConversationPromptMessages, buildConversationSystemPrompt } from './prompt.js';
import { formatPromptText } from './shared-helpers.js';
import { clamp, getConversationReplyMaxTokens, getConversationRuntimeStatusKey } from './schedule.js';
import { runtimeStatusOverrides } from './state.js';
import {
    addConversationReminder,
    buildConversationMessageReplyReference,
    getConversationThread,
    getImageCooldownRemainingSeconds,
    hasConversationMessageContent,
    markImageGenerated,
    updateConversationThreadMessage,
} from './thread-store.js';
import { waitForReplyDelay, withTypingParticipant } from './typing.js';
import { createConversationMessageAnchors, createConversationSubmissionKey } from './message-identity-utils.js';
import { waitForNativeConversationJob } from './native-jobs.js';

let activeConversationEditor = null;

export {
    extractCharacterReplyCommandParts,
    getCharacterReplyCommandMetadata,
    normalizeConversationOutputText,
    parseCommandArgs,
} from './generation-utils.js';

/** Capture the saved connection before preparation; a rejected profile never falls back. */
export async function captureConversationTextBinding(providedScope = {}, options) {
    const account = getCurrentUserHandle();
    const avatar = providedScope.avatar || getCurrentCharAvatar();
    const groupId = providedScope.groupId ?? getConversationGroupIdForAvatar(avatar);
    const personaId = providedScope.personaId ?? getConversationPersonaId();
    const thread = getConversationThreadStore(avatar, { create: true, groupId, personaId });
    const branchId = providedScope.branchId || thread?.activeBranchId;
    const scope = { target: { avatar, groupId, personaId, branchId }, branchCreatedAt: String(thread?.branches?.[branchId]?.createdAt ?? ''),
        speakerAvatar: providedScope.speakerAvatar || avatar,
        triggers: createConversationMessageAnchors(providedScope.messages || thread?.branches?.[branchId]?.messages || []) };
    const { sha256 } = await import('../../lib.js');
    scope.triggers = scope.triggers.map(({ messageId, revision }) => ({ messageId, revisionHash: sha256(revision) }));
    return { account, scope, bindingRequest: await preflightConversationBinding({ ...scope, bindingOnly: !options, ...(options ? { options } : {}) }, account) };
}

async function addAssistantKnowledge(requestOptions, scope, bindingRequest, assistantContext) {
    if (!isNeconyanAssistant(assistantContext?.character)) return;
    const limit = bindingRequest.contextLimits?.[scope.target.avatar];
    const knowledge = await buildAssistantKnowledge({ ...assistantContext,
        maxTokens: limit ? getAssistantKnowledgeBudget(limit - Number(requestOptions.responseLength || 0)) : 2048 });
    requestOptions.systemPrompt = [requestOptions.systemPrompt, knowledge.text].filter(Boolean).join('\n\n');
}

export async function generateConversationRaw(options, settings, assistantContext = null) {
    const { signal, scope: providedScope, bindingContext, ...requestOptions } = options;
    const { account, scope, bindingRequest } = bindingContext || await captureConversationTextBinding(providedScope, requestOptions);
    await addAssistantKnowledge(requestOptions, scope, bindingRequest, assistantContext);
    const result = await requestConversationBinding('binding/generate', { ...scope, bindingRequest,
        options: requestOptions }, account, signal);
    return result.text;
}

function getDeviceTimeZone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/**
 * Submit a regeneration or polish as a server job. The server keeps the paid
 * text, writes it into the message and applies any commands in one save, and
 * leaves the original reply untouched when the message changed meanwhile.
 * The saved store is read back before this resolves.
 * @returns {Promise<{ messageId: string, job: object } | null>} null when the page stopped watching.
 */
export async function submitConversationRewrite(mode, messageId, options, assistantContext = null) {
    const { scope: providedScope, bindingContext, ...requestOptions } = options;
    const { account, scope, bindingRequest } = bindingContext || await captureConversationTextBinding(providedScope, requestOptions);
    await addAssistantKnowledge(requestOptions, scope, bindingRequest, assistantContext);
    const response = await requestConversationBinding('rewrite/submit', { ...scope, bindingRequest, options: requestOptions,
        mode, messageId, submissionKey: createConversationSubmissionKey(mode), acknowledgement: bindingRequest.acknowledgement,
        timeZone: getDeviceTimeZone() }, account);
    if (!response?.job?.id) throw new Error('The server did not accept the rewrite.');
    const job = await waitForNativeConversationJob(response.job.id, account);
    if (!job) return null;
    if (job.state !== 'completed') throw new Error(job.error?.message || 'The rewrite did not finish.');
    return { messageId, job };
}

export async function generateConversationReply(directive, settings, { responseLength = null, speakerName = getCurrentCharName(), trimNames = true, avatar = getCurrentCharAvatar(), threadAvatar = avatar, speakerAvatar = avatar, branchId = '', groupId = getConversationGroupIdForAvatar(threadAvatar), personaId = getConversationPersonaId() } = {}) {
    const messages = getConversationThread(threadAvatar, { branchId, create: false, groupId, personaId });
    const assistantContext = { character: getCharacterForAvatar(speakerAvatar), messages: messages.map(message => ({ role: message.role, mes: message.mes })) };
    const resolvedResponseLength = Number.isFinite(responseLength) && responseLength > 0
        ? clamp(Math.round(responseLength), MIN_CONVERSATION_REPLY_MAX_TOKENS, MAX_CONVERSATION_REPLY_MAX_TOKENS)
        : getConversationReplyMaxTokens(settings);
    const bindingContext = await captureConversationTextBinding({ avatar: threadAvatar, speakerAvatar, branchId, groupId, personaId, messages });
    const prompt = await buildConversationPromptMessages(messages, directive, speakerName, { groupId, personaId });

    return generateConversationRaw({
        prompt,
        systemPrompt: buildConversationSystemPrompt(settings, speakerAvatar, { threadAvatar, branchId, groupId, personaId }),
        responseLength: resolvedResponseLength,
        trimNames,
        bindingContext,
        cacheScope: 'conversation-mode',
        scope: { avatar: threadAvatar, speakerAvatar, branchId, groupId, personaId },
    }, settings, assistantContext);
}

export function editConversationMessage(messageId) {
    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const personaId = getConversationPersonaId();
    const normalizedMessageId = String(messageId || '');
    const message = getConversationThread(avatar, { create: false, groupId, personaId })
        .find(item => String(item.id || '') === normalizedMessageId);
    if (!avatar || !message) {
        return;
    }

    const messageElement = Array.from(document.querySelectorAll('.sb-conversation-message'))
        .find(element => element.dataset.messageId === normalizedMessageId);
    if (!messageElement) {
        return;
    }

    const textElement = messageElement.querySelector('.sb-conversation-message-text');
    if (!textElement) {
        return;
    }

    if (activeConversationEditor?.messageElement === messageElement) {
        return;
    }

    if (activeConversationEditor && !activeConversationEditor.requestClose()) {
        return;
    }

    const originalTextElement = textElement.cloneNode(true);

    const textarea = document.createElement('textarea');
    textarea.className = 'sb-conversation-message-edit-textarea';
    textarea.value = message.mes;

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'sb-conversation-message-edit-buttons';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'menu_button sb-conversation-message-edit-control sb-conversation-message-edit-save fa-solid fa-check';
    saveButton.title = 'Save message changes';
    saveButton.setAttribute('aria-label', 'Save message changes');

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'menu_button sb-conversation-message-edit-control sb-conversation-message-edit-cancel fa-solid fa-xmark';
    cancelButton.title = 'Discard message changes';
    cancelButton.setAttribute('aria-label', 'Discard message changes');

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'menu_button sb-conversation-message-edit-control sb-conversation-message-edit-delete fa-solid fa-trash-can';
    deleteButton.title = 'Delete message';
    deleteButton.setAttribute('aria-label', 'Delete message');
    deleteButton.dataset.sbConversationAction = 'delete-message';
    deleteButton.dataset.messageId = message.id;

    buttonContainer.append(saveButton, cancelButton, deleteButton);

    textElement.textContent = '';
    textElement.append(textarea, buttonContainer);
    messageElement.classList.add('is-editing');
    messageElement.querySelector('.sb-conversation-message-actions')?.classList.remove('open');

    const closeEditor = () => {
        if (textElement.isConnected) {
            textElement.replaceWith(originalTextElement);
        }
        messageElement.classList.remove('is-editing');
        messageElement.querySelector('.sb-conversation-message-actions')?.classList.remove('open');
        if (activeConversationEditor?.messageElement === messageElement) {
            activeConversationEditor = null;
        }
    };

    // Switching editors drops whatever is in the textarea, so confirm first when it differs
    // from the stored message. Falls through when no confirm() exists (non-browser hosts).
    const requestClose = () => {
        if (textarea.value !== message.mes
            && typeof globalThis.confirm === 'function'
            && !globalThis.confirm('Discard unsaved changes to the message being edited?')) {
            return false;
        }

        closeEditor();
        return true;
    };

    activeConversationEditor = { messageElement, requestClose };

    saveButton.onclick = () => {
        const value = textarea.value;
        closeEditor();
        // A blanked textarea is not an edit: the delete control is the only way to drop a message.
        if (value.trim() && value !== message.mes) {
            updateConversationThreadMessage(avatar, message.id, value, null, { groupId, personaId });
        }
    };

    cancelButton.onclick = closeEditor;

    textarea.onkeydown = (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            saveButton.click();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelButton.click();
        }
    };

    textarea.focus({ preventScroll: true });
}

export function applyScheduleUpdateCommand(avatar, rawArgs, { personaId = getConversationPersonaId() } = {}) {
    const update = resolveConversationScheduleUpdate(rawArgs);
    if (avatar && update) runtimeStatusOverrides.set(getConversationRuntimeStatusKey(avatar, personaId), update);
}

export function extractCharacterReplyCommands(rawText, settings) {
    return extractCharacterReplyCommandParts(rawText, settings);
}

export function commitCharacterReplyCommands(commandParts, avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId(), reminderAvatar = avatar } = {}) {
    for (const rawArgs of commandParts.scheduleUpdates) {
        applyScheduleUpdateCommand(avatar, rawArgs, { personaId });
    }

    // Always enable parsing of the reminder command from character DMs!
    for (const reminder of commandParts.reminders) {
        addConversationReminder(reminderAvatar, groupId, reminder.delay, reminder.memo, { branchId, personaId });
    }
}

export function getConversationErrorDetail(error) {
    let detail = '';
    if (typeof error === 'string') {
        detail = error;
    } else if (error?.message) {
        detail = error.message;
    } else if (error?.response) {
        detail = error.response;
    } else if (error?.error?.message) {
        detail = error.error.message;
    } else if (error?.error) {
        detail = error.error;
    } else if (error) {
        try {
            detail = JSON.stringify(error);
        } catch {
            detail = String(error);
        }
    }

    return String(detail || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, CONVERSATION_ERROR_DETAIL_MAX_LENGTH);
}

export function reportConversationGenerationError(context, error, { toast = true, level = 'error' } = {}) {
    const detail = getConversationErrorDetail(error);
    const label = context ? `Conversation ${context}` : 'Conversation generation';
    const log = level === 'warning' ? console.warn : console.error;
    log(`${label} failed${detail ? `: ${detail}` : ''}`, error);

    if (!toast) {
        return;
    }

    const message = `${label} failed${detail ? `: ${detail}` : '. Check the browser console for details.'}`;
    if (level === 'warning') {
        globalThis.toastr?.warning?.(message, '', SAFE_TOAST_OPTIONS);
    } else {
        globalThis.toastr?.error?.(message, '', SAFE_TOAST_OPTIONS);
    }
}

export { splitPartnerChatroomMessages } from './reply-delivery.js';

function addConversationReplySpeaker(speakers, speaker) {
    const avatar = String(speaker?.avatar || '').trim();
    const name = String(speaker?.name || '').trim();
    if (!avatar || !name || speakers.some(item => item.avatar === avatar)) {
        return;
    }

    speakers.push({ avatar, name });
}

function getConversationReplySpeakers(threadAvatar, fallbackSpeaker, groupId, personaId) {
    const speakers = [];
    addConversationReplySpeaker(speakers, fallbackSpeaker);

    const threadCharacter = getCharacterForAvatar(threadAvatar);
    addConversationReplySpeaker(speakers, threadCharacter || { avatar: threadAvatar, name: getCurrentCharName() });

    const group = groupId ? getConversationGroupById(groupId, { personaId }) : null;
    if (group?.members?.length) {
        for (const memberAvatar of group.members) {
            if (group.disabled_members?.includes(memberAvatar)) {
                continue;
            }
            const character = getCharacterForAvatar(memberAvatar);
            addConversationReplySpeaker(speakers, character);
        }
    }

    return speakers;
}

function getResolvedReplyRole(speakerAvatar, threadAvatar) {
    return speakerAvatar && speakerAvatar !== threadAvatar ? 'partner' : 'character';
}

function getConversationGeneratedMessageSpeakerId(message, threadAvatar) {
    if (message?.role === 'user') {
        return 'user';
    }
    if (message?.role === 'partner') {
        return String(message.extra?.partner_avatar || '').trim();
    }
    if (message?.role === 'character') {
        return String(threadAvatar || '').trim();
    }

    return '';
}

function getGeneratedReplyReference(speakerAvatar, threadAvatar, { branchId = '', groupId = undefined, personaId = getConversationPersonaId() } = {}) {
    const speakerId = String(speakerAvatar || '').trim();
    const messages = getConversationThread(threadAvatar, { branchId, create: false, groupId, personaId });
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message || message.role === 'system' || !hasConversationMessageContent(message)) {
            continue;
        }

        const messageSpeakerId = getConversationGeneratedMessageSpeakerId(message, threadAvatar);
        if (speakerId && messageSpeakerId && speakerId === messageSpeakerId) {
            // Stop at a previous message from the same speaker. Follow-up messages
            // should not keep replying to the same older user/partner message.
            break;
        }

        const reference = buildConversationMessageReplyReference(message);
        if (reference) {
            return reference;
        }
    }

    return null;
}

function getResolvedReplyExtra(extra, speakerAvatar, threadAvatar, { branchId = '', groupId = undefined, personaId = getConversationPersonaId(), attachReplyReference = true } = {}) {
    const resolvedExtra = { ...extra };
    if (speakerAvatar && speakerAvatar !== threadAvatar) {
        resolvedExtra.partner_avatar = speakerAvatar;
    } else {
        delete resolvedExtra.partner_avatar;
    }

    if (!attachReplyReference) {
        delete resolvedExtra.conversation_reply_to;
    } else if (!resolvedExtra.conversation_reply_to) {
        const replyReference = getGeneratedReplyReference(speakerAvatar, threadAvatar, { branchId, groupId, personaId });
        if (replyReference) {
            resolvedExtra.conversation_reply_to = replyReference;
        }
    }

    return resolvedExtra;
}

async function appendResolvedConversationReply(messageText, speaker, settings, { avatar, extra = {}, branchId = '', groupId = undefined, personaId = getConversationPersonaId(), attachReplyReference = true, validateTarget = null } = {}) {
    const speakerAvatar = speaker?.avatar || avatar;
    const speakerName = speaker?.name || 'Character';
    const role = getResolvedReplyRole(speakerAvatar, avatar);
    const resolvedInputExtra = { ...extra };
    if (!attachReplyReference) {
        delete resolvedInputExtra.conversation_reply_to;
    }
    const resolvedExtra = getResolvedReplyExtra(resolvedInputExtra, speakerAvatar, avatar, { branchId, groupId, personaId, attachReplyReference });

    return withTypingParticipant({ avatar: speakerAvatar, name: speakerName }, async () => {
        await waitForReplyDelay(messageText, settings, speakerAvatar, { branchId, groupId, personaId });
        if (typeof validateTarget === 'function' && !validateTarget()) {
            return null;
        }
        return appendConversationMessage(messageText, {
            name: speakerName,
            role,
            extra: resolvedExtra,
            branchId,
            groupId,
            personaId,
        }, avatar);
    }, avatar, { branchId, groupId, personaId });
}

export async function postPartnerConversationReply(rawText, partner, partnerSettings, { avatar = getCurrentCharAvatar(), extra = {}, branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId(), validateTarget = null } = {}) {
    if (!avatar || !partner) return false;
    const result = await deliverReply(rawText, partnerSettings, { avatar: partner.avatar, name: partner.name || 'A friend' }, {
        avatar, extra, branchId, groupId, personaId, validateTarget, partner: true,
    });
    return result.posted;
}

function deliverReply(rawText, settings, fallbackSpeaker, { avatar, extra, branchId, groupId, personaId, validateTarget, partner = false }) {
    const scope = { branchId, groupId, personaId };
    return deliverConversationReply(rawText, settings, {
        fallbackSpeaker, groupId, extra, splitEveryLine: partner,
        getSpeakers: () => getConversationReplySpeakers(avatar, fallbackSpeaker, groupId, personaId),
        validateTarget: () => typeof validateTarget !== 'function' || validateTarget(),
        append: (text, speaker, options) => appendResolvedConversationReply(text, speaker, settings, { avatar, ...scope, ...options, validateTarget }),
        commitCommands: (commands, speakerAvatar) => commitCharacterReplyCommands(commands, speakerAvatar, { ...scope, reminderAvatar: avatar }),
        generateImage: (context, speaker, { attachReplyReference }) => {
            const speakerAvatar = speaker.avatar || fallbackSpeaker.avatar;
            const generate = () => generateSelfieFromContext(context, settings, speakerAvatar, {
                threadAvatar: avatar, role: getResolvedReplyRole(speakerAvatar, avatar), name: speaker.name || '',
                extra: getResolvedReplyExtra(extra, speakerAvatar, avatar, { ...scope, attachReplyReference }), ...scope, validateTarget,
            });
            return partner ? withTypingParticipant({ avatar: speakerAvatar, name: speaker.name || fallbackSpeaker.name }, generate, avatar, scope) : generate();
        },
    });
}

export async function generateSelfieFromContext(context, settings, avatar = getCurrentCharAvatar(), { threadAvatar = avatar, role = 'character', name = '', extra = {}, branchId = '', groupId = undefined, personaId = getConversationPersonaId(), force = false, notify = false, validateTarget = null } = {}) {
    const resolvedSettings = settings || {};
    if (!avatar) {
        return false;
    }
    if (typeof validateTarget === 'function' && !validateTarget()) {
        return false;
    }

    const cooldownRemaining = getImageCooldownRemainingSeconds(avatar, resolvedSettings, Date.now(), { branchId, groupId, personaId });
    if (!force && (!resolvedSettings.image_gen_enabled || cooldownRemaining > 0)) {
        return false;
    }

    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || 'Character';
    const appearance = getCharacterImageDetails(avatar);
    const metaPrompt = [
        'You are an image prompt generator. Write a concise, detailed image generation prompt for a selfie photo.',
        `Character name: ${charName}.`,
        appearance ? `Appearance: ${appearance}` : '',
        context ? `Photo context: ${context}` : 'Photo context: a casual selfie in the current moment.',
        'Include appearance, clothing, expression and selfie pose, setting/background, and lighting. Output ONLY the prompt text, nothing else.',
    ].filter(Boolean).join('\n');

    let imagePrompt = '';
    let bindingContext;
    try {
        bindingContext = await captureConversationTextBinding({ avatar: threadAvatar, speakerAvatar: avatar, branchId, groupId, personaId });
        imagePrompt = await generateConversationRaw({
            prompt: metaPrompt,
            systemPrompt: 'You output only a raw image generation prompt with no preamble.',
            responseLength: 200,
            trimNames: false,
            bindingContext,
        }, resolvedSettings);
    } catch (error) {
        console.warn('Conversation Mode: selfie prompt generation failed', error);
        if (notify) reportConversationGenerationError('selfie', error, { level: 'warning' });
        return false;
    }

    const scene = context || 'a casual selfie in the current moment';
    imagePrompt = buildCharacterImagePrompt(
        buildSelfieImagePromptTemplate(formatPromptText(imagePrompt, 600), resolvedSettings.selfie_prompt, scene),
        scene,
        avatar,
    );

    const imageUrl = await generateConversationImage(imagePrompt, resolvedSettings.image_gen_negative || '', { avatar, character, notify });
    if (imageUrl && (typeof validateTarget !== 'function' || validateTarget())) {
        let caption;
        try {
            caption = await generateSelfieCaption(scene, resolvedSettings, avatar, imagePrompt, bindingContext);
        } catch (error) {
            if (notify) reportConversationGenerationError('selfie caption', error, { level: 'warning' });
            return false;
        }
        if (typeof validateTarget === 'function' && !validateTarget()) {
            return false;
        }
        markImageGenerated(avatar, Date.now(), { branchId, groupId, personaId });
        await appendConversationMessage(caption, {
            name,
            role,
            extra: { ...extra, conversation_mode_image: true, image_url: imageUrl, image_prompt: imagePrompt },
            branchId,
            groupId,
            personaId,
        }, threadAvatar);
        return true;
    }

    return false;
}

async function generateSelfieCaption(context, settings, avatar, imagePrompt, bindingContext) {
    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName() || 'Character';
    const captionPrompt = [
        `Character name: ${charName}.`,
        character?.description ? `Description: ${formatPromptText(character.description, 900)}` : '',
        character?.personality ? `Personality: ${formatPromptText(character.personality, 700)}` : '',
        context ? `Selfie context: ${formatPromptText(context, 400)}` : 'Selfie context: a casual selfie in the current moment.',
        imagePrompt ? `Generated image prompt: ${formatPromptText(imagePrompt, 600)}` : '',
        'Write one short in-character chat message to accompany this selfie. Keep it natural, under 25 words, and output only the message text.',
    ].filter(Boolean).join('\n');

    try {
        const rawCaption = await generateConversationRaw({
            prompt: captionPrompt,
            systemPrompt: 'You write only a short in-character chat caption. No speaker labels, no stage directions, no preamble.',
            responseLength: 80,
            trimNames: false,
            bindingContext,
        }, settings || {});
        const caption = normalizeConversationOutputText(stripSpeakerPrefix(formatPromptText(rawCaption, 240), charName));
        if (caption) {
            return caption;
        }
    } catch (error) {
        console.warn('Conversation Mode: selfie caption generation failed', error);
        throw error;
    }

    return 'Here, I took this for you.';
}

export async function postCharacterReply(rawText, settings, { extra = {}, branchId = '', groupId = undefined, personaId = getConversationPersonaId(), validateTarget = null } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) return '';
    const character = (Array.isArray(characters) ? characters : []).find(c => c?.avatar === avatar);
    const speakerName = character?.name || getCurrentCharName();
    const result = await deliverReply(rawText, settings, { avatar, name: speakerName }, {
        avatar, extra, branchId, groupId, personaId, validateTarget,
    });
    return result.text.join('\n');
}
