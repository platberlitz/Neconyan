/* global globalThis */
import { beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

const home = { visible: false };
globalThis.document = { body: { classList: { contains: () => home.visible } } };
const { event_types, eventSource } = await import('../public/scripts/events.js');
const { clearHomePersonaChoice, homePersonaChoice, wireHomePersonaChoice } = await import('../public/scripts/scratchpad/home-persona.js');

beforeAll(() => wireHomePersonaChoice());

beforeEach(() => {
    home.visible = false;
    clearHomePersonaChoice();
});

describe('Home persona choice driven by real events', () => {
    test('a switch made by the user while Home is visible is recorded', async () => {
        home.visible = true;
        await eventSource.emit(event_types.PERSONA_CHANGED, 'Kris.png', { automatic: false });
        expect(homePersonaChoice()).toBe('Kris.png');
        await eventSource.emit(event_types.PERSONA_CHANGED, 'Rowan.png');
        expect(homePersonaChoice()).toBe('Rowan.png');
    });

    test('an automatic switch is never recorded and clears an earlier choice', async () => {
        home.visible = true;
        await eventSource.emit(event_types.PERSONA_CHANGED, 'Kris.png', { automatic: false });
        await eventSource.emit(event_types.PERSONA_CHANGED, 'Chat.png', { automatic: true });
        expect(homePersonaChoice()).toBe('');
    });

    test('a switch made while Home is hidden is not recorded', async () => {
        await eventSource.emit(event_types.PERSONA_CHANGED, 'Kris.png', { automatic: false });
        expect(homePersonaChoice()).toBe('');
    });

    test.each([
        ['before', 'after'],
        ['after', 'before'],
    ])('a chat change clears the choice whichever side of an automatic switch it lands on (%s)', async order => {
        home.visible = true;
        const chatChanged = () => eventSource.emit(event_types.CHAT_CHANGED);
        const automatic = () => eventSource.emit(event_types.PERSONA_CHANGED, 'Chat.png', { automatic: true });
        await eventSource.emit(event_types.PERSONA_CHANGED, 'Kris.png', { automatic: false });
        if (order === 'before') {
            await chatChanged();
            await automatic();
        } else {
            await automatic();
            await chatChanged();
        }
        expect(homePersonaChoice()).toBe('');
    });

    test('a chat change alone clears a hand-picked persona', async () => {
        home.visible = true;
        await eventSource.emit(event_types.PERSONA_CHANGED, 'Kris.png', { automatic: false });
        await eventSource.emit(event_types.CHAT_CHANGED);
        expect(homePersonaChoice()).toBe('');
    });
});
