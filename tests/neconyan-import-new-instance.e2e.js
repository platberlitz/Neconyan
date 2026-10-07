/* global window, document, getComputedStyle */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const rows = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {
    neconyan_roleplay: { schema: 1, instanceId: 'foreign-instance', revision: 90, writeId: 'foreign-write' }, integrity: 'foreign-seal',
} }, ...Array.from({ length: 50 }, (_, index) => ({ name: index % 2 ? 'Durable Nova' : 'User', is_user: index % 2 === 0,
    mes: `Imported message ${index + 1}`, send_date: '2099-01-01T00:00:00.000+08:00', extra: {} }))];
const upload = name => ({ name, mimeType: 'application/json', buffer: Buffer.from(rows.map(JSON.stringify).join('\n')) });

async function select(page, avatar) {
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        const core = await import('/script.js');
        await core.getOneCharacter(avatar, { allowInsert: true });
        await core.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
    }, avatar);
}

async function showOptions(page) {
    await page.locator('#option_select_chat').evaluate(element => element.click());
    await expect(page.locator('#shadow_select_chat_popup')).toBeVisible();
    await page.locator('#chat_import_instance_options summary').click();
    await expect(page.locator('#chat_import_new_instance')).not.toBeChecked();
}

async function importButtonContrast(page) {
    return page.locator('#sb_character_chat_import_action').evaluate(button => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const rgba = colour => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = colour;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
        };
        const luminance = rgb => rgb.slice(0, 3).reduce((sum, value, i) => sum
            + (value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i], 0);
        const background = rgba(getComputedStyle(button).backgroundColor);
        return [...button.querySelectorAll('strong, small')].map(label => {
            const style = getComputedStyle(label);
            const ink = rgba(style.color);
            const alpha = ink[3] / 255 * Number(style.opacity);
            const text = luminance(ink.map((value, i) => value * alpha + background[i] * (1 - alpha)));
            const surface = luminance(background);
            return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
        });
    });
}

