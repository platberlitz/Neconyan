import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test, MODEL } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

async function openChat(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    return page;
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} ordinary regenerate and guided response/swipe stay in the browser`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true });
        const page = await openChat(account);
        const requests = [];
        page.on('request', request => {
            if (/\/api\/(backends\/chat-completions\/generate|roleplay\/workflow\/submit)$/.test(request.url())) requests.push(request.url());
        });
        for (const [index, action] of ['normal', 'regenerate', 'guidedResponse', 'guidedSwipe'].entries()) {
            const answer = `Browser answer ${index}.`;
            app.provider.mode.reply = { choices: [{ message: { content: answer } }] };
            await page.locator('#send_textarea').fill(action === 'normal' ? 'Hello, Nova.' : action.startsWith('guided') ? `Direction ${index}: mention the fountain.` : '');
            await page.evaluate(async action => {
                if (action.startsWith('guided')) {
                    const module = await import(`/scripts/extensions/guided-generations/scripts/${action}.js`);
                    await module[action]();
                } else {
                    await (await import('/script.js')).Generate(action);
                }
            }, action);
            await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toHaveText(answer);
            if (action.startsWith('guided')) {
                await expect(page.locator('#send_textarea')).toHaveValue(`Direction ${index}: mention the fountain.`);
                expect(JSON.stringify(app.provider.calls[index].messages)).toContain(`Direction ${index}: mention the fountain.`);
            }
        }
        expect(requests).toHaveLength(4);
        expect(requests.every(url => url.endsWith('/api/backends/chat-completions/generate'))).toBe(true);
        expect(app.provider.calls).toHaveLength(4);
        const chat = await page.evaluate(async () => (await import('/script.js')).chat);
        expect(chat.filter(message => message.is_user).map(message => message.mes)).toEqual(['Hello, Nova.']);
        expect(chat.at(-1).swipes).toEqual(['Browser answer 2.', 'Browser answer 3.']);
    });

    test(`${viewport} browser reply remains visible while Post Gen and Companion run`, async ({ app }) => {
        app.provider.mode.hold = ['post-held', 'companion-held'];
        app.provider.mode.reply = body => ({ choices: [{ message: { content: body.model === MODEL ? 'The browser reply is ready.'
            : body.model === 'post-held' ? 'The revised browser reply is ready.' : 'The Companion note is ready.' }, finish_reason: 'stop' }] });
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.extension_settings.connectionManager.profiles.push(
                { id: 'post', name: 'Post Gen fixture', api: 'custom', mode: 'cc', model: 'post-held', 'api-url': app.provider.url },
                { id: 'companion', name: 'Companion fixture', api: 'custom', mode: 'cc', model: 'companion-held', 'api-url': app.provider.url });
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
                trackerCompanionAutoLoopVersion: 4, connectionProfile: 'post', companionExecutionMode: 'parallel', companionConcurrentWithPostGen: false } };
        } });
        const directory = path.join(app.dataRoot, 'default-user', 'InChatAgents');
        await fs.mkdir(directory, { recursive: true });
        for (const agent of [
            { id: 'post', name: 'Post Gen', enabled: true, phase: 'post', prompt: 'Revise the reply.', connectionProfile: 'post',
                postProcess: { enabled: false, promptTransformEnabled: true } },
            { id: 'companion', name: 'Story Companion', enabled: true, category: 'companion', execution: 'companion',
                prompt: 'Write a note about the reply.', connectionProfile: 'companion', companion: { trigger: 'auto', displayMode: 'card' } },
        ]) await fs.writeFile(path.join(directory, `${agent.id}.json`), JSON.stringify(agent));
        const page = await openChat(account);
        const submissions = [];
        page.on('request', request => { if (request.url().endsWith('/api/roleplay/workflow/submit')) submissions.push(request.url()); });
        await page.locator('#send_textarea').fill('Let the Agents help with this reply.');
        await page.locator('#send_textarea').press('Enter');
        try {
            await expect.poll(() => app.provider.calls.some(call => call.model === 'post-held'), { timeout: 30000 }).toBe(true);
            await expect(page.locator('#chat .mes[mesid]').last()).toContainText('The browser reply is ready.');
            expect(app.provider.calls.find(call => call.model === 'post-held').completedAt).toBeNull();
        } finally {
            await app.release();
        }
        await expect(page.locator('#chat .mes[mesid]').last()).toContainText('The revised browser reply is ready.', { timeout: 30000 });
        await expect(page.locator('#chat .mes[mesid]').last()).toContainText('The Companion note is ready.', { timeout: 30000 });
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
        expect(submissions).toEqual([]);
        expect(app.provider.calls).toHaveLength(3);
        await page.close();
        const reopened = await openChat(account);
        await expect(reopened.locator('#chat .mes[mesid]').last()).toContainText('The revised browser reply is ready.');
        await expect(reopened.locator('#chat .mes[mesid]').last()).toContainText('The Companion note is ready.');
        expect(app.provider.calls).toHaveLength(3);
    });
}

test('scoped Notebook context selects the server only while the note is enabled', async ({ app }) => {
    const account = await app.account({ activeConnection: true });
    const page = await openChat(account);
    const chatId = await page.evaluate(async () => (await import('/script.js')).getCurrentChatId());
    const { notebook } = await account.post('/api/notebooks/create', { operationId: 'routing:notebook', name: 'Reply context' });
    const { noteId } = await account.post('/api/notebooks/notes/create', { operationId: 'routing:note', notebookId: notebook.id,
        title: 'Selected context', text: 'The selected note says the fountain is purple.' });
    await account.post('/api/notebooks/policies/update', { notebookId: notebook.id, patch: {
        notes: { [noteId]: { context: { mode: 'pinned', scopes: [{ kind: 'chat', id: `${account.avatar}:${chatId}` }] } } },
    } });
    const native = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit'));
    await page.locator('#send_textarea').fill('Describe the fountain.');
    await page.locator('#send_textarea').press('Enter');
    const response = await native;
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).jobId);
    expect(JSON.stringify(app.provider.calls[0].messages)).toContain('The selected note says the fountain is purple.');
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
    await account.post('/api/notebooks/policies/update', { notebookId: notebook.id, patch: {
        notes: { [noteId]: { context: { mode: 'off' } } },
    } });
    const browser = page.waitForRequest(request => request.url().endsWith('/api/backends/chat-completions/generate'));
    await page.locator('#send_textarea').fill('Continue without the note.');
    await page.locator('#send_textarea').press('Enter');
    await browser;
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
    expect(app.provider.calls).toHaveLength(2);
    expect(JSON.stringify(app.provider.calls[1].messages)).not.toContain('The selected note says the fountain is purple.');
});
