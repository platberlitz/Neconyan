import { describe, expect, test } from '@jest/globals';
import { normaliseDesktopResponseControls } from '../public/scripts/desktop-response-controls.js';

describe('desktop response control preference', () => {
    test('preserves the explicit below-bubble choice', () => {
        expect(normaliseDesktopResponseControls('below')).toBe('below');
    });
    test.each([undefined, null, '', 'inside', 'invalid', 1, {}])('uses the inside default for absent or invalid settings: %p', value => {
        expect(normaliseDesktopResponseControls(value)).toBe('inside');
    });
});
