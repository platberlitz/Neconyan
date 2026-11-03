/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-standalone-expect -- Assertions in helpers. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const webkitTest = test.extend({ browserName: 'webkit' });

const ids = ['third-party/Neconyan-Preset-Tools', 'third-party/ChatCompletionTabs', 'third-party/Neconyan-Terminal-UI', 'third-party/Neconyan-BotSearcher', 'third-party/Neconyan-PromptTags', 'third-party/Neconyan-Regex-Agent-Themes', 'third-party/MacroEnhanced', 'third-party/Neconyan-WorldInfo-Lab', 'third-party/Neconyan-Prompting-Lab', 'neconyan-debugger', 'third-party/Neconyan-Time-Machine', 'third-party/Neconyan-Deep-Swipe', 'third-party/Neconyan-Story-Mode', 'third-party/Neconyan-Hopper'];

for (const [runner, engine, widths] of [[test, 'chromium', [393, 900, 1280]], [webkitTest, 'webkit', [393, 900]]]) {
    for (const width of widths) {
        runner(`plain included headers align at ${width} (${engine})`, async ({ app, browser, browserName }) => {
            expect(browserName).toBe(engine);
            expect(browser.browserType().name()).toBe(engine);
            test.setTimeout(360000);
            const account = await app.account({ phone: width === 393, contextOptions: engine === 'webkit' && width === 393 ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
                saved.firstRun = false;
                saved.extension_settings.disabledExtensions = (saved.extension_settings.disabledExtensions || []).filter(id => !['third-party/Neconyan-Terminal-UI', 'third-party/Neconyan-Time-Machine'].includes(id));
                saved.extension_settings.bundledOptInProcessedExtensions = [...new Set([...(saved.extension_settings.bundledOptInProcessedExtensions || []), 'neconyan-terminal-ui'])];
                saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
            } });
            await account.context.route('**/api/settings/get', async route => {
                const response = await route.fetch(), data = await response.json();
                if (typeof data.settings !== 'string') return route.fulfill({ response });
                const saved = JSON.parse(data.settings);
                saved.firstRun = false;
                saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', WelcomePage_PanelMode: 'full' };
                saved.extension_settings.disabledExtensions = (saved.extension_settings.disabledExtensions || []).filter(id => !['third-party/Neconyan-Terminal-UI', 'third-party/Neconyan-Time-Machine'].includes(id));
                saved.extension_settings.bundledOptInProcessedExtensions = [...new Set([...(saved.extension_settings.bundledOptInProcessedExtensions || []), 'neconyan-terminal-ui'])];
                await route.fulfill({ response, json: { ...data, settings: JSON.stringify(saved) } });
            });
            if (engine === 'webkit' && width === 393) await installIPhoneSafari(account.context, { standalone: false });
            const page = await account.open({ workspace: false });
            await page.locator('#preloader').waitFor({ state: 'detached', timeout: 90000 });
            await page.setViewportSize({ width, height: width === 393 ? 852 : 900 });
            if (engine === 'webkit' && width === 393) await applyIOSOnlyCss(page);
            await page.evaluate(() => window.NeconyanShell.applyTheme('windows-xp'));
            await page.waitForFunction(() => document.documentElement.dataset.sbTheme === 'windows-xp' && document.querySelector('link[data-sb-shell-style=\'windows-xp\']')?.sheet);
            await page.locator('#sbterm-settings-drawer').waitFor({ state: 'attached', timeout: 90000 });
            const tools = await page.evaluate(() => window.NeconyanNativeTools.getTools().map(({ id, label, unit }) => ({ id, label, unit })));
            for (const id of ids) {
                const tool = tools.find(item => item.id === id);
                expect(tool, id).toBeTruthy();
                await page.evaluate(value => window.NeconyanShell.openIncludedTool(value), id);
                await page.waitForFunction(({ label, unit }) => {
                    const title = document.querySelector('#user-settings-block .sb-shell-title');
                    const host = document.querySelector('#user-settings-block .neconyan-included-tool-content');
                    const mounted = unit ? host?.querySelector(unit) : host?.firstElementChild;
                    const visible = node => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== 'hidden';
                    return title?.textContent.trim() === label && visible(host) && visible(mounted) && !host.querySelector('.neconyan-included-tool-unavailable');
                }, tool);
                const geometry = await page.locator('#user-settings-block .sb-shell-header').evaluate(header => {
                    const title = header.querySelector(':scope > .sb-shell-title');
                    const close = header.querySelector('.sb-shell-close');
                    const t = title.getBoundingClientRect(), c = close.getBoundingClientRect(), h = header.getBoundingClientRect();
                    const range = document.createRange(); range.selectNodeContents(title);
                    const lines = [...range.getClientRects()].map(rect => rect.toJSON());
                    const hit = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
                    return { title: t.toJSON(), close: c.toJSON(), header: h.toJSON(), lines, text: title.textContent.trim(), visible: getComputedStyle(title).display !== 'none', hit: hit === close || close.contains(hit), intro: Boolean(header.querySelector('.neconyan-page-intro-header')), overflow: document.documentElement.scrollWidth - window.innerWidth };
                });
                expect(geometry.text, id).toBeTruthy();
                expect(geometry.visible, id).toBe(true);
                expect(geometry.title.width * geometry.title.height, id).toBeGreaterThan(0);
                expect(geometry.intro, id).toBe(false);
                expect(Math.abs(geometry.close.y + geometry.close.height / 2 - geometry.title.y - geometry.title.height / 2), id + ' title centre').toBeLessThanOrEqual(1);
                expect(geometry.hit, id).toBe(true);
                expect([geometry.close.width, geometry.close.height], id).toEqual(width === 393 ? [44, 44] : [40, 40]);
                expect(geometry.close.left, id).toBeGreaterThanOrEqual(geometry.header.left);
                expect(geometry.close.right, id).toBeLessThanOrEqual(geometry.header.right);
                expect(geometry.close.top, id).toBeGreaterThanOrEqual(geometry.header.top);
                expect(geometry.close.bottom, id).toBeLessThanOrEqual(geometry.header.bottom);
                expect(geometry.overflow, id).toBeLessThanOrEqual(1);
                if (id === 'third-party/Neconyan-Time-Machine' && width === 393) {
                    const title = page.locator('#user-settings-block .sb-shell-title');
                    const original = await title.textContent();
                    await title.evaluate(node => { node.textContent = 'Card & Lorebook Time Machine settings and saved backups for this workspace'; });
                    const stress = await title.evaluate(node => {
                        const header = node.closest('.sb-shell-header'), close = header.querySelector('.sb-shell-close');
                        const range = document.createRange(); range.selectNodeContents(node);
                        const h = header.getBoundingClientRect(), c = close.getBoundingClientRect(), t = node.getBoundingClientRect();
                        const hit = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
                        return { lines: [...range.getClientRects()].map(rect => rect.toJSON()), header: h.toJSON(), close: c.toJSON(), title: t.toJSON(), hit: hit === close || close.contains(hit) };
                    });
                    expect(stress.lines).toHaveLength(2);
                    expect(Math.abs(stress.close.y + stress.close.height / 2 - stress.title.y - stress.title.height / 2)).toBeLessThanOrEqual(1);
                    expect(stress.hit).toBe(true);
                    for (const line of stress.lines) {
                        expect(line.top).toBeGreaterThanOrEqual(stress.header.top);
                        expect(line.bottom).toBeLessThanOrEqual(stress.header.bottom);
                        expect(line.right).toBeLessThanOrEqual(stress.close.left - 8);
                    }
                    await title.evaluate((node, value) => { node.textContent = value; }, original);
                    const old = await page.addStyleTag({ content: 'body.neconyan #user-settings-block[data-sb-active-tab=\'included-tool\'] .sb-shell-header:not(:has(.neconyan-page-intro-header)) { justify-content: flex-start; } body.neconyan #user-settings-block[data-sb-active-tab=\'included-tool\'] .neconyan-shell-page-intro:empty { display: grid !important; }' });
                    const delta = await title.evaluate(node => {
                        const t = node.getBoundingClientRect(), c = node.closest('.sb-shell-header').querySelector('.sb-shell-close').getBoundingClientRect();
                        return Math.abs(c.y + c.height / 2 - t.y - t.height / 2);
                    });
                    expect(delta, 'restored old rules fail the real centre criterion').toBeGreaterThan(1);
                    await old.evaluate(node => node.remove());
                }
                expect(geometry.lines.length, id).toBeGreaterThan(0);
                for (const line of geometry.lines) {
                    expect(line.left, id).toBeGreaterThanOrEqual(geometry.header.left);
                    expect(line.top, id).toBeGreaterThanOrEqual(geometry.header.top);
                    expect(line.bottom, id).toBeLessThanOrEqual(geometry.header.bottom);
                    expect(line.right, id).toBeLessThanOrEqual(geometry.close.left);
                }
            }
            expect(app.provider.calls).toHaveLength(0);
        });
    }}
