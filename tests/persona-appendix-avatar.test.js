import { describe, expect, test } from '@jest/globals';
import {
    getScenarioAvatar,
    isScenarioAvatarPath,
    MAX_SCENARIO_AVATAR_LENGTH,
    normalizePortableScenarioAvatar,
    normalizeScenarioAvatar,
} from '../public/scripts/persona-appendix-avatar.js';

const portrait = 'data:image/png;base64,aGVsbG8=';
const other = 'data:image/webp;base64,d29ybGQ=';
const savedPortrait = '/user/images/persona-notes/full-size-portrait.png';

describe('Scenario Note portraits', () => {
    test('accepts saved user image files at their original size', () => {
        expect(normalizeScenarioAvatar(savedPortrait)).toBe(savedPortrait);
        expect(normalizeScenarioAvatar('/user/images/Scratchpad/scratchpad-abc123.png')).toBe('/user/images/Scratchpad/scratchpad-abc123.png');
        expect(normalizeScenarioAvatar('/user/images/persona-notes/picture.jpeg')).toBe('/user/images/persona-notes/picture.jpeg');
        expect(normalizeScenarioAvatar('/user/images/persona-notes/picture.webp')).toBe('/user/images/persona-notes/picture.webp');
        expect(normalizeScenarioAvatar('/user/images/persona-notes/picture.gif')).toBe('/user/images/persona-notes/picture.gif');
        expect(isScenarioAvatarPath(savedPortrait)).toBe(true);
    });

    test('keeps older embedded portraits working within their saved-data budget', () => {
        expect(normalizeScenarioAvatar(portrait)).toBe(portrait);
        expect(normalizeScenarioAvatar('data:image/gif;base64,aGVsbG8=')).toBe('data:image/gif;base64,aGVsbG8=');
        expect(normalizeScenarioAvatar(`data:image/png;base64,${'a'.repeat(MAX_SCENARIO_AVATAR_LENGTH)}`)).toBe('');
    });

    test('only portable embedded pictures belong in a persona card', () => {
        expect(normalizePortableScenarioAvatar(portrait)).toBe(portrait);
        expect(normalizePortableScenarioAvatar(savedPortrait)).toBe('');
        expect(normalizePortableScenarioAvatar('https://example.com/a.png')).toBe('');
    });

    test('uses visible note order rather than the order notes were enabled', () => {
        const notes = [{ id: 'plain' }, { id: 'first', avatar: savedPortrait }, { id: 'second', avatar: other }];
        expect(getScenarioAvatar(notes, ['second', 'plain', 'first'])).toBe(savedPortrait);
        expect(getScenarioAvatar(notes, ['second', 'plain'])).toBe(other);
        expect(getScenarioAvatar(notes, ['plain', 'deleted'])).toBe('');
        expect(getScenarioAvatar(notes, [])).toBe('');
    });

    test.each([
        undefined,
        {},
        'https://example.com/a.png',
        '../a.png',
        '/user/images/../settings.json',
        '/user/images/persona-notes/../../settings.json',
        '/user/images/persona-notes/%2e%2e/settings.png',
        '/user/images/persona-notes/picture.png?raw=1',
        '/user/images/persona-notes/picture.svg',
        '/characters/picture.png',
        '/User%20Avatars/picture.png',
        'user/images/persona-notes/picture.png',
        'javascript:alert(1)',
        'data:image/svg+xml;base64,aGVsbG8=',
        'data:image/png;base64,???',
        `data:image/png;base64,${'a'.repeat(MAX_SCENARIO_AVATAR_LENGTH)}`,
    ])('ignores unsupported, unsafe or oversized portrait data (case %#)', value => {
        expect(normalizeScenarioAvatar(value)).toBe('');
        expect(getScenarioAvatar([{ id: 'bad', avatar: value }, { id: 'ok', avatar: portrait }], ['bad', 'ok'])).toBe(portrait);
    });
});
