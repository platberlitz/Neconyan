/* global document, getComputedStyle */
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Scratchpad assistant library`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const page = await account.open();
        await page.evaluate(async avatar => (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar), account.avatar);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(page.locator('.scratchpad-composer')).toBeVisible();
        const prefix = `../screenshots/scratchpad-assistants/${phone ? 'phone' : 'desktop'}`;
        const manage = page.getByRole('button', { name: 'Assistants', exact: true });
        await manage.click();
        await page.getByRole('button', { name: 'Add a new assistant', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Remove picture', exact: true })).toBeHidden();
        await page.getByRole('textbox', { name: 'Assistant name', exact: true }).fill('Jun');
        await page.getByRole('textbox', { name: 'Personality', exact: true }).fill('You are Jun, a patient, dry-humoured editor. Ask precise questions and keep suggestions practical.');
        await page.getByLabel('Assistant picture', { exact: true }).setInputFiles('../public/img/neconyan/assistant-icons/nori-neutral.png');
        await expect(page.locator('.scratchpad-library')).not.toHaveAttribute('aria-busy', 'true');
        await page.screenshot({ path: `${prefix}-editor.png` });
        const save = async () => {
            const response = page.waitForResponse('**/api/scratchpad/assistants/save');
            await page.getByRole('button', { name: 'Save assistant', exact: true }).click();
            const result = await response;
            expect(result.ok(), await result.text()).toBe(true);
            await expect(page.getByRole('heading', { name: 'Your assistants', exact: true })).toBeVisible();
            return (await result.json()).assistant;
        };
        const assistant = await save();
        expect(assistant.avatar).toMatch(/^data:image\/jpeg;base64,/);
        await expect(page.getByRole('button', { name: 'Use Jun', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await page.getByRole('button', { name: 'Use a character card', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Search character cards', exact: true }).fill('Durable Nova');
        await page.screenshot({ path: `${prefix}-cards.png` });
        const importedResponse = page.waitForResponse('**/api/scratchpad/assistants/save');
        await page.getByRole('button', { name: 'Add Durable Nova as an assistant', exact: true }).click();
        const imported = await importedResponse;
        expect(imported.ok(), await imported.text()).toBe(true);
        expect((await imported.json()).assistant.personality).toContain('Nova belongs to account');
        await page.getByRole('button', { name: 'Use Jun', exact: true }).click();
        await page.screenshot({ path: `${prefix}-library.png` });
        const bounds = await page.locator('.scratchpad-library').boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        for (const height of await page.locator('.scratchpad-library-button').evaluateAll(items => items.map(item => item.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        await page.locator('.scratchpad-composer').fill('Help me plan a difficult conversation.');
        app.provider.mode.streamReply = { first: 'Jun has a thought.', rest: ' Ask one clear question.' };
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('Jun has a thought.');
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-send')).toHaveAccessibleName('Send');
        expect(app.provider.calls.at(-1).messages[0].content).toContain('You are Jun, a patient, dry-humoured editor.');
        await expect(page.locator('.scratchpad-message.is-assistant .scratchpad-author')).toContainText('Jun');
        // Custom choices keep the same two-row header as the included assistants.
        expect((await page.locator('.scratchpad-chat-top').boundingBox()).height).toBeLessThanOrEqual(112);
        await page.screenshot({ path: `${prefix}-after.png` });
        await manage.click();
        await page.getByRole('button', { name: 'Edit Jun', exact: true }).click();
        await page.getByRole('textbox', { name: 'Assistant name', exact: true }).fill('June');
        await page.getByRole('textbox', { name: 'Personality', exact: true }).fill('EDITED-BROWSER-VOICE. You are June.');
        expect((await save()).id).toBe(assistant.id);
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        await expect(page.locator('.scratchpad-message.is-assistant .scratchpad-author')).toContainText('Jun');
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await page.evaluate(async avatar => (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar), account.avatar);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await manage.click();
        await page.getByRole('button', { name: 'Edit June', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'Personality', exact: true })).toHaveValue('EDITED-BROWSER-VOICE. You are June.');
        await expect(page.locator('.scratchpad-library-portrait')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
        await page.getByRole('button', { name: 'Back to assistants', exact: true }).click();
        await page.getByRole('button', { name: 'Done', exact: true }).click();

        // Portability includes the used assistant, not unrelated library entries.
        await page.getByRole('tab', { name: 'Sessions', exact: true }).click();
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Export current', exact: true }).click();
        const exported = JSON.parse(await fs.readFile(await (await download).path(), 'utf8'));
        expect(Object.keys(exported.session.settings.assistants)).toEqual([assistant.id]);
        expect(exported.session.settings.assistants[assistant.id].name).toBe('June');
        expect(exported.session.messages.find(item => item.role === 'assistant').assistantName).toBe('Jun');

        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        const checkButtons = async () => {
            const ratios = await page.locator('.scratchpad-library-button:not(:disabled)').evaluateAll(async elements => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const context = document.createElement('canvas').getContext('2d');
                const channels = colour => { context.fillStyle = colour; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3); };
                return elements.map(element => {
                    const style = getComputedStyle(element);
                    return { label: element.getAttribute('aria-label') || element.textContent, ratio: contrastRatio(channels(style.color), channels(style.backgroundColor)) };
                });
            });
            for (const { label, ratio } of ratios) expect(ratio, label).toBeGreaterThanOrEqual(4.5);
            const surface = await page.locator('dialog:has(.scratchpad-library)').evaluate(element => getComputedStyle(element).backgroundColor);
            expect(surface).toMatch(/^rgb\(/);
            expect((await page.locator('dialog:has(.scratchpad-library)').boundingBox()).width).toBeLessThanOrEqual(phone ? 393 : 720);
        };
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                await manage.click();
                await checkButtons();
                await page.getByRole('button', { name: 'Edit June', exact: true }).click();
                await checkButtons();
                await page.getByRole('button', { name: 'Done', exact: true }).click();
            }
        }
        await page.getByRole('button', { name: 'Round table', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Round table', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await manage.click();
        await page.getByRole('button', { name: 'Edit June', exact: true }).click();
        await save();
        await expect(page.getByRole('button', { name: 'Use June', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.scratchpad-library-button[aria-pressed="true"]')).toHaveCount(3);

        await page.getByRole('button', { name: 'Edit Durable Nova', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Remove picture', exact: true })).toBeVisible();
        await page.screenshot({ path: `${prefix}-edit-card.png` });
        await page.getByRole('button', { name: 'Delete Durable Nova', exact: true }).click();
        const deleted = page.waitForResponse('**/api/scratchpad/assistants/delete');
        await page.locator('dialog[open] .popup-button-ok').last().click();
        expect((await deleted).ok()).toBe(true);
        await expect(page.getByRole('heading', { name: 'Your assistants', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Use Durable Nova', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Use June', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await page.getByRole('button', { name: 'Done', exact: true }).click();
    });
}
