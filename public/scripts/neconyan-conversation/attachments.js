import { getRequestHeaders, is_send_press } from '../../script.js';
import { getCurrentUserHandle } from '../user.js';
import { MEDIA_DISPLAY } from '../constants.js';
import {
    CHROME_IDS,
    CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS,
    CONVERSATION_ATTACHMENT_MAX_BYTES,
    CONVERSATION_ATTACHMENT_MAX_FILES,
    SAFE_TOAST_OPTIONS,
} from './constants.js';
import {
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationThreadStore,
    getCurrentCharAvatar,
} from './context.js';
import { createConversationMessageAnchors, getConversationMessageRevision } from './message-identity-utils.js';
import { observeNativeConversationJob } from './native-jobs.js';
import { getConversationPersonaName } from './personas.js';
import { formatConversationFileSize } from './prompt.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { escapeHtmlText } from './render-utils.js';
import { getSettings, saveSettings } from './settings-store.js';
import { formatPromptText } from './shared-helpers.js';
import { conversationState } from './state.js';
import { assertConversationAccount, flushConversationStore, refreshConversationStore } from './store-sync.js';
import {
    getConversationAttachmentSummary,
    getConversationFileAttachments,
    getConversationMediaAttachments,
    getConversationThread,
} from './thread-store.js';
import { clearConversationReplyTarget, getActiveConversationReplyTarget } from './timeline-render.js';
import { handleConversationSlashAction } from './timeline-slash-commands.js';
import { splitChatroomMessages } from './typing.js';

function buildConversationUserMessageExtra(replyTarget = null) {
    return {
        conversation_mode_user: true,
        ...(replyTarget ? { conversation_reply_to: replyTarget } : {}),
    };
}

export function getConversationPendingFiles() {
    const fileInput = document.getElementById(CHROME_IDS.fileInput);
    if (!(fileInput instanceof HTMLInputElement) || !fileInput.files?.length) {
        return [];
    }

    return Array.from(fileInput.files);
}

export function getConversationFileExtension(file) {
    const name = String(file?.name || '').toLowerCase();
    const dotIndex = name.lastIndexOf('.');
    return dotIndex >= 0 ? name.slice(dotIndex) : '';
}

export function isConversationAttachmentAllowed(file) {
    const mime = String(file?.type || '').toLowerCase();
    if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) {
        return true;
    }

    return CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS.includes(getConversationFileExtension(file));
}

export function warnConversationAttachment(message) {
    globalThis.toastr?.warning?.(message, '', SAFE_TOAST_OPTIONS);
}

export function getValidatedConversationPendingFiles({ notify = false } = {}) {
    const files = getConversationPendingFiles();
    if (!files.length) {
        return files;
    }

    if (files.length > CONVERSATION_ATTACHMENT_MAX_FILES) {
        if (notify) {
            warnConversationAttachment(`Attach up to ${CONVERSATION_ATTACHMENT_MAX_FILES} files per Conversation message.`);
        }
        return null;
    }

    const oversized = files.find(file => Number(file?.size || 0) > CONVERSATION_ATTACHMENT_MAX_BYTES);
    if (oversized) {
        if (notify) {
            warnConversationAttachment(`${oversized.name || 'Attachment'} is over ${formatConversationFileSize(CONVERSATION_ATTACHMENT_MAX_BYTES)}.`);
        }
        return null;
    }

    const blocked = files.find(file => !isConversationAttachmentAllowed(file));
    if (blocked) {
        if (notify) {
            warnConversationAttachment(`${blocked.name || 'Attachment'} is not a supported Conversation attachment type.`);
        }
        return null;
    }

    return files;
}

export function updateConversationAttachmentPreview() {
    const preview = document.getElementById(CHROME_IDS.attachmentPreview);
    if (!(preview instanceof HTMLElement)) {
        return;
    }

    const files = getConversationPendingFiles();
    if (!files.length) {
        preview.hidden = true;
        preview.textContent = '';
        return;
    }

    const fileRows = files.slice(0, 4).map((file) => {
        const size = formatConversationFileSize(file.size);
        return `<span class="sb-conversation-attachment-pill"><i class="fa-solid fa-paperclip" aria-hidden="true"></i><span>${escapeHtmlText(file.name)}</span>${size ? `<small>${escapeHtmlText(size)}</small>` : ''}</span>`;
    });
    if (files.length > 4) {
        fileRows.push(`<span class="sb-conversation-attachment-pill">+${files.length - 4} more</span>`);
    }

    preview.innerHTML = `
        <div class="sb-conversation-attachment-list">${fileRows.join('')}</div>
        <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="clear-attachments" title="Clear attachments" aria-label="Clear attachments">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
    `;
    preview.hidden = false;
}

