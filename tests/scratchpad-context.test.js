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
let chatId = 'chat';
const loadWorldInfo = jest.fn(async name => books.get(name));
const getRoleplaySourceId = jest.fn(() => null);

jest.unstable_mockModule('../public/script.js', () => ({
    characters, chat, chat_metadata: { world_info: 'Chat lore' }, this_chid: 0, name1: 'Roleplay user', getCurrentChatId: () => chatId,
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
jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({ getRoleplaySourceId }));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({ getTokenCountAsync: async () => 1 }));
jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    loadWorldInfo, selected_world_info: ['Global lore'], world_info: { charLore: [{ name: 'Nova', extraBooks: ['Extra lore'] }] },
}));

const { buildContext, collectLore, currentSource, isCurrentSource, wireSource, sourceMessages, sourceCharacters, setNotebookSource } = await import('../public/scripts/scratchpad/context.js');
const settings = { depth: 15, include: { lore: true, card: true, persona: true } };

beforeEach(() => {
    setNotebookSource(null);
    conversationState.conversationWorkspaceOpen = true;
    avatar = 'Nova.png';
    groupId = '';
    chatId = 'chat';
    getRoleplaySourceId.mockReset().mockReturnValue(null);
    branch.messages = [{ id: 'one', role: 'user', mes: 'A lighthouse.' }];
    chat.length = 0;
    books.clear();
    for (const name of ['Roleplay lore', 'Chat lore', 'Nova lore', 'Conversation lore', 'Persona lore', 'Extra lore', 'Global lore']) {
        books.set(name, { entries: { 0: { uid: 0, comment: name, key: ['lighthouse'], content: `${name}: {{char}} and {{user}}.` } } });
    }
    books.set('Empty lore', { entries: {} });
    loadWorldInfo.mockClear();
});

describe('Scratchpad swipe comparison', () => {
    beforeEach(() => {
        conversationState.conversationWorkspaceOpen = false;
        chat.push({ name: 'Roleplay', mes: 'The current ending, edited.', swipe_id: 1,
            swipes: ['The quiet ending.', 'The current ending.', 'The surprise ending.'] });
    });

    test('recent messages share only the current version, including its latest edits', async () => {
        const context = await buildContext({ source: currentSource(), settings: { depth: 1 } });
        expect(context.text).toContain('The current ending, edited.');
        expect(context.text).not.toContain('The quiet ending.');
        expect(context.text).not.toContain('The surprise ending.');
        expect(context.swipeCount).toBe(0);
    });

    test('shares selected alternatives with labels and leaves the current chat untouched', async () => {
        const before = structuredClone(chat);
        const choices = sourceMessages(currentSource())[0].swipes;
        const context = await buildContext({ source: currentSource(), settings: { depth: 15, picked: [choices[0].ref, choices[1].ref] } });
        expect(context.text).toContain('#0 Roleplay [swipe 1 of 3; alternative]:\nThe quiet ending.');
        expect(context.text).toContain('#0 Roleplay [swipe 2 of 3; current]:\nThe current ending, edited.');
        expect(context.text).not.toContain('The surprise ending.');
        expect(context.text).toContain('do not treat alternatives as consecutive events');
        expect(context.messageCount).toBe(1);
        expect(context.swipeCount).toBe(2);
        expect(chat).toEqual(before);
    });

    test('does not repeat a current message picked both directly and through its swipe', async () => {
        const context = await buildContext({ source: currentSource(), settings: { picked: ['0', '0:swipe:1'] } });
        expect(context.text.match(/The current ending, edited\./g)).toHaveLength(1);
        expect(context.messageCount).toBe(1);
        expect(context.swipeCount).toBe(1);
    });

    test('explicit alternatives can be shared with other messages, even when hidden', async () => {
        chat[0].is_system = true;
        chat.push({ name: 'User', is_user: true, mes: 'Compare the pacing.' });
        const context = await buildContext({ source: currentSource(), settings: { picked: ['0:swipe:2', '1'] } });
        expect(context.text).toContain('[swipe 3 of 3; alternative] (hidden)');
        expect(context.text).toContain('Compare the pacing.');
        expect(context.text).not.toContain('The current ending, edited.');
        expect(context.messageCount).toBe(2);
    });

    test('scans the selected swipe for lore keywords without sharing unselected alternatives', async () => {
        chat[0].swipes[0] = 'The lighthouse ending.';
        const ordinary = await buildContext({ source: currentSource(), settings });
        expect(ordinary.lore.entries.some(entry => entry.included)).toBe(false);
        const comparison = await buildContext({ source: currentSource(), settings: { ...settings, picked: ['0:swipe:0'] } });
        expect(comparison.lore.entries.some(entry => entry.included)).toBe(true);
        expect(comparison.text).not.toContain('The surprise ending.');
    });

    test('missing swipe picks never fall back to sharing recent messages', async () => {
        const context = await buildContext({ source: currentSource(), settings: { depth: 15, picked: ['0:swipe:8'] } });
        expect(context.messageCount).toBe(0);
        expect(context.text).not.toContain('The current ending, edited.');
        expect(context.picked).toBe(true);
    });
});

describe('Scratchpad source context', () => {
    test('renaming a protected Roleplay chat changes its label and migration hint, not its identity', () => {
        conversationState.conversationWorkspaceOpen = false;
        getRoleplaySourceId.mockReturnValue('11111111-2222-3333-4444-555555555555');
        const source = currentSource();
        expect(source.key).toBe('roleplay:11111111-2222-3333-4444-555555555555');
        expect(source.legacyKey).toBe('character:Roleplay.png:chat');
        expect(getRoleplaySourceId).toHaveBeenCalledWith({ group: false, avatar: 'Roleplay.png', chat: 'chat' });
        chatId = 'Renamed chat';
        expect(currentSource().key).toBe(source.key);
        expect(currentSource().label).toContain('Renamed chat');
        expect(isCurrentSource(source)).toBe(true);
        expect(wireSource(currentSource()).legacyKey).toBe('character:Roleplay.png:Renamed chat');
        getRoleplaySourceId.mockReturnValue('66666666-2222-3333-4444-555555555555');
        expect(isCurrentSource(source)).toBe(false);
    });

    test('a not-yet-protected Roleplay chat keeps its original filename key', () => {
        conversationState.conversationWorkspaceOpen = false;
        expect(wireSource(currentSource())).toEqual({ kind: 'roleplay', key: 'character:Roleplay.png:chat', label: 'Roleplay - chat' });
    });

    test('note-only discussions never borrow the open story, persona, characters or lore', async () => {
        setNotebookSource({ notebookId: 'nb', noteId: 'note', title: 'Saved plan' });
        const source = currentSource();
        expect(source).toMatchObject({ kind: 'notebook', key: 'notebook:nb:note', label: 'Saved plan' });
        const context = await buildContext({ source, settings });
        expect(sourceMessages(source)).toEqual([]);
        expect(sourceCharacters(source)).toEqual([]);
        expect(context.text).not.toMatch(/lighthouse|Nova|Roleplay persona|Conversation persona|Roleplay lore/i);
        expect(context.capabilities).toMatchObject({ lore: false, character: false, chat: false });
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });
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
