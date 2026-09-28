/* eslint-env browser */
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { acknowledgeActiveSettings, test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(240000);

const ANSWER = 'The group reply was written by the server.';

async function prepare(app, phone) {
    app.provider.mode.hold = ['conversation-fixture'];
    app.provider.mode.reply = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }] });
    const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
        saved.oai_settings.openai_max_context = 8192;
        saved.oai_settings.openai_max_tokens = 256;
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

for (const [viewport, phone, raceSettings] of [['desktop', false, false], ['phone', true, false], ['phone with a raced settings save', true, true]]) {
    test(`${viewport} group turn finishes on the server after every page closes`, async ({ app, browser }) => {
        const fixture = await prepare(app, phone);
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
