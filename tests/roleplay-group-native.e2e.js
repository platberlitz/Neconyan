/* eslint-env browser */
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acknowledgeActiveSettings, test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(240000);

const ANSWER = 'The group reply was written by the server.';

async function prepare(app, phone, companionCount = 0, companionTrigger = 'manual', stream = false) {
    app.provider.mode.hold = ['conversation-fixture'];
    app.provider.mode.reply = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }] });
    const companions = Array.from({ length: companionCount }, (_, index) => ({ id: `group-note-${index}`,
        name: `Group note ${index}`, enabled: true, category: 'companion', execution: 'companion',
        prompt: 'Write a short note.', companion: { trigger: companionTrigger, includeWorldInfo: false } }));
    for (const companion of companions) {
        await fs.writeFile(path.join(app.directory, 'data/default-user/InChatAgents', `${companion.id}.json`), JSON.stringify(companion));
    }
    const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
        saved.oai_settings.openai_max_context = 8192;
        saved.oai_settings.openai_max_tokens = 256;
        saved.oai_settings.stream_openai = stream;
        saved.power_user.auto_swipe = false;
        saved.power_user.auto_continue = { enabled: false, allow_chat_completions: false, target_length: 400 };
        if (companionCount) {
            saved.extension_settings.inChatAgents = { ...saved.extension_settings.inChatAgents, globalSettings: {
                ...saved.extension_settings.inChatAgents?.globalSettings, enabled: true, hiddenCompanionAgentIds: [],
                separateRecentChats: true, scopedEnabledAgentIdsInitialized: true,
                enabledAgentIdsByChatType: { group: companions.map(companion => companion.id), individual: [] },
            } };
        }
    } });
    const probe = await account.context.request.post('/api/chats/get', { headers: account.headers,
        data: { avatar_url: account.avatar, file_name: 'Group account probe', allow_create: true } });
    expect(probe.ok(), await probe.text()).toBe(true);
    const stamp = JSON.parse(probe.headers()['x-neconyan-roleplay']).account;
    const group = await account.post('/api/groups/create', { name: 'Native Group', members: [account.avatar],
        activation_strategy: 1, roleplay: { account: stamp, operationKey: randomUUID() } });
    const file = path.join(app.directory, 'data/default-user/group chats', `${group.chat_id}.jsonl`);
    return { account, group, file };
}

