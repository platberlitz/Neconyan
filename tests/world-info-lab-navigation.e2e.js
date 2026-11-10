/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-standalone-expect -- Shared assertions run through the Chromium and WebKit fixtures. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const webkitTest = test.extend({ browserName: 'webkit' });

for (const [runner, browserType] of [[test, 'chromium'], [webkitTest, 'webkit']]) {
    for (const phone of [true, false]) {
        runner(`World Info Lab page buttons on ${phone ? 'phone' : 'desktop'} (${browserType})`, async ({ app }) => {
            test.setTimeout(180000);
            const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
                saved.firstRun = false;
                saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
            } });
            if (phone) await installIPhoneSafari(account.context, { standalone: false });
            const page = await account.open({ workspace: false });
            await page.locator('#preloader').waitFor({ state: 'detached', timeout: 90000 });
            await page.evaluate(() => window.NeconyanNativeTools.activate('third-party/Neconyan-WorldInfo-Lab'));
            const root = page.locator('#sbwil-page');
            await expect(root).toBeVisible();
            if (phone) await applyIOSOnlyCss(page);
            const tabs = root.getByRole('tablist');
            await expect(root.locator('.sbwil-tab-select')).toHaveCount(0);
            await expect(tabs).toHaveAttribute('aria-orientation', phone ? 'horizontal' : 'vertical');
            const buttons = tabs.getByRole('tab');
            await expect(buttons).toHaveCount(5);
            for (const button of await buttons.all()) {
                if (phone) await button.tap();
                else await button.click();
                await expect(button).toHaveAttribute('aria-selected', 'true');
                await expect(root.locator(`#${await button.getAttribute('aria-controls')}`)).toBeVisible();
                const geometry = await button.evaluate(node => {
                    const box = node.getBoundingClientRect();
                    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                    return { height: box.height, hit: node === hit || node.contains(hit), overflow: node.scrollWidth - node.clientWidth };
                });
                expect(geometry.height).toBeGreaterThanOrEqual(44);
                expect(geometry.hit).toBe(true);
                expect(geometry.overflow).toBeLessThanOrEqual(1);
            }
            if (phone) {
                const geometry = await tabs.evaluate(node => ({ height: node.clientHeight, scrollable: node.scrollWidth > node.clientWidth, touch: getComputedStyle(node).touchAction }));
                expect(geometry.scrollable).toBe(true);
                expect(geometry.touch).toBe('pan-x');
                expect(geometry.height).toBeLessThan(70);
            }
            await buttons.last().press('Home');
            await expect(buttons.first()).toBeFocused();
            await expect(buttons.first()).toHaveAttribute('aria-selected', 'true');
            await buttons.first().press('End');
            await expect(buttons.last()).toBeFocused();
            const selected = await buttons.last().getAttribute('id');
            await root.locator('.sbwil-page-close').click();
            await page.evaluate(() => window.NeconyanNativeTools.activate('third-party/Neconyan-WorldInfo-Lab'));
            await expect(root.locator(`#${selected}`)).toHaveAttribute('aria-selected', 'true');
            expect(app.provider.calls).toHaveLength(0);
        });
    }
}
