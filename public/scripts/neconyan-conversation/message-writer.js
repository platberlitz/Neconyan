import { getConversationGroupIdForAvatar, getConversationPersonaId, getCurrentCharAvatar, getCurrentCharName } from './context.js';
import { incrementUnreadCount, isConversationActiveThread, notifyNewConversationMessage } from './notifications.js';
import { scheduleInterfaceRefresh, schedulePalsRailRender } from './render-scheduler.js';
import { conversationState } from './state.js';
import { appendConversationThreadMessage, markConversationSeen } from './thread-store.js';
import { getConversationScenarioAvatar } from './personas.js';

export async function appendConversationMessage(messageText, { name = getCurrentCharName(), role = 'character', extra = {}, branchId = '', groupId = undefined, personaId = getConversationPersonaId() } = {}, avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return null;
    }

    const resolvedGroupId = groupId !== undefined ? groupId : getConversationGroupIdForAvatar(avatar);
    const scenarioAvatar = role === 'user' ? getConversationScenarioAvatar(personaId, { avatar, groupId: resolvedGroupId }) : '';
    const message = appendConversationThreadMessage(avatar, {
        role,
        name,
        mes: messageText,
        extra: scenarioAvatar ? { ...extra, scenario_avatar: scenarioAvatar } : extra,
    }, { branchId, create: !branchId, groupId: resolvedGroupId, personaId });
    if (!message) {
        return null;
    }

    const isCurrentPersona = personaId === getConversationPersonaId();
    const isIncoming = !['user', 'system'].includes(role);
    const shouldIncrementUnread = isIncoming && !isConversationActiveThread(avatar, resolvedGroupId, { branchId, personaId });
    const shouldNotify = isCurrentPersona && shouldIncrementUnread;
    if (shouldIncrementUnread) {
        incrementUnreadCount(avatar, { branchId, groupId: resolvedGroupId, personaId });
    }
    if (isIncoming) {
        markConversationSeen(avatar, Date.now(), { branchId, groupId: resolvedGroupId, personaId });
    }

    if (isConversationActiveThread(avatar, resolvedGroupId, { branchId, personaId })) {
        scheduleInterfaceRefresh({ syncControls: false });
    } else if (conversationState.conversationWorkspaceOpen) {
        schedulePalsRailRender();
    }

    if (isCurrentPersona) {
        notifyNewConversationMessage(avatar, message, shouldNotify, { branchId, groupId: resolvedGroupId, personaId });
    }

    return message;
}
