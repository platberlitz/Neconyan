import { readFile } from 'node:fs/promises';
import { beforeEach, expect, jest, test } from '@jest/globals';

const chat = [];
const chatMetadata = {};
const saveMetadata = jest.fn(async () => true);
let generation = 1;

global.toastr = { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() };
global.window = Object.assign(new EventTarget(), { clearTimeout: jest.fn(), setTimeout: jest.fn() });
global.document = { querySelectorAll: () => [] };

jest.unstable_mockModule('../public/scripts/user.js', () => ({
    getCurrentUserHandle: () => 'default-user', currentUser: { handle: 'default-user' },
}));
jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ avatar: 'Mara.png' }], this_chid: 0, chat_metadata: chatMetadata, is_send_press: false, chat,
    getCurrentChatId: () => 'first', getChatGeneration: () => generation, getMaxContextTokens: () => 100000,
    flushPendingChatSaves: async () => true, getRequestHeaders: () => ({}), saveMetadata,
    saveChatConditional: jest.fn(async () => true), getChat: jest.fn(async () => true),
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    is_group_generating: false, selected_group: null, getGroupChat: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({
    getRoleplaySourceId: () => '', roleplayAccountStamp: () => ({}),
}));
const retryJob = jest.fn(async id => (await fetch(`/api/jobs/${id}/retry`, { method: 'POST' })).json());
const dismissJob = jest.fn(async id => (await fetch(`/api/jobs/${id}/dismiss`, { method: 'POST' })).json());
jest.unstable_mockModule('../public/scripts/jobs.js', () => ({
    cancelJob: jest.fn(), retryJob, dismissJob,
}));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    getFriendlyTokenizerName: () => ({ tokenizerKey: 'openai' }),
}));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    POPUP_TYPE: { CONFIRM: 'confirm' }, POPUP_RESULT: { AFFIRMATIVE: 1 }, Popup: class { show() { return 1; } },
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({ uuidv4: () => 'test-uuid' }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({
    conversationState: { conversationWorkspaceOpen: false },
}));
jest.unstable_mockModule('../public/scripts/mewmory/rag-settings.js', () => ({
    PREFIX_PRESETS: {}, RAG_DEFAULTS: {},
}));
jest.unstable_mockModule('../public/scripts/events.js', () => ({
    event_types: new Proxy({}, { get: (_, name) => name }),
    eventSource: { on: jest.fn() },
}));

const { act, manualHideDisabled } = await import('../public/scripts/mewmory/ui.js');
const { initMewmory, MEWMORY_CONFIG_CHANGED_KEY, mewmory, refreshMewmory } = await import('../public/scripts/mewmory/index.js');
const { mewmoryConfigAutosave } = await import('../public/scripts/mewmory/config-autosave.js');

const config = { revision: 1, roles: {}, autoHideTokens: 30 };
const response = data => ({ ok: true, json: async () => data });
const settle = async () => {
    for (let step = 0; step < 10; step++) await new Promise(resolve => setTimeout(resolve, 0));
};

let gate;
let inspects;
beforeEach(() => {
    generation++;
    Object.keys(chatMetadata).forEach(key => delete chatMetadata[key]);
    chat.splice(0);
    retryJob.mockClear();
    dismissJob.mockClear();
    for (const method of Object.values(global.toastr)) method.mockClear();
    gate = Promise.withResolvers();
    inspects = 0;
    global.fetch = jest.fn(async (url, { body } = {}) => {
        const parsed = body ? JSON.parse(body) : {};
        if (url.endsWith('config/get')) return response({ config, stories: [] });
        if (url.endsWith('inspect')) {
            const revision = ++inspects;
            if (revision === 1) await gate.promise;
            return response({
                locator: parsed.locator, enabled: true, revision, health: { pending: 0 },
                operations: revision === 1
                    ? [{ id: 'job-old', state: 'failed', label: 'Memory update', error: { message: 'Old failure' } }]
                    : [{ id: 'job-new', state: 'queued', label: 'Memory update' }],
            });
        }
        if (url.includes('/api/jobs/')) return response({ job: { id: 'job-new', state: 'queued' } });
        return response({});
    });
    Object.assign(mewmory, { view: null, config: null, filters: {}, error: '', loading: false, busy: false, preparing: false });
});

test('a settings save notifies other tabs and refreshes their cached config', async () => {
    initMewmory();
    const setItem = jest.fn();
    global.window.localStorage = { setItem };
    const onSaved = mewmoryConfigAutosave.options.onSaved;
    expect(onSaved).toEqual(expect.any(Function));

    onSaved({ revision: 7, roles: {} });
    expect(setItem).toHaveBeenCalledWith(MEWMORY_CONFIG_CHANGED_KEY, '7');
    await settle();

    fetch.mockClear();
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: MEWMORY_CONFIG_CHANGED_KEY });
    Object.defineProperty(event, 'newValue', { value: '8' });
    global.window.dispatchEvent(event);
    await settle();
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('config/get'))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('inspect'))).toHaveLength(1);
    delete global.window.localStorage;
});