export function clearConversationAttachmentInput() {
    const fileInput = document.getElementById(CHROME_IDS.fileInput);
    if (fileInput instanceof HTMLInputElement) {
        fileInput.value = '';
    }
    updateConversationAttachmentPreview();
}

export function addConversationFilesToInput(files) {
    const fileInput = document.getElementById(CHROME_IDS.fileInput);
    if (!(fileInput instanceof HTMLInputElement) || !files?.length) {
        return;
    }

    const transfer = typeof DataTransfer === 'function' ? new DataTransfer() : null;
    const previousTransfer = typeof DataTransfer === 'function' ? new DataTransfer() : null;
    if (!transfer || !previousTransfer) {
        return;
    }

    for (const file of Array.from(fileInput.files || [])) {
        previousTransfer.items.add(file);
        transfer.items.add(file);
    }
    for (const file of files) {
        transfer.items.add(file);
    }

    fileInput.files = transfer.files;
    if (getValidatedConversationPendingFiles({ notify: true })) {
        updateConversationAttachmentPreview();
    } else {
        fileInput.files = previousTransfer.files;
        updateConversationAttachmentPreview();
    }
}

export async function populateConversationUserAttachments(messageInput, account = getCurrentUserHandle()) {
    assertConversationAccount(account);
    const pendingFiles = getValidatedConversationPendingFiles();
    if (!pendingFiles?.length) {
        return;
    }

    const { populateFileAttachment } = await import('../chats.js');
    // Conversation clears its own file input after the send is accepted; do not
    // let the shared helper reset the Roleplay attachment form here.
    await populateFileAttachment(messageInput, CHROME_IDS.fileInput, { resetForm: false, account });
    assertConversationAccount(account);
    if (getConversationMediaAttachments(messageInput).length) {
        messageInput.extra.media_display = MEDIA_DISPLAY.LIST;
        messageInput.extra.inline_image = true;
    }
}

export async function buildConversationAttachmentPromptContext(messageInput, visibleText) {
    const summary = getConversationAttachmentSummary(messageInput);
    if (!summary) {
        return '';
    }

    const parts = [summary];
    if (getConversationFileAttachments(messageInput).length) {
        try {
            const { appendFileContent } = await import('../chats.js');
            const promptMessage = {
                ...messageInput,
                extra: { ...messageInput.extra },
            };
            const filePromptText = await appendFileContent(promptMessage, visibleText || '');
            const cleanPromptText = formatPromptText(filePromptText, 2800);
            const cleanVisibleText = formatPromptText(visibleText || '', 2800);
            if (cleanPromptText && cleanPromptText !== cleanVisibleText) {
                parts.push(`Attached file text: ${cleanPromptText}`);
            }
        } catch (error) {
            console.warn('Conversation Mode: could not read attachment text for prompt context', error);
        }
    }

    return parts.join('\n');
}

export function focusConversationInput() {
    const input = document.getElementById(CHROME_IDS.input);
    if (input instanceof HTMLTextAreaElement && !input.disabled) {
        input.focus({ preventScroll: true });
    }
}

