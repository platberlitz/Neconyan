/* global window, document, getComputedStyle */
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from './neconyan-conversation-durable-fixture.js';
import { setConfigFilePath } from '../src/util.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { roleplayAccountStamp } = await import('../src/roleplay-store.js');
const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { captureGenerationBinding } = await import('../src/generation/profiles.js');
const { getSettingsRevision } = await import('../src/settings-version.js');
const { captureRoleplayWorkflowRequest, admitRoleplayWorkflowJob } = await import('../src/generation/roleplay-workflow.js');
const { releaseJob } = await import('../src/jobs/store.js');

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(240000);

function owned(app) {
    const owner = 'default-user';
    const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE)
        .map(([key, relative]) => [key, path.join(app.directory, 'data', owner, relative)]));
    const base = { owner, directories };
    const { accountId, dataEpoch } = roleplayAccountStamp(base);
    return { base, account: { accountId, dataEpoch }, directories, scope: { ...base, accountId, dataEpoch } };
}

async function savedChat(account, name) {
    const fields = { avatar_url: account.avatar, file_name: name };
    const source = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
    expect(source.ok(), await source.text()).toBe(true);
    const vacancy = JSON.parse(source.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/save', { ...fields, chat: [
        { user_name: 'User', character_name: 'Durable Nova', chat_metadata: { stage8: true } },
        { name: 'Durable Nova', is_user: false, mes: 'Retained answer.', extra: {},
            swipes: ['Retained answer.', 'Retained alternative.'], swipe_id: 0 },
        { name: 'User', is_user: true, mes: 'Please answer this question.', extra: {} },
    ], roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    return { group: false, avatar: account.avatar, chat: name };
}

