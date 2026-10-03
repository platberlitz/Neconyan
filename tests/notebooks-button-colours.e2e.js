/* global document, getComputedStyle, requestAnimationFrame */
import { test, expect } from '@playwright/test';
import { openNotes } from './notebooks-browser-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const styles = ['calico', 'cozy-warm', 'slate-flat', 'clean-minimal', 'macos-minimal', 'windows-aero', 'windows-98', 'hypr-glow', 'kittyless'];

for (const phone of [false, true]) {
    test(`Notes primary buttons keep the native colour pair on ${phone ? 'iPhone-emulated' : 'desktop'} layouts`, async ({ browser }, testInfo) => {
        test.setTimeout(180000);
        const viewport = phone ? { width: 393, height: 852 } : { width: 1280, height: 900 };
        const context = await browser.newContext({ ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport }), baseURL: testInfo.project.use.baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });
        try {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            const page = await context.newPage();
            await openNotes(page, viewport);
            await expect(page.locator('#neconyan-notes .notes-pane-nav').getByRole('button', { name: 'New note', exact: true })).toBeVisible();
            await page.evaluate(async () => {
                const { button } = await import('/scripts/notebooks/dom.js');
                const reference = button('Native primary reference', () => {}, { className: 'menu_button_primary', icon: 'fa-file-circle-plus' });
                reference.id = 'notes-primary-reference';
                document.querySelector('#neconyan-notes .notes-pane-nav .notes-nav-actions').append(reference);
            });
            for (const shell of styles) {
                if (shell !== 'calico') await page.addStyleTag({ url: `/css/shell-styles/${shell}.css` });
                await page.evaluate(shell => { document.documentElement.dataset.sbTheme = shell; }, shell);
                if (phone) await applyIOSOnlyCss(page);
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                const colours = await page.evaluate(() => {
                    const read = element => {
                        const style = getComputedStyle(element);
                        return { color: style.color, background: style.backgroundColor, image: style.backgroundImage, icon: getComputedStyle(element.querySelector('i')).color, text: getComputedStyle(element.querySelector('span')).color };
                    };
                    const actual = document.querySelector('#neconyan-notes .notes-pane-nav .notes-primary');
                    return { actual: read(actual), reference: read(document.querySelector('#notes-primary-reference')), height: actual.getBoundingClientRect().height };
                });
                expect(colours.actual, `${shell}: use the theme's complete native primary-button colour pair`).toEqual(colours.reference);
                if (phone) expect(colours.height).toBeGreaterThanOrEqual(44);
                if (shell === 'slate-flat') await page.screenshot({ path: testInfo.outputPath('new-note-colours.png') });
            }
            await page.locator('#notes-primary-reference').evaluate(element => element.remove());
            await page.locator('#neconyan-notes .notes-pane-nav').getByRole('button', { name: 'New note', exact: true }).click();
            await expect(page.locator('.popup').getByRole('heading', { name: 'New note', exact: true })).toBeVisible();
            await page.locator('.popup').getByRole('button', { name: 'Cancel', exact: true }).click();
        } finally { await context.close(); }
    });
}
