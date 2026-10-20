/* global globalThis */
import fs from 'node:fs';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const source = { kind: 'roleplay', key: 'original' };
const chat = [];
let current = true;
let book;
let character;
let selectedAvatar = 'Nova.png';
const saveChatConditional = jest.fn(async () => true);
const updateMessageBlock = jest.fn();
const emit = jest.fn();
const hideChatMessageRange = jest.fn(async () => true);
const deleteMessage = jest.fn(async index => { chat.splice(index, 1); });
const loadWorldInfo = jest.fn(async () => structuredClone(book));
const saveWorldInfo = jest.fn(async () => 'Garden');

jest.unstable_mockModule('../public/script.js', () => ({
    chat, chat_metadata: {}, characters: [], deleteMessage, getOneCharacter: jest.fn(), getRequestHeaders: () => ({}),
    getThumbnailUrl: jest.fn(), name1: 'User', reloadCurrentChat: jest.fn(), saveChatConditional,
    select_selected_character: jest.fn(), syncMesToSwipe: jest.fn(), this_chid: 0, updateMessageBlock, printCharactersDebounced: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/chats.js', () => ({ hideChatMessageRange }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({ event_types: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' }, eventSource: { emit } }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
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
    isCurrentSource: source => current && (source.kind !== 'general' || source.avatar === selectedAvatar),
    sourceCharacters: () => [{ name: 'Nova', avatar: selectedAvatar }],
}));

const { prepareChange } = await import('../public/scripts/scratchpad/changes.js');
const panelSource = fs.readFileSync(new URL('../public/scripts/scratchpad/index.js', import.meta.url), 'utf8');

beforeEach(() => {
    jest.clearAllMocks();
    saveChatConditional.mockReset().mockResolvedValue(true);
    hideChatMessageRange.mockReset().mockResolvedValue(true);
    current = true;
    selectedAvatar = 'Nova.png';
    chat.splice(0, chat.length, { name: 'Nova', mes: 'Original message.', is_system: false });
    book = { entries: { 0: { uid: 0, comment: 'Flower', key: ['flower'], content: 'Original lore.' } } };
    character = { name: 'Nova', data: { alternate_greetings: ['  Original greeting.  ', 'Another scene.\n\n---\n\nThe same greeting continues.'] } };
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: true, headers: { get: () => 'a'.repeat(64) }, json: async () => structuredClone(character) }));
});

afterEach(() => jest.restoreAllMocks());

