import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as profiles from '../public/scripts/authors-note-profiles.js';

// Exercise the real module with its browser dependencies replaced, including the shared
// profile logic. script.js cannot be imported directly in Jest.
const source = readFileSync(new URL('../public/scripts/authors-note.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/^export \{[^}]*\};\n/gm, '')
    .replace(/^export /gm, '');
const utils = readFileSync(new URL('../public/scripts/utils.js', import.meta.url), 'utf8');
const timing = ['debounce', 'cancelDebounce'].map(name => utils.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0]).join('\n');

function setup({ group = false } = {}) {
    const elements = new Map();
    const $ = selector => {
        if (typeof selector === 'object') return selector;
        if (!elements.has(selector)) {
            const element = { value: '', length: 0, get: () => undefined };
            element.val = jest.fn(function (value) {
                if (!arguments.length) return element.value;
                element.value = value;
                return element;
            });
            for (const method of ['text', 'prop', 'find', 'attr', 'toggleClass', 'addClass', 'removeClass', 'children', 'empty', 'append', 'trigger']) {
                element[method] = jest.fn(() => element);
            }
            elements.set(selector, element);
        }
        return elements.get(selector);
    };
    const chat = { characterId: 0, characters: [{ avatar: 'Miso.png', name: 'Miso' }], userAvatar: 'first.png',
        groupId: group ? 'group-one' : '', chat: [], setExtensionPrompt: jest.fn() };
    const context = vm.createContext({
        ...profiles, $, getContext: () => chat,
        getCharaFilename: (_, { manualAvatarKey }) => manualAvatarKey.replace(/\.png$/, ''),
        chat_metadata: {}, extension_settings: { note: { default: 'Default note', chara: [], persona: {} } },
        power_user: { personas: {} }, groups: [], getGroupMembers: () => [], getSelectedGroupSpeakerAvatar: () => '',
        getThumbnailUrl: () => '', getTokenCountAsync: jest.fn(async () => 1),
        saveSettingsDebounced: jest.fn(), saveMetadataDebounced: jest.fn(),
        extension_prompt_roles: { SYSTEM: 0 }, extension_prompt_types: { NONE: -1 }, MAX_INJECTION_DEPTH: 10000,
        debounce_timeout: { short: 200, standard: 300 }, setTimeout, clearTimeout,
        t: (strings, ...values) => String.raw({ raw: strings }, ...values),
        console: { debug: jest.fn(), warn: jest.fn() }, Option: function () {},
        uuidv4: jest.fn(() => 'created-note'),
        Popup: { show: { input: jest.fn(), confirm: jest.fn() } }, POPUP_RESULT: { AFFIRMATIVE: 1 },
        toastr: { info: jest.fn(), error: jest.fn() },
    });
    vm.runInContext(`const debounceMap = new Map();\n${timing}\n${source}`, context);
    const loadSettings = context.loadSettings;
    context.loadSettings = jest.fn(() => loadSettings());
    return { context, chat, $, input: (selector, value, handler) => {
        $(selector).value = value;
        context[handler].call($(selector));
    } };
}

describe('Author\'s Note typing', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test.each(['chat', 'defaults'])('%s text and prompt update before the display refresh', async (slot) => {
        const { context, chat, $, input } = setup();
        const isChat = slot === 'chat';
        const selector = isChat ? '#extension_floating_prompt' : '#extension_floating_default';
        const handler = isChat ? 'onExtensionFloatingPromptInput' : 'onExtensionFloatingDefaultInput';
        $('#extension_floating_prompt').value = 'Stale display';
        for (const value of ['A', 'An', 'An edit']) {
            input(selector, value, handler);
            expect(isChat ? context.chat_metadata.note_prompt : context.extension_settings.note.default).toBe(value);
            expect(chat.setExtensionPrompt.mock.lastCall[1]).toBe(value);
            await jest.advanceTimersByTimeAsync(50);
        }
        expect(context.saveSettingsDebounced).toHaveBeenCalledTimes(3);
        expect(context.saveMetadataDebounced).toHaveBeenCalledTimes(isChat ? 3 : 0);
        expect(context.loadSettings).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(300);
        expect(context.loadSettings).toHaveBeenCalledTimes(1);
        expect($(selector).value).toBe('An edit');
    });

    test.each(['chara', 'group', 'persona'])('%s profiles and legacy mirrors are current before refresh', async (kind) => {
        const { context, chat } = setup({ group: kind === 'group' });
        const slot = kind === 'persona' ? 'persona' : 'chara';
        context.onNoteEnabledChanged(slot, true);
        context.loadSettings.mockClear();
        context.saveSettingsDebounced.mockClear();
        context.saveMetadataDebounced.mockClear();
        for (const value of ['A', 'An', 'An edit']) {
            context.onNotePromptInput(slot, value);
            expect(chat.setExtensionPrompt.mock.lastCall[1]).toBe(value);
            await jest.advanceTimersByTimeAsync(50);
        }
        const note = kind === 'group' ? context.chat_metadata.note_chara
            : kind === 'persona' ? context.extension_settings.note.persona['first.png'] : context.extension_settings.note.chara[0];
        expect(note.prompt).toBe('An edit');
        expect(note.profiles[0].prompt).toBe('An edit');
        expect(context.saveSettingsDebounced).toHaveBeenCalledTimes(kind === 'group' ? 0 : 3);
        expect(context.saveMetadataDebounced).toHaveBeenCalledTimes(kind === 'group' ? 3 : 0);
        expect(context.loadSettings).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(300);
        expect(context.loadSettings).toHaveBeenCalledTimes(1);
    });

    test('a persona switch before refresh preserves both notes and displays the current persona', async () => {
        const { context, chat, $ } = setup();
        context.onNotePromptInput('persona', 'First edit');
        chat.userAvatar = 'second.png';
        context.onNotePromptInput('persona', 'Second edit');
        await jest.advanceTimersByTimeAsync(300);
        expect(context.extension_settings.note.persona['first.png'].prompt).toBe('First edit');
        expect(context.extension_settings.note.persona['second.png'].prompt).toBe('Second edit');
        expect($('#extension_floating_persona').value).toBe('Second edit');
    });

    test('switching the open character profile keeps its edit even when it is not in use', async () => {
        const { context, $ } = setup();
        context.extension_settings.note.chara.push({ name: 'individual:Miso', useChara: true, activeProfiles: ['first'], profiles: [
            { id: 'first', name: 'First', prompt: 'Active', position: 0 },
            { id: 'second', name: 'Second', prompt: 'Inactive', position: 0 },
        ] });
        context.onCharaNoteOpened('second');
        context.onNotePromptInput('chara', 'Inactive edited');
        context.onCharaNoteOpened('first');
        await jest.advanceTimersByTimeAsync(300);
        expect(context.extension_settings.note.chara[0].profiles[1].prompt).toBe('Inactive edited');
        expect($('#extension_floating_chara').value).toBe('Active');
    });

    test('an immediate control change cancels the pending redundant redraw', async () => {
        const { context, $ } = setup();
        context.onNotePromptInput('persona', 'Typed');
        context.onNoteEnabledChanged('persona', true);
        expect(context.loadSettings).toHaveBeenCalledTimes(1);
        expect($('#extension_floating_persona').value).toBe('Typed');
        await jest.advanceTimersByTimeAsync(300);
        expect(context.loadSettings).toHaveBeenCalledTimes(1);
    });

    test('changing chats before the refresh never applies the old text to the new chat', async () => {
        const { context, $, input } = setup();
        input('#extension_floating_prompt', 'First chat edit', 'onExtensionFloatingPromptInput');
        const firstChat = context.chat_metadata;
        context.chat_metadata = { note_prompt: 'Second chat note' };
        await context.onChatChanged();
        await jest.advanceTimersByTimeAsync(300);
        expect(firstChat.note_prompt).toBe('First chat edit');
        expect(context.chat_metadata.note_prompt).toBe('Second chat note');
        expect($('#extension_floating_prompt').value).toBe('Second chat note');
        expect(context.loadSettings).toHaveBeenCalledTimes(1);
    });
});

