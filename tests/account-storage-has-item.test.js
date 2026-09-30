/* global globalThis */
import { afterAll, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

await jest.unstable_mockModule('../public/script.js', () => ({
    saveSettingsDebounced: jest.fn(),
}));

const { accountStorage } = await import('../public/scripts/util/AccountStorage.js');

afterAll(() => {
    delete globalThis.localStorage;
});

describe('account storage key checks', () => {
    test('hasItem reports stored keys without copying the state', () => {
        globalThis.localStorage = { length: 0, key: () => null, getItem: () => null, removeItem: () => {} };
        accountStorage.init({ __migrated: '2', 'drawer-open': 'true' });

        const clone = jest.spyOn(globalThis, 'structuredClone');
        try {
            expect(accountStorage.hasItem('__migrated')).toBe(true);
            expect(accountStorage.hasItem('drawer-open')).toBe(true);
            expect(accountStorage.hasItem('missing')).toBe(false);
            expect(accountStorage.hasItem('toString')).toBe(false);
            expect(clone).not.toHaveBeenCalled();
        } finally {
            clone.mockRestore();
        }

        accountStorage.removeItem('drawer-open');
        expect(accountStorage.hasItem('drawer-open')).toBe(false);
    });

    test('the shell checks the ready marker with hasItem before falling back to a snapshot', () => {
        const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
        const start = source.indexOf('function getShellAccountStorage()');
        const body = source.slice(start, source.indexOf('\n}\n', start));

        expect(start).toBeGreaterThan(-1);
        expect(body).toContain('storage.hasItem(NN_ACCOUNT_STORAGE_READY_MARKER)');
        expect(body.indexOf('storage.hasItem(')).toBeLessThan(body.indexOf('storage.getState()'));
    });
});
