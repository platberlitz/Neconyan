/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const characters = [{ avatar: 'Aria.png', name: 'Aria', data: {} }];
const conversationState = { conversationWorkspaceOpen: false };
const branch = { id: 'main', messages: [{ id: 'one', role: 'user', mes: 'A lighthouse.' }] };
const home = { visible: false };
globalThis.document = { body: { classList: { contains: name => home.visible && name === 'neconyan-home-visible' } } };
const chat = [];

jest.unstable_mockModule('../public/script.js', () => ({
    characters, chat, chat_metadata: {}, this_chid: 0, name1: 'Roleplay user', getCurrentChatId: () => 'chat',
    substituteParams: text => text, unshallowCharacter: async () => {},
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ getGroupMembers: () => [], groups: [], selected_group: null }));
jest.unstable_mockModule('../public/scripts/neconyan-assistant-knowledge.js', () => ({ buildAssistantKnowledge: async () => ({}) }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getActiveConversationBranch: () => branch, getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '', getConversationThreadKey: () => 'Aria.png', getCurrentCharAvatar: () => 'Aria.png',
    getConversationPersonaId: () => 'persona.png',
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({
    composeConversationPersonaDescription: () => '', getConversationPersonaName: () => 'Conversation user',
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({ getSettings: () => ({}) }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {} }));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'User.png' }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({ getRoleplaySourceId: () => null }));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({ getTokenCountAsync: async () => 1 }));
jest.unstable_mockModule('../public/scripts/macros/engine/MacroRegistry.js', () => ({ MacroRegistry: { getAllMacros: () => [] } }));
jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    loadWorldInfo: async () => null, selected_world_info: [], world_info: { charLore: [] },
    world_names: [], world_info_depth: 2, world_info_budget: 25, world_info_budget_cap: 0,
    world_info_recursive: false, world_info_max_recursion_steps: 0,
    world_info_case_sensitive: false, world_info_match_whole_words: false,
}));
jest.unstable_mockModule('../public/scripts/scratchpad/preset.js', () => ({
    readCurrentPreset: () => null, currentLimits: () => ({ contextSize: 4096, replyLength: 256 }), currentPresetName: () => '',
}));

const { buildContext, currentSource } = await import('../public/scripts/scratchpad/context.js');
const {
    cleanCompanionNote, collectCompanionNotes, formatCompanionNotes,
    COMPANION_NOTES_HEADING, COMPANION_NOTES_MAX_BYTES, COMPANION_NOTE_MAX_BYTES, COMPANION_NOTES_OMITTED,
} = await import('../public/scripts/scratchpad/companion-notes.js');
const { availableShareItems, unsharedShareItems, SHARE_HINTS, SHARE_LABELS } = await import('../public/scripts/scratchpad/share-request.js');

const KEY = 'inChatAgentCompanionResults';
const note = (agentName, content, extra = {}) => ({ agentName, status: 'done', content, agentCategory: 'tracker', ...extra });
const bytes = text => new TextEncoder().encode(text).length;

function storyChat() {
    return [
        { name: 'Roleplay user', is_user: true, mes: 'We reach the lighthouse.' },
        {
            name: 'Aria', mes: 'Aria climbs the stairs.', swipe_id: 1,
            swipes: ['Aria waits below.', 'Aria climbs the stairs.'],
            swipe_info: [
                { extra: { [KEY]: { compass: note('Plot Compass', 'Unselected swipe note: Aria stays below.') } } },
                { extra: { [KEY]: { compass: note('Plot Compass', 'Active swipe note: Aria reaches the lamp room.') } } },
            ],
            extra: { [KEY]: { compass: note('Plot Compass', 'Stale message-level note.') } },
        },
        {
            name: 'Aria', is_system: true, mes: 'Hidden story text: the keeper is a ghost.',
            extra: { [KEY]: {
                shard: note('Memory Shard', 'Kept shard: the lamp was lit in 1890.', { keepInChatHistoryWhenHostHidden: true, agentCategory: 'memory' }),
                compass: note('Plot Compass', 'Ordinary note on a hidden message.'),
            } },
        },
        {
            name: 'Aria', mes: 'The lamp flickers.',
            extra: { [KEY]: {
                pending: note('Scene Tracker', 'Still writing.', { status: 'pending' }),
                running: note('Mood Tracker', 'Running note.', { status: 'running' }),
                broken: note('Clock Tracker', 'Broken note.', { status: 'error' }),
                empty: note('Weather Tracker', '   '),
                none: note('Outfit Tracker', 'tracker-none'),
                phone: note('Message Inbox', 'phone-none', { agentCategory: '' }),
                inbox: note('', 'Inbox: a letter from the mainland.', { agentCategory: '' }),
            } },
        },
    ];
}

