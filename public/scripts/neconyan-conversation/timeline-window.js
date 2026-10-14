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

function getMessageId(message, index) {
    const rawId = message?.id;
    if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
        return String(rawId);
    }
    return `idx:${index}`;
}

function expandBoundsForProtectedIds(list, startIndex, endIndex, protectedMessageIds) {
    if (!Array.isArray(protectedMessageIds) || protectedMessageIds.length === 0) {
        return { startIndex, endIndex };
    }
    const protectedSet = new Set(protectedMessageIds.map(id => String(id || '')).filter(Boolean));
    if (protectedSet.size === 0) {
        return { startIndex, endIndex };
    }
    let nextStart = startIndex;
    let nextEnd = endIndex;
    for (let i = 0; i < list.length; i++) {
        const id = String(list[i]?.id ?? '');
        if (id && protectedSet.has(id)) {
            if (i < nextStart) nextStart = i;
            if (i >= nextEnd) nextEnd = i + 1;
        }
    }
    return { startIndex: nextStart, endIndex: nextEnd };
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
        protectedMessageIds = [],
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
        const rawEnd = total;
        const rawStart = Math.max(0, rawEnd - cap);
        const { startIndex, endIndex } = expandBoundsForProtectedIds(list, rawStart, rawEnd, protectedMessageIds);
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

    let rawStart;
    let rawEnd;
    if (foundStartIndex >= 0) {
        rawStart = foundStartIndex;
        rawEnd = Math.min(total, rawStart + cap);
    } else if (foundEndIndex >= 0) {
        rawEnd = Math.min(total, foundEndIndex + 1);
        rawStart = Math.max(0, rawEnd - cap);
    } else {
        const fallbackStart = Number.isInteger(previousDescriptor.startIndex)
            ? previousDescriptor.startIndex
            : 0;
        rawStart = Math.max(0, Math.min(fallbackStart, Math.max(0, total - cap)));
        rawEnd = Math.min(total, rawStart + cap);
    }

    if (rawEnd >= total) {
        rawEnd = total;
        rawStart = Math.max(0, total - cap);
    }

    const { startIndex, endIndex } = expandBoundsForProtectedIds(list, rawStart, rawEnd, protectedMessageIds);
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
        protectedMessageIds = [],
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
            protectedMessageIds,
        });
    }

    const settled = selectConversationTimelineWindow(list, currentDescriptor, {
        identityKey: normalizedIdentity,
        lowMemoryActive,
        windowSize: cap,
    }).descriptor;

    const step = Math.max(1, cap - 1);
    let rawStart = settled.startIndex;
    let rawEnd = settled.endIndex;
    let followingLatest = settled.followingLatest;

    if (direction === 'older') {
        rawStart = Math.max(0, settled.startIndex - step);
        rawEnd = Math.min(total, rawStart + cap);
        followingLatest = rawEnd >= total;
    } else if (direction === 'newer') {
        const anchorIndex = Math.max(0, settled.endIndex - 1);
        if (anchorIndex + cap >= total) {
            rawEnd = total;
            rawStart = Math.max(0, total - cap);
            followingLatest = true;
        } else {
            rawStart = anchorIndex;
            rawEnd = rawStart + cap;
            followingLatest = false;
        }
    }

    const { startIndex, endIndex } = expandBoundsForProtectedIds(list, rawStart, rawEnd, protectedMessageIds);
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
