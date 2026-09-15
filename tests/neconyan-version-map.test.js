import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
    NECONYAN_COMPATIBLE_ST_VERSION,
    mapSillyBunnyVersionToStEquivalent,
    SILLYBUNNY_TO_ST_MINOR,
} from '../public/scripts/neconyan-version-map.js';

describe('mapSillyBunnyVersionToStEquivalent', () => {
    test('maps SB 1.6.x to ST 1.18.x', () => {
        expect(mapSillyBunnyVersionToStEquivalent('1.6.4')).toBe('1.18.4');
        expect(mapSillyBunnyVersionToStEquivalent('1.6.0')).toBe('1.18.0');
        expect(mapSillyBunnyVersionToStEquivalent('1.6.99')).toBe('1.18.99');
    });

    test('preserves suffix', () => {
        expect(mapSillyBunnyVersionToStEquivalent('1.6.4-beta')).toBe('1.18.4-beta');
    });

    test('clamps future unmapped SB minors to the highest synced ST version', () => {
        // SB 1.7.0 is not yet in SILLYBUNNY_TO_ST_MINOR, but should map to ST 1.18.0
        // (the highest synced ST minor) instead of passing through as 1.7.0.
        expect(mapSillyBunnyVersionToStEquivalent('1.7.0')).toBe('1.18.0');
        expect(mapSillyBunnyVersionToStEquivalent('1.99.5')).toBe('1.18.5');
        expect(mapSillyBunnyVersionToStEquivalent('1.8.1')).toBe('1.18.1');
        expect(mapSillyBunnyVersionToStEquivalent('1.7.3-beta')).toBe('1.18.3-beta');
    });

    test('passes through SB minors lower than the minimum mapped entry', () => {
        // SB 1.5.x is below the minimum mapped entry (6); pass through unchanged.
        expect(mapSillyBunnyVersionToStEquivalent('1.5.0')).toBe('1.5.0');
        expect(mapSillyBunnyVersionToStEquivalent('1.0.1')).toBe('1.0.1');
    });

    test('passes through non-1.x major versions', () => {
        expect(mapSillyBunnyVersionToStEquivalent('2.0.0')).toBe('2.0.0');
        expect(mapSillyBunnyVersionToStEquivalent('0.9.1')).toBe('0.9.1');
    });

    test('passes through invalid version strings', () => {
        expect(mapSillyBunnyVersionToStEquivalent('not-a-version')).toBe('not-a-version');
        expect(mapSillyBunnyVersionToStEquivalent('1.6')).toBe('1.6');
        expect(mapSillyBunnyVersionToStEquivalent('')).toBe('');
    });

    test('handles version with v prefix stripped', () => {
        // versionCompare strips 'v' before calling this function
        expect(mapSillyBunnyVersionToStEquivalent('1.6.4')).toBe('1.18.4');
    });
});

describe('SILLYBUNNY_TO_ST_MINOR table', () => {
    test('documents current SB-to-ST minor mapping', () => {
        // SB 1.6.x tracks ST 1.18.x
        expect(SILLYBUNNY_TO_ST_MINOR[6]).toBe(18);
    });

    test('contains only integer keys and values', () => {
        for (const [sbMinor, stMinor] of Object.entries(SILLYBUNNY_TO_ST_MINOR)) {
            expect(Number.isInteger(Number(sbMinor))).toBe(true);
            expect(Number.isInteger(stMinor)).toBe(true);
        }
    });
});

describe('Neconyan extension compatibility', () => {
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
                mapSillyBunnyVersionToStEquivalent: () => { throw new Error('Neconyan must not use the SillyBunny version map'); },
            });
            expect(result).toBe(expected);
        }
        expect(source).toContain('current compatible version is ${extensionCompatibilityVersion}');
    });
});
