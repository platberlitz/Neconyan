/* global document, window, localStorage, getComputedStyle */
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

const sectionsKey = 'NeconyanWorkspaceRailSections.v1';
const list = '[data-neconyan-quick-actions]';
const toggle = name => `[data-neconyan-section-toggle="${name}"]`;

async function ready(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
}

async function openRail(page, phone) {
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    if (phone) {
        const rail = page.locator('#neconyan-workspace-rail');
        if (await rail.getAttribute('aria-hidden') !== 'false') {
            await page.locator('#sb-hamburger').click();
        }
        await expect(rail).toHaveAttribute('aria-hidden', 'false');
        await expect(rail).toHaveJSProperty('inert', false);
    }
}

async function checkIconSidebar(page, phone) {
    if (phone) return;
    await page.locator('#neconyan-sidebar-toggle').click();
    await expect(page.locator(toggle('workspace'))).toBeHidden();
    await expect(page.locator('[data-neconyan-quick-actions] > button').first()).toBeVisible();
    await page.locator('#neconyan-sidebar-toggle').click();
}

for (const phone of [false, true]) {
    test.describe(`${phone ? 'phone' : 'desktop'} sidebar sections`, () => {
        const mode = phone ? 'mobile' : 'desktop';
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: 'block', reducedMotion: 'reduce' });
        test('saved shortcuts, editing, section keyboard toggles and remembered state', async ({ page }, info) => {
            test.setTimeout(240000);
            let stored = '{}';
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const body = await response.json();
                if (typeof body.settings !== 'string') return route.fulfill({ response, json: body });
                const settings = JSON.parse(body.settings);
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanWorkspaceRailCollapsed.v1': 'false', [sectionsKey]: stored };
                await route.fulfill({ response, json: { ...body, settings: JSON.stringify(settings) } });
            });
            await page.route('**/api/settings/save', async route => {
                let bytes = route.request().postDataBuffer();
                if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
                const payload = JSON.parse(bytes.toString());
                stored = payload.accountStorage[sectionsKey] ?? stored;
                await route.fulfill({ json: { result: 'ok', version: Number(payload._version || 0) + 1, settingsRevision: Number(payload._settingsRevision || 0) + 1 } });
            });
            await page.addInitScript(() => {
                if (localStorage.getItem('sidebar-test-initialised')) return;
                localStorage.setItem('sidebar-test-initialised', 'true');
                localStorage.setItem('sb-desktop-quick-actions-v2', JSON.stringify([{ type: 'tab', shellKey: 'left', tabId: 'presets', label: 'Desktop preset shortcut', icon: 'fa-sliders' }]));
                localStorage.setItem('sb-mobile-quick-actions-v2', JSON.stringify([{ type: 'tab', shellKey: 'left', tabId: 'sampling', label: 'Phone sampling shortcut', icon: 'fa-wave-square' }]));
            });
            await ready(page);
            await openRail(page, phone);
            const shortcut = page.locator(`${list} > button`);
            await expect(shortcut).toHaveText(phone ? 'Phone sampling shortcut' : 'Desktop preset shortcut');
            const geometry = await page.locator(list).evaluate(element => ({
                top: element.getBoundingClientRect().top,
                advancedBottom: document.querySelector('[data-neconyan-advanced-nav]').getBoundingClientRect().bottom,
                display: getComputedStyle(element).display,
            }));
            expect(geometry.top).toBeGreaterThan(geometry.advancedBottom);
            expect(geometry.display).not.toBe('none');
            await shortcut.click();
            await expect(page.locator('#left-nav-panel')).toHaveAttribute('data-sb-active-tab', phone ? 'sampling' : 'presets');
            await openRail(page, phone);
            for (const name of ['workspace', 'advanced', 'quickActions', 'finer', 'modes', 'recent']) {
                const heading = page.locator(toggle(name));
                await heading.scrollIntoViewIfNeeded();
                await expect(heading).toHaveAttribute('aria-expanded', 'true');
                const panelId = await heading.getAttribute('aria-controls');
                const panel = page.locator(`#${panelId}`);
                // Keyboard presses skip visibility/stability checks. Let the drawer
                // finish opening and restoring focus before taking keyboard focus.
                await heading.click({ trial: true });
                await heading.focus();
                await expect(heading).toBeFocused();
                await heading.press('Enter');
                await expect(panel).toBeHidden();
                await expect(heading).toHaveAttribute('aria-expanded', 'false');
                await expect(heading).toBeFocused();
                await heading.press('Space');
                await expect(panel).toBeVisible();
                await heading.click();
            }
            const headingSizes = await page.locator('[data-neconyan-section-toggle]').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
            expect(headingSizes.every(height => height >= (phone ? 44 : 34))).toBe(true);
            await expect(page.locator('[data-neconyan-open-archive]')).toBeVisible();
            await expect(page.locator('[data-neconyan-refresh-recent]')).toBeVisible();
            const tools = page.locator('.neconyan-rail-tools');
            await tools.locator(':scope > summary').click();
            await expect(tools).toHaveAttribute('open', '');
            await expect.poll(() => JSON.parse(stored).recent).toBe(true);
            await expect.poll(() => JSON.parse(stored).tools).toBe(false);
            await ready(page);
            await openRail(page, phone);
            await expect(page.locator('[data-neconyan-section-toggle][aria-expanded="false"]')).toHaveCount(6);
            await expect(tools).toHaveAttribute('open', '');
            await page.locator(toggle('quickActions')).click();
            await expect(shortcut).toBeVisible();
            await page.screenshot({ path: info.outputPath('collapsed-sections.png') });
            await page.locator('[data-neconyan-edit-quick-actions]').click();
            const search = page.locator(`#sb-${mode}-quick-action-search`);
            await expect(search).toBeVisible();
            await page.locator(`#sb-${mode}-quick-action-list button[aria-label^="Remove "]`).click();
            await openRail(page, phone);
            await expect(page.locator(`${list} > button`)).toHaveCount(0);
            await expect(page.locator(list)).toContainText('No Quick Actions');
            await page.locator('[data-neconyan-edit-quick-actions]').click();
            await page.locator(`#sb-${mode}-quick-action-reset`).click();
            await openRail(page, phone);
            await expect(page.locator(`${list} > button`).first()).toBeVisible();
            await page.screenshot({ path: info.outputPath('quick-actions.png') });
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone ? 394 : 1281);
            await expect.poll(() => JSON.parse(stored).quickActions).toBe(false);
            await ready(page);
            await openRail(page, phone);
            await expect(page.locator(`${list} > button`).first()).toBeVisible();
            await expect(page.locator(toggle('advanced'))).toHaveAttribute('aria-expanded', 'false');
            await tools.locator(':scope > summary').click();
            await page.locator(toggle('workspace')).click();
            await page.screenshot({ path: info.outputPath('sidebar-sections.png') });
            await checkIconSidebar(page, phone);
            await page.unrouteAll({ behavior: 'ignoreErrors' });
        });
    });
}