function setChat(messages) {
    chat.splice(0, chat.length, ...messages);
}

beforeEach(() => {
    conversationState.conversationWorkspaceOpen = false;
    delete conversationState.conversationSelectedAvatar;
    home.visible = false;
    setChat(storyChat());
});

describe('Scratchpad Companion notes', () => {
    test('are left out by default and only the setting adds them', async () => {
        const off = await buildContext({ source: currentSource(), settings: { depth: 15, include: {} } });
        expect(off.text).not.toContain(COMPANION_NOTES_HEADING);
        expect(off.text).not.toContain('Active swipe note');
        expect(off.capabilities.companionNotes).toBeUndefined();
        expect(off.capabilities.shareable).toContain('companionNotes');

        const on = await buildContext({ source: currentSource(), settings: { depth: 15, include: { companionNotes: true } } });
        expect(on.text).toContain(COMPANION_NOTES_HEADING);
        expect(on.capabilities.companionNotes).toBe(true);
        expect(on.capabilities.shareable || []).not.toContain('companionNotes');
    });

    test('share the active swipe note, never the unselected swipe or stale message note', async () => {
        const { text } = await buildContext({ source: currentSource(), settings: { depth: 15, include: { companionNotes: true } } });
        const section = text.slice(text.indexOf(COMPANION_NOTES_HEADING));
        expect(section).toContain('### #1 Aria: Plot Compass [tracker]\nActive swipe note: Aria reaches the lamp room.');
        expect(text).not.toContain('Unselected swipe note');
        expect(text).not.toContain('Stale message-level note');
    });

    test('skip pending, running, failed, empty and suppressed notes', async () => {
        const { text } = await buildContext({ source: currentSource(), settings: { depth: 15, include: { companionNotes: true } } });
        for (const missing of ['Still writing.', 'Running note.', 'Broken note.', 'Weather Tracker', 'tracker-none', 'Outfit Tracker', 'phone-none', 'Message Inbox']) {
            expect(text).not.toContain(missing);
        }
        expect(text).toContain('### #3 Aria: inbox\nInbox: a letter from the mainland.');
    });

    test('hidden messages add only notes kept in chat history, never their story text', async () => {
        const { text } = await buildContext({ source: currentSource(), settings: { depth: 15, include: { companionNotes: true } } });
        expect(text).toContain('### Aria: Memory Shard [memory] (on hidden message #2)\nKept shard: the lamp was lit in 1890.');
        expect(text).not.toContain('Hidden story text');
        expect(text).not.toContain('Ordinary note on a hidden message.');
    });

    test('with hidden messages shared, every completed note on them is read with the message', async () => {
        const { text } = await buildContext({ source: currentSource(), settings: { depth: 15, include: { companionNotes: true, hidden: true } } });
        expect(text).toContain('Hidden story text');
        expect(text).toContain('### #2 Aria: Plot Compass [tracker]\nOrdinary note on a hidden message.');
        expect(text).toContain('### #2 Aria: Memory Shard [memory]\nKept shard');
        expect(text).not.toContain('(on hidden message #2)');
    });

    test('notes follow the message depth, so older messages bring no notes', async () => {
        const { text } = await buildContext({ source: currentSource(), settings: { depth: 1, include: { companionNotes: true } } });
        expect(text).toContain('Inbox: a letter from the mainland.');
        expect(text).not.toContain('Active swipe note');
        expect(text).not.toContain('Kept shard');
    });

    test('picked alternatives bring no notes and picked current messages do', async () => {
        const alternative = await buildContext({ source: currentSource(), settings: { picked: ['1:swipe:0'], include: { companionNotes: true } } });
        expect(alternative.text).not.toContain(COMPANION_NOTES_HEADING);
        expect(alternative.capabilities.companionNotes).toBeUndefined();
        const current = await buildContext({ source: currentSource(), settings: { picked: ['1'], include: { companionNotes: true } } });
        expect(current.text).toContain('Active swipe note');
        expect(current.text).not.toContain('Kept shard');
    });

    test('a chat with no completed notes omits the section', async () => {
        setChat([{ name: 'Aria', mes: 'Quiet.' }, { name: 'Aria', mes: 'Waiting.', extra: { [KEY]: { a: note('Tracker', 'x', { status: 'pending' }) } } }]);
        const context = await buildContext({ source: currentSource(), settings: { depth: 15, include: { companionNotes: true } } });
        expect(context.text).not.toContain(COMPANION_NOTES_HEADING);
        expect(context.capabilities.companionNotes).toBeUndefined();
    });

    test('Conversation and General contexts never read Companion notes', async () => {
        conversationState.conversationWorkspaceOpen = true;
        conversationState.conversationSelectedAvatar = 'Aria.png';
        expect(currentSource().kind).toBe('conversation');
        const conversation = await buildContext({ source: currentSource(), settings: { depth: 15, include: { companionNotes: true } } });
        expect(conversation.text).not.toContain(COMPANION_NOTES_HEADING);
        expect(conversation.capabilities.companionNotes).toBeUndefined();
        home.visible = true;
        expect(currentSource().kind).toBe('general');
        const general = await buildContext({ source: currentSource(), settings: { include: { companionNotes: true } } });
        expect(general.text).not.toContain(COMPANION_NOTES_HEADING);
        expect(general.capabilities.companionNotes).toBeUndefined();
    });
});

