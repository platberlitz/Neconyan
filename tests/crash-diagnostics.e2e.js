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
        ui.setActive(true);
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
    expect(value).toContain('administrator account');
    expect(value).not.toContain('private-value');
    expect(await report.getAttribute('readonly')).not.toBeNull();
    const downloadReady = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download reports' }).click();
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
    expect(value).toContain('server could not be reached');
    await page.getByRole('button', { name: 'Android crash reports' }).click();
    expect(await page.evaluate(() => globalThis.androidReportsOpened)).toBe(1);
});
