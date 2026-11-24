/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const characters = [
    { avatar: 'Roleplay.png', name: 'Roleplay', data: { extensions: { world: 'Roleplay lore' } } },
    { avatar: 'Nova.png', name: 'Nova', data: { description: '{{char}} talks to {{user}}.', extensions: { world: 'Nova lore' } } },
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
jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({
    composeConversationPersonaDescription: () => '{{user}} is a Conversation persona with {{char}}.', getConversationPersonaName: () => 'Conversation user',
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({ getSettings: () => conversationSettings }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user }));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({ get user_avatar() { return persona.id; } }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({ getRoleplaySourceId }));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({ getTokenCountAsync: async () => 1 }));
jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    loadWorldInfo, selected_world_info: ['Global lore'], world_info: { charLore: [] },
    world_names: [], world_info_depth: 2, world_info_budget: 25, world_info_budget_cap: 0,
    world_info_recursive: false, world_info_max_recursion_steps: 0,
    world_info_case_sensitive: false, world_info_match_whole_words: false,
}));
const EVIDENCE_SECTION = '## App evidence\nRecorded by Neconyan itself.\n\n### Neconyan and this device\n- Neconyan 1.0.0';
jest.unstable_mockModule('../public/scripts/scratchpad/evidence-gather.js', () => ({ gatherAppEvidence: async () => EVIDENCE_SECTION }));
const itemizedByChat = new Map();
const readItemizedPromptsForChat = jest.fn(async id => itemizedByChat.get(id) || []);
jest.unstable_mockModule('../public/scripts/itemized-prompts.js', () => ({ readItemizedPromptsForChat }));
let serverPrompt = null;
const readLastPrompt = jest.fn(async () => ({ prompt: serverPrompt }));
jest.unstable_mockModule('../public/scripts/scratchpad/api.js', () => ({ readLastPrompt }));
const presetSnapshot = {
    kind: 'chat', api: 'Chat Completion', name: 'Lantern', targets: [],
    modules: [
        { id: 'main', name: 'Main Prompt', enabled: true, marker: false, role: 'system', depth: null, content: 'Write {{char}}\'s next reply.' },
        { id: 'chatHistory', name: 'Chat History', enabled: true, marker: true, role: '', depth: null, content: '' },
    ],
    values: { contextSize: 4096, replyLength: 256, continuePrefill: false, samplers: [{ key: 'temperature', label: 'Temperature', value: 1 }] },
    connection: { source: 'openai', sourceLabel: 'OpenAI', model: 'test-model', modelContext: 8192 },
};
const readCurrentPreset = jest.fn(() => presetSnapshot);
jest.unstable_mockModule('../public/scripts/scratchpad/preset.js', () => ({ readCurrentPreset, currentLimits: () => ({ contextSize: 4096, replyLength: 256 }), currentPresetName: () => presetSnapshot.name }));

const { buildContext, currentSource, clearHomePersonaChoice } = await import('../public/scripts/scratchpad/context.js');
const settings = { depth: 15, include: { lore: true, card: true, persona: true, preset: true } };

beforeEach(() => {
    conversationState.conversationWorkspaceOpen = true;
    avatar = 'Nova.png';
    home.visible = false;
    clearHomePersonaChoice();
    persona.id = 'User.png';
    power_user.persona_description = 'Roleplay persona';
    delete power_user.persona_descriptions;
    delete power_user.default_persona;
    delete power_user.personas;
    delete chatMetadata.persona;
    groupId = '';
    chatId = 'chat';
    getRoleplaySourceId.mockReset().mockReturnValue(null);
    itemizedByChat.clear();
    readItemizedPromptsForChat.mockClear();
    readLastPrompt.mockClear();
    serverPrompt = null;
    loadWorldInfo.mockImplementation(async name => books.get(name));
    characters.splice(0, characters.length, ...structuredClone([
        { avatar: 'Roleplay.png', name: 'Roleplay', data: { extensions: { world: 'Roleplay lore' } } },
        { avatar: 'Nova.png', name: 'Nova', data: { description: '{{char}} talks to {{user}}.', extensions: { world: 'Nova lore' } } },
    ]));
    fullCards.clear();
    unshallowCharacter.mockClear();
    chat.length = 0;
    books.clear();
    for (const name of ['Roleplay lore', 'Chat lore', 'Nova lore', 'Persona lore', 'Global lore']) {
        books.set(name, { entries: { 0: { uid: 0, comment: name, key: ['lighthouse'], content: `${name}: {{char}} and {{user}}.` } } });
    }
});