describe('Character note libraries per persona', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function seed(context, group) {
        const note = { name: 'individual:Miso', useChara: true, perPersona: true,
            profiles: [
                { id: 'tone', name: 'Tone', prompt: 'Gentle', position: 2 },
                { id: 'setting', name: 'Setting', prompt: 'Garden', position: 1 },
            ], activeProfile: 'tone', activeProfiles: ['tone'],
            personaActiveProfiles: { 'first.png': ['tone'], 'second.png': ['setting'] } };
        if (group) context.chat_metadata.note_chara = note;
        else context.extension_settings.note.chara = [note];
        return () => group ? context.chat_metadata.note_chara : context.extension_settings.note.chara[0];
    }

    test.each([false, true])('edits, names, new notes and deletion are isolated (group: %s)', async group => {
        const { context, chat } = setup({ group });
        const saved = seed(context, group);
        context.onCharaNoteOpened('tone');
        context.onNotePromptInput('chara', 'First tone');
        context.onNotePositionChanged('chara', 1);
        context.Popup.show.input.mockResolvedValueOnce('First only');
        await context.onRenameNoteProfile('chara');
        context.Popup.show.input.mockResolvedValueOnce('Extra');
        await context.onNewNoteProfile('chara');
        context.onNotePromptInput('chara', 'Extra text');
        expect(profiles.resolveActiveNoteProfiles(saved(), 'first.png').map(note => note.prompt)).toEqual(['First tone', 'Extra text']);
        chat.userAvatar = 'second.png';
        context.onCharaNoteOpened('tone');
        expect(context.getNoteView('chara', saved()).profile).toMatchObject({ name: 'Tone', prompt: 'Gentle', position: 2 });
        context.onNotePromptInput('chara', 'Second tone');
        context.onCharaNoteMixChanged('tone', true);
        context.Popup.show.confirm.mockResolvedValueOnce(1);
        await context.onDeleteNoteProfile('chara');
        expect(profiles.getNoteProfiles(saved(), 'second.png').map(note => note.id)).toEqual(['setting']);
        expect(profiles.getActiveNoteProfileIds(saved(), 'second.png')).toEqual(['setting']);
        chat.userAvatar = 'first.png';
        context.onCharaNoteOpened('tone');
        expect(context.getNoteView('chara', saved()).profile).toMatchObject({ name: 'First only', prompt: 'First tone', position: 1 });
        expect(profiles.getNoteProfiles(saved(), 'first.png')).toHaveLength(3);
        expect(saved().profiles[0].prompt).toBe('Gentle');
    });

    test('shared mode and persona libraries survive toggling, serialisation and an empty mix', () => {
        const { context, chat } = setup();
        const saved = seed(context, false);
        context.onNotePromptInput('chara', 'First tone');
        context.onCharaNoteMixChanged('tone', false);
        context.onCharaPerPersonaChanged(false);
        expect(context.getNoteView('chara', saved()).profile.prompt).toBe('Gentle');
        context.onNotePromptInput('chara', 'Shared tone');
        context.onCharaPerPersonaChanged(true);
        expect(context.getNoteView('chara', saved()).profile.prompt).toBe('First tone');
        expect(profiles.getActiveNoteProfileIds(saved(), 'first.png')).toEqual([]);
        context.extension_settings.note.chara = JSON.parse(JSON.stringify(context.extension_settings.note.chara));
        chat.userAvatar = 'second.png';
        context.onCharaNoteOpened('setting');
        context.onNotePromptInput('chara', 'Second garden');
        chat.userAvatar = 'first.png';
        expect(profiles.getActiveNoteProfileIds(saved(), 'first.png')).toEqual([]);
        expect(profiles.resolveNoteProfile(saved(), 'first.png').prompt).toBe('First tone');
        context.onNoteEnabledChanged('chara', false);
        context.onCharaPerPersonaChanged(false);
        context.onNotePromptInput('chara', '');
        expect(saved().personaNoteLibraries['first.png'].profiles[0].prompt).toBe('First tone');
    });

    test.each([false, true])('deleting a persona clears its library and legacy picks (group: %s)', group => {
        const { context, chat } = setup({ group });
        const saved = seed(context, group);
        context.onNotePromptInput('chara', 'First tone');
        chat.userAvatar = 'second.png';
        context.onNotePromptInput('chara', 'Second tone');
        context.onPersonaDeleted({ avatarId: 'first.png' });
        expect(saved().personaNoteLibraries['first.png']).toBeUndefined();
        expect(saved().personaActiveProfiles['first.png']).toBeUndefined();
        expect(saved().personaNoteLibraries['second.png']).toBeDefined();
    });

    test('switching to shared notes preserves unedited legacy persona collections', () => {
        const { context, chat } = setup();
        const saved = seed(context, false);
        context.onCharaPerPersonaChanged(false);
        context.onNotePromptInput('chara', 'Changed shared tone');
        context.onCharaNoteOpened('setting');
        context.onNotePromptInput('chara', 'Changed shared setting');
        context.onCharaPerPersonaChanged(true);
        chat.userAvatar = 'second.png';
        expect(profiles.resolveActiveNoteProfiles(saved(), 'second.png')).toMatchObject([{ prompt: 'Garden' }]);
        expect(profiles.getNoteProfiles(saved(), 'second.png')[0].prompt).toBe('Gentle');
    });

    test.each(['onNewNoteProfile', 'onRenameNoteProfile', 'onDeleteNoteProfile'])('%s ignores a dialog completed after switching personas', async handler => {
        const { context, chat } = setup();
        const saved = seed(context, false);
        let finish;
        const answer = new Promise(resolve => { finish = resolve; });
        context.Popup.show.input.mockReturnValue(answer);
        context.Popup.show.confirm.mockReturnValue(answer);
        const pending = context[handler]('chara');
        chat.userAvatar = 'second.png';
        finish(handler === 'onDeleteNoteProfile' ? 1 : 'Wrong persona');
        await pending;
        expect(saved().profiles).toHaveLength(2);
        expect(saved().profiles[0]).toMatchObject({ name: 'Tone', prompt: 'Gentle' });
        expect(saved().personaNoteLibraries).toBeUndefined();
    });
});
