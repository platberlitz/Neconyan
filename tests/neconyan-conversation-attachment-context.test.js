import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store-utils.js', () => ({
    getConversationAttachmentSummary: () => 'Attachment: notes.txt',
    getConversationMediaDisplay: () => '',
    getConversationMediaIndex: () => 0,
    getConversationPromptMediaAttachments: () => [],
}));

const { composeConversationPromptMessages } = await import('../public/scripts/neconyan-conversation/prompt-messages.js');

describe('conversation attachment context', () => {
    test('a stored attachment context reaches the transcript row', async () => {
        const rows = await composeConversationPromptMessages([
            {
                id: 'u1', role: 'user', name: 'User', mes: 'See attached',
                extra: { conversation_attachment_context: 'Attached file text: the passphrase is moonlight' },
            },
        ], '', 'Aster');
        const row = rows.find(item => item.identifier === 'conversation-message-u1');
        expect(row.content).toContain('moonlight');
    });

    test('a message without attachment context is unchanged', async () => {
        const rows = await composeConversationPromptMessages([
            { id: 'u2', role: 'user', name: 'User', mes: 'Just text' },
        ], '', 'Aster');
        const row = rows.find(item => item.identifier === 'conversation-message-u2');
        expect(row.content).toBe('User: Just text Attachment: notes.txt');
    });
});
