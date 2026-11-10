/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-standalone-expect -- Assertions in helpers. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const webkitTest = test.extend({ browserName: 'webkit' });

for (const [runner, engine, widths] of [[test, 'chromium', [393, 900, 1280]], [webkitTest, 'webkit', [393, 900]]]) {
    for (const width of widths) {
        runner(`Prompting Lab navigation remains readable at ${width} (${engine})`, async ({ app, browser, browserName }) => {
            expect(browserName).toBe(engine);
            expect(browser.browserType().name()).toBe(engine);
            test.setTimeout(180000);
            const account = await app.account({ phone: width === 393, contextOptions: engine === 'webkit' && width === 393 ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
                saved.firstRun = false;
                saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
            } });
            if (engine === 'webkit' && width === 393) await installIPhoneSafari(account.context, { standalone: false });
            const page = await account.open({ workspace: false });
            await page.locator('#preloader').waitFor({ state: 'detached', timeout: 90000 });
            await page.setViewportSize({ width, height: width === 393 ? 852 : 900 });
            if (engine === 'webkit' && width === 393) await applyIOSOnlyCss(page);
            await page.evaluate(() => window.NeconyanShell.applyTheme('windows-xp'));
            await page.waitForFunction(() => document.documentElement.dataset.sbTheme === 'windows-xp' && document.querySelector('link[data-sb-shell-style=\'windows-xp\']')?.sheet);
            await page.evaluate(() => window.NeconyanNativeTools.activate('third-party/Neconyan-Prompting-Lab'));
            await expect(page.locator('#sbpl-page .sbpl-workbench-page')).toBeVisible();
            if (engine === 'webkit' && width === 393) await applyIOSOnlyCss(page);
            const root = page.locator('#sbpl-page');
            const select = root.locator('.sbpl-tab-select'), tabs = root.locator('.sbpl-tabs');
            await expect(select).toHaveCount(0);
            await expect(tabs).toBeVisible();
            if (width === 393) {
                await expect(tabs).toHaveAttribute('aria-orientation', 'horizontal');
                await expect(tabs.getByRole('tab')).toHaveCount(10);
                const rail = await tabs.evaluate(node => ({ height: node.clientHeight, overflow: node.scrollWidth > node.clientWidth, touch: getComputedStyle(node).touchAction }));
                expect(rail.overflow).toBe(true);
                expect(rail.touch).toBe('pan-x');
                expect(rail.height).toBeLessThan(70);
                for (const tab of await tabs.getByRole('tab').all()) {
                    const label = await tab.locator('.sbpl-tab-label').innerText();
                    await tab.tap();
                    await expect(tab).toHaveAttribute('aria-selected', 'true');
                    expect((await tab.boundingBox()).height).toBeGreaterThanOrEqual(44);
                    await expect(root.locator('.sbpl-panel-title').filter({ hasText: label })).toBeVisible();
                }
                await tabs.getByRole('tab', { selected: true }).press('End');
                await expect(tabs.getByRole('tab', { name: 'Settings', exact: true })).toBeFocused();
                await page.setViewportSize({ width: 1280, height: 900 });
                await expect(tabs).toHaveAttribute('aria-orientation', 'vertical');
                await page.setViewportSize({ width: 393, height: 852 });
                await expect(tabs).toHaveAttribute('aria-orientation', 'horizontal');
            } else {
                const widths = await root.evaluate(node => ({ nav: node.querySelector('.sbpl-nav').getBoundingClientRect().width, main: node.querySelector('.sbpl-main').getBoundingClientRect().width }));
                expect(widths).toEqual(width === 900 ? { nav: 172.5, main: 727.5 } : { nav: 232.5, main: 1047.5 });
                const buttons = tabs.locator('.sbpl-tab');
                await expect(buttons).toHaveCount(10);
                let badges = 0;
                for (const button of await buttons.all()) {
                    await button.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
                    await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
                    const data = await button.evaluate(node => {
                        const label = node.querySelector('.sbpl-tab-label'), text = label.firstChild;
                        const box = node.getBoundingClientRect(), lb = label.getBoundingClientRect(), badge = node.querySelector('.sbpl-tab-badge');
                        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                        const words = [...text.textContent.matchAll(/\S+/g)].map(match => { const range = document.createRange(); range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length); return { text: match[0], rects: [...range.getClientRects()].map(rect => rect.toJSON()) }; });
                        return { text: label.textContent.trim(), visible: getComputedStyle(label).visibility === 'visible' && getComputedStyle(label).display !== 'none', box: box.toJSON(), label: lb.toJSON(), badge: badge?.getBoundingClientRect().toJSON() || null, badgeText: badge?.textContent.trim() || null, words, hit: hit === node || node.contains(hit), overflow: node.scrollWidth - node.clientWidth };
                    });
                    expect(data.text).toBeTruthy(); expect(data.visible).toBe(true); expect(data.label.width * data.label.height).toBeGreaterThan(0);
                    expect(data.hit, data.text).toBe(true); expect(data.overflow, data.text).toBeLessThanOrEqual(1);
                    for (const word of data.words) expect(word.rects, `${data.text}: ${word.text} remains whole`).toHaveLength(1);
                    if (data.badge) { badges++; expect(data.badgeText).toBe('tokens'); expect(data.badge.width * data.badge.height).toBeGreaterThan(0); expect(data.badge.left).toBeGreaterThanOrEqual(data.box.left); expect(data.badge.top).toBeGreaterThanOrEqual(data.box.top); expect(data.badge.right).toBeLessThanOrEqual(data.box.right); expect(data.badge.bottom).toBeLessThanOrEqual(data.box.bottom); }
                }
                expect(badges).toBe(3);
                for (const label of ['Compare prompts', 'Compare models']) {
                    const tab = page.getByRole('tab', { name: label + ', uses tokens', exact: true });
                    await tab.focus(); await expect(tab).toBeFocused(); await page.keyboard.press('Enter');
                    await expect(root.locator('.sbpl-panel-title').filter({ hasText: label })).toBeVisible();
                }
            }
            await root.locator('.sbpl-page-close').click();
            await expect(root).toBeHidden();
            await page.evaluate(() => window.NeconyanNativeTools.activate('third-party/Neconyan-Prompting-Lab'));
            await expect(root.locator('.sbpl-workbench-page')).toBeVisible();
            expect(app.provider.calls).toHaveLength(0);
        });
    }}
