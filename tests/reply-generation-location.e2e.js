/* global window */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test, MODEL } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

const ANSWER = 'The server wrote this reply.';
const REGENERATED = 'The server wrote a replacement.';
const BACKGROUND_ANSWER = 'A server reply that outlives the page.';

async function openChat(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    await acknowledgeActiveSettings(page);
    return page;
}

async function chooseReplies(page, value) {
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    await page.locator('#sb-settings-tabs .sb-settings-tab-btn').filter({ hasText: 'Chat & Writing' }).click();
    const select = page.locator('#reply_generation_location');
    if (!(await select.isVisible())) await page.locator('#ChatCharactersSection > .inline-drawer-header').click();
    await expect(select).toBeVisible();
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save')
        && response.request().postDataJSON()?.power_user?.reply_generation_location === value);
    await select.selectOption(value);
    expect((await saved).ok()).toBe(true);
}

async function sendToServer(page, text) {
    const submission = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_textarea').press('Enter');
    const accepted = await submission;
    expect(accepted.ok(), await accepted.text()).toBe(true);
    return (await accepted.json()).jobId;
}

async function createGroup(account) {
    const created = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: 'Durable Kit', description: 'A second speaker.', first_mes: 'Hello from Kit.' } });
    expect(created.ok(), await created.text()).toBe(true);
    const second = await created.text();
    const probe = await account.context.request.post('/api/chats/get', { headers: account.headers,
        data: { avatar_url: account.avatar, file_name: 'Group preference probe', allow_create: true } });
    expect(probe.ok(), await probe.text()).toBe(true);
    const stamp = JSON.parse(probe.headers()['x-neconyan-roleplay']).account;
    return account.post('/api/groups/create', { name: 'Server group', members: [account.avatar, second],
        activation_strategy: 1, roleplay: { account: stamp, operationKey: randomUUID() } });
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`${viewport} browser is the default, and a saved server choice survives reload`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true,
            contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context);
        const page = await openChat(account);
        if (phone) await applyIOSOnlyCss(page);

        const preference = () => page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.reply_generation_location);
        await expect.poll(preference).toBe('browser');
        await expect(page.locator('#reply_generation_location')).toHaveValue('browser');

        await chooseReplies(page, 'server');
        expect(await preference()).toBe('server');
        await page.close();

        const reopened = await openChat(account);
        if (phone) await applyIOSOnlyCss(reopened);
        await expect.poll(() => reopened.evaluate(async () => (await import('/scripts/power-user.js')).power_user.reply_generation_location)).toBe('server');
        await expect(reopened.locator('#reply_generation_location')).toHaveValue('server');

        const browserRequests = [];
        reopened.on('request', request => {
            if (request.url().endsWith('/api/backends/chat-completions/generate')) browserRequests.push(request.url());
        });
        app.provider.mode.reply = { choices: [{ message: { content: ANSWER } }] };
        const jobId = await sendToServer(reopened, 'Write this one on the server.');
        await account.settled(jobId);
        const lastText = reopened.locator('#chat .mes[mesid]').last().locator('.mes_text');
        await expect(lastText).toHaveText(ANSWER);
        expect(browserRequests).toEqual([]);
        expect(app.provider.calls).toHaveLength(1);

        app.provider.mode.reply = { choices: [{ message: { content: REGENERATED } }] };
        const replacement = reopened.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
        await reopened.evaluate(async () => {
            const core = await import('/script.js');
            void core.Generate('regenerate');
        });
        const accepted = await replacement;
        expect(accepted.ok(), await accepted.text()).toBe(true);
        await account.settled((await accepted.json()).jobId);
        await expect(lastText).toHaveText(REGENERATED);
        expect(browserRequests).toEqual([]);
        expect(app.provider.calls).toHaveLength(2);
    });
}

