/* global document, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

test.setTimeout(120000);

test.use({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
});

async function tapAndHold(page, cdp, locator, holdMs) {
    const box = await locator.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(holdMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('top bar search stays open and focused after an unhurried phone tap', async ({ page, context }) => {
    await isolateSettingsSaves(page, settings => {
        settings.firstRun = false;
        settings.accountStorage = {
            ...settings.accountStorage,
            'NeconyanTutorialStatus.v1': 'skipped',
        };
    });
    await page.goto('/');
    const shortcut = page.locator('#sb-shortcut-right[data-sb-universal-search-trigger="true"]');
    await expect(shortcut).toBeVisible({ timeout: 60000 });
    await expect(page.locator('.neconyan-home-booting')).toHaveCount(0, { timeout: 60000 });
    await page.evaluate(() => {
        document.querySelector('#neconyan-tour-coachmark [data-tour-coach-skip]')?.click();
        for (const id of ['nn-update-toast', 'toast-container']) {
            const element = document.getElementById(id);
            if (element) element.style.display = 'none';
        }
    });

    const row = page.locator('#sb-topbar-search-row');
    const input = page.locator('#sb-universal-search-input');
    const cdp = await context.newCDPSession(page);

    // A finger resting for 400 ms is an ordinary tap on a phone. Search used to
    // close itself (and drop the keyboard) when the click came more than 280 ms
    // after the press that opened it.
    await tapAndHold(page, cdp, shortcut, 400);
    await expect(row).toHaveClass(/\bis-open\b/);
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('sb-universal-search-input');
    await page.waitForTimeout(400);
    await expect(row).toHaveClass(/\bis-open\b/);
    await expect(input).toBeFocused();

    await tapAndHold(page, cdp, shortcut, 80);
    await expect(row).not.toHaveClass(/\bis-open\b/);
    await expect(input).not.toBeFocused();

    await tapAndHold(page, cdp, shortcut, 80);
    await expect(row).toHaveClass(/\bis-open\b/);
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => window.getComputedStyle(document.getElementById('sb-topbar-search-row')).display)).not.toBe('none');
});