async function noPages(browser) {
    for (const context of browser.contexts()) for (const page of context.pages()) await page.close();
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} progressive replies retain rejected swipes and complete with no page after a serving-process restart`, async ({ app, browser }, info) => {
        app.provider.mode.reply = body => {
            const history = JSON.stringify(body.messages ?? []);
            const text = history.includes('Generate an alternative reply')
                ? 'The saved final answer is complete, selected, and durable.' : 'Short';
            return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] };
        };
        const account = await app.account({ phone, activeConnection: true, configureSettings: settings => {
            settings.power_user.auto_swipe = true;
            settings.power_user.auto_swipe_minimum_length = 15;
        } });
        await account.open({ workspace: false });
        await noPages(browser);
        const native = owned(app);
        const locator = await savedChat(account, `Stage8 ${viewport} progression`);
        const source = captureRoleplaySource(native.scope, { locator });
        const settings = JSON.parse(fs.readFileSync(path.join(native.directories.root, 'settings.json'), 'utf8'));
        const binding = captureGenerationBinding(native.directories, { kind: 'active' },
            { settingsRevision: getSettingsRevision(settings) });
        const request = captureRoleplayWorkflowRequest(native.base, native.account, source,
            { avatar: account.avatar, binding, maxTokens: 128, effect: 'append' });
        const operationKey = `stage8-${viewport}-${randomUUID()}`;
        const admitted = admitRoleplayWorkflowJob(native.base, native.account, { operationKey, source, request });
        releaseJob(native.directories, admitted.jobId);
        const result = await account.settled(admitted.jobId);
        expect(result.result.result.status).toBe('completed');
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        const records = readRoleplayChat(native.scope, locator).records;
        expect(records[1].swipes).toEqual(['Retained answer.', 'Retained alternative.']);
        expect(records.at(-1).swipes).toEqual(['Short', 'The saved final answer is complete, selected, and durable.']);
        expect(records.at(-1).swipe_id).toBe(1);
        const paid = app.provider.calls.length;
        await app.restart();
        expect(app.processes[0].signal).toBe('SIGKILL');
        const page = await account.open({ workspace: false });
        await page.evaluate(async ({ avatar, chatName }) => {
            const context = window.SillyTavern.getContext();
            const core = await import('/script.js');
            await context.getCharacters();
            await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            await core.openCharacterChat(chatName);
        }, { avatar: account.avatar, chatName: locator.chat });
        await expect(page.locator('#chat .mes').last()).toContainText('The saved final answer');
        const geometry = await page.locator('#send_textarea').evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width, viewport: window.innerWidth,
                fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
                overflow: document.documentElement.scrollWidth > window.innerWidth };
        });
        expect(geometry.width).toBeGreaterThan(100);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
        expect(geometry.fontSize).toBeGreaterThanOrEqual(14);
        expect(geometry.overflow).toBe(false);
        expect(app.provider.calls).toHaveLength(paid);
        await page.screenshot({ path: info.outputPath('retained-progressive-reply.png') });
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
    });

    test(`${viewport} two saved group speakers complete in order with no page and reopen after a restart`, async ({ app, browser }, info) => {
        app.provider.mode.reply = body => {
            const prompt = JSON.stringify(body.messages ?? []);
            const text = prompt.includes('write only as Durable Kit') ? 'Kit answers after Nova.' : 'Nova answers the group.';
            return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] };
        };
        const account = await app.account({ phone, activeConnection: true });
        const second = await account.context.request.post('/api/characters/create', { headers: account.headers,
            data: { ch_name: 'Durable Kit', description: 'The second protected speaker.', first_mes: 'Hello.' } });
        expect(second.ok()).toBe(true);
        const otherAvatar = await second.text();
        const name = `Stage8 group ${viewport}`;
        const group = await account.post('/api/groups/create', { name: 'Stage8 team', members: [account.avatar, otherAvatar],
            chat_id: name, chats: [name], activation_strategy: 1 });
        const response = await account.context.request.post('/api/chats/group/get', { headers: account.headers,
            data: { id: name, allow_create: true } });
        expect(response.ok(), await response.text()).toBe(true);
        const vacancy = JSON.parse(response.headers()['x-neconyan-roleplay']);
        await account.post('/api/chats/group/save', { id: name, chat: [
            { user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
            { name: 'Durable Nova', is_user: false, mes: 'Retained answer.', extra: {},
                swipes: ['Retained answer.', 'Retained alternative.'], swipe_id: 0, original_avatar: account.avatar },
            { name: 'User', is_user: true, mes: 'Everyone, please answer.', extra: {} },
        ], roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
        await account.open({ workspace: false });
        await noPages(browser);
        const native = owned(app);
        const locator = { group: true, chat: name };
        const source = captureRoleplaySource(native.scope, { locator, groupId: group.id });
        const settings = JSON.parse(fs.readFileSync(path.join(native.directories.root, 'settings.json'), 'utf8'));
        const binding = captureGenerationBinding(native.directories, { kind: 'active' },
            { settingsRevision: getSettingsRevision(settings) });
        const request = captureRoleplayWorkflowRequest(native.base, native.account, source,
            { binding, maxTokens: 128, effect: 'append', generationId: 73 });
        expect(request.group.speakers.map(speaker => speaker.avatar)).toEqual([account.avatar, otherAvatar]);
        const admitted = admitRoleplayWorkflowJob(native.base, native.account,
            { operationKey: `stage8-group-${viewport}-${randomUUID()}`, source, request });
        releaseJob(native.directories, admitted.jobId);
        const job = await account.settled(admitted.jobId);
        expect(job.result.result.speakers.map(speaker => speaker.avatar)).toEqual([account.avatar, otherAvatar]);
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        const records = readRoleplayChat(native.scope, locator).records;
        expect(records[1].swipes).toEqual(['Retained answer.', 'Retained alternative.']);
        expect(records.slice(-2).map(record => [record.original_avatar, record.mes, record.extra.gen_id])).toEqual([
            [account.avatar, 'Nova answers the group.', 73], [otherAvatar, 'Kit answers after Nova.', 73],
        ]);
        const paid = app.provider.calls.length;
        await app.restart();
        expect(app.processes[0].signal).toBe('SIGKILL');
        const page = await account.open({ workspace: false });
        await page.evaluate(async ({ groupId, chatName }) => {
            const groups = await import('/scripts/group-chats.js');
            await groups.openGroupById(groupId, { switchMenu: false });
            await groups.openGroupChat(groupId, chatName);
        }, { groupId: group.id, chatName: name });
        await expect(page.locator('#chat .mes').last()).toContainText('Kit answers after Nova.');
        const geometry = await page.locator('#send_textarea').evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { width: rect.width, left: rect.left, right: rect.right, viewport: window.innerWidth,
                overflow: document.documentElement.scrollWidth > window.innerWidth };
        });
        expect(geometry.width).toBeGreaterThan(100);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
        expect(geometry.overflow).toBe(false);
        expect(app.provider.calls).toHaveLength(paid);
        await page.screenshot({ path: info.outputPath('retained-group-turn.png') });
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
    });
}