test('a server reply keeps writing after the page closes, and Stop cancels the next one', async ({ app }) => {
    const account = await app.account({ activeConnection: true, configureSettings(saved) {
        saved.power_user.reply_generation_location = 'server';
    } });
    app.provider.mode.reply = { choices: [{ message: { content: BACKGROUND_ANSWER } }] };
    app.provider.mode.hold = MODEL;
    const page = await openChat(account);

    const jobId = await sendToServer(page, 'Keep writing after I close this page.');
    await expect.poll(() => app.provider.calls.length).toBe(1);
    await page.close();
    await app.release();
    await account.settled(jobId);

    const reopened = await openChat(account);
    await expect(reopened.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(BACKGROUND_ANSWER);
    expect(app.provider.calls).toHaveLength(1);

    app.provider.mode.reply = { choices: [{ message: { content: 'The stopped reply should not land.' } }] };
    app.provider.mode.hold = MODEL;
    const stoppedId = await sendToServer(reopened, 'Start one, then stop it.');
    await expect.poll(() => app.provider.calls.length).toBe(2);
    await reopened.evaluate(async () => (await import('/script.js')).stopGeneration());
    await account.settled(stoppedId, 'cancelled');
    await app.release();
    await expect.poll(() => reopened.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
    await expect(reopened.locator('#chat .mes[mesid]').last().locator('.mes_text')).not.toHaveText('The stopped reply should not land.');
    expect(app.provider.calls).toHaveLength(2);
});

test('changing the reply location during a server reply keeps the reply and its Agent result', async ({ app }) => {
    app.provider.mode.hold = MODEL;
    app.provider.mode.reply = body => ({ choices: [{ message: { content: body.model === MODEL ? ANSWER : 'The Agent rewrite landed.' } }] });
    const account = await app.account({ activeConnection: true, configureSettings(saved) {
        saved.power_user.reply_generation_location = 'server';
        saved.extension_settings.connectionManager.profiles.push(
            { id: 'post', name: 'Post Gen fixture', api: 'custom', mode: 'cc', model: 'post-held', 'api-url': app.provider.url });
        saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
            connectionProfile: 'post' } };
    } });
    const directory = path.join(app.dataRoot, 'default-user', 'InChatAgents');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'post.json'), JSON.stringify({ id: 'post', name: 'Post Gen', enabled: true,
        phase: 'post', prompt: 'Revise the reply.', connectionProfile: 'post',
        postProcess: { enabled: false, promptTransformEnabled: true } }));
    const page = await openChat(account);

    const jobId = await sendToServer(page, 'Change the setting while this reply runs.');
    await expect.poll(() => app.provider.calls.length).toBe(1);
    await chooseReplies(page, 'browser');
    await app.release();
    const job = await account.settled(jobId);
    await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toContainText('The Agent rewrite landed.');
    expect(job.state).toBe('completed');
    expect(app.provider.calls).toHaveLength(2);
    expect(app.provider.calls.filter(call => call.model === 'post-held')).toHaveLength(1);
    expect(await page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.reply_generation_location)).toBe('browser');
});

test('ordinary group replies follow the saved server choice', async ({ app }) => {
    const account = await app.account({ activeConnection: true, configureSettings(saved) {
        saved.power_user.reply_generation_location = 'server';
        // Group server turns cannot carry page prompts; keep the fixture's prompt page empty.
        saved.extension_settings.disabledExtensions = [...new Set([...(saved.extension_settings.disabledExtensions ?? []),
            'third-party/sillytavern-character-colors'])];
    } });
    const group = await createGroup(account);
    app.provider.mode.reply = { choices: [{ message: { content: ANSWER } }] };
    const page = await account.open({ workspace: false });
    await page.evaluate(async id => { await (await import('/scripts/group-chats.js')).openGroupById(id); }, group.id);
    await acknowledgeActiveSettings(page);
    const browserRequests = [];
    page.on('request', request => {
        if (request.url().endsWith('/api/backends/chat-completions/generate')) browserRequests.push(request.url());
    });

    const submission = page.waitForResponse(response => response.url().endsWith('/api/roleplay/group/submit') && response.status() !== 409);
    await page.locator('#send_textarea').fill('Write this group turn on the server.');
    await page.locator('#send_textarea').press('Enter');
    const accepted = await submission;
    expect(accepted.ok(), await accepted.text()).toBe(true);
    await account.settled((await accepted.json()).jobId);
    await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(ANSWER);
    expect(browserRequests).toEqual([]);
    expect(app.provider.calls).toHaveLength(1);
});
