/* global globalThis */
import { describe, expect, jest, test } from '@jest/globals';

const handlers = new Map();
const savedSettings = { _settingsRevision: 2 };
const store = {};
const ensureConversationAutomationOwnership = jest.fn(async ({ acknowledgement }) => {
    store.automation = { mode: 'server', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', acknowledgement };
    return store.automation;
});
const triggerRoleplayDM = jest.fn();
const roleplayChat = [];
const personaChangeOrder = [];
const handleChatChanged = jest.fn(() => personaChangeOrder.push('handle'));
const loadCurrentPanelSettings = jest.fn(() => personaChangeOrder.push('load'));
const selectConversationThread = jest.fn();
const windowHandlers = new Map();
let hasUsage = false;
const conversationState = {
    runtimeStarted: false,
    conversationReplyTarget: { messageId: 'old-target' },
    conversationSelectedGroupId: null,
    conversationWorkspaceOpen: false,
    externalGenerationActive: false,
    generationActive: false,
    initialized: false,
};

globalThis.window = {
    addEventListener: (event, handler) => windowHandlers.set(event, handler),
    setInterval: jest.fn(),
};
globalThis.CustomEvent = class CustomEvent {
    constructor(detail) {
        this.detail = detail;
    }
};

await jest.unstable_mockModule('../public/script.js', () => ({ chat: roleplayChat, main_api: 'openai', settings: savedSettings }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'tester' }));
await jest.unstable_mockModule('../public/scripts/events.js', () => ({
    eventSource: { on: (event, handler) => handlers.set(event, handler) },
    event_types: {
        APP_READY: 'app-ready',
        CHARACTER_MESSAGE_RENDERED: 'character-message-rendered',
        CHAT_CHANGED: 'chat-changed',
        CHAT_LOADED: 'chat-loaded',
        GENERATION_ENDED: 'generation-ended',
        GENERATION_STARTED: 'generation-started',
        GENERATION_STOPPED: 'generation-stopped',
        PERSONA_CHANGED: 'persona-changed',
        SETTINGS_UPDATED: 'settings-updated',
        USER_MESSAGE_RENDERED: 'user-message-rendered',
    },
}));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/auto-engine.js', () => ({
    captureGroupAsideRequest: jest.fn(),
    captureRoleplayDMRequest: options => ({ ...options, branchId: 'branch-a', roleplayContext: 'captured roleplay' }),
    checkGroupChatMention: jest.fn(),
    handleChatChanged,
    triggerGroupAsideDM: jest.fn(),
    triggerRoleplayDM,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/chrome.js', () => ({
    disableConversationModeForCurrentCharacter: jest.fn(),
    ensureConversationStylesheet: jest.fn(),
    getDefaultConversationAvatar: () => '',
    selectConversationThread,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getConversationGroupById: () => null,
    getConversationPersonaId: () => 'persona-b.png',
    getConversationStore: () => store,
    getRoleplayCurrentCharacter: () => ({ avatar: 'roleplay.png', name: 'Roleplay' }),
    getRoleplayGroupById: () => null,
    migrateConversationLocalStorage: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/interface.js', () => ({ loadCurrentPanelSettings }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/notifications.js', () => ({
    sanitizeConversationUnreadCounts: jest.fn(),
    updateConversationNotificationIndicators: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/pals-rail.js', () => ({
    getCharacterForGroupChatMessage: () => null,
    getCurrentGroupConversationMembers: () => [],
    getConversationRailItems: () => [],
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-scheduler.js', () => ({ scheduleInterfaceRefresh: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-panel.js', () => ({
    closeConversationSettings: () => personaChangeOrder.push('close'),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({
    getSettings: avatar => ({ roleplay_reactions: avatar === 'roleplay.png' }),
    hasAnyConversationModeUsage: () => hasUsage,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({
    assertConversationAccount: () => {},
    initConversationStoreSync: jest.fn(),
    ensureConversationAutomationOwnership,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/native-jobs.js', () => ({
    resumeNativeConversationObservation: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({
    conversationState,
    setExternalConversationGenerationActive: (active) => {
        conversationState.externalGenerationActive = active;
        conversationState.generationActive = active;
    },
}));

const { init } = await import('../public/scripts/neconyan-conversation/init.js');

describe('conversation persona runtime', () => {
    test('starts autonomous runtime and clears context-bound reply UI after persona change', () => {
        init();
        expect(ensureConversationAutomationOwnership).not.toHaveBeenCalled();

        hasUsage = true;
        conversationState.conversationWorkspaceOpen = true;
        personaChangeOrder.length = 0;
        handlers.get('persona-changed')();

        expect(ensureConversationAutomationOwnership).toHaveBeenCalledWith({ acknowledgement: { account: 'tester', settingsRevision: 2 } });
        expect(conversationState.runtimeStarted).toBe(true);
        expect(conversationState.conversationReplyTarget).toBeNull();
        expect(personaChangeOrder).toEqual(['close', 'handle', 'load']);
    });

    test('targets the originating roleplay character instead of Conversation selection', () => {
        init();
        hasUsage = true;
        conversationState.conversationWorkspaceOpen = true;
        conversationState.conversationSelectedAvatar = 'conversation.png';
        roleplayChat[0] = { id: 0, role: 'character', mes: 'roleplay reply' };
        triggerRoleplayDM.mockClear();
        const random = jest.spyOn(Math, 'random').mockReturnValue(0);

        handlers.get('character-message-rendered')(0);

        expect(triggerRoleplayDM).toHaveBeenCalledWith(expect.objectContaining({
            avatar: 'roleplay.png',
            personaId: 'persona-b.png',
        }));
        random.mockRestore();
    });

    test('captures a successful save during configure and ignores already acknowledged revisions', async () => {
        await Promise.resolve();
        let finish;
        ensureConversationAutomationOwnership.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        savedSettings._settingsRevision = 3;
        handlers.get('settings-updated')();
        savedSettings._settingsRevision = 4;
        handlers.get('settings-updated')();
        finish({ mode: 'server', acknowledgement: { account: 'tester', settingsRevision: 3 } });
        await new Promise(resolve => setImmediate(resolve));
        expect(ensureConversationAutomationOwnership).toHaveBeenLastCalledWith({ acknowledgement: { account: 'tester', settingsRevision: 4 } });
        ensureConversationAutomationOwnership.mockClear();
        handlers.get('settings-updated')();
        expect(ensureConversationAutomationOwnership).not.toHaveBeenCalled();
    });

    test('passes captured persona identity through workspace-open events', () => {
        init();
        selectConversationThread.mockClear();

        windowHandlers.get('sb:open-conversation-workspace')(new globalThis.CustomEvent({
            avatar: 'char.png',
            branchId: 'branch-b',
            groupId: 'group-b',
            personaId: 'persona-c.png',
            showToast: false,
        }));

        expect(selectConversationThread).toHaveBeenCalledWith('char.png', {
            branchId: 'branch-b',
            groupId: 'group-b',
            personaId: 'persona-c.png',
            showToast: false,
        });
    });

    test('follows the newly selected roleplay character while Conversation is open', () => {
        init();
        selectConversationThread.mockClear();
        conversationState.conversationWorkspaceOpen = true;

        windowHandlers.get('sb:roleplay-character-selected')(new globalThis.CustomEvent({
            avatar: 'new-character.png',
        }));

        expect(selectConversationThread).toHaveBeenCalledWith('new-character.png', {
            showToast: false,
        });
    });
});
