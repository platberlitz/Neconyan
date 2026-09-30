import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const versionFunction = source.match(/async function getClientVersion\(\) \{[\s\S]*?^\}/m)[0];
const initialDisplay = source.match(/export let displayVersion = ([^;]+);/)[1];
const initialAgent = source.match(/export let CLIENT_VERSION = ([^;]+);/)[1];

async function loadVersion(fetch) {
    const labels = {};
    const error = jest.fn();
    const state = vm.createContext({ fetch, console: { error }, $: selector => ({ text: text => { labels[selector] = text; } }) });
    await vm.runInContext(`let currentVersion = '0.0.0'; let displayVersion = ${initialDisplay}; let CLIENT_VERSION = ${initialAgent}; ${versionFunction}\ngetClientVersion()`, state);
    const values = vm.runInContext('({ currentVersion, displayVersion, CLIENT_VERSION })', state);
    return { ...values, labels, error };
}

describe('visible Neconyan release version', () => {
    for (const version of ['1.0.5', '1.2.3', '2.0.0-beta.1']) {
        test(`shows the server release ${version} in both version labels`, async () => {
            const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ pkgVersion: version, agent: `Neconyan:${version}` }) }));
            const result = await loadVersion(fetch);
            expect(fetch).toHaveBeenCalledWith('/version');
            expect(result.currentVersion).toBe(version);
            expect(result.displayVersion).toBe(`Neconyan v${version}`);
            expect(result.CLIENT_VERSION).toBe(`Neconyan:${version}`);
            expect(result.labels).toEqual({ '#version_display': `Neconyan v${version}`, '#version_display_welcome': `Neconyan v${version}` });
            expect(result.error).not.toHaveBeenCalled();
        });
    }

    test('a failed request does not advertise an outdated hard-coded release', async () => {
        const result = await loadVersion(async () => { throw new Error('offline'); });
        expect(result.displayVersion).toBe('Neconyan');
        expect(result.CLIENT_VERSION).toBe('Neconyan');
        expect(result.error).toHaveBeenCalled();
    });

    test('does not accept an unsuccessful version response', async () => {
        const result = await loadVersion(async () => ({ ok: false, status: 503 }));
        expect(result.displayVersion).toBe('Neconyan');
        expect(result.error).toHaveBeenCalled();
    });
});
