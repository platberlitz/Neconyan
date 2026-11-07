/* global document, window, PointerEvent */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.use({ viewport: { width: 393, height: 852 }, hasTouch: true });

test('Starlight taps create the desktop burst without blocking controls or leaving a hover trail', async ({ page }) => {
    test.setTimeout(180000);
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        const settings = JSON.parse(data.settings || readFileSync(new URL('../default/content/settings.json', import.meta.url), 'utf8'));
        settings.power_user.neconyan_shell_style = 'starlight-conservatory';
        settings.power_user.reduced_motion = false;
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        data.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: data });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.neconyan-home-intro')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('#sb-starlight-conservatory-stage')).toHaveAttribute('data-starlight-motion', 'active');
    await page.evaluate(() => {
        const button = document.createElement('button');
        button.id = 'sparkle-tap-target';
        button.textContent = 'Tap';
        button.style.cssText = 'position:fixed;left:100px;top:300px;width:100px;height:60px;z-index:2147483647';
        button.onclick = () => { button.dataset.tapped = 'true'; };
        document.body.append(button);
    });
    const snapshot = () => page.evaluate(() => window.NeconyanStarlightConservatory.snapshot());
    const target = page.locator('#sparkle-tap-target');
    await target.tap();
    await expect(target).toHaveAttribute('data-tapped', 'true');
    expect((await snapshot()).trail).toBe(8);
    expect((await snapshot()).companion).toBe(false);
    // The animation caps elapsed time per frame; software-rendered WebKit needs longer.
    await expect.poll(async () => (await snapshot()).trail, { timeout: 60000 }).toBe(0);

    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointermove', {
        pointerType: 'touch', clientX: 150, clientY: 350,
    })));
    expect((await snapshot()).trail).toBe(0);
    expect((await snapshot()).companion).toBe(false);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(async () => (await snapshot()).motion).toBe('still');
    await target.tap();
    expect((await snapshot()).trail).toBe(0);
    await page.evaluate(() => window.NeconyanStarlightConservatory.unmount());
    await target.tap();
    expect(await snapshot()).toEqual({ mounted: false });
});
