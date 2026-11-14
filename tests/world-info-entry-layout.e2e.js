/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-standalone-expect -- Shared assertions run through the Chromium and WebKit fixtures. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const webkitTest = test.extend({ browserName: 'webkit' });

async function openEntry(app, phone) {
    const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
        saved.firstRun = false;
        saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        saved.power_user.neconyan_shell_style = 'windows-98';
    } });
    if (phone) await installIPhoneSafari(account.context, { standalone: false });
    await account.post('/api/worldinfo/edit', { name: 'Workshop notes', data: { entries: {
        0: { uid: 0, key: ['workshop'], keysecondary: [], content: 'A quiet workshop overlooking the harbour.', comment: 'The workshop',
            constant: false, selective: true, disable: false, order: 100, position: 0, depth: 4, probability: 100, useProbability: true, addMemo: true },
    } } });
    const page = await account.open({ workspace: false });
    await page.locator('#preloader').waitFor({ state: 'detached', timeout: 90000 });
    await page.evaluate(() => window.NeconyanShell.openTab('characters', 'world-info'));
    await page.locator('.neconyan-lorebook-book-open').filter({ hasText: 'Workshop notes' }).click();
    await page.locator('#world_popup_entries_list button.inline-drawer-toggle').first().click();
    const advanced = page.locator('#WorldInfo .neconyan-entry-advanced:visible');
    await expect(advanced).toBeVisible();
    if (phone) await applyIOSOnlyCss(page);
    await page.evaluate(() => document.fonts.ready);
    return { account, page, advanced };
}

for (const [runner, browserType] of [[test, 'chromium'], [webkitTest, 'webkit']]) {
    for (const phone of [true, false]) {
        runner(`Lorebook advanced disclosure on ${phone ? 'phone' : 'desktop'} (${browserType})`, async ({ app }) => {
            test.setTimeout(180000);
            const { advanced } = await openEntry(app, phone);
            const summary = advanced.locator('summary');
            const indicator = summary.locator('.fa-chevron-down');
            await expect(summary).toHaveText('Advanced entry settings');
            await expect(indicator).toHaveAttribute('aria-hidden', 'true');
            await summary.scrollIntoViewIfNeeded();
            const geometry = await summary.evaluate(node => {
                const box = node.getBoundingClientRect();
                const icon = node.querySelector('i');
                const iconBox = icon.getBoundingClientRect();
                const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                return { height: box.height, hit: node === hit || node.contains(hit), iconWidth: iconBox.width,
                    mask: getComputedStyle(icon, '::before').maskImage, overflow: node.scrollWidth - node.clientWidth };
            });
            expect(geometry.height).toBeGreaterThanOrEqual(44);
            expect(geometry.hit).toBe(true);
            expect(geometry.iconWidth).toBeGreaterThan(0);
            expect(geometry.mask).not.toBe('none');
            expect(geometry.overflow).toBeLessThanOrEqual(1);
            await expect(advanced).not.toHaveAttribute('open');
            if (phone) await summary.tap();
            else await summary.click();
            await expect(advanced).toHaveAttribute('open');
            await expect(indicator).toHaveCSS('rotate', '180deg');
            await summary.press('Space');
            await expect(advanced).not.toHaveAttribute('open');
            await summary.press('Enter');
            await expect(advanced).toHaveAttribute('open');
            expect(app.provider.calls).toHaveLength(0);
        });
    }
}
