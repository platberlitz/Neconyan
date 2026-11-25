/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const characters = [
    { avatar: 'Roleplay.png', name: 'Roleplay', description: 'Live description.', creatorcomment: 'Live notes.', data: { description: 'Live description.', creator_notes: 'Live notes.', alternate_greetings: ['Hello there.'], extensions: { world: 'Roleplay lore' } } },
    { avatar: 'Nova.png', name: 'Nova', data: { description: 'Nova as saved.', extensions: { world: 'Nova lore' } } },
];
const conversationState = { conversationWorkspaceOpen: false };
const branch = { id: 'main', messages: [] };
const power_user = {};
const persona = { id: 'User.png' };
globalThis.document = { body: { classList: { contains: () => false } } };
const chat = [];
const chatMetadata = {};
const books = new Map();
const loadWorldInfo = jest.fn(async name => books.get(name));
const originalCharacters = structuredClone(characters);

jest.unstable_mockModule('../public/script.js', () => ({
    characters, chat, chat_metadata: chatMetadata, this_chid: 0, name1: 'Mira', getCurrentChatId: () => 'chat',
    substituteParams: (text, options = {}) => text.replaceAll('{{char}}', options.name2Override || 'Roleplay').replaceAll('{{user}}', options.name1Override || 'Mira'),
    unshallowCharacter: async () => {},
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ getGroupMembers: () => [], groups: [], selected_group: null }));
jest.unstable_mockModule('../public/scripts/neconyan-assistant-knowledge.js', () => ({ buildAssistantKnowledge: async () => ({}) }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getActiveConversationBranch: () => branch, getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '', getConversationThreadKey: () => 'Nova.png', getCurrentCharAvatar: () => 'Nova.png',
    getConversationPersonaId: () => 'persona.png',
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({
    composeConversationPersonaDescription: () => 'Conversation persona.', getConversationPersonaName: () => 'Conversation user',
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({ getSettings: () => ({}) }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user }));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({ get user_avatar() { return persona.id; } }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({ getRoleplaySourceId: () => null }));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({ getTokenCountAsync: async () => 1 }));
jest.unstable_mockModule('../public/scripts/macros/engine/MacroRegistry.js', () => ({ MacroRegistry: { getAllMacros: () => { throw new Error('The registry is unavailable in this test.'); } } }));
jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    loadWorldInfo, selected_world_info: [], world_info: { charLore: [] },
    world_names: [], world_info_depth: 2, world_info_budget: 25, world_info_budget_cap: 0,
    world_info_recursive: false, world_info_max_recursion_steps: 0,
    world_info_case_sensitive: false, world_info_match_whole_words: false,
}));
const presetSnapshot = {
    kind: 'chat', api: 'Chat Completion', name: 'Lantern',
    targets: [{ api: 'openai', name: 'Lantern' }],
    modules: [
        { id: 'main', name: 'Main Prompt', enabled: true, marker: false, role: 'system', depth: null, content: 'Write the next reply.' },
        { id: 'charDescription', name: 'Char Description', enabled: true, marker: true, role: '', depth: null, content: '' },
        { id: 'nsfw', name: 'Spice', enabled: false, marker: false, role: 'system', depth: null, content: 'Off module text.' },
        { id: 'reminder', name: 'Reminder', enabled: true, marker: false, role: 'user', depth: 2, content: 'Stay in tense.' },
    ],
    values: { contextSize: 4096, replyLength: 256, continuePrefill: false, samplers: [] },
    connection: { source: 'openai', sourceLabel: 'OpenAI', model: 'test-model', modelContext: 8192 },
};
jest.unstable_mockModule('../public/scripts/scratchpad/preset.js', () => ({ readCurrentPreset: () => presetSnapshot, currentLimits: () => ({ contextSize: 4096, replyLength: 256 }), currentPresetName: () => presetSnapshot.name }));