for (const phone of [false, true]) {
    test(`explicit adoption preserves 50 messages and selects one separate character on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        await select(page, account.avatar);
        const cardFile = path.join(app.directory, 'data', 'default-user', 'characters', account.avatar);
        const originalCard = await fs.readFile(cardFile);
        await showOptions(page);
        const refused = page.waitForResponse(response => response.url().endsWith('/api/chats/import'));
        await page.locator('#chat_import_file').setInputFiles(upload('Foreign.jsonl'));
        expect((await refused).status()).toBe(409);
        await expect(page.locator('#chat_import_file')).toHaveValue('');
        await expect(page.locator('#toast-container')).toContainText('Import as new instance');
        await page.locator('#chat_import_instance_options summary').click();
        await expect(page.locator('#chat_import_new_instance')).not.toBeChecked();
        await expect(page.locator('#chat_import_new_instance_help')).toContainText('one-way');
        await page.locator('#toast-container').evaluate(element => element.remove());
        await fs.mkdir('../screenshots', { recursive: true });
        await page.screenshot({ path: `../screenshots/import-${phone ? 'phone' : 'desktop'}-after.png` });
        const geometry = await page.locator('#chat_import_instance_options').evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, right: rect.right, width: window.innerWidth,
                labelHeight: element.querySelector('label').getBoundingClientRect().height,
                summaryHeight: element.querySelector('summary').getBoundingClientRect().height };
        });
        expect(geometry.x).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.width);
        expect(geometry.labelHeight).toBeGreaterThanOrEqual(44);
        expect(geometry.summaryHeight).toBeGreaterThanOrEqual(44);
        await page.locator('#chat_import_new_instance').check();
        const accepted = page.waitForResponse(response => response.url().endsWith('/api/chats/import'));
        await page.locator('#chat_import_file').setInputFiles([upload('First.jsonl'), upload('Second.jsonl')]);
        const response = await accepted;
        expect(response.status(), await response.text()).toBe(200);
        const result = await response.json();
        expect(result.fileNames).toHaveLength(2);
        const avatar = result.roleplay.character.avatar;
        expect(avatar).not.toBe(account.avatar);
        // Selection waits for the normal 50-message render and chat-change listeners.
        await expect(page.locator('#chat_import_file')).toHaveValue('', { timeout: 30000 });
        await expect.poll(() => page.evaluate(() => {
            const context = window.SillyTavern.getContext();
            return context.characters[context.characterId]?.avatar;
        })).toBe(avatar);
        expect(await fs.readFile(cardFile)).toEqual(originalCard);
        const folder = path.join(app.directory, 'data', 'default-user', 'chats', avatar.replace('.png', ''));
        expect((await fs.readdir(folder)).filter(name => name.endsWith('.jsonl'))).toHaveLength(2);
        for (const name of result.fileNames) {
            const records = (await fs.readFile(path.join(folder, name + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
            expect(records.slice(1)).toEqual(rows.slice(1));
            expect(records[0].chat_metadata.neconyan_roleplay.instanceId).not.toBe('foreign-instance');
            const loaded = await account.context.request.post('/api/chats/get', { headers: account.headers,
                data: { avatar_url: avatar, file_name: name } });
            expect(loaded.status(), await loaded.text()).toBe(200);
            expect(await loaded.json()).toHaveLength(51);
        }
        await expect(page.locator('#chat_import_new_instance')).not.toBeChecked();
        expect(app.provider.calls).toHaveLength(0);
        await page.close();
    });
}

for (const phone of [false, true]) {
    test(`the main Import tab adopts chats without opening Chat History on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        await page.evaluate(() => window.NeconyanShell.openTab('characters', 'import'));
        const panel = page.locator('#sb_character_import_panel');
        await expect(panel).toBeVisible();
        const consent = panel.locator('#sb_character_import_new_instance');
        await expect(consent).not.toBeChecked();
        // Character-card import stays the first step on this page for a new user.
        const imported = page.waitForResponse(response => response.url().endsWith('/api/characters/import'));
        await page.locator('#character_import_file').setInputFiles(path.join(app.directory, 'data', 'default-user', 'characters', account.avatar));
        const sourceAvatar = (await (await imported).json()).file_name + '.png';
        await expect(page.locator('#character_import_file')).toHaveValue('', { timeout: 20000 });
        await page.evaluate(() => window.NeconyanShell.openTab('characters', 'import'));
        await expect(panel.locator('#sb_character_chat_import_target')).toContainText('Durable Nova');
        await expect(consent).not.toBeChecked();
        await expect(page.locator('#shadow_select_chat_popup')).toBeHidden();
        await expect(panel.locator('#sb_character_chat_import_action')).toBeEnabled();
        await expect(panel).toContainText('one-way');
        await fs.mkdir('../screenshots', { recursive: true });
        await panel.locator('#sb_character_chat_import_options').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/main-import-${phone ? 'phone' : 'desktop'}-after.png` });
        const geometry = await panel.evaluate(element => ({
            bottom: element.getBoundingClientRect().bottom,
            buttonBottom: element.querySelector('#sb_character_chat_import_action').getBoundingClientRect().bottom,
            labelHeight: element.querySelector('label').getBoundingClientRect().height,
        }));
        expect(geometry.bottom).toBeGreaterThanOrEqual(geometry.buttonBottom);
        expect(geometry.labelHeight).toBeGreaterThanOrEqual(44);
        for (const contrast of await importButtonContrast(page)) expect(contrast).toBeGreaterThanOrEqual(4.5);
        for (const profile of ['Pearl', 'Midnight Ink']) {
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'background'));
            await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${profile} accent profile"]`).evaluate(element => element.click());
            await page.evaluate(() => window.NeconyanShell.openTab('characters', 'import'));
            for (const contrast of await importButtonContrast(page)) expect(contrast).toBeGreaterThanOrEqual(4.5);
        }
        await consent.check();
        const accepted = page.waitForResponse(response => response.url().endsWith('/api/chats/import'));
        await panel.locator('#sb_character_chat_import_file').setInputFiles([upload('Main first.jsonl'), upload('Main second.jsonl')]);
        const response = await accepted;
        expect(response.status(), await response.text()).toBe(200);
        const result = await response.json();
        expect(result.fileNames).toHaveLength(2);
        expect(result.roleplay.character.avatar).not.toBe(sourceAvatar);
        expect(result.roleplay.character.avatar).not.toBe(account.avatar);
        await expect(panel.locator('#sb_character_chat_import_file')).toHaveValue('', { timeout: 30000 });
        expect(await page.evaluate(() => {
            const context = window.SillyTavern.getContext();
            return context.characters[context.characterId]?.avatar;
        })).toBe(result.roleplay.character.avatar);
        await page.evaluate(() => window.NeconyanShell.openTab('characters', 'import'));
        await expect(consent).not.toBeChecked();
        await page.close();
    });
}

test('an uncertain adoption reuses its identity after reopening and never selects a copy after switching characters', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    let page = await account.open({ workspace: false });
    await select(page, account.avatar);
    await showOptions(page);
    await page.locator('#chat_import_new_instance').check();
    const attempts = [];
    await page.route('**/api/chats/import', async route => {
        const response = await route.fetch();
        attempts.push(await response.json());
        await route.abort('failed');
    });
    await page.locator('#chat_import_file').setInputFiles(upload('Foreign retry.jsonl'));
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await page.close();
    page = await account.open({ workspace: false });
    await select(page, account.avatar);
    await showOptions(page);
    await page.locator('#chat_import_new_instance').check();
    const other = await account.context.request.post('/api/characters/create', { headers: account.headers,
        data: { ch_name: 'Other selection', first_mes: 'Stay here.' } });
    const otherAvatar = await other.text();
    await page.route('**/api/chats/import', async route => {
        const response = await route.fetch();
        expect(await response.json()).toEqual(attempts[0]);
        await select(page, otherAvatar);
        await route.fulfill({ response });
    });
    await page.locator('#chat_import_file').setInputFiles(upload('Foreign retry.jsonl'));
    await expect(page.locator('#chat_import_file')).toHaveValue('');
    expect(await page.evaluate(() => {
        const context = window.SillyTavern.getContext();
        return context.characters[context.characterId]?.avatar;
    })).toBe(otherAvatar);
    const cards = await fs.readdir(path.join(app.directory, 'data', 'default-user', 'characters'));
    expect(cards.filter(name => name.startsWith('Imported-'))).toHaveLength(1);
    await page.close();
});
