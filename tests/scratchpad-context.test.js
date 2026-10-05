import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const characters = [
    { avatar: 'Roleplay.png', name: 'Roleplay', data: { extensions: { world: 'Roleplay lore' } } },
    { avatar: 'Nova.png', name: 'Nova', data: { description: '{{char}} talks to {{user}}.', extensions: { world: 'Nova lore' } } },
    { avatar: 'Kit.png', name: 'Kit', data: { extensions: { world: 'Empty lore' } } },
];
const conversationState = { conversationWorkspaceOpen: true };
const branch = { id: 'main', messages: [] };
const conversationSettings = { lorebook_override: 'Conversation lore', connection_profile: 'conversation-profile' };
const power_user = { persona_description: 'Roleplay persona', persona_description_lorebook: 'Persona lore' };
const chat = [];
const books = new Map();
let avatar = 'Nova.png';
let groupId = '';
const loadWorldInfo = jest.fn(async name => books.get(name));

jest.unstable_mockModule('../public/script.js', () => ({
    characters, chat, chat_metadata: { world_info: 'Chat lore' }, this_chid: 0, name1: 'Roleplay user', getCurrentChatId: () => 'chat',
    substituteParams: (text, options = {}) => text.replaceAll('{{char}}', options.name2Override || 'Roleplay').replaceAll('{{user}}', options.name1Override || 'Roleplay user'),
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ getGroupMembers: () => characters.slice(1), groups: [], selected_group: null }));
jest.unstable_mockModule('../public/scripts/neconyan-assistant-knowledge.js', () => ({ buildAssistantKnowledge: async () => ({}) }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getActiveConversationBranch: () => branch, getConversationGroupById: () => ({ name: 'Friends', members: ['Nova.png', 'Kit.png'] }),
    getConversationGroupIdForAvatar: () => groupId, getConversationThreadKey: () => avatar, getCurrentCharAvatar: () => avatar,
    getConversationPersonaId: () => 'persona.png',
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({
    composeConversationPersonaDescription: () => '{{user}} is a Conversation persona with {{char}}.', getConversationPersonaName: () => 'Conversation user',
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({ getSettings: () => conversationSettings }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user }));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({ getTokenCountAsync: async () => 1 }));
jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    loadWorldInfo, selected_world_info: ['Global lore'], world_info: { charLore: [{ name: 'Nova', extraBooks: ['Extra lore'] }] },
}));

const { buildContext, collectLore, currentSource } = await import('../public/scripts/scratchpad/context.js');
const settings = { depth: 15, include: { lore: true, card: true, persona: true } };

beforeEach(() => {
    conversationState.conversationWorkspaceOpen = true;
    avatar = 'Nova.png';
    groupId = '';
    branch.messages = [{ id: 'one', role: 'user', mes: 'A lighthouse.' }];
    chat.length = 0;
    books.clear();
    for (const name of ['Roleplay lore', 'Chat lore', 'Nova lore', 'Conversation lore', 'Persona lore', 'Extra lore', 'Global lore']) {
        books.set(name, { entries: { 0: { uid: 0, comment: name, key: ['lighthouse'], content: `${name}: {{char}} and {{user}}.` } } });
    }
    books.set('Empty lore', { entries: {} });
    loadWorldInfo.mockClear();
});

describe('Scratchpad source context', () => {
    test('Conversation reads its own characters, persona, override and attached books', async () => {
        const context = await buildContext({ source: currentSource(), settings });
        expect(context.lore.books).toEqual(expect.arrayContaining(['Nova lore', 'Conversation lore', 'Extra lore', 'Global lore', 'Persona lore']));
        expect(context.text).not.toMatch(/Roleplay lore|Chat lore|Roleplay persona|Roleplay user/);
        expect(context.text).toContain('Conversation user is a Conversation persona with Nova.');
        expect(context.text).toContain('Nova lore: Nova and Conversation user.');
    });

    test('includes every group member and keeps empty attached books available for new entries', async () => {
        groupId = 'friends';
        const lore = await collectLore({ source: currentSource(), settings, scanText: '' });
        expect(lore.books).toContain('Empty lore');
        expect(lore.books).toContain('Nova lore');
        expect(lore.books).not.toContain('Roleplay lore');
    });

    test('Roleplay still reads its character and chat lore', async () => {
        conversationState.conversationWorkspaceOpen = false;
        const lore = await collectLore({ source: currentSource(), settings, scanText: 'lighthouse' });
        expect(lore.books).toEqual(expect.arrayContaining(['Roleplay lore', 'Chat lore', 'Global lore', 'Persona lore']));
        expect(lore.books).not.toContain('Conversation lore');
    });

    test('refuses a context whose source changed while lore was loading', async () => {
        const source = currentSource();
        loadWorldInfo.mockImplementationOnce(async name => { avatar = 'Kit.png'; return books.get(name); });
        await expect(buildContext({ source, settings })).rejects.toThrow('Open the chat');
    });

    test('bounds non-Latin context by the server byte limit', async () => {
        branch.messages = Array.from({ length: 200 }, (_, index) => ({ id: String(index), role: 'user', mes: '猫'.repeat(16000) }));
        const result = await buildContext({ source: currentSource(), settings: { depth: 200 } });
        expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(1536 * 1024);
    });
});
