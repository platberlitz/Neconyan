import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');

describe('settings saves skip unchanged serialisation', () => {
    test('every debounced save records a mutation revision', () => {
        expect(source).toContain('let settingsMutationRevision = 0;');
        expect(source).toContain('export const saveSettingsDebounced = (loopCounter = 0) => {');
        expect(source).toContain('settingsMutationRevision++;');
        expect(source).toContain('scheduleSettingsSave(loopCounter);');
    });

    test('an unchanged helper save returns before the payload is built', () => {
        const fastPath = source.indexOf('if (skipIfUnchanged && lastSavedSettings?.account === account');
        const payload = source.indexOf('    const payload = {\n        _version: lastServerSettingsVersion,', fastPath);
        expect(fastPath).toBeGreaterThan(-1);
        expect(payload).toBeGreaterThan(fastPath);
        expect(source).toContain('lastSavedSettings.revision === settingsMutationRevision');
    });

    test('a completed save records the revision its body was built from', () => {
        expect(source).toContain('const payloadRevision = settingsMutationRevision;\n        const serializedPayload = JSON.stringify(payload);');
        expect(source).toContain('lastSavedSettings = accepted ? { ...accepted, revision: payloadRevision } : null;');
        expect(source).toContain('lastSavedSettings = { ...lastSavedSettings, revision: payloadRevision };');
    });

    test('both helper generations ask for an unchanged save to be skipped', () => {
        const calls = source.match(/saveSettings\(0, \{ returnResult: true, skipIfUnchanged: true \}\)/g) ?? [];
        expect(calls).toHaveLength(1);
        expect(source.match(/acknowledgement: await acknowledgeGenerationSettings\(force\)/g)).toHaveLength(2);
    });
});
