import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/personas.js', import.meta.url), 'utf8');
const inputSource = source.slice(source.indexOf('const pendingPersonaDescriptionUpdates'), source.indexOf('async function onPersonaDescriptionDepthValueInput'));
const composeSource = source.slice(source.indexOf('function composePersonaDescription('), source.indexOf('async function setActivePersonaAppendixIds('));

function setup({ named = true, descriptor = true } = {}) {
    const elements = new Map();
    const $ = selector => {
        if (!elements.has(selector)) {
            const element = {
                value: '',
                val: jest.fn(() => element.value),
                text: jest.fn(() => element),
                toggleClass: jest.fn(() => element),
                attr: jest.fn(() => 'No description'),
                find: jest.fn(() => element),
            };
            elements.set(selector, element);
        }
        return elements.get(selector);
    };
    const context = vm.createContext({
        $, user_avatar: 'first.png',
        power_user: {
            personas: named ? { 'first.png': 'First' } : {},
            persona_descriptions: descriptor ? { 'first.png': { description: 'Original' } } : {},
            persona_description: 'Original',
        },
        getActivePersonaAppendices: () => [{ name: 'Active note', description: 'Keep this context.' }],
        countPersonaDescriptionTokens: jest.fn(),
        saveSettingsDebounced: jest.fn(),
        event_types: { PERSONA_UPDATED: 'persona_updated' },
        eventSource: { emit: jest.fn(async (_, avatarId) => {
            if (avatarId === context.user_avatar) context.syncPersonaDescriptionFromDescriptor();
        }) },
        t: strings => strings[0],
        debounce_timeout: { standard: 300 },
        debounce: (callback, timeout) => {
            let timer;
            return () => {
                clearTimeout(timer);
                timer = setTimeout(callback, timeout);
            };
        },
    });
    vm.runInContext(`${composeSource}\n${inputSource}`, context);
    return {
        context, $,
        input(value) {
            $('#persona_description').value = value;
            context.onPersonaDescriptionInput();
        },
    };
}

describe('Persona description typing', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('updates prompt data and schedules saving immediately, but refreshes once after typing stops', async () => {
        const { context, $, input } = setup();
        for (const value of ['A', 'An', 'An edit']) {
            input(value);
            expect(context.power_user.persona_descriptions['first.png'].description).toBe(value);
            expect(context.power_user.persona_description).toBe(`${value}\n\n(Active note)\nKeep this context.`);
            await jest.advanceTimersByTimeAsync(100);
        }
        expect(context.saveSettingsDebounced).toHaveBeenCalledTimes(3);
        expect(context.eventSource.emit).not.toHaveBeenCalled();
        expect($('#persona_effective_description_preview').text).not.toHaveBeenCalled();
        expect(context.countPersonaDescriptionTokens).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(200);
        expect(context.eventSource.emit).toHaveBeenCalledTimes(1);
        expect(context.eventSource.emit).toHaveBeenCalledWith('persona_updated', 'first.png');
        expect($('#persona_effective_description_preview').text).toHaveBeenCalledWith('An edit\n\n(Active note)\nKeep this context.');
        expect(context.countPersonaDescriptionTokens).toHaveBeenCalledTimes(1);
        expect($('.avatar-container[data-avatar-id="first.png"] .ch_description').text).toHaveBeenCalledWith('An edit');
    });

    test('retains both edits when switching personas before the pending refresh', async () => {
        const { context, $, input } = setup();
        input('First edited');
        context.user_avatar = 'second.png';
        context.power_user.personas['second.png'] = 'Second';
        context.power_user.persona_descriptions['second.png'] = { description: 'Second original' };
        input('Second edited');
        await jest.advanceTimersByTimeAsync(300);

        expect(context.eventSource.emit.mock.calls).toEqual([
            ['persona_updated', 'first.png'], ['persona_updated', 'second.png'],
        ]);
        expect(context.power_user.persona_descriptions['first.png'].description).toBe('First edited');
        expect(context.power_user.persona_descriptions['second.png'].description).toBe('Second edited');
        expect(context.power_user.persona_description).toBe('Second edited\n\n(Active note)\nKeep this context.');
        expect($('#persona_effective_description_preview').text).toHaveBeenCalledTimes(1);
        expect($('.avatar-container[data-avatar-id="first.png"] .ch_description').text).toHaveBeenCalledWith('First edited');
    });

    test('does not overwrite the new selection when only the previous persona was edited', async () => {
        const { context, $, input } = setup();
        input('First edited');
        context.user_avatar = 'second.png';
        context.power_user.persona_description = 'Second original';
        await jest.advanceTimersByTimeAsync(300);

        expect(context.eventSource.emit).toHaveBeenCalledWith('persona_updated', 'first.png');
        expect(context.power_user.persona_description).toBe('Second original');
        expect($('#persona_effective_description_preview').text).not.toHaveBeenCalled();
    });

    test('creates missing persona metadata before a delayed refresh', () => {
        const { context, $, input } = setup({ descriptor: false });
        $('#persona_description_position').value = '0';
        $('#persona_depth_value').value = '2';
        $('#persona_depth_role').value = '1';
        input('New description');
        expect(context.power_user.persona_descriptions['first.png']).toMatchObject({
            description: 'New description', position: 0, depth: 2, role: 1, appendices: [], activeAppendices: {},
        });
        expect(context.saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('refreshes the unnamed persona and empty-description placeholder without a persona event', async () => {
        const { context, $, input } = setup({ named: false, descriptor: false });
        input('Unnamed description');
        expect(context.power_user.persona_description).toBe('Unnamed description');
        await jest.advanceTimersByTimeAsync(300);
        expect($('#persona_effective_description_preview').text).toHaveBeenLastCalledWith('Unnamed description');
        input('');
        await jest.advanceTimersByTimeAsync(300);
        expect($('#persona_effective_description_preview').text).toHaveBeenLastCalledWith('[No description]');
        expect($('.avatar-container[data-avatar-id="first.png"] .ch_description').text).toHaveBeenLastCalledWith('No description');
        expect(context.eventSource.emit).not.toHaveBeenCalled();
        expect(context.countPersonaDescriptionTokens).toHaveBeenCalledTimes(2);
    });
});
