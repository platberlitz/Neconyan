/* global globalThis */
import { afterEach, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const originals = { document: globalThis.document, fetch: globalThis.fetch, CustomEvent: globalThis.CustomEvent, dispatchEvent: globalThis.dispatchEvent, getComputedStyle: globalThis.getComputedStyle };
afterEach(() => { Object.assign(globalThis, originals); jest.resetModules(); });

async function runtime({ assistant = 'miso-male', group = null } = {}) {
    jest.resetModules();
    const toolSource = readFileSync(new URL('../public/scripts/tool-calling.js', import.meta.url), 'utf8');
    const toolContext = vm.createContext({ console: { error() {}, log() {}, warn() {} }, Error, toastr: { info() {}, clear() {} }, stringify: JSON.stringify });
    vm.runInContext(toolSource.slice(toolSource.indexOf('class ToolDefinition {')).replace('export class ToolManager', 'class ToolManager') + '\nthis.ToolManager = ToolManager;', toolContext);
    const manager = toolContext.ToolManager;
    const context = {
        account: 'one', chatId: 'chat', generation: 1, editorOpen: false, dirtyPreset: false, agentGenerating: false,
        reviews: [], writes: [], events: [], confirm: async () => 1,
        beforeLoreWrite: async () => {}, beforeAgentWrite: async () => {}, afterCharacterWrite: () => {},
        characters: [
            { avatar: 'miso.png', name: 'Miso', data: { name: 'Miso', description: 'Old Miso', extensions: { neconyan_assistant: { id: assistant, version: 2 } } } },
            { avatar: ' Card.png', name: 'Card', description: 'Old card', data: { name: 'Card', description: 'Old card', extensions: { foreign: 'keep' } } },
        ],
        agents: new Map([['agent', { id: 'agent', name: 'Agent', description: '', prompt: 'Old agent', tags: [], favorite: false, connectionProfile: '', modelOverride: '', unknown: { keep: true } }]]),
        books: new Map([[' Notes', { unknown: 'keep', entries: {
            0: { uid: 0, comment: 'Old title', content: 'Old lore', disable: true, unknown: 'keep' },
            1: { uid: 1, comment: 'Private', content: 'Not for agents', agentBlacklisted: true },
        } }]]),
        presets: new Map([[' Saved', { temperature: 1, n: 1, openai_max_context: 16384, sampler_order: [0, 1, 2], custom_url: 'private-url', custom_include_headers: 'private-header', foreign: { keep: true } }]]),
        selectedPreset: 'Other',
    };
    const presetManager = {
        getAllPresets: () => [...context.presets.keys()],
        getCompletionPresetByName: name => context.presets.get(name),
        hasUnsavedChanges: () => context.dirtyPreset,
        getSelectedPresetName: () => context.selectedPreset,
        findPreset: name => name,
        selectPreset: jest.fn(async name => { context.selectedPreset = name; }),
        savePreset: jest.fn(async (name, value, options) => {
            context.writes.push({ kind: 'preset', name, value: structuredClone(value), options });
            context.presets.set(name, structuredClone(value));
            return name;
        }),
    };
    const getOneCharacter = jest.fn(async () => true);
    const refreshEditor = jest.fn();
    globalThis.document = {
        querySelector: () => context.editorOpen ? {} : null,
        querySelectorAll: () => context.editorOpen ? [{ getClientRects: () => [{}] }] : [],
        getElementById: id => id === 'form_create' ? context.form : { dataset: { saveStatus: context.editorStatus || 'saved' } },
        createElement: tag => ({ tagName: tag, style: {}, textContent: '', children: [], append(...nodes) { this.children.push(...nodes); }, set innerHTML(_value) { throw new Error('Review must use textContent.'); } }),
    };
    globalThis.getComputedStyle = () => ({ visibility: 'visible' });
    globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
    globalThis.dispatchEvent = event => { context.events.push(event); };
    globalThis.fetch = jest.fn(async (url, options) => {
        const payload = JSON.parse(options.body);
        if (url !== '/api/characters/edit-attribute') throw new Error(`Unexpected request: ${url}`);
        const character = context.characters.find(item => item.avatar === payload.avatar_url);
        character[payload.field] = character.data[payload.field] = payload.value;
        context.writes.push({ kind: 'character', payload });
        context.afterCharacterWrite();
        return { ok: true, json: async () => ({}) };
    });
    jest.unstable_mockModule('../public/script.js', () => ({
        characters: context.characters, this_chid: 0,
        eventSource: { emit: async (...args) => context.events.push(args) }, event_types: { CHARACTER_EDITED: 'edited' },
        flushCharacterSaveDebounced: async () => context.characterSave !== false,
        getChatGeneration: () => context.generation, getCurrentChatId: () => context.chatId,
        getOneCharacter, select_selected_character: refreshEditor, getRequestHeaders: () => ({}), printCharactersDebounced: jest.fn(),
    }));
    jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: group }));
    jest.unstable_mockModule('../public/scripts/tool-calling.js', () => ({ ToolManager: manager }));
    jest.unstable_mockModule('../public/scripts/popup.js', () => ({
        POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1 },
        callGenericPopup: async node => { context.reviews.push(node); return context.confirm(node); },
    }));
    jest.unstable_mockModule('../public/scripts/world-info.js', () => ({ world_names: [...context.books.keys()], loadWorldInfo: async name => structuredClone(context.books.get(name)) }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/entry-manager.js', () => ({
        updateEntry: async (book, uid, content, title, expected, options) => {
            await context.beforeLoreWrite();
            if (options.signal?.aborted || !options.isCurrent()) throw new DOMException('Stale', 'AbortError');
            const entry = context.books.get(book).entries[uid];
            if (String(entry.comment ?? '') !== expected.title || entry.content !== expected.content) throw new Error('Conflicting lorebook edit');
            if (content !== undefined) entry.content = content;
            if (title !== undefined) entry.comment = title;
            context.writes.push({ kind: 'lorebook', options });
        },
    }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
        areAgentsLoaded: () => true, getAgents: () => [...context.agents.values()], getAgentById: id => context.agents.get(id),
        saveAgent: async (id, { update }) => {
            await context.beforeAgentWrite();
            const next = update(structuredClone(context.agents.get(id)));
            context.agents.set(id, next); context.writes.push({ kind: 'agent', next });
            return next;
        },
    }));
    jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-runner.js', () => ({ isAgentGenerationActive: () => context.agentGenerating }));
    jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: { connectionManager: { profiles: [{ id: 'profile' }] } } }));
    jest.unstable_mockModule('../public/scripts/preset-manager.js', () => ({ getPresetManager: () => presetManager }));
    jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => context.account }));
    const tools = await import('../public/scripts/neconyan-assistant-tools.js');
    tools.syncNeconyanAssistantTools();
    const invoke = async (name, input = {}, options) => JSON.parse(await manager.invokeFunctionTool(`Neconyan_Assistant_${name}`, JSON.stringify(input), options));
    return { context, manager, tools, invoke, presetManager, getOneCharacter, refreshEditor };
}

