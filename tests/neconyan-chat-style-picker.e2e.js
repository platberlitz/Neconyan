/* global document, window, getComputedStyle */
import { expect, test } from '@playwright/test';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.describe.configure({ mode: 'serial' });
test.setTimeout(120000);

async function prepare(page) {
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        const settings = typeof data.settings === 'string' ? JSON.parse(data.settings) : {};
        settings.firstRun = false;
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        return route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
}

async function openPicker(page) {
    await page.waitForFunction(() => document.querySelectorAll('.nn-chat-style-card').length === 13);
    await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    if (!await page.locator('#nn-chat-style-gallery').isVisible()) {
        await page.locator('#sb-avatar-chat-styles-drawer > .inline-drawer-header').click();
    }
}

const card = (page, value) => page.locator(`.nn-chat-style-card[data-chat-style="${value}"]`);
const classes = ['flatchat', 'bubblechat', 'documentstyle', 'echostyle', 'whisperstyle', 'hushstyle', 'ripplestyle', 'tidestyle', 'nnchat-messenger', 'nnchat-notebook', 'nnchat-script', 'nnchat-compact', 'nnchat-storybook'];

for (const width of [393, 1280, 320]) {
    test(`chat previews select, synchronise and persist at ${width}px`, async ({ browser }) => {
        const phone = width < 768;
        const context = await browser.newContext({ ...(phone ? IPHONE_SAFARI_CONTEXT : {}), viewport: { width, height: phone ? 852 : 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
        if (phone) await installIPhoneSafari(context);
        const page = await context.newPage();
        await prepare(page);
        try {
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await openPicker(page);
            if (phone) await applyIOSOnlyCss(page);
            await expect(page.locator('#chat_display')).toBeHidden();
            await expect(page.locator('.nn-chat-style-card')).toHaveCount(await page.locator('#chat_display option').count());
            const grid = page.locator('.nn-chat-style-grid');
            expect(await grid.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
            for (let value = 0; value < classes.length; value++) {
                const button = card(page, value);
                expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
                await button.click();
                await expect(button).toHaveAttribute('aria-pressed', 'true');
                await expect(page.locator('#chat_display')).toHaveValue(String(value));
                await expect(page.locator('body')).toHaveClass(new RegExp(`\\b${classes[value]}\\b`));
                await expect(page.locator('.nn-chat-style-card[aria-pressed="true"]')).toHaveCount(1);
            }
            await card(page, 0).focus();
            await page.keyboard.press('ArrowRight');
            await expect(card(page, 1)).toBeFocused();
            await page.keyboard.press('Enter');
            await expect(card(page, 1)).toHaveAttribute('aria-pressed', 'true');
            await expect(card(page, 1)).toBeFocused();
            const columns = await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
            await page.keyboard.press('ArrowDown');
            await expect(card(page, 1 + columns)).toBeFocused();
            await page.keyboard.press('End');
            await expect(card(page, 12)).toBeFocused();
            await page.keyboard.press('Home');
            await expect(card(page, 0)).toBeFocused();
            await expect(page.locator('.nn-chat-style-card[tabindex="0"]')).toHaveCount(1);
            // Extensions and the shell still use this original control.
            await page.locator('#chat_display').selectOption('8', { force: true });
            await expect(card(page, 8)).toHaveAttribute('aria-pressed', 'true');
            await expect(page.locator('.nn-chat-style-current strong')).toHaveText('Messenger');
            await expect.poll(() => page.evaluate(async () => {
                const { getRequestHeaders } = await import('/script.js');
                const response = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
                return JSON.parse((await response.json()).settings).power_user.chat_display;
            })).toBe(8);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await openPicker(page);
            await expect(card(page, 8)).toHaveAttribute('aria-pressed', 'true');
            await expect(card(page, 8)).toHaveAttribute('tabindex', '0');
        } finally {
            await context.close();
        }
    });
}

test('preview labels and selected mark retain contrast with light and dark accents', async ({ page }) => {
    await prepare(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openPicker(page);
    await card(page, 0).click();
    for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
        await page.locator('#themes').selectOption(theme, { force: true });
        for (const accent of [null, 'rgba(220, 245, 230, 1)', 'rgba(65, 20, 100, 1)']) {
            if (accent) {
                await page.evaluate(rgba => {
                    for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) {
                        document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba }, bubbles: true }));
                    }
                }, accent);
            }
            const ratios = await card(page, 0).evaluate(async button => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                const colour = value => { context.fillStyle = value; return context.fillStyle; };
                const style = getComputedStyle(button);
                const check = getComputedStyle(button.querySelector('.nn-chat-style-check'));
                return {
                    label: contrastRatio(colour(style.color), colour(style.backgroundColor)),
                    check: contrastRatio(colour(check.color), colour(check.backgroundColor)),
                };
            });
            expect(ratios.label, `${theme}, ${accent}: label`).toBeGreaterThanOrEqual(4.5);
            expect(ratios.check, `${theme}, ${accent}: selected mark`).toBeGreaterThanOrEqual(4.5);
        }
    }
});
