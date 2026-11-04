import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Guards the startup request overlap: the three independent bootstrap requests run in
// one Promise.all, and the settings data - not the version probe or the secrets
// handshake - must be the value bound to initialSettingsData and handed to initLocales.
const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');

const allStart = source.indexOf('const [initialSettingsData] = await Promise.all([');
if (allStart < 0) throw new Error('The startup Promise.all statement is missing.');
const localesStatement = 'await initLocales(initialSettingsData);';
const localesStart = source.indexOf(localesStatement, allStart);
if (localesStart < 0) throw new Error('initLocales is not fed from initialSettingsData.');
const segment = source.slice(allStart, localesStart + localesStatement.length);

describe('startup bootstrap requests', () => {
    test('the settings data lands in initialSettingsData and feeds initLocales', async () => {
        let localesInput;
        const context = vm.createContext({
            Promise,
            getClientVersion: async () => ({ pkgVersion: 'version-data' }),
            initSecrets: async () => 'secrets-init',
            readSecretState: async () => 'secret-state',
            requestSettingsData: async () => ({ settings: 'settings-data' }),
            initLocales: value => {
                localesInput = value;
                return Promise.resolve();
            },
        });
        const runner = `(async () => { ${segment} return initialSettingsData; })()`;
        const result = await vm.runInContext(runner, context);

        expect(result).toEqual({ settings: 'settings-data' });
        expect(localesInput).toEqual({ settings: 'settings-data' });
    });

    test('the three bootstrap requests still run together', async () => {
        const started = [];
        const context = vm.createContext({
            Promise,
            getClientVersion: async () => { started.push('version'); },
            initSecrets: async () => { started.push('secrets'); },
            readSecretState: async () => { started.push('secret-state'); },
            requestSettingsData: async () => { started.push('settings'); },
            initLocales: () => Promise.resolve(),
        });
        await vm.runInContext(`(async () => { ${segment} })()`, context);
        // All three start before any of them completes: no serial waterfall.
        expect(started).toEqual(expect.arrayContaining(['version', 'secrets', 'settings', 'secret-state']));
    });
});
