import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

const root = path.dirname(fileURLToPath(import.meta.url));
const script = fs.readFileSync(path.join(root, '..', 'public', 'script.js'), 'utf8');
const groupChats = fs.readFileSync(path.join(root, '..', 'public', 'scripts', 'group-chats.js'), 'utf8');

describe('start-up group list prefetch', () => {
    test('starts the group request beside the character request', () => {
        const character = script.indexOf('startupCharacterListPromise = fetch(\'/api/characters/all\'');
        const groups = script.indexOf('prefetchGroups();');
        const locales = script.indexOf('await initLocales(initialSettingsData);', character);
        expect(character).toBeGreaterThan(-1);
        expect(groups).toBeGreaterThan(character);
        expect(groups).toBeLessThan(locales);
    });

    test('getGroups consumes one prefetched response and clears the slot', () => {
        expect(groupChats).toContain('let startupGroupListPromise = null;');
        expect(groupChats).toContain('function prefetchGroups()');
        expect(groupChats).toContain('startupGroupListPromise ??= fetch(\'/api/groups/all\'');
        expect(groupChats).toContain('const pendingResponse = startupGroupListPromise;');
        expect(groupChats).toContain('startupGroupListPromise = null;');
        expect(groupChats).toContain('const response = await (pendingResponse ?? fetch(\'/api/groups/all\'');
    });
});
