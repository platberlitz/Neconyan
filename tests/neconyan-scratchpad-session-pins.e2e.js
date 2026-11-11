/* global document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Scratchpad sessions can be pinned to the top and unpinned`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const openSessions = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'sessions' }));
            if (phone) await applyIOSOnlyCss(page);
        };
        const rows = page.locator('.scratchpad-session');
        const names = () => rows.locator('.scratchpad-session-info strong').allTextContents();
        const prefix = `../screenshots/scratchpad-session-pins/${phone ? 'phone' : 'desktop'}`;
        const newSession = async label => {
            const response = page.waitForResponse('**/api/scratchpad/session/create');
            await page.getByRole('button', { name: label, exact: true }).click();
            expect((await response).ok()).toBe(true);
            await openSessions();
        };
        const togglePin = async (row, label) => {
            const response = page.waitForResponse('**/api/scratchpad/session/update');
            await row.getByRole('button', { name: label, exact: true }).click();
            const result = await response;
            expect(result.ok(), await result.text()).toBe(true);
            return { source: result.request().postDataJSON().source, bucket: (await result.json()).bucket };
        };

        await openSessions();
        await newSession('New session');
        await newSession('New session');
        await expect(rows).toHaveCount(2);
        const [newer, older] = await names();
        await page.screenshot({ path: `${prefix}-before.png` });

        // The older session moves to the top once pinned, and says so.
        const { source, bucket } = await togglePin(rows.nth(1), 'Pin session');
        expect(await names()).toEqual([older, newer]);
        const unpin = rows.nth(0).getByRole('button', { name: 'Unpin session', exact: true });
        await expect(unpin).toHaveAttribute('aria-pressed', 'true');
        await expect(unpin).toBeFocused();
        await expect(rows.nth(0).locator('.scratchpad-session-info small')).toContainText('Pinned');
        await expect(rows.nth(1).locator('.scratchpad-session-info small')).not.toContainText('Pinned');
        expect(bucket.sessions.find(session => session.name === older).pinned).toBe(true);
        await page.screenshot({ path: `${prefix}-pinned.png` });

        const box = await unpin.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
        expect(box.width).toBeGreaterThanOrEqual(phone ? 44 : 36);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);

        // The pin is saved on the server, so it is still there after Scratchpad is closed and reopened.
        const saved = (await account.post('/api/scratchpad/bucket', { source })).bucket;
        expect(saved.sessions.filter(session => session.pinned).map(session => session.name)).toEqual([older]);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        await openSessions();
        expect(await names()).toEqual([older, newer]);

        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                for (const button of [unpin, rows.nth(1).getByRole('button', { name: 'Pin session', exact: true })]) {
                    const contrast = await button.evaluate(async element => {
                        const { contrastRatio } = await import('/scripts/theme-contrast.js');
                        const context = document.createElement('canvas').getContext('2d');
                        const channels = colour => {
                            context.fillStyle = colour;
                            context.fillRect(0, 0, 1, 1);
                            return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
                        };
                        // A transparent button shows the nearest painted surface behind it.
                        let surface = element;
                        while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
                        return contrastRatio(channels(getComputedStyle(element).color), channels(getComputedStyle(surface ?? document.body).backgroundColor));
                    });
                    expect(contrast, `${theme} ${accent ?? 'default'}`).toBeGreaterThanOrEqual(4.5);
                }
            }
        }

        // A temporary session offers no pin, because it disappears when another session opens.
        await newSession('Temporary session');
        const temporary = rows.filter({ hasText: 'Temporary' });
        await expect(temporary).toHaveCount(1);
        await expect(temporary.getByRole('button', { name: 'Pin session', exact: true })).toHaveCount(0);
        expect((await names())[0]).toBe(older);

        await togglePin(rows.nth(0), 'Unpin session');
        await expect(page.getByRole('button', { name: 'Unpin session', exact: true })).toHaveCount(0);
        await expect(rows.locator('.scratchpad-session-info small').filter({ hasText: 'Pinned' })).toHaveCount(0);
    });
}
