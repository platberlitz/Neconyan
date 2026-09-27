/* global window, document */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from './neconyan-conversation-durable-fixture.js';
import { setConfigFilePath } from '../src/util.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { roleplayAccountStamp } = await import('../src/roleplay-store.js');
const { readRoleplayChat } = await import('../src/generation/roleplay-source.js');

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(240000);

const ANSWER = 'The server wrote this reply.';

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
        { user_name: 'User', character_name: 'Durable Nova', chat_metadata: { stage9: true } },
        { name: 'Durable Nova', is_user: false, mes: 'Retained answer.', extra: {},
            swipes: ['Retained answer.', 'Retained alternative.'], swipe_id: 0 },
        { name: 'User', is_user: true, mes: 'Retained question.', extra: {} },
    ], roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    return { group: false, avatar: account.avatar, chat: name };
}

async function openChat(page, { avatar, chat }) {
    const opened = await page.evaluate(async ({ avatar, chat }) => {
        const context = window.SillyTavern.getContext();
        const core = await import('/script.js');
        await context.getCharacters();
        await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        // The card remembers the saved chat, so selecting the character opens it.
        if (core.getCurrentChatId() !== chat) await core.openCharacterChat(chat);
        return core.getCurrentChatId();
    }, { avatar, chat });
    expect(opened).toBe(chat);
    await expect(page.locator('#chat .mes').first()).toContainText('Retained answer.');
}

// A stale settings acknowledgement is refused once; the browser saves its settings and
// replays the same key, so the test waits for the submission the server accepted.
function acceptedSubmission(response) {
    return response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409;
}

function noPages(browser) {
    return browser.contexts().flatMap(context => context.pages());
}