test('an older server error is shown with the current field label', async () => {
    global.fetch = jest.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Hide messages beyond, tokens must be between 1024 and 2000000.' }),
    }));
    await expect(mewmoryConfigAutosave.options.save({}, { account: null }))
        .rejects.toThrow('Hide older messages at this chat size, tokens must be between 1024 and 2000000.');
});

test('manual hiding stays available during a memory update and off remains disabled', async () => {
    mewmory.busy = true;
    expect(manualHideDisabled({ enabled: true })).toBe(false);
    expect(manualHideDisabled({ enabled: false })).toBe(true);
    const source = await readFile(new URL('../public/scripts/mewmory/ui.js', import.meta.url), 'utf8');
    expect(source).toContain('{ disabled: manualHideDisabled(view) }');
});

async function holdInspectionThenAct(action) {
    const stale = refreshMewmory();
    await settle();
    expect(inspects).toBe(1);

    const acting = act(() => action('job-old'));
    await settle();
    const heldInspects = inspects;

    gate.resolve();
    await Promise.all([acting, stale]);
    return { heldInspects };
}

test('a held inspection cannot answer the panel refresh after a job retry', async () => {
    const { heldInspects } = await holdInspectionThenAct(retryJob);
    expect(retryJob).toHaveBeenCalledWith('job-old');
    expect(heldInspects).toBe(2);
    expect(mewmory.view.operations[0].state).toBe('queued');
    expect(mewmory.busy).toBe(true);
    expect(mewmory.error).toBe('');
});

test('a held inspection cannot answer the panel refresh after a job dismiss', async () => {
    const { heldInspects } = await holdInspectionThenAct(dismissJob);
    expect(dismissJob).toHaveBeenCalledWith('job-old');
    expect(heldInspects).toBe(2);
    expect(mewmory.view.operations[0].state).toBe('queued');
    expect(mewmory.busy).toBe(true);
    expect(mewmory.error).toBe('');
});

test('earlier versions mark the words that were added and removed', async () => {
    const { wordChanges } = await import('../public/scripts/mewmory/ui.js');
    expect(wordChanges('Mara accepted the gift.', 'Mara accepted the gift.')).toEqual([['same', 'Mara accepted the gift.']]);
    const parts = wordChanges('Mara accepted the gift.', 'Mara quietly accepted the parcel.');
    expect(parts.filter(([type]) => type !== 'removed').map(([, text]) => text).join('')).toBe('Mara quietly accepted the parcel.');
    expect(parts.filter(([type]) => type !== 'added').map(([, text]) => text).join('')).toBe('Mara accepted the gift.');
    expect(parts.filter(([type]) => type === 'added').map(([, text]) => text.trim())).toEqual(['quietly', 'parcel.']);
    expect(parts.filter(([type]) => type === 'removed').map(([, text]) => text.trim())).toEqual(['gift.']);
    expect(wordChanges('', 'New text')).toEqual([['added', 'New text']]);
    const long = Array.from({ length: 700 }, (_, index) => 'word' + index).join(' ');
    expect(wordChanges(long, long + ' more')).toEqual([['removed', long], ['added', long + ' more']]);
});

test('the update estimate says what will be read and warns about the daily limit', async () => {
    const { estimateText } = await import('../public/scripts/mewmory/ui.js');
    expect(estimateText({ messages: 0 })).toEqual(['Nothing is waiting. Every message in this chat already has its memories.']);
    const first = estimateText({ messages: 1, batches: 1, messageTokens: 900, tokens: null, enabled: true, overLimit: false });
    expect(first[0]).toBe('1 message to read in about 1 model request.');
    expect(first[1]).toMatch(/^The messages add up to about .*real figure is higher\.$/);
    const later = estimateText({ messages: 24, batches: 2, messageTokens: 5000, tokens: 2200, enabled: false, overLimit: true });
    expect(later[0]).toBe('24 messages to read in about 2 model requests.');
    expect(later[1]).toMatch(/^Expected use: about .*earlier updates in this chat\.$/);
    expect(later).toContain('This would go past your daily token limit. Updates you start yourself still run.');
    expect(later.some(line => line.startsWith('Facts and events is switched off'))).toBe(true);
});

test('a file with every chat restores only the memories that belong to this chat', async () => {
    const { pickRestoreBackup } = await import('../public/scripts/mewmory/ui.js');
    const single = { format: 'mewmory-export-1', state: { storyId: 's1' } };
    expect(pickRestoreBackup(single, { storyId: 'other' })).toBe(single);
    const all = { format: 'mewmory-export-all-1', exportedAt: 9, chats: [
        { locator: { chat: 'A' }, exportedAt: 5, state: { storyId: 's1', branchId: 'b1' } },
        { locator: { chat: 'B' }, state: { storyId: 's2', branchId: 'b2' } },
    ] };
    expect(pickRestoreBackup(all, { storyId: 's1', branchId: 'b1' })).toEqual({ format: 'mewmory-export-1', exportedAt: 5, state: all.chats[0].state });
    expect(pickRestoreBackup(all, { storyId: 'x', branchId: 'y', locator: { chat: 'B' } })).toEqual({ format: 'mewmory-export-1', exportedAt: 9, state: all.chats[1].state });
    expect(() => pickRestoreBackup(all, { storyId: 'x', branchId: 'y', locator: { chat: 'C' } })).toThrow('This file has no memories for this chat.');
});
