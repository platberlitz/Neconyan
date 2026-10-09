/* global document, window */
import { expect, test } from '@playwright/test';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const views = [
    { name: 'desktop Chromium', browserName: 'chromium', phone: false },
    { name: 'desktop Firefox', browserName: 'firefox', phone: false },
    { name: 'iPhone Chromium stand-in', browserName: 'chromium', phone: true },
];

async function expectReadable(intro, singleLine = false) {
    const geometry = await intro.evaluate(node => {
        const label = node.querySelector('.neconyan-native-kicker');
        const toggle = node.querySelector('.neconyan-page-intro-toggle');
        const tour = node.querySelector('.neconyan-tool-tour-button');
        const text = document.createRange();
        text.selectNodeContents(label);
        return {
            clipped: label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1,
            lines: text.getClientRects().length,
            overlap: toggle.getBoundingClientRect().right > tour.getBoundingClientRect().left,
            overflow: node.scrollWidth > node.clientWidth + 1,
        };
    });
    expect(geometry.clipped).toBe(false);
    expect(geometry.overlap).toBe(false);
    expect(geometry.overflow).toBe(false);
    if (singleLine) expect(geometry.lines).toBeLessThan(1.1);
}

for (const view of views) {
    test.describe(`${view.name}`, () => {
        test('mini headers fit their labels and wrap long translations', async ({ playwright }, info) => {
            test.setTimeout(120000);
            const browser = await playwright[view.browserName].launch();
            const context = await browser.newContext({
                ...(view.phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
                baseURL: info.project.use.baseURL,
                serviceWorkers: 'block',
                reducedMotion: 'reduce',
            });
            try {
                if (view.phone) await installIPhoneSafari(context, { standalone: true });
                const page = await context.newPage();
                await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
                await page.route('**/api/settings/get', async route => {
                    const response = await route.fetch();
                    const data = await response.json();
                    const settings = JSON.parse(data.settings || '{}');
                    settings.firstRun = false;
                    settings.accountStorage ??= {};
                    settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
                    for (const key of ['character-library', 'group-library', 'character-import', 'persona']) {
                        settings.accountStorage[`neconyanToolTourInvite.${key}`] = 'seen';
                        settings.accountStorage[`neconyanPageIntroExpanded.${key}`] = 'false';
                    }
                    await route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
                });
                await page.goto('/');
                await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 90000 });
                await page.evaluate(() => document.fonts.ready);
                for (const theme of ['calico', 'windows-98']) {
                    await page.evaluate(theme => window.NeconyanShell.applyTheme(theme), theme);
                    if (theme !== 'calico') await page.waitForFunction(() => document.querySelector('link[data-sb-shell-style="windows-98"]')?.sheet);
                    for (const tab of ['characters', 'groups', 'import', 'persona']) {
                        await page.evaluate(tab => window.NeconyanShell.openTab('characters', tab), tab);
                        const intro = page.locator('.neconyan-tool-page-intro:visible').filter({ has: page.locator('.neconyan-page-intro-toggle') }).first();
                        await expect(intro).toBeVisible();
                        if (view.phone) await applyIOSOnlyCss(page);
                        await expectReadable(intro, true);
                        const toggle = intro.locator('.neconyan-page-intro-toggle');
                        await toggle.click();
                        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
                        await expect(intro.locator('.neconyan-tool-page-copy')).toBeVisible();
                        await expectReadable(intro, true);
                        await toggle.click();
                        await expect(intro.locator('.neconyan-tool-page-copy')).toBeHidden();
                        const label = intro.locator('.neconyan-native-kicker');
                        const original = await label.textContent();
                        for (const text of ['All your characters and their adventures together in one place', 'EineSehrLangeUnunterbrocheneÜbersetzteAbschnittsüberschrift'.repeat(3)]) {
                            await label.evaluate((node, text) => { node.textContent = text; }, text);
                            await expectReadable(intro);
                        }
                        await label.evaluate((node, text) => { node.textContent = text; }, original);
                        await intro.locator('.neconyan-tool-tour-button').click();
                        await expect(page.locator('#neconyan-tool-tour')).toBeVisible();
                        await page.locator('#neconyan-tool-tour .neconyan-tool-tour-close').click();
                    }
                }
            } finally {
                for (const page of context.pages()) await page.unrouteAll({ behavior: 'wait' });
                await context.close();
                await browser.close();
            }
        });
    });
}
