import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'script.js'), 'utf8');

describe('start-up character list', () => {
    test('starts the character request as soon as settings arrive', () => {
        const start = source.indexOf('const [initialSettingsData] = await Promise.all([');
        const end = source.indexOf('await initLocales(initialSettingsData);');
        const boot = source.slice(start, end);
        expect(start).toBeGreaterThan(-1);
        expect(boot.indexOf('requestSettingsData()')).toBeLessThan(boot.indexOf('getClientVersion()'));
        expect(boot).toContain('startupCharacterListPromise = fetch(\'/api/characters/all\'');
    });

    test('getCharacters uses the started response and clears the slot', () => {
        const start = source.indexOf('export async function getCharacters()');
        const end = source.indexOf('export ', start + 10);
        const getCharacters = source.slice(start, end);
        expect(getCharacters).toContain('const pendingResponse = startupCharacterListPromise;');
        expect(getCharacters).toContain('startupCharacterListPromise = null;');
        expect(getCharacters).toContain('pendingResponse ?? fetch(\'/api/characters/all\'');
    });
});
