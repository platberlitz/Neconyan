import { describe, expect, test } from '@jest/globals';
import { getScenarioAvatar, MAX_SCENARIO_AVATAR_LENGTH, normalizeScenarioAvatar } from '../public/scripts/persona-appendix-avatar.js';

const portrait = 'data:image/png;base64,aGVsbG8=';
const other = 'data:image/webp;base64,d29ybGQ=';

describe('Scenario Note portraits', () => {
    test('uses visible note order rather than the order notes were enabled', () => {
        const notes = [{ id: 'plain' }, { id: 'first', avatar: portrait }, { id: 'second', avatar: other }];
        expect(getScenarioAvatar(notes, ['second', 'plain', 'first'])).toBe(portrait);
        expect(getScenarioAvatar(notes, ['second', 'plain'])).toBe(other);
        expect(getScenarioAvatar(notes, ['plain', 'deleted'])).toBe('');
        expect(getScenarioAvatar(notes, [])).toBe('');
    });

    test.each([undefined, {}, 'https://example.com/a.png', '../a.png', 'data:image/svg+xml;base64,aGVsbG8=', 'data:image/png;base64,???', `data:image/png;base64,${'a'.repeat(MAX_SCENARIO_AVATAR_LENGTH)}`])('ignores unsupported or oversized portrait data (case %#)', value => {
        expect(normalizeScenarioAvatar(value)).toBe('');
        expect(getScenarioAvatar([{ id: 'bad', avatar: value }, { id: 'ok', avatar: portrait }], ['bad', 'ok'])).toBe(portrait);
    });
});
