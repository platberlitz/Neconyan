import { describe, expect, jest, test } from '@jest/globals';
import { sha256 } from 'js-sha256';
import { personaExpressionFolder, personaExpressionSelection } from '../public/scripts/extensions/expressions/persona-expressions.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

await jest.unstable_mockModule('../public/lib.js', () => ({ sha256 }));

describe('persona expression identity', () => {
    test('same-name personas and Unicode avatars get stable, separate, filename-safe folders', async () => {
        const first = await personaExpressionFolder('Robin 😺.png');
        expect(first).toMatch(/^__personas\/[a-f0-9]{64}$/);
        expect(await personaExpressionFolder('Robin 😺.png')).toBe(first);
        expect(await personaExpressionFolder('Robin 😺 (1).png')).not.toBe(first);
        await expect(personaExpressionFolder('../Robin.png')).rejects.toThrow('Invalid persona');
    });

    test('a selected image cannot cross into another persona or escape its set', async () => {
        const folder = await personaExpressionFolder('Robin.png');
        const src = `/characters/${folder}/joy-2.png?t=3`;
        expect(personaExpressionSelection({ 'Robin.png': src }, 'Robin.png', folder)).toBe(src);
        expect(personaExpressionSelection({ 'Robin.png': null }, 'Robin.png', folder)).toBeNull();
        for (const value of ['/characters/Other/joy.png', `/characters/${folder}/%2e%2e/joy.png`, `https://test/characters/${folder}/joy.png`]) {
            expect(personaExpressionSelection({ 'Robin.png': value }, 'Robin.png', folder)).toBeUndefined();
        }
    });

    test('HTTP pages without Web Crypto use the same persona folder', async () => {
        const expected = await personaExpressionFolder('Robin.png');
        const original = Object.getOwnPropertyDescriptor(global, 'crypto');
        Object.defineProperty(global, 'crypto', { configurable: true, value: undefined });
        try {
            expect(await personaExpressionFolder('Robin.png')).toBe(expected);
        } finally {
            Object.defineProperty(global, 'crypto', original);
        }
    });

    test('user history uses its recorded persona, never the current persona or a same-name character', () => {
        const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
        const functionText = source.match(/^export function getMessageExpressionAvatar\([\s\S]*?^}/m)[0].replace('export ', '');
        const runtime = vm.createContext({ system_message_types: { NARRATOR: 'narrator' },
            parseAvatarSource: source => JSON.parse(source), characters: [{ avatar: 'Robin.png' }], this_chid: 0, selected_group: null });
        vm.runInContext(functionText, runtime);
        expect(runtime.getMessageExpressionAvatar({ is_user: true, force_avatar: JSON.stringify({ type: 'persona', file: 'Robin.png' }) })).toBe('persona:Robin.png');
        expect(runtime.getMessageExpressionAvatar({ is_user: true })).toBeNull();
        expect(runtime.getMessageExpressionAvatar({ is_user: true, force_avatar: JSON.stringify({ type: 'avatar', file: 'Robin.png' }) })).toBeNull();
        expect(runtime.getMessageExpressionAvatar({ is_user: false })).toBe('Robin.png');
    });
});
