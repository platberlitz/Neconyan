import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const extensionSettings = {};
const saveSettingsDebounced = jest.fn();
const persistConversationStoreDebounced = jest.fn();
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({ persistConversationStoreDebounced }));

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [],
    saveSettingsDebounced,
    this_chid: undefined,
    getRequestHeaders: () => ({}),
    settings: {},
}));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: extensionSettings }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'tester' }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    editGroup: jest.fn(),
    groups: [],
    selected_group: null,
}));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'persona-a.png' }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/media.js', () => ({ getCharacterForAvatar: () => null }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/schedule.js', () => ({
    getConversationReplyMaxTokens: settings => settings.reply_max_tokens,
    getScheduleStorageKey: avatar => `schedule:${avatar}`,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({
    conversationState: {
        conversationSelectedAvatar: null,
        conversationSelectedGroupId: null,
        conversationWorkspaceOpen: false,
    },
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store.js', () => ({ safeParseThread: value => value }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/typing.js', () => ({ stripPreviewText: value => String(value || '') }));

const {
    compactConversationSettings,
    getCharacterConversationStore,
    getConversationStore,
    safeParseSettings,
} = await import('../public/scripts/neconyan-conversation/context.js');
const {
    DEFAULT_SETTINGS,
    THREAD_CONVERSATION_SETTINGS_KEYS,
} = await import('../public/scripts/neconyan-conversation/constants.js');

function pickThreadKeys(settings) {
    return Object.fromEntries(THREAD_CONVERSATION_SETTINGS_KEYS.map(key => [key, settings[key]]));
}

describe('conversation thread settings compaction', () => {
    beforeEach(() => {
        for (const key of Object.keys(extensionSettings)) {
            delete extensionSettings[key];
        }
    });

    test('keeps only values that differ from the defaults', () => {
        const settings = safeParseSettings({ enabled: true, chatroom_prompt: 'Custom prompt', cooldown: DEFAULT_SETTINGS.cooldown });

        expect(compactConversationSettings(settings, THREAD_CONVERSATION_SETTINGS_KEYS)).toEqual({
            enabled: true,
            chatroom_prompt: 'Custom prompt',
        });
    });

    test('reads back exactly the settings a full copy gave', () => {
        const stored = {
            ...DEFAULT_SETTINGS,
            enabled: true,
            offline_message: 'Away',
            geechan_chatroom_prompt: 'Legacy prompt',
            reply_max_tokens: 1024,
            multi_char_names: 'Nova, Iris',
            quiet_hours_start: '22',
        };
        delete stored.chatroom_prompt;
        const normalized = safeParseSettings(stored);
        const compact = compactConversationSettings(normalized, THREAD_CONVERSATION_SETTINGS_KEYS);

        expect(compact.chatroom_prompt).toBe('Legacy prompt');
        expect(Object.keys(compact)).not.toContain('selfie_prompt');
        expect(pickThreadKeys(safeParseSettings(compact))).toEqual(pickThreadKeys(normalized));
        expect(compactConversationSettings(safeParseSettings(compact), THREAD_CONVERSATION_SETTINGS_KEYS)).toEqual(compact);
    });

    test('stores new and existing threads without default copies', () => {
        extensionSettings.neconyan_conversation = {
            characters: {
                'persona:persona-a.png:old.png': {
                    activeBranchId: 'main',
                    settings: { ...DEFAULT_SETTINGS, enabled: true, availability: 'dnd' },
                    branches: { main: { id: 'main', messages: [] } },
                },
            },
            groups: [],
            reminders: [],
            settings: {},
        };

        expect(getCharacterConversationStore('old.png', { personaId: 'persona-a.png' }).settings).toEqual({
            enabled: true,
            availability: 'dnd',
        });
        expect(getCharacterConversationStore('new.png', { personaId: 'persona-a.png' }).settings).toEqual({});
        expect(getConversationStore().characters['persona:persona-a.png:new.png'].settings).toEqual({});
    });
});
