/* global document, window */
/* eslint-disable playwright/no-standalone-expect -- Shared fixture helpers assert their own setup. */
import { expect } from '@playwright/test';
import { MODEL, test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

async function openScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.getByRole('textbox', { name: 'Message for Scratchpad', exact: true })).toBeEnabled();
    return page.evaluate(async () => (await import('/scripts/scratchpad/context.js')).wireSource((await import('/scripts/scratchpad/context.js')).currentSource()));
}

async function createCharacter(account, name) {
    const result = await account.context.request.post('/api/characters/create', { headers: account.headers, data: { ch_name: name, description: name, first_mes: 'Hello.' } });
    expect(result.ok()).toBe(true);
    return result.text();
}

async function selectConversation(page, avatar) {
    await page.evaluate(async avatar => {
        await window.SillyTavern.getContext().getCharacters();
        await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar);
    }, avatar);
    await openScratchpad(page);
}

test('assistant connection choices survive reopening and route each speaker to its own model', async ({ app }) => {
    test.setTimeout(150000);
    const account = await app.account({ configureSettings: saved => {
        const profiles = saved.extension_settings.connectionManager.profiles;
        for (const assistant of ['miso', 'taro', 'nori']) profiles.push({ ...profiles[0], id: `scratch-${assistant}`, name: assistant, model: `model-${assistant}` });
    } });
    const page = await account.open();
    const source = await openScratchpad(page);
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await expect(page.locator('#scratchpad-max-tokens')).toHaveValue('16000');
    for (const assistant of ['miso', 'taro', 'nori']) {
        await page.locator(`#scratchpad-connection-${assistant}`).selectOption(`scratch-${assistant}`);
    }
    await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0]?.settings.assistantConnections).toEqual({
        miso: { kind: 'profile', profileId: 'scratch-miso' }, taro: { kind: 'profile', profileId: 'scratch-taro' }, nori: { kind: 'profile', profileId: 'scratch-nori' },
    });
    await page.close();
    const reopened = await account.open();
    await openScratchpad(reopened);
    await reopened.getByRole('tab', { name: 'Context', exact: true }).click();
    for (const assistant of ['miso', 'taro', 'nori']) await expect(reopened.locator(`#scratchpad-connection-${assistant}`)).toHaveValue(`scratch-${assistant}`);
    await reopened.getByRole('tab', { name: 'Chat', exact: true }).click();
    for (const assistant of ['Miso', 'Taro', 'Nori']) {
        await reopened.locator('.scratchpad-assistants').getByRole('button', { name: assistant, exact: true }).click();
        await expect(reopened.locator('.scratchpad-assistants').getByRole('button', { name: assistant, exact: true })).toHaveAttribute('aria-pressed', 'true');
        const question = `Which model, ${assistant}?`;
        app.provider.mode.streamReply = { first: `${assistant} answers`, rest: ' with its chosen model.' };
        await reopened.locator('.scratchpad-composer').fill(question);
        const accepted = reopened.waitForResponse('**/api/scratchpad/send');
        await reopened.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        await expect(reopened.locator('.scratchpad-stream')).toContainText(`${assistant} answers`);
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        await expect(reopened.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        expect(app.provider.calls.filter(call => call.messages?.at(-1)?.content === question).map(call => call.model)).toEqual([`model-${assistant.toLowerCase()}`]);
    }
});

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} swipe picks share only the selected versions without switching the story`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        const versions = ['A quiet meeting in the garden.', 'The current version in the library.', 'A surprising meeting by the sea.'];
        const chatId = await page.evaluate(async ({ avatar, versions }) => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const message = context.chat[0];
            message.swipes = versions;
            message.swipe_id = 1;
            message.mes = versions[1];
            message.swipe_info = versions.map(() => ({ send_date: message.send_date, extra: structuredClone(message.extra || {}) }));
            await context.saveChat({ throwOnError: true });
            await (await import('/script.js')).reloadCurrentChat();
            return context.getCurrentChatId();
        }, { avatar: account.avatar, versions });
        const source = await openScratchpad(page);
        if (phone) await applyIOSOnlyCss(page);
        await page.locator('.scratchpad-composer').fill('Compare the first and third swipes.');
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.locator('.scratchpad-swipes > summary').click();
        await expect(page.locator('.scratchpad-swipes')).toContainText('Swipe 2 of 3 (current)');
        await page.getByRole('checkbox', { name: 'Pick message #0, swipe 1', exact: true }).check();
        await page.getByRole('checkbox', { name: 'Pick message #0, swipe 3', exact: true }).check();
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].settings.picked).toEqual(['0:swipe:0', '0:swipe:2']);
        await openScratchpad(page);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(page.getByRole('checkbox', { name: 'Pick message #0, swipe 1', exact: true })).toBeChecked();
        await expect(page.getByRole('checkbox', { name: 'Pick message #0, swipe 3', exact: true })).toBeChecked();
        const target = await page.locator('.scratchpad-swipes > summary').boundingBox();
        expect(target.height).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await page.locator('.scratchpad-swipes').screenshot({ path: test.info().outputPath('swipes.png') });
        await page.getByRole('button', { name: 'Show preview', exact: true }).click();
        const preview = page.locator('.scratchpad-preview-text');
        await expect(preview).toContainText('[swipe 1 of 3; alternative]');
        await expect(preview).toContainText('[swipe 3 of 3; alternative]');
        await expect(preview).toContainText(versions[0]);
        await expect(preview).toContainText(versions[2]);
        await expect(preview).not.toContainText(versions[1]);
        const text = await preview.textContent();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        app.provider.mode.streamReply = { first: 'The two versions ', rest: 'have different pacing.' };
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        expect(response.request().postDataJSON().context).toBe(text);
        await expect(page.locator('.scratchpad-stream')).toContainText('The two versions');
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        const saved = (await account.post('/api/chats/get', { avatar_url: account.avatar, file_name: chatId })).find(record => typeof record.mes === 'string');
        expect(saved).toMatchObject({ swipe_id: 1, mes: versions[1], swipes: versions });
        expect(await page.evaluate(() => window.SillyTavern.getContext().chat[0].swipe_id)).toBe(1);
    });

    test(`${phone ? 'iPhone stand-in' : 'desktop'} round table streams three models independently and keeps the group after reopening`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings: saved => {
            const profiles = saved.extension_settings.connectionManager.profiles;
            for (const assistant of ['miso', 'taro', 'nori']) profiles.push({ ...profiles[0], id: `table-${assistant}`, name: assistant, model: `table-${assistant}` });
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        app.provider.mode.streamReply = body => ({ first: `${body.model} suggests `, rest: 'an approach to learning languages.' });
        const page = await account.open();
        const source = await openScratchpad(page);
        if (phone) await applyIOSOnlyCss(page);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        for (const assistant of ['miso', 'taro', 'nori']) await page.locator(`#scratchpad-connection-${assistant}`).selectOption(`table-${assistant}`);
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.locator('.scratchpad-round-table').click();
        await expect(page.locator('.scratchpad-round-table')).toHaveAttribute('aria-pressed', 'true');
        const people = page.locator('.scratchpad-assistants');
        await people.getByRole('button', { name: 'Nori', exact: true }).click();
        await expect(page.locator('.scratchpad-send')).toHaveText('Ask 2');
        await people.getByRole('button', { name: 'Taro', exact: true }).click();
        await expect(people.getByRole('button', { name: 'Miso', exact: true })).toBeDisabled();
        await people.getByRole('button', { name: 'Taro', exact: true }).click();
        await people.getByRole('button', { name: 'Nori', exact: true }).click();
        await expect(page.locator('.scratchpad-send')).toHaveText('Ask 3');
        const controls = await page.locator('.scratchpad-round-table, .scratchpad-assistant').evaluateAll(elements => elements.map(element => {
            const rect = element.getBoundingClientRect();
            return Math.min(rect.width, rect.height);
        }));
        expect(Math.min(...controls)).toBeGreaterThanOrEqual(phone ? 44 : 32);
        await page.locator('.scratchpad-composer').fill('How should I learn another language?');
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        const result = await response.json();
        await expect(page.locator('.scratchpad-stream')).toHaveCount(3);
        await expect.poll(() => app.provider.calls.filter(call => call.messages?.at(-1)?.content === 'How should I learn another language?').length).toBe(3);
        const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === 'How should I learn another language?');
        expect(calls.map(call => call.model).sort()).toEqual(['table-miso', 'table-nori', 'table-taro']);
        for (const assistant of ['Miso', 'Taro', 'Nori']) {
            await expect(page.locator('.scratchpad-message.is-assistant').filter({ has: page.locator('.scratchpad-author', { hasText: assistant }) }).locator('.scratchpad-stream')).toContainText(`table-${assistant.toLowerCase()} suggests`);
        }
        calls.find(call => call.model === 'table-miso').finishStream();
        await expect(page.locator('.scratchpad-message.is-done')).toHaveCount(1);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(2);
        await page.close();
        for (const call of calls.filter(call => call.model !== 'table-miso')) call.finishStream();
        await account.settled(result.job.id);

        const reopened = await account.open();
        await openScratchpad(reopened);
        if (phone) await applyIOSOnlyCss(reopened);
        await expect(reopened.locator('.scratchpad-round-table')).toHaveAttribute('aria-pressed', 'true');
        await expect(reopened.locator('.scratchpad-message.is-done')).toHaveCount(3);
        await expect(reopened.locator('.scratchpad-message.is-user')).toHaveCount(1);
        expect(await reopened.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await reopened.screenshot({ path: test.info().outputPath('round-table.png') });
        const before = (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].messages;
        const retry = reopened.waitForResponse('**/api/scratchpad/send');
        await reopened.locator('.scratchpad-message.is-assistant').filter({ has: reopened.locator('.scratchpad-author', { hasText: 'Taro' }) }).getByRole('button', { name: 'Try again', exact: true }).click();
        const retried = await retry;
        expect(retried.ok(), await retried.text()).toBe(true);
        await expect(reopened.locator('.scratchpad-stream')).toContainText('table-taro suggests');
        expect(app.provider.calls.at(-1).model).toBe('table-taro');
        app.provider.calls.at(-1).finishStream();
        await account.settled((await retried.json()).job.id);
        const after = (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].messages;
        expect(after.filter(message => message.assistant !== 'taro')).toEqual(before.filter(message => message.assistant !== 'taro'));
    });

    test(`${phone ? 'iPhone stand-in' : 'desktop'} Scratchpad sends the preview with the chat connection and preserves new drafts`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, settings: { lorebook_override: 'Scratchpad Garden' } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        await account.post('/api/worldinfo/edit', { name: 'Scratchpad Garden', data: { entries: {
            0: { uid: 0, comment: 'Moonflower', key: ['moonflower'], content: 'Moonflowers only bloom at midnight.' },
        } } });
        app.provider.mode.streamReply = { first: 'A streamed Scratchpad ', rest: 'fixture reply.' };
        const page = await account.open();
        const source = await openScratchpad(page);
        if (phone) await applyIOSOnlyCss(page);
        const composer = page.getByRole('textbox', { name: 'Message for Scratchpad', exact: true });
        await composer.fill('Tell me about the moonflower.');
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        // Dispatch together while the first session is still being created.
        await page.locator('#scratchpad-depth').evaluate(input => {
            input.value = '1';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            const tokens = document.getElementById('scratchpad-max-tokens');
            tokens.value = '512';
            tokens.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect.poll(async () => {
            const { bucket } = await account.post('/api/scratchpad/bucket', { source });
            return bucket.sessions.map(session => [session.settings.depth, session.settings.maxTokens]);
        }).toEqual([[1, 512]]);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(page.locator('.scratchpad-lore')).toContainText('Shared: keyword found');
        await page.getByRole('button', { name: 'Show preview', exact: true }).click();
        await expect(page.locator('.scratchpad-preview-text')).toContainText('Moonflowers only bloom at midnight.');
        const preview = await page.locator('.scratchpad-preview-text').textContent();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await expect(composer).toHaveValue('Tell me about the moonflower.');

        let release;
        const gate = new Promise(resolve => { release = resolve; });
        await page.route('**/api/scratchpad/send', async route => {
            const response = await route.fetch();
            await gate;
            await route.fulfill({ response });
        });
        const request = page.waitForRequest('**/api/scratchpad/send');
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const body = (await request).postDataJSON();
        try {
            expect(body.chatProfileId).toBe('durable');
            expect(body.context).toBe(preview);
            await composer.fill('Keep this next message.');
        } finally { release(); }
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        await expect(page.locator('.scratchpad-messages')).toContainText('A streamed Scratchpad');
        app.provider.mode.finishStream();
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-messages')).toContainText('Scratchpad fixture reply.');
        await expect(composer).toHaveValue('Keep this next message.');
        expect(app.provider.calls.filter(call => call.messages?.at(-1)?.content === 'Tell me about the moonflower.').map(call => call.model)).toEqual([MODEL]);

        await page.getByRole('tab', { name: 'Sessions', exact: true }).click();
        await page.getByRole('button', { name: 'New session', exact: true }).click();
        await expect(composer).toHaveValue('');
        await composer.fill('A separate session draft.');
        await page.getByRole('tab', { name: 'Sessions', exact: true }).click();
        await page.locator('.scratchpad-session:not(.is-active)').getByRole('button', { name: 'Open', exact: true }).click();
        await expect(composer).toHaveValue('Keep this next message.');

        const toggle = page.locator('.scratchpad-overview-toggle');
        const box = await toggle.boundingBox();
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(phone ? 44 : 32);
        const before = await page.locator('.scratchpad-messages').boundingBox();
        await toggle.click();
        await expect(page.locator('.scratchpad-overview-bar')).toBeVisible();
        expect((await page.locator('.scratchpad-messages').boundingBox()).height).toBeGreaterThan(before.height + 20);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        if (phone) expect(await page.locator('.scratchpad-quick').evaluate(element => window.getComputedStyle(element).touchAction)).toBe('pan-x');
        await page.screenshot({ path: test.info().outputPath('scratchpad.png') });
    });
}

