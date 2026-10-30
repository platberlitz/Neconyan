/* global globalThis */
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
const persona = { id: 'User.png' };
const home = { visible: false };
globalThis.document = { body: { classList: { contains: () => home.visible } } };
const chat = [];
const chatMetadata = { world_info: 'Chat lore' };
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
    characters, chat, chat_metadata: chatMetadata, this_chid: 0, name1: 'Roleplay user', getCurrentChatId: () => chatId,
    substituteParams: (text, options = {}) => text.replaceAll('{{char}}', options.name2Override || 'Roleplay').replaceAll('{{user}}', options.name1Override || 'Roleplay user')
        .replaceAll('{{lastMessage}}', chat.at(-1)?.mes || ''),
    unshallowCharacter,
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ getGroupMembers: () => characters.slice(1), groups: [], selected_group: null }));
jest.unstable_mockModule('../public/scripts/neconyan-assistant-knowledge.js', () => ({ buildAssistantKnowledge: async () => ({}) }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getActiveConversationBranch: () => branch, getConversationGroupById: () => ({ name: 'Friends', members: ['Nova.png', 'Kit.png'] }),
    getConversationGroupIdForAvatar: () => groupId, getConversationThreadKey: () => avatar, getCurrentCharAvatar: () => avatar,
    getConversationPersonaId: () => 'persona.png',
}));
let conversationPersona = '{{user}} is a Conversation persona with {{char}}.';
jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({
    composeConversationPersonaDescription: () => conversationPersona, getConversationPersonaName: () => 'Conversation user',
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({ getSettings: () => conversationSettings }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user }));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({ get user_avatar() { return persona.id; } }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
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

const { buildContext, collectLore, currentSource, formatPreset, isCurrentSource, wireSource, sameChat, sourceMessages, sourceCharacters, setNotebookSource, MAX_CONTEXT_BYTES } = await import('../public/scripts/scratchpad/context.js');
const settings = { depth: 15, include: { lore: true, card: true, persona: true } };

beforeEach(() => {
    setNotebookSource(null);
    conversationState.conversationWorkspaceOpen = true;
    conversationPersona = '{{user}} is a Conversation persona with {{char}}.';
    avatar = 'Nova.png';
    Object.defineProperty(conversationState, 'conversationSelectedAvatar', { configurable: true, get: () => avatar });
    home.visible = false;
    power_user.persona_description = 'Roleplay persona';
    delete power_user.persona_descriptions;
    delete power_user.default_persona;
    delete power_user.personas;
    delete chatMetadata.persona;
    branch.id = 'main';
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
    books.set('Conversation lore', { entries: { 0: { uid: 0, comment: 'Conversation lore', key: ['lighthouse'],
        content: 'Conversation lore: {{char}} and {{user}}. Hidden: {{lastMessage}}.' } } });
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

    test.each([
        ['while the note is shared', { depth: 2, notes: [{ notebookId: 'nb', noteId: 'note', grantId: 'grant-1' }] }],
        ['after Stop sharing', { depth: 2, notes: [] }],
        ['when the session has no saved notes', { depth: 2 }],
    ])('a note discussion never sends the note title to the model %s', async (state, noteSettings) => {
        setNotebookSource({ notebookId: 'nb', noteId: 'note', title: 'Saved plan' });
        const context = await buildContext({ source: currentSource(), settings: noteSettings });
        expect(context.text).toMatch(/^Notebook discussion\nOnly the explicitly shared notes are included\./);
        expect(JSON.stringify(context)).not.toContain('Saved plan');
    });

    test('a note discussion keeps its title as the label shown to the user and stored with its sessions', () => {
        setNotebookSource({ notebookId: 'nb', noteId: 'note', title: 'Saved plan' });
        const source = currentSource();
        expect(source).toMatchObject({ kind: 'notebook', key: 'notebook:nb:note', label: 'Saved plan' });
        expect(wireSource(source)).toMatchObject({ kind: 'notebook', key: 'notebook:nb:note', label: 'Saved plan' });
    });

    test('Conversation reads its own characters, persona, override and attached books', async () => {
        const context = await buildContext({ source: currentSource(), settings });
        expect(context.lore.books).toEqual(expect.arrayContaining(['Nova lore', 'Conversation lore', 'Extra lore', 'Global lore', 'Persona lore']));
        expect(context.text).not.toMatch(/Roleplay lore|Chat lore|Roleplay persona|Roleplay user/);
        expect(context.text).toContain('Conversation user is a Conversation persona with Nova.');
        expect(context.text).toContain('Nova lore: Nova and Conversation user.');
        expect(context.text).toContain('### Description [description]\n{{char}} talks to {{user}}.');
    });

    test('Conversation persona and lore cannot read the hidden Roleplay chat through macros', async () => {
        chat.push({ name: 'Roleplay', mes: 'HIDDEN-CONVERSATION-MACRO' });
        conversationPersona = '{{user}} is a Conversation persona with {{char}}. Hidden: {{lastMessage}}.';
        const context = await buildContext({ source: currentSource(), settings });
        expect(context.text).toContain('Conversation user is a Conversation persona with Nova. Hidden: {{lastMessage}}.');
        expect(context.text).toContain('Conversation lore: Nova and Conversation user. Hidden: {{lastMessage}}.');
        expect(context.text).not.toContain('HIDDEN-CONVERSATION-MACRO');
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
        await expect(buildContext({ source, settings })).rejects.toThrow('context changed');
    });
});

describe('General Scratchpad context', () => {
    test.each(['chat', 'character'])('Home replaces a hidden %s-locked persona with the account default, including when sharing is off', async lock => {
        home.visible = true;
        power_user.default_persona = 'Default.png';
        power_user.personas = { 'User.png': 'Roleplay user', 'Default.png': 'Account default' };
        power_user.persona_descriptions = { 'User.png': { description: 'HIDDEN-LOCKED-PERSONA', connections: lock === 'character' ? [{ type: 'character', id: 'Roleplay.png' }] : [] },
            'Default.png': { description: 'ACCOUNT-DEFAULT-PERSONA' } };
        power_user.persona_description = 'HIDDEN-LOCKED-PERSONA';
        if (lock === 'chat') chatMetadata.persona = 'User.png';
        const source = currentSource();
        expect(source.personaId).toBe('Default.png');
        const shared = await buildContext({ source, settings });
        expect(shared.text).toContain('ACCOUNT-DEFAULT-PERSONA');
        expect(shared.names.user).toBe('Account default');
        expect(shared.text).not.toMatch(/HIDDEN-LOCKED|Roleplay user/);
        const unshared = await buildContext({ source, settings: { ...settings, include: { ...settings.include, persona: false } } });
        expect(unshared.text).not.toMatch(/HIDDEN-LOCKED|Roleplay user|ACCOUNT-DEFAULT-PERSONA/);
    });

    test.each(['chat', 'character'])('Home omits a hidden %s-locked persona when no default exists, without changing no-chat or chat-list behaviour', async lock => {
        home.visible = true;
        conversationState.conversationWorkspaceOpen = false;
        power_user.persona_descriptions = { 'User.png': { description: 'HIDDEN-LOCKED-PERSONA', connections: lock === 'character' ? [{ type: 'character', id: 'Roleplay.png' }] : [] } };
        power_user.persona_description = 'HIDDEN-LOCKED-PERSONA';
        if (lock === 'chat') chatMetadata.persona = 'User.png';
        const source = currentSource();
        expect(source.personaId).toBe('');
        const hidden = await buildContext({ source, settings });
        expect(hidden.names.user).toBe('User');
        expect(hidden.text).not.toMatch(/HIDDEN-LOCKED|Roleplay user/);
        chatId = '';
        const empty = await buildContext({ source: currentSource(), settings });
        expect(currentSource().personaId).toBe('User.png');
        expect(empty.names.user).toBe('Roleplay user');
        expect(empty.text).toContain('HIDDEN-LOCKED-PERSONA');
        home.visible = false;
        chatId = 'chat';
        const inChat = await buildContext({ source: currentSource(), settings });
        expect(inChat.names.user).toBe('Roleplay user');
        expect(inChat.text).toContain('HIDDEN-LOCKED-PERSONA');
    });
    test.each(['ACCOUNT-PERSONA', undefined])('General uses only the base persona, description=%s, without hidden chat appendices', async description => {
        home.visible = true;
        power_user.persona_descriptions = { 'User.png': { description } };
        power_user.persona_description = 'ACCOUNT-PERSONA\nHIDDEN-METADATA-APPENDIX';
        const result = await buildContext({ source: currentSource(), settings });
        expect(result.text.includes('ACCOUNT-PERSONA')).toBe(Boolean(description));
        expect(result.text).not.toContain('HIDDEN-METADATA-APPENDIX');
    });
    test('General persona substitution cannot read hidden messages through a macro', async () => {
        home.visible = true;
        chat.push({ mes: 'HIDDEN-MACRO-STORY' });
        power_user.persona_description = '{{user}} remembers {{lastMessage}}.';
        const result = await buildContext({ source: currentSource(), settings });
        expect(result.text).toContain('Roleplay user remembers {{lastMessage}}.');
        expect(result.text).not.toContain('HIDDEN-MACRO-STORY');
    });
    test('Home excludes the loaded hidden story, card, lore and preset, while sharing the chosen persona', async () => {
        home.visible = true;
        chat.push({ name: 'Roleplay', mes: 'HIDDEN-STORY', swipes: ['HIDDEN-SWIPE'] });
        const source = currentSource();
        expect(source).toMatchObject({ kind: 'general', key: 'general', contextMode: 'roleplay' });
        expect(source.avatar).toBeUndefined();
        const result = await buildContext({ source, settings: { ...settings, picked: ['0'], include: { ...settings.include, authorsNote: true, preset: true, hidden: true } } });
        expect(result).toMatchObject({ messageCount: 0, swipeCount: 0, totalMessages: 0, picked: false, preset: null,
            lore: { books: [], entries: [] }, capabilities: { chat: false, character: false, lore: false, members: [] } });
        expect(result.text).toContain('General Scratchpad: no story chat is open');
        expect(result.text).toContain('Roleplay persona');
        expect(result.text).not.toMatch(/HIDDEN-|## Character:|Chat lore|Current preset:|Latest messages|Picked messages/);
        expect(loadWorldInfo).not.toHaveBeenCalled();
        expect(sourceMessages(source)).toEqual([]);
    });

    test('plain no-chat and unselected Conversation never borrow the underlying Roleplay card', async () => {
        avatar = '';
        expect(currentSource().avatar).toBeUndefined();
        const result = await buildContext({ source: currentSource(), settings });
        expect(result.text).not.toContain('## Character: Roleplay');
        conversationState.conversationWorkspaceOpen = false;
        chatId = '';
        characters[0] = null;
        expect(currentSource()).toMatchObject({ kind: 'general', key: 'general' });
        expect(sourceCharacters(currentSource())).toEqual([]);
    });

    test('an unavailable Conversation selection without a branch cannot fall back to hidden card persona additions', async () => {
        avatar = 'Deleted.png';
        branch.id = '';
        const source = currentSource();
        expect(source).toMatchObject({ kind: 'general', contextMode: 'roleplay' });
        expect(source.avatar).toBeUndefined();
        const result = await buildContext({ source, settings });
        expect(result.text).not.toMatch(/Conversation persona|## Character: Roleplay/);
    });

    test.each([true, false])('selected no-chat Roleplay card obeys sharing=%s without messages or lore', async card => {
        conversationState.conversationWorkspaceOpen = false;
        chatId = '';
        const source = currentSource();
        expect(source.avatar).toBe('Roleplay.png');
        characters[0].data.description = 'Selected reference.';
        const result = await buildContext({ source, settings: { ...settings, include: { ...settings.include, card } } });
        expect(result.text.includes('Selected reference.')).toBe(card);
        expect(result.capabilities.character).toBe(card);
        expect(result.messageCount).toBe(0);
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });

    test.each([true, false])('Conversation selection without a branch shares only its own persona when enabled=%s', async enabled => {
        branch.id = '';
        const source = currentSource();
        expect(source).toMatchObject({ kind: 'general', avatar: 'Nova.png', contextMode: 'conversation', personaId: 'persona.png' });
        const result = await buildContext({ source, settings: { ...settings, include: { ...settings.include, persona: enabled } } });
        expect(result.names.user).toBe('Conversation user');
        expect(result.text.includes('Conversation user is a Conversation persona with Nova.')).toBe(enabled);
        expect(result.text).not.toMatch(/Roleplay persona|Roleplay lore|A lighthouse/);
    });

    test('wire identity preserves General context, and a changed selection invalidates asynchronous card loading', async () => {
        branch.id = '';
        const source = currentSource();
        expect(wireSource(source)).toEqual(source);
        expect(sameChat(source, { ...source, label: 'Different label' })).toBe(true);
        for (const changed of [{ avatar: 'Kit.png' }, { contextMode: 'roleplay' }, { personaId: 'Other.png' }]) {
            expect(sameChat(source, { ...source, ...changed })).toBe(false);
        }
        characters[1].shallow = true;
        unshallowCharacter.mockImplementationOnce(async () => { avatar = 'Kit.png'; });
        await expect(buildContext({ source, settings })).rejects.toThrow('context changed');
        expect(isCurrentSource(source)).toBe(false);
        expect(currentSource().key).toBe('general');
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

describe('Scratchpad shared context budget', () => {
    const bytes = text => new TextEncoder().encode(text).length;
    const occurrences = (text, body) => text.split(body).length - 1;
    const headCopy = 'The shared context is too large to send. Turn off the persona, character cards, Author\'s Note, lorebooks or preset you do not need, then try again.';
    const depthCopy = 'The selected chat messages are too large to share. Shorten them, pick specific messages, or turn off the persona, character cards, Author\'s Note, lorebooks and preset, then try again.';
    const pickedCopy = 'These picked messages are too large to share. Pick fewer or shorter ones, then try again.';

    test('shares a 20,000-character message whole and never marks a cut', async () => {
        conversationState.conversationWorkspaceOpen = false;
        chat.push({ name: 'Nova', mes: 'A'.repeat(19_993) + 'THE-END' });
        const context = await buildContext({ source: currentSource(), settings: { depth: 1 } });
        expect(chat.at(-1).mes).toHaveLength(20_000);
        expect(context.text).toContain('THE-END');
        expect(context.text).not.toContain('[...]');
        expect(context.messageCount).toBe(1);
        expect(context.leftOut).toBe(0);
    });

    test('fits CJK Conversation messages newest first to the exact byte budget', async () => {
        branch.messages = Array.from({ length: 200 }, (_, index) => ({ id: String(index), role: 'user', mes: '猫'.repeat(16_000) }));
        const context = await buildContext({ source: currentSource(), settings: { depth: 200 } });
        expect(context.messageCount).toBe(29);
        expect(context.leftOut).toBe(171);
        expect(context.totalMessages).toBe(200);
        expect(context.text).toContain('## Latest messages (29 of 200)');
        expect(bytes(context.text)).toBe(1_392_877);
        expect(occurrences(context.text, '猫'.repeat(16_000))).toBe(29);
        const nextOlderLine = '#170 Conversation user:\n' + '猫'.repeat(16_000);
        expect(bytes(context.text) + 2 + bytes(nextOlderLine)).toBeGreaterThan(MAX_CONTEXT_BYTES);
    });

    test('drops the oldest whole Roleplay messages and keeps the newest ones complete', async () => {
        conversationState.conversationWorkspaceOpen = false;
        const body = index => 'M' + index + ':' + 'x'.repeat(250_000) + ':END';
        chat.push(...Array.from({ length: 10 }, (_, index) => ({ name: 'Nova', mes: body(index) })));
        const context = await buildContext({ source: currentSource(), settings: { depth: 10 } });
        expect(context.messageCount).toBe(5);
        expect(context.totalMessages).toBe(10);
        expect(context.leftOut).toBe(5);
        expect(context.text).toContain('## Latest messages (5 of 10)');
        for (const index of [5, 6, 7, 8, 9]) {
            expect(context.text).toContain(body(index));
            expect(occurrences(context.text, body(index))).toBe(1);
        }
        for (const index of [0, 1, 2, 3, 4]) expect(context.text).not.toContain(body(index));
    });

    test('refuses picked messages that cannot all fit and shares a smaller pick whole', async () => {
        conversationState.conversationWorkspaceOpen = false;
        const body = index => 'P' + index + ':' + 'C'.repeat(300_000) + ':END';
        chat.push(...Array.from({ length: 6 }, (_, index) => ({ name: 'Nova', mes: body(index) })));
        const source = currentSource();
        await expect(buildContext({ source, settings: { picked: ['0', '1', '2', '3', '4', '5'] } })).rejects.toThrow(pickedCopy);
        const context = await buildContext({ source, settings: { picked: ['0', '1', '2'] } });
        expect(context.messageCount).toBe(3);
        expect(context.leftOut).toBe(0);
        for (const index of [0, 1, 2]) {
            expect(context.text).toContain(body(index));
            expect(occurrences(context.text, body(index))).toBe(1);
        }
        for (const index of [3, 4, 5]) expect(context.text).not.toContain(body(index));
    });

    test('refuses picked swipe versions that cannot all fit and shares a smaller pick whole', async () => {
        conversationState.conversationWorkspaceOpen = false;
        const swipes = [0, 1, 2].map(index => `V${index}:` + 'D'.repeat(600_000) + ':END');
        chat.push({ name: 'Nova', swipe_id: 1, mes: swipes[1], swipes });
        const source = currentSource();
        await expect(buildContext({ source, settings: { picked: ['0:swipe:0', '0:swipe:1', '0:swipe:2'] } })).rejects.toThrow(pickedCopy);
        const context = await buildContext({ source, settings: { picked: ['0:swipe:0', '0:swipe:1'] } });
        expect(context.messageCount).toBe(1);
        expect(context.swipeCount).toBe(2);
        expect(context.leftOut).toBe(0);
        expect(context.text).toContain('[swipe 1 of 3; alternative]');
        expect(context.text).toContain('[swipe 2 of 3; current]');
        expect(occurrences(context.text, swipes[0])).toBe(1);
        expect(occurrences(context.text, swipes[1])).toBe(1);
        expect(context.text).not.toContain(swipes[2]);
    });

    test('refuses a Conversation head that is too large', async () => {
        characters[1].data.description = 'E'.repeat(1_450_000);
        await expect(buildContext({ source: currentSource(), settings: { depth: 0, include: { card: true } } })).rejects.toThrow(headCopy);
    });

    test('refuses a single Roleplay message that is too large', async () => {
        conversationState.conversationWorkspaceOpen = false;
        chat.push({ name: 'Nova', mes: 'F'.repeat(1_500_000) });
        await expect(buildContext({ source: currentSource(), settings: { depth: 1 } })).rejects.toThrow(depthCopy);
    });

    test('shares no messages at depth 0 and skips hidden messages entirely', async () => {
        conversationState.conversationWorkspaceOpen = false;
        chat.push({ name: 'Nova', mes: 'A short message.' });
        const empty = await buildContext({ source: currentSource(), settings: { depth: 0 } });
        expect(empty.messageCount).toBe(0);
        expect(empty.leftOut).toBe(0);
        expect(empty.text).toContain('## Latest messages (0 of 1)');
        chat.length = 0;
        const hiddenBody = 'H' + 'G'.repeat(199_999);
        chat.push(...Array.from({ length: 10 }, () => ({ name: 'Nova', mes: hiddenBody, is_system: true })));
        chat.push({ name: 'Nova', mes: 'VISIBLE-ONLY', is_user: true });
        const visible = await buildContext({ source: currentSource(), settings: { depth: 2 } });
        expect(visible.messageCount).toBe(1);
        expect(visible.totalMessages).toBe(11);
        expect(visible.leftOut).toBe(0);
        expect(visible.text).toContain('VISIBLE-ONLY');
        expect(visible.text).not.toContain(hiddenBody);
    });

    test('General refuses an oversized card but keeps the notebook path free of the budget check', async () => {
        conversationState.conversationWorkspaceOpen = false;
        home.visible = false;
        chatId = '';
        expect(currentSource()).toMatchObject({ kind: 'general', avatar: 'Roleplay.png' });
        characters[0].data.description = 'E'.repeat(1_450_000);
        const settings = { depth: 0, include: { card: true } };
        await expect(buildContext({ source: currentSource(), settings })).rejects.toThrow(headCopy);
        delete characters[0].data.description;
        const general = await buildContext({ source: currentSource(), settings });
        expect(general.leftOut).toBe(0);
        expect(general.messageCount).toBe(0);
        characters[0].data.description = 'E'.repeat(1_450_000);
        setNotebookSource({ notebookId: 'nb', noteId: 'note', title: 'Saved plan' });
        const notebook = await buildContext({ source: currentSource(), settings });
        expect(notebook.text).toMatch(/^Notebook discussion\n/);
        expect(notebook.leftOut).toBe(0);
        expect(notebook.messageCount).toBe(0);
    });
});
