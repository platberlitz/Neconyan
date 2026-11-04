/* eslint-env browser */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createZipReleaseChecker } from '../src/server-admin-zip-update.js';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} ZIP app updates use the verified release and recover from a failed check`, async ({ app }) => {
        const account = await app.account({ phone });
        const check = createZipReleaseChecker({ fetchImpl: async () => new Response(JSON.stringify({
            tag_name: 'v1.4.1', name: 'Neconyan 1.4.1', assets: [{ name: 'Neconyan-1.4.1-source.zip', size: 123,
                digest: `sha256:${'a'.repeat(64)}`, browser_download_url: 'https://github.com/platberlitz/Neconyan/releases/download/v1.4.1/Neconyan-1.4.1-source.zip' }],
        })) });
        const verified = await check('1.4.0');
        let release = { supported: false, checked: false, canUpdate: false,
            message: 'ZIP updates are not available because this copy of Neconyan has no place set up to download releases from.' };
        const updates = [];
        const requests = [];
        await account.context.route('**/api/server-admin/status', route => {
            requests.push(route.request().postDataJSON());
            return route.fulfill({ json: { runtime: 'Node.js', version: { pkgVersion: '1.4.0' },
                repository: { supported: false, isRepo: false }, release } });
        });
        // The browser checks controls and request routing; helper subprocess tests
        // exercise installation/restart without changing the test server itself.
        await account.context.route('**/api/server-admin/zip-update', route => {
            updates.push(route.request().postDataJSON());
            return route.fulfill({ json: { updated: false, restarting: false, message: 'Fixture ZIP update accepted' } });
        });
        const page = await account.open({ workspace: false, readyTimeout: 60000, timeout: 60000 });
        // The shared account fixture blocks update notices with a page-level route.
        // Remove it so this test's context-level release response can be exercised.
        await page.unroute('**/api/server-admin/status');
        await page.waitForFunction(async () => {
            const { eventSource, event_types } = await import('/scripts/events.js');
            return eventSource.autoFireLastArgs.has(event_types.APP_READY);
        });
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'server'));
        const panel = page.locator('#sb-shell-panel-right-server');
        const button = panel.getByRole('button', { name: 'Update & Restart', exact: true });
        const refresh = panel.getByRole('button', { name: 'Check for updates', exact: true });
        await refresh.click();
        await expect(button).toBeDisabled();
        await expect(panel).toContainText(release.message);
        const screenshot = async phase => {
            await button.scrollIntoViewIfNeeded();
            const filename = path.resolve('..', 'screenshots', `${viewport}-zip-app-update-${phase}.png`);
            await fs.mkdir(path.dirname(filename), { recursive: true });
            await page.screenshot({ path: filename });
            await test.info().attach(`${viewport}-zip-app-update-${phase}`, { path: filename, contentType: 'image/png' });
        };
        await screenshot('before');
        release = verified;
        await refresh.click();
        await expect(button).toBeEnabled();
        await expect(panel).toContainText('Neconyan v1.4.1 is available.');
        expect(requests.at(-1).forceRefresh).toBe(true);
        await expect(button).toHaveAttribute('data-sb-update-mode', 'zip');
        await screenshot('after');
        const geometry = await button.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: window.innerWidth };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.width);
        await button.click();
        await expect(panel).toContainText('Fixture ZIP update accepted');
        expect(updates).toHaveLength(1);
        release = { ...verified, checked: false, canUpdate: false, message: 'Could not check GitHub for a ZIP update. Check your connection and try again.' };
        await refresh.click();
        await expect(button).toBeDisabled();
        await expect(panel).toContainText(release.message);
        release = verified;
        await refresh.click();
        await expect(button).toBeEnabled();
    });
}