test('switching chats during the first send keeps drafts separate and refuses the stale send', async ({ app }) => {
    test.setTimeout(120000);
    const account = await app.account();
    const other = await createCharacter(account, 'Other Scratchpad character');
    const page = await account.open();
    const source = await openScratchpad(page);
    const composer = page.getByRole('textbox', { name: 'Message for Scratchpad', exact: true });
    await composer.fill('The original draft.');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/scratchpad/session/create', async route => {
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
    });
    const creation = page.waitForRequest('**/api/scratchpad/session/create');
    await page.locator('.scratchpad-send').click();
    await creation;
    try {
        await selectConversation(page, other);
        await expect(composer).toHaveValue('');
        await composer.fill('The other chat draft.');
    } finally { release(); }
    await expect(page.locator('.scratchpad-send')).toHaveText('Send');
    await expect(composer).toHaveValue('The other chat draft.');
    expect((await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].messages).toEqual([]);
    expect(app.provider.calls.filter(call => call.messages?.at(-1)?.content === 'The original draft.')).toEqual([]);
    await selectConversation(page, account.avatar);
    await expect(composer).toHaveValue('The original draft.');
});

test('reviewed character changes reject another tab\'s edit and save a fresh review conditionally', async ({ app }) => {
    test.setTimeout(120000);
    const account = await app.account();
    const page = await account.open();
    const source = await openScratchpad(page);
    const proposal = { type: 'character', character: 'Durable Nova', field: 'description', value: 'The reviewed description.' };
    await account.post('/api/scratchpad/session/import', { source, session: { name: 'Review', messages: [
        { role: 'assistant', text: '```scratchpad-change\n' + JSON.stringify(proposal) + '\n```' },
    ] } });
    await openScratchpad(page);
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.locator('.scratchpad-review-before')).toContainText('Nova belongs to account');
    const changed = await account.context.request.post('/api/characters/merge-attributes', { headers: account.headers, data: {
        avatar: account.avatar, description: 'Another tab changed this.', data: { description: 'Another tab changed this.' },
    } });
    expect(changed.ok()).toBe(true);
    const refused = page.waitForResponse('**/api/characters/merge-attributes');
    await page.getByRole('button', { name: 'Save change', exact: true }).click();
    expect((await refused).status()).toBe(409);
    await expect(page.locator('.scratchpad-change.is-applied')).toHaveCount(0);
    expect((await account.post('/api/characters/get', { avatar_url: account.avatar })).data.description).toBe('Another tab changed this.');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.locator('.scratchpad-review-before')).toHaveText('Another tab changed this.');
    await page.getByRole('button', { name: 'Save change', exact: true }).click();
    await expect(page.locator('.scratchpad-change.is-applied')).toContainText('Saved');
    const saved = await account.post('/api/characters/get', { avatar_url: account.avatar });
    expect(saved.data.description).toBe('The reviewed description.');
    expect(saved).not.toHaveProperty('expected_revision');
});

