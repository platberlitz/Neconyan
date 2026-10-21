import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const adoptSource = scriptSource.match(/export function adoptServerSettingsWrite\([\s\S]*?\n\}/)[0].replace(/^export /, '');

function page({ version = 8, revision = 4 } = {}) {
    const context = {
        lastServerSettingsVersion: version,
        lastServerSettingsRevision: revision,
        recentSamePageServerWrite: null,
        acknowledgedGenerationSettings: { account: 'alice', settingsRevision: revision, controls: {} },
        getCurrentUserHandle: () => 'alice',
    };
    runInNewContext(`${adoptSource}\nglobalThis.adopt = adoptServerSettingsWrite;`, context);
    return context;
}

describe('adoptServerSettingsWrite', () => {
    test('adopts a server write over the version this page last saw', () => {
        const context = page();
        expect(context.adopt({ account: 'alice', previousVersion: 8, previousSettingsRevision: 4, version: 9, settingsRevision: 5 })).toBe(true);
        expect([context.lastServerSettingsVersion, context.lastServerSettingsRevision, context.acknowledgedGenerationSettings.settingsRevision]).toEqual([9, 5, 5]);
    });

    test('adopts a server write that followed Conversation-only writes this page did not see', () => {
        // The Conversation store saved version 9 without moving the settings revision, then the
        // Time Machine job wrote version 10 over it. The next settings save must not conflict.
        const context = page();
        expect(context.adopt({ account: 'alice', previousVersion: 9, previousSettingsRevision: 4, version: 10, settingsRevision: 5 })).toBe(true);
        expect([context.lastServerSettingsVersion, context.lastServerSettingsRevision]).toEqual([10, 5]);
    });

    test.each([
        ['another tab changed settings first', { previousVersion: 9, previousSettingsRevision: 5, version: 10, settingsRevision: 6 }],
        ['the previous revision is unknown', { previousVersion: 9, version: 10, settingsRevision: 5 }],
        ['the server wrote over an older version', { previousVersion: 7, previousSettingsRevision: 4, version: 8, settingsRevision: 5 }],
        ['the version does not move forward', { previousVersion: 9, previousSettingsRevision: 4, version: 9, settingsRevision: 5 }],
        ['the revision is invalid', { previousVersion: 8, previousSettingsRevision: 4, version: 9, settingsRevision: 'x' }],
    ])('keeps the conflict reload when %s', (_, write) => {
        const context = page();
        expect(context.adopt({ account: 'alice', ...write })).toBe(false);
        expect([context.lastServerSettingsVersion, context.lastServerSettingsRevision]).toEqual([8, 4]);
    });

    test('ignores a write for another account', () => {
        const context = page();
        expect(context.adopt({ account: 'bob', previousVersion: 8, previousSettingsRevision: 4, version: 9, settingsRevision: 5 })).toBe(false);
        expect(context.lastServerSettingsVersion).toBe(8);
    });
});
