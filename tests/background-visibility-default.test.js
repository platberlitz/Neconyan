import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const declaration = source.match(/^const NN_SURFACE_TRANSPARENCY = Object\.freeze\(\{[\s\S]*?^\}\);/m)?.[0];
const normalizer = source.match(/^function normalizeSurfaceTransparency\(value\) \{[\s\S]*?^\}/m)?.[0];
if (!declaration || !normalizer) throw new Error('Could not extract the real Background Visibility normalizer and constants.');
const normalize = vm.runInNewContext(`${declaration}\n${normalizer}\nnormalizeSurfaceTransparency`);

describe('Background Visibility default', () => {
    test.each([null, undefined, '', ' ', '\t\n', 'invalid', NaN, Infinity, -Infinity, 'Infinity'])('uses 100 for absent or invalid preference %p', value => {
        expect(normalize(value)).toBe(100);
    });

    test.each([[0, 0], ['0', 0], [50, 50], ['50', 50], [100, 100], ['100', 100], [52, 50], ['52', 50], [-10, 0], [110, 100]])('preserves, snaps and clamps %p to %p', (value, expected) => {
        expect(normalize(value)).toBe(expected);
    });
});
