import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsSource = fs.readFileSync(path.join(root, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');
const toastCss = fs.readFileSync(path.join(root, 'public', 'css', 'neconyan-update-toast.css'), 'utf8');

function extract(name) {
    const match = tabsSource.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'));
    if (!match) throw new Error(`Missing ${name}`);
    return match[0];
}

function createContext(status) {
    const store = new Map();
    const shown = [];
    const context = vm.createContext({
        nnUpdateToastChecking: false,
        nnUpdateToastTimer: 1,
        NN_UPDATE_TOAST_STORAGE_KEY: 'neconyan:update-toast-commit',
        localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
        requestServerAdmin: async () => {
            if (status instanceof Error) throw status;
            return status;
        },
        showUpdateToast: async repository => {
            store.set('neconyan:update-toast-commit', repository.remoteCommit);
            shown.push(repository.remoteCommit);
        },
        clearInterval: () => {},
    });
    vm.runInContext([extract('readNotifiedUpdateCommit'), extract('checkForNeconyanUpdate')].join('\n'), context);
    return { context, shown };
}

describe('update toast', () => {
    test('shows once per new upstream commit', async () => {
        const status = { repository: { isRepo: true, remoteCommit: 'abc1234', behind: 2 } };
        const { context, shown } = createContext(status);
        await context.checkForNeconyanUpdate();
        await context.checkForNeconyanUpdate();
        expect(shown).toEqual(['abc1234']);
        status.repository.remoteCommit = 'def5678';
        await context.checkForNeconyanUpdate();
        expect(shown).toEqual(['abc1234', 'def5678']);
    });

    test('stays quiet when up to date, and stops polling without admin access', async () => {
        const upToDate = createContext({ repository: { isRepo: true, remoteCommit: 'abc1234', behind: 0 } });
        await upToDate.context.checkForNeconyanUpdate();
        expect(upToDate.shown).toEqual([]);

        const denied = Object.assign(new Error('no'), { status: 403 });
        const forbidden = createContext(denied);
        await forbidden.context.checkForNeconyanUpdate();
        expect(forbidden.shown).toEqual([]);
        expect(vm.runInContext('nnUpdateToastTimer', forbidden.context)).toBeNull();
    });

    test('starts after the app is ready, opens Server, and respects reduced motion', () => {
        expect(tabsSource).toMatch(/window\.addEventListener\('neconyan:ready'[\s\S]*?startNeconyanUpdateToast\(\);/);
        expect(extract('showUpdateToast')).toContain('openShell(\'right\', \'server\')');
        expect(tabsSource).toContain('NN_UPDATE_TOAST_INTERVAL_MS = 30 * 60 * 1000');
        expect(toastCss).toContain('@media (prefers-reduced-motion: reduce) { .nn-update-toast { animation: none; } }');
    });
});
