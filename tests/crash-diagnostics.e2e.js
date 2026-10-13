/* global globalThis, document */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

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
        localStorage.setItem('neconyan.crash-session.v1:fixture-tab', JSON.stringify({ schema: 1, documentId: 'old-document', state: 'running', heartbeatAt: Date.now(),
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
