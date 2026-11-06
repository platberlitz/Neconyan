/* global document, window */
/* eslint-disable playwright/no-conditional-in-test -- Optional baseline captures and viewport-specific setup. */
/* eslint-disable playwright/no-standalone-expect -- Shared setup verifies the selected source. */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

async function openScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} reviews and persists shared preset edits without changing other settings`, async ({ app }) => {
        test.setTimeout(150000);
        const size = phone ? 'phone' : 'desktop';
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const manager = getPresetManager('openai');
            const preset = structuredClone(manager.getPresetSettings());
            preset.prompts.find(item => item.identifier === 'main').content = 'Write {{char}}\'s next reply. Keep the scene moving.';
            await manager.savePreset('Scratchpad Garden', preset);
        }, account.avatar);
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/scratchpad/preset.js')).currentPresetName())).toBe('Scratchpad Garden');
        const original = await page.evaluate(async () => (await import('/scripts/preset-manager.js')).getPresetManager('openai').getCompletionPresetByName('Scratchpad Garden'));
        await openScratchpad(page);
        const source = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });
        expect(source.kind).toBe('roleplay');
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0]?.settings.assistantConnections?.miso?.profileId).toBe('durable');
        await page.getByRole('checkbox', { name: /^Current preset: Scratchpad Garden/ }).check();
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0]?.settings.include.preset).toBe(true);
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        const proposal = { type: 'preset', action: 'replace', api: 'openai', preset: 'Scratchpad Garden', module: 'main', field: 'content',
            value: 'Write {{char}}\'s next reply with vivid sensory details. Leave {{user}}\'s choices to them.', reason: 'Keep the scene vivid without deciding the user\'s actions.' };
        app.provider.mode.streamReply = { first: 'Here is a change to the Main Prompt.\n\n', rest: '```scratchpad-change\n' + JSON.stringify(proposal) + '\n```' };
        await page.locator('.scratchpad-composer').fill('Improve the main prompt in my preset.');
        const sent = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await sent;
        expect(response.ok(), await response.text()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('Here is a change');
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-change')).toContainText('Scratchpad Garden');
        const call = app.provider.calls.find(call => call.messages?.at(-1)?.content === 'Improve the main prompt in my preset.');
        expect(JSON.stringify(call.messages)).toContain('Module ID: main');
        expect(call.messages[0].content).toContain('"type":"preset"');
        const baseline = process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT;
        const reloadScratchpad = async () => {
            await page.reload();
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
            await page.evaluate(async avatar => {
                const context = window.SillyTavern.getContext();
                await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
            }, account.avatar);
            await openScratchpad(page);
        };
        if (baseline) {
            await page.route('**/scripts/scratchpad/**', route => route.fulfill({ path: path.join(baseline, 'public', new URL(route.request().url()).pathname), contentType: 'text/javascript' }));
            await reloadScratchpad();
            await expect(page.locator('.scratchpad-change.is-invalid')).toBeVisible();
            await page.evaluate(() => window.toastr.clear());
            await page.screenshot({ path: `../screenshots/preset-${size}-before.png` });
            await page.unroute('**/scripts/scratchpad/**');
            await reloadScratchpad();
        }
        await page.locator('.scratchpad-change').getByRole('button', { name: 'Review', exact: true }).click();
        await expect(page.locator('.scratchpad-review-editor')).toHaveValue(proposal.value);
        await page.evaluate(() => window.toastr.clear());
        await page.screenshot({ path: `../screenshots/preset-${size}-after.png` });
        const reviewed = proposal.value + '\nKeep literal {{char}} macros.';
        await page.locator('.scratchpad-review-editor').fill(reviewed);
        expect(await page.evaluate(async () => (await import('/scripts/preset-manager.js')).getPresetManager('openai').getCompletionPresetByName('Scratchpad Garden'))).toEqual(original);
        const saved = page.waitForResponse('**/api/presets/save');
        await page.getByRole('button', { name: 'Save change', exact: true }).click();
        const savedResponse = await saved;
        expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
        expect(savedResponse.request().postDataJSON().expected_preset).toEqual(original);
        await expect(page.locator('.scratchpad-change')).toContainText('Saved');
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/scratchpad/preset.js')).currentPresetName())).toBe('Scratchpad Garden');
        const persisted = await page.evaluate(async () => (await import('/scripts/preset-manager.js')).getPresetManager('openai').getCompletionPresetByName('Scratchpad Garden'));
        expect(persisted.prompts.find(item => item.identifier === 'main').content).toBe(reviewed);
        expect(persisted.prompts.filter(item => item.identifier !== 'main')).toEqual(original.prompts.filter(item => item.identifier !== 'main'));
        expect(persisted.temperature).toBe(original.temperature);
        expect(persisted.prompt_order).toEqual(original.prompt_order);
    });
}