const ROLEPLAY_EXPECTED = `Chat: Roleplay - chat
Mode: Roleplay
User: Roleplay user

## Roleplay user (the user's persona)
Roleplay persona

Character cards follow in full, exactly as saved. Macros such as {{char}} and {{user}} are left in place; {{char}} means that card's character. Field keys are shown in [brackets].

## Character: Roleplay
Linked lorebook: Roleplay lore
Talkativeness: 0.5 [extensions.talkativeness]
Favourite: false [extensions.fav]
Character's note depth [extensions.depth_prompt.depth]: 4
Character's note role [extensions.depth_prompt.role]: system

## Lorebooks
Lorebooks active in this chat: Roleplay lore, Global lore, Persona lore, Chat lore

### Roleplay lore
book: Roleplay lore | uid: 0 | keys: lighthouse
Roleplay lore: Roleplay and Roleplay user.

### Global lore
book: Global lore | uid: 0 | keys: lighthouse
Global lore: Roleplay and Roleplay user.

### Persona lore
book: Persona lore | uid: 0 | keys: lighthouse
Persona lore: Roleplay and Roleplay user.

### Chat lore
book: Chat lore | uid: 0 | keys: lighthouse
Chat lore: Roleplay and Roleplay user.

## Current preset: Lantern

API: Chat Completion | Modules: 2 on, 0 off

This is the generation preset, shared separately from the character cards, persona and lorebooks. Modules are listed in prompt order and marked [on] or [off]; only [on] modules are sent when the story generates. Text is exactly as saved, macros included. A slot is a placeholder the app fills from elsewhere, not preset text.

### [on] Main Prompt (system)
Module ID: main
Write {{char}}'s next reply.

### [on] Chat History (slot, filled from the chat messages)
Module ID: chatHistory

## Latest messages (1 of 1)

#0 Roleplay:
A lighthouse.`;
const GENERAL_EXPECTED = `General Scratchpad: no story chat is open. No story messages, Author's Note or chat metadata is shared. One lorebook was shared by hand for this session. It and any selected character card are reference material, not a live story.
The equipped preset below is reference material only. It does not control this discussion.
User: Roleplay user

## Lorebooks
Lorebook shared by hand for this session: Persona lore

## Current preset: Lantern

API: Chat Completion | Modules: 2 on, 0 off

This is the generation preset, shared separately from the character cards, persona and lorebooks. Modules are listed in prompt order and marked [on] or [off]; only [on] modules are sent when the story generates. Text is exactly as saved, macros included. A slot is a placeholder the app fills from elsewhere, not preset text.

### [on] Main Prompt (system)
Module ID: main
Write {{char}}'s next reply.

### [on] Chat History (slot, filled from the chat messages)
Module ID: chatHistory`;

describe('Scratchpad shared context without Problem checks is unchanged', () => {
    test('Roleplay with a card, lorebooks and a preset keeps the exact text', async () => {
        conversationState.conversationWorkspaceOpen = false;
        chat.push({ name: 'Roleplay', mes: 'A lighthouse.', is_user: true });
        const context = await buildContext({ source: currentSource(), settings });
        expect(context.text).toBe(ROLEPLAY_EXPECTED);
    });

    test('General with a hand-shared lorebook and a preset keeps the exact text', async () => {
        home.visible = true;
        conversationState.conversationWorkspaceOpen = false;
        chatId = '';
        const context = await buildContext({ source: currentSource(), settings: { depth: 0, lorebook: 'Persona lore', include: { card: false, persona: false, preset: true } } });
        expect(context.text).toBe(GENERAL_EXPECTED);
    });
});

