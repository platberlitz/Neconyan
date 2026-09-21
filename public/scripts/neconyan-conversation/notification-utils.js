/** Undefined means legacy state; an empty or trimmed boundary precedes this history. */
export function countConversationUnread(messages, readThrough) {
    if (typeof readThrough !== 'string') return null;
    const list = Array.isArray(messages) ? messages : [];
    const index = list.findIndex(message => message?.id === readThrough);
    return list.slice(index + 1).filter(message => message && !['user', 'system'].includes(message.role)).length;
}

export function normalizeConversationUnreadCount(value) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function getConversationThreadUnreadCount(threadStore) {
    const branches = threadStore?.branches && typeof threadStore.branches === 'object' ? threadStore.branches : {};
    return Object.values(branches).reduce((total, branch) => total + normalizeConversationUnreadCount(branch?.unread), 0);
}

export function setConversationThreadUnreadCount(threadStore, count, { branchId = '' } = {}) {
    const branches = threadStore?.branches && typeof threadStore.branches === 'object' ? threadStore.branches : {};
    const unread = normalizeConversationUnreadCount(count);
    if (branchId) {
        if (!branches[branchId] || typeof branches[branchId] !== 'object') {
            return false;
        }
        if (normalizeConversationUnreadCount(branches[branchId].unread) === unread) return false;
        branches[branchId].unread = unread;
        return true;
    }

    const activeBranchId = threadStore?.activeBranchId;
    if (unread > 0 && activeBranchId && branches[activeBranchId]) {
        if (normalizeConversationUnreadCount(branches[activeBranchId].unread) === unread) return false;
        branches[activeBranchId].unread = unread;
        return true;
    }
    if (unread === 0) {
        let changed = false;
        Object.values(branches).forEach((branch) => {
            if (branch && typeof branch === 'object' && normalizeConversationUnreadCount(branch.unread) !== 0) {
                branch.unread = 0;
                changed = true;
            }
        });
        return changed;
    }

    return false;
}

function getUnreadBranches(store) {
    const characters = store?.characters && typeof store.characters === 'object' ? store.characters : {};
    return Object.entries(characters).flatMap(([threadKey, threadStore]) => {
        const branches = threadStore?.branches && typeof threadStore.branches === 'object' ? threadStore.branches : {};
        return Object.values(branches)
            .filter(branch => branch && typeof branch === 'object')
            .map(branch => ({ threadKey, threadStore, branch }));
    });
}

export function clearConversationUnreadStore(store, shouldClearThread = () => true) {
    let changed = false;
    let cleared = 0;

    for (const { threadKey, threadStore, branch } of getUnreadBranches(store)) {
        if (!shouldClearThread(threadKey, threadStore)) {
            continue;
        }

        const unread = normalizeConversationUnreadCount(branch.unread);
        if (unread > 0) {
            cleared += unread;
        }
        if (branch.unread !== 0) {
            branch.unread = 0;
            changed = true;
        }
    }

    return { changed, cleared };
}

export function sanitizeConversationUnreadStore(store, isThreadCountable) {
    let changed = false;
    let cleared = 0;

    for (const { threadKey, threadStore, branch } of getUnreadBranches(store)) {
        const unread = normalizeConversationUnreadCount(branch.unread);
        const countable = typeof isThreadCountable === 'function' ? Boolean(isThreadCountable(threadKey, threadStore)) : true;

        if (branch.unread !== unread) {
            branch.unread = unread;
            changed = true;
        }
        if (!countable && unread > 0) {
            branch.unread = 0;
            cleared += unread;
            changed = true;
        }
    }

    return { changed, cleared };
}