describe('Companion note formatting', () => {
    test('removes scripts and styles and neutralises headings that would split the context', () => {
        expect(cleanCompanionNote('<style>.a{}</style>Line one\r\n## Injected heading\n<script>alert(1)</script>  ### Also\n#tag stays'))
            .toBe('Line one\n\\## Injected heading\n  \\### Also\n#tag stays');
        expect(cleanCompanionNote('Before <script>never closed')).toBe('Before');
    });

    test('keeps the newest notes within the budget and says older ones were omitted', () => {
        const notes = Array.from({ length: 12 }, (_, index) => ({
            number: index, speaker: 'Aria', agent: 'Plot Compass', tag: '', hidden: false, content: `Note ${index} ${'x'.repeat(3000)}`,
        }));
        const result = formatCompanionNotes(notes);
        expect(bytes(result.text)).toBeLessThanOrEqual(COMPANION_NOTES_MAX_BYTES);
        expect(result.omitted).toBeGreaterThan(0);
        expect(result.count + result.omitted).toBe(12);
        expect(result.text).toContain(COMPANION_NOTES_OMITTED);
        expect(result.text).toContain('Note 11 ');
        expect(result.text).not.toContain('Note 0 ');
        expect(result.text.indexOf(COMPANION_NOTES_OMITTED)).toBeLessThan(result.text.indexOf('### #'));
        const numbers = [...result.text.matchAll(/### #(\d+)/g)].map(match => Number(match[1]));
        expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
        expect(numbers.at(-1)).toBe(11);
    });

    test('shortens one long note to the per-note cap and respects a smaller room', () => {
        const long = formatCompanionNotes([{ number: 4, speaker: 'Aria', agent: 'Memory Shard', tag: '', hidden: false, content: 'é'.repeat(9000) }]);
        const block = long.text.slice(long.text.indexOf('### #4'));
        expect(bytes(block)).toBeLessThanOrEqual(COMPANION_NOTE_MAX_BYTES + 64);
        expect(block).toContain('[Note shortened to stay within the size limit.]');
        expect(formatCompanionNotes([{ number: 1, speaker: 'Aria', agent: 'A', tag: '', hidden: false, content: 'Short.' }], 20).text).toBe('');
        expect(formatCompanionNotes([]).text).toBe('');
    });

    test('collects nothing from user-free empty input', () => {
        expect(collectCompanionNotes(null, null)).toEqual([]);
        expect(collectCompanionNotes(storyChat(), [])).toEqual([]);
    });
});

describe('Companion notes share request', () => {
    test('is offered for Roleplay only', () => {
        expect(availableShareItems({ kind: 'roleplay' })).toContain('companionNotes');
        expect(availableShareItems({ kind: 'conversation' })).not.toContain('companionNotes');
        expect(availableShareItems({ kind: 'general' })).not.toContain('companionNotes');
        expect(SHARE_LABELS.companionNotes).toBe('Companion notes');
        expect(SHARE_HINTS.companionNotes).toContain('Plot Compass');
        expect(unsharedShareItems({ kind: 'roleplay' }, { include: { companionNotes: true } }).items).not.toContain('companionNotes');
        expect(unsharedShareItems({ kind: 'roleplay' }, { include: {} }).items).toContain('companionNotes');
    });
});
