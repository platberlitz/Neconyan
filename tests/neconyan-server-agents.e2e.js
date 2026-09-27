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
const { roleplayAccountStamp, withRoleplayAccount } = await import('../src/roleplay-store.js');
const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureGenerationBinding, getChatProfileContextLimit } = await import('../src/generation/profiles.js');
const { getSettingsRevision } = await import('../src/settings-version.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { getJob, releaseJob } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { writeAgentRecordLocked } = await import('../src/in-chat-agent-storage.js');
const { stageBoundModelToolCalls, admitBoundModelToolCall, releaseBoundModelToolCall,
    readBoundModelToolResult } = await import('../src/generation/roleplay-tool-dispatch.js');

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(240000);

function completed(text) { return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] }; }
function accountScope(app) {
    const owner = 'default-user';
    const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, relative]) => [key, path.join(app.directory, 'data', owner, relative)]));
    const base = { owner, directories };
    const { accountId, dataEpoch } = roleplayAccountStamp(base);
    return { base, directories, account: { accountId, dataEpoch }, scope: { ...base, accountId, dataEpoch } };
}

async function chat(account, name) {
    const fields = { avatar_url: account.avatar, file_name: name };
    const response = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
    expect(response.ok(), await response.text()).toBe(true);
    const vacancy = JSON.parse(response.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/save', { ...fields, chat: [
        { user_name: 'User', character_name: 'Durable Nova', chat_metadata: { fromStage7: true } },
        { name: 'Durable Nova', is_user: false, mes: 'Original answer.', extra: {}, swipes: ['Original answer.', 'Keep this alternative.'], swipe_id: 0 },
        { name: 'User', is_user: true, mes: 'Original question.', extra: {} },
    ], roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    return { group: false, avatar: account.avatar, chat: name };
}

function reply(native, avatar, locator, operationKey) {
    const source = captureRoleplaySource(native.scope, { locator });
    const settings = JSON.parse(fs.readFileSync(path.join(native.directories.root, 'settings.json'), 'utf8'));
    const binding = captureGenerationBinding(native.directories, { kind: 'active' }, { settingsRevision: getSettingsRevision(settings) });
    const request = { binding, maxTokens: 128, characterName: 'Durable Nova', messages: [], serverPrompt: true,
        worldInfo: captureRoleplayWorldInfo(native.base, native.account, source, { avatar,
            maxContext: getChatProfileContextLimit(native.directories, binding) - 128, serverPrompt: true }) };
    const { jobId } = admitRoleplayJob(native.base, native.account, { operationKey, effect: 'append', source, request });
    releaseJob(native.directories, jobId);
    return jobId;
}

async function noPages(browser) {
    for (const context of browser.contexts()) for (const page of context.pages()) {
        // Finish startup writes before this test edits saved settings directly with every page closed.
        expect(await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }))).toBe(true);
        await page.close();
    }
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
}

