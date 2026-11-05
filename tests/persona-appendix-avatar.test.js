import { describe, expect, test } from '@jest/globals';
import { fitScenarioAvatar, getScenarioAvatar, MAX_SCENARIO_AVATAR_LENGTH, normalizeScenarioAvatar } from '../public/scripts/persona-appendix-avatar.js';

const portrait = 'data:image/png;base64,aGVsbG8=';
const other = 'data:image/webp;base64,d29ybGQ=';

describe('Scenario Note portraits', () => {
    test('retains large portrait detail and its aspect ratio', async () => {
        const sizes = [];
        expect(await fitScenarioAvatar(1536, 1024, (w, h) => { sizes.push([w, h]); return portrait; })).toBe(portrait);
        expect(sizes).toEqual([[1024, 683]]);
    });

    test('reduces oversized portraits until they fit the existing limit', async () => {
        const sizes = [];
        const result = await fitScenarioAvatar(1200, 1600, (w, h) => {
            sizes.push([w, h]);
            return h > 512 ? `data:image/webp;base64,${'a'.repeat(MAX_SCENARIO_AVATAR_LENGTH)}` : portrait;
        });
        expect(result).toBe(portrait);
        expect(sizes).toEqual([[768, 1024], [576, 768], [384, 512]]);
    });

    test('does not enlarge small originals or retry duplicate sizes', async () => {
        const sizes = [];
        await expect(fitScenarioAvatar(80, 60, (w, h) => { sizes.push([w, h]); return ''; })).rejects.toThrow('storage limit');
        expect(sizes).toEqual([[80, 60]]);
    });

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