export async function submitConversationInput() {
    const account = getCurrentUserHandle();
    if (is_send_press || conversationState.conversationUploadActive) {
        return;
    }

    const input = document.getElementById(CHROME_IDS.input);
    if (!(input instanceof HTMLTextAreaElement)) {
        return;
    }

    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    const personaId = getConversationPersonaId();
    const threadStore = getConversationThreadStore(avatar, { groupId, personaId });
    const branchId = threadStore?.activeBranchId || '';
    const settings = getSettings(avatar, { groupId, personaId });
    const text = input.value.trim();
    const pendingFiles = getValidatedConversationPendingFiles({ notify: true });
    if (!pendingFiles) {
        return;
    }

    // A blank composer with no files only means "force a reply" when there is
    // already a user message to answer.
    if (!text && !pendingFiles.length) {
        const branchMessages = getConversationThread(avatar, { branchId, create: false, groupId, personaId }) || [];
        const lastUser = [...branchMessages].reverse().find(message => message?.role === 'user');
        if (!lastUser) {
            return;
        }
        await submitAcceptedReply({ avatar, branchId, groupId, personaId, account, force: true, triggers: [lastUser] });
        return;
    }

    if (!settings.enabled) {
        settings.enabled = true;
        saveSettings(avatar, settings, { groupId, personaId });
    }

    if (text.startsWith('/') && !pendingFiles.length) {
        const handled = await handleConversationSlashAction(text, { avatar, branchId, settings, groupId, personaId });
        if (handled) {
            clearConversationComposer(input);
            return;
        }
    }

    await submitAcceptedSend({ avatar, branchId, groupId, personaId, text, input, account });
}

/** A stable identity for the currently selected files, used to tell a retry
 *  apart from newly picked files. */
function getPendingFileSignature() {
    return getConversationPendingFiles()
        .map(file => [file?.name || '', file?.size ?? 0, file?.lastModified ?? 0].join(':'))
        .join('|');
}

/** The browser's timezone, so an interactive reply is not scheduled as UTC. */
function getDeviceTimeZone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/** Clear the exact draft that was submitted, leaving anything the user typed or
 *  selected since. Attachments picked while acceptance was in flight survive. */
function clearConversationComposer(input, submittedText = null, { hadAttachments = false, fileSignature = '' } = {}) {
    if (submittedText !== null && input.value.trim() !== submittedText) {
        return;
    }
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (hadAttachments && getPendingFileSignature() === fileSignature) {
        clearConversationAttachmentInput();
    }
}

function buildConversationReplyReference(target) {
    if (!target) {
        return null;
    }
    const reference = { ...target };
    delete reference.avatar;
    delete reference.branchId;
    delete reference.groupId;
    delete reference.personaId;
    return reference;
}

function getBranchRecord(avatar, branchId, { groupId, personaId }) {
    const threadStore = getConversationThreadStore(avatar, { create: false, groupId, personaId });
    return threadStore?.branches?.[branchId] || null;
}

/** Send new composer content: the server appends the user bubbles itself. */
async function submitAcceptedSend({ avatar, branchId, groupId, personaId, text, input, account }) {
    if (conversationState.conversationUploadActive) {
        return;
    }
    const branch = getBranchRecord(avatar, branchId, { groupId, personaId });
    if (!branch) {
        toastr.warning('The Conversation thread is no longer available.');
        return;
    }

    const userName = getConversationPersonaName(personaId, 'You');
    const replyTarget = getActiveConversationReplyTarget(avatar, { branchId, groupId, personaId });
    const replyReference = buildConversationReplyReference(replyTarget);
    const replyTargetAnchor = resolveReplyTargetAnchor(replyTarget, branch.messages);
    if (replyTarget?.messageId && !replyTargetAnchor) {
        toastr.warning('The message you replied to is no longer available.');
        return;
    }

    const pendingFiles = getValidatedConversationPendingFiles({ notify: true });
    if (!pendingFiles) {
        return;
    }
    const fileSignature = getPendingFileSignature();
    const branchCreatedAt = String(branch.createdAt ?? '');
    const draftSignature = JSON.stringify([account, 'send', avatar, groupId, personaId, branchId, branchCreatedAt, text, fileSignature, replyTargetAnchor?.messageId || '', replyTargetAnchor?.revision || '']);

    // Guard before the async upload so a second tap cannot submit the same draft
    // twice while the first upload is still in flight.
    conversationState.conversationUploadActive = true;
    try {
        let payload;
        if (pendingSubmission && pendingSubmission.draftSignature === draftSignature) {
            // A prior attempt with this exact draft failed uncertainly: replay the
            // frozen request (and its uploaded attachment URLs) rather than
            // re-uploading the files under a new key.
            payload = pendingSubmission.payload;
        } else {
            const messages = [];
            if (pendingFiles.length) {
                const messageInput = { role: 'user', name: userName, mes: text, extra: buildConversationUserMessageExtra(replyReference) };
                await populateConversationUserAttachments(messageInput, account);
                if (!String(messageInput.mes || '').trim() && !getConversationMediaAttachments(messageInput).length && !getConversationFileAttachments(messageInput).length) {
                    toastr.warning('No attachments were added. Try a different file.');
                    return;
                }
                const attachmentContext = await buildConversationAttachmentPromptContext(messageInput, text);
                if (attachmentContext) {
                    messageInput.extra.conversation_attachment_context = attachmentContext;
                }
                messages.push({ mes: String(messageInput.mes || ''), extra: messageInput.extra });
            } else {
                let includeReplyTarget = true;
                for (const messageText of splitChatroomMessages(text)) {
                    messages.push({ mes: messageText, extra: buildConversationUserMessageExtra(includeReplyTarget ? replyReference : null) });
                    includeReplyTarget = false;
                }
            }
            payload = {
                mode: 'send',
                target: { avatar, groupId, personaId, branchId },
                messages,
                replyTarget: replyTargetAnchor,
                branchCreatedAt,
                timeZone: getDeviceTimeZone(),
            };
            payload.submissionKey = resolveSubmissionKey(payload, account);
        }

        const accepted = await acceptConversationSubmission(payload, { draftSignature, account });
        if (!accepted) {
            return;
        }
        try {
            await refreshConversationStore(account);
        } catch {
            // The acceptance is durable; observation retries the authoritative
            // read rather than the user resending and duplicating the message.
        }
        if (account !== getCurrentUserHandle()) return;
        scheduleInterfaceRefresh({ syncControls: false });
        clearConversationComposer(input, text, { hadAttachments: pendingFiles.length > 0, fileSignature });
        pendingSubmission = null;
        if (replyTargetAnchor && getActiveConversationReplyTarget(avatar, { branchId, groupId, personaId })?.messageId === replyTargetAnchor.messageId) {
            clearConversationReplyTarget();
        }
        observeNativeConversationJob(accepted.job.id, account);
    } finally {
        conversationState.conversationUploadActive = false;
        // Clear the busy flag even on the failure paths, then repaint so Send is
        // re-enabled instead of staying disabled after a rejected submission.
        scheduleInterfaceRefresh({ syncControls: true });
    }
}

