/* global document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} saved Scratchpad quick prompts can be added, reordered, deleted and survive reopening`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const open = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad());
            if (phone) await applyIOSOnlyCss(page);
        };
        const quick = page.locator('.scratchpad-quick');
        const edit = quick.getByRole('button', { name: 'Edit quick prompts', exact: true });
        const add = page.getByRole('button', { name: 'Add a prompt', exact: true });
        const save = page.getByRole('button', { name: 'Save quick prompts', exact: true });
        const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
        const rows = page.locator('.scratchpad-quick-row');
        const names = page.getByRole('textbox', { name: 'Name on the button', exact: true });
        const texts = page.getByRole('textbox', { name: 'Text it fills in', exact: true });
        const composer = page.locator('.scratchpad-composer');
        const prefix = `../screenshots/scratchpad-quick-prompts/${phone ? 'phone' : 'desktop'}`;
        // 'Image idea' joins the row once image availability has been checked, which can land at any point in the test.
        const chipLabels = async () => (await quick.locator('button:not(.scratchpad-chip-edit)').allTextContents()).filter(label => label !== 'Image idea');
        const savePrompts = async () => {
            const response = page.waitForResponse('**/api/scratchpad/quick-prompts/update');
            await save.click();
            const result = await response;
            expect(result.ok(), await result.text()).toBe(true);
            await expect(add).toBeHidden();
            return (await result.json()).quickPrompts;
        };

        await open();
        await expect(edit).toBeVisible();
        const builtIn = await chipLabels();
        expect(builtIn).toContain('Plot ideas');
        await page.screenshot({ path: `${prefix}-before.png` });

        await edit.click();
        await expect(page.getByText('You have no quick prompts of your own yet.')).toBeVisible();
        await add.click();
        await expect(names.nth(0)).toBeFocused();
        await names.nth(0).fill('Tighten prose');
        await texts.nth(0).fill('Tighten this passage without changing its meaning:\n');
        await add.click();
        await names.nth(1).fill('Name ideas');
        await texts.nth(1).fill('Suggest ten names for ');
        await page.screenshot({ path: `${prefix}-editor.png` });

        for (const box of [await names.nth(0).boundingBox(), await texts.nth(0).boundingBox()]) {
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        }
        const targets = await page.locator('.scratchpad-quick-row-button, .scratchpad-quick-add').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
        for (const height of targets) expect(height).toBeGreaterThanOrEqual(phone ? 44 : 36);

        // A half-filled row is refused rather than silently dropped.
        await add.click();
        await names.nth(2).fill('No text yet');
        await save.click();
        await expect(page.getByRole('alert')).toContainText('Each quick prompt needs a name and the text it fills in.');
        await rows.nth(2).getByRole('button', { name: 'Delete prompt', exact: true }).click();
        await expect(rows).toHaveCount(2);

        await rows.nth(1).getByRole('button', { name: 'Move up', exact: true }).click();
        await expect(names.nth(0)).toHaveValue('Name ideas');
        await expect(rows.nth(0).getByRole('button', { name: 'Move up', exact: true })).toBeDisabled();
        expect((await savePrompts()).prompts.map(prompt => prompt.label)).toEqual(['Name ideas', 'Tighten prose']);

        // Saved prompts sit before the built-in ones, and pressing one only fills the message box.
        expect(await chipLabels()).toEqual(['Name ideas', 'Tighten prose', ...builtIn]);
        await quick.getByRole('button', { name: 'Tighten prose', exact: true }).click();
        await expect(composer).toHaveValue('Tighten this passage without changing its meaning:\n');
        await composer.fill('');
        await page.screenshot({ path: `${prefix}-after.png` });

        // A second writer must not silently lose their saved prompts.
        await edit.click();
        const current = (await account.post('/api/scratchpad/quick-prompts')).quickPrompts;
        await account.post('/api/scratchpad/quick-prompts/update', { prompts: [{ label: 'Saved elsewhere', text: 'From another device.' }], expectedRevision: current.revision });
        await names.nth(0).fill('My unsaved name');
        await save.click();
        await expect(page.getByRole('alert')).toContainText('Your quick prompts changed elsewhere.');
        await expect(names.nth(0)).toHaveValue('My unsaved name');
        await cancel.click();

        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await open();
        await expect(quick.getByRole('button', { name: 'Saved elsewhere', exact: true })).toBeVisible();
        // Home may offer a different built-in set than the chat did; the saved prompt still leads it.
        const reopened = await chipLabels();
        expect(reopened[0]).toBe('Saved elsewhere');
        expect(reopened).not.toContain('Name ideas');

        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                await edit.click();
                for (const button of [edit, add, save, rows.nth(0).getByRole('button', { name: 'Delete prompt', exact: true })]) {
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
                    expect(contrast).toBeGreaterThanOrEqual(4.5);
                }
                await cancel.click();
            }
        }

        await edit.click();
        await rows.nth(0).getByRole('button', { name: 'Delete prompt', exact: true }).click();
        expect((await savePrompts()).prompts).toEqual([]);
        expect(await chipLabels()).toEqual(reopened.slice(1));
    });
}
