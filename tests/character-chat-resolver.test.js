import { describe, expect, test } from '@jest/globals';
import { availableCharacterChatName, normalizeCharacterChatName, resolveCharacterChatNameForLoad } from '../public/scripts/character-chat-resolver.js';

describe('normalizeCharacterChatName', () => {
    test('trims names and strips jsonl extensions', () => {
        expect(normalizeCharacterChatName(' Chat One.jsonl ')).toBe('Chat One');
    });
});

describe('availableCharacterChatName', () => {
    const base = 'Taro (Neutral) - 2026-11-14 17-15-25';

    test('keeps the readable timestamp when it is unused', () => {
        expect(availableCharacterChatName(base, [{ file_name: 'An older chat.jsonl' }])).toBe(base);
    });

    test('preserves every existing chat created within the same second', () => {
        const chats = [base, `${base} (1)`, `${base} (2)`].map(name => ({ file_name: `${name}.jsonl` }));
        expect(availableCharacterChatName(base, chats)).toBe(`${base} (3)`);
        expect(chats.map(chat => chat.file_name)).toEqual([`${base}.jsonl`, `${base} (1).jsonl`, `${base} (2).jsonl`]);
    });

    test('handles unsuffixed filenames and reuses a free numbered name', () => {
        expect(availableCharacterChatName(base, [{ file_name: base }, { file_name: `${base} (2).jsonl` }])).toBe(`${base} (1)`);
    });
});

describe('resolveCharacterChatNameForLoad', () => {
    test('keeps persisted chat when it exists', () => {
        expect(resolveCharacterChatNameForLoad({
            persistedChat: 'Existing Chat',
            existingChats: [
                { file_name: 'Existing Chat.jsonl' },
                { file_name: 'Older Chat.jsonl' },
            ],
            allowCreate: true,
            newChatName: 'New Chat',
        })).toEqual({ chatName: 'Existing Chat', created: false });
    });

    test('falls back to latest existing chat when persisted chat is stale', () => {
        expect(resolveCharacterChatNameForLoad({
            persistedChat: 'Missing Chat',
            existingChats: [
                { file_name: 'Latest Real Chat.jsonl' },
                { file_name: 'Older Real Chat.jsonl' },
            ],
            allowCreate: true,
            newChatName: 'New Chat',
        })).toEqual({ chatName: 'Latest Real Chat', created: false });
    });

    test('creates a new chat only when no real chat exists', () => {
        expect(resolveCharacterChatNameForLoad({
            persistedChat: 'Missing Chat',
            existingChats: [],
            allowCreate: true,
            newChatName: 'Fresh Chat',
        })).toEqual({ chatName: 'Fresh Chat', created: true });
    });

    test('allows missing persisted chat for intentional new chat creation', () => {
        expect(resolveCharacterChatNameForLoad({
            persistedChat: 'Intentional New Chat',
            existingChats: [],
            allowCreate: true,
            allowMissingPersisted: true,
            newChatName: 'Fallback Chat',
        })).toEqual({ chatName: 'Intentional New Chat', created: true });
    });
});
