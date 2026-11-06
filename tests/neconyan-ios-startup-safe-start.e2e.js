/* global localStorage, sessionStorage, globalThis, document, window, ErrorEvent */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect, test, webkit } from '@playwright/test';
import { IPHONE_SAFARI_CONTEXT, applyIOSOnlyCss, installIPhoneSafari } from './ios-safari-emulation.js';

const base = process.env.NECONYAN_TEST_BASE_URL;
test.skip(!base, 'Requires this worktree\'s disposable preview.');
test.setTimeout(180000);
test.describe.configure({ mode: 'serial' });

const screenshots = path.resolve('../screenshots');
fs.mkdirSync(screenshots, { recursive: true });

async function installCrashLoopSeed(context) {
    await context.addInitScript(() => {
        const reseedTab = sessionStorage.getItem('nn-safe-start-reseed-tab');
        const firstLoad = !sessionStorage.getItem('nn-safe-start-seeded');
        if (!firstLoad && !reseedTab) return;
        const tabId = reseedTab || 'safe-start-tab';
        sessionStorage.setItem('nn-safe-start-seeded', '1');
        sessionStorage.removeItem('nn-safe-start-reseed-tab');
        sessionStorage.setItem('neconyan.crash-tab.v1', tabId);
        const at = Date.now();
        localStorage.setItem('neconyan.crash-startup-failures.v1', JSON.stringify({ schema: 1, count: 1, at }));
        localStorage.setItem('neconyan.crash-session.v1:' + tabId, JSON.stringify({
            schema: 1, documentId: 'loop-document', state: 'running', ready: false, heartbeatAt: at, visibility: 'visible',
            snapshot: { schema: 1, pageSessionId: 'loop-document', at: at - 4000, view: 'chat', mode: 'roleplay',
                chat: { messageCount: 58, estimatedTextBytes: 340000 }, generation: { phase: 'post-agents', location: 'server' },
                agents: { running: [{ label: 'Proofreader', phase: 'post', location: 'server' }] } },
            events: [],
        }));
    });
}

async function waitForReady(page) {
    await page.waitForFunction(() => globalThis.NeconyanCrashDiagnostics?.getActivity?.()?.snapshot?.ready === true, null, { timeout: 120000 });
}

async function openIphone() {
    const browser = await webkit.launch({ headless: true });
    const context = await browser.newContext(IPHONE_SAFARI_CONTEXT);
    await installIPhoneSafari(context, { standalone: false });
    await installCrashLoopSeed(context);
    const page = await context.newPage();
    return { browser, context, page };
}

test('iPhone: the safe start holds the boot, reads the report and starts in low-memory mode', async () => {
    const { browser, context, page } = await openIphone();
    const settingsRequests = [];
    page.on('request', request => { if (request.url().includes('/api/settings/get')) settingsRequests.push(request.url()); });
    try {
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#neconyan-safe-start')).toBeVisible();
        await applyIOSOnlyCss(page);

        expect(await page.evaluate(() => globalThis.NeconyanCrashDiagnostics.getStartupGuardState())).toMatchObject({
            failures: 2, safeStart: true, holdActive: true, lowMemoryAuto: true, ios: true,
        });
        // The app has not started while the report is on offer.
        expect(await page.evaluate(() => globalThis.NeconyanCrashDiagnostics.getActivity().snapshot.ready)).toBe(false);
        expect(settingsRequests).toHaveLength(0);

        await page.screenshot({ path: path.join(screenshots, 'ios-safe-start-phone.png') });
        const buttons = await page.locator('#neconyan-safe-start button').allTextContents();
        expect(buttons).toEqual(['Start Neconyan', 'Read crash report', 'Start without low-memory mode', 'Clear frontend cache and reload']);

        await page.getByRole('button', { name: 'Read crash report', exact: true }).click();
        const report = page.getByRole('textbox', { name: 'Saved crash reports' });
        await expect(report).toBeVisible();
        const text = await report.inputValue();
        expect(text).toContain('unclean-previous-page');
        expect(text).toContain('Proofreader');
        await page.screenshot({ path: path.join(screenshots, 'ios-safe-start-reader-phone.png') });
        await page.getByRole('button', { name: 'Close', exact: true }).click();

        await page.getByRole('button', { name: 'Start Neconyan', exact: true }).click();
        await expect(page.locator('#neconyan-safe-start')).toHaveCount(0);
        await waitForReady(page);
        expect(settingsRequests.length).toBeGreaterThan(0);
        expect(await page.evaluate(() => localStorage.getItem('neconyan.crash-startup-failures.v1'))).toBeNull();
        expect(await page.evaluate(async () => {
            const lowMemory = await import('/scripts/low-memory-mode.js');
            const state = lowMemory.getLowMemoryState();
            return { active: state.active, mode: state.mode, roleplayWindow: state.roleplayWindowSize, applied: state.appliedKeys };
        })).toMatchObject({ active: true, mode: 'on', roleplayWindow: 25, applied: ['fast_ui_mode', 'chat_truncation'] });
    } finally {
        await context.close();
        await browser.close();
    }
});

