/* global window */
/* eslint-disable playwright/no-conditional-in-test -- The same checks cover phone and desktop. */
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test as base } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

// Keep the standard account startup limits separate from each interaction check.
const test = base.extend({
    readyAccount: [async ({ app }, use, testInfo) => {
        const phone = testInfo.title.startsWith('phone');
        const ios = testInfo.title.includes('gestures');
        const account = await app.account({ phone, contextOptions: ios ? IPHONE_SAFARI_CONTEXT : {} });
        if (ios) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await use({ account, page });
    }, { timeout: 120000 }],
});

const question = 'Suggest a quiet opening for the garden scene.';
const answer = 'Start with the garden gate left open. Nova notices the fresh footprints before anyone speaks.';
const warning = 'No persona is selected. Pick one in Personas if you want General Scratchpad to use it.';

async function open(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeVisible();
    return page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
}

async function picture(page, name, phone) {
    await fs.mkdir('../screenshots', { recursive: true });
    await page.screenshot({ path: `../screenshots/scratchpad-${name}-${phone ? 'phone' : 'desktop'}-${process.env.NECONYAN_SCRATCHPAD_SCREENSHOT_LABEL || 'after'}.png`,
        style: '#toast-container > :not(.toast-warning) { visibility: hidden; }' });
}

async function seed(account, page) {
    const source = await open(page);
    await account.post('/api/scratchpad/session/import', { source, session: {
        name: 'Garden ideas', assistant: 'miso', settings: { connection: { kind: 'profile', profileId: 'durable' } },
        messages: [{ role: 'user', text: question }, { role: 'assistant', assistant: 'miso', assistantName: 'Miso', text: answer }],
    } });
    await open(page);
    await expect(page.locator('.scratchpad-reply')).toHaveText(answer);
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
    if (page.context().browser().browserType().name() !== 'chromium') {
        // Playwright has no native drag-touch API for WebKit. Exercise the real listeners there.
        await page.locator('.scratchpad-text').last().evaluate((element, direction) => {
            const dispatch = (type, x) => {
                const event = new Event(type, { bubbles: true, cancelable: true });
                const point = { clientX: x, clientY: 100 };
                Object.assign(event, { touches: type === 'touchend' ? [] : [point], changedTouches: [point] });
                element.dispatchEvent(event);
            };
            dispatch('touchstart', 160);
            dispatch('touchmove', 160 + direction * 84);
            dispatch('touchend', 160 + direction * 84);
        }, direction);
        return;
    }
    const box = await page.locator('.scratchpad-text').last().boundingBox();
    const client = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2;
    const y = box.y + Math.min(box.height / 2, 20);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 6; i++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + direction * i * 14, y }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await client.detach();
}

for (const phone of [true, false]) {
    test(`${phone ? 'phone' : 'desktop'} General Scratchpad warns once per visit when no persona is selected`, async ({ readyAccount }) => {
        const { page } = readyAccount;
        await page.evaluate(async () => {
            // Startup creates the fallback User persona; remove it to represent an unequipped persona.
            const { power_user } = await import('/scripts/power-user.js');
            power_user.personas = {};
            power_user.default_persona = '';
            window.toastr.clear();
        });
        const source = await open(page);
        expect(source.kind).toBe('general');
        await picture(page, 'no-persona', phone);
        const toast = page.locator('.toast-warning').filter({ hasText: warning });
        await expect(toast).toHaveCount(1);
        await page.evaluate(() => {
            window.dispatchEvent(new Event('neconyan:navigate-home'));
            window.dispatchEvent(new Event('neconyan:navigate-home'));
        });
        await expect(toast).toHaveCount(1);
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            const { user_avatar } = await import('/script.js');
            power_user.personas[user_avatar] = 'Garden writer';
            power_user.default_persona = user_avatar;
            window.toastr.clear();
            (await import('/scripts/scratchpad/index.js')).hideScratchpad();
        });
        await open(page);
        await expect(toast).toHaveCount(0);
    });

    test(`${phone ? 'phone' : 'desktop'} empty Send answers the remaining user message without duplicating it`, async ({ app, readyAccount }) => {
        const { account, page } = readyAccount;
        const { source } = await seed(account, page);
        const original = (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].messages[0];
        await page.locator('.scratchpad-message.is-assistant summary[aria-label="Message actions"]').click();
        await page.locator('.scratchpad-message.is-assistant').getByRole('button', { name: 'Delete', exact: true }).click();
        await page.locator('dialog.popup').getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(page.locator('.scratchpad-message')).toHaveCount(1);
        await expect(page.locator('.scratchpad-composer')).toHaveValue('');
        await page.evaluate(() => window.toastr.clear());
        await expect(page.locator('#ica--tracker-panel-handle')).toBeHidden();
        await picture(page, 'reply-deleted', phone);
        app.provider.mode.streamReply = { first: 'Another opening: ', rest: 'Nova finds a letter beneath the gate.' };
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        await finish(app, account, await accepted);
        await expect(page.locator('.scratchpad-reply')).toContainText('Nova finds a letter');
        const saved = (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0];
        expect(saved.messages).toHaveLength(2);
        expect(saved.messages[0]).toEqual(original);
        expect(app.provider.calls.at(-1).messages.filter(message => message.role === 'user' && message.content === question)).toHaveLength(1);
        await picture(page, 'empty-send', phone);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        await expect(page.locator('#ica--tracker-panel-handle')).toBeVisible();
    });
}

test('phone gestures generate a new reply and browse both saved versions', async ({ app, readyAccount }) => {
    const { account, page } = readyAccount;
    const { source } = await seed(account, page);
    await applyIOSOnlyCss(page);
    await page.evaluate(() => window.toastr.clear());
    await picture(page, 'gestures', true);
    app.provider.mode.streamReply = { first: 'Another opening: ', rest: 'Nova finds a letter beneath the gate.' };
    const accepted = page.waitForResponse('**/api/scratchpad/send');
    await swipe(page, -1);
    await finish(app, account, await accepted);
    await expect(page.locator('.scratchpad-swipe-count')).toHaveText('2 of 2');
    await swipe(page, 1);
    await expect(page.locator('.scratchpad-reply')).toHaveText(answer);
    await swipe(page, -1);
    await expect(page.locator('.scratchpad-reply')).toContainText('Nova finds a letter');
    expect(app.provider.calls).toHaveLength(1);
    expect((await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].messages).toHaveLength(2);
    await picture(page, 'gestures', true);
});
