import { describe, expect, test } from '@jest/globals';
import {
    CONVERSATION_TIMELINE_WINDOW_LOW_MEMORY,
    CONVERSATION_TIMELINE_WINDOW_NORMAL,
    buildConversationTimelineWindowIdentity,
    pageConversationTimelineWindow,
    resolveConversationTimelineWindowSize,
    selectConversationTimelineWindow,
} from '../public/scripts/neconyan-conversation/timeline-window.js';

function makeMessages(count, prefix = 'msg') {
    return Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index}`,
        role: index % 2 === 0 ? 'user' : 'character',
        name: index % 2 === 0 ? 'User' : 'Miso',
        mes: `Message ${index}`,
    }));
}

describe('Conversation timeline window selection and paging', () => {
    test('uses 200 in normal mode and 25 in active low-memory mode and stores only IDs and counts in the descriptor', () => {
        expect(CONVERSATION_TIMELINE_WINDOW_NORMAL).toBe(200);
        expect(CONVERSATION_TIMELINE_WINDOW_LOW_MEMORY).toBe(25);
        expect(resolveConversationTimelineWindowSize({ lowMemoryActive: false })).toBe(200);
        expect(resolveConversationTimelineWindowSize({ lowMemoryActive: true })).toBe(25);

        const messages = makeMessages(500);
        const identityKey = buildConversationTimelineWindowIdentity({
            account: 'user-a',
            personaId: 'persona-1.png',
            avatar: 'miso.png',
            groupId: '',
            branchId: 'main',
            channel: 'main',
            query: '',
        });

        const normal = selectConversationTimelineWindow(messages, null, {
            identityKey,
            lowMemoryActive: false,
        });
        expect(normal.messages).toHaveLength(200);
        expect(normal.messages[0].id).toBe('msg-300');
        expect(normal.messages.at(-1).id).toBe('msg-499');
        expect(normal.descriptor).toEqual({
            identityKey,
            followingLatest: true,
            startMessageId: 'msg-300',
            endMessageId: 'msg-499',
            startIndex: 300,
            endIndex: 500,
            windowSize: 200,
            totalMessages: 500,
            hasOlder: true,
            hasNewer: false,
        });
        expect(Object.keys(normal.descriptor)).not.toContain('messages');

        const lowMemory = selectConversationTimelineWindow(messages, null, {
            identityKey,
            lowMemoryActive: true,
        });
        expect(lowMemory.messages).toHaveLength(25);
        expect(lowMemory.messages[0].id).toBe('msg-475');
        expect(lowMemory.messages.at(-1).id).toBe('msg-499');
        expect(lowMemory.descriptor.windowSize).toBe(25);
    });

    test('pages older and newer with a one-message overlap and reaches every message in both directions without gaps', () => {
        const messages = makeMessages(80);
        const identityKey = 'test-thread';
        let current = selectConversationTimelineWindow(messages, null, {
            identityKey,
            lowMemoryActive: true,
        });

        const seenBackwards = new Set(current.messages.map(m => m.id));
        expect(current.descriptor.startIndex).toBe(55);
        expect(current.descriptor.endIndex).toBe(80);

        while (current.descriptor.hasOlder) {
            const previousFirstId = current.messages[0].id;
            const next = pageConversationTimelineWindow(messages, current.descriptor, 'older', {
                identityKey,
                lowMemoryActive: true,
            });
            // One-message overlap: the previous first visible message remains visible in the older page.
            expect(next.messages.map(m => m.id)).toContain(previousFirstId);
            next.messages.forEach(m => seenBackwards.add(m.id));
            current = next;
        }

        expect(current.descriptor.startIndex).toBe(0);
        expect(current.descriptor.hasOlder).toBe(false);
        expect(current.descriptor.hasNewer).toBe(true);
        expect(current.descriptor.followingLatest).toBe(false);
        expect(seenBackwards.size).toBe(80);

        // Now page forward with 'newer' all the way back to the latest message.
        const seenForwards = new Set(current.messages.map(m => m.id));
        while (current.descriptor.hasNewer) {
            const previousLastId = current.messages.at(-1).id;
            const next = pageConversationTimelineWindow(messages, current.descriptor, 'newer', {
                identityKey,
                lowMemoryActive: true,
            });
            expect(next.messages.map(m => m.id)).toContain(previousLastId);
            next.messages.forEach(m => seenForwards.add(m.id));
            current = next;
        }

        expect(current.descriptor.endIndex).toBe(80);
        expect(current.descriptor.followingLatest).toBe(true);
        expect(current.descriptor.hasNewer).toBe(false);
        expect(seenForwards.size).toBe(80);
    });

    test('retains historical reader position when new messages arrive and resolves deleted anchor boundaries', () => {
        const messages = makeMessages(100);
        const identityKey = 'reader-thread';
        const initial = selectConversationTimelineWindow(messages, null, {
            identityKey,
            lowMemoryActive: true,
        });
        const historical = pageConversationTimelineWindow(messages, initial.descriptor, 'older', {
            identityKey,
            lowMemoryActive: true,
        });
        expect(historical.descriptor.followingLatest).toBe(false);
        expect(historical.descriptor.startMessageId).toBe('msg-51');
        expect(historical.descriptor.endMessageId).toBe('msg-75');

        // Appending new messages at the end does not pull the historical reader to the bottom.
        const withNewReplies = [...messages, { id: 'msg-100', role: 'character', mes: 'New reply 1' }, { id: 'msg-101', role: 'character', mes: 'New reply 2' }];
        const refreshed = selectConversationTimelineWindow(withNewReplies, historical.descriptor, {
            identityKey,
            lowMemoryActive: true,
        });
        expect(refreshed.descriptor.followingLatest).toBe(false);
        expect(refreshed.descriptor.startMessageId).toBe('msg-51');
        expect(refreshed.descriptor.endMessageId).toBe('msg-75');
        expect(refreshed.descriptor.hasNewer).toBe(true);

        // Deleting the start boundary message resolves from the remaining end boundary without jumping to latest.
        const withoutStartAnchor = withNewReplies.filter(m => m.id !== 'msg-51');
        const afterDelete = selectConversationTimelineWindow(withoutStartAnchor, refreshed.descriptor, {
            identityKey,
            lowMemoryActive: true,
        });
        expect(afterDelete.descriptor.followingLatest).toBe(false);
        expect(afterDelete.descriptor.endMessageId).toBe('msg-75');
        expect(afterDelete.messages).toHaveLength(25);

        // Choosing 'latest' returns immediately to the newest end.
        const latest = pageConversationTimelineWindow(withoutStartAnchor, afterDelete.descriptor, 'latest', {
            identityKey,
            lowMemoryActive: true,
        });
        expect(latest.descriptor.followingLatest).toBe(true);
        expect(latest.descriptor.hasNewer).toBe(false);
        expect(latest.messages.at(-1).id).toBe('msg-101');
    });

    test('resets to the newest window when account, persona, avatar, group, branch, channel or query changes', () => {
        const messages = makeMessages(100);
        const baseParams = {
            account: 'user-a',
            personaId: 'persona-1.png',
            avatar: 'miso.png',
            groupId: '',
            branchId: 'main',
            channel: 'main',
            query: '',
        };
        const baseKey = buildConversationTimelineWindowIdentity(baseParams);
        const initial = selectConversationTimelineWindow(messages, null, { identityKey: baseKey, lowMemoryActive: true });
        const historical = pageConversationTimelineWindow(messages, initial.descriptor, 'older', { identityKey: baseKey, lowMemoryActive: true });
        expect(historical.descriptor.followingLatest).toBe(false);

        const variations = [
            { ...baseParams, account: 'user-b' },
            { ...baseParams, personaId: 'persona-2.png' },
            { ...baseParams, avatar: 'taro.png' },
            { ...baseParams, groupId: 'group-1' },
            { ...baseParams, branchId: 'branch-2' },
            { ...baseParams, channel: 'pinned' },
            { ...baseParams, query: 'coffee' },
        ];

        for (const variant of variations) {
            const nextKey = buildConversationTimelineWindowIdentity(variant);
            expect(nextKey).not.toBe(baseKey);
            const reset = selectConversationTimelineWindow(messages, historical.descriptor, {
                identityKey: nextKey,
                lowMemoryActive: true,
            });
            expect(reset.descriptor.followingLatest).toBe(true);
            expect(reset.descriptor.startIndex).toBe(75);
            expect(reset.descriptor.endIndex).toBe(100);
        }
    });
});