/** Ask for a reply to messages the browser already saved (force response, branch-from-message). */
export async function submitAcceptedReply({ avatar, branchId, groupId, personaId, force, triggers, submissionKey = '', account = getCurrentUserHandle() }) {
    if (conversationState.conversationUploadActive) {
        return;
    }
    const branch = getBranchRecord(avatar, branchId, { groupId, personaId });
    if (!branch) {
        return;
    }
    const triggerMessages = (Array.isArray(triggers) ? triggers : []).filter(message => message?.id);
    // A forced reply may answer an empty thread; a plain reply needs a source.
    if (!triggerMessages.length && !force) {
        return;
    }
    const replyTargetAnchor = resolveReplyTargetAnchor(
        getActiveConversationReplyTarget(avatar, { branchId, groupId, personaId }) || replyTargetFromTriggers(triggerMessages, branch.messages),
        branch.messages,
    );
    const payload = {
        mode: 'reply',
        target: { avatar, groupId, personaId, branchId },
        triggers: createConversationMessageAnchors(triggerMessages),
        replyTarget: replyTargetAnchor,
        branchCreatedAt: String(branch.createdAt ?? ''),
        force: Boolean(force),
        timeZone: getDeviceTimeZone(),
    };
    payload.submissionKey = submissionKey || resolveSubmissionKey(payload, account);
    conversationState.conversationUploadActive = true;
    try {
        const accepted = await acceptConversationSubmission(payload, { account });
        if (accepted) {
            pendingSubmission = null;
            try {
                await refreshConversationStore(account);
            } catch {
                // The acceptance is durable; observation retries the read.
            }
            if (account !== getCurrentUserHandle()) return;
            scheduleInterfaceRefresh({ syncControls: false });
            observeNativeConversationJob(accepted.job.id, account);
        }
    } finally {
        conversationState.conversationUploadActive = false;
        // Clear the busy flag even on the failure paths, then repaint so Send is
        // re-enabled instead of staying disabled after a rejected submission.
        scheduleInterfaceRefresh({ syncControls: true });
    }
}

function replyTargetFromTriggers(triggerMessages, messages) {
    const lastUser = [...triggerMessages].reverse().find(message => message?.role === 'user');
    const messageId = String(lastUser?.extra?.conversation_reply_to?.messageId || '').trim();
    return messageId ? { messageId } : null;
}

