/* global document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} global Scratchpad instructions save, select assistants and survive reopening`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const open = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
            if (phone) await applyIOSOnlyCss(page);
        };
        const edit = page.getByRole('button', { name: 'Edit user instructions', exact: true });
        const save = page.getByRole('button', { name: 'Save instructions', exact: true });
        const editor = page.getByRole('textbox', { name: 'User instructions', exact: true });
        const scope = page.getByRole('combobox', { name: 'Apply to', exact: true });
        const prefix = `../screenshots/scratchpad-instructions/${phone ? 'phone' : 'desktop'}`;
        const saveInstructions = async () => {
            const response = page.waitForResponse('**/api/scratchpad/instructions/update');
            await save.click();
            const result = await response;
            expect(result.ok(), await result.text()).toBe(true);
            await expect(editor).toBeHidden();
            return (await result.json()).instructions;
        };

        await open();
        await expect(edit).toBeVisible();
        await page.screenshot({ path: `${prefix}-after.png` });
        await edit.click();
        await expect(scope).toHaveValue('all');
        await expect(editor).toHaveValue('');
        await editor.fill('Keep your answers concise. Ask before writing a long draft.\nUse British spelling and explain unfamiliar terms.');
        await scope.selectOption('selected');
        await page.getByRole('checkbox', { name: 'Taro', exact: true }).uncheck();
        await page.screenshot({ path: `${prefix}-editor.png` });
        const bounds = await editor.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        expect(bounds.height).toBeGreaterThanOrEqual(150);
        const checks = await page.locator('.scratchpad-review .scratchpad-check').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
        for (const height of checks) expect(height).toBeGreaterThanOrEqual(phone ? 44 : 36);
        expect((await saveInstructions()).assistants).toEqual(['miso', 'nori']);

        await edit.click();
        await expect(page.getByRole('checkbox', { name: 'Taro', exact: true })).not.toBeChecked();
        await page.getByRole('checkbox', { name: 'Miso', exact: true }).uncheck();
        expect((await saveInstructions()).assistants).toEqual(['nori']);
        await edit.click();
        await page.getByRole('checkbox', { name: 'Nori', exact: true }).uncheck();
        await save.click();
        await expect(page.getByRole('alert')).toContainText('Choose at least one assistant.');
        await expect(editor).toHaveValue(/Keep your answers concise/);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();

        // A second writer must not silently lose their saved instructions.
        await edit.click();
        const current = (await account.post('/api/scratchpad/instructions')).instructions;
        await account.post('/api/scratchpad/instructions/update', { instructions: { ...current, text: 'Saved elsewhere.' }, expectedRevision: current.revision });
        await editor.fill('My unsaved draft.');
        await save.click();
        await expect(page.getByRole('alert')).toContainText('User instructions changed elsewhere.');
        await expect(editor).toHaveValue('My unsaved draft.');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();

        // Reopening from Home needs no chat/session and reads the saved account data.
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await open();
        await edit.click();
        await expect(editor).toHaveValue('Saved elsewhere.');
        await expect(scope).toHaveValue('selected');
        await expect(page.getByRole('checkbox', { name: 'Nori', exact: true })).toBeChecked();
        await scope.selectOption('all');
        await editor.fill('GLOBAL-BROWSER-INSTRUCTIONS');
        expect((await saveInstructions()).scope).toBe('all');

        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                await edit.click();
                for (const button of [edit, save]) {
                    const contrast = await button.evaluate(async element => {
                        const { contrastRatio } = await import('/scripts/theme-contrast.js');
                        const context = document.createElement('canvas').getContext('2d');
                        const channels = colour => {
                            context.fillStyle = colour;
                            context.fillRect(0, 0, 1, 1);
                            return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
                        };
                        const style = getComputedStyle(element);
                        return contrastRatio(channels(style.color), channels(style.backgroundColor));
                    });
                    expect(contrast).toBeGreaterThanOrEqual(4.5);
                }
                await page.getByRole('button', { name: 'Cancel', exact: true }).click();
            }
        }

        await page.evaluate(async avatar => (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar), account.avatar);
        await open();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.locator('.scratchpad-composer').fill('Check my global preferences.');
        app.provider.mode.streamReply = { first: 'A thought.', rest: ' Finished.' };
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('A thought.');
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        expect(app.provider.calls.at(-1).messages[0].content).toContain('GLOBAL-BROWSER-INSTRUCTIONS');
        await open();
        await edit.click();
        await editor.fill('');
        expect((await saveInstructions()).text).toBe('');
    });
}
