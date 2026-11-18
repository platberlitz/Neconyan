/* global window */
/* eslint-disable playwright/no-conditional-in-test -- Both viewports share the same checks with optional iOS emulation and screenshots. */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

async function equipPreset(page, name, prompt) {
    await page.evaluate(async ({ name, prompt }) => {
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        const manager = getPresetManager('openai');
        const preset = structuredClone(manager.getPresetSettings());
        preset.prompts.find(item => item.identifier === 'main').content = prompt;
        await manager.savePreset(name, preset);
    }, { name, prompt });
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} General Scratchpad opts in to sharing the equipped preset as reference`, async ({ app }) => {
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const openContext = async activePage => {
            await activePage.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
            await activePage.getByRole('tab', { name: 'Context', exact: true }).click();
            if (phone) await applyIOSOnlyCss(activePage);
        };
        const baseline = process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT;
        const screenshot = (activePage, label) => activePage.screenshot({ path: `../screenshots/scratchpad-general-preset/${phone ? 'phone' : 'desktop'}-${label}.png` });
        const clearToasts = activePage => activePage.evaluate(() => window.toastr.clear());
        if (baseline) {
            const before = await account.open({ workspace: false });
            await before.route('**/scripts/scratchpad/**', route => route.fulfill({ path: path.join(baseline, 'public', new URL(route.request().url()).pathname), contentType: 'text/javascript' }));
            await openContext(before);
            const share = before.getByRole('heading', { name: 'Also share', exact: true });
            await share.scrollIntoViewIfNeeded();
            await clearToasts(before);
            await screenshot(before, 'before');
            await before.close();
        }
        const page = await account.open({ workspace: false });
        await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
        const tab = name => page.getByRole('tab', { name, exact: true });
        await equipPreset(page, 'Garden', 'Garden prompt with {{char}}.');
        await openContext(page);
        await expect(page.locator('.scratchpad-source')).toContainText('General Scratchpad');
        const preset = () => page.getByRole('checkbox', { name: /^Current preset:/ });
        await expect(preset()).toHaveAccessibleName(/^Current preset: Garden/);
        await expect(preset()).not.toBeChecked();
        const row = preset().locator('..');
        await row.scrollIntoViewIfNeeded();
        const box = await row.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        const previewButton = page.getByRole('button', { name: 'Show preview', exact: true });
        const preview = page.locator('pre.scratchpad-preview-text');
        await previewButton.click();
        await expect(preview).toBeVisible();
        await expect(preview).not.toContainText('Garden');

        // Preview while the first setting is still saving, before the session redraws Context.
        const saveGate = Promise.withResolvers();
        await page.route('**/api/scratchpad/session/update', async route => {
            await saveGate.promise;
            await route.continue();
        }, { times: 1 });
        try {
            await preset().check();
            await previewButton.click();
        } finally {
            saveGate.resolve();
        }
        await expect(preview).toContainText('## Current preset: Garden');
        await expect(preview).toContainText('Garden prompt with {{char}}.');
        if (baseline) {
            await page.getByRole('heading', { name: 'Also share', exact: true }).scrollIntoViewIfNeeded();
            await clearToasts(page);
            await screenshot(page, 'after');
        }

        const rawPrompt = 'Harbour prompt with {{lastMessage}}.';
        await equipPreset(page, 'Harbour', rawPrompt);
        await expect(preset()).toHaveAccessibleName(/^Current preset: Harbour/);
        await expect(preset()).toBeChecked();
        await previewButton.click();
        await expect(preview).toContainText(rawPrompt);
        await expect(preview).not.toContainText('Garden');

        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('checkbox', { name: /^Stream replies/ }).uncheck();
        await tab('Chat').click();
        const question = 'What is the prompt for my equipped preset?';
        app.provider.mode.reply = { choices: [{ message: { content: 'Here is what the preset says.' } }] };
        await page.locator('.scratchpad-composer').fill(question);
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        await account.settled((await response.json()).job.id);
        const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === question);
        expect(calls).toHaveLength(1);
        const sent = calls[0].messages.map(message => String(message.content)).join('\n');
        expect(sent).toContain('## Current preset: Harbour');
        expect(sent).toContain(rawPrompt);
        expect(sent).not.toMatch(/Garden|Latest messages|## Author's Note|Editable preset target|"type":"preset"/);

        await tab('Context').click();
        await preset().uncheck();
        await previewButton.click();
        await expect(preview).toBeVisible();
        await expect(preview).not.toContainText(rawPrompt);
    });
}
