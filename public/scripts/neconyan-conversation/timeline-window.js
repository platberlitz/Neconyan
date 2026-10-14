export const CONVERSATION_TIMELINE_WINDOW_NORMAL = 200;
export const CONVERSATION_TIMELINE_WINDOW_LOW_MEMORY = 25;

export function buildConversationTimelineWindowIdentity({
    account = '',
    personaId = '',
    avatar = '',
    groupId = '',
    branchId = '',
    channel = 'main',
    query = '',
} = {}) {
    return [
        String(account || ''),
        String(personaId || ''),
        String(avatar || ''),
        String(groupId || ''),
        String(branchId || ''),
        String(channel || 'main').trim() || 'main',
        String(query || '').trim().toLowerCase(),
    ].join('\u001f');
}

export function resolveConversationTimelineWindowSize({
    lowMemoryActive = false,
    windowSize,
} = {}) {
    const numeric = Number(windowSize);
    if (Number.isFinite(numeric) && numeric > 0) {
        return Math.max(1, Math.floor(numeric));
    }
    return lowMemoryActive
        ? CONVERSATION_TIMELINE_WINDOW_LOW_MEMORY
        : CONVERSATION_TIMELINE_WINDOW_NORMAL;
}

export function moveConversationTimelineWindowToLatest(state) {
    if (!state || typeof state !== 'object') {
        return;
    }
    if (state.timelineWindowDescriptor && typeof state.timelineWindowDescriptor === 'object') {
        state.timelineWindowDescriptor = Object.freeze({
            ...state.timelineWindowDescriptor,
            followingLatest: true,
        });
    }
    state.timelineBottomScrollPending = true;
}

export function syncConversationHistoryButtonsForEditState(timeline) {
    if (!timeline || typeof timeline.querySelectorAll !== 'function') {
        return false;
    }
    const disabled = Boolean(timeline.querySelector?.('.sb-conversation-message.is-editing'));
    timeline.querySelectorAll('.sb-conversation-history-button').forEach((button) => {
        button.disabled = disabled;
        button.setAttribute?.('aria-disabled', String(disabled));
    });
    return disabled;
}

function getMessageId(message, index) {
    const rawId = message?.id;
    if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
        return String(rawId);
    }
    return `idx:${index}`;
}

function createWindowDescriptor({
    identityKey,
    followingLatest,
    list,
    startIndex,
    endIndex,
    windowSize,
}) {
    const totalMessages = list.length;
    const safeStart = totalMessages > 0 ? Math.max(0, Math.min(startIndex, totalMessages - 1)) : 0;
    const safeEnd = totalMessages > 0 ? Math.max(safeStart + 1, Math.min(endIndex, totalMessages)) : 0;
    const isAtLatest = totalMessages === 0 || safeEnd >= totalMessages;
    const effectiveFollowingLatest = Boolean(followingLatest || isAtLatest);

    return Object.freeze({
        identityKey: String(identityKey || ''),
        followingLatest: effectiveFollowingLatest,
        startMessageId: totalMessages > 0 ? getMessageId(list[safeStart], safeStart) : null,
        endMessageId: totalMessages > 0 ? getMessageId(list[safeEnd - 1], safeEnd - 1) : null,
        startIndex: safeStart,
        endIndex: safeEnd,
        windowSize,
        totalMessages,
        hasOlder: safeStart > 0,
        hasNewer: safeEnd < totalMessages,
    });
}