test('only supported active individual-chat assistant metadata registers tools', async () => {
    for (const options of [{}, { assistant: 'ordinary' }, { group: 'group' }]) {
        const { manager } = await runtime(options);
        expect(manager.tools.length).toBe(Object.keys(options).length ? 0 : 13);
    }
});

test('real ToolManager list/read actions keep exact names and omit inaccessible fields', async () => {
    const { invoke } = await runtime();
    expect(await invoke('ListLorebooks')).toMatchObject({ books: [{ name: ' Notes' }] });
    expect(await invoke('ListLorebookEntries', { book: ' Notes' })).toMatchObject({ entries: [{ uid: 0, disabled: true }] });
    expect((await invoke('ListLorebookEntries', { book: ' Notes' })).entries[0]).not.toHaveProperty('content');
    expect(await invoke('ReadLorebookEntry', { book: ' Notes', uid: 1 })).toMatchObject({ status: 'failure' });
    expect(await invoke('ListAgents')).toMatchObject({ agents: [{ id: 'agent' }] });
    expect((await invoke('ListAgents')).agents[0]).not.toHaveProperty('prompt');
    expect(await invoke('ReadAgent', { id: 'agent' })).toMatchObject({ agent: { prompt: 'Old agent' } });
    expect(await invoke('ListModelPresets', { apiId: 'openai' })).toMatchObject({ presets: [{ name: ' Saved' }] });
    const preset = await invoke('ReadModelPreset', { apiId: 'openai', name: ' Saved' });
    expect(preset.preset).toHaveProperty('temperature', 1);
    expect(preset.preset).not.toHaveProperty('custom_url');
    expect(preset.preset).not.toHaveProperty('custom_include_headers');
    expect(await invoke('ListCharacters')).toMatchObject({ characters: [{ avatar: 'miso.png' }, { avatar: ' Card.png' }] });
    expect((await invoke('ListCharacters')).characters[1]).not.toHaveProperty('description');
    expect(await invoke('ReadCharacter', { avatar: ' Card.png' })).toMatchObject({ character: { description: 'Old card' } });
});