function resolveReplyTargetAnchor(replyTarget, messages) {
    const messageId = String(replyTarget?.messageId || '').trim();
    if (!messageId) {
        return null;
    }
    const targetMessage = (Array.isArray(messages) ? messages : []).find(message => String(message?.id || '') === messageId);
    return targetMessage ? { messageId, revision: getConversationMessageRevision(targetMessage) } : null;
}

let pendingSubmission = null;

function createSubmissionKey() {
    try {
        if (globalThis.crypto?.randomUUID) {
            return globalThis.crypto.randomUUID();
        }
    } catch {
        /* fall through to a timestamp key */
    }
    return `sub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Reuse the key of a submission whose response was lost, so a retry cannot duplicate it. */
function resolveSubmissionKey(payload, account) {
    const signature = JSON.stringify([payload.mode, payload.target, payload.branchCreatedAt, payload.messages, payload.triggers, payload.replyTarget, payload.force, payload.timeZone]);
    if (pendingSubmission && pendingSubmission.account === account && pendingSubmission.signature === signature) {
        return pendingSubmission.key;
    }
    return createSubmissionKey();
}

async function acceptConversationSubmission(payload, meta = {}) {
    const { account = getCurrentUserHandle() } = meta;
    const signature = JSON.stringify([payload.mode, payload.target, payload.branchCreatedAt, payload.messages, payload.triggers, payload.replyTarget, payload.force, payload.timeZone]);
    let flushed = false;
    try {
        flushed = await flushConversationStore(account);
    } catch {
        flushed = false;
    }
    if (!flushed) {
        toastr.error('Conversation changes could not be saved. Check the server connection and try again.', 'Reply not sent');
        return null;
    }
    try {
        const accepted = await postConversationSubmission(payload, account);
        if (!accepted?.job || accepted.inputDurable !== true) {
            toastr.warning('The Conversation reply was not accepted. Try again.', 'Reply not sent');
            return null;
        }
        return accepted;
    } catch (error) {
        // An uncertain failure may have been accepted already, so keep the exact
        // request (and its key and uploaded payload); the next identical send
        // replays rather than duplicates.
        pendingSubmission = { key: payload.submissionKey, signature, payload, account, draftSignature: meta.draftSignature || '' };
        const detail = error?.body?.error || error?.message || 'The Conversation reply could not be sent.';
        toastr.error(detail, 'Reply not sent');
        return null;
    }
}

async function postConversationSubmission(payload, account) {
    if (account !== getCurrentUserHandle()) throw new Error('account_changed');
    const response = await fetch('/api/neconyan-conversation/reply/submit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json', 'X-Neconyan-Account': account },
        body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (account !== getCurrentUserHandle()) throw new Error('account_changed');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) {
        const error = new Error(body?.error || `Conversation submit failed with ${response.status}.`);
        error.status = response.status;
        error.body = body;
        throw error;
    }
    return body;
}

if (typeof window !== 'undefined') {
    window.addEventListener('sb:queue-conversation-reply', (event) => {
        const detail = event?.detail || {};
        const avatar = String(detail.avatar || '').trim();
        if (!avatar) {
            return;
        }

        const personaId = String(detail.personaId || getConversationPersonaId()).trim();
        const groupId = detail.groupId || '';
        const threadStore = getConversationThreadStore(avatar, { create: false, groupId, personaId });
        const branchId = String(detail.branchId || threadStore?.activeBranchId || '').trim();
        if (!branchId) {
            return;
        }
        const messageIds = Array.isArray(detail.messageIds) ? detail.messageIds.filter(Boolean).map(String) : [];
        const messages = getConversationThread(avatar, { branchId, create: false, groupId, personaId }) || [];
        const triggers = messageIds.map(messageId => messages.find(message => String(message?.id || '') === messageId)).filter(Boolean);
        if (messageIds.length && triggers.length !== messageIds.length) {
            toastr.warning('A message this reply depends on is no longer available.');
            return;
        }
        void submitAcceptedReply({
            avatar,
            branchId,
            groupId,
            personaId,
            force: Boolean(detail.force),
            triggers,
            submissionKey: String(detail.submissionKey || '').trim(),
            account: detail.account,
        });
    });
}
