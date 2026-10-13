/* global globalThis, document, sessionStorage, localStorage */
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createServer } from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, test, expect } from '@playwright/test';

const publicRoot = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));

test.beforeEach(async ({ page }) => {
    await page.route('http://crash.test/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/server-admin/crash-reports') return route.fulfill({ status: 403, body: 'Forbidden' });
        if (url.pathname.startsWith('/scripts/')) {
            const file = path.resolve(publicRoot, '.' + url.pathname);
            if (!file.startsWith(publicRoot + path.sep)) return route.abort();
            return route.fulfill({ contentType: 'text/javascript', path: file });
        }
        return route.fulfill({ contentType: 'text/html', body: '<script src="/scripts/crash-diagnostics.js"></script><main>Crash report test</main>' });
    });
    await page.goto('http://crash.test/');
});

async function openReader(page) {
    await page.evaluate(async () => {
        globalThis.SillyTavern = { getContext: () => ({
            getRequestHeaders: () => ({}), POPUP_TYPE: { TEXT: 1 },
            callGenericPopup(content) { document.body.appendChild(content); },
        }) };
        const ui = await import('/scripts/extensions/neconyan-debugger/src/ui.js');
        ui.setActive(false);
        await ui.showCrashReports();
    });
}

test('a real exception before debugger startup survives reload and can be downloaded', async ({ page }) => {
    await page.evaluate(() => {
        setTimeout(() => { throw new Error('Crash fixture password=private-value', { cause: new Error('Root failure') }); }, 0);
    });
    await expect.poll(() => page.evaluate(() => globalThis.NeconyanCrashDiagnostics.getReports().reports.length)).toBe(1);
    await page.reload();
    await openReader(page);
    const report = page.getByRole('textbox', { name: 'Saved crash reports' });
    const value = await report.inputValue();
    expect(value).toContain('Root failure');
    expect(value).toContain('uncaught-exception');
    await expect(page.getByText('Server reports require an administrator account.')).toBeVisible();
    expect(value).not.toContain('private-value');
    expect(await report.getAttribute('readonly')).not.toBeNull();
    const downloadReady = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download report' }).click();
    const download = await downloadReady;
    expect(await fs.readFile(await download.path(), 'utf8')).toBe(value);
});

test('browser reports remain available offline and the APK reader is accessible', async ({ page }) => {
    await page.evaluate(() => {
        Promise.reject(new Error('Rejected operation'));
        globalThis.androidReportsOpened = 0;
        globalThis.NeconyanExport = { showCrashReports() { globalThis.androidReportsOpened++; } };
    });
    await expect.poll(() => page.evaluate(() => globalThis.NeconyanCrashDiagnostics.getReports().reports.length)).toBe(1);
    await page.route('**/api/server-admin/crash-reports', route => route.abort());
    await openReader(page);
    const value = await page.getByRole('textbox', { name: 'Saved crash reports' }).inputValue();
    expect(value).toContain('Rejected operation');
    await expect(page.getByText('The server could not be reached. Saved browser reports are still available.')).toBeVisible();
    await page.getByRole('button', { name: 'Android crash reports' }).click();
    expect(await page.evaluate(() => globalThis.androidReportsOpened)).toBe(1);
});

