/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const source = { kind: 'roleplay', key: 'original' };
const chat = [];
const chatMetadata = {};
const characters = [];
let book;
let character;
let liveKey = 'original';
const saveChatConditional = jest.fn(async () => true);
const updateMessageBlock = jest.fn();
const emit = jest.fn();
const reloadCurrentChat = jest.fn();
const syncMesToSwipe = jest.fn();
const getOneCharacter = jest.fn();
const hideChatMessageRange = jest.fn(async (start, _end, unhide) => {
    chat[start].is_system = !unhide;
    return true;
});
const deleteMessage = jest.fn(async index => { chat.splice(index, 1); });
const loadWorldInfo = jest.fn(async () => structuredClone(book));
const saveWorldInfo = jest.fn(async (_name, data) => {
    book = structuredClone(data);
    return 'Garden';
});

jest.unstable_mockModule('../public/script.js', () => ({
    chat, chat_metadata: chatMetadata, characters, deleteMessage, getOneCharacter, getRequestHeaders: () => ({}),
    getThumbnailUrl: jest.fn(), name1: 'User', reloadCurrentChat, saveChatConditional,
    extractMessageBias: () => '', isGenerating: () => false,
    select_selected_character: jest.fn(), syncMesToSwipe, this_chid: 0, updateMessageBlock, printCharactersDebounced: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/chats.js', () => ({ hideChatMessageRange }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({
    event_types: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated', CHARACTER_EDITED: 'character-edited' }, eventSource: { emit },
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), ''), translate: text => text }));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'user.png' }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: { personas: {} } }));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ getMessageTimeStamp: () => 'today' }));
jest.unstable_mockModule('../public/scripts/slash-commands.js', () => ({ getNameAndAvatarForMessage: () => ({ name: 'Nova' }) }));
jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    world_names: ['Garden'], updateWorldInfoList: jest.fn(), loadWorldInfo, saveWorldInfo,
    createWorldInfoEntry: (_name, data) => (data.entries[1] = { uid: 1 }),
    deleteWorldInfoEntry: async (data, uid) => { delete data.entries[uid]; },
}));
jest.unstable_mockModule('../public/scripts/scratchpad/context.js', () => ({
    isCurrentSource: () => true,
    currentSource: () => ({ kind: 'roleplay', key: liveKey }),
    sourceCharacters: () => [{ name: 'Nova', avatar: 'Nova.png' }],
    wireSource: source => ({ kind: source.kind, key: source.key }),
}));
const memory = { ferry: { id: 'ferry', kind: 'event', version: 2, text: 'The ferry leaves at noon.', status: 'active' } };
const readMewmoryRecord = jest.fn(async (_source, _session, id) => structuredClone(memory[id]));
const correctMewmoryRecord = jest.fn(async (_source, _session, id, { field, value, expected, version }) => {
    const record = memory[id];
    if (record[field] !== expected || record.version !== version) throw Object.assign(new Error('Changed.'), { status: 409 });
    record[field] = value;
    record.version += 1;
    return { record: structuredClone(record) };
});
jest.unstable_mockModule('../public/scripts/scratchpad/api.js', () => ({ readMewmoryRecord, correctMewmoryRecord }));

let agents = [];
jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
    getAgentById: id => agents.find(item => item.id === id),
    saveAgent: jest.fn(async (id, { update }) => {
        const index = agents.findIndex(item => item.id === id);
        const next = update(structuredClone(agents[index]));
        if (next) agents[index] = next;
    }),
}));
let cssSnippets = [];
jest.unstable_mockModule('../public/scripts/extensions/css-snippets/src/runtime.js', () => ({
    getSettings: () => ({ snippetList: cssSnippets }), saveSnippet: jest.fn(), hasNoReadableRules: () => false,
    getCtx: () => ({ saveSettingsDebounced: jest.fn() }),
}));
const dialogueColors = { characterColors: {} };
jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/state.js', () => ({
    get characterColors() { return dialogueColors.characterColors; },
}));
jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/palettes.js', () => ({ getBaseColor: entry => entry.baseColor }));
jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/ui.js', () => ({
    applyCharacterBaseColor: jest.fn((key, color) => {
        if (!dialogueColors.characterColors[key]) return false;
        dialogueColors.characterColors[key].baseColor = color;
        return true;
    }),
    maybeAutoRecolorAfterColorChange: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/storage.js', () => ({ saveData: jest.fn() }));
