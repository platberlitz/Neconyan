import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { registerExtensionCapability } from '../public/scripts/neconyan-conversation/extension-capabilities.js';
import { canReadAloud, isReadingAloud, spokenText, stopReadAloud, toggleReadAloud } from '../public/scripts/scratchpad/read-aloud.js';

const change = '```scratchpad-change\n{"type":"persona","action":"replace","field":"description","value":"Tall."}\n```';

function fakeTts({ started = true } = {}) {
    const tts = {
        playing: false,
        narrateTtsMessage: jest.fn(async () => { tts.playing = started; return started; }),
        stopPlayback: jest.fn(() => { tts.playing = false; }),
        isPlaying: () => tts.playing,
    };
    return tts;
}

describe('Scratchpad read aloud', () => {
    let unregister = null;
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        stopReadAloud();
        unregister?.();
        unregister = null;
        jest.useRealTimers();
    });

    test('speaks the prose and leaves out change cards, code, source numbers and link addresses', () => {
        const text = `## Plan\nRead the [guide](https://example.com/a_(b)) first [1][12].\n\n${change}\n\n\`\`\`js\nconst secret = 1;\n\`\`\`\nThen run \`npm test\`. See https://example.com/raw now.`;
        expect(spokenText(text)).toBe('Plan\nRead the guide first.\n\nThen run npm test. See now.');
        expect(spokenText(change)).toBe('');
        expect(spokenText(null)).toBe('');
    });

    test('is offered only when text to speech can also be stopped and watched', () => {
        expect(canReadAloud()).toBe(false);
        unregister = registerExtensionCapability('tts', { narrateTtsMessage: async () => true });
        expect(canReadAloud()).toBe(false);
        unregister();
        unregister = registerExtensionCapability('tts', fakeTts());
        expect(canReadAloud()).toBe(true);
    });

    test('reads with the assistant voice, stops on a second press and notices when playback ends', async () => {
        const tts = fakeTts();
        unregister = registerExtensionCapability('tts', tts);
        const onChange = jest.fn();
        const message = { id: 'a', text: `Hello there.\n\n${change}` };

        expect(await toggleReadAloud(message, 'Miso', onChange)).toBe('started');
        expect(tts.narrateTtsMessage).toHaveBeenCalledWith(
            { name: 'Miso', mes: 'Hello there.', is_user: false, is_system: false, extra: {} },
            { manual: true, force: true, propagateErrors: true, unrestrictedVoiceMap: true });
        expect(isReadingAloud('a')).toBe(true);
        expect(onChange).toHaveBeenCalledTimes(1);

        expect(await toggleReadAloud(message, 'Miso', onChange)).toBe('stopped');
        expect(tts.stopPlayback).toHaveBeenCalledTimes(1);
        expect(isReadingAloud('a')).toBe(false);
        expect(onChange).toHaveBeenCalledTimes(2);

        expect(await toggleReadAloud(message, 'Miso', onChange)).toBe('started');
        jest.advanceTimersByTime(2000);
        expect(isReadingAloud('a')).toBe(true);
        tts.playing = false;
        jest.advanceTimersByTime(400);
        // One quiet check may be the pause between two paragraphs.
        expect(isReadingAloud('a')).toBe(true);
        jest.advanceTimersByTime(400);
        expect(isReadingAloud('a')).toBe(false);
        expect(onChange).toHaveBeenCalledTimes(4);
        expect(tts.stopPlayback).toHaveBeenCalledTimes(1);
    });

    test('reading another reply ends the first, and nothing starts without text or when text to speech declines', async () => {
        const tts = fakeTts();
        unregister = registerExtensionCapability('tts', tts);
        const first = jest.fn();
        expect(await toggleReadAloud({ id: 'a', text: 'One.' }, 'Miso', first)).toBe('started');
        expect(await toggleReadAloud({ id: 'b', text: 'Two.' }, 'Taro', jest.fn())).toBe('started');
        expect(first).toHaveBeenCalledTimes(2);
        expect(isReadingAloud('a')).toBe(false);
        expect(isReadingAloud('b')).toBe(true);

        expect(await toggleReadAloud({ id: 'c', text: change }, 'Miso', jest.fn())).toBe('empty');
        expect(isReadingAloud('b')).toBe(true);
        expect(tts.narrateTtsMessage).toHaveBeenCalledTimes(2);

        stopReadAloud();
        unregister();
        unregister = registerExtensionCapability('tts', fakeTts({ started: false }));
        expect(await toggleReadAloud({ id: 'd', text: 'Four.' }, 'Miso', jest.fn())).toBe('unavailable');
        expect(isReadingAloud('d')).toBe(false);
        unregister();
        unregister = null;
        expect(await toggleReadAloud({ id: 'e', text: 'Five.' }, 'Miso', jest.fn())).toBe('unavailable');
    });
});