test('Roleplay change cards wait for successful saves and persist message and lorebook changes', async ({ app }) => {
    test.setTimeout(120000);
    const account = await app.account();
    await account.post('/api/worldinfo/edit', { name: 'Scratchpad Garden', data: { entries: {} } });
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    const source = await openScratchpad(page);
    const chatId = await page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId());
    const proposals = [
        { type: 'chat', action: 'edit', message: 0, text: 'Reviewed original.' },
        { type: 'chat', action: 'insert', after: 0, speaker: 'user', text: 'Inserted by review.' },
        { type: 'chat', action: 'hide', message: 1 },
        { type: 'chat', action: 'unhide', message: 1 },
        { type: 'chat', action: 'delete', message: 1 },
        { type: 'lorebook', action: 'add', book: 'Scratchpad Garden', title: 'Flower', keys: ['flower'], content: 'Reviewed lore.' },
    ];
    await account.post('/api/scratchpad/session/import', { source, session: { name: 'Review', messages: [
        { role: 'assistant', text: proposals.map(proposal => '```scratchpad-change\n' + JSON.stringify(proposal) + '\n```').join('\n') },
    ] } });
    await openScratchpad(page);
    const readChat = async () => (await account.post('/api/chats/get', { avatar_url: account.avatar, file_name: chatId })).filter(record => typeof record.mes === 'string');
    const original = await readChat();
    await page.route('**/api/chats/save', route => route.fulfill({ status: 503, json: { error: 'Fixture save failure' } }));
    await page.locator('.scratchpad-change').first().getByRole('button', { name: 'Review', exact: true }).click();
    const refused = page.waitForResponse('**/api/chats/save');
    await page.getByRole('button', { name: 'Save change', exact: true }).click();
    expect((await refused).status()).toBe(503);
    await expect(page.locator('.scratchpad-change.is-applied')).toHaveCount(0);
    expect(await readChat()).toEqual(original);
    await page.unroute('**/api/chats/save');

    const expectedMessages = [
        [{ mes: 'Reviewed original.' }],
        [{ mes: 'Reviewed original.' }, { mes: 'Inserted by review.', is_user: true }],
        [{ mes: 'Reviewed original.' }, { mes: 'Inserted by review.', is_system: true }],
        [{ mes: 'Reviewed original.' }, { mes: 'Inserted by review.', is_system: false }],
        [{ mes: 'Reviewed original.' }],
        [{ mes: 'Reviewed original.' }],
    ];
    for (const [index, messages] of expectedMessages.entries()) {
        const card = page.locator('.scratchpad-change').nth(index);
        await card.getByRole('button', { name: 'Review', exact: true }).click();
        await page.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(card).toContainText('Saved');
        expect(await readChat()).toMatchObject(messages);
    }
    const lore = await account.post('/api/worldinfo/get', { name: 'Scratchpad Garden' });
    expect(Object.values(lore.entries)).toEqual([expect.objectContaining({ content: 'Reviewed lore.', comment: 'Flower', key: ['flower'] })]);
});
