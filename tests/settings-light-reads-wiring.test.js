import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Each of these reads used to download the whole settings file. On a large
// account that is several megabytes per request, and Dialogue Colors polls
// every few seconds. They must keep asking for only the part they use.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

describe('light settings reads', () => {
    test.each([
        ['public/scripts/extensions/third-party/sillytavern-character-colors/src/storage.js', 'extensionSettings: [MODULE_NAME]'],
        ['public/scripts/extensions/third-party/Neconyan-Time-Machine/src/store.js', 'extensionSettings: [MODULE_NAME]'],
        ['public/scripts/extensions/quick-image-gen/lib/host-persistence.js', 'extensionSettings: [settingsKey]'],
        ['public/scripts/extensions/third-party/Neconyan-Time-Machine/src/api.js', 'sections: [\'presets\']'],
        ['public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/host.js', 'sections: [\'presets\']'],
        ['public/scripts/extensions/in-chat-agents/index.js', 'sections: [\'agents\']'],
        ['public/scripts/extensions/in-chat-agents/agent-store.js', 'sections: [\'agents\']'],
        ['public/scripts/extensions/quick-reply/index.js', 'sections: [\'quickReplies\']'],
        ['public/scripts/world-info.js', 'sections: [\'worlds\']'],
    ])('%s asks for %s', (file, marker) => {
        expect(read(file)).toContain(marker);
    });

    test('Dialogue Colors skips the migration save when a browser has no old local data', () => {
        const source = read('public/scripts/extensions/third-party/sillytavern-character-colors/src/storage.js');
        const start = source.indexOf('export function migrateLegacyLocalStorageIfNeeded()');
        expect(start).toBeGreaterThan(-1);
        const body = source.slice(start, start + 2000);
        const fastPath = body.indexOf('!hasLegacyLocalStorageSettings()');
        expect(fastPath).toBeGreaterThan(-1);
        expect(body.indexOf('migrated: false', fastPath)).toBeGreaterThan(fastPath);
    });
});
