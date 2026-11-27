import { DEFAULT_BRANCH_ID, GROUP_CONVERSATION_STORE_PREFIX } from './constants.js';
import { isConversationGroupSpeakerEligible } from './partners-utils.js';

function parseGroupConversationStoreKey(storeKey) {
    const value = String(storeKey || '');
    if (!value.startsWith(GROUP_CONVERSATION_STORE_PREFIX)) {
        return null;
    }

    const withoutPrefix = value.slice(GROUP_CONVERSATION_STORE_PREFIX.length);
    const separatorIndex = withoutPrefix.indexOf(':');
    if (separatorIndex < 0) {
        return null;
    }

    const groupId = withoutPrefix.slice(0, separatorIndex);
    const avatar = withoutPrefix.slice(separatorIndex + 1);
    return groupId && avatar ? { groupId, avatar } : null;
}

function getActiveMemoryBranch(threadStore) {
    const branches = threadStore?.branches && typeof threadStore.branches === 'object' ? threadStore.branches : {};
    const branchId = threadStore?.activeBranchId || DEFAULT_BRANCH_ID;
    return branches[branchId] || branches[DEFAULT_BRANCH_ID] || null;
}

export function collectSoloConversationMemorySummary(charactersStore, avatar) {
    if (!avatar || !charactersStore || typeof charactersStore !== 'object') {
        return null;
    }

    const threadStore = charactersStore[avatar];
    const branch = getActiveMemoryBranch(threadStore);
    const summary = String(threadStore?.memorySummary || branch?.memorySummary || '').trim();
    if (!summary) {
        return null;
    }

    const updatedAt = Number(threadStore?.memoryUpdatedAt || branch?.updatedAt || branch?.createdAt || 0);
    return {
        avatar,
        summary,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    };
}

export function collectGroupConversationMemorySummaries(charactersStore, avatar, { groups = [], personaId = '', excludeGroupId = '', getGroupName = () => '', max = 4 } = {}) {
    if (!avatar || !charactersStore || typeof charactersStore !== 'object') {
        return [];
    }

    const persona = String(personaId || '').trim();
    const knownGroupIds = new Set();
    const eligibleGroups = new Map();
    for (const group of groups) {
        if (group?.id == null) continue;
        const id = String(group.id).trim();
        knownGroupIds.add(id);
        const owner = String(group.personaId || group.persona || group.personaAvatar || group.userAvatar || '').trim();
        if (owner === persona && Array.isArray(group.members) && isConversationGroupSpeakerEligible(group, avatar)) {
            eligibleGroups.set(id, group);
        }
    }

    const newest = new Map();
    Object.entries(charactersStore).forEach(([storeKey, threadStore]) => {
        const parsed = parseGroupConversationStoreKey(storeKey);
        if (!parsed || (excludeGroupId && parsed.groupId === String(excludeGroupId))) return;
        // Only unresolved legacy groups use the holder as the access rule.
        const group = eligibleGroups.get(parsed.groupId);
        if (!group && (knownGroupIds.has(parsed.groupId) || parsed.avatar !== avatar)) {
            return;
        }

        const branch = getActiveMemoryBranch(threadStore);
        const summary = String(threadStore?.memorySummary || branch?.memorySummary || '').trim();
        if (!summary) {
            return;
        }

        const time = Number(threadStore?.memoryUpdatedAt || branch?.updatedAt || branch?.createdAt || 0);
        const updatedAt = Number.isFinite(time) ? time : 0;
        const previous = newest.get(parsed.groupId);
        if (previous && (previous.memory.updatedAt > updatedAt || (previous.memory.updatedAt === updatedAt && previous.storeKey < storeKey))) return;

        const groupName = String((group ? group.name : getGroupName(parsed.groupId)) || '').trim();
        newest.set(parsed.groupId, { storeKey, memory: { groupId: parsed.groupId, groupName, summary, updatedAt } });
    });

    const parsedMax = Number(max);
    const limit = Number.isFinite(parsedMax) ? Math.max(0, parsedMax) : undefined;
    return Array.from(newest.values(), item => item.memory)
        .sort((first, second) => second.updatedAt - first.updatedAt)
        .slice(0, limit);
}
