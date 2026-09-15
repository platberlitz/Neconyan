import { describe, expect, jest, test } from '@jest/globals';

const selectConversationThread = jest.fn(async () => true);

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ playMessageSound: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/chrome.js', () => ({ selectConversationThread }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    clearLegacyConversationUnreadStorage: () => 0,
    getActiveConversationBranch: () => null,
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: () => 'active.png',
    getConversationStore: () => ({ characters: {} }),
    getConversationThreadKey: () => '',
    getConversationThreadStore: () => null,
    getCurrentCharAvatar: () => '',
    isConversationThreadKeyForPersona: () => true,
    parseConversationThreadKey: () => ({ avatar: '', groupId: '', personaId: '' }),
    parsePositiveInt: (_value, fallback) => fallback,
    persistConversationStore: jest.fn(),
    shouldSurfaceConversationNotification: () => true,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/media.js', () => ({ getCharacterForAvatar: () => null }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({
    getSettings: () => ({}),
    isConversationModeEnabled: () => true,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState: {} }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/typing.js', () => ({ stripPreviewText: value => String(value || '') }));

const { openConversationFromNotification } = await import('../public/scripts/neconyan-conversation/notifications.js');

describe('conversation notification routing', () => {
    test('routes the captured persona, branch, and group to thread selection', async () => {
        await expect(openConversationFromNotification('char.png', {
            branchId: 'branch-a',
            groupId: 'group-a',
            personaId: 'captured.png',
        })).resolves.toBe(true);

        expect(selectConversationThread).toHaveBeenCalledWith('char.png', {
            branchId: 'branch-a',
            groupId: 'group-a',
            personaId: 'captured.png',
            showToast: false,
        });
    });
});
