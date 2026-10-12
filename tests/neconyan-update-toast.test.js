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
        document: { hidden: false, addEventListener() {}, removeEventListener() {} },
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

    test('announces compatible APK releases once per version, without requiring Git', async () => {
        const status = { repository: { isRepo: false }, androidRelease: {
            supported: true, checked: true, assetAvailable: true, canUpdate: true, latestVersion: '1.3.0', architecture: 'arm64',
        } };
        const { context, shown } = createContext(status);
        await context.checkForNeconyanUpdate();
        await context.checkForNeconyanUpdate();
        expect(shown).toEqual(['apk:arm64:1.3.0']);
        status.androidRelease.latestVersion = '1.3.0.1';
        await context.checkForNeconyanUpdate();
        expect(shown).toEqual(['apk:arm64:1.3.0', 'apk:arm64:1.3.0.1']);
        expect(extract('showUpdateToast')).toContain('APK v${repository.latestVersion} is ready. Open Server to update.');
    });

    test.each([{ checked: false }, { assetAvailable: false }, { canUpdate: false }, { latestVersion: '' }])(
        'never announces an unavailable, failed or unnecessary APK update: %j', async override => {
            const { context, shown } = createContext({ androidRelease: {
                supported: true, checked: true, assetAvailable: true, canUpdate: true, latestVersion: '1.3.0', architecture: 'arm64', ...override,
            } });
            await context.checkForNeconyanUpdate();
            expect(shown).toEqual([]);
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

    test('does not consume an APK notice if the app is hidden while GitHub is checked', async () => {
        const status = { androidRelease: {
            supported: true, checked: true, assetAvailable: true, canUpdate: true, latestVersion: '1.3.0', architecture: 'arm64',
        } };
        const { context, shown } = createContext(status);
        let finishRequest;
        context.requestServerAdmin = () => new Promise(resolve => { finishRequest = resolve; });
        const check = context.checkForNeconyanUpdate();
        context.document.hidden = true;
        finishRequest(status);
        await check;
        expect(shown).toEqual([]);
        expect(context.readNotifiedUpdateCommit()).toBe('');
        context.document.hidden = false;
        context.requestServerAdmin = async () => status;
        await context.checkForNeconyanUpdate();
        expect(shown).toEqual(['apk:arm64:1.3.0']);
    });

    test('keeps a notice unread if the app is hidden while its stylesheet loads', async () => {
        let finishStyles;
        const store = new Map();
        const toasts = [];
        const context = vm.createContext({
            document: {
                hidden: false,
                body: { append: toast => toasts.push(toast) },
                createElement: () => ({ setAttribute() {}, querySelector: () => ({ addEventListener() {} }) }),
            },
            NN_UPDATE_TOAST_STORAGE_KEY: 'neconyan:update-toast-commit',
            localStorage: { setItem: (key, value) => store.set(key, value) },
            dismissUpdateToast() {},
            scheduleUpdateToastDismissal() {},
            loadUpdateToastStyles: () => new Promise(resolve => { finishStyles = resolve; }),
        });
        vm.runInContext([extract('rememberNotifiedUpdateCommit'), extract('showUpdateToast')].join('\n'), context);
        const show = context.showUpdateToast({ kind: 'apk', remoteCommit: 'apk:arm64:1.3.0', latestVersion: '1.3.0' });
        context.document.hidden = true;
        finishStyles();
        await show;
        expect(toasts).toEqual([]);
        expect(store.size).toBe(0);
    });

    test('checks again on returning to the app and removes that listener without admin access', async () => {
        const { context } = createContext(Object.assign(new Error('no'), { status: 403 }));
        const listeners = new Set();
        context.document.addEventListener = (name, callback) => { expect(name).toBe('visibilitychange'); listeners.add(callback); };
        context.document.removeEventListener = (name, callback) => { expect(name).toBe('visibilitychange'); listeners.delete(callback); };
        context.setInterval = () => 1;
        context.NN_UPDATE_TOAST_INTERVAL_MS = 1800000;
        context.nnUpdateToastTimer = null;
        vm.runInContext(extract('startNeconyanUpdateToast'), context);
        context.startNeconyanUpdateToast();
        expect(listeners.has(context.checkForNeconyanUpdate)).toBe(true);
        await new Promise(resolve => setImmediate(resolve));
        expect(listeners.size).toBe(0);
        expect(context.nnUpdateToastTimer).toBeNull();
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
