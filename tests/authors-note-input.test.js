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
            for (const method of ['text', 'prop', 'find', 'attr', 'toggleClass', 'addClass', 'removeClass', 'children', 'empty', 'append']) {
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
