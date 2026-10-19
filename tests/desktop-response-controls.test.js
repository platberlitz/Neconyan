import { describe, expect, test } from '@jest/globals';
import { managesResponseControls, normaliseDesktopResponseControls } from '../public/scripts/desktop-response-controls.js';

describe('desktop response control preference', () => {
    test('preserves the explicit below-bubble choice', () => {
        expect(normaliseDesktopResponseControls('below')).toBe('below');
    });
    test.each([undefined, null, '', 'inside', 'invalid', 1, {}])('uses the inside default for absent or invalid settings: %p', value => {
        expect(normaliseDesktopResponseControls(value)).toBe('inside');
    });
});

describe('desktop response control wrapper gate', () => {
    const tide = { matches: selector => selector === '.nn-tide-layout' };
    const plain = { matches: () => false };

    test('manages every style from 1001px', () => {
        expect(managesResponseControls(true, false, plain)).toBe(true);
        expect(managesResponseControls(true, false, tide)).toBe(true);
    });

    test('manages Tide rows only at 769-1000px', () => {
        expect(managesResponseControls(false, true, tide)).toBe(true);
        expect(managesResponseControls(false, true, plain)).toBe(false);
    });

    test('manages nothing at phone width', () => {
        expect(managesResponseControls(false, false, tide)).toBe(false);
    });
});
