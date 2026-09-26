/* global window */
import { expect } from '@playwright/test';
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