describe('Scratchpad reviewed saves', () => {
    test.each(['review', 'save'])('General waits for pending sharing settings before %s and refuses an unshared card', async stage => {
        let release;
        const queued = new Promise(resolve => { release = resolve; });
        let shared = true;
        const app = { source: { kind: 'general', key: 'general', avatar: selectedAvatar }, queue: stage === 'review' ? queued : Promise.resolve() };
        const commit = jest.fn();
        const prepare = jest.fn(async () => ({ before: 'Old.', after: 'New.', editable: false, commit }));
        const errors = [];
        const popup = jest.fn(async () => { app.queue = queued; return 1; });
        const runtime = vm.createContext({ app, prepareChange: prepare, currentSettings: () => ({ include: { card: shared } }),
            sameChat: () => true, requireScope() {}, reportError: error => errors.push(error.message),
            h: () => ({}), changeDiff: () => ({}), callGenericPopup: popup, POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1 },
            committedChanges: new Set(), toastr: { success: jest.fn() }, markChange: async () => true,
            t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
        });
        vm.runInContext(panelSource.match(/^async function reviewAndSaveChange\([\s\S]*?^}/m)[0], runtime);
        const pending = runtime.reviewAndSaveChange({ id: 'session' }, { sharedAvatar: selectedAvatar }, { change: { type: 'character', action: 'replace' } }, 'change');
        for (let i = 0; i < 6; i++) await Promise.resolve();
        expect(commit).not.toHaveBeenCalled();
        expect(prepare).toHaveBeenCalledTimes(stage === 'review' ? 0 : 1);
        shared = false;
        release();
        await pending;
        expect(commit).not.toHaveBeenCalled();
        expect(errors[0]).toMatch(/share the selected card|Share the selected character card/);
    });
    test.each(['edit', 'insert', 'hide', 'unhide', 'delete'])('General rejects message %s without touching the hidden chat', async action => {
        await expect(prepareChange({ type: 'chat', action, message: 0, after: 0, text: 'New.' }, { kind: 'general', key: 'general', avatar: selectedAvatar })).rejects.toThrow('Roleplay chats');
        expect(chat[0].mes).toBe('Original message.');
        expect(saveChatConditional).not.toHaveBeenCalled();
    });

    test.each(['add', 'edit', 'delete'])('General rejects lorebook %s before loading lore', async action => {
        await expect(prepareChange({ type: 'lorebook', action, book: 'Garden', uid: 0, content: 'New.' }, { kind: 'general', key: 'general', avatar: selectedAvatar })).rejects.toThrow('does not share lorebooks');
        expect(loadWorldInfo).not.toHaveBeenCalled();
    });

    test('General permits new-character creation only after review approval', async () => {
        const general = { kind: 'general', key: 'general', avatar: selectedAvatar };
        const plan = await prepareChange({ type: 'character', action: 'create', character: { name: 'New Nova' } }, general);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        globalThis.fetch.mockResolvedValueOnce({ ok: true, text: async () => 'New Nova.png' });
        await expect(plan.commit(plan.after)).resolves.toMatchObject({ committed: true });
    });

    test('General requires its selected card to have been shared and refuses a card swap during review', async () => {
        const general = { kind: 'general', key: 'general', avatar: selectedAvatar };
        const change = { type: 'character', character: 'Nova', field: 'description', value: 'New.' };
        await expect(prepareChange(change, general)).rejects.toThrow('Share the selected');
        await expect(prepareChange({ ...change, character: 'Kit' }, general, { sharedAvatar: selectedAvatar })).rejects.toThrow('selected, shared character');
        const plan = await prepareChange(change, general, { sharedAvatar: selectedAvatar });
        selectedAvatar = 'Other Nova.png';
        await expect(plan.commit(plan.after)).rejects.toThrow('changed');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        selectedAvatar = general.avatar;
        await expect(plan.commit(plan.after)).resolves.toBeUndefined();
        expect(JSON.parse(globalThis.fetch.mock.calls[1][1].body).avatar).toBe(general.avatar);
    });
    test('creates the reviewed character only on save, including its note and greetings', async () => {
        const plan = await prepareChange({ type: 'character', action: 'create', character: { name: 'New Nova', description: 'Draft.' },
            characterNote: '[curious;]', alternateGreetings: ['First alternate.', 'Second alternate.'] }, source);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        const edited = JSON.parse(plan.after);
        edited.character.description = 'Reviewed description.';
        globalThis.fetch.mockResolvedValueOnce({ ok: true, text: async () => 'New Nova.png' });
        await expect(plan.commit(JSON.stringify(edited))).resolves.toMatchObject({ committed: true, avatar: 'New Nova.png' });
        const [url, options] = globalThis.fetch.mock.calls[0];
        expect(url).toBe('/api/characters/create');
        expect(options.body.get('ch_name')).toBe('New Nova');
        expect(options.body.get('description')).toBe('Reviewed description.');
        expect(options.body.get('depth_prompt_prompt')).toBe('[curious;]');
        expect(options.body.getAll('alternate_greetings')).toEqual(['First alternate.', 'Second alternate.']);
        expect(options.body.has('avatar')).toBe(false);
        await plan.commit(JSON.stringify(edited));
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    test('recovers nested draft fields for review and revalidates conflicts before saving', async () => {
        const plan = await prepareChange({ type: 'character', action: 'create', character: { name: 'New Nova',
            characterNote: '  Keep this note.\n', alternate_greetings: ['  Keep this greeting.\n'] } }, source);
        const edited = JSON.parse(plan.after);
        expect(edited).toEqual({ character: { name: 'New Nova' }, characterNote: '  Keep this note.\n',
            alternateGreetings: ['  Keep this greeting.\n'], avatarPrompt: '' });
        expect(globalThis.fetch).not.toHaveBeenCalled();
        edited.character.characterNote = 'Conflicting note.';
        await expect(plan.commit(JSON.stringify(edited))).rejects.toThrow('Conflicting values');
        expect(globalThis.fetch).not.toHaveBeenCalled();
        delete edited.character.characterNote;
        globalThis.fetch.mockResolvedValueOnce({ ok: true, text: async () => 'New Nova.png' });
        await plan.commit(JSON.stringify(edited));
        const [, options] = globalThis.fetch.mock.calls[0];
        expect(options.body.get('depth_prompt_prompt')).toBe(edited.characterNote);
        expect(options.body.getAll('alternate_greetings')).toEqual(edited.alternateGreetings);
    });

    test('two saves started together on one review create the character once', async () => {
        const plan = await prepareChange({ type: 'character', action: 'create', character: { name: 'New Nova' } }, source);
        globalThis.fetch.mockResolvedValueOnce({ ok: true, text: async () => 'New Nova.png' });
        const [first, second] = await Promise.all([plan.commit(plan.after), plan.commit(plan.after)]);
        expect(second).toBe(first);
        expect(globalThis.fetch.mock.calls.filter(([url]) => url === '/api/characters/create')).toHaveLength(1);
    });

    test('a failed character save can be retried from the same review', async () => {
        const plan = await prepareChange({ type: 'character', action: 'create', character: { name: 'New Nova' } }, source);
        globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Failed' });
        await expect(plan.commit(plan.after)).rejects.toThrow('Character creation failed');
        globalThis.fetch.mockResolvedValueOnce({ ok: true, text: async () => 'New Nova.png' });
        await expect(plan.commit(plan.after)).resolves.toMatchObject({ committed: true, avatar: 'New Nova.png' });
    });

    test('refuses invalid reviewed character JSON and a source switch before creation', async () => {
        const plan = await prepareChange({ type: 'character', action: 'create', character: { name: 'Nova' } }, source);
        await expect(plan.commit('{')).rejects.toThrow('valid JSON');
        await expect(plan.commit('{"character":{"name":"../Nova"}}')).rejects.toThrow('path separators');
        current = false;
        await expect(plan.commit(plan.after)).rejects.toThrow('changed');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('an unavailable avatar provider or failed save leaves the draft unapplied', async () => {
        const image = await prepareChange({ type: 'character', action: 'create', character: { name: 'Nova' }, avatarPrompt: 'A portrait.' }, source);
        await expect(image.commit(image.after)).rejects.toThrow('Quick Image Gen');
        expect(globalThis.fetch).not.toHaveBeenCalled();
        const plain = await prepareChange({ type: 'character', action: 'create', character: { name: 'Nova' } }, source);
        globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Failed' });
        await expect(plain.commit(plain.after)).rejects.toThrow('Character creation failed');
    });

    test.each([false, true])('appends reviewed greetings after the saved list, empty=%s', async empty => {
        character.data.alternate_greetings = empty ? [] : character.data.alternate_greetings;
        const existing = structuredClone(character.data.alternate_greetings);
        const plan = await prepareChange({ type: 'character', action: 'append', character: 'Nova', field: 'alternate_greetings', value: ['Proposed greeting.'] }, source);
        expect(plan.after).toBe('Proposed greeting.');
        expect(plan.getAfterText('Reviewed greeting.\n\n---\n\nOne more greeting.')).toBe([...existing, 'Reviewed greeting.', 'One more greeting.'].join('\n\n---\n\n'));
        await plan.commit('Reviewed greeting.\n\n---\n\nOne more greeting.');
        const body = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
        expect(body).toEqual({ avatar: 'Nova.png', expected_revision: 'a'.repeat(64), data: { alternate_greetings: [...existing, 'Reviewed greeting.', 'One more greeting.'] } });
        expect(character.data.alternate_greetings).toEqual(existing);
    });

    test('does not save an empty greeting addition after editing the review', async () => {
        const plan = await prepareChange({ type: 'character', action: 'append', character: 'Nova', field: 'alternate_greetings', value: ['Proposed greeting.'] }, source);
        await expect(plan.commit('   ')).rejects.toThrow('no new greetings');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    test('keeps whole-list replacement available for older greeting changes', async () => {
        const plan = await prepareChange({ type: 'character', character: 'Nova', field: 'alternate_greetings', value: ['Replacement.'] }, source);
        await plan.commit(plan.after);
        expect(JSON.parse(globalThis.fetch.mock.calls[1][1].body).data.alternate_greetings).toEqual(['Replacement.']);
    });

    test.each([
        { type: 'lorebook', action: 'delete', book: 'Garden', uid: 0 },
        { type: 'chat', action: 'delete', message: 0 },
    ])('reviews $type deletion as removed text without a placeholder addition', async change => {
        const plan = await prepareChange(change, source);
        expect(plan.before).toContain(change.type === 'chat' ? 'Original message.' : 'Original lore.');
        expect(plan.after).toBe('');
        expect(plan.editable).toBe(false);
    });

    test.each(['add', 'edit', 'delete'])('refuses a lorebook %s after switching chats during the review', async action => {
        const plan = await prepareChange({ type: 'lorebook', action, book: 'Garden', uid: 0, content: 'New lore.' }, source);
        current = false;
        await expect(plan.commit(plan.after)).rejects.toThrow('changed');
        expect(saveWorldInfo).not.toHaveBeenCalled();
    });

    test('does not report a discarded lorebook save as successful', async () => {
        const plan = await prepareChange({ type: 'lorebook', action: 'edit', book: 'Garden', uid: 0, content: 'New lore.' }, source);
        saveWorldInfo.mockResolvedValueOnce(null);
        await expect(plan.commit(plan.after)).rejects.toThrow('not saved');
    });

    test('refuses lore changed after review and saves a fresh review', async () => {
        const change = { type: 'lorebook', action: 'edit', book: 'Garden', uid: 0, content: 'New lore.' };
        const old = await prepareChange(change, source);
        book.entries[0].content = 'Another edit.';
        await expect(old.commit(old.after)).rejects.toThrow('changed');
        expect(saveWorldInfo).not.toHaveBeenCalled();
        const fresh = await prepareChange(change, source);
        await fresh.commit(fresh.after);
        expect(saveWorldInfo.mock.calls[0][1].entries[0].content).toBe('New lore.');
    });

    test.each(['edit', 'insert', 'delete', 'hide', 'unhide'])('does not report a failed message %s as successful', async action => {
        const plan = await prepareChange({ type: 'chat', action, message: 0, after: 0, text: 'New message.' }, source);
        saveChatConditional.mockResolvedValueOnce(false);
        hideChatMessageRange.mockResolvedValueOnce(false);
        await expect(plan.commit(plan.after)).rejects.toThrow('saved');
    });

    test.each(['edit', 'insert', 'delete', 'hide', 'unhide'])('accepts a saved message %s', async action => {
        const plan = await prepareChange({ type: 'chat', action, message: 0, after: 0, text: 'New message.' }, source);
        await expect(plan.commit(plan.after)).resolves.toBeUndefined();
    });

    test('does not render or save a message edit into the newly selected chat', async () => {
        const plan = await prepareChange({ type: 'chat', action: 'edit', message: 0, text: 'New message.' }, source);
        emit.mockImplementationOnce(async () => { current = false; });
        await expect(plan.commit(plan.after)).rejects.toThrow('changed');
        expect(updateMessageBlock).not.toHaveBeenCalled();
        expect(saveChatConditional).not.toHaveBeenCalled();
    });
});