describe('Scratchpad shared context with App diagnostics', () => {
    test('the switch off, missing or set to anything but true keeps the exact text and capabilities', async () => {
        conversationState.conversationWorkspaceOpen = false;
        chat.push({ name: 'Roleplay', mes: 'A lighthouse.', is_user: true });
        const plain = await buildContext({ source: currentSource(), settings });
        for (const appEvidence of [false, undefined, 'yes', 1]) {
            const other = await buildContext({ source: currentSource(), settings: { ...settings, include: { ...settings.include, appEvidence } } });
            expect(other.text).toBe(plain.text);
            expect(other.capabilities).toEqual(plain.capabilities);
        }
        expect(plain.text).toBe(ROLEPLAY_EXPECTED);
        expect(plain.capabilities.appEvidence).toBeUndefined();
        expect(plain.text).not.toContain('App evidence');
    });

    test('the switch on adds one headed section and flags the capability, and nothing else changes', async () => {
        conversationState.conversationWorkspaceOpen = false;
        chat.push({ name: 'Roleplay', mes: 'A lighthouse.', is_user: true });
        const plain = await buildContext({ source: currentSource(), settings });
        const shared = await buildContext({ source: currentSource(), settings: { ...settings, include: { ...settings.include, appEvidence: true } } });
        expect(shared.capabilities).toEqual({ ...plain.capabilities, appEvidence: true });
        expect(shared.text.match(/^## App evidence$/gm)).toHaveLength(1);
        expect(shared.text.replace(`\n\n${EVIDENCE_SECTION}`, '')).toBe(plain.text);
        expect(shared.text.indexOf('## App evidence')).toBeLessThan(shared.text.indexOf('A lighthouse.'));
    });
});

describe('Scratchpad shared context with Last prompt sent', () => {
    const HIDDEN = 'The Moonvault key is buried under {{char}}\'s third lantern, and {{user}} must never learn it.';
    const sentPrompt = [
        { role: 'system', content: 'Write Roleplay\'s next reply in the lighthouse story.' },
        { role: 'system', content: 'THE MOONVAULT KEY IS BURIED UNDER ROLEPLAY\'S THIRD LANTERN, AND ROLEPLAY USER MUST NEVER LEARN IT.' },
        { role: 'user', name: 'Roleplay user', content: 'A lighthouse. My key is sk-proj-Abc123def456ghi789jkl0.' },
    ];
    const roleplayChat = () => {
        conversationState.conversationWorkspaceOpen = false;
        chat.push({ name: 'Roleplay', mes: 'A lighthouse.', is_user: true });
        books.get('Global lore').entries[1] = { uid: 1, comment: 'Vault', key: ['vault'], content: HIDDEN, agentBlacklisted: true };
        itemizedByChat.set('chat', [
            { mesId: 1, rawPrompt: 'An older prompt.', main_api: 'textgenerationwebui', recordedAt: 2000 },
            { mesId: 0, rawPrompt: sentPrompt, main_api: 'openai', presetName: 'Lantern', this_max_context: 8192, recordedAt: 3000 },
        ]);
    };

    test('the switch off, missing or set to anything but true keeps the exact text and reads no prompt', async () => {
        roleplayChat();
        const plain = await buildContext({ source: currentSource(), settings });
        for (const lastPrompt of [false, undefined, 'yes', 1]) {
            const other = await buildContext({ source: currentSource(), settings: { ...settings, include: { ...settings.include, lastPrompt } } });
            expect(other.text).toBe(plain.text);
            expect(other.capabilities).toEqual(plain.capabilities);
        }
        expect(plain.capabilities.lastPrompt).toBeUndefined();
        expect(plain.text).not.toContain('Last prompt sent');
        expect(readItemizedPromptsForChat).not.toHaveBeenCalled();
        expect(readLastPrompt).not.toHaveBeenCalled();
    });

    test('the switch on shares the newest prompt for this chat with the hidden entry and key removed', async () => {
        roleplayChat();
        const plain = await buildContext({ source: currentSource(), settings });
        const shared = await buildContext({ source: currentSource(), settings: { ...settings, include: { ...settings.include, lastPrompt: true } } });
        expect(readItemizedPromptsForChat).toHaveBeenCalledWith('chat');
        expect(shared.capabilities).toEqual({ ...plain.capabilities, lastPrompt: true });
        const section = shared.text.slice(shared.text.indexOf('## Last prompt sent'), shared.text.indexOf('## Latest messages'));
        expect(shared.text.match(/^## Last prompt sent$/gm)).toHaveLength(1);
        expect(section).toContain('Mode: Roleplay, Chat Completion');
        expect(section).toContain('Preset: Lantern');
        expect(section).toContain('Write Roleplay\'s next reply in the lighthouse story.');
        expect(section).toContain('[hidden lorebook entry omitted]');
        expect(section).toContain('Hidden lorebook entries were omitted.');
        expect(shared.text.toLowerCase()).not.toContain('moonvault');
        expect(shared.text).not.toContain('sk-proj-Abc123def456ghi789jkl0');
        expect(section).not.toContain('An older prompt.');
        expect(shared.text.replace(/\n\n## Last prompt sent[\s\S]*?(?=\n\n## Latest messages)/, '')).toBe(plain.text);
    });

    test('a newer server prompt for the same chat wins, and a chat with no prompt says so', async () => {
        roleplayChat();
        serverPrompt = { recordedAt: 5000, origin: 'server', mode: 'roleplay', api: 'openai', prompt: [{ role: 'system', content: 'Server durable prompt.' }] };
        const newer = await buildContext({ source: currentSource(), settings: { ...settings, include: { ...settings.include, lastPrompt: true } } });
        expect(newer.text).toContain('Server durable prompt.');
        expect(newer.text).not.toContain('Write Roleplay\'s next reply');
        chatId = 'other-chat';
        serverPrompt = null;
        const empty = await buildContext({ source: currentSource(), settings: { ...settings, include: { ...settings.include, lastPrompt: true } } });
        expect(readItemizedPromptsForChat).toHaveBeenLastCalledWith('other-chat');
        expect(empty.text).toContain('## Last prompt sent\nNo prompt has been sent in this chat yet');
        expect(empty.text).not.toContain('lighthouse story');
        expect(empty.capabilities.lastPrompt).toBeUndefined();
    });

    test('a lorebook that cannot be read keeps the prompt out', async () => {
        roleplayChat();
        loadWorldInfo.mockImplementation(async name => {
            if (name === 'Global lore') throw new Error('offline');
            return books.get(name);
        });
        const shared = await buildContext({ source: currentSource(), settings: { ...settings, include: { ...settings.include, lastPrompt: true, lore: false } } });
        expect(shared.text).toContain('left the last prompt out to keep hidden entries private');
        expect(shared.text).not.toContain('lighthouse story');
        expect(shared.capabilities.lastPrompt).toBeUndefined();
    });

    test('Conversation reads the server prompt for its branch, and General never shares one', async () => {
        conversationState.conversationSelectedAvatar = 'Nova.png';
        serverPrompt = { recordedAt: 4000, origin: 'server', mode: 'conversation', api: 'openai', speaker: 'Nova', prompt: [{ role: 'system', content: 'Conversation system prompt.' }, { role: 'user', content: 'Hi Nova.' }] };
        const conversation = await buildContext({ source: currentSource(), settings: { ...settings, include: { ...settings.include, lastPrompt: true } } });
        expect(readLastPrompt.mock.calls.at(-1)[0]).toMatchObject({ kind: 'conversation' });
        expect(readItemizedPromptsForChat).not.toHaveBeenCalled();
        expect(conversation.text).toContain('Mode: Conversation, Chat Completion');
        expect(conversation.text).toContain('Conversation system prompt.');
        expect(conversation.capabilities.lastPrompt).toBe(true);
        readLastPrompt.mockClear();
        delete conversationState.conversationSelectedAvatar;
        home.visible = true;
        conversationState.conversationWorkspaceOpen = false;
        chatId = '';
        const general = await buildContext({ source: currentSource(), settings: { depth: 0, include: { card: false, persona: false, preset: true, lastPrompt: true } } });
        expect(general.text).not.toContain('Last prompt sent');
        expect(general.capabilities.lastPrompt).toBeUndefined();
        expect(readLastPrompt).not.toHaveBeenCalled();
    });
});
