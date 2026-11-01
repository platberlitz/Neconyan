/* global document, window */
import { expect, test } from '@playwright/test';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.describe.configure({ mode: 'serial' });
test.setTimeout(120000);

async function prepare(page) {
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        if (typeof data.settings !== 'string') return route.fulfill({ response, json: data });
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        return route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
}

async function openPicker(page) {
    await page.waitForFunction(() => document.querySelectorAll('.nn-ui-theme-card').length > 0);
    await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    if (!await page.locator('#nn-ui-theme-gallery').isVisible()) await page.locator('#AppearanceSection > .inline-drawer-header').click();
}

const card = (page, name) => page.locator('.nn-ui-theme-card').filter({ has: page.getByText(name, { exact: true }) });

for (const width of [393, 1280, 320]) {
    test(`palette gallery fits and selects at ${width}px`, async ({ browser }) => {
        const phone = width < 768;
        const context = await browser.newContext({ ...(phone ? IPHONE_SAFARI_CONTEXT : {}), viewport: { width, height: phone ? 852 : 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
        if (phone) await installIPhoneSafari(context);
        const page = await context.newPage();
        await prepare(page);
        try {
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await openPicker(page);
            if (phone) await applyIOSOnlyCss(page);
            await expect(page.locator('#themes')).toBeHidden();
            const gallery = page.locator('#nn-ui-theme-gallery');
            const search = gallery.getByRole('searchbox');
            const total = await page.locator('#themes option').count();
            await expect(page.locator('.nn-ui-theme-card')).toHaveCount(total);
            expect(await gallery.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
            expect((await card(page, 'Neconyan Calico Dark').boundingBox()).height).toBeGreaterThanOrEqual(44);
            await search.fill('calico');
            await gallery.locator('[data-tone="light"]').click();
            await expect(page.locator('.nn-ui-theme-card:visible')).toHaveCount(1);
            await card(page, 'Neconyan Calico').click();
            await expect(page.locator('#themes')).toHaveValue('Neconyan Calico');
            await expect(card(page, 'Neconyan Calico')).toHaveAttribute('aria-pressed', 'true');
            await expect(page.locator('html')).toHaveAttribute('data-neconyan-ui-theme', 'neconyan-calico');
            await search.fill('no such theme exists');
            await expect(gallery.getByText('No themes match that search.')).toBeVisible();
            await gallery.getByRole('button', { name: 'Clear filters' }).click();
            await expect(search).toBeFocused();
            await card(page, 'Neconyan Calico Dark').focus();
            await page.keyboard.press('ArrowRight');
            await expect(card(page, 'Neconyan Calico')).toBeFocused();
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('Enter');
            await expect(card(page, 'Neconyan Calico Dark')).toBeFocused();
            await expect(card(page, 'Neconyan Calico Dark')).toHaveAttribute('aria-pressed', 'true');
            await expect(page.locator('.nn-ui-theme-card[tabindex="0"]')).toHaveCount(1);
            // The old control remains available to extensions and slash-command paths.
            await page.locator('#themes').selectOption('AMOLED Black', { force: true });
            await expect(card(page, 'AMOLED Black')).toHaveAttribute('aria-pressed', 'true');
            await card(page, 'Neconyan Calico Dark').click();
            await expect.poll(() => page.evaluate(async () => {
                const { getRequestHeaders } = await import('/script.js');
                const response = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
                return JSON.parse((await response.json()).settings).power_user.theme;
            })).toBe('Neconyan Calico Dark');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await openPicker(page);
            await expect(card(page, 'Neconyan Calico Dark')).toHaveAttribute('aria-pressed', 'true');
        } finally {
            await context.close();
        }
    });
}

test('import, update and delete refresh palette cards', async ({ page }) => {
    await prepare(page);
    // Exercise the real client lifecycle without leaving imported files or settings on the server.
    await page.route('**/api/themes/save', route => route.fulfill({ json: {} }));
    await page.route('**/api/themes/delete', route => route.fulfill({ json: {} }));
    await page.route('**/api/settings/save', route => route.fulfill({ json: {} }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openPicker(page);
    const name = `Palette "import" (test) + ${Date.now()}`;
    const imported = { name, blur_tint_color: 'rgb(10, 40, 70)', main_text_color: 'rgb(240, 245, 250)', quote_text_color: 'rgb(100, 200, 240)' };
    await page.locator('#ui_preset_import_file').setInputFiles({ name: 'theme.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
    const added = card(page, name);
    await expect(added).toHaveAttribute('aria-pressed', 'true');
    const surface = added.locator('.nn-ui-theme-palette > span').first();
    await expect(surface).toHaveCSS('background-color', imported.blur_tint_color);
    await page.evaluate(async () => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.blur_tint_color = 'rgb(240, 245, 250)';
    });
    await page.locator('#ui-preset-update-button').click();
    await expect(surface).toHaveCSS('background-color', 'rgb(240, 245, 250)');
    await page.locator('#ui-preset-delete-button').click();
    await page.locator('dialog.popup:visible .popup-button-ok').click();
    await expect(added).toHaveCount(0);
    await expect(page.locator('.nn-ui-theme-card[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('#themes')).toHaveValue(await page.locator('.nn-ui-theme-card[aria-pressed="true"]').getAttribute('data-theme-name'));
});
