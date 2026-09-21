import { chat, getCurrentChatId, getRequestHeaders, saveChatConditional } from '../../script.js';
import { getCurrentUserHandle } from '../user.js';
import { assertConversationAccount } from './store-sync.js';
import { selected_group } from '../group-chats.js';
import { getConversationPersonaId, getConversationThreadStore, getCurrentCharAvatar, getRoleplayCurrentCharacter, getRoleplayGroupById } from './context.js';
import { reportConversationGenerationError } from './generation.js';
import { loadCurrentPanelSettings } from './interface.js';
import { getCharacterForAvatar } from './media.js';
import { buildGroupChatContext, getCurrentGroupConversationMembers } from './pals-rail.js';
import { isCharacterMentionedInText } from './partners.js';
import { getRoleplayGroupRevision, getRoleplaySourceMessageRevision } from './roleplay-source.js';
import { buildConversationRoleplayContext } from './shared-helpers.js';
import { getSettings } from './settings-store.js';
import { groupAsideBusyKeys } from './state.js';
import { getConversationActivityContext } from './typing.js';

export { getRoleplaySourceMessageRevision };

async function submitConversationAside(body, account) {
    assertConversationAccount(account);
    const response = await fetch('/api/neconyan-conversation/aside/submit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...getRequestHeaders(), 'X-Neconyan-Account': account },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    assertConversationAccount(account);
    if (!response.ok) {
        throw Object.assign(new Error(payload?.error || `Aside request failed (${response.status}).`), { status: response.status });
    }
    return payload;
}

function isCapturedRoleplaySourceValid({ account, avatar = '', sourceGroupId = '', sourceGroupRevision = '', sourceMessageId = null, sourceMessageRevision = '' } = {}) {
    if (account !== getCurrentUserHandle()) return false;
    try { assertConversationAccount(account); } catch { return false; }
    if (sourceMessageId !== null && typeof sourceMessageId !== 'undefined') {
        const currentMessage = chat[sourceMessageId];
        if (!currentMessage || getRoleplaySourceMessageRevision(currentMessage) !== sourceMessageRevision) {
            return false;
        }
    }
    if (sourceGroupId) {
        const currentGroup = getRoleplayGroupById(sourceGroupId);
        return String(selected_group || '') === sourceGroupId
            && Boolean(currentGroup)
            && getRoleplayGroupRevision(currentGroup) === sourceGroupRevision;
    }

    return !selected_group && (!avatar || getRoleplayCurrentCharacter()?.avatar === avatar);
}

export function captureGroupAsideRequest(character, { personaId = getConversationPersonaId(), reason = 'random', sourceGroup = null, sourceGroupId = String(selected_group || ''), sourceMessageId = null } = {}) {
    const group = sourceGroup || getRoleplayGroupById(sourceGroupId);
    const sourceMessage = sourceMessageId !== null && typeof sourceMessageId !== 'undefined' ? chat[sourceMessageId] : null;
    const branchId = getConversationThreadStore(character?.avatar, { create: false, groupId: '', personaId })?.activeBranchId || '';
    const groupContext = buildGroupChatContext();
    if (!group || !character?.avatar || !branchId || !groupContext || (sourceMessageId !== null && !sourceMessage)) {
        return null;
    }

    return {
        branchId,
        groupContext,
        account: getCurrentUserHandle(),
        personaId,
        reason,
        sourceGroupId: String(group.id || sourceGroupId || ''),
        sourceGroupRevision: getRoleplayGroupRevision(group),
        sourceMessageId,
        sourceMessageRevision: sourceMessage ? getRoleplaySourceMessageRevision(sourceMessage) : '',
    };
}

export function captureRoleplayDMRequest({ avatar = getCurrentCharAvatar(), personaId = getConversationPersonaId(), roleplayContext = '', sourceMessageId = null } = {}) {
    const sourceMessage = sourceMessageId !== null && typeof sourceMessageId !== 'undefined' ? chat[sourceMessageId] : null;
    const branchId = getConversationThreadStore(avatar, { create: false, groupId: '', personaId })?.activeBranchId || '';
    const capturedContext = String(roleplayContext || buildConversationRoleplayContext(chat, sourceMessageId)).trim();
    if (!avatar || !branchId || !capturedContext || (sourceMessageId !== null && !sourceMessage)) {
        return null;
    }

    return {
        avatar,
        branchId,
        personaId,
        account: getCurrentUserHandle(),
        roleplayContext: capturedContext,
        sourceMessageId,
        sourceMessageRevision: sourceMessage ? getRoleplaySourceMessageRevision(sourceMessage) : '',
    };
}

export async function checkGroupChatMention(messageId) {
    if (!selected_group) {
        return;
    }

    const message = chat[messageId];
    if (!message || !(message.is_user === true || message.role === 'user') || !message.mes) {
        return;
    }

    const personaId = getConversationPersonaId();
    const sourceGroupId = String(selected_group || '');
    const roleplayGroup = getRoleplayGroupById(sourceGroupId);
    const members = getCurrentGroupConversationMembers({ group: roleplayGroup, requireRoleplayReactions: true });
    const memberCharacters = members.map(item => item.character).filter(Boolean);
    const mentionedMembers = members.filter(({ character }) => isCharacterMentionedInText(character, message.mes, memberCharacters));
    if (!mentionedMembers.length) {
        return;
    }

    const requests = mentionedMembers
        .map(({ character }) => ({
            character,
            request: captureGroupAsideRequest(character, { personaId, reason: 'mention', sourceGroup: roleplayGroup, sourceGroupId, sourceMessageId: messageId }),
        }))
        .filter(item => item.request);
    for (const { character, request } of requests) {
        void triggerGroupAsideDM(character, request);
    }
}

export async function triggerGroupAsideDM(character, options = {}) {
    const captured = options.branchId ? options : captureGroupAsideRequest(character, options);
    if (!captured || !isCapturedRoleplaySourceValid({ ...captured, avatar: character?.avatar })) {
        return false;
    }
    const { branchId, personaId, reason, sourceGroupId, sourceMessageId, sourceGroupRevision, sourceMessageRevision } = captured;
    const groupId = String(sourceGroupId || '');
    const group = getRoleplayGroupById(groupId);
    if (!group || !character?.avatar || !group.members?.includes(character.avatar) || group.disabled_members?.includes(character.avatar)) {
        return false;
    }

    const settings = getSettings(character.avatar, { groupId, personaId });
    if (!settings.enabled || !settings.roleplay_reactions) {
        return false;
    }

    const current = getConversationActivityContext(settings, character.avatar, new Date(), { personaId });
    if (current.status === 'offline') {
        return false;
    }

    const key = `${personaId || 'persona'}:${group.id || 'group'}:${character.avatar || 'unknown'}`;
    if (groupAsideBusyKeys.has(key)) {
        return false;
    }

    const threadStore = getConversationThreadStore(character.avatar, { create: false, groupId: '', personaId });
    if (!threadStore?.branches?.[branchId]) {
        return false;
    }
    groupAsideBusyKeys.add(key);
    try {
        await saveChatConditional({ throwOnError: true, account: captured.account });
        if (!isCapturedRoleplaySourceValid({ ...captured, avatar: character.avatar })) {
            return false;
        }
        const result = await submitConversationAside({
            target: { avatar: character.avatar, personaId, branchId },
            source: {
                locator: { chat: String(getCurrentChatId() || ''), avatar: '', group: true },
                groupId: group.id,
            },
            messageIndex: sourceMessageId,
            messageRevision: sourceMessageRevision,
            groupRevision: sourceGroupRevision,
            reason,
        }, captured.account);
        return Boolean(result?.created);
    } catch (err) {
        reportConversationGenerationError('group aside DM', err, { toast: false });
        return false;
    } finally {
        groupAsideBusyKeys.delete(key);
    }
}

export async function triggerRoleplayDM(options = {}) {
    const captured = options.branchId ? options : captureRoleplayDMRequest(options);
    if (!captured || !isCapturedRoleplaySourceValid(captured)) return false;
    const { avatar, branchId, personaId, sourceMessageId, sourceMessageRevision } = captured;
    const character = getCharacterForAvatar(avatar);
    if (!character || !avatar) return false;

    const threadStore = getConversationThreadStore(avatar, { create: false, groupId: '', personaId });
    if (!threadStore?.branches?.[branchId]) return false;

    const settings = getSettings(avatar, { groupId: '', personaId });
    const sheld = document.getElementById('sheld');
    if (!settings.enabled || (sheld instanceof HTMLElement && sheld.dataset.sbConversationMode === 'on')) {
        return false;
    }

    try {
        await saveChatConditional({ throwOnError: true, account: captured.account });
        if (!isCapturedRoleplaySourceValid(captured)) {
            return false;
        }
        const result = await submitConversationAside({
            target: { avatar, personaId, branchId },
            source: { locator: { chat: String(getCurrentChatId() || ''), avatar, group: false } },
            messageIndex: sourceMessageId,
            messageRevision: sourceMessageRevision,
            reason: 'reaction',
        }, captured.account);
        return Boolean(result?.created);
    } catch (err) {
        reportConversationGenerationError('roleplay side DM', err, { toast: false });
        return false;
    }
}

export function handleChatChanged() {
    loadCurrentPanelSettings();
}
