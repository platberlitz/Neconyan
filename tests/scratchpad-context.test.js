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
const fullCards = new Map();
const unshallowCharacter = jest.fn(async index => {
    const full = fullCards.get(characters[index]?.avatar);
    if (characters[index]?.shallow && full) characters[index] = structuredClone(full);
});
const originalCharacters = structuredClone(characters);

jest.unstable_mockModule('../public/script.js', () => ({
    characters, chat, chat_metadata: { world_info: 'Chat lore' }, this_chid: 0, name1: 'Roleplay user', getCurrentChatId: () => chatId,
    substituteParams: (text, options = {}) => text.replaceAll('{{char}}', options.name2Override || 'Roleplay').replaceAll('{{user}}', options.name1Override || 'Roleplay user'),
    unshallowCharacter,
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
const presetSnapshot = {
    kind: 'chat', api: 'Chat Completion', name: 'Lantern',
    modules: [
        { id: 'main', name: 'Main Prompt', enabled: true, marker: false, role: 'system', depth: null, content: 'Write {{char}}\'s next reply.' },
        { id: 'charDescription', name: 'Char Description', enabled: true, marker: true, role: '', depth: null, content: '' },
        { id: 'nsfw', name: 'Spice', enabled: false, marker: false, role: 'system', depth: null, content: 'Off module text.' },
        { id: 'reminder', name: 'Reminder', enabled: true, marker: false, role: 'user', depth: 2, content: 'Stay in tense.' },
        { id: 'chatHistory', name: 'Chat History', enabled: true, marker: true, role: '', depth: null, content: '' },
    ],
};
const readCurrentPreset = jest.fn(() => presetSnapshot);
jest.unstable_mockModule('../public/scripts/scratchpad/preset.js', () => ({ readCurrentPreset, currentPresetName: () => presetSnapshot.name }));

const { buildContext, collectLore, currentSource, formatPreset, isCurrentSource, wireSource, sourceMessages, sourceCharacters, setNotebookSource } = await import('../public/scripts/scratchpad/context.js');
const settings = { depth: 15, include: { lore: true, card: true, persona: true } };

beforeEach(() => {
    setNotebookSource(null);
    conversationState.conversationWorkspaceOpen = true;
    avatar = 'Nova.png';
    groupId = '';
    chatId = 'chat';
    getRoleplaySourceId.mockReset().mockReturnValue(null);
    characters.splice(0, characters.length, ...structuredClone(originalCharacters));
    fullCards.clear();
    unshallowCharacter.mockClear();
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
        expect(wireSource(currentSource())).toEqual({ kind: 'roleplay', key: 'character:Roleplay.png:chat', label: 'Roleplay - chat', scope: { kind: 'character', id: 'Roleplay.png' } });
    });

    test('shares a character scope without weakening the exact-chat context guard', () => {
        const first = currentSource();
        branch.id = 'other';
        expect(currentSource().scope).toEqual(first.scope);
        expect(isCurrentSource(first)).toBe(false);
        branch.id = 'main';
    });

    test('picks from another chat cannot select matching message numbers or fall back to recent messages', async () => {
        conversationState.conversationWorkspaceOpen = false;
        chat.push({ name: 'Roleplay', mes: 'Do not share this other scene.' });
        const source = currentSource();
        const result = await buildContext({ source, settings: { depth: 15, picked: ['0'], pickedSource: { kind: 'roleplay', key: 'character:Roleplay.png:other' } } });
        expect(result.messageCount).toBe(0);
        expect(result.picked).toBe(true);
        expect(result.text).not.toContain('Do not share this other scene.');
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
        expect(context.text).toContain('### Description [description]\n{{char}} talks to {{user}}.');
    });

    test('shares every part of a character card whole and exactly as saved', async () => {
        const long = `${'{{char}} remembers the lighthouse. '.repeat(1200)}The final line.`;
        Object.assign(characters[1], {
            tags: ['sea', 'mystery'],
            data: {
                ...characters[1].data,
                creator: 'Ash', character_version: '2.1', description: long,
                personality: 'Patient.', scenario: 'A storm.', first_mes: '{{char}} waves at {{user}}.',
                alternate_greetings: ['Hello again.', 'A quieter hello.'], group_only_greetings: ['Hello, everyone.'],
                mes_example: '<START>\n{{char}}: Hi.', creator_notes: 'Use with care.', system_prompt: 'Stay in voice.',
                post_history_instructions: 'Keep it short.',
                extensions: { ...characters[1].data.extensions, depth_prompt: { prompt: 'Nova hates rain.', depth: 2, role: 'user' } },
            },
        });
        const { text } = await buildContext({ source: currentSource(), settings });
        expect(long.length).toBeGreaterThan(8_000);
        expect(text).toContain(long);
        expect(text).not.toContain('[...]');
        for (const part of [
            'Creator: Ash', 'Version: 2.1', 'Tags [tags]: sea, mystery', 'Linked lorebook: Nova lore', 'Extra lorebooks: Extra lore',
            '### Personality [personality]\nPatient.', '### Scenario [scenario]\nA storm.',
            '### First message [first_mes]\n{{char}} waves at {{user}}.',
            '### Alternate greetings [alternate_greetings] (2)\n\nGreeting 1:\nHello again.\n\nGreeting 2:\nA quieter hello.',
            '### Group-only greetings [group_only_greetings] (1)\n\nGreeting 1:\nHello, everyone.',
            '### Example messages [mes_example]\n<START>\n{{char}}: Hi.', '### Creator\'s notes [creator_notes]\nUse with care.',
            '### System prompt [system_prompt]\nStay in voice.', '### Post-history instructions [post_history_instructions]\nKeep it short.',
            '### Character\'s note (inserted at depth 2 as user)\nNova hates rain.',
        ]) expect(text).toContain(part);
    });

    test('loads lazily loaded group members in full before sharing their cards', async () => {
        groupId = 'friends';
        fullCards.set('Kit.png', { ...characters[2], data: { ...characters[2].data, description: 'Kit keeps the light.', first_mes: 'Kit looks up.' } });
        characters[2] = { avatar: 'Kit.png', name: 'Kit', shallow: true, data: { name: 'Kit', extensions: { world: 'Empty lore' } } };
        const { text } = await buildContext({ source: currentSource(), settings });
        expect(unshallowCharacter).toHaveBeenCalledWith('2');
        expect(text).toContain('## Character: Kit (group member)');
        expect(text).toContain('### Description [description]\nKit keeps the light.');
        expect(text).toContain('### First message [first_mes]\nKit looks up.');
        expect(text).not.toContain('Only part of this card could be loaded');
    });

    test('says so when a lazily loaded card cannot be loaded in full', async () => {
        characters[1] = { ...characters[1], shallow: true };
        const { text } = await buildContext({ source: currentSource(), settings });
        expect(unshallowCharacter).toHaveBeenCalledWith('1');
        expect(text).toContain('Only part of this card could be loaded');
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

describe('Scratchpad current preset', () => {
    beforeEach(() => {
        conversationState.conversationWorkspaceOpen = false;
        characters[0].data.description = 'Roleplay card text.';
        chat.push({ name: 'Roleplay user', is_user: true, mes: 'A lighthouse.' });
        readCurrentPreset.mockClear();
    });

    test('is not shared unless chosen', async () => {
        const result = await buildContext({ source: currentSource(), settings });
        expect(result.text).not.toContain('Current preset');
        expect(result.preset).toBeNull();
        expect(readCurrentPreset).not.toHaveBeenCalled();
    });

    test('shares the preset as its own section, apart from the card, persona and lore', async () => {
        const result = await buildContext({ source: currentSource(), settings: { ...settings, include: { ...settings.include, preset: true } } });
        const { text } = result;
        const section = text.slice(text.indexOf('## Current preset: Lantern'), text.indexOf('## Latest messages'));
        expect(section).toContain('API: Chat Completion | Modules: 4 on, 1 off');
        expect(section).not.toContain('Roleplay card text.');
        expect(section).not.toContain('Roleplay persona');
        expect(section).not.toContain('Roleplay lore:');
        expect(text.indexOf('## Character: Roleplay')).toBeLessThan(text.indexOf('## Current preset'));
        expect(text.indexOf('## Lorebooks')).toBeLessThan(text.indexOf('## Current preset'));
        expect(result.preset).toEqual({ name: 'Lantern', on: 4, off: 1 });
    });

    test('lists every module in order, marks it on or off and leaves its text as saved', () => {
        const text = formatPreset(presetSnapshot);
        const order = ['Main Prompt', 'Char Description', 'Spice', 'Reminder', 'Chat History'].map(name => text.indexOf(`] ${name}`));
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(order.every(index => index > 0)).toBe(true);
        expect(text).toContain('### [on] Main Prompt (system)\nWrite {{char}}\'s next reply.');
        expect(text).toContain('### [off] Spice (system)\nOff module text.');
        expect(text).toContain('### [on] Reminder (user, in chat at depth 2)\nStay in tense.');
        expect(text).toContain('### [on] Char Description (slot, filled from the character card)');
        expect(text).toContain('### [on] Chat History (slot, filled from the chat messages)');
    });

    test('stays out of Conversation chats, which do not use the preset', async () => {
        conversationState.conversationWorkspaceOpen = true;
        const result = await buildContext({ source: currentSource(), settings: { ...settings, include: { ...settings.include, preset: true } } });
        expect(result.text).not.toContain('Current preset');
        expect(readCurrentPreset).not.toHaveBeenCalled();
    });
});
