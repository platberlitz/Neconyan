import { chat, getCurrentChatId, getRequestHeaders, saveChatConditional } from '../../script.js';
import { getCurrentUserHandle } from '../user.js';
import { assertConversationAccount } from './store-sync.js';
import { selected_group } from '../group-chats.js';
import { getConversationPersonaId, getCurrentCharAvatar, getRoleplayGroupById } from './context.js';
import { reportConversationGenerationError } from './generation.js';
import { loadCurrentPanelSettings } from './interface.js';
import { getRoleplayGroupRevision, getRoleplaySourceMessageRevision } from './roleplay-source.js';
import { groupAsideBusyKeys } from './state.js';

export { getRoleplaySourceMessageRevision };

async function submitConversationAsideEventRequest(body, account) {
    assertConversationAccount(account);
    const response = await fetch('/api/neconyan-conversation/aside/event', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...getRequestHeaders(), 'X-Neconyan-Account': account },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    assertConversationAccount(account);
    if (!response.ok) {
        throw Object.assign(new Error(payload?.error || `Aside event failed (${response.status}).`), { status: response.status });
    }
    return payload;
}

/**
 * A short, stable identity for one saved source. The server caps an event key, and
 * a message revision is a JSON copy of the whole message, so the key carries a hash
 * of it rather than the text. The server still proves the real revision.
 */
function sourceFingerprint(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${hash.toString(16).padStart(8, '0')}-${value.length.toString(36)}`;
}

/**
 * One native aside event: a Roleplay message was rendered, or a user message may
 * name a group member. The page states only the fact and the saved source it can
 * prove; the server samples the event and chooses the recipient, so a reopened
 * page cannot sample the same message again and no page decides who speaks.
 *
 * The event key is derived from the saved source, so a second render of the same
 * message is the same event rather than a second request. A refused or lost event
 * is never retried automatically: the decision is the server's and the accepted
 * aside already has its permanent occurrence key.
 */
export async function submitConversationAsideEvent(kind, messageId, { account = getCurrentUserHandle() } = {}) {
    if (kind !== 'mention' && kind !== 'rendered') return null;
    const message = chat[messageId];
    if (!message) return null;
    const chatName = String(getCurrentChatId() || '').replace(/\.jsonl$/i, '');
    if (!chatName) return null;
    const groupId = String(selected_group || '');
    const group = groupId ? getRoleplayGroupById(groupId) : null;
    if (kind === 'mention' && (!group || groupId !== String(group.id || groupId))) return null;
    const isGroup = Boolean(groupId);
    if (isGroup && !group) return null;
    const avatar = isGroup ? '' : String(getCurrentCharAvatar() || '');
    if (!isGroup && !avatar) return null;
    // The Conversation sheld is the page's own presentation, so the page keeps it.
    const sheld = globalThis.document?.getElementById?.('sheld');
    if (!isGroup && sheld?.dataset?.sbConversationMode === 'on') return null;

    const speaker = String(message.original_avatar || message.avatar || '');
    const messageRevision = getRoleplaySourceMessageRevision(message);
    const body = {
        eventKey: `aside-event:${kind}:${isGroup ? group.id : avatar}:${chatName}:${messageId}:${sourceFingerprint(messageRevision)}`,
        personaId: getConversationPersonaId(),
        kind,
        source: {
            locator: { chat: chatName, avatar, group: isGroup },
            groupId: isGroup ? group.id : '',
        },
        messageIndex: messageId,
        messageRevision,
        groupRevision: isGroup ? getRoleplayGroupRevision(group) : '',
        speakerAvatar: isGroup ? speaker : '',
    };
    const key = `${body.personaId || 'persona'}:${isGroup ? group.id : 'solo'}:${speaker || avatar || 'unknown'}`;
    if (groupAsideBusyKeys.has(key)) return null;
    groupAsideBusyKeys.add(key);
    try {
        // A refreshed account is refused before anything is saved, so a stale
        // page can never write a chat that belongs to someone else.
        assertConversationAccount(account);
        await saveChatConditional({ throwOnError: true, account });
        return await submitConversationAsideEventRequest(body, account);
    } catch (err) {
        reportConversationGenerationError('roleplay aside event', err, { toast: false });
        return null;
    } finally {
        groupAsideBusyKeys.delete(key);
    }
}

export function handleChatChanged() {
    loadCurrentPanelSettings();
}
