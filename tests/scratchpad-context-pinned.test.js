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