let regexScripts = [];
jest.unstable_mockModule('../public/scripts/extensions/regex/engine.js', () => ({
    SCRIPT_TYPES: { GLOBAL: 0 }, getScriptsByType: () => regexScripts, saveScriptsByType: jest.fn(async () => {}), RegexProvider: { instance: { clear() {} } },
}));
jest.unstable_mockModule('../public/scripts/extensions/regex/index.js', () => ({ loadRegexScripts: jest.fn(async () => {}) }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({ regexFromString: input => new RegExp(input) }));

// A fake DOM whose nodes only ever take text through textContent, so markup in saved text cannot become elements.
const created = [];
function fakeElement(tag) {
    const node = {
        tag, attributes: {}, children: [], listeners: {}, textContent: '', open: false, dataset: {},
        append(...items) { for (const item of items.flat()) if (item != null && item !== false) this.children.push(item); },
        setAttribute(key, value) { this.attributes[key] = String(value); },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        closest: () => null,
        set innerHTML(_value) { throw new Error('innerHTML must not be used for Change history.'); },
    };
    created.push(node);
    return node;
}
jest.unstable_mockModule('../public/scripts/notebooks/dom.js', () => ({
    h: (tag, attributes = {}, ...children) => {
        const node = fakeElement(tag);
        for (const [key, value] of Object.entries(attributes ?? {})) {
            if (value == null || value === false) continue;
            if (key === 'text') node.textContent = String(value);
            else if (key === 'dataset') Object.assign(node.dataset, value);
            else if (key.startsWith('on') && typeof value === 'function') node.listeners[key.slice(2)] = value;
            else node.setAttribute(key, value);
        }
        node.append(...children);
        return node;
    },
}));

const { prepareChange } = await import('../public/scripts/scratchpad/changes.js');
const { undoChange, UndoConflictError, UndoUnavailableError } = await import('../public/scripts/scratchpad/change-undo.js');
const { canUndoEntry, findHistoryEntry, historyStatus, renderChangeHistory } = await import('../public/scripts/scratchpad/change-history-ui.js');

function patchCharacter(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) patchCharacter(target[key] ??= {}, value);
        else target[key] = value;
    }
}

async function save(change, options = {}, edited) {
    const plan = await prepareChange(change, source, options);
    const { receipt } = await plan.commit(edited ?? plan.after);
    return { ...receipt, id: 'entry', status: 'applied' };
}

async function refused(promise) {
    const error = await promise.then(() => null, caught => caught);
    expect(error).toBeInstanceOf(UndoConflictError);
    expect(error.conflict).toBe(true);
    expect(error.message).toContain('automatic undo was stopped to avoid overwriting your later changes');
    return error;
}

beforeEach(() => {
    jest.clearAllMocks();
    liveKey = 'original';
    chat.splice(0, chat.length,
        { name: 'Nova', mes: 'First message.', is_system: false },
        { name: 'User', mes: 'Second message.', is_system: false },
        { name: 'Nova', mes: 'Third message.', is_system: false });
    for (const key of Object.keys(chatMetadata)) delete chatMetadata[key];
    characters.splice(0, characters.length, { avatar: 'Nova.png', name: 'Nova' });
    book = { entries: { 0: { uid: 0, comment: 'Flower', key: ['flower'], content: 'Original lore.' } } };
    character = { name: 'Nova', description: 'Old description.', data: { description: 'Old description.', alternate_greetings: ['Hello.'] } };
    memory.ferry = { id: 'ferry', kind: 'event', version: 2, text: 'The ferry leaves at noon.', status: 'active' };
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
        const body = JSON.parse(options.body);
        if (url === '/api/characters/merge-attributes') {
            const patch = { ...body };
            delete patch.avatar;
            delete patch.expected_revision;
            patchCharacter(character, patch);
        }
        return { ok: true, status: 200, headers: { get: () => 'a'.repeat(64) }, json: async () => structuredClone(character) };
    });
});

afterEach(() => jest.restoreAllMocks());

