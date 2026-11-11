/* global document, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Scratchpad Context choices can be saved as a setup and applied to another session`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const openContext = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
            if (phone) await applyIOSOnlyCss(page);
        };
        const prefix = `../screenshots/scratchpad-context-setups/${phone ? 'phone' : 'desktop'}`;
        const section = page.locator('.scratchpad-setups');
        const depth = page.locator('#scratchpad-depth');
        const stream = page.getByRole('checkbox', { name: 'Stream replies' });
        const button = name => section.getByRole('button', { name, exact: true });
        const saved = async action => {
            const response = page.waitForResponse('**/api/scratchpad/session/update');
            await action();
            const result = await response;
            expect(result.ok(), await result.text()).toBe(true);
        };
        const setDepth = value => saved(async () => {
            await depth.fill(String(value));
            await depth.dispatchEvent('change');
        });
        const listed = async () => (await account.post('/api/scratchpad/context-setups', {})).contextSetups;

        await openContext();
        await expect(section.getByRole('heading', { name: 'Saved setups' })).toBeVisible();
        await expect(section).toContainText('You have no saved setups yet.');
        await expect(page.locator('#scratchpad-setup')).toHaveCount(0);
        await expect(button('Apply setup')).toHaveCount(0);
        await expect(button('Delete setup')).toHaveCount(0);
        await section.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${prefix}-empty.png` });

        // Choices worth keeping: seven messages, and wait for the finished reply.
        await setDepth(7);
        await saved(() => stream.uncheck());

        await button('Save current choices').click();
        const dialog = page.locator('dialog[open]');
        await expect(dialog).toContainText('Name this setup:');
        await dialog.locator('.popup-input').fill('  Quick   look ');
        const written = page.waitForResponse('**/api/scratchpad/context-setups/update');
        await dialog.locator('.popup-button-ok').click();
        const response = await written;
        expect(response.ok(), await response.text()).toBe(true);
        const select = page.locator('#scratchpad-setup');
        await expect(select).toHaveValue('Quick look');
        await expect(button('Save current choices')).toBeFocused();
        const stored = await listed();
        expect(stored.setups.map(setup => setup.name)).toEqual(['Quick look']);
        expect(stored.setups[0].settings).toMatchObject({ depth: 7, stream: false });
        expect(Object.keys(stored.setups[0].settings).sort()).toEqual(['depth', 'include', 'maxTokens', 'partialPrefill', 'prefill', 'readLinks', 'stream', 'webSearch']);

        await section.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${prefix}-saved.png` });
        for (const name of ['Apply setup', 'Save current choices', 'Delete setup']) {
            const box = await button(name).boundingBox();
            expect(box.height, name).toBeGreaterThanOrEqual(phone ? 44 : 32);
            expect(box.x, name).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width, name).toBeLessThanOrEqual(phone ? 393 : 1280);
        }
        const selectBox = await select.boundingBox();
        expect(selectBox.height).toBeGreaterThanOrEqual(phone ? 44 : 30);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

        // A new session starts from its own choices; applying the setup brings the saved ones in.
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'sessions' }));
        const created = page.waitForResponse('**/api/scratchpad/session/create');
        await page.locator('#neconyan-scratchpad .scratchpad-panel:not([hidden])').getByRole('button', { name: 'New session', exact: true }).click();
        expect((await created).ok()).toBe(true);
        await openContext();
        await setDepth(3);
        if (!await stream.isChecked()) await saved(() => stream.check());
        await expect(select).toHaveValue('Quick look');
        await saved(() => button('Apply setup').click());
        await expect(depth).toHaveValue('7');
        await expect(stream).not.toBeChecked();
        await expect(page.locator('#toast-container')).toContainText('Setup applied to this session.');
        await section.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${prefix}-applied.png` });

        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                for (const name of ['Apply setup', 'Save current choices', 'Delete setup']) {
                    const contrast = await button(name).evaluate(async element => {
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
                    expect(contrast, `${theme} ${accent ?? 'default'} ${name}`).toBeGreaterThanOrEqual(4.5);
                }
            }
        }

        // Setups belong to the account, so they are still there after a reload.
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await openContext();
        await expect(select).toHaveValue('Quick look');

        // 'Cancel' keeps the setup; 'Delete setup' removes it without touching the session that used it.
        await button('Delete setup').click();
        await expect(dialog).toContainText('Delete the saved setup \'Quick look\'?');
        await dialog.locator('.popup-button-cancel').click();
        await expect(select).toHaveValue('Quick look');
        await button('Delete setup').click();
        const removed = page.waitForResponse('**/api/scratchpad/context-setups/update');
        await dialog.locator('.popup-button-ok').click();
        expect((await removed).ok()).toBe(true);
        await expect(section).toContainText('You have no saved setups yet.');
        await expect(select).toHaveCount(0);
        expect((await listed()).setups).toEqual([]);
    });
}
