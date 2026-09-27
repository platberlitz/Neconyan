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
        document: { hidden: false },
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

    test('does not make update requests from hidden tabs', async () => {
        const { context, shown } = createContext({ repository: { isRepo: true, remoteCommit: 'abc1234', behind: 1 } });
        context.document.hidden = true;
        let requests = 0;
        context.requestServerAdmin = () => { requests++; };
        await context.checkForNeconyanUpdate();
        expect(requests).toBe(0);
        expect(shown).toEqual([]);
        expect(context.nnUpdateToastChecking).toBe(false);
    });

    test('dismisses after eight seconds, protecting hover and keyboard focus and cancelling on close', () => {
        let callback;
        let removed = false;
        let hovered = false;
        let focused = false;
        const toast = { matches: () => hovered, contains: () => focused, remove: () => { removed = true; } };
        const context = vm.createContext({
            NN_UPDATE_TOAST_DURATION_MS: 8000,
            nnUpdateToastDismissTimer: null,
            document: { activeElement: null, getElementById: () => toast },
            setTimeout: (fn, delay) => { expect(delay).toBe(8000); callback = fn; return 1; },
            clearTimeout: () => { callback = null; },
        });
        vm.runInContext([extract('dismissUpdateToast'), extract('scheduleUpdateToastDismissal')].join('\n'), context);
        context.scheduleUpdateToastDismissal(toast);
        hovered = true;
        callback();
        expect(removed).toBe(false);
        hovered = false;
        focused = true;
        callback();
        expect(removed).toBe(false);
        focused = false;
        callback();
        expect(removed).toBe(true);
        expect(callback).toBeNull();
        expect(context.nnUpdateToastDismissTimer).toBeNull();
    });
});