async function reopen(account, name, info) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async ({ avatar, chatName }) => {
        const context = window.SillyTavern.getContext();
        const core = await import('/script.js');
        await context.getCharacters();
        await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        await core.openCharacterChat(chatName);
    }, { avatar: account.avatar, chatName: name });
    await expect(page.locator('#send_textarea')).toBeVisible();
    const geometry = await page.locator('#send_textarea').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, width: bounds.width, viewport: window.innerWidth,
            fontSize: Number.parseFloat(getComputedStyle(element).fontSize), overflow: document.documentElement.scrollWidth > window.innerWidth };
    });
    expect(geometry.width).toBeGreaterThan(100);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.fontSize).toBeGreaterThanOrEqual(14);
    expect(geometry.overflow).toBe(false);
    await page.screenshot({ path: info.outputPath('retained-agents.png') });
    return page;
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} saved Agents and Quick Reply finish a protected reply with every page closed`, async ({ app, browser }, info) => {
        app.provider.mode.reply = body => completed(JSON.stringify(body.messages).includes('CHANGE RESPONSE TO ORBIT')
            ? 'Edited by Agent.' : 'Original from model.');
        const account = await app.account({ phone, activeConnection: true, configureSettings: settings => {
            settings.extension_settings.inChatAgents = { globalSettings: { enabled: true, postMainInterceptShowMessageFirst: false } };
            settings.extension_settings.quickReplyV2 = { isEnabled: true, config: { setList: [{ set: 'Actions' }] } };
            settings.world_info_settings = { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 };
        } });
        await account.open({ workspace: false });
        await noPages(browser);
        const native = accountScope(app);
        withRoleplayAccount(native.base, native.account, lease => {
            fs.writeFileSync(path.join(native.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
                1: { uid: 1, key: ['Original question'], content: 'A saved match.', position: 0, automationId: 'qr-one' },
            } }));
            fs.mkdirSync(native.directories.quickreplies, { recursive: true });
            fs.writeFileSync(path.join(native.directories.quickreplies, 'Actions.json'), JSON.stringify({ name: 'Actions', version: 2,
                qrList: [{ id: 1, automationId: 'qr-one', message: '/setvar key=color green' }] }));
            const settingsFile = path.join(native.directories.root, 'settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            settings.extension_settings.quickReplyV2 = { isEnabled: true, config: { setList: [{ set: 'Actions' }] } };
            fs.writeFileSync(settingsFile, JSON.stringify(settings));
            writeAgentRecordLocked(lease, 'agent', { id: 'editor', name: 'Editor', category: 'custom', enabled: true, phase: 'post', prompt: 'CHANGE RESPONSE TO ORBIT',
                postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMode: 'rewrite', promptTransformMaxTokens: 64 } });
        });
        const locator = await chat(account, 'Stage7 saved Agents');
        const jobId = reply(native, account.avatar, locator, 'stage7-agent-quick-reply');
        await account.settled(jobId);
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        const accepted = getJob(native.directories, jobId).intent.request.worldInfo;
        const scan = readArtifact(native.directories, jobId, 'roleplay-world-info');
        expect(scan?.hookEvents?.actions, JSON.stringify({ books: accepted.names, quickReply: accepted.hookPolicy.quickReply, activated: scan?.activated })).toHaveLength(1);
        const records = readRoleplayChat(native.scope, locator).records;
        expect(records[1].swipes).toEqual(['Original answer.', 'Keep this alternative.']);
        expect(records[0].chat_metadata.variables.color).toBe('green');
        expect(records.at(-1).mes).toBe('Edited by Agent.');
        expect(records.at(-1).extra.inChatAgentTransformHistory).toHaveLength(1);
        expect(readArtifact(native.directories, jobId, 'roleplay-quick-replies').results[0].value).toBe('green');
        const paid = app.provider.calls.length;
        await app.restart();
        const page = await reopen(account, locator.chat, info);
        await expect(page.locator('#chat .mes').last()).toContainText('Edited by Agent.');
        expect(app.processes[0].signal).toBe('SIGKILL');
        expect(app.provider.calls).toHaveLength(paid);
        await page.close();
    });

    test(`${viewport} a model-sourced Pathfinder tool gets real approval and completes without pages`, async ({ app, browser }, info) => {
        app.provider.mode.reply = () => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'call-stage7', type: 'function', function: { name: 'Pathfinder_Summarize',
                arguments: JSON.stringify({ title: 'Safe bridge', content: 'The route is open.', significance: 'high', book: 'Manual' }) } }] } }] });
        const account = await app.account({ phone, activeConnection: true, configureSettings: settings => {
            settings.oai_settings.function_calling = true;
            settings.extension_settings.inChatAgents = { globalSettings: { enabled: true, pathfinderEnabled: true } };
        } });
        await account.open({ workspace: false });
        await noPages(browser);
        const native = accountScope(app);
        withRoleplayAccount(native.base, native.account, lease => {
            fs.writeFileSync(path.join(native.directories.worlds, 'Manual.json'), JSON.stringify({ entries: { 12: {
                uid: 12, comment: 'Observatory', content: 'The telescope is broken.', key: ['telescope'], position: 0,
            } } }));
            writeAgentRecordLocked(lease, 'agent', { id: 'pathfinder', name: 'Pathfinder', category: 'tool', enabled: true,
                sourceTemplateId: 'tpl-pathfinder', settings: { sidecarEnabled: false, pipelineEnabled: false,
                    enabledLorebooks: ['Manual'], includeContextualLorebooks: false, confirmTools: { Pathfinder_Summarize: true } } });
        });
        const locator = await chat(account, 'Stage7 saved tool');
        const parentId = reply(native, account.avatar, locator, 'stage7-model-tool');
        await account.settled(parentId, 'failed');
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        expect(readArtifact(native.directories, parentId, 'roleplay-main-provider')).toBeTruthy();
        const parent = () => ({ owner: native.base.owner, directories: native.directories, job: getJob(native.directories, parentId), signal: new AbortController().signal });
        const calls = stageBoundModelToolCalls(parent());
        expect(calls.calls.map(call => call.name)).toEqual(['Pathfinder_Summarize']);
        const child = admitBoundModelToolCall(parent(), 0);
        releaseBoundModelToolCall(parent(), 0);
        await expect.poll(async () => (await account.job(child.childJobId)).state, { timeout: 60000 }).toBe('waiting');
        const waiting = await account.job(child.childJobId);
        expect(waiting.result.approval.id).toBeTruthy();
        expect(JSON.parse(fs.readFileSync(path.join(native.directories.worlds, 'Manual.json'), 'utf8')).entries[12].content).toBe('The telescope is broken.');
        await account.post(`/api/jobs/${encodeURIComponent(child.childJobId)}/approval/${encodeURIComponent(waiting.result.approval.id)}`,
            { proposalHash: waiting.result.approval.proposalHash, decision: 'allow' });
        await account.settled(child.childJobId);
        const bound = readBoundModelToolResult(parent(), 0);
        expect(bound.completed).toBe(true);
        expect(bound.result.result.title).toMatch(/Summary/);
        const book = JSON.parse(fs.readFileSync(path.join(native.directories.worlds, 'Manual.json'), 'utf8'));
        expect(Object.values(book.entries).some(entry => entry.comment.includes('Safe bridge'))).toBe(true);
        expect(readRoleplayChat(native.scope, locator).records).toHaveLength(3);
        const paid = app.provider.calls.length;
        await app.restart();
        expect(readBoundModelToolResult(parent(), 0).result).toEqual(bound.result);
        const page = await reopen(account, locator.chat, info);
        await expect(page.locator('#chat .mes').last()).toContainText('Original question.');
        expect(app.processes[0].signal).toBe('SIGKILL');
        expect(app.provider.calls).toHaveLength(paid);
        await page.close();
    });
}
