import { describe, expect, jest, test } from '@jest/globals';
import {
    LOW_MEMORY_BROWSER_MAX_GB,
    LOW_MEMORY_MODE_STORAGE_KEY,
    LOW_MEMORY_MODES,
    LOW_MEMORY_NATIVE_MAX_MIB,
    NATIVE_MEMORY_WAIT_TIMEOUT_MS,
    RECOGNISED_BROWSER_MEMORY_BUCKETS,
    classifyDeviceMemory,
    createLowMemoryRuntime,
    normalizeBrowserDeviceMemory,
    normalizeLowMemoryMode,
    validateAndroidMemoryProfile,
} from '../public/scripts/low-memory-mode.js';

describe('low-memory mode classification and runtime', () => {
    test('classifies every recognised browser deviceMemory bucket with <= 2 GB threshold', () => {
        expect(RECOGNISED_BROWSER_MEMORY_BUCKETS).toEqual([0.25, 0.5, 1, 2, 4, 8]);
        expect(LOW_MEMORY_BROWSER_MAX_GB).toBe(2);

        for (const bucket of [0.25, 0.5, 1, 2]) {
            const result = classifyDeviceMemory({ deviceMemory: bucket });
            expect(result).toEqual({
                lowMemory: true,
                source: 'browser',
                reason: 'browser-device-memory-low',
                deviceMemoryGb: bucket,
                totalMemoryMiB: null,
                isLowRamDevice: null,
            });
        }

        for (const bucket of [4, 8]) {
            const result = classifyDeviceMemory({ deviceMemory: bucket });
            expect(result).toEqual({
                lowMemory: false,
                source: 'browser',
                reason: 'browser-device-memory-sufficient',
                deviceMemoryGb: bucket,
                totalMemoryMiB: null,
                isLowRamDevice: null,
            });
        }
    });

    test('treats missing, zero, negative, non-numeric, non-finite and unrecognised browser values as unknown', () => {
        const invalidValues = [
            undefined,
            null,
            0,
            -1,
            -0.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            '2',
            '0.5',
            '',
            true,
            false,
            {},
            [2],
            3,
            6,
            16,
        ];

        for (const candidate of invalidValues) {
            expect(normalizeBrowserDeviceMemory(candidate)).toBeNull();
            expect(classifyDeviceMemory({ deviceMemory: candidate })).toEqual({
                lowMemory: false,
                source: 'unknown',
                reason: 'memory-unavailable',
                deviceMemoryGb: null,
                totalMemoryMiB: null,
                isLowRamDevice: null,
            });
        }
    });

    test('validates native Android profiles and enforces native threshold boundaries and low-RAM flag', () => {
        expect(LOW_MEMORY_NATIVE_MAX_MIB).toBe(4096);

        expect(validateAndroidMemoryProfile(null)).toBeNull();
        expect(validateAndroidMemoryProfile(undefined)).toBeNull();
        expect(validateAndroidMemoryProfile({})).toBeNull();
        expect(validateAndroidMemoryProfile({ schema: 2, totalMemoryMiB: 2048, isLowRamDevice: true })).toBeNull();
        expect(validateAndroidMemoryProfile({ schema: 1, totalMemoryMiB: 0, isLowRamDevice: false })).toBeNull();
        expect(validateAndroidMemoryProfile({ schema: 1, totalMemoryMiB: -2048, isLowRamDevice: false })).toBeNull();
        expect(validateAndroidMemoryProfile({ schema: 1, totalMemoryMiB: '4096', isLowRamDevice: false })).toBeNull();
        expect(validateAndroidMemoryProfile({ schema: 1, totalMemoryMiB: 4096, isLowRamDevice: 'false' })).toBeNull();

        expect(classifyDeviceMemory({
            nativeMemory: { schema: 1, totalMemoryMiB: 4096, isLowRamDevice: false },
        })).toEqual({
            lowMemory: true,
            source: 'native',
            reason: 'native-total-memory-low',
            deviceMemoryGb: null,
            totalMemoryMiB: 4096,
            isLowRamDevice: false,
        });

        expect(classifyDeviceMemory({
            nativeMemory: { schema: 1, totalMemoryMiB: 4097, isLowRamDevice: false },
        })).toEqual({
            lowMemory: false,
            source: 'native',
            reason: 'native-total-memory-sufficient',
            deviceMemoryGb: null,
            totalMemoryMiB: 4097,
            isLowRamDevice: false,
        });

        expect(classifyDeviceMemory({
            nativeMemory: { schema: 1, totalMemoryMiB: 6144, isLowRamDevice: true },
        })).toEqual({
            lowMemory: true,
            source: 'native',
            reason: 'native-low-ram-flag',
            deviceMemoryGb: null,
            totalMemoryMiB: 6144,
            isLowRamDevice: true,
        });
    });

    test('gives valid native Android profiles authority over coarse browser deviceMemory buckets', () => {
        expect(classifyDeviceMemory({
            deviceMemory: 2,
            nativeMemory: { schema: 1, totalMemoryMiB: 6144, isLowRamDevice: false },
        })).toEqual({
            lowMemory: false,
            source: 'native',
            reason: 'native-total-memory-sufficient',
            deviceMemoryGb: 2,
            totalMemoryMiB: 6144,
            isLowRamDevice: false,
        });

        expect(classifyDeviceMemory({
            deviceMemory: 4,
            nativeMemory: { schema: 1, totalMemoryMiB: 4096, isLowRamDevice: false },
        })).toEqual({
            lowMemory: true,
            source: 'native',
            reason: 'native-total-memory-low',
            deviceMemoryGb: 4,
            totalMemoryMiB: 4096,
            isLowRamDevice: false,
        });

        expect(classifyDeviceMemory({
            deviceMemory: 8,
            nativeMemory: { schema: 1, totalMemoryMiB: 8192, isLowRamDevice: true },
        })).toEqual({
            lowMemory: true,
            source: 'native',
            reason: 'native-low-ram-flag',
            deviceMemoryGb: 8,
            totalMemoryMiB: 8192,
            isLowRamDevice: true,
        });
    });

    test('leaves Safari and unknown browsers unclassified without guessing from CPU count, heap or userAgent', () => {
        const safariLike = classifyDeviceMemory({
            deviceMemory: undefined,
            hardwareConcurrency: 2,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
            performanceMemory: { usedJSHeapSize: 900_000_000, jsHeapSizeLimit: 1_000_000_000 },
        });
        expect(safariLike.lowMemory).toBe(false);
        expect(safariLike.source).toBe('unknown');
        expect(safariLike.reason).toBe('memory-unavailable');
    });

    test('persists mode only in localStorage and supports On and Off overrides', () => {
        const store = new Map();
        const storageRef = {
            getItem: jest.fn(key => store.get(key) ?? null),
            setItem: jest.fn((key, value) => { store.set(key, value); }),
        };
        const runtime = createLowMemoryRuntime({
            navigatorRef: { deviceMemory: 8 },
            storageRef,
            windowRef: new EventTarget(),
            globalRef: {},
        });

        expect(runtime.getLowMemoryState().mode).toBe(LOW_MEMORY_MODES.AUTO);
        expect(runtime.getLowMemoryState().active).toBe(false);

        runtime.setLowMemoryMode(LOW_MEMORY_MODES.ON);
        expect(storageRef.setItem).toHaveBeenCalledWith(LOW_MEMORY_MODE_STORAGE_KEY, 'on');
        expect(runtime.getLowMemoryState().mode).toBe(LOW_MEMORY_MODES.ON);
        expect(runtime.getLowMemoryState().active).toBe(true);

        const lowRamRuntime = createLowMemoryRuntime({
            navigatorRef: { deviceMemory: 2 },
            storageRef,
            windowRef: new EventTarget(),
            globalRef: {},
        });
        expect(lowRamRuntime.getLowMemoryState().mode).toBe(LOW_MEMORY_MODES.ON);
        lowRamRuntime.setLowMemoryMode(LOW_MEMORY_MODES.OFF);
        expect(store.get(LOW_MEMORY_MODE_STORAGE_KEY)).toBe('off');
        expect(lowRamRuntime.getLowMemoryState().active).toBe(false);

        expect(normalizeLowMemoryMode('invalid')).toBe(LOW_MEMORY_MODES.AUTO);
        expect(normalizeLowMemoryMode(null)).toBe(LOW_MEMORY_MODES.AUTO);
    });

    test('keeps in-memory mode choice when localStorage is blocked', () => {
        const blockedStorage = {
            getItem: () => { throw new Error('SecurityError'); },
            setItem: () => { throw new Error('QuotaExceededError'); },
        };
        const runtime = createLowMemoryRuntime({
            navigatorRef: { deviceMemory: undefined },
            storageRef: blockedStorage,
            windowRef: new EventTarget(),
            globalRef: {},
        });

        expect(runtime.getLowMemoryState().mode).toBe(LOW_MEMORY_MODES.AUTO);
        expect(runtime.getLowMemoryState().active).toBe(false);

        expect(() => runtime.setLowMemoryMode(LOW_MEMORY_MODES.ON)).not.toThrow();
        expect(runtime.getLowMemoryState().mode).toBe(LOW_MEMORY_MODES.ON);
        expect(runtime.getLowMemoryState().active).toBe(true);
    });

    test('provides idempotent subscription and unsubscription without duplicate notifications', () => {
        const runtime = createLowMemoryRuntime({
            navigatorRef: { deviceMemory: 2 },
            storageRef: { getItem: () => null, setItem: () => {} },
            windowRef: new EventTarget(),
            globalRef: {},
        });
        const listener = jest.fn();

        const unsubscribe1 = runtime.subscribeLowMemoryState(listener);
        const unsubscribe2 = runtime.subscribeLowMemoryState(listener);

        runtime.setLowMemoryMode(LOW_MEMORY_MODES.OFF);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].active).toBe(false);

        // Setting the same mode again does not notify.
        runtime.setLowMemoryMode(LOW_MEMORY_MODES.OFF);
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe1();
        unsubscribe2();
        runtime.setLowMemoryMode(LOW_MEMORY_MODES.ON);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('does not wait on non-Android browsers and bounds the Android profile wait to 500 ms', async () => {
        const scheduleTimeout = jest.fn();
        const browserRuntime = createLowMemoryRuntime({
            navigatorRef: { deviceMemory: 2 },
            storageRef: { getItem: () => null, setItem: () => {} },
            windowRef: new EventTarget(),
            globalRef: {},
            setTimeoutRef: scheduleTimeout,
        });

        const browserState = await browserRuntime.waitForAndroidMemoryProfile();
        expect(scheduleTimeout).not.toHaveBeenCalled();
        expect(browserState.active).toBe(true);
        expect(browserState.nativeProfileStatus).toBe('not-applicable');

        let timeoutCallback = null;
        let scheduledDelay = null;
        const androidRuntime = createLowMemoryRuntime({
            navigatorRef: { deviceMemory: 4 },
            storageRef: { getItem: () => null, setItem: () => {} },
            windowRef: new EventTarget(),
            globalRef: { NeconyanAndroid: {} },
            setTimeoutRef: (fn, delayMs) => {
                timeoutCallback = fn;
                scheduledDelay = delayMs;
                return 99;
            },
            clearTimeoutRef: () => {},
        });

        const waitPromise = androidRuntime.waitForAndroidMemoryProfile({ timeoutMs: 5000 });
        expect(scheduledDelay).toBe(NATIVE_MEMORY_WAIT_TIMEOUT_MS);

        timeoutCallback();
        const timedOutState = await waitPromise;
        expect(timedOutState.nativeProfileStatus).toBe('timeout');
        expect(timedOutState.classification.source).toBe('browser');
        expect(timedOutState.active).toBe(false);

        // A late native profile still updates the policy once without reloading.
        const listener = jest.fn();
        androidRuntime.subscribeLowMemoryState(listener);
        expect(androidRuntime.acceptAndroidMemoryProfile({
            schema: 1,
            totalMemoryMiB: 3072,
            isLowRamDevice: false,
        })).toBe(true);

        const lateState = androidRuntime.getLowMemoryState();
        expect(lateState.nativeProfileStatus).toBe('late');
        expect(lateState.classification.source).toBe('native');
        expect(lateState.active).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('resolves pending Android wait immediately when old 2-argument bridge install passes no profile', async () => {
        const clearTimeoutRef = jest.fn();
        const androidRuntime = createLowMemoryRuntime({
            navigatorRef: { deviceMemory: 2 },
            storageRef: { getItem: () => null, setItem: () => {} },
            windowRef: new EventTarget(),
            globalRef: { NeconyanAndroid: {} },
            setTimeoutRef: () => 42,
            clearTimeoutRef,
        });

        const waitPromise = androidRuntime.waitForAndroidMemoryProfile();
        expect(androidRuntime.acceptAndroidMemoryProfile(undefined)).toBe(false);
        const state = await waitPromise;

        expect(clearTimeoutRef).toHaveBeenCalledWith(42);
        expect(state.nativeProfileStatus).toBe('unavailable');
        expect(state.classification.source).toBe('browser');
        expect(state.active).toBe(true);
    });
});
