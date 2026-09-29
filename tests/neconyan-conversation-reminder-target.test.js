import { describe, expect, jest, test } from '@jest/globals';
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'tester' }));
const assertConversationAccount = jest.fn();
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({
    assertConversationAccount,
    refreshConversationStore: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/presentation.js', () => ({ presentPendingConversationClaims: jest.fn() }));

import { resolveConversationReminderBranchId } from '../public/scripts/neconyan-conversation/thread-store-utils.js';

const persistConversationStore = jest.fn();
const generateConversationReply = jest.fn();
const reminder = {
    id: 'reminder-1',
    avatar: 'char.png',
    branchId: 'deleted-branch',
    groupId: '',
    personaId: 'persona-a.png',
    text: 'remember this',
    triggerAt: 1,
    fired: false,
};

const saveChatConditional = jest.fn(async () => true);
await jest.unstable_mockModule('../public/script.js', () => ({ chat: [{ mes: 'first' }, { mes: 'second', name: 'Aster', avatar: 'char.png' }], getCurrentChatId: () => 'chat', getRequestHeaders: () => ({}), is_send_press: false, name1: 'User', saveChatConditional }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getActiveConversationBranch: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-a.png' : value || ''),
    getConversationStore: () => ({ reminders: [reminder] }),
    getConversationThreadStore: () => ({
        activeBranchId: 'main',
        branches: { main: { id: 'main' } },
    }),
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
    getRoleplayCurrentCharacter: () => ({ avatar: 'char.png' }),
    getRoleplayGroupById: () => null,
    parsePositiveInt: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    persistConversationStore,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/generation.js', () => ({
    generateConversationReply,
    postCharacterReply: jest.fn(),
    postPartnerConversationReply: jest.fn(),
    reportConversationGenerationError: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/interface.js', () => ({ loadCurrentPanelSettings: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/media.js', () => ({
    getCharacterForAvatar: () => ({ avatar: 'char.png', name: 'Aster' }),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/message-writer.js', () => ({ appendConversationMessage: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/pals-rail.js', () => ({
    getConversationRailItems: () => [],
    getCurrentGroupConversationMembers: () => [],
    getSelectedConversationGroup: () => null,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/partners.js', () => ({
    getAllowedPartnerCharacters: () => [],
    isCharacterMentionedInText: () => false,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({
    getConversationPersonaName: () => 'User',
    getUserStatus: () => 'online',
    safeParseWeeklySchedule: () => [],
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/schedule.js', () => ({
    clamp: value => value,
    getCurrentActivityFromSchedule: () => ({ activity: '', status: 'online' }),
    getStoredSchedule: () => null,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/shared-helpers.js', () => ({ buildConversationRoleplayContext: () => '' }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({
    getAutoCharacterChatCooldownMs: () => 0,
    getConversationBranchActivityTime: () => 0,
    getConversationSessionMarker: () => '',
    getFollowupCount: () => 0,
    getLastAutoCharacterChatTime: () => 0,
    getLastUserActivity: () => 0,
    getSettings: () => ({ enabled: true }),
    setConversationSessionMarker: jest.fn(),
    setFollowupCount: jest.fn(),
    setLastAutoCharacterChatTime: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({
    conversationState: {},
    groupAsideBusyKeys: new Set(),
    groupAsideLastSent: new Map(),
    partnerReplyBusyKeys: new Set(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store.js', () => ({
    getConversationThread: () => [],
    resolveConversationReminderBranchId,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/typing.js', () => ({
    getConversationActivityContext: () => ({ activity: '', source: 'manual', status: 'online' }),
    withTypingParticipant: (_participant, task) => task(),
}));

const { submitConversationAsideEvent } = await import('../public/scripts/neconyan-conversation/auto-engine.js');

describe('conversation reminder target identity', () => {
    test('the native aside event refuses a refreshed identity before saving the old chat', async () => {
        assertConversationAccount.mockImplementation(() => { throw new Error('account_changed'); });
        await expect(submitConversationAsideEvent('rendered', 1, { account: 'tester' })).resolves.toBeNull();
        expect(assertConversationAccount).toHaveBeenCalledWith('tester');
        expect(saveChatConditional).not.toHaveBeenCalled();
        assertConversationAccount.mockReset();
    });
});