async function terminal(account, id) {
    await expect.poll(async () => (await account.job(id)).state, { timeout: 60000 })
        .toMatch(/^(completed|failed|interrupted|cancelled|conflict)$/);
    return account.job(id);
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`${viewport} Agents can be switched off during setup recovery and the Companion paw stays available`, async ({ app }, info) => {
        const agent = { id: 'controls-companion', name: 'Controls companion', enabled: true, category: 'companion',
            execution: 'companion', prompt: 'Keep a note.', companion: { displayMode: 'panel' } };
        const account = await app.account({ configureSettings(saved) {
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false } };
        }, phone });
        const native = owned(app);
        await fs.mkdir(path.join(native.directories.inChatAgents, 'presets'), { recursive: true });
        await fs.writeFile(path.join(native.directories.inChatAgents, `${agent.id}.json`), JSON.stringify(agent));
        await fs.writeFile(path.join(native.directories.inChatAgents, 'presets', 'controls-recovery.json'), JSON.stringify({
            id: 'controls-recovery', name: 'Recovery before controls', version: 1, recoveryFor: 'controls', agents: [agent], globalSettings: { enabled: true },
        }));
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'agents'));
        const toggle = page.locator('#ica--globalEnabled');
        await expect(toggle).toHaveText('Agents On', { timeout: 30000 });
        await expect(page.locator('#ica--run-status')).toHaveText('Agent setup or library needs recovery');
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).setCompanionPanelLauncher('topbar'));
        const paw = page.locator('#ica--tracker-panel-topbar');
        await expect(paw).toBeVisible();
        await toggle.click();
        await expect(toggle).toHaveText('Agents Off');
        const saved = await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }));
        expect(saved).toBe(true);
        expect(JSON.parse((await account.post('/api/settings/get')).settings).extension_settings.inChatAgents.globalSettings.enabled).toBe(false);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 120000 });
        await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'agents'));
        await expect(toggle).toHaveText('Agents Off', { timeout: 30000 });
        await expect(paw).toBeVisible();
        const geometry = await paw.boundingBox();
        expect(geometry.width).toBeGreaterThan(0);
        expect(geometry.height).toBeGreaterThan(0);
        expect(geometry.x).toBeGreaterThanOrEqual(0);
        expect(geometry.x + geometry.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await paw.click();
        await expect(page.locator('#ica--tracker-panel')).toHaveAttribute('aria-hidden', 'false');
        await expect(page.locator('#ica--tracker-panel')).toContainText('Controls companion');
        await expect(page.locator('[data-action="panel-regenerate-all"]')).toBeDisabled();
        expect(app.provider.calls).toHaveLength(0);
        await page.screenshot({ path: info.outputPath('agent-controls.png') });
    });

    test(`${viewport} returning to a completed workflow does not reload over a pending chat save`, async ({ app }) => {
        app.provider.mode.reply = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }] });
        const account = await app.account({ phone, activeConnection: true });
        const native = owned(app);
        const locator = await savedChat(account, `Readback save ${viewport}`);
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await openChat(page, locator);
        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('One reply before returning to the tab.');
        await page.locator('#send_textarea').press('Enter');
        const accepted = await (await submitted).json();
        await account.settled(accepted.jobId);
        await expect(page.locator('#chat .mes').last()).toContainText(ANSWER, { timeout: 30000 });
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating()), { timeout: 30000 }).toBe(false);

        try {
            await page.evaluate(() => {
                window.readbackTestFetch = window.fetch;
                window.fetch = async (...args) => {
                    const response = await window.readbackTestFetch(...args);
                    if (String(args[0]).endsWith('/api/chats/save') && !window.readbackSaveArrived) {
                        window.readbackSaveArrived = true;
                        await new Promise(resolve => { window.releaseReadbackSave = resolve; });
                    }
                    return response;
                };
                window.pendingReadbackTestSave = import('/script.js').then(core => core.saveChatConditional({ throwOnError: true }));
            });
            await page.waitForFunction(() => window.readbackSaveArrived);
            await page.evaluate(async () => {
                const workflows = await import('/scripts/neconyan-conversation/roleplay-workflows.js');
                await Promise.all([workflows.resumeNativeRoleplayWorkflowObservation(), workflows.resumeNativeRoleplayWorkflowObservation()]);
            });
            await expect(page.locator('#chat .mes').last()).toContainText(ANSWER);
            await expect(page.locator('#toast-container').filter({ hasText: 'Could not load chat data' })).toHaveCount(0);
        } finally {
            await page.evaluate(async () => {
                window.releaseReadbackSave?.();
                await window.pendingReadbackTestSave;
                window.fetch = window.readbackTestFetch;
            });
        }
        expect(app.provider.calls).toHaveLength(1);
        // Both replacement controls must preserve the saved reply until the server
        // accepts and completes its replacement, including after a tab resume.
        for (const action of ['regenerate', 'swipe']) {
            let beforeSubmission;
            await page.route('**/api/roleplay/workflow/submit', route => {
                beforeSubmission = readRoleplayChat(native.scope, locator).records.at(-1);
                return route.continue();
            });
            const replacement = page.waitForResponse(acceptedSubmission);
            if (action === 'regenerate') {
                await page.evaluate(() => document.querySelector('#option_regenerate').click());
            } else {
                await page.locator('#chat .mes').last().locator('.swipe_right').click();
            }
            const response = await replacement;
            expect(response.status(), await response.text()).toBe(202);
            const replacementJob = await terminal(account, (await response.json()).jobId);
            const children = await Promise.all((replacementJob.children ?? []).map(id => account.job(id)));
            expect(replacementJob.state, JSON.stringify({ action, error: replacementJob.error,
                children: children.map(job => ({ state: job.state, error: job.error })) })).toBe('completed');
            await expect(page.locator('#chat .mes').last()).toContainText(ANSWER, { timeout: 30000 });
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating()), { timeout: 30000 }).toBe(false);
            expect(beforeSubmission.mes).toBe(ANSWER);
            await page.unroute('**/api/roleplay/workflow/submit');
        }
        expect(app.provider.calls).toHaveLength(3);
    });

    test(`${viewport} hidden Companions do not block a named Roleplay reply with a false capacity error`, async ({ app }, info) => {
        const agents = Array.from({ length: 31 }, (_, index) => ({ id: `capacity-${index}`, name: `Capacity ${index}`,
            enabled: true, category: 'companion', execution: 'companion', phase: 'pre', prompt: `TASK_CAPACITY_${index}`,
            companion: { trigger: 'auto', includeWorldInfo: false } }));
        app.provider.mode.reply = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }] });
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.extension_settings.character_allowed_regex = ['Another character.png'];
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, connectionProfile: 'durable',
                separateRecentChats: false, hiddenCompanionAgentIds: agents.slice(9).map(agent => agent.id),
                companionExecutionMode: 'parallel', companionConcurrentWithPostGen: true } };
        } });
        const native = owned(app);
        await fs.mkdir(native.directories.inChatAgents, { recursive: true });
        await Promise.all(agents.map(agent => fs.writeFile(path.join(native.directories.inChatAgents, `${agent.id}.json`), JSON.stringify(agent))));
        const locator = await savedChat(account, `Companion capacity ${viewport}`);
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await openChat(page, locator);
        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('Generate with the visible Companions.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.status(), await response.text()).toBe(202);
        const accepted = await response.json();
        await account.settled(accepted.jobId);
        await expect(page.locator('#chat .mes').last()).toContainText(ANSWER, { timeout: 30000 });
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating()), { timeout: 30000 }).toBe(false);
        const result = readRoleplayChat(native.scope, locator).records.at(-1);
        expect(Object.keys(result.extra.inChatAgentCompanionResults).sort()).toEqual(agents.slice(0, 9).map(agent => agent.id).sort());
        expect(app.provider.calls).toHaveLength(10);
        await page.screenshot({ path: info.outputPath('companion-capacity-reply.png') });
    });

    test(`${viewport} a named Roleplay reply from the browser completes once, closes its page and reopens without replaying`, async ({ app, browser }, info) => {
        app.provider.mode.reply = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }] });
        const account = await app.account({ phone, activeConnection: true });
        const native = owned(app);
        const locator = await savedChat(account, `Stage9 ${viewport} reply`);
        const page = await account.open({ workspace: false });
        await openChat(page, locator);
        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('Ask the server one question.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.status(), await response.text()).toBe(202);
        const accepted = await response.json();
        expect(accepted.name).toBe('roleplay.reply');
        expect(accepted.jobId).toBeTruthy();

        // The browser adopts the server's durable write by reloading the chat it owns,
        // so the answer appears without a page refresh and without a second generation.
        await expect(page.locator('#chat .mes').last()).toContainText(ANSWER, { timeout: 30000 });
        const job = await account.settled(accepted.jobId);
        expect(job.result.result.status).toBe('completed');
        expect(app.provider.calls).toHaveLength(1);

        const records = readRoleplayChat(native.scope, locator).records;
        expect(records[1].swipes).toEqual(['Retained answer.', 'Retained alternative.']);
        expect(records[1].swipe_id).toBe(0);
        expect(records.at(-1).mes).toBe(ANSWER);
        expect(records.filter(record => record.is_user)).toHaveLength(2);

        const receipt = await (await account.context.request.get(
            `/api/roleplay/workflow/receipt?key=${encodeURIComponent(accepted.key)}`, { headers: account.headers })).json();
        expect(receipt.accepted).toBe(true);
        expect(receipt.state).toBe('closed');
        expect(receipt.result.named).toEqual({ appended: true });
        expect(receipt.jobId).toBe(accepted.jobId);

        await page.screenshot({ path: info.outputPath('completed-reply.png') });
        await page.close();
        expect(noPages(browser)).toHaveLength(0);

        // Reopening the same chat reads the receipt back; it never submits again.
        const reopened = await account.open({ workspace: false });
        await openChat(reopened, locator);
        await expect(reopened.locator('#chat .mes').last()).toContainText(ANSWER);
        expect(app.provider.calls).toHaveLength(1);
        await reopened.close();
        expect(noPages(browser)).toHaveLength(0);
    });

    test(`${viewport} a failed named Roleplay workflow keeps the saved chat and never generates a second time`, async ({ app, browser }, info) => {
        // The fixture's canned reply wins over fail mode, so clear it first.
        app.provider.mode.reply = null;
        app.provider.mode.fail = true;
        const account = await app.account({ phone, activeConnection: true });
        const native = owned(app);
        const locator = await savedChat(account, `Stage9 ${viewport} failure`);
        const page = await account.open({ workspace: false });
        await openChat(page, locator);

        const submitted = page.waitForResponse(acceptedSubmission);
        await page.locator('#send_textarea').fill('This answer cannot be produced.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.ok(), await response.text()).toBe(true);
        const accepted = await response.json();

        const job = await terminal(account, accepted.jobId);
        expect(job.state).not.toBe('completed');
        // A refused or failed paid step is never repeated automatically.
        expect(app.provider.calls).toHaveLength(1);
        await expect(page.locator('#chat .mes').last()).toContainText('This answer cannot be produced.');
        await page.screenshot({ path: info.outputPath('failed-workflow.png') });

        const records = readRoleplayChat(native.scope, locator).records;
        expect(records[1].swipes).toEqual(['Retained answer.', 'Retained alternative.']);
        expect(records.at(-1).is_user).toBe(true);
        expect(records.at(-1).mes).toBe('This answer cannot be produced.');
        expect(records).toHaveLength(4);
        await page.close();
        expect(noPages(browser)).toHaveLength(0);
    });
}
