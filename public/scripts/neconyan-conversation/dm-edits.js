/**
 * Deleting a Conversation DM from the page: the Pals bin button and Home's Delete both come here.
 *
 * Loaded only by dynamic `import()` from `chrome.js` and `welcome-screen.js`, so suites that link those
 * modules do not need `i18n.js` or the store-sync module for it.
 */
import { t, translate } from '../i18n.js';
import {
    deleteConversationWelcomeBranch,
    getConversationGroupById,
    getConversationPersonaId,
    getConversationThreadStore,
} from './context.js';
import { getCharacterForAvatar } from './media.js';
import { applyConversationServerEdit, waitForConversationEdits } from './store-sync.js';

const THREAD_DELETE_ENDPOINT = '/api/neconyan-conversation/thread/delete';
const GROUP_DELETE_ENDPOINT = '/api/neconyan-conversation/group/delete';

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