export function selectConversationTimelineWindow(
    filteredMessages,
    previousDescriptor = null,
    {
        identityKey = '',
        lowMemoryActive = false,
        windowSize,
    } = {},
) {
    const list = Array.isArray(filteredMessages) ? filteredMessages : [];
    const total = list.length;
    const cap = resolveConversationTimelineWindowSize({ lowMemoryActive, windowSize });
    const normalizedIdentity = String(identityKey || '');

    if (total === 0) {
        const descriptor = createWindowDescriptor({
            identityKey: normalizedIdentity,
            followingLatest: true,
            list,
            startIndex: 0,
            endIndex: 0,
            windowSize: cap,
        });
        return {
            messages: [],
            descriptor,
        };
    }

    const sameIdentity = Boolean(
        previousDescriptor
        && typeof previousDescriptor === 'object'
        && previousDescriptor.identityKey === normalizedIdentity,
    );

    if (!sameIdentity || previousDescriptor.followingLatest !== false) {
        const endIndex = total;
        const startIndex = Math.max(0, endIndex - cap);
        const descriptor = createWindowDescriptor({
            identityKey: normalizedIdentity,
            followingLatest: true,
            list,
            startIndex,
            endIndex,
            windowSize: cap,
        });
        return {
            messages: list.slice(descriptor.startIndex, descriptor.endIndex),
            descriptor,
        };
    }

    const startId = previousDescriptor.startMessageId;
    const endId = previousDescriptor.endMessageId;
    const foundStartIndex = startId !== null && startId !== undefined
        ? list.findIndex((item, idx) => getMessageId(item, idx) === startId)
        : -1;
    const foundEndIndex = endId !== null && endId !== undefined
        ? list.findIndex((item, idx) => getMessageId(item, idx) === endId)
        : -1;

    let startIndex;
    let endIndex;
    if (foundStartIndex >= 0) {
        startIndex = foundStartIndex;
        endIndex = Math.min(total, startIndex + cap);
    } else if (foundEndIndex >= 0) {
        endIndex = Math.min(total, foundEndIndex + 1);
        startIndex = Math.max(0, endIndex - cap);
    } else {
        const fallbackStart = Number.isInteger(previousDescriptor.startIndex)
            ? previousDescriptor.startIndex
            : 0;
        startIndex = Math.max(0, Math.min(fallbackStart, Math.max(0, total - cap)));
        endIndex = Math.min(total, startIndex + cap);
    }

    if (endIndex >= total) {
        endIndex = total;
        startIndex = Math.max(0, total - cap);
    }

    const descriptor = createWindowDescriptor({
        identityKey: normalizedIdentity,
        followingLatest: endIndex >= total,
        list,
        startIndex,
        endIndex,
        windowSize: cap,
    });

    return {
        messages: list.slice(descriptor.startIndex, descriptor.endIndex),
        descriptor,
    };
}

export function pageConversationTimelineWindow(
    filteredMessages,
    currentDescriptor = null,
    direction = 'latest',
    {
        identityKey = currentDescriptor?.identityKey || '',
        lowMemoryActive = false,
        windowSize,
    } = {},
) {
    const list = Array.isArray(filteredMessages) ? filteredMessages : [];
    const total = list.length;
    const cap = resolveConversationTimelineWindowSize({ lowMemoryActive, windowSize });
    const normalizedIdentity = String(identityKey || '');

    if (total === 0 || direction === 'latest') {
        return selectConversationTimelineWindow(list, null, {
            identityKey: normalizedIdentity,
            lowMemoryActive,
            windowSize: cap,
        });
    }

    const settled = selectConversationTimelineWindow(list, currentDescriptor, {
        identityKey: normalizedIdentity,
        lowMemoryActive,
        windowSize: cap,
    }).descriptor;

    const step = Math.max(1, cap - 1);
    let startIndex = settled.startIndex;
    let endIndex = settled.endIndex;
    let followingLatest = settled.followingLatest;

    if (direction === 'older') {
        startIndex = Math.max(0, settled.startIndex - step);
        endIndex = Math.min(total, startIndex + cap);
        followingLatest = endIndex >= total;
    } else if (direction === 'newer') {
        const anchorIndex = Math.max(0, settled.endIndex - 1);
        if (anchorIndex + cap >= total) {
            endIndex = total;
            startIndex = Math.max(0, total - cap);
            followingLatest = true;
        } else {
            startIndex = anchorIndex;
            endIndex = startIndex + cap;
            followingLatest = false;
        }
    }

    const descriptor = createWindowDescriptor({
        identityKey: normalizedIdentity,
        followingLatest,
        list,
        startIndex,
        endIndex,
        windowSize: cap,
    });

    return {
        messages: list.slice(descriptor.startIndex, descriptor.endIndex),
        descriptor,
    };
}