async function readRows(file) {
    return (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

async function openGroup({ account, group }) {
    const page = await account.open({ workspace: false, readyTimeout: 60000 });
    await page.evaluate(async id => {
        const groups = await import('/scripts/group-chats.js');
        await groups.openGroupById(id);
    }, group.id);
    await expect(page.locator('#send_textarea')).toBeVisible();
    await acknowledgeActiveSettings(page);
    return page;
}

async function closeEveryPage(browser) {
    for (const context of browser.contexts()) {
        for (const open of context.pages()) await open.close();
    }
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
}

for (const [viewport, phone] of [['desktop', false], ['phone', true]]) {
    test(`a dropped group provider connection shows its reason and is not retried on ${viewport}`, async ({ app }) => {
        const setup = await prepare(app, phone, 0, 'manual', true);
        const page = await openGroup(setup);
        app.provider.mode.disconnect = true;
        const accepted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/group/submit') && response.status() === 202);
        await page.locator('#send_textarea').fill('Please answer this group message.');
        await page.locator('#send_textarea').press('Enter');
        const { jobId } = await (await accepted).json();
        await expect.poll(() => app.provider.calls.length).toBe(1);
        await app.release();
        await setup.account.settled(jobId, 'interrupted');
        await expect(page.locator('.toast-error')).toContainText('Reply stopped');
        await expect(page.locator('.toast-error')).toContainText('The connection to your model provider closed before a complete reply was received.');
        await expect(page.locator('.toast-error')).toContainText('not retried automatically');
        await expect.poll(() => page.evaluate(async () => {
            const core = await import('/script.js');
            const groups = await import('/scripts/group-chats.js');
            return core.is_send_press || groups.is_group_generating;
        })).toBe(false);
        await app.restart();
        await delay(1200);
        expect(app.provider.calls).toHaveLength(1);
        expect(app.provider.calls[0].stream).toBe(true);
        expect((await readRows(setup.file)).filter(row => row.is_user)).toHaveLength(1);
        expect((await setup.account.job(jobId)).state).toBe('interrupted');
    });
}

for (const [viewport, phone, raceSettings, companionCount] of [
    ['desktop', false, false, 0], ['phone', true, false, 0], ['phone with a raced settings save', true, true, 0],
    ['desktop with eleven Companions', false, false, 11], ['phone with eleven Companions', true, false, 11],
]) {
    test(`${viewport} group turn finishes on the server after every page closes`, async ({ app, browser }) => {
        const fixture = await prepare(app, phone, companionCount);
        const page = await openGroup(fixture);
        const submissions = [];
        if (raceSettings) {
            await page.route('**/api/roleplay/group/submit', async route => {
                const body = route.request().postDataJSON();
                if (!submissions.length) {
                    // Move the real saved revision after the browser captured its proof.
                    await page.evaluate(async () => {
                        if (!await (await import('/script.js')).saveSettings(0, { returnResult: true })) throw new Error('The racing settings save failed.');
                    });
                }
                const response = await route.fetch();
                submissions.push({ body, status: response.status() });
                await route.fulfill({ response });
            });
        }
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/group/submit') && (!raceSettings || response.status() === 202));
        await page.locator('#send_textarea').fill('Tell the group about the moon.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.status(), await response.text()).toBe(202);
        const accepted = await response.json();
        if (raceSettings) {
            expect(submissions.map(entry => entry.status)).toEqual([409, 202]);
            expect(submissions[1].body).toEqual({ ...submissions[0].body, acknowledgement: submissions[1].body.acknowledgement });
            expect(submissions[1].body.acknowledgement.settingsRevision).toBeGreaterThan(submissions[0].body.acknowledgement.settingsRevision);
        }
        await expect.poll(() => app.provider.calls.length).toBe(1);
        await closeEveryPage(browser);
        await app.release();
        await fixture.account.settled(accepted.jobId);
        const rows = await readRows(fixture.file);
        expect(rows.some(row => row.is_user && row.mes === 'Tell the group about the moon.')).toBe(true);
        expect(rows.at(-1).mes).toBe(ANSWER);
        expect(rows.at(-1).is_user).toBe(false);
        expect(app.provider.calls).toHaveLength(1);
        const reopened = await openGroup(fixture);
        await expect(reopened.locator('#chat .mes').last()).toContainText(ANSWER);
        expect(app.provider.calls).toHaveLength(1);
    });
}

for (const [viewport, phone] of [['desktop', false], ['phone', true]]) {
    test(`${viewport} group reply with eleven Companions appears without reopening the chat`, async ({ app }) => {
        const fixture = await prepare(app, phone, 11);
        const page = await openGroup(fixture);
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/group/submit'));
        await page.locator('#send_textarea').fill('Keep this group chat open while replying.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.status(), await response.text()).toBe(202);
        const accepted = await response.json();
        await expect.poll(() => app.provider.calls.length).toBe(1);
        await expect(page.getByLabel('Reply in progress')).toBeVisible();
        await app.release();
        await fixture.account.settled(accepted.jobId);
        await expect(page.locator('#chat .mes').last()).toContainText(ANSWER);
        await expect(page.getByLabel('Reply in progress')).toHaveCount(0);
        expect((await readRows(fixture.file)).at(-1).mes).toBe(ANSWER);
        expect(app.provider.calls).toHaveLength(1);
    });

    test(`${viewport} group refusal shows the server reason and allows a fresh send without duplicate requests`, async ({ app }) => {
        const fixture = await prepare(app, phone);
        const page = await openGroup(fixture);
        const reason = 'This complete workflow cannot fit inside its protected chat capacity.';
        let refusedRequests = 0;
        await page.route('**/api/roleplay/group/submit', async route => {
            refusedRequests++;
            await route.fulfill({ status: 507, json: { error: reason, code: 'ROLEPLAY_WORKFLOW_CAPACITY' } });
        });
        const refusal = page.waitForResponse(response => response.url().endsWith('/api/roleplay/group/submit'));
        await page.locator('#send_textarea').fill('This question is saved even if the reply is refused.');
        await page.locator('#send_textarea').press('Enter');
        expect((await refusal).status()).toBe(507);
        await expect(page.locator('.toast-error')).toContainText(reason);
        await expect(page.locator('.toast-error .toast-title')).toHaveText('Group reply failed');
        await expect.poll(() => page.evaluate(async () => {
            const core = await import('/script.js');
            const groups = await import('/scripts/group-chats.js');
            return core.is_send_press || groups.is_group_generating;
        })).toBe(false);
        expect(refusedRequests).toBe(1);
        expect(app.provider.calls).toHaveLength(0);
        expect((await readRows(fixture.file)).filter(row => row.is_user)).toHaveLength(1);

        await page.unroute('**/api/roleplay/group/submit');
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/group/submit'));
        await page.locator('#send_textarea').fill('Please answer this new question.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.status(), await response.text()).toBe(202);
        const accepted = await response.json();
        await app.release();
        await fixture.account.settled(accepted.jobId);
        await expect(page.locator('#chat .mes').last()).toContainText(ANSWER);
        const rows = await readRows(fixture.file);
        expect(rows.filter(row => row.is_user)).toHaveLength(2);
        expect(rows.at(-1).mes).toBe(ANSWER);
        expect(app.provider.calls).toHaveLength(1);
    });
}

test('stopping a group submission does not show a late refusal as a new error', async ({ app }) => {
    const fixture = await prepare(app, false);
    const page = await openGroup(fixture);
    let releaseRefusal;
    const held = new Promise(resolve => { releaseRefusal = resolve; });
    await page.route('**/api/roleplay/group/submit', async route => {
        await held;
        await route.fulfill({ status: 507, json: { error: 'The cancelled submission was refused.' } });
    });
    const requested = page.waitForRequest(request => request.url().endsWith('/api/roleplay/group/submit'));
    const response = page.waitForResponse(result => result.url().endsWith('/api/roleplay/group/submit'));
    await page.locator('#send_textarea').fill('Stop before the refusal returns.');
    await page.locator('#send_textarea').press('Enter');
    await requested;
    expect(await page.evaluate(async () => (await import('/script.js')).stopGeneration())).toBe(true);
    releaseRefusal();
    expect((await response).status()).toBe(507);
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/group-chats.js')).is_group_generating)).toBe(false);
    await expect(page.locator('.toast-error')).toHaveCount(0);
    expect(app.provider.calls).toHaveLength(0);
    expect((await readRows(fixture.file)).filter(row => row.is_user)).toHaveLength(1);
});

test('a native group reply runs its automatic Companion once, not again in the browser', async ({ app }) => {
    const fixture = await prepare(app, false, 1, 'auto');
    const page = await openGroup(fixture);
    const browserGenerations = [];
    page.on('request', request => {
        if (request.url().endsWith('/api/backends/chat-completions/generate')) browserGenerations.push(request.url());
    });
    const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/group/submit'));
    await page.locator('#send_textarea').fill('Write one reply and one Companion note.');
    await page.locator('#send_textarea').press('Enter');
    const response = await submitted;
    expect(response.status(), await response.text()).toBe(202);
    const accepted = await response.json();
    await app.release();
    await fixture.account.settled(accepted.jobId);
    await expect(page.locator('#chat .mes').last()).toContainText(ANSWER);
    // Cross the normal post-generation recovery window, which must not rerun saved server work.
    await delay(7200);
    expect(browserGenerations).toHaveLength(0);
    expect(app.provider.calls).toHaveLength(2);
});