const preview = await import('../public/scripts/scratchpad/rehearsal-preview.js');
const { MAX_REHEARSAL_LABEL, REHEARSAL_INSTRUCTIONS, REHEARSAL_REQUEST, normaliseRehearsalLabel } = await import('../public/scripts/scratchpad/rehearsal.js');
const { describeChange } = await import('../public/scripts/scratchpad/proposals.js');
const { buildContext, currentSource, setNotebookSource } = await import('../public/scripts/scratchpad/context.js');
const {
    TRYABLE_CHANGE_TYPES, applyAuthorsNoteChangeToSnapshot, applyCharacterChangeToSnapshot, applyChatChangeToMessages, applyLoreChangeToEntries,
    applyPersonaChangeToSnapshot, applyPresetChangeToSnapshot, buildTryRehearsalRequest, canTryProposalInRehearsal, formatRehearsalChangeNote,
    loreChangeKey, rehearsalChangeKind, rehearsalMessageRef,
} = preview;

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

const frozen = value => deepFreeze(structuredClone(value));

const SOURCES = {
    roleplay: { kind: 'roleplay', id: 'Roleplay.png', chatId: 'chat' },
    conversation: { kind: 'conversation', id: 'Nova.png', branchId: 'main' },
    general: { kind: 'general', id: 'general' },
    notebook: { kind: 'notebook', id: 'notebook-1' },
};

const PROPOSALS = {
    character: { type: 'character', character: 'Roleplay', field: 'description', value: 'New description.', reason: 'r' },
    character_greetings: { type: 'character', character: 'Roleplay', field: 'alternate_greetings', value: ['Hi.'], action: 'append', reason: 'r' },
    character_name: { type: 'character', character: 'Roleplay', field: 'name', value: 'Renamed', reason: 'r' },
    character_tags: { type: 'character', character: 'Roleplay', field: 'tags', value: ['a'], reason: 'r' },
    avatar: { type: 'image', target: 'avatar', prompt: 'A cat.', reason: 'r' },
    new_character: { type: 'character', action: 'create', name: 'Fresh', description: 'New.', reason: 'r' },
    persona: { type: 'persona', persona: 'Mira', field: 'description', value: 'Mira, rewritten.', reason: 'r' },
    persona_avatar: { type: 'persona', persona: 'Mira', field: 'avatar', value: 'x.png', reason: 'r' },
    persona_note: { type: 'persona-note', persona: 'Mira', field: 'description', value: 'Note.', reason: 'r' },
    new_persona: { type: 'persona', action: 'create', name: 'Someone', description: 'New persona.', reason: 'r' },
    authors_note: { type: 'authors-note', action: 'replace', value: 'Keep it tense.', reason: 'r' },
    lore_add: { type: 'lorebook', action: 'add', book: 'Roleplay lore', title: 'Harbour', keys: ['harbour'], content: 'The harbour is quiet.', constant: false, reason: 'r' },
    lore_edit: { type: 'lorebook', action: 'edit', book: 'Roleplay lore', uid: 0, content: 'The lighthouse is dark now.', reason: 'r' },
    lore_toggle: { type: 'lorebook', action: 'edit', book: 'Roleplay lore', uid: 0, disable: true, reason: 'r' },
    lore_delete: { type: 'lorebook', action: 'delete', book: 'Roleplay lore', uid: 0, reason: 'r' },
    preset: { type: 'preset', action: 'replace', api: 'openai', preset: 'Lantern', module: 'main', field: 'content', value: 'Write slowly.', reason: 'r' },
    chat_edit: { type: 'chat', action: 'edit', message: 0, text: 'Rewritten opening.', reason: 'r' },
    chat_insert: { type: 'chat', action: 'insert', after: 0, speaker: 'character', name: 'Roleplay', text: 'Inserted line.', reason: 'r' },
    chat_hide: { type: 'chat', action: 'hide', message: 0, reason: 'r' },
    chat_unhide: { type: 'chat', action: 'unhide', message: 0, reason: 'r' },
    chat_delete: { type: 'chat', action: 'delete', message: 0, reason: 'r' },
    agent: { type: 'agent', action: 'create', name: 'Helper', prompt: 'Help.', reason: 'r' },
    regex: { type: 'regex', action: 'create', name: 'Trim', find: 'a', replace: 'b', reason: 'r' },
    css_snippet: { type: 'css-snippet', action: 'create', name: 'Look', css: '.a{}', reason: 'r' },
    dialogue_colors: { type: 'dialogue-color', action: 'set', character: 'Roleplay', color: 'blue', reason: 'r' },
    mewmory: { type: 'mewmory', action: 'add', text: 'Remember.', reason: 'r' },
    notebook: { type: 'notebook', action: 'add', text: 'Note.', reason: 'r' },
    unknown: { type: 'mystery', value: 'x' },
};