test('same-tab unexpected stop offers the old activity and dismisses once', async ({ page }) => {
    await page.addInitScript(() => {
        if (sessionStorage.getItem('fixture-seeded')) return;
        sessionStorage.setItem('fixture-seeded', 'yes'); sessionStorage.setItem('neconyan.crash-tab.v1', 'fixture-tab');
        localStorage.setItem('neconyan.crash-session.v1:fixture-tab', JSON.stringify({ schema: 1, documentId: 'old-document', state: 'running', visibility: 'visible', heartbeatAt: Date.now(),
            snapshot: { schema: 1, pageSessionId: 'old-document', at: Date.now() - 4000, mode: 'roleplay', chat: { messageCount: 58 },
                agents: { running: [{ label: 'Format Fixer', phase: 'post', location: 'server' }, { label: 'Proofreader', phase: 'post', location: 'server' }] } }, events: [] }));
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Read report', exact: true })).toBeVisible();
    await expect(page.getByText(/Last known activity: 58 messages/)).toBeVisible();
    await page.getByRole('button', { name: 'Read report', exact: true }).click();
    const report = page.getByRole('textbox', { name: 'Saved crash reports' });
    await expect(report).toBeVisible();
    expect(await report.inputValue()).toContain('Proofreader');
    expect(await report.inputValue()).toContain('definite cause');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Read report', exact: true })).toHaveCount(0);
});

test('a disposable Chromium renderer crash retains the old sample on reload', async () => {
    test.setTimeout(60000);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neconyan-crash-browser-'));
    const server = createServer(async (request, response) => {
        if (request.url.startsWith('/scripts/')) {
            const file = path.resolve(publicRoot, '.' + new URL(request.url, 'http://localhost').pathname);
            if (!file.startsWith(publicRoot + path.sep)) { response.writeHead(403); response.end(); return; }
            response.setHeader('Content-Type', 'text/javascript');
            response.end(await fs.readFile(file));
        } else response.end('<script src="/scripts/crash-diagnostics.js"></script><main>Disposable renderer crash fixture</main>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const debugPort = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const context = await chromium.launchPersistentContext(directory, { headless: true, args: [`--remote-debugging-port=${debugPort}`] });
    let restoredBrowser;
    try {
        const page = context.pages()[0];
        const url = `http://127.0.0.1:${server.address().port}`;
        await page.goto(url);
        await page.evaluate(() => {
            globalThis.NeconyanCrashDiagnostics.updateActivity({ mode: 'roleplay', chat: { messageCount: 58 } });
            globalThis.NeconyanCrashDiagnostics.beginAgent({ id: 'test-agent', sourceTemplateId: 'tpl-proofreader', phase: 'post' });
            globalThis.NeconyanCrashDiagnostics.flushActivity('fixture');
        });
        const session = await context.newCDPSession(page);
        const crashed = page.waitForEvent('crash');
        void session.send('Page.crash').catch(() => {});
        await crashed;
        await session.send('Page.navigate', { url: url + '/recovered' });
        // Playwright marks a crashed Page permanently. A fresh CDP client observes
        // the same physical tab after browser-level navigation, not a seeded new tab.
        restoredBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
        const restored = restoredBrowser.contexts()[0].pages()[0];
        await expect(restored.getByRole('button', { name: 'Read report', exact: true })).toBeVisible();
        expect(await restored.evaluate(() => globalThis.NeconyanCrashDiagnostics.getReports().recoveries.at(-1).lastKnownActivity.snapshot.chat.messageCount)).toBe(58);
    } finally {
        await restoredBrowser?.close();
        await context.close().catch(() => {});
        await new Promise(resolve => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('critical startup failure is readable, then suppressed if the document reaches ready', async ({ page }) => {
    await page.route('http://crash.test/script.js', route => route.abort());
    await page.route('http://crash.test/fatal', route => route.fulfill({ contentType: 'text/html', body: '<script src="/scripts/crash-diagnostics.js"></script><script type="module" src="/script.js"></script><main>Fatal fixture</main>' }));
    await page.goto('http://crash.test/fatal');
    await expect(page.getByRole('button', { name: 'Read report', exact: true })).toBeVisible();
    expect(await page.evaluate(() => globalThis.NeconyanCrashDiagnostics.getReports().reports.at(-1).kind)).toBe('critical-startup-load-failure');
    await page.evaluate(() => globalThis.NeconyanCrashDiagnostics.markAppReady());
    await expect(page.getByRole('button', { name: 'Read report', exact: true })).toHaveCount(0);
});

test('background discard is manual-only and does not replace saved errors', async ({ page }) => {
    await page.addInitScript(() => {
        sessionStorage.setItem('neconyan.crash-tab.v1', 'background-tab');
        localStorage.setItem('neconyan.crash-session.v1:background-tab', JSON.stringify({ schema: 1, documentId: 'background-document', state: 'running', visibility: 'hidden', heartbeatAt: Date.now(), snapshot: { pageSessionId: 'background-document', visibility: 'hidden', at: Date.now(), mode: 'roleplay' } }));
        localStorage.setItem('neconyan.crash-reports.v1', JSON.stringify(Array.from({ length: 5 }, (_, index) => ({ schema: 1, id: `real-${index}`, runtime: 'browser', kind: 'error', error: { message: `Real error ${index}` } }))));
    });
    await page.reload();
    await expect(page.locator('#neconyan-crash-notice')).toHaveCount(0);
    expect(await page.evaluate(() => globalThis.NeconyanCrashDiagnostics.getReports().reports.length)).toBe(5);
    expect(await page.evaluate(() => globalThis.NeconyanCrashDiagnostics.getReports().recoveries.length)).toBe(1);
    await openReader(page);
    const options = page.getByRole('combobox', { name: 'Select a crash report' }).locator('option');
    await expect(options.filter({ hasText: /- error$/ })).toHaveCount(5);
    await expect(options.filter({ hasText: 'unclean-previous-page' })).toHaveCount(1);
});

test('server report reloads deduplicate the picker', async ({ page }) => {
    await page.route('**/api/server-admin/crash-reports', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reports: [{ schema: 1, id: 'server-one', runtime: 'server', kind: 'test', error: { message: 'Server error' } }] }) }));
    await openReader(page);
    const options = page.getByRole('combobox', { name: 'Select a crash report' }).locator('option');
    await expect(options).toHaveCount(1);
    await page.getByRole('button', { name: 'Load server reports' }).click();
    await expect(page.getByText('1 saved server reports')).toBeVisible();
    await expect(options).toHaveCount(1);
});

test('recovery wording reflects a before-reply Agent phase', async ({ page }) => {
    await page.addInitScript(() => {
        sessionStorage.setItem('neconyan.crash-tab.v1', 'pre-tab');
        localStorage.setItem('neconyan.crash-session.v1:pre-tab', JSON.stringify({ schema: 1, documentId: 'pre-document', state: 'running', visibility: 'visible', heartbeatAt: Date.now(), snapshot: { pageSessionId: 'pre-document', at: Date.now(), generation: { phase: 'pre-agents' }, agents: { running: [{ label: 'Format Fixer', phase: 'pre', location: 'server' }] } } }));
    });
    await page.reload();
    await expect(page.locator('#neconyan-crash-notice')).toContainText('before a reply');
    await expect(page.locator('#neconyan-crash-notice')).not.toContainText('after a reply');
});
