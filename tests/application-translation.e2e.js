/* eslint-env browser */
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(240000);

async function prepare(app, phone) {
    app.provider.mode.reply = body => ({ translatedText: `FR: ${body.q}` });
    app.provider.mode.hold = [undefined];
    const account = await app.account({ phone, configureSettings(saved) {
        saved.extension_settings.translate = { provider: 'libre', target_language: 'fr', internal_language: 'en', auto_mode: 'none', deepl_endpoint: 'free' };
    } });
    await account.post('/api/secrets/write', { key: 'libre_url', value: app.provider.url + '/translate' });
    const fields = { avatar_url: account.avatar, file_name: 'Translation source' };
    const response = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
    expect(response.ok(), await response.text()).toBe(true);
    const vacancy = JSON.parse(response.headers()['x-neconyan-roleplay']);
    const records = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
        { name: 'Durable Nova', is_user: false, mes: 'Original answer.', extra: { reasoning: 'Original reasoning.' },
            swipes: ['Original answer.', 'Another answer.'], swipe_id: 0, swipe_info: [{ extra: { reasoning: 'Original reasoning.' } }, { extra: {} }] },
        { name: 'User', is_user: true, mes: 'Original question.', extra: {} }];
    await account.post('/api/chats/save', { ...fields, chat: records,
        roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    const filename = path.join(app.directory, 'data/default-user/chats', account.avatar.replace(/\.png$/i, ''), fields.file_name + '.jsonl');
    return { account, fields, records, read: async () => (await fs.readFile(filename, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

async function openChat(account, fields) {
    const page = await account.open({ workspace: false, readyTimeout: 60000 });
    await page.evaluate(async ({ avatar_url, file_name }) => {
        const context = window.SillyTavern.getContext();
        const core = await import('/script.js');
        await context.getCharacters();
        await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar_url), { switchMenu: false });
        if (core.getCurrentChatId() !== file_name) await core.openCharacterChat(file_name);
    }, fields);
    await expect(page.locator('#chat .mes').first()).toContainText('Original answer.');
    return page;
}

async function submitChat(page) {
    await page.locator('#extensionsMenuButton').click();
    const response = page.waitForResponse(value => value.url().endsWith('/api/operations/submit') && value.request().postDataJSON()?.kind === 'translation');
    await page.locator('#translate_chat').click();
    const submitted = await response;
    expect(submitted.status(), await submitted.text()).toBe(202);
    return submitted.json();
}

async function savedControls(page) {
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
    await page.getByRole('group', { name: 'Extension settings scope' }).getByRole('button', { name: 'Built-in', exact: true }).click();
    const container = page.locator('#translation_container');
    const select = container.getByLabel('Saved translations', { exact: true });
    if (!await select.isVisible()) await container.locator('.inline-drawer-toggle').click();
    await expect(select).toBeVisible();
    const geometry = await select.evaluate(element => ({ width: element.getBoundingClientRect().width, display: getComputedStyle(element).display }));
    expect(geometry.width).toBeGreaterThan(100);
    expect(geometry.display).not.toBe('none');
    return { container, select };
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`${viewport} whole-chat translation finishes after every page closes and retains swipes`, async ({ app, browser }) => {
        const fixture = await prepare(app, phone);
        const page = await openChat(fixture.account, fixture.fields);
        const accepted = await submitChat(page);
        await expect.poll(() => app.provider.calls.length).toBe(1);
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await app.release();
        await fixture.account.settled(accepted.job.id);
        const rows = await fixture.read();
        expect(rows[1].mes).toBe('Original answer.');
        expect(rows[1].swipes).toEqual(fixture.records[1].swipes);
        expect(rows[1].swipe_id).toBe(0);
        expect(rows[1].extra.display_text).toBe('FR: Original answer.');
        expect(rows[1].extra.reasoning_display_text).toBe('FR: Original reasoning.');
        expect(rows[2].extra.display_text).toBe('FR: Original question.');
        expect(app.provider.calls).toHaveLength(3);
        const reopened = await fixture.account.open({ workspace: false, readyTimeout: 60000 });
        const { container, select } = await savedControls(reopened);
        await select.selectOption(accepted.record.key);
        await expect(container.getByLabel('Saved translation result')).toHaveValue('2 saved messages updated.');
        expect(app.provider.calls).toHaveLength(3);
    });

    test(`${viewport} reopened translation Stop is saved before later fields are sent`, async ({ app, browser }) => {
        const fixture = await prepare(app, phone);
        const page = await openChat(fixture.account, fixture.fields);
        const accepted = await submitChat(page);
        await expect.poll(() => app.provider.calls.length).toBe(1);
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        const reopened = await fixture.account.open({ workspace: false, readyTimeout: 60000 });
        const { container, select } = await savedControls(reopened);
        await select.selectOption(accepted.record.key);
        await container.getByRole('button', { name: 'Stop translation', exact: true }).click();
        await fixture.account.settled(accepted.job.id, 'cancelled');
        await app.release();
        const rows = await fixture.read();
        expect(rows[1].extra.display_text).toBeUndefined();
        expect(rows[2].extra.display_text).toBeUndefined();
        expect(rows[1].swipes).toEqual(fixture.records[1].swipes);
        expect(app.provider.calls).toHaveLength(1);
        await expect(container.getByRole('status')).toContainText('Translation stopped.');
    });
}
