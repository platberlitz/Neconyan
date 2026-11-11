/* global document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const GENERAL = { kind: 'general', key: 'general', label: 'General Scratchpad' };

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Scratchpad finds a session in another list and copies it here`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const prefix = `../screenshots/scratchpad-search-all/${phone ? 'phone' : 'desktop'}`;
        const width = phone ? 393 : 1280;

        // A session that lives in General Scratchpad, not in the chat that is open.
        const created = Date.now() - 60000;
        const imported = await account.post('/api/scratchpad/session/import', {
            source: GENERAL,
            session: {
                name: 'Harbour plans', assistant: 'miso',
                messages: [
                    { role: 'user', text: 'Where does the lighthouse keeper hide the brass key?', created },
                    { role: 'assistant', text: 'Under the third step of the lighthouse stairs.', created: created + 1000, assistant: 'miso' },
                ],
            },
        });
        const original = imported.bucket.sessions.find(session => session.name === 'Harbour plans');
        expect(original).toBeTruthy();

        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'sessions' }));
        if (phone) await applyIOSOnlyCss(page);
        const box = page.locator('.scratchpad-session-search');
        const button = page.locator('.scratchpad-every-list-button');

        // One character is too little to search every list.
        await box.fill('l');
        await expect(button).toHaveCount(0);
        await box.fill('lighthouse');
        await expect(button).toBeVisible();
        await expect(button).toHaveText(/Search every list/);
        await expect(page.locator('.scratchpad-found')).toHaveCount(0);

        const searched = page.waitForResponse('**/api/scratchpad/search');
        await button.click();
        const answer = await searched;
        expect(answer.ok(), await answer.text()).toBe(true);
        expect(answer.request().postDataJSON()).toEqual({ query: 'lighthouse' });

        const found = page.locator('.scratchpad-found .scratchpad-session');
        await expect(found).toHaveCount(1);
        await expect(page.locator('.scratchpad-every-list [role="status"]')).toHaveText('1 match in your other lists.');
        await expect(found.locator('strong')).toHaveText('Harbour plans');
        await expect(found.locator('small')).toContainText('General Scratchpad');
        await expect(found.locator('small')).toContainText('2 messages');
        await expect(found.locator('small')).toContainText(String(new Date().getFullYear()));
        await expect(found.locator('small')).not.toContainText('General Scratchpad: General Scratchpad');
        await expect(found.locator('.scratchpad-found-snippet')).toContainText('lighthouse keeper hide the brass key');
        await expect(button).toBeFocused();

        const copy = found.getByRole('button', { name: 'Copy here', exact: true });
        for (const control of [button, copy]) {
            const size = await control.boundingBox();
            expect(size.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
            expect(size.x).toBeGreaterThanOrEqual(0);
            expect(size.x + size.width).toBeLessThanOrEqual(width);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await copy.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${prefix}-results.png` });

        // Copying puts the session in the open list and opens it; the original stays in General.
        const copied = page.waitForResponse('**/api/scratchpad/search/copy');
        await copy.click();
        const result = await copied;
        expect(result.ok(), await result.text()).toBe(true);
        const bucket = (await result.json()).bucket;
        const session = bucket.sessions.find(item => item.name === 'Harbour plans');
        expect(session.id).not.toBe(original.id);
        expect(bucket.activeSessionId).toBe(session.id);
        await expect(page.locator('.scratchpad-message.is-user')).toContainText('brass key');
        await expect(page.locator('.scratchpad-message.is-assistant')).toContainText('third step of the lighthouse stairs');
        await page.screenshot({ path: `${prefix}-copied.png` });
        const general = (await account.post('/api/scratchpad/bucket', { source: GENERAL })).bucket;
        expect(general.sessions.map(item => item.id)).toContain(original.id);

        // The copy is now in this list, so the same search no longer offers the General one twice over.
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'sessions' }));
        await box.fill('nothing like this anywhere');
        await box.press('Enter');
        await expect(page.locator('.scratchpad-every-list [role="status"]')).toHaveText('Nothing in your other lists matches that search.');

        await box.fill('lighthouse');
        await box.press('Enter');
        await expect(found).toHaveCount(1);
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                for (const control of [button, copy]) {
                    const contrast = await control.evaluate(async element => {
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
    });
}