test('desktop: low-memory start works, and clearing the cache reloads without another safe start', async () => {
    const browser = await webkit.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await installCrashLoopSeed(context);
    const page = await context.newPage();
    try {
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#neconyan-safe-start')).toBeVisible();
        expect(await page.evaluate(() => globalThis.NeconyanCrashDiagnostics.getStartupGuardState())).toMatchObject({
            failures: 2, safeStart: true, lowMemoryAuto: false, ios: false,
        });
        await page.screenshot({ path: path.join(screenshots, 'ios-safe-start-desktop.png') });
        await expect(page.getByRole('button', { name: 'Start in low-memory mode', exact: true })).toBeVisible();

        await page.getByRole('button', { name: 'Start in low-memory mode', exact: true }).click();
        await waitForReady(page);
        expect(await page.evaluate(() => localStorage.getItem('neconyan:low-memory-mode:v1'))).toBe('on');

        // Seed another unfinished start for this tab and reload into the safe start.
        await page.evaluate(() => sessionStorage.setItem('nn-safe-start-reseed-tab', sessionStorage.getItem('neconyan.crash-tab.v1')));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('#neconyan-safe-start')).toBeVisible();
        expect(await page.evaluate(() => globalThis.NeconyanCrashDiagnostics.getStartupGuardState())).toMatchObject({ failures: 2, safeStart: true });

        await page.getByRole('button', { name: 'Clear frontend cache and reload', exact: true }).click();
        await expect(page.locator('#neconyan-safe-start')).toHaveCount(0);
        await waitForReady(page);
        expect(await page.evaluate(() => localStorage.getItem('neconyan.crash-startup-failures.v1'))).toBeNull();
    } finally {
        await context.close();
        await browser.close();
    }
});

test('iPhone: starting without low-memory mode respects the choice', async () => {
    const { browser, context, page } = await openIphone();
    try {
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#neconyan-safe-start')).toBeVisible();
        await page.getByRole('button', { name: 'Start without low-memory mode', exact: true }).click();
        await waitForReady(page);
        expect(await page.evaluate(() => localStorage.getItem('neconyan:low-memory-mode:v1'))).toBe('off');
        expect(await page.evaluate(async () => {
            const lowMemory = await import('/scripts/low-memory-mode.js');
            return lowMemory.getLowMemoryState().active;
        })).toBe(false);
    } finally {
        await context.close();
        await browser.close();
    }
});

test('iPhone: a normal load without crash history boots straight in', async () => {
    const browser = await webkit.launch({ headless: true });
    const context = await browser.newContext(IPHONE_SAFARI_CONTEXT);
    await installIPhoneSafari(context, { standalone: false });
    const page = await context.newPage();
    try {
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await waitForReady(page);
        await expect(page.locator('#neconyan-safe-start')).toHaveCount(0);
        expect(await page.evaluate(() => globalThis.NeconyanCrashDiagnostics.getStartupGuardState())).toMatchObject({ safeStart: false, holdActive: false });
    } finally {
        await context.close();
        await browser.close();
    }
});

test('native startup diagnostics bound resource failures without losing JavaScript errors or readiness', async () => {
    const controller = fs.readFileSync(new URL('../ios/App/BrowserController.swift', import.meta.url), 'utf8');
    const script = controller.match(/WKUserScript\(source: """\n([\s\S]*?)\n\s*""", injectionTime/)[1];
    for (const browserType of [chromium, webkit]) {
        const browser = await browserType.launch({ headless: true });
        const context = await browser.newContext(IPHONE_SAFARI_CONTEXT);
        await installIPhoneSafari(context, { standalone: true });
        const page = await context.newPage();
        try {
            await page.setContent('<!doctype html><main>Native diagnostics fixture</main>');
            await page.evaluate(() => {
                globalThis.nativeMessages = [];
                globalThis.webkit = { messageHandlers: { nativeDiagnostics: { postMessage: message => globalThis.nativeMessages.push(message) } } };
            });
            await page.evaluate(script);
            await page.evaluate(() => {
                const resource = document.createElement('img');
                // Empty image placeholders previously logged the page URL hundreds of times.
                resource.setAttribute('src', '');
                document.body.append(resource);
                for (let i = 0; i < 100; i++) resource.dispatchEvent(new Event('error'));
                for (let i = 0; i < 100; i++) {
                    resource.setAttribute('src', '/missing-' + i + '.png');
                    resource.dispatchEvent(new Event('error'));
                    resource.dispatchEvent(new Event('error'));
                }
                window.dispatchEvent(new ErrorEvent('error', { message: 'Real startup exception' }));
                window.dispatchEvent(new Event('neconyan:ready'));
            });
            const messages = await page.evaluate(() => globalThis.nativeMessages);
            expect(messages.filter(message => message.kind === 'resource-error')).toHaveLength(30);
            expect(messages).toContainEqual({ kind: 'resource-error', text: 'IMG: /missing-0.png' });
            expect(messages).toContainEqual({ kind: 'error', text: 'Real startup exception' });
            expect(messages).toContainEqual({ kind: 'ready', text: 'Workspace initialisation completed' });
            expect(messages).toHaveLength(32);
        } finally {
            await context.close();
            await browser.close();
        }
    }
});
