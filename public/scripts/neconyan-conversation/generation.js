import { buildAssistantKnowledge, getAssistantKnowledgeBudget, isNeconyanAssistant } from '../neconyan-assistant-knowledge.js';
import { getCurrentUserHandle } from '../user.js';
import { preflightConversationBinding, requestConversationBinding } from './bindings.js';
import { CONVERSATION_ERROR_DETAIL_MAX_LENGTH, SAFE_TOAST_OPTIONS } from './constants.js';
import { getConversationGroupIdForAvatar, getConversationPersonaId, getConversationThreadStore, getCurrentCharAvatar } from './context.js';
import { getConversationThread, updateConversationThreadMessage } from './thread-store.js';
import { createConversationMessageAnchors, createConversationSubmissionKey } from './message-identity-utils.js';
import { cancelNativeConversationJob, waitForNativeConversationJob } from './native-jobs.js';
import { scheduleTimelineRender } from './render-scheduler.js';
import { conversationState } from './state.js';

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
    const limit = bindingRequest.contextLimits?.[scope.speakerAvatar || scope.target.avatar];
    const knowledge = await buildAssistantKnowledge({ ...assistantContext,
        maxTokens: limit ? getAssistantKnowledgeBudget(limit - Number(requestOptions.responseLength || 0)) : 2048 });
    requestOptions.systemPrompt = [requestOptions.systemPrompt, knowledge.text].filter(Boolean).join('\n\n');
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

/**
 * Submit a manual selfie as a server job. The server writes the image prompt,
 * renders the picture, writes the caption and posts it, so closing the page
 * does not lose a picture that was already paid for.
 * @returns {Promise<object|null>} the finished job, or null when the page stopped watching.
 */
export async function submitConversationSelfie({ avatar, speakerAvatar = avatar, branchId = '', groupId = '', personaId = '', context = '', sourceMessageId = '' } = {}) {
    const { account, scope, bindingRequest } = await captureConversationTextBinding({ avatar, speakerAvatar, branchId, groupId, personaId });
    const response = await requestConversationBinding('selfie/submit', { ...scope, bindingRequest,
        context: String(context || '').trim(), ...(sourceMessageId ? { sourceMessageId: String(sourceMessageId) } : {}),
        submissionKey: createConversationSubmissionKey('selfie'), acknowledgement: bindingRequest.acknowledgement }, account);
    if (!response?.job?.id) throw new Error('The server did not accept the selfie.');
    // The pending image bubble's Stop button cancels the server job; anything
    // already posted stays.
    const pending = { abort: () => cancelNativeConversationJob(response.job.id).catch(() => {}) };
    conversationState.imageGenerationActive = true;
    conversationState.imageGenerationAbortController = pending;
    scheduleTimelineRender();
    try {
        const job = await waitForNativeConversationJob(response.job.id, account);
        if (!job) return null;
        if (job.state === 'cancelled') return job;
        if (job.state !== 'completed') throw new Error(job.error?.message || 'The selfie did not finish.');
        return job;
    } finally {
        if (conversationState.imageGenerationAbortController === pending) {
            conversationState.imageGenerationActive = false;
            conversationState.imageGenerationAbortController = null;
            scheduleTimelineRender();
        }
    }
}

/** Run a manual selfie from a button or command and say how it went. */
export async function requestConversationSelfie(options) {
    try {
        const job = await submitConversationSelfie(options);
        if (!job) {
            globalThis.toastr?.info?.('The selfie is still being made on the server. It appears here when it is posted.', '', SAFE_TOAST_OPTIONS);
        }
        return true;
    } catch (error) {
        reportConversationGenerationError('selfie', error, { level: 'warning' });
        return false;
    }
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
