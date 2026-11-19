import { afterEach, describe, expect, jest, test } from '@jest/globals';

const {
    getPendingSettingsSetupTaskNames,
    registerSettingsSetupTask,
    waitForSettingsSetup,
} = await import('../public/scripts/settings-setup.js');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

describe('settings setup tasks', () => {
    test('nothing pending lets a reply go at once', async () => {
        expect(getPendingSettingsSetupTaskNames()).toEqual([]);
        await expect(waitForSettingsSetup()).resolves.toBe(true);
    });

    test('a reply waits for setup that is still changing settings', async () => {
        const setup = deferred();
        registerSettingsSetupTask('first start', setup.promise);
        let waited = false;
        const waiting = waitForSettingsSetup().then(result => {
            waited = true;
            return result;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(waited).toBe(false);
        expect(getPendingSettingsSetupTaskNames()).toEqual(['first start']);
        setup.resolve();
        await expect(waiting).resolves.toBe(true);
        expect(getPendingSettingsSetupTaskNames()).toEqual([]);
    });

    test('setup started while waiting is waited for too', async () => {
        const first = deferred();
        const second = deferred();
        registerSettingsSetupTask('agents', first.promise);
        const waiting = waitForSettingsSetup();
        first.promise.then(() => registerSettingsSetupTask('trim rules', second.promise));
        first.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(getPendingSettingsSetupTaskNames()).toEqual(['trim rules']);
        second.resolve();
        await expect(waiting).resolves.toBe(true);
    });

    test('failed setup is logged and stops holding replies', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const setup = deferred();
        registerSettingsSetupTask('broken', setup.promise);
        const waiting = waitForSettingsSetup();
        setup.reject(new Error('offline'));
        await expect(waiting).resolves.toBe(true);
        expect(warn).toHaveBeenCalledWith('[Settings] broken did not finish cleanly.', expect.any(Error));
    });

    test('a reply stops waiting at the cap', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const setup = deferred();
        registerSettingsSetupTask('stuck', setup.promise, { timeoutMs: 60_000 });
        await expect(waitForSettingsSetup({ timeoutMs: 20 })).resolves.toBe(false);
        setup.resolve();
        await expect(waitForSettingsSetup()).resolves.toBe(true);
    });

    test('setup that never finishes stops holding replies after its own limit', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        registerSettingsSetupTask('never', new Promise(() => {}), { timeoutMs: 20 });
        await expect(waitForSettingsSetup({ timeoutMs: 1000 })).resolves.toBe(true);
        expect(warn).toHaveBeenCalledWith('[Settings] never is still running; replies no longer wait for it.');
        expect(getPendingSettingsSetupTaskNames()).toEqual([]);
    });
});
