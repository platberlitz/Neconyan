/* global document */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect */
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { checkImageControlContrast } from './scratchpad-image-contrast-helpers.js';

async function open(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeVisible();
    return page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
}

async function seed(account) {
    let page = await account.open();
    const source = await open(page);
    await account.post('/api/scratchpad/session/import', { source, session: {
        name: 'Scene ideas', assistant: 'miso', settings: { connection: { kind: 'profile', profileId: 'durable' } },
        messages: [{ role: 'user', text: 'Suggest a quiet opening for the garden scene.' },
            { role: 'assistant', assistant: 'miso', assistantName: 'Miso', text: 'Start with the garden gate left open. Nova notices the fresh footprints before anyone speaks.' }],
    } });
    await page.close();
    page = await account.open();
    await open(page);
    await expect(page.locator('.scratchpad-reply')).toBeVisible();
    return { page, source };
}

async function finish(app, account, response) {
    expect(response.ok(), await response.text()).toBe(true);
    const result = await response.json();
    await expect.poll(() => Boolean(app.provider.calls.at(-1)?.finishStream)).toBe(true);
    app.provider.calls.at(-1).finishStream();
    await account.settled(result.job.id);
}

async function swipe(page, direction) {
    const box = await page.locator('.scratchpad-text').last().boundingBox();
    const client = await page.context().newCDPSession(page);
    const x = box.x + (direction === 'left' ? box.width - 12 : 12);
    const y = box.y + Math.min(box.height / 2, 20);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 6; i++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (direction === 'left' ? -1 : 1) * i * 14, y }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await client.detach();
}

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} reply versions survive regeneration, switching and reopening`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        let { page, source } = await seed(account);
        if (phone) await applyIOSOnlyCss(page);
        const original = await page.locator('.scratchpad-reply').textContent();
        app.provider.mode.streamReply = { first: 'Another opening: ', rest: 'Nova finds a letter beneath the gate.' };
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.getByRole('button', { name: 'Generate another reply', exact: true }).click();
        const response = await accepted;
        await expect(page.locator('.scratchpad-swipe-count')).toHaveText('2 of 2');
        await expect(page.getByRole('button', { name: 'Previous reply', exact: true })).toBeDisabled();
        await finish(app, account, response);
        await expect(page.locator('.scratchpad-reply')).toContainText('Nova finds a letter');
        await page.getByRole('button', { name: 'Previous reply', exact: true }).click();
        await expect(page.locator('.scratchpad-reply')).toHaveText(original);
        await expect(page.locator('.scratchpad-swipe-count')).toHaveText('1 of 2');
        await page.getByRole('button', { name: 'Next reply', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.scratchpad-reply')).toContainText('Nova finds a letter');
        if (phone) {
            await swipe(page, 'right');
            await expect(page.locator('.scratchpad-swipe-count')).toHaveText('1 of 2');
            await swipe(page, 'left');
            await expect(page.locator('.scratchpad-swipe-count')).toHaveText('2 of 2');
        }
        const sizes = await page.locator('.scratchpad-reply-swipes button').evaluateAll(buttons => buttons.map(button => {
            const rect = button.getBoundingClientRect();
            return Math.min(rect.width, rect.height);
        }));
        expect(Math.min(...sizes)).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await fs.mkdir('../screenshots', { recursive: true });
        await page.screenshot({ path: `../screenshots/scratchpad-swipes-${phone ? 'phone' : 'desktop'}-after.png` });
        await page.close();
        page = await account.open();
        await open(page);
        await expect(page.locator('.scratchpad-swipe-count')).toHaveText('2 of 2');
        const saved = (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0];
        expect(saved.messages).toHaveLength(2);
        expect(saved.messages[1].swipes[0].text).toContain('garden gate left open');
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        const prefill = page.getByLabel('Reply prefill', { exact: true });
        await prefill.fill('Opening: ');
        await prefill.press('Tab');
        const partial = page.locator('#neconyan-scratchpad').getByLabel('Kimi K3 / K3.1 partial prefill', { exact: true });
        await partial.fill('<think>Consider the scene.</think>Opening: ');
        await partial.press('Tab');
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].settings.partialPrefill).toBe('<think>Consider the scene.</think>Opening: ');
        await page.locator('.scratchpad-section').filter({ has: page.locator('#scratchpad-prefill') }).evaluate(section => section.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: `../screenshots/scratchpad-prefills-${phone ? 'phone' : 'desktop'}-after.png` });
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await checkImageControlContrast(page, ['.scratchpad-reply-swipes button:not(:disabled)'], phone);
    });
}

for (const [model, thinkingOnly] of [['kimi-k3', false], ['moonshotai/kimi-k3.1-pro', false], ['ordinary-model', false], ['kimi-k3.1', true]]) {
    test(`${model}${thinkingOnly ? ' thinking-only' : ''} sends the correct trailing prefill and saves only visible text`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ configureSettings: settings => { settings.extension_settings.connectionManager.profiles[0].model = model; } });
        const { page, source } = await seed(account);
        const session = (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0];
        await account.post('/api/scratchpad/session/update', { source, sessionId: session.id, changes: { settings: {
            prefill: 'Ordinary: ', partialPrefill: `<think>Consider {{char}} carefully.${thinkingOnly ? '' : '</think>Opening: '}`,
        } } });
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await open(page);
        app.provider.mode.streamReply = { first: 'Nova notices ', rest: 'the letter.', reasoning: 'New thinking.' };
        await page.locator('.scratchpad-composer').fill('What happens next?');
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        await expect.poll(() => Boolean(app.provider.calls.at(-1)?.finishStream)).toBe(true);
        const trailing = app.provider.calls.at(-1).messages.at(-1);
        if (model.includes('kimi-k3')) {
            expect(trailing.partial).toBe(true);
            expect(trailing.reasoning_content).toBe('Consider Miso carefully.');
            expect(trailing.content).toBe(thinkingOnly ? '' : 'Opening: ');
        } else {
            expect(trailing.content).toBe('Ordinary: ');
            expect(trailing.reasoning_content).toBeUndefined();
        }
        const prefix = thinkingOnly ? '' : `${model.includes('kimi-k3') ? 'Opening' : 'Ordinary'}: `;
        await expect(page.locator('.scratchpad-stream')).toHaveText(`${prefix}Nova notices `);
        await finish(app, account, response);
        const reply = (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].messages.at(-1);
        expect(reply.text).toBe(`${prefix}Nova notices the letter.`);
        expect(reply.reasoning).toBe('New thinking.');
    });
}
