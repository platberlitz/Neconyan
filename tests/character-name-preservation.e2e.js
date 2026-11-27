import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { test } from './neconyan-conversation-durable-fixture.js';

const cases = [
    { label: 'ordinary', name: 'Zed and Co' },
    { label: 'ampersand', name: 'Zed & Co', legacy: true },
    { label: 'comparison', name: 'Zed & Co (2 < 3)', save: true },
    { label: 'literal entity', name: 'Zed &amp; Co (2 < 3)', save: true },
    { label: 'trailing comparison', name: 'Zed & Co <', legacy: true, save: true },
    { label: 'benign tag', name: 'Zed <B>marker</B>', legacy: true, save: true },
];

for (const sample of cases) test(`${sample.label} survives character reads and editing`, async ({ app }) => {
    test.setTimeout(150000);
    const account = await app.account();
    const { avatar, context, headers } = account;
    const fields = { avatar_url: avatar, file_name: 'Name preservation chat' };
    const vacancyResponse = await context.request.post('/api/chats/get', { headers, data: { ...fields, allow_create: true } });
    expect(vacancyResponse.ok()).toBe(true);
    const vacancy = JSON.parse(vacancyResponse.headers()['x-neconyan-roleplay']);
    const chat = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
        { name: 'User', is_user: true, mes: 'Stable association witness.', extra: {} }];
    await account.post('/api/chats/save', { ...fields, chat,
        roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    const association = await context.request.post('/api/characters/edit-attribute', { headers,
        data: { avatar_url: avatar, ch_name: 'Durable Nova', field: 'chat', value: fields.file_name } });
    expect(association.ok()).toBe(true);
    let page = await account.open({ workspace: false });
    const edit = await context.request.post('/api/characters/edit-attribute', { headers,
        data: { avatar_url: avatar, ch_name: 'Durable Nova', field: 'name', value: sample.name } });
    expect(edit.ok()).toBe(true);
    const initial = await account.post('/api/characters/get', { avatar_url: avatar });
    expect(initial.name).toBe(sample.name);
    expect(initial.data.name).toBe(sample.name);
    const display = await page.evaluate(({ name, legacy }) => legacy ? window.DOMPurify.sanitize(name) : name, sample);
    if (sample.label === 'benign tag') expect(display).not.toBe(sample.name);
    expect(initial.chat).toBe(fields.file_name);

    for (const stage of ['single', 'reload']) {
        if (stage === 'single') {
            expect(await page.evaluate(async avatar => (await import('/script.js')).getOneCharacter(avatar), avatar)).toBe(true);
        } else {
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        }
        const card = await page.evaluate(async avatar => {
            const core = await import('/script.js');
            const card = core.characters.find(item => item.avatar === avatar);
            await core.printCharacters();
            window.NeconyanShell.openTab('characters', 'characters');
            return { name: card.name, index: core.characters.indexOf(card), chat: card.chat };
        }, avatar);
        expect(card.name).toBe(display);
        const row = page.locator(`#rm_print_characters_block .character_select[data-chid="${card.index}"]`);
        await expect(row.locator('.ch_name')).toHaveText(display);
        expect(await row.locator('.ch_name').evaluate(node => node.childElementCount)).toBe(0);
        await expect(row.locator('img')).toHaveAttribute('alt', display);
        await expect(row.locator('[data-entity-action="edit-card"]')).toHaveAttribute('aria-label', `Edit ${display}`);
        await row.locator('[data-entity-action="edit-card"]').click();
        await expect(page.locator('#character_name_pole')).toHaveValue(sample.name);
        await expect(page.locator('#rm_button_selected_ch h2')).toHaveText(display);
        const stored = await account.post('/api/characters/get', { avatar_url: avatar });
        expect(stored.name).toBe(sample.name);
        expect(stored.data.name).toBe(sample.name);
        expect(stored.chat).toBe(initial.chat);

        if (stage === 'reload' && sample.save) {
            const response = page.waitForResponse(r => r.url().endsWith('/api/characters/edit') && r.request().method() === 'POST');
            await page.locator('#description_textarea').fill('An unrelated description edit.');
            await page.getByRole('button', { name: 'Save now', exact: true }).click();
            expect((await response).ok()).toBe(true);
            await expect.poll(async () => (await account.post('/api/characters/get', { avatar_url: avatar })).description).toBe('An unrelated description edit.');
            const saved = await account.post('/api/characters/get', { avatar_url: avatar });
            expect(saved.name).toBe(sample.name);
            expect(saved.data.name).toBe(sample.name);
            expect(saved.avatar).toBe(avatar);
            expect(saved.chat).toBe(fields.file_name);
            const savedChat = await account.post('/api/chats/get', fields);
            expect(savedChat.some(row => row.mes === 'Stable association witness.')).toBe(true);
        }
    }

    await page.close();
    page = await account.open({ workspace: true });
    await expect(page.locator('#sb_conversation_input')).toBeVisible({ timeout: 15000 });
    const pal = page.locator(`.sb-conversation-pal[data-avatar="${avatar}"][data-group-id=""]`);
    if (!await pal.isVisible()) await page.locator('[data-sb-conversation-action="toggle-pals"]:visible').first().click();
    await expect(pal.locator('.sb-conversation-pal-name')).toHaveText(display);
    expect(await pal.locator('.sb-conversation-pal-name').evaluate(node => node.childElementCount)).toBe(0);
    const nativeConfirmation = page.waitForEvent('dialog').then(async dialog => { const message = dialog.message(); await dialog.dismiss(); return message; });
    await page.locator(`.sb-conversation-pal-delete[data-avatar="${avatar}"][data-group-id=""]`).click();
    expect(await nativeConfirmation).toContain(display);
    const closeRail = page.locator('[data-sb-conversation-action="close-pals"]:visible');
    if (await closeRail.count()) await closeRail.first().click();
    await page.evaluate(async () => (await import('/scripts/welcome-screen.js')).openWelcomeScreen({ force: true }));
    const recent = page.locator(`article.recentChat[data-recent-chat-type="conversation"][data-avatar="${avatar}"][data-group=""]`).first();
    await expect(recent).toBeVisible({ timeout: 15000 });
    await recent.locator('.deleteChat').evaluate(button => button.click());
    const popup = page.locator('dialog.popup[open]');
    await expect(popup.locator('.popup-content')).toContainText(display);
    expect(await popup.locator('.popup-content b').count()).toBe(0);
    await popup.locator('.popup-button-cancel').click();

    for (const deleteChats of [false, true]) {
        await page.evaluate(({ deleteChats, avatar }) => {
            window.nameDeleteResult = 'pending';
            import('/scripts/slash-commands.js').then(({ executeSlashCommandsWithOptions }) =>
                executeSlashCommandsWithOptions(`/char-delete char="${avatar}" deleteChats=${deleteChats}`)).then(() => { window.nameDeleteResult = 'done'; });
        }, { deleteChats, avatar });
        const confirmation = page.locator('dialog.popup[open]');
        await expect(confirmation.locator('.popup-content')).toContainText(display);
        expect(await confirmation.locator('.popup-content b').count()).toBe(0);
        await confirmation.locator('.popup-button-cancel').click();
        await expect.poll(() => page.evaluate(() => window.nameDeleteResult)).toBe('done');
    }
});