test('four confirmed field edits preserve other fields and literal multiline review values', async () => {
    const { context, invoke, presetManager } = await runtime();
    const value = '<img src=x onerror=alert(1)> &\n' + 'Long exact text. '.repeat(50);
    expect(await invoke('EditLorebookEntry', { book: ' Notes', uid: 0, field: 'content', value })).toMatchObject({ status: 'success', committed: true });
    expect(context.books.get(' Notes').entries[0]).toMatchObject({ content: value, disable: true, unknown: 'keep' });
    const review = context.reviews[0];
    expect(review.children.filter(node => node.tagName === 'pre').map(node => node.textContent)).toEqual(['Old lore', value]);
    expect(await invoke('EditAgent', { id: 'agent', field: 'prompt', value })).toMatchObject({ status: 'success', committed: true });
    expect(context.agents.get('agent').unknown).toEqual({ keep: true });
    expect(await invoke('EditModelPreset', { apiId: 'openai', name: ' Saved', field: 'temperature', value: 0.7 })).toMatchObject({ status: 'success', committed: true });
    expect(presetManager.selectPreset).not.toHaveBeenCalled();
    expect(context.presets.get(' Saved').foreign).toEqual({ keep: true });
    expect(await invoke('EditCharacter', { avatar: ' Card.png', field: 'description', value })).toMatchObject({ status: 'success', committed: true });
    expect(context.characters[1].data.extensions).toEqual({ foreign: 'keep' });
});

test('declined, cancelled, stale and conflicting edits do not write', async () => {
    const { context, invoke } = await runtime();
    const input = { id: 'agent', field: 'prompt', value: 'Changed' };
    context.confirm = async () => 0;
    expect(await invoke('EditAgent', input)).toMatchObject({ status: 'cancelled' });
    context.confirm = async () => { context.account = 'two'; return 1; };
    expect(await invoke('EditAgent', input)).toMatchObject({ status: 'cancelled' });
    context.account = 'one'; context.confirm = async () => 1;
    expect(await invoke('EditAgent', input, { signal: AbortSignal.abort() })).toMatchObject({ status: 'cancelled' });
    context.beforeAgentWrite = async () => { context.agents.get('agent').prompt = 'Other edit'; };
    expect(await invoke('EditAgent', input)).toMatchObject({ status: 'conflict' });
    expect(context.writes).toEqual([]);
});

