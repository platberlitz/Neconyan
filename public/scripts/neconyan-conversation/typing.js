import { DEFAULT_SETTINGS } from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationThreadStore,
    getConversationThreadKey,
    getCurrentCharAvatar,
    persistConversationStore,
} from './context.js';
import { isConversationActiveThread, updateConversationNotificationIndicators } from './notifications.js';
import { getAvailabilityCopy } from './personas.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { getCurrentActivityFromSchedule, getStoredSchedule } from './schedule.js';
import { activeTypingParticipants } from './state.js';
import { getConversationMessagePreviewText, getConversationThread, hasConversationMessageContent } from './thread-store.js';

export function getConversationActivityContext(settings, avatar, now = new Date(), { personaId = getConversationPersonaId() } = {}) {
    const schedule = getStoredSchedule(avatar, { personaId });
    if (schedule) {
        return getCurrentActivityFromSchedule(schedule, avatar, now, { personaId });
    }

    const status = settings?.availability || DEFAULT_SETTINGS.availability;
    const copy = getAvailabilityCopy(status);
    return { status, activity: copy.detail.replace(/\.$/, '').toLowerCase(), source: 'manual' };
}

export function getTypingParticipantMap(avatar = getCurrentCharAvatar(), { branchId = '', create = false, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const threadAvatar = avatar || getCurrentCharAvatar();
    if (!threadAvatar) {
        return null;
    }

    const storageKey = getConversationThreadKey(threadAvatar, groupId || '', { personaId });
    const resolvedBranchId = branchId || getConversationThreadStore(threadAvatar, { create: false, groupId, personaId })?.activeBranchId || '';
    const threadKey = resolvedBranchId ? `${storageKey}:${resolvedBranchId}` : storageKey;
    if (!threadKey) {
        return null;
    }

    let participantMap = activeTypingParticipants.get(threadKey);
    if (!participantMap && create) {
        participantMap = new Map();
        activeTypingParticipants.set(threadKey, participantMap);
    }

    return participantMap || null;
}

export function getActiveTypingParticipants(avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const participantMap = getTypingParticipantMap(avatar, { branchId, groupId, personaId });
    return participantMap ? Array.from(participantMap.values()).filter(participant => participant?.avatar) : [];
}

export function getPrimaryTypingParticipant(avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const participants = getActiveTypingParticipants(avatar, { branchId, groupId, personaId });
    return participants.length ? participants[participants.length - 1] : null;
}

export async function withTypingParticipant(participant, task, avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const threadAvatar = avatar || getCurrentCharAvatar();
    const participantAvatar = participant?.avatar || threadAvatar;
    const participantMap = getTypingParticipantMap(threadAvatar, { branchId, create: true, groupId, personaId });
    const previousTypingParticipant = participantMap?.get(participantAvatar) || null;
    if (participantMap && participantAvatar) {
        participantMap.set(participantAvatar, participant || { avatar: participantAvatar, name: 'Character' });
    }

    const isThreadActive = isConversationActiveThread(threadAvatar, groupId, { branchId, personaId });
    if (isThreadActive) {
        scheduleInterfaceRefresh({ syncControls: false });
    }
    try {
        return await task();
    } finally {
        if (participantMap && participantAvatar) {
            if (previousTypingParticipant) {
                participantMap.set(participantAvatar, previousTypingParticipant);
            } else {
                participantMap.delete(participantAvatar);
            }
            const storageKey = getConversationThreadKey(threadAvatar, groupId || '', { personaId });
            const resolvedBranchId = branchId || getConversationThreadStore(threadAvatar, { create: false, groupId, personaId })?.activeBranchId || '';
            const threadKey = resolvedBranchId ? `${storageKey}:${resolvedBranchId}` : storageKey;
            if (!participantMap.size && threadKey) {
                activeTypingParticipants.delete(threadKey);
            }
        }
        if (isConversationActiveThread(threadAvatar, groupId, { branchId, personaId })) {
            scheduleInterfaceRefresh({ syncControls: false });
        }
    }
}

export function stripPreviewText(messageText) {
    return String(messageText || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 130);
}

export { splitChatroomMessages } from './reply-delivery.js';

export function setLastConversationPreview(avatar, messageText, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const preview = stripPreviewText(messageText);
    if (!avatar || !preview) {
        return;
    }

    const branch = getActiveConversationBranch(avatar, { branchId, create: !branchId, groupId, personaId });
    if (branch && branch.preview !== preview) {
        branch.preview = preview;
        branch.updatedAt = Date.now();
        persistConversationStore();
    }
}

export function getLastConversationPreview(avatar, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return getActiveConversationBranch(avatar, { create: false, groupId, personaId })?.preview || 'Conversation ready';
}

export function updateLastPreviewFromConversation(avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    const messages = getConversationThread(avatar, { branchId, create: !branchId, groupId, personaId });
    const message = [...messages].reverse().find(hasConversationMessageContent);
    if (message) {
        setLastConversationPreview(avatar, getConversationMessagePreviewText(message), { branchId, groupId, personaId });
    }

    updateConversationNotificationIndicators();
}
