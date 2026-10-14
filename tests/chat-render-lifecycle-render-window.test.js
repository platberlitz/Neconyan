import { describe, expect, test } from '@jest/globals';

import {
    CHAT_RENDER_WINDOW_DEFAULT,
    CHAT_RENDER_WINDOW_LOW_MEMORY_MAX,
    CHAT_RENDER_WINDOW_MAX,
    getChatHistoryPageSize,
    getChatRenderWindowStartIndex,
    normalizeChatRenderWindowSize,
    resolveChatRenderWindowPolicy,
    resolvePagedChatRenderWindowSize,
} from '../public/scripts/chat-render-lifecycle/render-window.js';

describe('chat render lifecycle render window helper', () => {
    test('uses a bounded default when truncation is disabled or invalid', () => {
        expect(CHAT_RENDER_WINDOW_DEFAULT).toBe(100);
        expect(CHAT_RENDER_WINDOW_MAX).toBe(200);
        expect(normalizeChatRenderWindowSize(0)).toBe(CHAT_RENDER_WINDOW_DEFAULT);
        expect(normalizeChatRenderWindowSize(null)).toBe(CHAT_RENDER_WINDOW_DEFAULT);
        expect(normalizeChatRenderWindowSize(Number.NaN)).toBe(CHAT_RENDER_WINDOW_DEFAULT);
        expect(normalizeChatRenderWindowSize(-1)).toBe(CHAT_RENDER_WINDOW_DEFAULT);
    });

    test('floors requested values and clamps large windows to the hard cap', () => {
        expect(normalizeChatRenderWindowSize(24.9)).toBe(24);
        expect(normalizeChatRenderWindowSize(500)).toBe(CHAT_RENDER_WINDOW_MAX);
        expect(normalizeChatRenderWindowSize(Number.MAX_SAFE_INTEGER)).toBe(CHAT_RENDER_WINDOW_MAX);
    });

    test('resolves the initial tail-window start index without rendering everything', () => {
        expect(getChatRenderWindowStartIndex(12, 100)).toBe(0);
        expect(getChatRenderWindowStartIndex(250, 100)).toBe(150);
        expect(getChatRenderWindowStartIndex(250, 0)).toBe(150);
        expect(getChatRenderWindowStartIndex(250, 500)).toBe(50);
    });

    test('keeps one rendered message as a paging anchor when pruning will follow', () => {
        expect(getChatHistoryPageSize(100, { renderedMessageCount: 0, windowSize: 100 })).toBe(100);
        expect(getChatHistoryPageSize(100, { renderedMessageCount: 100, windowSize: 100 })).toBe(99);
        expect(getChatHistoryPageSize(500, { renderedMessageCount: 200, windowSize: 200 })).toBe(199);
    });

    test('can load an exact page for target-reveal callers', () => {
        expect(getChatHistoryPageSize(50, {
            renderedMessageCount: 100,
            windowSize: 100,
            preserveAnchor: false,
        })).toBe(50);
        expect(getChatHistoryPageSize(500, {
            renderedMessageCount: 200,
            windowSize: 200,
            preserveAnchor: false,
        })).toBe(200);
    });

    test('applies a fixed 25-message low-memory window when history settings are not explicitly owned', () => {
        expect(CHAT_RENDER_WINDOW_LOW_MEMORY_MAX).toBe(25);

        const policy = resolveChatRenderWindowPolicy({
            chatTruncation: 100,
            aggressiveUnload: false,
            aggressiveWindowSize: 5,
            lowMemoryActive: true,
            historyExplicit: false,
        });
        expect(policy).toEqual({
            mode: 'fixed',
            initialSize: 25,
            maxSize: 25,
        });

        expect(resolvePagedChatRenderWindowSize(100, 25, {
            chatTruncation: 100,
            lowMemoryActive: true,
            historyExplicit: false,
        })).toBe(25);

        expect(getChatHistoryPageSize(100, {
            renderedMessageCount: 25,
            windowSize: 25,
            preserveAnchor: true,
        })).toBe(24);
    });

    test('honours explicit 5, 80 and 100-message user choices and caps zero or huge values safely', () => {
        const explicitAggressive = resolveChatRenderWindowPolicy({
            chatTruncation: 100,
            aggressiveUnload: true,
            aggressiveWindowSize: 5,
            lowMemoryActive: true,
            historyExplicit: true,
        });
        expect(explicitAggressive).toEqual({
            mode: 'fixed',
            initialSize: 5,
            maxSize: 5,
        });
        expect(resolvePagedChatRenderWindowSize(100, 5, {
            chatTruncation: 100,
            aggressiveUnload: true,
            aggressiveWindowSize: 5,
            lowMemoryActive: true,
            historyExplicit: true,
        })).toBe(5);

        for (const explicitTruncation of [80, 100]) {
            const explicitNormal = resolveChatRenderWindowPolicy({
                chatTruncation: explicitTruncation,
                lowMemoryActive: true,
                historyExplicit: true,
            });
            expect(explicitNormal).toEqual({
                mode: 'normal',
                initialSize: explicitTruncation,
                maxSize: 200,
            });
            expect(resolvePagedChatRenderWindowSize(explicitTruncation, explicitTruncation, {
                chatTruncation: explicitTruncation,
                lowMemoryActive: true,
                historyExplicit: true,
            })).toBe(Math.min(200, explicitTruncation * 2));
        }

        // Zero or huge truncation values cannot escape the 25-message low-memory cap or 200-message normal cap.
        for (const legacyValue of [0, 500, Number.MAX_SAFE_INTEGER]) {
            expect(resolveChatRenderWindowPolicy({
                requestedSize: legacyValue,
                chatTruncation: legacyValue,
                lowMemoryActive: true,
                historyExplicit: false,
            })).toEqual({
                mode: 'fixed',
                initialSize: 25,
                maxSize: 25,
            });

            expect(resolveChatRenderWindowPolicy({
                requestedSize: legacyValue,
                chatTruncation: legacyValue,
                lowMemoryActive: true,
                historyExplicit: true,
            }).initialSize).toBeLessThanOrEqual(200);
        }

        // Target-reveal calls requesting a small count keep their exact page size within the low-memory window.
        expect(getChatHistoryPageSize(12, {
            renderedMessageCount: 25,
            windowSize: resolvePagedChatRenderWindowSize(12, 25, {
                chatTruncation: 100,
                lowMemoryActive: true,
                historyExplicit: false,
            }),
            preserveAnchor: false,
        })).toBe(12);
    });
});