const STORY = ['roleplay', 'conversation'];
const ROLEPLAY = ['roleplay'];
const EXPECTED_MODES = {
    character: STORY, character_greetings: STORY, persona: STORY, lore_add: STORY, lore_edit: STORY, lore_toggle: STORY, lore_delete: STORY,
    authors_note: ROLEPLAY, preset: STORY, chat_edit: STORY, chat_insert: STORY, chat_hide: ROLEPLAY, chat_unhide: ROLEPLAY, chat_delete: STORY,
};

describe('which proposed changes can be tried first', () => {
    test('the allow-list names the six tryable kinds and their modes', () => {
        expect(Object.keys(TRYABLE_CHANGE_TYPES).sort()).toEqual(['authors_note', 'character', 'chat', 'lore', 'persona', 'preset']);
        expect(TRYABLE_CHANGE_TYPES.character.fields).toEqual(['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'alternate_greetings', 'creator_notes']);
        expect(Object.isFrozen(TRYABLE_CHANGE_TYPES)).toBe(true);
    });

    for (const [name, proposal] of Object.entries(PROPOSALS)) {
        for (const [mode, source] of Object.entries(SOURCES)) {
            const expected = (EXPECTED_MODES[name] || []).includes(mode);
            test(`${name} in ${mode} is ${expected ? 'tryable' : 'not tryable'}`, () => {
                expect(canTryProposalInRehearsal(frozen(proposal), source)).toBe(expected);
            });
        }
    }

    test('missing proposals and sources are never tryable', () => {
        expect(canTryProposalInRehearsal(null, SOURCES.roleplay)).toBe(false);
        expect(canTryProposalInRehearsal(PROPOSALS.character, null)).toBe(false);
        expect(rehearsalChangeKind(undefined)).toBe('');
        expect(rehearsalChangeKind(PROPOSALS.lore_edit)).toBe('lore');
    });

    test('field aliases resolve before the allow-list is checked', () => {
        expect(rehearsalChangeKind({ ...PROPOSALS.character, field: 'creatorcomment' })).toBe('character');
        expect(rehearsalChangeKind({ ...PROPOSALS.character, field: 'depth_prompt' })).toBe('');
    });
});

describe('the rehearsal request and label', () => {
    test('names the change in the request', () => {
        expect(buildTryRehearsalRequest('Change Roleplay\'s description')).toBe('Rehearse the next story reply using this unsaved change: Change Roleplay\'s description.');
        expect(buildTryRehearsalRequest('')).toBe('Rehearse the next story reply using this unsaved change.');
        expect(REHEARSAL_REQUEST).toBe('Rehearse the next story reply using the shared context.');
        expect(REHEARSAL_INSTRUCTIONS).not.toContain('unsaved');
    });

    test('labels lose control characters and stop at 160 characters', () => {
        expect(normaliseRehearsalLabel('Edit\u0000 entry\n\t2\u007f in  Book ')).toBe('Edit entry 2 in Book');
        expect(normaliseRehearsalLabel(42)).toBe('');
        const long = normaliseRehearsalLabel('x'.repeat(400));
        expect(long).toHaveLength(MAX_REHEARSAL_LABEL);
        expect(long.endsWith('…')).toBe(true);
    });

    test('the context note names the change and what it applies to', () => {
        expect(formatRehearsalChangeNote('Change the Author\'s Note', 'the Author\'s Note')).toBe([
            '## Unsaved change under rehearsal',
            'Change: Change the Author\'s Note',
            'Applies to: the Author\'s Note',
            'The context below already shows this change in place. It has not been saved; rehearse the next story reply as if it were.',
        ].join('\n'));
        expect(formatRehearsalChangeNote('', '')).toContain('Change: Proposed change');
    });
});

describe('overlays leave their inputs untouched', () => {
    const person = frozen(characters[0]);

    test('character text fields, with the edited draft winning over the proposal', () => {
        const proposal = frozen(PROPOSALS.character);
        const shown = applyCharacterChangeToSnapshot(person, proposal);
        expect(shown).not.toBe(person);
        expect(shown.data.description).toBe('New description.');
        expect(shown.description).toBe('New description.');
        expect(shown.data.extensions).toBe(person.data.extensions);
        expect(applyCharacterChangeToSnapshot(person, proposal, 'Edited draft.').data.description).toBe('Edited draft.');
        expect(person.data.description).toBe('Live description.');
    });

    test('creator notes also replace the top-level creatorcomment, system prompts only data', () => {
        const notes = applyCharacterChangeToSnapshot(person, frozen({ ...PROPOSALS.character, field: 'creator_notes', value: 'New notes.' }));
        expect(notes.data.creator_notes).toBe('New notes.');
        expect(notes.creatorcomment).toBe('New notes.');
        const system = applyCharacterChangeToSnapshot(person, frozen({ ...PROPOSALS.character, field: 'system_prompt', value: 'Be brief.' }));
        expect(system.data.system_prompt).toBe('Be brief.');
        expect(system).not.toHaveProperty('system_prompt');
    });

    test('alternate greetings append to or replace the saved list', () => {
        const appended = applyCharacterChangeToSnapshot(person, frozen(PROPOSALS.character_greetings));
        expect(appended.data.alternate_greetings).toEqual(['Hello there.', 'Hi.']);
        const edited = applyCharacterChangeToSnapshot(person, frozen(PROPOSALS.character_greetings), 'One.\n---\nTwo.');
        expect(edited.data.alternate_greetings).toEqual(['Hello there.', 'One.', 'Two.']);
        const replaced = applyCharacterChangeToSnapshot(person, frozen({ ...PROPOSALS.character_greetings, action: undefined, value: ['Only.'] }));
        expect(replaced.data.alternate_greetings).toEqual(['Only.']);
        expect(person.data.alternate_greetings).toEqual(['Hello there.']);
    });

    test('unsupported character fields return the same snapshot', () => {
        expect(applyCharacterChangeToSnapshot(person, frozen(PROPOSALS.character_name))).toBe(person);
        expect(applyCharacterChangeToSnapshot(person, frozen(PROPOSALS.new_character))).toBe(person);
    });

    test('persona description keeps chat-specific additions around the base text', () => {
        const live = frozen({ name: 'Mira', description: 'Mira is a sailor.', title: 'Captain', text: 'Mira is a sailor.\n\nIn this chat she is lost.' });
        const shown = applyPersonaChangeToSnapshot(live, frozen(PROPOSALS.persona));
        expect(shown.description).toBe('Mira, rewritten.');
        expect(shown.text).toBe('Mira, rewritten.\n\nIn this chat she is lost.');
        expect(applyPersonaChangeToSnapshot(live, frozen({ ...PROPOSALS.persona, field: 'name', value: '  Captain Mira ' })).name).toBe('Captain Mira');
        expect(applyPersonaChangeToSnapshot(live, frozen({ ...PROPOSALS.persona, field: 'title', value: 'Pilot' }), 'Navigator').title).toBe('Navigator');
        expect(applyPersonaChangeToSnapshot(live, frozen(PROPOSALS.persona_avatar))).toBe(live);
        expect(live.text).toBe('Mira is a sailor.\n\nIn this chat she is lost.');
    });

    test('Author\'s Note', () => {
        expect(applyAuthorsNoteChangeToSnapshot('Old note.', frozen(PROPOSALS.authors_note))).toBe('Keep it tense.');
        expect(applyAuthorsNoteChangeToSnapshot('Old note.', frozen(PROPOSALS.authors_note), 'Edited note.')).toBe('Edited note.');
        expect(applyAuthorsNoteChangeToSnapshot('Old note.', frozen(PROPOSALS.regex))).toBe('Old note.');
    });

    describe('lorebook entries', () => {
        const entries = frozen([
            { world: 'Roleplay lore', uid: 0, comment: 'Lighthouse', key: ['lighthouse'], content: 'The lighthouse burns.', constant: false },
            { world: 'Roleplay lore', uid: 1, comment: 'Secret', key: ['secret'], content: 'Hidden from agents.', agentBlacklisted: true },
            { world: 'Roleplay lore', uid: 2, comment: 'Dormant', key: ['dormant'], content: 'Switched off.', disable: true },
        ]);

        test('create appends an unsaved entry, using the edited draft', () => {
            const shown = applyLoreChangeToEntries(entries, frozen(PROPOSALS.lore_add));
            expect(shown).toHaveLength(4);
            expect(shown.slice(0, 3)).toEqual(entries);
            expect(shown[3]).toMatchObject({ world: 'Roleplay lore', uid: 'unsaved', comment: 'Harbour', key: ['harbour'], content: 'The harbour is quiet.', constant: false, disable: false });
            const edited = applyLoreChangeToEntries(entries, frozen(PROPOSALS.lore_add), 'Title: Docks\nKeys: dock, pier\nAlways active: yes\n\nThe docks creak.');
            expect(edited[3]).toMatchObject({ comment: 'Docks', key: ['dock', 'pier'], content: 'The docks creak.', constant: true, vectorized: false });
            expect(loreChangeKey(PROPOSALS.lore_add)).toBe('Roleplay lore::unsaved');
        });

        test('edit replaces only the named entry with a copy', () => {
            const shown = applyLoreChangeToEntries(entries, frozen(PROPOSALS.lore_edit));
            expect(shown[0]).not.toBe(entries[0]);
            expect(shown[0]).toMatchObject({ comment: 'Lighthouse', key: ['lighthouse'], content: 'The lighthouse is dark now.' });
            expect(shown[1]).toBe(entries[1]);
            expect(shown[2]).toBe(entries[2]);
            const draft = applyLoreChangeToEntries(entries, frozen(PROPOSALS.lore_edit), 'Title: Beacon\nKeys: beacon\nAlways active: no\n\nThe beacon blinks.');
            expect(draft[0]).toMatchObject({ comment: 'Beacon', key: ['beacon'], content: 'The beacon blinks.' });
            expect(entries[0].content).toBe('The lighthouse burns.');
            expect(loreChangeKey(PROPOSALS.lore_edit)).toBe('Roleplay lore::0');
        });

        test('toggle changes the switch without touching the text', () => {
            const off = applyLoreChangeToEntries(entries, frozen(PROPOSALS.lore_toggle));
            expect(off[0]).toMatchObject({ disable: true, content: 'The lighthouse burns.' });
            const on = applyLoreChangeToEntries(entries, frozen({ ...PROPOSALS.lore_toggle, uid: 2, disable: false }));
            expect(on[2]).toMatchObject({ disable: false, content: 'Switched off.' });
        });

        test('delete removes the entry from the copy', () => {
            const shown = applyLoreChangeToEntries(entries, frozen(PROPOSALS.lore_delete));
            expect(shown.map(entry => entry.uid)).toEqual([1, 2]);
            expect(entries).toHaveLength(3);
        });

        test('entries hidden from agents are never changed, revealed or removed', () => {
            for (const proposal of [{ ...PROPOSALS.lore_edit, uid: 1 }, { ...PROPOSALS.lore_toggle, uid: 1, disable: false }, { ...PROPOSALS.lore_delete, uid: 1 }]) {
                expect(applyLoreChangeToEntries(entries, frozen(proposal))).toBe(entries);
            }
            expect(applyLoreChangeToEntries(entries, frozen({ ...PROPOSALS.lore_edit, uid: 9 }))).toBe(entries);
            expect(applyLoreChangeToEntries(entries, frozen({ ...PROPOSALS.lore_edit, book: 'Other lore' }))).toBe(entries);
        });
    });

    describe('presets', () => {
        const preset = frozen(presetSnapshot);

        test('prompt text, with the edited draft', () => {
            const shown = applyPresetChangeToSnapshot(preset, frozen(PROPOSALS.preset));
            expect(shown.modules[0].content).toBe('Write slowly.');
            expect(shown.modules[1]).toBe(preset.modules[1]);
            expect(applyPresetChangeToSnapshot(preset, frozen(PROPOSALS.preset), 'Write in verse.').modules[0].content).toBe('Write in verse.');
            expect(preset.modules[0].content).toBe('Write the next reply.');
        });

        test('toggle, name, role, depth and position', () => {
            const proposal = field => frozen({ ...PROPOSALS.preset, module: 'nsfw', field, value: undefined });
            expect(applyPresetChangeToSnapshot(preset, { ...proposal('enabled'), value: true }).modules[2].enabled).toBe(true);
            expect(applyPresetChangeToSnapshot(preset, { ...proposal('name'), value: 'Heat' }).modules[2].name).toBe('Heat');
            expect(applyPresetChangeToSnapshot(preset, { ...proposal('role'), value: 'user' }).modules[2].role).toBe('user');
            expect(applyPresetChangeToSnapshot(preset, { ...proposal('injection_position'), value: 1 }).modules[2].depth).toBe(4);
            const depth = frozen({ ...PROPOSALS.preset, module: 'reminder', field: 'injection_depth', value: 6 });
            expect(applyPresetChangeToSnapshot(preset, depth).modules[3].depth).toBe(6);
            expect(applyPresetChangeToSnapshot(preset, frozen({ ...depth, field: 'injection_position', value: 0 })).modules[3].depth).toBeNull();
        });

        test('markers, other presets and unknown prompts stay as saved', () => {
            expect(applyPresetChangeToSnapshot(preset, frozen({ ...PROPOSALS.preset, module: 'charDescription' }))).toBe(preset);
            expect(applyPresetChangeToSnapshot(preset, frozen({ ...PROPOSALS.preset, preset: 'Other' }))).toBe(preset);
            expect(applyPresetChangeToSnapshot(preset, frozen({ ...PROPOSALS.preset, module: 'missing' }))).toBe(preset);
        });

        test('text-completion system prompts rebuild their module from the fields', () => {
            const text = frozen({
                kind: 'text', api: 'Text Completion', name: 'Story',
                modules: [{ id: 'sysprompt', name: 'System prompt: Story', enabled: true, content: 'Old.\n\nPost-history instructions:\nAfter.' }, { id: 'context', content: 'Story string.' }],
                targets: [{ api: 'sysprompt', name: 'Story', fields: { content: 'Old.', post_history: 'After.' } }],
            });
            const shown = applyPresetChangeToSnapshot(text, frozen({ type: 'preset', action: 'replace', api: 'sysprompt', preset: 'Story', field: 'content', value: 'New.' }));
            expect(shown.modules[0].content).toBe('New.\n\nPost-history instructions:\nAfter.');
            expect(shown.targets[0].fields).toEqual({ content: 'New.', post_history: 'After.' });
            expect(shown.modules[1]).toBe(text.modules[1]);
            expect(text.targets[0].fields.content).toBe('Old.');
        });
    });

    describe('chat messages', () => {
        const messages = frozen([
            { ref: '0', number: 0, name: 'Roleplay', text: 'Opening.', hidden: false, isUser: false, swipes: [{ ref: '0:swipe:0', messageRef: '0', number: 0, swipe: 1, current: true, text: 'Opening.' }] },
            { ref: '1', number: 1, name: 'Mira', text: 'Reply.', hidden: true, isUser: true, swipes: [] },
            { ref: '2', number: 2, name: 'Roleplay', text: 'Later.', hidden: false, isUser: false, swipes: [] },
        ]);

        test('edit rewrites the message and its current swipe', () => {
            const shown = applyChatChangeToMessages(messages, frozen(PROPOSALS.chat_edit));
            expect(shown[0].text).toBe('Rewritten opening.');
            expect(shown[0].swipes[0].text).toBe('Rewritten opening.');
            expect(applyChatChangeToMessages(messages, frozen(PROPOSALS.chat_edit), 'Draft.')[0].text).toBe('Draft.');
            expect(shown[1]).toBe(messages[1]);
            expect(rehearsalMessageRef(messages, PROPOSALS.chat_edit)).toBe('0');
        });

        test('insert adds an unsaved message and renumbers the rest', () => {
            const shown = applyChatChangeToMessages(messages, frozen(PROPOSALS.chat_insert), undefined, { userName: 'Mira', characterName: 'Roleplay' });
            expect(shown.map(item => [item.ref, item.number])).toEqual([['0', 0], ['unsaved-insert', 1], ['1', 2], ['2', 3]]);
            expect(shown[1]).toMatchObject({ name: 'Roleplay', text: 'Inserted line.', hidden: false, isUser: false });
            expect(shown[0]).toBe(messages[0]);
            expect(rehearsalMessageRef(shown, PROPOSALS.chat_insert)).toBe('unsaved-insert');
            expect(applyChatChangeToMessages(messages, frozen({ ...PROPOSALS.chat_insert, after: 7 }))).toBe(messages);
        });

        test('hide and unhide flip the flag, delete removes and renumbers', () => {
            expect(applyChatChangeToMessages(messages, frozen(PROPOSALS.chat_hide))[0].hidden).toBe(true);
            expect(applyChatChangeToMessages(messages, frozen({ ...PROPOSALS.chat_unhide, message: 1 }))[1].hidden).toBe(false);
            const deleted = applyChatChangeToMessages(messages, frozen(PROPOSALS.chat_delete));
            expect(deleted.map(item => [item.ref, item.number])).toEqual([['1', 0], ['2', 1]]);
            expect(messages[1].number).toBe(1);
            expect(rehearsalMessageRef(messages, PROPOSALS.chat_hide)).toBeNull();
        });
    });
});

describe('buildContext with an unsaved change', () => {
    const roleplay = () => currentSource();
    const trial = (change, value) => ({ change, ...(value === undefined ? {} : { value }), label: describeChange(change) });

    beforeEach(() => {
        setNotebookSource(null);
        conversationState.conversationWorkspaceOpen = false;
        persona.id = 'User.png';
        power_user.persona_description = 'Mira is a sailor.';
        power_user.personas = { 'User.png': 'Mira' };
        power_user.persona_descriptions = { 'User.png': { description: 'Mira is a sailor.', title: 'Captain' } };
        characters.splice(0, characters.length, ...structuredClone(originalCharacters));
        chatMetadata.note_prompt = 'Keep it light.';
        chat.splice(0, chat.length,
            { name: 'Roleplay', mes: 'The lighthouse opening.', swipe_id: 0, swipes: ['The lighthouse opening.'] },
            { name: 'Mira', is_user: true, is_system: true, mes: 'A hidden aside.' },
            { name: 'Roleplay', mes: 'The latest line.' });
        books.clear();
        books.set('Roleplay lore', { entries: {
            0: { uid: 0, comment: 'Lighthouse', key: ['lighthouse'], content: 'The lighthouse burns.' },
            1: { uid: 1, comment: 'Secret', key: ['lighthouse'], content: 'AGENT-HIDDEN secret.', agentBlacklisted: true },
        } });
        loadWorldInfo.mockClear();
    });

    test('is byte-identical without a change, with null and with an unsupported change', async () => {
        const settings = { depth: 15, include: { card: true, persona: true, lore: true, authorsNote: true, preset: true } };
        const plain = await buildContext({ source: roleplay(), settings });
        expect((await buildContext({ source: roleplay(), settings, rehearsalChange: null })).text).toBe(plain.text);
        expect((await buildContext({ source: roleplay(), settings, rehearsalChange: trial(PROPOSALS.regex) })).text).toBe(plain.text);
        expect(plain.text).not.toContain('Unsaved change under rehearsal');
    });

    test('a character change shows in the card even with Character switched off', async () => {
        const settings = frozen({ depth: 15, include: { card: false } });
        const plain = await buildContext({ source: roleplay(), settings });
        expect(plain.text).not.toContain('Live description.');
        const context = await buildContext({ source: roleplay(), settings, rehearsalChange: trial(PROPOSALS.character, 'Draft description.') });
        expect(context.text).toContain('## Unsaved change under rehearsal\nChange: Change Roleplay\'s description\nApplies to: Roleplay\'s character card');
        expect(context.text).toContain('Draft description.');
        expect(context.text).not.toContain('Live description.');
        expect(settings.include.card).toBe(false);
        expect(characters[0].data.description).toBe('Live description.');
    });

    test('a persona change replaces the shared persona and its editable fields', async () => {
        const settings = frozen({ depth: 15, include: { persona: false } });
        const context = await buildContext({ source: roleplay(), settings, rehearsalChange: trial(PROPOSALS.persona) });
        expect(context.text).toContain('Applies to: Mira\'s persona');
        expect(context.text).toContain('Mira, rewritten.');
        expect(context.text).toContain('"description":"Mira, rewritten."');
        expect(context.text).not.toContain('Mira is a sailor.');
        expect(power_user.persona_descriptions['User.png'].description).toBe('Mira is a sailor.');
    });

    test('an Author\'s Note change is shared with the switch off', async () => {
        const context = await buildContext({ source: roleplay(), settings: frozen({ depth: 15, include: {} }), rehearsalChange: trial(PROPOSALS.authors_note) });
        expect(context.text).toContain('## Author\'s Note\nKeep it tense.');
        expect(context.text).not.toContain('Keep it light.');
        expect(chatMetadata.note_prompt).toBe('Keep it light.');
    });

    test('a lorebook edit shares only that entry with Lore off and never leaks agent-hidden entries', async () => {
        const context = await buildContext({ source: roleplay(), settings: frozen({ depth: 15, include: { lore: false } }), rehearsalChange: trial(PROPOSALS.lore_edit) });
        expect(context.text).toContain('Applies to: the Roleplay lore lorebook');
        expect(context.text).toContain('The lighthouse is dark now.');
        expect(context.text).not.toContain('The lighthouse burns.');
        expect(context.text).not.toContain('AGENT-HIDDEN');
        const blocked = await buildContext({ source: roleplay(), settings: { depth: 15, include: { lore: true } }, rehearsalChange: trial({ ...PROPOSALS.lore_edit, uid: 1, content: 'Revealed.' }) });
        expect(blocked.text).not.toContain('AGENT-HIDDEN');
        expect(blocked.text).not.toContain('Revealed.');
        expect(books.get('Roleplay lore').entries[0].content).toBe('The lighthouse burns.');
    });

    test('a new lorebook entry is shared as unsaved', async () => {
        const context = await buildContext({ source: roleplay(), settings: { depth: 15, include: { lore: true } }, rehearsalChange: trial(PROPOSALS.lore_add) });
        expect(context.text).toContain('The harbour is quiet.');
        expect(context.text).toContain('The lighthouse burns.');
    });

    test('a preset change shows the edited prompt but keeps the live preset checks', async () => {
        const context = await buildContext({ source: roleplay(), settings: { depth: 15, include: { preset: false } }, rehearsalChange: trial(PROPOSALS.preset, 'Write in verse.') });
        expect(context.text).toContain('Applies to: preset \'Lantern\'');
        expect(context.text).toContain('Write in verse.');
        expect(context.text).not.toContain('Write the next reply.');
        expect(presetSnapshot.modules[0].content).toBe('Write the next reply.');
    });

    test('a chat edit rewrites the shared message and keeps hidden messages out', async () => {
        const context = await buildContext({ source: roleplay(), settings: { depth: 1, include: {} }, rehearsalChange: trial(PROPOSALS.chat_edit, 'The rewritten opening.') });
        expect(context.text).toContain('Applies to: the chat messages');
        expect(context.text).toContain('The rewritten opening.');
        expect(context.text).toContain('The latest line.');
        expect(context.text).not.toContain('The lighthouse opening.');
        expect(context.text).not.toContain('A hidden aside.');
        expect(chat[0].mes).toBe('The lighthouse opening.');
        const unhide = await buildContext({ source: roleplay(), settings: { depth: 15, include: {} }, rehearsalChange: trial({ ...PROPOSALS.chat_unhide, message: 1 }) });
        expect(unhide.text).toContain('A hidden aside.');
        expect(chat[1].is_system).toBe(true);
    });

    test('roleplay-only changes are ignored in Conversation', async () => {
        conversationState.conversationWorkspaceOpen = true;
        const settings = { depth: 15, include: {} };
        const plain = await buildContext({ source: currentSource(), settings });
        const tried = await buildContext({ source: currentSource(), settings, rehearsalChange: trial(PROPOSALS.authors_note) });
        expect(tried.text).toBe(plain.text);
    });
});
