/* global globalThis, window */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
let bridge;
const secret = 'a'.repeat(64);

beforeEach(async () => {
    jest.resetModules();
    const window = new EventTarget(); window.top = window; window.location = { origin: 'http://127.0.0.1:8000' };
    globalThis.window = window;
    globalThis.document = { addEventListener: jest.fn() };
    globalThis.HTMLAnchorElement = class { click() {} };
    globalThis.alert = jest.fn();
    globalThis.NeconyanExport = { showCrashReports: jest.fn(() => true), beginExport: jest.fn(() => true), appendExport: jest.fn(() => true), finishExport: jest.fn(() => true), cancelExport: jest.fn(() => true) };
    globalThis.NeconyanAndroid = { installUpdate: jest.fn(() => true) };
    bridge = await import('../public/scripts/android-native-bridge.js');
});
afterEach(() => {
    for (const name of ['window', 'document', 'HTMLAnchorElement', 'alert', 'NeconyanExport', 'NeconyanAndroid', 'fetch']) delete globalThis[name];
});

describe('module-private Android caller capability', () => {
    test('missing or malformed secret invokes no native actions', async () => {
        expect(bridge.requestAndroidUpdate('1.3.3')).toBe(false);
        expect(bridge.showAndroidCrashReports()).toBe(false);
        expect(await bridge.saveAndroidBlob('blob:http://127.0.0.1:8000/x', 'card')).toBe(false);
        expect(bridge.installAndroidNativeBridge('wrong', window.location.origin)).toBe(false);
        expect(globalThis.NeconyanAndroid.installUpdate).not.toHaveBeenCalled();
        expect(globalThis.NeconyanExport.showCrashReports).not.toHaveBeenCalled();
        expect(globalThis.NeconyanExport.beginExport).not.toHaveBeenCalled();
    });
    test('only the expected main origin can receive a secret', () => {
        expect(bridge.installAndroidNativeBridge(secret, 'https://wrong.example')).toBe(false);
        window.top = {};
        expect(bridge.installAndroidNativeBridge(secret, window.location.origin)).toBe(false);
        expect(bridge.requestAndroidUpdate('1.3.3')).toBe(false);
    });
    test('update and crash report calls pass a private secret; a wrong secret is refused by native gate', () => {
        globalThis.NeconyanAndroid.installUpdate.mockImplementation((token, version) => token === secret && version === '1.3.3');
        expect(bridge.installAndroidNativeBridge('b'.repeat(64), window.location.origin)).toBe(true);
        expect(bridge.requestAndroidUpdate('1.3.3')).toBe(false);
        expect(bridge.installAndroidNativeBridge(secret, window.location.origin)).toBe(true);
        expect(bridge.requestAndroidUpdate('1.3.3')).toBe(true); expect(bridge.showAndroidCrashReports()).toBe(true);
        expect(globalThis.NeconyanAndroid.installUpdate).toHaveBeenLastCalledWith(secret, '1.3.3');
        expect(globalThis.NeconyanExport.showCrashReports).toHaveBeenCalledWith(secret);
        expect(Object.values(window)).not.toContain(secret);
        expect(Object.keys(bridge)).not.toContain('callerToken');
        expect(window.neconyanSaveBlob.toString()).not.toContain(secret);
    });
    test('all export stages use the same capability and loss of permission cancels with the original one', async () => {
        bridge.installAndroidNativeBridge(secret, window.location.origin);
        globalThis.fetch = jest.fn(async () => ({ blob: async () => new Blob(['data']) }));
        expect(await bridge.saveAndroidBlob('blob:http://127.0.0.1:8000/x', 'file')).toBe(true);
        expect(globalThis.NeconyanExport.beginExport).toHaveBeenCalledWith(secret, 'file', 4);
        expect(globalThis.NeconyanExport.appendExport).toHaveBeenCalledWith(secret, 'ZGF0YQ==');
        expect(globalThis.NeconyanExport.finishExport).toHaveBeenCalledWith(secret);
        globalThis.NeconyanExport.appendExport.mockReturnValue(false);
        expect(await bridge.saveAndroidBlob('blob:http://127.0.0.1:8000/x', 'file')).toBe(false);
        expect(globalThis.NeconyanExport.cancelExport).toHaveBeenCalledWith(secret);
    });

    test('hands optional Android memory profile to low-memory mode only after origin and token validation', async () => {
        const lowMemory = await import('../public/scripts/low-memory-mode.js');
        lowMemory.resetLowMemoryRuntimeForTests({
            navigatorRef: { deviceMemory: 8 },
            storageRef: { getItem: () => null, setItem: () => {} },
            windowRef: window,
            globalRef: globalThis,
        });

        // Wrong origin or bad token must not install the native memory profile.
        expect(bridge.installAndroidNativeBridge(secret, 'https://wrong.example', {
            schema: 1,
            totalMemoryMiB: 2048,
            isLowRamDevice: true,
        })).toBe(false);
        expect(lowMemory.getLowMemoryState().classification.source).toBe('browser');
        expect(lowMemory.getLowMemoryState().active).toBe(false);

        expect(bridge.installAndroidNativeBridge('wrong', window.location.origin, {
            schema: 1,
            totalMemoryMiB: 2048,
            isLowRamDevice: true,
        })).toBe(false);
        expect(lowMemory.getLowMemoryState().classification.source).toBe('browser');

        // Old two-argument callers keep working and fall back to browser classification.
        expect(bridge.installAndroidNativeBridge(secret, window.location.origin)).toBe(true);
        expect(lowMemory.getLowMemoryState().classification.source).toBe('browser');
        expect(lowMemory.getLowMemoryState().active).toBe(false);

        // Invalid third-argument payload is ignored without breaking bridge installation.
        expect(bridge.installAndroidNativeBridge(secret, window.location.origin, {
            schema: 99,
            totalMemoryMiB: -1,
        })).toBe(true);
        expect(lowMemory.getLowMemoryState().classification.source).toBe('browser');

        // Valid third-argument profile activates native low-memory classification.
        expect(bridge.installAndroidNativeBridge(secret, window.location.origin, {
            schema: 1,
            totalMemoryMiB: 3072,
            isLowRamDevice: false,
        })).toBe(true);
        expect(lowMemory.getLowMemoryState().classification).toEqual({
            lowMemory: true,
            source: 'native',
            reason: 'native-total-memory-low',
            deviceMemoryGb: 8,
            totalMemoryMiB: 3072,
            isLowRamDevice: false,
        });
        expect(lowMemory.getLowMemoryState().active).toBe(true);
    });
});