describe('Scratchpad saved change receipts', () => {
    test('every reversible save returns an undoable receipt with the text it replaced', async () => {
        const entry = await save({ type: 'character', character: 'Nova', field: 'description', value: 'New description.' });
        expect(entry).toMatchObject({
            type: 'character', undoable: true, undoUnavailableReason: '', before: 'Old description.', after: 'New description.',
            target: { kind: 'character', label: expect.stringContaining('Nova'), character: 'Nova' },
            undo: { kind: 'character', avatar: 'Nova.png', field: 'description', before: 'Old description.', after: 'New description.' },
        });
        expect(entry.description).toBeTruthy();
    });

    test('creating something is recorded honestly as not undoable', async () => {
        const entry = { id: 'made', type: 'character', action: 'create', status: 'applied', undoable: false, undo: null,
            undoUnavailableReason: 'Scratchpad does not delete characters it created. Remove the card from your library if you no longer want it.' };
        const error = await undoChange(entry, source).then(() => null, caught => caught);
        expect(error).toBeInstanceOf(UndoUnavailableError);
        expect(error.message).toBe(entry.undoUnavailableReason);
        await expect(undoChange({ ...entry, undoable: true, undo: { kind: 'character' }, status: 'undone' }, source)).rejects.toThrow('already undone');
        await expect(undoChange({ id: 'odd', undoable: true, undo: { kind: 'mystery' }, status: 'applied' }, source)).rejects.toThrow('not available');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});

describe('Scratchpad Undo', () => {
    test('a character card edit goes back exactly, and is refused after a later edit', async () => {
        const entry = await save({ type: 'character', character: 'Nova', field: 'description', value: 'New description.' });
        expect(character.data.description).toBe('New description.');
        await undoChange(entry, source);
        expect(character.data.description).toBe('Old description.');
        expect(getOneCharacter).toHaveBeenCalledWith('Nova.png');
        expect(emit).toHaveBeenCalledWith('character-edited', expect.objectContaining({ detail: expect.objectContaining({ id: 0 }) }));

        const again = await save({ type: 'character', character: 'Nova', field: 'description', value: 'Second description.' });
        character.data.description = 'Edited by hand.';
        await refused(undoChange(again, source));
        expect(character.data.description).toBe('Edited by hand.');
        const merges = globalThis.fetch.mock.calls.filter(([url]) => url === '/api/characters/merge-attributes');
        expect(merges).toHaveLength(3);
    });

    test('appended greetings are taken back off', async () => {
        const entry = await save({ type: 'character', action: 'append', character: 'Nova', field: 'alternate_greetings', value: ['Proposed greeting.'] });
        expect(character.data.alternate_greetings).toEqual(['Hello.', 'Proposed greeting.']);
        await undoChange(entry, source);
        expect(character.data.alternate_greetings).toEqual(['Hello.']);
    });

    test('lorebook add, edit and delete each reverse, and a hand edit stops the undo', async () => {
        const original = structuredClone(book.entries[0]);
        const edit = await save({ type: 'lorebook', action: 'edit', book: 'Garden', uid: 0, content: 'New lore.' });
        expect(book.entries[0].content).toBe('New lore.');
        await undoChange(edit, source);
        expect(book.entries[0]).toEqual(original);

        const added = await save({ type: 'lorebook', action: 'add', book: 'Garden', title: 'Moon', keys: ['moon'], content: 'Moon lore.' });
        expect(added.undo).toMatchObject({ kind: 'lorebook-add', book: 'Garden', uid: 1 });
        expect(book.entries[1].content).toBe('Moon lore.');
        await undoChange(added, source);
        expect(book.entries[1]).toBeUndefined();

        const deleted = await save({ type: 'lorebook', action: 'delete', book: 'Garden', uid: 0 });
        expect(book.entries[0]).toBeUndefined();
        await undoChange(deleted, source);
        expect(book.entries[0]).toEqual(original);

        const stale = await save({ type: 'lorebook', action: 'edit', book: 'Garden', uid: 0, content: 'Newer lore.' });
        book.entries[0].content = 'Hand-written lore.';
        await refused(undoChange(stale, source));
        expect(book.entries[0].content).toBe('Hand-written lore.');
    });

    test('the Author\'s Note goes back only in the same chat and only while unchanged', async () => {
        chatMetadata.note_prompt = 'Keep calm.';
        const entry = await save({ type: 'authors-note', action: 'replace', value: 'Keep wary.' }, { authorsNoteShared: true });
        expect(chatMetadata.note_prompt).toBe('Keep wary.');
        liveKey = 'another-chat';
        await expect(undoChange(entry, { ...source, key: 'another-chat' })).rejects.toThrow('Open the chat this change was made in');
        liveKey = 'original';
        await undoChange(entry, source);
        expect(chatMetadata.note_prompt).toBe('Keep calm.');
        expect(saveChatConditional).toHaveBeenLastCalledWith({ throwOnError: true });

        const stale = await save({ type: 'authors-note', action: 'replace', value: 'Keep bold.' }, { authorsNoteShared: true });
        chatMetadata.note_prompt = 'Typed by hand.';
        await refused(undoChange(stale, source));
        expect(chatMetadata.note_prompt).toBe('Typed by hand.');

        chatMetadata.note_prompt = 'Keep bold.';
        saveChatConditional.mockResolvedValueOnce(false);
        await expect(undoChange(stale, source)).rejects.toThrow('was not restored');
        expect(chatMetadata.note_prompt).toBe('Keep bold.');
    });

    test('Agent, regex and CSS snippet text each reverse and refuse after a later edit', async () => {
        agents = [{ id: 'a-1', name: 'Keeper', prompt: 'Old prompt.' }];
        regexScripts = [{ id: 'tidy', scriptName: 'Tidy', findRegex: '/colour/g', replaceString: 'color' }];
        cssSnippets = [{ id: 'look', name: 'Look', content: '.mes { color: red; }', modifiedOn: 1 }];
        const agent = await save({ type: 'agent', action: 'replace', agent: 'a-1', field: 'prompt', value: 'New prompt.' }, { agentsShared: true });
        const regex = await save({ type: 'regex', action: 'replace', script: 'tidy', field: 'replaceString', value: 'hue' }, { regexShared: true });
        const css = await save({ type: 'css-snippet', action: 'replace', snippet: 'look', field: 'content', value: '.mes { color: blue; }' }, { cssSnippetsShared: true });
        await undoChange(agent, source);
        await undoChange(regex, source);
        await undoChange(css, source);
        expect(agents[0].prompt).toBe('Old prompt.');
        expect(regexScripts[0].replaceString).toBe('color');
        expect(cssSnippets[0].content).toBe('.mes { color: red; }');

        const agentAgain = await save({ type: 'agent', action: 'replace', agent: 'a-1', field: 'prompt', value: 'Newer prompt.' }, { agentsShared: true });
        agents[0].prompt = 'Hand prompt.';
        await refused(undoChange(agentAgain, source));
        expect(agents[0].prompt).toBe('Hand prompt.');
        const regexAgain = await save({ type: 'regex', action: 'replace', script: 'tidy', field: 'replaceString', value: 'tint' }, { regexShared: true });
        regexScripts[0].replaceString = 'shade';
        await refused(undoChange(regexAgain, source));
        const cssAgain = await save({ type: 'css-snippet', action: 'replace', snippet: 'look', field: 'content', value: '.mes { color: pink; }' }, { cssSnippetsShared: true });
        cssSnippets[0].content = '.mine { top: 0; }';
        await refused(undoChange(cssAgain, source));
        expect(cssSnippets[0].content).toBe('.mine { top: 0; }');
    });

    test('a dialogue colour goes back, and a colour that never existed is not undoable', async () => {
        dialogueColors.characterColors = { nova: { name: 'Nova', baseColor: '#aa0000' } };
        const entry = await save({ type: 'dialogue-color', action: 'replace', character: 'Nova', value: '#112233' }, { dialogueColorsShared: true });
        await undoChange(entry, source);
        expect(dialogueColors.characterColors.nova.baseColor).toBe('#aa0000');
        const stale = await save({ type: 'dialogue-color', action: 'replace', character: 'Nova', value: '#445566' }, { dialogueColorsShared: true });
        dialogueColors.characterColors.nova.baseColor = '#000000';
        await refused(undoChange(stale, source));

        // The mocked module reads the table once, so change the entry in place.
        dialogueColors.characterColors.nova.baseColor = '';
        const fresh = await save({ type: 'dialogue-color', action: 'replace', character: 'Nova', value: '#112233' }, { dialogueColorsShared: true });
        expect(fresh).toMatchObject({ undoable: false, undo: null, undoUnavailableReason: expect.stringContaining('no saved dialogue colour') });
    });

    test('chat edits, hides, inserts and deletes each reverse in the same chat', async () => {
        const edit = await save({ type: 'chat', action: 'edit', message: 0, text: 'Rewritten.' });
        expect(chat[0].mes).toBe('Rewritten.');
        await undoChange(edit, source);
        expect(chat[0].mes).toBe('First message.');
        expect(syncMesToSwipe).toHaveBeenLastCalledWith(0);

        const hide = await save({ type: 'chat', action: 'hide', message: 1 });
        expect(chat[1].is_system).toBe(true);
        await undoChange(hide, source);
        expect(chat[1].is_system).toBe(false);

        const insert = await save({ type: 'chat', action: 'insert', after: 0, text: 'Inserted line.' });
        expect(chat).toHaveLength(4);
        await undoChange(insert, source);
        expect(chat.map(message => message.mes)).toEqual(['First message.', 'Second message.', 'Third message.']);

        const removed = structuredClone(chat[1]);
        const deleted = await save({ type: 'chat', action: 'delete', message: 1 });
        expect(chat).toHaveLength(2);
        await undoChange(deleted, source);
        expect(chat[1]).toEqual(removed);
        expect(chat).toHaveLength(3);

        liveKey = 'another-chat';
        await expect(undoChange(edit, source)).rejects.toThrow('Open the chat this change was made in');
    });

    test('Conversation message undo requires the original branch to be open', async () => {
        const entry = {
            status: 'applied',
            undoable: true,
            undo: {
                kind: 'conversation-edit',
                chatKey: 'conversation:t:b1',
                avatar: 'Nova.png',
                branchId: 'b1',
                groupId: '',
                personaId: 'sam.png',
                id: 'm1',
                index: 1,
                before: 'Old.',
                after: 'New.',
            },
        };
        liveKey = 'conversation:t:b2';
        await expect(undoChange(entry, { kind: 'conversation', key: 'conversation:t:b2' }))
            .rejects.toThrow('Open the chat this change was made in');
    });

    test('chat undo refuses when the message or its neighbours changed', async () => {
        const edit = await save({ type: 'chat', action: 'edit', message: 0, text: 'Rewritten.' });
        chat[0].mes = 'Edited by hand.';
        await refused(undoChange(edit, source));
        expect(chat[0].mes).toBe('Edited by hand.');

        const deleted = await save({ type: 'chat', action: 'delete', message: 1 });
        chat.push({ name: 'User', mes: 'A new reply.', is_system: false });
        await refused(undoChange(deleted, source));
        expect(chat.map(message => message.mes)).toEqual(['Edited by hand.', 'Third message.', 'A new reply.']);
    });

    test('a Mewmory correction goes back with the live version, and refuses after another correction', async () => {
        const roleplay = { kind: 'roleplay', key: 'original' };
        const plan = await prepareChange({ type: 'mewmory', action: 'replace', record: 'ferry', field: 'text', value: 'The ferry leaves at dusk.' }, roleplay, { mewmoryShared: true, sessionId: 's1' });
        const { receipt } = await plan.commit(plan.after);
        expect(receipt.undo).toMatchObject({ kind: 'mewmory', record: 'ferry', before: 'The ferry leaves at noon.', after: 'The ferry leaves at dusk.', postVersion: 3 });
        await undoChange({ ...receipt, status: 'applied' }, roleplay);
        expect(memory.ferry).toMatchObject({ text: 'The ferry leaves at noon.', version: 4 });
        expect(correctMewmoryRecord).toHaveBeenLastCalledWith(expect.anything(), 's1', 'ferry',
            { field: 'text', value: 'The ferry leaves at noon.', expected: 'The ferry leaves at dusk.', version: 3 });

        const again = await prepareChange({ type: 'mewmory', action: 'replace', record: 'ferry', field: 'text', value: 'At dawn.' }, roleplay, { mewmoryShared: true, sessionId: 's1' });
        const second = (await again.commit('At dawn.')).receipt;
        memory.ferry.text = 'Corrected by hand.';
        await refused(undoChange({ ...second, status: 'applied' }, roleplay));
        expect(memory.ferry.text).toBe('Corrected by hand.');
    });
});

describe('Change history list', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const history = [
        { id: 'one', type: 'character', status: 'applied', undoable: true, undo: { kind: 'character' }, description: `Change ${payload}`,
            target: { label: payload }, field: 'Description', before: `Old ${payload}`, after: 'New.', savedAt: '2026-11-25T10:00:00.000Z' },
        { id: 'two', type: 'creator', status: 'applied', undoable: false, undo: null, undoUnavailableReason: 'Delete the draft in Catelier.',
            description: 'Open in Catelier', before: '', after: 'Draft.', savedAt: '2026-11-25T09:00:00.000Z' },
        { id: 'three', type: 'lorebook', status: 'undone', undoable: true, undo: { kind: 'lorebook-edit' }, description: 'Edit lore',
            before: 'A', after: 'B', savedAt: '2026-11-25T08:00:00.000Z', undoneAt: '2026-11-25T08:30:00.000Z' },
    ];
    const button = (label, onClick, { className = '', disabled = false } = {}) => {
        const node = fakeElement('button');
        node.textContent = label;
        node.attributes.class = className;
        node.disabled = disabled;
        node.click = onClick;
        return node;
    };
    const all = node => [node, ...node.children.filter(child => typeof child === 'object').flatMap(all)];

    test('badges, Undo and the empty state follow each entry', () => {
        expect(historyStatus(history[0]).label).toBe('Saved');
        expect(historyStatus(history[1]).label).toBe('Recorded');
        expect(historyStatus(history[2]).label).toBe('Undone');
        expect(history.map(canUndoEntry)).toEqual([true, false, false]);
        expect(findHistoryEntry([{ id: 'x', sessionId: 's', messageId: 'm', proposalIndex: 1 }], { sessionId: 's', messageId: 'm', proposalIndex: 1 })?.id).toBe('x');
        expect(findHistoryEntry(null, { sessionId: 's', messageId: 'm', proposalIndex: 1 })).toBeNull();

        const empty = all(renderChangeHistory([], { button }));
        expect(empty.some(node => node.attributes.class === 'scratchpad-history-empty')).toBe(true);

        const onUndo = jest.fn();
        const onCopy = jest.fn();
        const nodes = all(renderChangeHistory(history, { button, onUndo, onCopy, busy: new Set(['one']), conflicts: new Map([['one', 'Stopped.']]) }));
        const undo = nodes.filter(node => node.attributes.class === 'scratchpad-history-undo');
        expect(undo).toHaveLength(1);
        expect(undo[0]).toMatchObject({ textContent: 'Undoing…', disabled: true });
        expect(undo[0].attributes['aria-busy']).toBe('true');
        undo[0].click();
        expect(onUndo).toHaveBeenCalledWith(history[0]);
        nodes.find(node => node.attributes.class === 'scratchpad-history-copy').click();
        expect(onCopy).toHaveBeenCalledWith(`Old ${payload}`);
        expect(nodes.find(node => node.attributes.class === 'scratchpad-history-conflict')?.textContent).toBe('Stopped.');
        expect(nodes.some(node => node.textContent === 'Delete the draft in Catelier.')).toBe(true);
        expect(nodes.filter(node => node.tag === 'summary').map(node => node.textContent)).toContain('View before & after');
    });

    test('saved text containing markup stays text', () => {
        created.length = 0;
        const nodes = all(renderChangeHistory(history, { button, onUndo() {}, onCopy() {}, open: new Set(['one']), diffParts: (a, b) => [[-1, a], [1, b]] }));
        expect(created.some(node => node.tag === 'img')).toBe(false);
        const holding = nodes.filter(node => node.textContent.includes(payload));
        expect(holding.length).toBeGreaterThanOrEqual(4);
        expect(holding.every(node => node.children.length === 0)).toBe(true);
    });
});
