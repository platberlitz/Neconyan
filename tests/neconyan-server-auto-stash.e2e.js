/* global window */
import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';

const files = ['package.json', 'package-lock.json', ...Array.from({ length: 11 }, (_, i) => `public/local-${i}.txt`),
    'public/<img src=x onerror=alert(1)>.txt', `public/${'long-path-'.repeat(18)}.txt`];
const config = 'autoStashBeforePull: false\nport: 4433\n';

for (const phone of [false, true]) {
    test.describe(`${phone ? 'phone' : 'desktop'} server auto-stash`, () => {
        test.setTimeout(90000);
        test.use({ serviceWorkers: 'block', viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone });

        async function checkForUpdates(page, button) {
            const [response] = await Promise.all([
                page.waitForResponse(response => response.url().endsWith('/api/server-admin/status')
                    && response.request().postDataJSON()?.forceRefresh === true),
                button.click(),
            ]);
            return response.request().postDataJSON();
        }

        async function openServer(page, { defaultAutoStash = false, ahead = 0, behind = 1 } = {}) {
            const state = { fail: false, requests: [], updates: [], configSaves: [] };
            await page.emulateMedia({ reducedMotion: 'reduce' });
            let savedSettings;
            await page.route('**/api/settings/get', async route => {
                const envelope = await (await route.fetch()).json();
                if (typeof envelope.settings !== 'string') return route.fulfill({ json: envelope });
                const settings = savedSettings ?? JSON.parse(envelope.settings);
                settings.firstRun = false;
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
                await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
            });
            await page.route('**/api/settings/save', route => {
                let bytes = route.request().postDataBuffer();
                if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
                const payload = JSON.parse(bytes.toString());
                savedSettings = { ...payload, _version: Math.max(Date.now(), Number(payload._version || 0) + 1), _settingsRevision: Number(payload._settingsRevision || 0) + 1 };
                return route.fulfill({ json: { result: 'ok', version: savedSettings._version, settingsRevision: savedSettings._settingsRevision } });
            });
            await page.route('**/api/server-admin/config/get', route => route.fulfill({ json: { content: config, lastModifiedMs: 1, path: 'config.yaml' } }));
            await page.route('**/api/server-admin/config/save', route => {
                state.configSaves.push(route.request().postDataJSON());
                return route.fulfill({ json: {} });
            });
            await page.route('**/api/server-admin/branches', route => route.fulfill({ json: { currentBranch: 'staging', branches: ['staging'] } }));
            await page.route('**/api/server-admin/status', route => {
                const body = route.request().postDataJSON();
                state.requests.push(body);
                if (state.fail) return route.fulfill({ status: 503, json: { error: 'Fixture status unavailable' } });
                const autoStash = body.autoStash ?? defaultAutoStash;
                return route.fulfill({ json: {
                    runtime: 'Node.js', version: { pkgVersion: '1.3.0', gitRevision: 'abc123' },
                    repository: { supported: true, isRepo: true, branch: 'staging', trackingBranch: 'origin/staging',
                        hasLocalChanges: true, autoStash, ahead, behind, canUpdate: autoStash && ahead === 0 && behind > 0,
                        changedFilesCount: files.length, changedFiles: files.map(path => ({ path, index: ' ', workingDir: 'M' })),
                        message: autoStash ? 'Local changes will be auto-stashed before updating.' : 'Local changes are present, so auto-update is blocked to protect your work.' },
                } });
            });
            // Never send a real update from a browser fixture.
            await page.route('**/api/server-admin/update', route => {
                state.updates.push(route.request().postDataJSON());
                return route.fulfill({ json: { updated: false, restarting: false, message: 'Fixture update accepted' } });
            });
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.NeconyanShell?.openTab, { timeout: 60000 });
            await expect(page.locator('#loader')).toBeHidden({ timeout: 60000 });
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'server'));
            const panel = page.locator('#sb-shell-panel-right-server');
            const checkbox = panel.locator('#auto_stash_before_pull');
            await expect(checkbox).toBeEnabled({ timeout: 30000 });
            return { panel, checkbox, state, update: panel.getByRole('button', { name: 'Update & Restart', exact: true }),
                refresh: panel.getByRole('button', { name: 'Check for updates', exact: true }) };
        }

        test('shows every changed file and applies the checkbox without editing or saving config', async ({ page }) => {
            const { panel, checkbox, state, update, refresh } = await openServer(page);
            await expect(update).toBeDisabled();
            const list = panel.locator('.sb-server-note').filter({ has: page.getByText(`Changed files: ${files.length}`, { exact: true }) });
            await expect(list).toBeVisible();
            for (const file of files) await expect(list.getByText(file, { exact: true })).toBeVisible();
            await expect(list.locator('img')).toHaveCount(0);
            await list.scrollIntoViewIfNeeded();
            const geometry = await list.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth,
                left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, viewport: window.innerWidth }));
            expect(geometry.content).toBeLessThanOrEqual(geometry.width + 1);
            expect(geometry.left).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
            const editor = panel.getByRole('textbox', { name: 'config.yaml editor', exact: true });
            await editor.fill(config + '# unsaved draft\n');
            await checkbox.check();
            await expect(update).toBeEnabled();
            await expect(panel).toContainText('Auto-stash is on for this session.');
            await expect(editor).toHaveValue(config + '# unsaved draft\n');
            const refreshBody = await checkForUpdates(page, refresh);
            await expect(update).toBeEnabled();
            await expect(checkbox).toBeChecked();
            expect(refreshBody).toMatchObject({ forceRefresh: true, autoStash: true });
            await expect(editor).toHaveValue(config + '# unsaved draft\n');
            expect(state.configSaves).toEqual([]);
            await update.click();
            await expect(panel).toContainText('Fixture update accepted');
            expect(state.updates).toEqual([{ autoStash: true }]);
        });

        test('can turn off a true default and restores the last choice when checking fails', async ({ page }) => {
            const { panel, checkbox, state, update, refresh } = await openServer(page, { defaultAutoStash: true });
            await expect(update).toBeEnabled();
            await checkbox.uncheck();
            await expect(panel).toContainText('Auto-stash is off.');
            await expect(update).toBeDisabled();
            const refreshBody = await checkForUpdates(page, refresh);
            await expect(checkbox).toBeEnabled();
            await expect(checkbox).not.toBeChecked();
            expect(refreshBody.autoStash).toBe(false);
            state.fail = true;
            await checkbox.click();
            await expect(panel).toContainText('Fixture status unavailable');
            await expect(checkbox).not.toBeChecked();
            await expect(update).toBeDisabled();
            state.fail = false;
            const retryBody = await checkForUpdates(page, refresh);
            await expect(checkbox).toBeEnabled();
            expect(retryBody.autoStash).toBe(false);
        });

        test('still blocks a diverged branch with auto-stash enabled', async ({ page }) => {
            const { panel, checkbox, update } = await openServer(page, { ahead: 1 });
            await checkbox.check();
            await expect(panel).toContainText('Auto-stash is on for this session.');
            await expect(update).toBeDisabled();
            await expect(panel.locator('.sb-server-pill')).toHaveText('Update Blocked');
        });

        test('shows auto-stash enabled rather than blocked when no update exists', async ({ page }) => {
            const { panel, update } = await openServer(page, { defaultAutoStash: true, behind: 0 });
            await expect(update).toBeDisabled();
            await expect(panel.locator('.sb-server-pill')).toHaveText('Auto-stash Enabled');
        });
    });
}
