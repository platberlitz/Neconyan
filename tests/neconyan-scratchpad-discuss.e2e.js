/* global document, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const REQUEST = 'Read each other\'s answers to my last message. Say where you agree, where you disagree and why, and what you would now change in your own answer.';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} round-table assistants discuss each other's answers`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings: saved => {
            const profiles = saved.extension_settings.connectionManager.profiles;
            for (const id of ['miso', 'taro', 'nori']) profiles.push({ ...profiles[0], id: `discuss-${id}`, name: id, model: `discuss-${id}` });
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(page.locator('.scratchpad-composer')).toBeEnabled();
        if (phone) await applyIOSOnlyCss(page);
        const prefix = `../screenshots/scratchpad-discuss/${phone ? 'phone' : 'desktop'}`;

        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        for (const id of ['miso', 'taro', 'nori']) await page.locator(`#scratchpad-connection-${id}`).selectOption(`discuss-${id}`);
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.locator('.scratchpad-round-table').click();
        await expect(page.locator('.scratchpad-send')).toHaveAccessibleName('Ask 3');
        await page.locator('.scratchpad-assistants').getByRole('button', { name: 'Nori', exact: true }).click();
        await expect(page.locator('.scratchpad-send')).toHaveAccessibleName('Ask 2');

        const discuss = page.locator('.scratchpad-discuss');
        await expect(discuss).toHaveCount(0);

        let round = 0;
        app.provider.mode.streamReply = body => ({ first: `${body.model} round ${round}`, rest: ' is done.' });
        const ask = async (click, last) => {
            round += 1;
            const sent = page.waitForResponse('**/api/scratchpad/send');
            await click();
            const response = await sent;
            expect(response.ok(), await response.text()).toBe(true);
            await expect(page.locator('.scratchpad-stream')).toHaveCount(2);
            // No discussion can start while this round is still being written.
            await expect(discuss).toHaveCount(0);
            await expect.poll(() => app.provider.calls.filter(call => call.messages?.at(-1)?.content === last).length).toBe(2);
            const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === last);
            expect(calls.map(call => call.model).sort()).toEqual(['discuss-miso', 'discuss-taro']);
            for (const call of calls) call.finishStream();
            await account.settled((await response.json()).job.id);
            await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
            await expect(page.locator('.scratchpad-send')).toBeEnabled();
            return { calls, body: response.request().postDataJSON() };
        };

        await page.locator('.scratchpad-composer').fill('How should the heist begin?');
        await ask(() => page.locator('.scratchpad-send').click(), 'How should the heist begin?');
        await expect(page.locator('.scratchpad-message.is-assistant')).toHaveCount(2);

        await expect(discuss).toHaveCount(1);
        await expect(discuss).toBeEnabled();
        await expect(discuss).toHaveAccessibleName('Discuss these answers');
        await discuss.scrollIntoViewIfNeeded();
        const box = await discuss.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await page.screenshot({ path: `${prefix}-button.png` });

        // What is typed in the box goes along as the point to focus on.
        await page.locator('.scratchpad-composer').fill('  Focus on the getaway.  ');
        const text = `${REQUEST}\n\nFocus on the getaway.`;
        const { calls, body } = await ask(() => discuss.click(), text);
        expect(body.discuss).toBe(true);
        expect(body.text).toBe(text);
        for (const [mine, peer, name] of [['miso', 'taro', 'Taro'], ['taro', 'miso', 'Miso']]) {
            const messages = calls.find(call => call.model === `discuss-${mine}`).messages;
            const peerAnswer = messages.find(message => message.role === 'user' && message.content.startsWith(`[Earlier reply from ${name} in Scratchpad]`));
            expect(peerAnswer?.content).toContain(`discuss-${peer} round 1 is done.`);
            expect(messages.some(message => message.role === 'assistant' && message.content === `discuss-${mine} round 1 is done.`)).toBe(true);
        }
        await expect(page.locator('.scratchpad-composer')).toHaveValue('');
        await expect(page.locator('.scratchpad-message.is-user')).toHaveCount(2);
        await expect(page.locator('.scratchpad-message.is-user').nth(1)).toContainText('Focus on the getaway.');
        const replies = page.locator('.scratchpad-message.is-assistant');
        await expect(replies).toHaveCount(4);
        await expect(replies.filter({ hasText: 'round 2 is done.' })).toHaveCount(2);
        // The new answers can be discussed in turn.
        await expect(discuss).toHaveCount(1);
        await discuss.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${prefix}-discussed.png` });

        // Random asks one assistant, so there is nothing to compare.
        await page.locator('.scratchpad-random').click();
        await expect(page.locator('.scratchpad-random')).toHaveAttribute('aria-pressed', 'true');
        await expect(discuss).toHaveCount(0);
        await page.locator('.scratchpad-random').click();
        await expect(discuss).toHaveCount(1);

        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                const contrast = await discuss.evaluate(async element => {
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
                expect(contrast, `${theme} ${accent ?? 'default'}`).toBeGreaterThanOrEqual(4.5);
            }
        }
    });
}
