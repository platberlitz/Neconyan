import { test, expect } from '@playwright/test';
import { enterNotes, openNotes } from './notebooks-browser-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`Miso's Notes invitation X stays at the top right and remembers dismissal on ${phone ? 'iPhone-emulated' : 'desktop'} layouts`, async ({ browser }, info) => {
        test.setTimeout(120000);
        const viewport = phone ? { width: 393, height: 852 } : { width: 1280, height: 900 };
        const context = await browser.newContext({ ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport }), baseURL: info.project.use.baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });
        try {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            const page = await context.newPage();
            await openNotes(page, viewport);
            await page.evaluate(async () => {
                const { accountStorage } = await import('/scripts/util/AccountStorage.js');
                accountStorage.removeItem('neconyanToolTourInvite.notes');
                const app = (await import('/scripts/notebooks/notes-app.js')).notesApp();
                const { mountToolPage } = await import('/scripts/neconyan-tool-tour.js');
                mountToolPage('notes', app.elements.intro, app.elements.root);
            });
            if (phone) await applyIOSOnlyCss(page);
            const invite = page.locator('#neconyan-notes .neconyan-tool-tour-invite');
            await expect(invite).toBeVisible();
            const close = invite.locator('.neconyan-tour-invite-dismiss');
            const box = await invite.boundingBox();
            const x = await close.boundingBox();
            expect(Math.abs(x.y - box.y - 13)).toBeLessThanOrEqual(2);
            expect(Math.abs(box.x + box.width - x.x - x.width - 13)).toBeLessThanOrEqual(2);
            expect(x.height).toBeGreaterThanOrEqual(44);
            await page.screenshot({ path: info.outputPath('miso-invitation.png') });
            await close.click();
            await expect(invite).toBeHidden();
            expect(await page.evaluate(async () => (await import('/scripts/util/AccountStorage.js')).accountStorage.getItem('neconyanToolTourInvite.notes'))).toBe('seen');
            expect(await page.evaluate(async () => {
                const { saveSettings } = await import('/script.js');
                return saveSettings(0, { returnResult: true });
            })).toBe(true);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
            await enterNotes(page, viewport);
            if (phone) await applyIOSOnlyCss(page);
            await expect(invite).toBeAttached();
            await expect(invite).toBeHidden();
            await expect(page.locator('#neconyan-notes .neconyan-tool-tour-button')).toBeVisible();
        } finally {
            for (const page of context.pages()) await page.unrouteAll({ behavior: 'wait' });
            await context.close();
        }
    });
}
