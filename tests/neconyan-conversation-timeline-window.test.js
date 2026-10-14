import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CONVERSATION_TIMELINE_WINDOW_LOW_MEMORY,
    CONVERSATION_TIMELINE_WINDOW_NORMAL,
    buildConversationTimelineWindowIdentity,
    moveConversationTimelineWindowToLatest,
    pageConversationTimelineWindow,
    resolveConversationTimelineWindowSize,
    selectConversationTimelineWindow,
    syncConversationHistoryButtonsForEditState,
} from '../public/scripts/neconyan-conversation/timeline-window.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

    test('never stretches the window beyond its cap even with 3,000 messages and disables history buttons during an open edit', () => {
        const messages = makeMessages(3000);
        const identityKey = 'large-thread';
        const initial = selectConversationTimelineWindow(messages, null, {
            identityKey,
            lowMemoryActive: true,
        });
        expect(initial.messages).toHaveLength(25);

        const olderPage = pageConversationTimelineWindow(messages, {
            identityKey,
            followingLatest: false,
            startMessageId: 'msg-40',
            endMessageId: 'msg-64',
            startIndex: 40,
            endIndex: 65,
            windowSize: 25,
            totalMessages: 3000,
            hasOlder: true,
            hasNewer: true,
        }, 'latest', {
            identityKey,
            lowMemoryActive: true,
        });
        expect(olderPage.messages).toHaveLength(25);
        expect(olderPage.descriptor.startIndex).toBe(2975);
        expect(olderPage.descriptor.endIndex).toBe(3000);

        const buttons = [
            { disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
            { disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
        ];
        let editing = true;
        const fakeTimeline = {
            querySelector: () => (editing ? {} : null),
            querySelectorAll: () => buttons,
        };
        expect(syncConversationHistoryButtonsForEditState(fakeTimeline)).toBe(true);
        expect(buttons.every(b => b.disabled === true && b.attrs['aria-disabled'] === 'true')).toBe(true);

        editing = false;
        expect(syncConversationHistoryButtonsForEditState(fakeTimeline)).toBe(false);
        expect(buttons.every(b => b.disabled === false && b.attrs['aria-disabled'] === 'false')).toBe(true);
    });

    test('moves a historical descriptor back to latest on workspace reopen, tab return and user send', () => {
        const messages = makeMessages(100);
        const identityKey = 'reopen-thread';
        const initial = selectConversationTimelineWindow(messages, null, { identityKey, lowMemoryActive: true });
        const historical = pageConversationTimelineWindow(messages, initial.descriptor, 'older', { identityKey, lowMemoryActive: true });
        expect(historical.descriptor.followingLatest).toBe(false);

        const state = {
            timelineWindowDescriptor: historical.descriptor,
            timelineBottomScrollPending: false,
        };
        moveConversationTimelineWindowToLatest(state);
        expect(state.timelineWindowDescriptor.followingLatest).toBe(true);
        expect(state.timelineBottomScrollPending).toBe(true);

        const reopened = selectConversationTimelineWindow(messages, state.timelineWindowDescriptor, {
            identityKey,
            lowMemoryActive: true,
        });
        expect(reopened.descriptor.followingLatest).toBe(true);
        expect(reopened.descriptor.startIndex).toBe(75);
        expect(reopened.descriptor.endIndex).toBe(100);

        const chromeSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-conversation', 'chrome.js'), 'utf8');
        const tabsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');
        const attachmentsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-conversation', 'attachments.js'), 'utf8');
        expect(chromeSource).toContain('moveConversationTimelineWindowToLatest();');
        expect(tabsSource).toContain('moveConversationTimelineWindowToLatest(conversationState);');
        expect(attachmentsSource).toContain('moveConversationTimelineWindowToLatest(conversationState);');
    });
});
