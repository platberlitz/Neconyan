import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} unchanged default prompts stay default on the next request and custom prompts are preserved`, async ({ app }, testInfo) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        // eslint-disable-next-line playwright/no-conditional-in-test -- Only the phone fixture emulates iPhone Safari.
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const notebookId = (await account.post('/api/notebooks/list')).notebooks[0].id;
        await account.post('/api/notebooks/policies/update', { notebookId, patch: { assistant: 'read' } });
        const page = await account.open();
        const openEditor = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
            // eslint-disable-next-line playwright/no-conditional-in-test -- Chromium needs the iOS-only CSS for the phone fixture.
            if (phone) await applyIOSOnlyCss(page);
            await page.getByRole('button', { name: 'View or edit Miso\'s prompt', exact: true }).click();
        };
        const editor = page.getByRole('textbox', { name: 'Assistant prompt', exact: true });
        const savePrompt = async () => {
            const saved = page.waitForResponse('**/api/scratchpad/session/update');
            await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
            const response = await saved;
            expect(response.ok()).toBe(true);
            const { bucket } = await response.json();
            return bucket.sessions.find(session => session.id === bucket.activeSessionId).settings;
        };
        const send = async text => {
            await page.getByRole('tab', { name: 'Chat', exact: true }).click();
            await page.locator('.scratchpad-composer').fill(text);
            app.provider.mode.streamReply = { first: 'A thought.', rest: ' Finished.' };
            const accepted = page.waitForResponse('**/api/scratchpad/send');
            await page.locator('.scratchpad-send').click();
            const response = await accepted;
            expect(response.ok()).toBe(true);
            await expect(page.locator('.scratchpad-stream')).toContainText('A thought.');
            app.provider.mode.finishStream();
            await account.settled((await response.json()).job.id);
            await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
            return app.provider.calls.find(call => call.messages?.at(-1)?.content === text).messages;
        };
        const marker = 'Notebook changes use the shared Notebook operations';
        await openEditor();
        await expect(editor).toBeVisible();
        const displayedDefault = await editor.inputValue();
        expect(displayedDefault.split(marker)).toHaveLength(2);
        await testInfo.attach('default-prompt-editor', { body: await page.screenshot(), contentType: 'image/png' });
        const defaultSettings = await savePrompt();
        const next = await send('Check the unchanged default.');
        expect(next[0].content.split(marker)).toHaveLength(2);
        expect(next.some(message => message.content.startsWith('<notebook_context>'))).toBe(true);
        expect(defaultSettings.assistantPrompts?.miso).toBeUndefined();

        // An edit followed by restoration also leaves a default session using its default.
        await openEditor();
        await editor.fill(displayedDefault + '\nTemporary edit.');
        await editor.fill(displayedDefault);
        expect((await savePrompt()).assistantPrompts?.miso).toBeUndefined();

        await openEditor();
        const custom = 'You are Miso. Keep this exact custom instruction.\n\nPROMPT-PRESERVATION';
        await editor.fill(custom);
        expect((await savePrompt()).assistantPrompts.miso).toBe(custom);
        await openEditor();
        await expect(editor).toHaveValue(custom);
        expect((await savePrompt()).assistantPrompts.miso).toBe(custom);
        expect((await send('Check the preserved custom.'))[0].content).toContain(custom);

        // Textareas normalise line endings; an unchanged saved prompt keeps its original bytes.
        const source = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });
        const { bucket } = await account.post('/api/scratchpad/bucket', { source });
        const customWithCRLF = custom.replaceAll('\n', '\r\n');
        await account.post('/api/scratchpad/session/update', { source, sessionId: bucket.activeSessionId,
            changes: { settings: { assistantPrompts: { miso: customWithCRLF } } } });
        await openEditor();
        await expect(editor).toHaveValue(custom);
        expect((await savePrompt()).assistantPrompts.miso).toBe(customWithCRLF);

        // Existing custom text remains custom even if it equals the assembled default.
        await openEditor();
        await editor.fill(displayedDefault);
        expect((await savePrompt()).assistantPrompts.miso).toBe(displayedDefault);
        await openEditor();
        expect((await savePrompt()).assistantPrompts.miso).toBe(displayedDefault);

        await openEditor();
        await page.getByRole('button', { name: 'Reset to default', exact: true }).click();
        expect((await savePrompt()).assistantPrompts?.miso).toBeUndefined();
        expect((await send('Check the reset default.'))[0].content.split(marker)).toHaveLength(2);
    });

    test(`${phone ? 'phone' : 'desktop'} Scratchpad prompts can be viewed, saved, sent and reset`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const open = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
            if (phone) await applyIOSOnlyCss(page);
        };
        await open();
        await page.getByRole('button', { name: 'View or edit Miso\'s prompt', exact: true }).click();
        const editor = page.getByRole('textbox', { name: 'Assistant prompt', exact: true });
        await expect(editor).toHaveValue(/You are Miso/);
        await expect(editor).toHaveValue(/"action":"append"/);
        await editor.fill('You are Miso. Answer every question with a short numbered list. PROMPT-TEST');
        await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.locator('.scratchpad-composer').fill('Please compare these ideas.');
        app.provider.mode.streamReply = { first: 'First idea.', rest: ' Second idea.' };
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('First idea.');
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        expect(app.provider.calls.at(-1).messages[0].content).toContain('PROMPT-TEST');
        const reply = page.locator('.scratchpad-message.is-assistant.is-done');
        const actions = reply.locator('.scratchpad-message-actions');
        await expect(actions).toBeHidden();
        const toggle = reply.locator('summary[aria-label="Message actions"]');
        await toggle.click();
        await expect(actions).toBeVisible();
        await expect(actions.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
        const bounds = await toggle.boundingBox();
        const card = await reply.boundingBox();
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.x).toBeGreaterThan(card.x + card.width / 2);
        await toggle.press('Escape');
        await expect(actions).toBeHidden();
        await toggle.click();
        await actions.getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'Edit message', exact: true })).toBeVisible();
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await page.evaluate(async avatar => {
            await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar);
        }, account.avatar);
        await open();
        await page.getByRole('button', { name: 'View or edit Miso\'s prompt', exact: true }).click();
        await expect(editor).toHaveValue(/PROMPT-TEST/);
        await page.getByRole('button', { name: 'Reset to default', exact: true }).click();
        await expect(editor).toHaveValue(/You are Miso/);
        await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
        await page.getByRole('button', { name: 'View or edit Miso\'s prompt', exact: true }).click();
        await expect(editor).not.toHaveValue(/PROMPT-TEST/);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    });
}