test('a context change inside the native lorebook queue cancels the write', async () => {
    const { context, invoke } = await runtime();
    context.beforeLoreWrite = async () => { context.account = 'two'; };
    expect(await invoke('EditLorebookEntry', { book: ' Notes', uid: 0, field: 'content', value: 'Changed' })).toMatchObject({ status: 'cancelled' });
    expect(context.writes).toEqual([]);
});

test('dirty editors and failed character autosaves refuse edits', async () => {
    const { context, invoke } = await runtime();
    context.editorOpen = true;
    expect(await invoke('EditAgent', { id: 'agent', field: 'prompt', value: 'Changed' })).toMatchObject({ status: 'failure' });
    context.editorOpen = false; context.dirtyPreset = true;
    expect(await invoke('EditModelPreset', { apiId: 'openai', name: ' Saved', field: 'temperature', value: 0.5 })).toMatchObject({ status: 'failure' });
    context.characterSave = false;
    expect(await invoke('EditCharacter', { avatar: ' Card.png', field: 'description', value: 'Changed' })).toMatchObject({ status: 'failure' });
    expect(context.writes).toEqual([]);
    context.agentGenerating = true;
    expect(await invoke('EditAgent', { id: 'agent', field: 'prompt', value: 'Changed' })).toMatchObject({ status: 'failure' });
});

test('an entry with only a keyword keeps its raw empty title while its content is edited', async () => {
    const { context, invoke } = await runtime();
    delete context.books.get(' Notes').entries[0].comment;
    context.books.get(' Notes').entries[0].key = ['Keyword'];
    expect(await invoke('ReadLorebookEntry', { book: ' Notes', uid: 0 })).toMatchObject({ entry: { title: '', label: 'Keyword' } });
    expect(await invoke('EditLorebookEntry', { book: ' Notes', uid: 0, field: 'content', value: 'Changed' })).toMatchObject({ status: 'success' });
    expect(context.books.get(' Notes').entries[0].comment).toBeUndefined();
});

test('the visible target editor refreshes after a committed edit', async () => {
    const { context, invoke, refreshEditor } = await runtime();
    context.form = { getAttribute: () => 'editcharacter', getClientRects: () => [{}] };
    expect(await invoke('EditCharacter', { avatar: 'miso.png', field: 'description', value: 'Updated Miso' })).toMatchObject({ status: 'success', committed: true });
    expect(refreshEditor).toHaveBeenCalledWith(0, { switchMenu: false });
});

test('invalid character names and invalid numeric sampler values are rejected', async () => {
    const { context, invoke } = await runtime();
    expect(await invoke('EditCharacter', { avatar: ' Card.png', field: 'name', value: ' ' })).toMatchObject({ status: 'failure' });
    expect(await invoke('EditModelPreset', { apiId: 'openai', name: ' Saved', field: 'n', value: 1.5 })).toMatchObject({ status: 'failure' });
    expect(await invoke('EditModelPreset', { apiId: 'textgenerationwebui', name: ' Saved', field: 'sampler_order', value: [0, null] })).toMatchObject({ status: 'failure' });
    expect(context.writes).toEqual([]);
});

test('valid modern context limits remain editable and same-chat reload renews registration', async () => {
    const { context, tools, invoke } = await runtime();
    expect(await invoke('EditModelPreset', { apiId: 'openai', name: ' Saved', field: 'openai_max_context', value: 32768 })).toMatchObject({ status: 'success' });
    context.generation++;
    tools.syncNeconyanAssistantTools();
    expect(await invoke('ListAgents')).toMatchObject({ status: 'success' });
});

test('a committed character edit cannot refresh another account after the request completes', async () => {
    const { context, invoke, getOneCharacter } = await runtime();
    context.afterCharacterWrite = () => { context.account = 'two'; };
    const result = await invoke('EditCharacter', { avatar: ' Card.png', field: 'description', value: 'Committed' });
    expect(result.committed).toBe(true);
    expect(getOneCharacter).toHaveBeenCalledTimes(2);
    expect(context.events).toEqual([]);
});
