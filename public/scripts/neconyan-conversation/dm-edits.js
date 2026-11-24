/**
 * Editing a Conversation DM from the page: the Pals bin button and Home's Delete both come here, and so do a group DM's member edit and Home's row check.
 *
 * Loaded only by dynamic `import()` from `chrome.js` and `welcome-screen.js`, so suites that link those
 * modules do not need `i18n.js` or the store-sync module for it.
 */
import { t, translate } from '../i18n.js';
import {
    deleteConversationWelcomeBranch,
    getConversationGroupById,
    getConversationGroupThreadAnchor,
    getConversationPersonaId,
    getConversationThreadStore,
} from './context.js';
import { isConversationGroupMemberActive } from './group-member-edits.js';
import { getCharacterForAvatar } from './media.js';
import { applyConversationServerEdit, flushConversationStore, waitForConversationEdits } from './store-sync.js';

const THREAD_DELETE_ENDPOINT = '/api/neconyan-conversation/thread/delete';
const GROUP_DELETE_ENDPOINT = '/api/neconyan-conversation/group/delete';
const GROUP_MEMBERS_ENDPOINT = '/api/neconyan-conversation/group/members';

/**
 * Ask the server to add and remove the members of an owned group DM in place and adopt the answer. The page's own pending save goes first,
 * so what the page holds is not lost when the thread moves. Rejects when the server refused (the error's message is its code) or was unreachable.
 */
export async function updateConversationGroupMembers({ groupId, add, remove, rename = null, personaId = getConversationPersonaId() }) {
    await flushConversationStore().catch(() => false);
    return applyConversationServerEdit(GROUP_MEMBERS_ENDPOINT, { groupId, personaId, add, remove, ...(rename ? { rename } : {}) });
}

/** The toast for the outcome of a member edit: 'saved' (with the group's name) or the kind of error `describeConversationGroupMemberError` gives. */
export function getConversationGroupMemberToast({ kind, groupName = '' }) {
    if (kind === 'saved') {
        const name = groupName || translate('Group DM');
        return t`Saved the members of '${name}'.`;
    }
    if (kind === 'too_few') return t`A group DM needs at least two pals with character cards.`;
    if (kind === 'missing_card') return t`One of those pals no longer has a character card.`;
    if (kind === 'gone') return t`This group DM no longer exists.`;
    return t`Could not save the group members. Check your connection and try again.`;
}

/**
 * Who a Home row's chat belongs to now. A row keeps the avatar it was drawn with, but after a member edit that pal may have left the group
 * and their thread moved, and the page would resolve (pal, group) to the pal's own solo DM. Returns the row's avatar when it is still
 * right, the group's current holder when it is not, and '' when the group has nobody left to hold it.
 */
export function resolveConversationHomeRowAvatar(avatar, groupId, { personaId = getConversationPersonaId() } = {}) {
    if (!groupId) return avatar;
    const group = getConversationGroupById(groupId, { personaId });
    if (!group || group.is_conversation_group !== true || isConversationGroupMemberActive(group, avatar)) return avatar;
    return getConversationGroupThreadAnchor(group, { personaId })?.avatar || '';
}

/**
 * Ask the server to delete a solo DM (`avatar`) or a group DM (`groupId`) and adopt the answer.
 * A solo DM keeps the pal's Character Schedule; a group DM goes with every member's thread in it.
 * Rejects when the server could not be reached or refused, leaving the page as it was.
 */
export function deleteConversationDm({ avatar, groupId = '', personaId = getConversationPersonaId() }) {
    return groupId
        ? applyConversationServerEdit(GROUP_DELETE_ENDPOINT, { groupId, personaId })
        : applyConversationServerEdit(THREAD_DELETE_ENDPOINT, { avatar, personaId });
}

/**
 * The words for deleting a DM, one source for the Pals button and Home: the confirm, the success text and the failure text.
 * Names go in as written (the Pals confirm is native text); a caller that shows HTML escapes the finished string.
 */
export function getConversationDmDeleteCopy({ avatar, groupId = '' }) {
    const failed = t`Could not delete that DM. Check your connection and try again.`;
    if (!groupId) {
        const name = getCharacterForAvatar(avatar)?.name || translate('Character');
        return {
            confirm: t`Delete your DM with ${name}? Its messages, branches, memory summary and settings, including Manual Scheduling, will be removed, and ${name} will stop messaging you here. Group DMs with ${name} are kept. This cannot be undone.`,
            success: t`Deleted your DM with ${name}.`,
            failed,
        };
    }
    const group = getConversationGroupById(groupId);
    const groupName = group?.name || translate('Group DM');
    if (group && !group.is_conversation_group) {
        // A Roleplay group: only its Conversation history (its DM threads and reminders) goes.
        return {
            confirm: t`Delete the Conversation history for '${groupName}'? Its messages and memory summaries will be removed. The Roleplay group itself is kept. This cannot be undone.`,
            success: t`Deleted the Conversation history for '${groupName}'.`,
            failed,
        };
    }
    return {
        confirm: t`Delete the group DM '${groupName}'? The group, its settings, and every member's messages and memory summaries in it will be removed, and its members will stop chatting in it. Each member's own DM is kept. This cannot be undone.`,
        success: t`Deleted the group DM '${groupName}'.`,
        failed,
    };
}

/**
 * Whether a Home row's chat exists in its DM and whether it is the DM's only chat.
 * A Conversation-owned group with no thread yet counts as one chat.
 */
export function describeConversationHomeChat(avatar, branchId, { groupId = '' } = {}) {
    const threadStore = getConversationThreadStore(avatar, { create: false, groupId });
    if (!threadStore) {
        const group = groupId ? getConversationGroupById(groupId) : null;
        return group?.is_conversation_group ? { exists: true, only: true } : { exists: false, only: false };
    }
    const branchIds = Object.keys(threadStore.branches || {});
    const exists = branchIds.includes(branchId);
    return { exists, only: exists && branchIds.length === 1 };
}

/** Delete one chat of a DM that has several, and wait until the change has reached the server. */
export async function deleteConversationHomeChat(avatar, branchId, { groupId = '' } = {}) {
    const result = deleteConversationWelcomeBranch(avatar, branchId, { groupId });
    const saved = result.deleted ? await waitForConversationEdits() : true;
    return { ...result, saved };
}
