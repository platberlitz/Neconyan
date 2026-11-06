/* global document, window, localStorage, getComputedStyle */
import { readFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

const defaultSettings = JSON.parse(readFileSync(new URL('../default/content/settings.json', import.meta.url), 'utf8'));

async function ready(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(async () => document.body.classList.contains('neconyan-rail-ready') && (await import('/script.js')).settingsReady);
    const legacy = page.locator('dialog.popup[open]').filter({ hasText: 'Quick Image Gen found legacy browser-only settings' });
    await legacy.waitFor({ state: 'visible', timeout: 3000 }).then(() => legacy.getByRole('button', { name: 'Cancel', exact: true }).click(), () => {});
}

async function openRail(page, phone) {
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    if (phone && await page.locator('#neconyan-workspace-rail').getAttribute('aria-hidden') !== 'false') {
        await page.locator('#sb-hamburger').click();
    }
    await expect(page.locator('#neconyan-workspace-rail')).toHaveJSProperty('inert', false);
}

for (const phone of [false, true]) {
    test.describe(`${phone ? 'phone' : 'desktop'} searchable Quick Actions`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: 'block', reducedMotion: 'reduce' });
        test('Simple Mode keeps editing, collapsing and saved page shortcuts including Catelier', async ({ page }) => {
            test.setTimeout(180000);
            const mode = phone ? 'mobile' : 'desktop';
            let savedSettings;
            let account = {
                'NeconyanSimpleMode.v1': 'on',
                'NeconyanTutorialStatus.v1': 'completed',
                'NeconyanWorkspaceRailCollapsed.v1': 'false',
                'NeconyanWorkspaceRailSections.v1': '{}',
            };
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const body = await response.json();
                const settings = savedSettings ? structuredClone(savedSettings)
                    : typeof body.settings === 'string' ? JSON.parse(body.settings) : structuredClone(defaultSettings);
                settings.accountStorage = { ...settings.accountStorage, ...account };
                await route.fulfill({ response, json: { ...body, settings: JSON.stringify(settings) } });
            });
            await page.route('**/api/settings/save', async route => {
                let bytes = route.request().postDataBuffer();
                if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
                const payload = JSON.parse(bytes.toString());
                savedSettings = structuredClone(payload);
                account = { ...account, ...payload.accountStorage };
                await route.fulfill({ json: { result: 'ok', version: Number(payload._version || 0) + 1, settingsRevision: Number(payload._settingsRevision || 0) + 1 } });
            });
            await ready(page);
            await expect(page.locator('html')).toHaveClass(/neconyan-simple-mode/);
            const otherMode = phone ? 'desktop' : 'mobile';
            const otherActions = await page.evaluate(mode => localStorage.getItem(`sb-${mode}-quick-actions-v2`), otherMode);
            await openRail(page, phone);
            const heading = page.locator('[data-neconyan-section-toggle="quickActions"]');
            const list = page.locator('[data-neconyan-quick-actions]');
            await expect(heading).toBeVisible();
            await heading.click();
            await expect(list).toBeHidden();
            await heading.click();
            await expect(list).toBeVisible();
            await page.locator('[data-neconyan-edit-quick-actions]').click();
            const search = page.locator(`#sb-${mode}-quick-action-search`);
            await expect(search).toBeVisible();
            for (const label of ['Catelier', 'Notebooks', 'Scratchpad', 'Handbook', 'Conversation']) {
                await search.fill(label);
                await page.getByRole('button', { name: `Add ${label} to ${mode} Quick Actions`, exact: true }).first().click();
                await expect(page.locator(`#sb-${mode}-quick-action-list`)).toContainText(label);
            }
            await search.fill('Catelier');
            await expect(page.getByRole('button', { name: `Catelier is already in ${mode} Quick Actions`, exact: true }).first()).toBeDisabled();
            await openRail(page, phone);
            const catelier = list.getByRole('button', { name: 'Catelier', exact: true });
            await expect(catelier).toBeVisible();
            const geometry = await catelier.evaluate(button => ({ height: button.getBoundingClientRect().height, display: getComputedStyle(button).display }));
            expect(geometry.height).toBeGreaterThanOrEqual(phone ? 44 : 34);
            expect(geometry.display).not.toBe('none');
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 394 : 1281);
            mkdirSync(new URL('../screenshots/', import.meta.url), { recursive: true });
            await page.screenshot({ path: new URL(`../screenshots/quick-actions-${phone ? 'phone' : 'desktop'}-after.png`, import.meta.url).pathname });
            await catelier.click();
            await expect(page.locator('#sb_character_creator_panel')).toBeVisible();
            expect(await page.evaluate(mode => localStorage.getItem(`sb-${mode}-quick-actions-v2`), otherMode)).toBe(otherActions);
            if (phone) await expect(page.locator('#neconyan-workspace-rail')).toHaveAttribute('aria-hidden', 'true');
            // Quick Actions is device-saved; the destination must survive a full reload.
            await expect.poll(() => page.evaluate(mode => JSON.parse(localStorage.getItem(`sb-${mode}-quick-actions-v2`)).some(action => action.dedupeKey === 'characters::creator'), mode)).toBe(true);
            await ready(page);
            await openRail(page, phone);
            await expect(catelier).toBeVisible();
            await catelier.click();
            await expect(page.locator('#sb_character_creator_panel')).toBeVisible();
            await openRail(page, phone);
            await list.getByRole('button', { name: 'Scratchpad', exact: true }).click();
            await expect(page.getByRole('textbox', { name: 'Message for Scratchpad', exact: true })).toBeVisible();
            await openRail(page, phone);
            await page.locator('[data-neconyan-edit-quick-actions]').click();
            await search.fill('Catelier');
            await page.screenshot({ path: new URL(`../screenshots/quick-actions-${phone ? 'phone' : 'desktop'}-editor-after.png`, import.meta.url).pathname });
            await page.getByRole('button', { name: `Remove Catelier from ${mode} Quick Actions`, exact: true }).click();
            await openRail(page, phone);
            await expect(catelier).toHaveCount(0);
            await page.unrouteAll({ behavior: 'ignoreErrors' });
        });
    });
}
