import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

const root = path.dirname(fileURLToPath(import.meta.url));
const script = fs.readFileSync(path.join(root, '..', 'public', 'script.js'), 'utf8');
const personas = fs.readFileSync(path.join(root, '..', 'public', 'scripts', 'personas.js'), 'utf8');

describe('start-up avatar list prefetch', () => {
    test('starts the avatar request beside the other list requests', () => {
        const groups = script.indexOf('prefetchGroups();');
        const avatars = script.indexOf('prefetchUserAvatars();');
        const locales = script.indexOf('await initLocales(initialSettingsData);', groups);
        expect(groups).toBeGreaterThan(-1);
        expect(avatars).toBeGreaterThan(groups);
        expect(avatars).toBeLessThan(locales);
    });

    test('getUserAvatars consumes one prefetched response and clears the slot', () => {
        expect(personas).toContain('let startupAvatarListPromise = null;');
        expect(personas).toContain('export function prefetchUserAvatars()');
        expect(personas).toContain('startupAvatarListPromise ??= fetch(\'/api/avatars/get\'');
        expect(personas).toContain('const pendingResponse = startupAvatarListPromise;');
        expect(personas).toContain('startupAvatarListPromise = null;');
        expect(personas).toContain('const response = await (pendingResponse ?? fetch(\'/api/avatars/get\'');
    });
});
