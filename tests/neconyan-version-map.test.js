import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { NECONYAN_COMPATIBLE_ST_VERSION } from '../public/scripts/neconyan-version-map.js';

describe('Neconyan extension compatibility', () => {
    test('exposes the SillyTavern version whose extension APIs Neconyan keeps', () => {
        expect(NECONYAN_COMPATIBLE_ST_VERSION).toBe('1.18.1');
    });

    test('activates against the inherited engine version instead of the product version', () => {
        const source = readFileSync(new URL('../public/scripts/extensions.js', import.meta.url), 'utf8');
        const utils = readFileSync(new URL('../public/scripts/utils.js', import.meta.url), 'utf8');
        const setup = source.match(/extensionLoadErrors\.clear\(\);([\s\S]*?)const extensions =/)[1];
        const check = source.match(/const clientVersionMeetsMinimum =([\s\S]*?);/)[0];
        const compare = utils.match(/export function versionCompare\([\s\S]*?^}/m)[0].replace('export ', '');
        for (const [minimum, expected] of [['1.18.1', true], ['1.18.2', false], [undefined, true]]) {
            const result = vm.runInNewContext(`${compare}\n${setup}\n${check}\nclientVersionMeetsMinimum`, {
                CLIENT_VERSION: 'Neconyan:1.0.0',
                NECONYAN_COMPATIBLE_ST_VERSION,
                minClientVersion: minimum,
            });
            expect(result).toBe(expected);
        }
        expect(source).toContain('current compatible version is ${extensionCompatibilityVersion}');
    });
});
