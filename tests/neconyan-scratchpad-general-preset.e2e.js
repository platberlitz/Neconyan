/* global window */
/* eslint-disable playwright/no-conditional-in-test -- Exercise the context UI at both sizes and verify the shared send path once. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { openScratchpadContext, showContextSection } from './neconyan-scratchpad-context-helpers.js';

async function equipPreset(page, name, prompt) {
    await page.evaluate(async ({ name, prompt }) => {
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        const manager = getPresetManager('openai');
        const preset = structuredClone(manager.getPresetSettings());
        preset.prompts.find(item => item.identifier === 'main').content = prompt;
        await manager.savePreset(name, preset);
    }, { name, prompt });
}

async function expectSharedPreset(page, app, account, tab, rawPrompt) {
    await showContextSection(page, 'replies');
    await page.locator('#scratchpad-connection-miso').selectOption('durable');
    await page.getByRole('checkbox', { name: /^Stream replies/ }).uncheck();
    await tab('Chat').click();
    const question = 'What is the prompt for my equipped preset?';
    app.provider.mode.reply = { choices: [{ message: { content: 'Here is what the preset says.' } }] };
    await page.locator('.scratchpad-composer').fill(question);
    const [response] = await Promise.all([
        page.waitForResponse('**/api/scratchpad/send'),
        page.locator('.scratchpad-send').click(),
    ]);
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).job.id);
    const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === question);
    expect(calls).toHaveLength(1);
    const sent = calls[0].messages.map(message => String(message.content)).join('\n');
    expect(sent).toContain('## Current preset: Harbour');
    expect(sent).toContain(rawPrompt);
    expect(sent).not.toMatch(/Garden|Latest messages|## Author's Note|Editable preset target|"type":"preset"/);
    await openScratchpadContext(page, 'sharing');
}

async function expectPresetPreview(button, preview, prompt) {
    await button.click();
    await expect(preview).toContainText(prompt);
}

const withoutPreset = /^General Scratchpad:(?![\s\S]*## Current preset:)/;

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} General Scratchpad opts in to sharing the equipped preset as reference`, async ({ app }) => {
        const account = await app.account({
            phone,
            contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {},
            configureSettings(saved) {
                saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
                saved.power_user.reduced_motion = true;
            },
        });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false, skipTour: false });
        await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
        const tab = name => page.getByRole('tab', { name, exact: true });
        await equipPreset(page, 'Garden', 'Garden prompt with {{char}}.');
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await openScratchpadContext(page, 'sharing');
        if (phone) await applyIOSOnlyCss(page);
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
        await expect(preview).toHaveText(withoutPreset);

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
        if (process.env.NECONYAN_SCRATCHPAD_SCREENSHOTS === '1') {
            await page.getByRole('heading', { name: 'Story and lore', exact: true }).scrollIntoViewIfNeeded();
            await page.evaluate(() => window.toastr.clear());
            await page.screenshot({ path: `../screenshots/scratchpad-general-preset/${phone ? 'phone' : 'desktop'}-after.png` });
        }

        const rawPrompt = 'Harbour prompt with {{lastMessage}}.';
        await equipPreset(page, 'Harbour', rawPrompt);
        await expect(preset()).toHaveAccessibleName(/^Current preset: Harbour/);
        await expect(preset()).toBeChecked();

        if (phone) await expectPresetPreview(previewButton, preview, rawPrompt);
        else await expectSharedPreset(page, app, account, tab, rawPrompt);

        await preset().uncheck();
        await previewButton.click();
        await expect(preview).toHaveText(withoutPreset);
    });
}
