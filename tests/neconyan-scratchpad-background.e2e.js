import { expect } from '@playwright/test';
import { MODEL, test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const stream of [true, false]) {
    test(`phone replies finish on the server with streaming ${stream ? 'on' : 'off'} while the page is frozen or closed`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone: true, contextOptions: IPHONE_SAFARI_CONTEXT,
            configureSettings: saved => { saved.oai_settings.show_thoughts = true; } });
        await installIPhoneSafari(account.context, { standalone: true });
        let page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
        await applyIOSOnlyCss(page);
        await page.getByRole('checkbox', { name: 'Stream replies' }).setChecked(stream);
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        const source = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });

        for (const away of ['frozen', 'closed']) {
            const thinking = `The server kept thinking while the page was ${away}.`;
            const answer = `The server finished while the page was ${away}.`;
            if (stream) app.provider.mode.streamReply = { reasoning: thinking, first: 'The server ', rest: answer.slice('The server '.length) };
            else {
                app.provider.mode.hold = MODEL;
                app.provider.mode.reply = { choices: [{ message: { content: answer, reasoning_content: thinking } }] };
            }
            const question = `Keep working while this page is ${away}.`;
            await page.locator('.scratchpad-composer').fill(question);
            const accepted = page.waitForResponse('**/api/scratchpad/send');
            await page.locator('.scratchpad-send').click();
            const response = await accepted;
            expect(response.ok(), await response.text()).toBe(true);
            const jobId = (await response.json()).job.id;
            await expect.poll(() => app.provider.calls.find(call => call.messages?.at(-1)?.content === question)?.stream).toBe(stream);
            if (stream) await expect(page.locator('.scratchpad-stream')).toHaveText('The server ');

            // App navigation stops the preview subscriber, never the server reply.
            await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
            await expect(page.locator('#neconyan-scratchpad')).toBeHidden();
            let lifecycle;
            let otherTab;
            if (away === 'frozen') {
                otherTab = await account.context.newPage();
                await otherTab.goto('about:blank');
                await otherTab.bringToFront();
                lifecycle = await account.context.newCDPSession(page);
                await lifecycle.send('Page.setWebLifecycleState', { state: 'frozen' });
            } else await page.close();

            if (stream) app.provider.mode.finishStream();
            else await app.release();
            await account.settled(jobId);
            const saved = (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].messages.at(-1);
            expect(saved).toMatchObject({ state: 'done', text: answer, reasoning: thinking, jobId });
            expect(saved).not.toHaveProperty('error');

            if (away === 'frozen') {
                await lifecycle.send('Page.setWebLifecycleState', { state: 'active' });
                await lifecycle.detach();
                await otherTab.close();
                await page.bringToFront();
            } else page = await account.open();
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
            await applyIOSOnlyCss(page);
            await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
            await expect(page.locator('.scratchpad-reply').last()).toHaveText(answer);
            await expect(page.locator('.scratchpad-reasoning .scratchpad-plain').last()).toHaveText(thinking);
            expect(app.provider.calls.filter(call => call.messages?.at(-1)?.content === question)).toHaveLength(1);
        }
    });
}
