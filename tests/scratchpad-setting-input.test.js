import { describe, expect, test } from '@jest/globals';
import { integerSettingValue, reflectSavedValue, reflectedSettingValue } from '../public/scripts/scratchpad/setting-input.js';

describe('Scratchpad numeric settings', () => {
    test('blank and non-finite values keep the saved value instead of becoming zero', () => {
        for (const value of ['', '   ', 'not a number', null, undefined, NaN, Infinity]) {
            expect(integerSettingValue(value, { min: 0, max: 200 })).toBeNull();
            expect(integerSettingValue(value, { min: 64, max: 32000 })).toBeNull();
        }
    });

    test('valid values are rounded and clamped to the same limits the server uses', () => {
        expect(integerSettingValue('999', { min: 0, max: 200 })).toBe(200);
        expect(integerSettingValue('-4', { min: 0, max: 200 })).toBe(0);
        expect(integerSettingValue('2048', { min: 64, max: 32000 })).toBe(2048);
        expect(integerSettingValue('63', { min: 64, max: 32000 })).toBe(64);
        expect(integerSettingValue('32001', { min: 64, max: 32000 })).toBe(32000);
        expect(integerSettingValue('12.6', { min: 0, max: 200 })).toBe(13);
    });

    test('the field shows the saved value only while it is still on screen', () => {
        const connected = { isConnected: true, value: '' };
        reflectSavedValue(connected, 2048);
        expect(connected.value).toBe('2048');
        const removed = { isConnected: false, value: '4096' };
        reflectSavedValue(removed, 2048);
        expect(removed.value).toBe('4096');
    });

    test('a newly created session still shows the value it just saved', () => {
        expect(reflectedSettingValue(32000, 15, { sessionId: undefined, activeSessionId: 'new-session' })).toBe(32000);
        expect(reflectedSettingValue(2048, 32000, { sessionId: 'same', activeSessionId: 'same' })).toBe(2048);
        expect(reflectedSettingValue(2048, 32000, { sessionId: 'old', activeSessionId: 'other' })).toBe(32000);
        expect(reflectedSettingValue(32000, 15, { sessionId: undefined, activeSessionId: 'new-session', succeeded: false })).toBe(15);
        expect(reflectedSettingValue(2048, 32000, { sessionId: 'same', activeSessionId: 'same', succeeded: false })).toBe(32000);
    });
});
