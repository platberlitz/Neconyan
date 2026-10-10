/* global document */
/* eslint-disable playwright/no-standalone-expect -- Shared helpers verify the visible Scratchpad state. */
import { expect } from '@playwright/test';
import { MODEL, test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

async function openScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
    return page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
}

async function checkEmptyAssistant(page, name, title) {
    await expect(page.locator('.scratchpad-summary')).toContainText(title);
    await expect(page.locator('.scratchpad-empty')).toContainText(`Ask ${name} anything.`);
    const expected = await page.evaluate(async id => (await import('/scripts/neconyan-assistant-art.js')).getAssistantIconSrc(id), name.toLowerCase());
    await expect(page.locator('.scratchpad-empty img')).toHaveAttribute('src', expected);
}

for (const phone of [false, true]) {
    const size = phone ? 'phone' : 'desktop';
    test(`${size} switches the whole empty Scratchpad identity and keeps a custom name`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const source = await openScratchpad(page);
        if (phone) await applyIOSOnlyCss(page);
        const picker = page.locator('.scratchpad-assistants');
        await page.locator('.scratchpad-composer').fill('Keep my unsent idea.');
        for (const name of ['Taro', 'Nori', 'Miso', 'Taro']) {
            await picker.getByRole('button', { name, exact: true }).click();
            await checkEmptyAssistant(page, name, `New session with ${name}`);
            await expect(page.locator('.scratchpad-composer')).toHaveValue('Keep my unsent idea.');
        }
        expect((await account.post('/api/scratchpad/bucket', { source })).bucket.sessions).toHaveLength(0);
        await page.screenshot({ path: `../screenshots/scratchpad-identity-${size}-after.png` });
        await page.locator('.scratchpad-header .scratchpad-new-session').click();
        await checkEmptyAssistant(page, 'Taro', "Taro's notes");
        await picker.getByRole('button', { name: 'Nori', exact: true }).click();
        await checkEmptyAssistant(page, 'Nori', "Nori's notes");
        const saved = (await account.post('/api/scratchpad/bucket', { source })).bucket;
        await account.post('/api/scratchpad/session/update', { source, sessionId: saved.activeSessionId, changes: { name: 'My planning' } });
        await openScratchpad(page);
        await picker.getByRole('button', { name: 'Miso', exact: true }).click();
        await checkEmptyAssistant(page, 'Miso', 'My planning');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
    });

    test(`${size} saves the streaming choice and streams thinking before the answer`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {},
            configureSettings: saved => { saved.oai_settings.show_thoughts = true; } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        let page = await account.open();
        const source = await openScratchpad(page);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(page.getByRole('checkbox', { name: 'Stream replies' })).toBeChecked();
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0]?.settings.stream).toBe(false);
        await page.close();
        page = await account.open();
        await openScratchpad(page);
        if (phone) await applyIOSOnlyCss(page);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(page.getByRole('checkbox', { name: 'Stream replies' })).not.toBeChecked();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        app.provider.mode.hold = MODEL;
        app.provider.mode.reply = { choices: [{ message: { content: 'The finished answer.', reasoning_content: 'The finished thinking.' } }] };
        await page.locator('.scratchpad-composer').fill('Wait until the answer is ready.');
        let accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        let response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        await expect.poll(() => app.provider.calls.find(call => call.messages?.at(-1)?.content === 'Wait until the answer is ready.')?.stream).toBe(false);
        await expect(page.locator('.scratchpad-stream')).toHaveText('');
        await expect(page.locator('.scratchpad-message.is-pending .scratchpad-reasoning')).toBeHidden();
        await app.release();
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        await expect(page.locator('.scratchpad-reasoning .scratchpad-plain')).toHaveText('The finished thinking.');

        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.getByRole('checkbox', { name: 'Stream replies' }).check();
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0]?.settings.stream).toBe(true);
        await page.locator('#scratchpad-max-tokens').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/scratchpad-settings-${size}-after.png` });
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        app.provider.mode.streamReply = { reasoning: 'Checking the scene.', holdReasoning: true,
            reasoningRest: ' Comparing the details.', first: 'A streamed answer', rest: ' is ready.' };
        await page.locator('.scratchpad-composer').fill('Show your thinking as it arrives.');
        accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        let reasoning = page.locator('.scratchpad-message.is-pending .scratchpad-reasoning');
        await expect(reasoning.locator('.scratchpad-plain')).toBeVisible();
        await expect(reasoning).toContainText('Checking the scene.');
        await expect(page.locator('.scratchpad-stream')).toHaveText('');
        await page.screenshot({ path: `../screenshots/scratchpad-thinking-${size}-after.png` });
        await reasoning.locator('summary').click();
        app.provider.mode.finishReasoning();
        await expect(reasoning.locator('.scratchpad-plain')).toHaveText('Checking the scene. Comparing the details.');
        await expect(reasoning).not.toHaveAttribute('open');
        await expect(page.locator('.scratchpad-stream')).toHaveText('A streamed answer');
        await page.close();
        page = await account.open();
        await openScratchpad(page);
        reasoning = page.locator('.scratchpad-message.is-pending .scratchpad-reasoning');
        await expect(reasoning.locator('.scratchpad-plain')).toBeVisible();
        await expect(reasoning).toContainText('Checking the scene. Comparing the details.');
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        await expect(page.locator('.scratchpad-reply').last()).toHaveText('A streamed answer is ready.');
        await expect(page.locator('.scratchpad-reasoning .scratchpad-plain').last()).toHaveText('Checking the scene. Comparing the details.');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
    });
}
