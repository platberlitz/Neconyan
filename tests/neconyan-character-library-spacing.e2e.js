/* global window */
import { expect, test } from '@playwright/test';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.describe.configure({ mode: 'serial' });

for (const phone of [false, true]) {
    test(`Characters and Groups keep their intro and search together: ${phone ? 'iPhone emulation' : 'desktop'}`, async ({ browser }, testInfo) => {
        test.setTimeout(120000);
        const context = await browser.newContext({
            ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
            baseURL: testInfo.project.use.baseURL, reducedMotion: 'reduce', serviceWorkers: 'block',
        });
        try {
            if (phone) await installIPhoneSafari(context, { standalone: false });
            const page = await context.newPage();
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 120000 });
            const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
            if (await skip.isVisible()) await skip.click();
            for (const tab of ['characters', 'groups']) {
                await page.evaluate(tab => window.NeconyanShell.openTab('characters', tab), tab);
                const root = page.locator('#rm_characters_block');
                const intro = root.locator('.neconyan-tool-page-intro');
                const toggle = intro.locator('.neconyan-page-intro-toggle');
                await expect(intro.locator('.neconyan-tool-tour-button')).toHaveAttribute('aria-label', tab === 'groups' ? 'Start Miso\'s Groups tour' : 'Start Nori\'s Characters tour');
                await expect(toggle).toBeVisible();
                const later = root.locator('.neconyan-tool-tour-invite button').filter({ hasText: 'Not now' });
                if (await later.isVisible()) await later.click();
                if (phone) await applyIOSOnlyCss(page);
                if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
                for (const expanded of [false, true]) {
                    await expect(toggle).toHaveAttribute('aria-expanded', String(expanded));
                    await expect.poll(async () => root.evaluate(root => {
                        const intro = root.querySelector('.neconyan-tool-page-intro');
                        const search = root.querySelector('#character_search_bar').getBoundingClientRect();
                        const heading = intro.querySelector('.neconyan-native-kicker').getBoundingClientRect();
                        const tour = intro.querySelector('.neconyan-tool-tour-button').getBoundingClientRect();
                        const copy = intro.querySelector('.neconyan-tool-page-copy');
                        const compactBlurbGap = copy.hidden || copy.getBoundingClientRect().top - tour.bottom <= 2;
                        const gap = search.top - intro.getBoundingClientRect().bottom;
                        return { compactGap: gap >= 6 && gap <= 12, compactBlurbGap, tourBesideHeading: tour.left >= heading.right && tour.left - heading.right <= 16 };
                    })).toEqual({ compactGap: true, compactBlurbGap: true, tourBesideHeading: true });
                    if (!expanded) await toggle.click();
                }
                await toggle.click();
                await root.locator('#character_search_bar').fill('spacing check');
                await expect(root.locator('#character_search_bar')).toHaveValue('spacing check');
                await root.locator('#character_search_bar').fill('');
                await intro.locator('.neconyan-tool-tour-button').click();
                await expect(page.locator('#neconyan-tool-tour')).toHaveAttribute('data-step', 'welcome');
                await page.keyboard.press('Escape');
                await expect(page.locator('#neconyan-tool-tour')).toHaveCount(0);
            }
        } finally {
            await context.close();
        }
    });
}
