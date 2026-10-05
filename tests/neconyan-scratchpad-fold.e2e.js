/* global document, window */
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

const key = 'neconyanScratchpad';

async function openScratchpad(page, phone) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    if (phone) {
        await page.locator('#sb-hamburger').click();
        await expect(page.locator('body')).toHaveClass(/neconyan-rail-drawer-open/);
    }
    await page.locator('[data-neconyan-route="scratchpad"]').click();
    await expect(page.locator('#neconyan-scratchpad')).toBeVisible();
}

for (const phone of [false, true]) {
    test.describe(`${phone ? 'phone' : 'desktop'} Scratchpad details`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone, serviceWorkers: 'block', reducedMotion: 'reduce' });
        test('fold away, give the space to the conversation and stay folded after a reload', async ({ page }) => {
            test.setTimeout(120000);
            let stored = JSON.stringify({ layout: 'beside', collapsed: false });
            // Use the real account save/load flow without changing the preview account.
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const body = await response.json();
                if (typeof body.settings !== 'string') return route.fulfill({ response, json: body });
                const data = JSON.parse(body.settings);
                data.accountStorage = { ...data.accountStorage, [key]: stored };
                await route.fulfill({ response, json: { ...body, settings: JSON.stringify(data) } });
            });
            await page.route('**/api/settings/save', async route => {
                let bytes = route.request().postDataBuffer();
                if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
                const payload = JSON.parse(bytes.toString());
                stored = payload.accountStorage?.[key] ?? stored;
                await route.fulfill({ json: {
                    result: 'ok',
                    version: Number(payload._version || 0) + 1,
                    settingsRevision: Number(payload._settingsRevision || 0) + 1,
                } });
            });

            await openScratchpad(page, phone);
            const toggle = page.locator('.scratchpad-overview-toggle');
            const bar = page.locator('.scratchpad-overview-bar');
            const messages = page.locator('.scratchpad-messages');
            await expect(toggle).toBeVisible();
            await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            await expect(bar).toBeHidden();

            const expanded = await page.locator('.scratchpad-chat-top').evaluate(row => {
                const tops = [...row.querySelectorAll('.scratchpad-overview-toggle, .scratchpad-assistant')]
                    .map(element => Math.round(element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2));
                return { lines: new Set(tops).size, spread: Math.max(...tops) - Math.min(...tops) };
            });
            // Miso, Taro and Nori stay on one line with the fold button, even on a phone.
            expect(expanded.spread).toBeLessThanOrEqual(2);
            const toggleBox = await toggle.boundingBox();
            // Phones show only the chevron, so the button keeps a full touch target and a spoken name.
            expect(Math.min(toggleBox.width, toggleBox.height)).toBeGreaterThanOrEqual(phone ? 44 : 32);
            await expect(toggle).toHaveAccessibleName(phone ? 'Hide details' : 'Talking with');
            const before = (await messages.boundingBox()).height;

            await toggle.click();
            await expect(bar).toBeVisible();
            await expect(bar).toHaveAttribute('aria-expanded', 'false');
            await expect(page.locator('#scratchpad-overview')).toBeHidden();
            await expect(bar).toBeFocused();
            await expect(bar).toContainText('No chat open');
            const barBox = await bar.boundingBox();
            expect(barBox.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
            expect(barBox.height).toBeLessThanOrEqual(phone ? 52 : 48);
            expect((await messages.boundingBox()).height).toBeGreaterThan(before + 20);
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);

            await bar.press('Enter');
            await expect(toggle).toBeVisible();
            await expect(toggle).toBeFocused();
            await toggle.press('Space');
            await expect(bar).toBeFocused();

            await expect.poll(() => JSON.parse(stored).collapsed, { timeout: 15000 }).toBe(true);
            await openScratchpad(page, phone);
            await expect(bar).toBeVisible();
            await expect(page.locator('#scratchpad-overview')).toBeHidden();
        });
    });
}
