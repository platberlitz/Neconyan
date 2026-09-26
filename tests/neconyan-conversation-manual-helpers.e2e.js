import { expect } from '@playwright/test';
import { MODEL, test } from './neconyan-conversation-durable-fixture.js';

test.describe.configure({ mode: 'default' });
test.setTimeout(180000);

const SCHEDULE = JSON.stringify({ talkativeness: 42, inactivityThresholdMinutes: 90,
    days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(day => [day, [{ time: '09:00-17:00', activity: 'Fixture shift', status: 'dnd' }]])) });

function helperReply(body) {
    const text = JSON.stringify(body.messages || body.prompt || '');
    let content = 'Unexpected fixture request.';
    if (text.includes('You are an editor for')) content = 'Polished fixture reply.';
    else if (text.includes('raw image generation prompt')) content = 'rain on a window, soft light';
    else if (text.includes('short in-character chat caption')) content = 'Durable Nova: Rain suits me.';
    else if (text.includes('You are a schedule generator.')) content = SCHEDULE;
    else if (text.includes('Regenerate the selected Conversation reply')) content = 'Regenerated fixture reply.';
    return { choices: [{ message: { role: 'assistant', content } }] };
}

async function accepted(page, route, click) {
    const response = page.waitForResponse(value => value.url().endsWith(route) && value.request().method() === 'POST');
    await click();
    const value = await response;
    expect(value.status(), await value.text()).toBe(202);
    return (await value.json()).job;
}

async function closeEveryPage(browser, page) {
    await page.close();
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`${viewport} Regenerate and Rewrite finish on the server with no page open and never repeat`, async ({ app, browser }) => {
        const account = await app.account({ phone, settings: { prose_polisher: true } });
        await account.changeStore(store => store.characters[account.threadKey].branches.main.messages.push(
            { id: 'old-reply', role: 'character', name: 'Durable Nova', mes: 'Original reply.', timestamp: 1700000000001 },
            { id: 'later-user', role: 'user', name: 'User', mes: 'Unrelated later message.', timestamp: 1700000000002 },
        ));
        app.provider.mode.reply = helperReply;
        app.provider.mode.hold = MODEL;
        const reply = page => page.locator('.sb-conversation-message[data-message-id="old-reply"]');

        const page = await account.open();
        const regenerate = await accepted(page, '/rewrite/submit', async () => {
            await reply(page).locator('.sb-conversation-more-actions').click();
            await page.locator('[data-sb-conversation-action="regenerate-message"][data-message-id="old-reply"]').click();
        });
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
        await closeEveryPage(browser, page);
        expect((await account.branch()).messages.find(message => message.id === 'old-reply').mes).toBe('Original reply.');
        await app.release();
        await account.settled(regenerate.id);
        let messages = (await account.branch()).messages;
        expect(messages.map(message => [message.id, message.mes])).toEqual([
            ['seed-user', 'Original question.'], ['old-reply', 'Regenerated fixture reply.'], ['later-user', 'Unrelated later message.']]);
        expect(messages[1].extra.regenerated_at).toEqual(expect.any(Number));

        app.provider.mode.hold = MODEL;
        const second = await account.open();
        await expect(reply(second)).toContainText('Regenerated fixture reply.');
        const polish = await accepted(second, '/rewrite/submit', async () => {
            await reply(second).locator('.sb-conversation-more-actions').click();
            await second.locator('[data-sb-conversation-action="polish-character-message"][data-message-id="old-reply"]').click();
        });
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(2);
        await closeEveryPage(browser, second);
        await app.release();
        await account.settled(polish.id);
        messages = (await account.branch()).messages;
        expect(messages.find(message => message.id === 'old-reply').mes).toBe('Polished fixture reply.');

        const reopened = await account.open();
        await expect(reply(reopened)).toContainText('Polished fixture reply.');
        await reopened.waitForTimeout(3000);
        expect((await account.branch()).messages).toEqual(messages);
        expect(app.provider.calls).toHaveLength(2);
    });

    test(`${viewport} Generate schedule completes with no page open and Edit schedule saves on the server`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        app.provider.mode.reply = helperReply;
        app.provider.mode.hold = MODEL;
        const page = await account.open();
        await page.locator('[data-sb-conversation-action="open-settings"]').first().click();
        const job = await accepted(page, '/schedule/submit', () =>
            page.locator('[data-sb-conversation-action="generate-schedule"]').dispatchEvent('click'));
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
        await closeEveryPage(browser, page);
        await app.release();
        await account.settled(job.id);
        let slot = (await account.store()).characters[account.threadKey];
        expect(slot.schedule.days[1]).toEqual([{ time: '09:00-17:00', activity: 'Fixture shift', status: 'dnd' }]);
        expect(slot.settings.talkativeness).toBe(42);
        expect(JSON.parse(slot.settings.auto_schedule).talkativeness).toBe(42);

        const reopened = await account.open();
        await reopened.locator('#sb_conversation_toggle_tools').click();
        await reopened.locator('.sb-conversation-quick-actions [data-sb-conversation-action="edit-schedule"]').click();
        await reopened.locator('.sb-schedule-modal-talkativeness').fill('55');
        const saved = reopened.waitForResponse(value => value.url().endsWith('/schedule/submit'));
        await reopened.locator('.sb-schedule-modal-save').click();
        expect((await saved).status()).toBe(200);
        await expect(reopened.locator('.sb-schedule-modal-save')).toBeHidden();
        slot = (await account.store()).characters[account.threadKey];
        expect(slot.schedule.talkativeness).toBe(55);
        expect(slot.schedule.days[1]).toEqual([{ time: '09:00-17:00', activity: 'Fixture shift', status: 'dnd' }]);
        expect(app.provider.calls).toHaveLength(1);
    });

    test(`${viewport} Selfie posts one image with no page open and reopening does not make another`, async ({ app, browser }) => {
        const images = await app.images();
        const account = await app.account({ phone, configureSettings(saved) {
            saved.extension_settings['quick-image-gen'] = { provider: 'local', localUrl: images.url.replace(/\/v1$/, ''),
                localType: 'stable-diffusion', a1111Model: 'nova.safetensors', sampler: 'euler_a' };
        } });
        app.provider.mode.reply = helperReply;
        app.provider.mode.hold = MODEL;
        const page = await account.open();
        page.once('dialog', dialog => dialog.accept('A rainy window'));
        const job = await accepted(page, '/selfie/submit', async () => {
            await page.locator('#sb_conversation_toggle_tools').click();
            await page.locator('.sb-conversation-quick-actions [data-sb-conversation-action="quick-selfie"]').click();
        });
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
        await closeEveryPage(browser, page);
        await app.release();
        await account.settled(job.id);
        const messages = (await account.branch()).messages;
        const pictures = messages.filter(message => message.extra?.conversation_mode_image);
        expect(pictures).toHaveLength(1);
        expect(pictures[0]).toMatchObject({ role: 'character', mes: 'Rain suits me.' });
        expect(pictures[0].extra.image_prompt).toContain('rain on a window');
        const image = await account.context.request.get(pictures[0].extra.image_url);
        expect((await image.body()).subarray(1, 4).toString()).toBe('PNG');
        expect(JSON.stringify(app.provider.calls[0].messages)).toContain('A rainy window');

        const reopened = await account.open();
        await expect(reopened.locator(`.sb-conversation-message[data-message-id="${pictures[0].id}"] img`).first()).toBeAttached();
        await reopened.waitForTimeout(3000);
        expect((await account.branch()).messages).toEqual(messages);
        expect(app.provider.calls).toHaveLength(2);
        expect(images.calls).toHaveLength(1);
    });
}
