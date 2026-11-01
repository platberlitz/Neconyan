/* global document, window, getComputedStyle */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

async function seedChats(app, avatar) {
    const directory = path.join(app.dataRoot, 'default-user', 'chats', path.parse(avatar).name);
    await fs.mkdir(directory, { recursive: true });
    const names = Array.from({ length: 20 }, (_, i) => `Durable Nova - ${i === 0 ? 'Quiet evening' : i === 1 ? 'Market debate' : `Another scene ${i}`}`);
    for (const [i, name] of names.entries()) {
        const records = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
            { name: 'Durable Nova', is_user: false, mes: `Scene ${i}: a cup of tea.`, send_date: Date.now() - i * 1000, extra: {} }];
        await fs.writeFile(path.join(directory, `${name}.jsonl`), records.map(JSON.stringify).join('\n'));
    }
    return names;
}

for (const phone of [false, true]) {
    test(`chat browser searches, scrolls and switches saved chats on ${phone ? 'iPhone emulation' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, activeConnection: true, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const names = await seedChats(app, account.avatar);
        const page = await account.open({ workspace: false });
        await page.evaluate(async ({ avatar, name }) => {
            const c = window.SillyTavern.getContext();
            await c.getCharacters();
            await c.selectCharacterById(c.characters.findIndex(ch => ch.avatar === avatar), { switchMenu: false });
            await window.NeconyanShell.activateMode('roleplay');
            await c.openCharacterChat(name);
        }, { avatar: account.avatar, name: names[0] });
        if (phone) await applyIOSOnlyCss(page);
        const trigger = page.locator('#sb-bottom-chat-picker-button');
        const panel = page.locator('#sb-bottom-chat-picker');
        await expect(trigger).toContainText('Quiet evening');
        await expect(page.locator('#sb-bottom-chat-select')).toBeHidden();
        await trigger.click();
        await expect(panel.locator('.sb-chat-picker-row')).toHaveCount(20);
        await expect(panel.locator('[aria-current="true"]')).toContainText('Quiet evening');
        const search = panel.getByRole('searchbox');
        if (phone) await expect(search).not.toBeFocused();
        else await expect(search).toBeFocused();
        const box = await panel.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
        expect(box.y + box.height).toBeLessThanOrEqual((await trigger.boundingBox()).y);
        const list = panel.locator('.sb-chat-picker-list');
        expect(await panel.evaluate(el => el.parentElement === document.body)).toBe(true);
        await expect(list).toHaveCSS('overscroll-behavior', 'contain');
        if (phone) {
            const cdp = await account.context.newCDPSession(page);
            const r = await list.boundingBox();
            const x = r.x + r.width / 2;
            const y = r.y + r.height - 30;
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 20 }] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
            await cdp.detach();
        }
        await search.fill('missing chat');
        await expect(panel.getByRole('status')).toContainText('No matching chats');
        await search.press('Escape');
        await expect(search).toHaveValue('');
        await expect(panel).toBeVisible();
        await search.fill('NOVA market tea');
        await expect(panel.locator('.sb-chat-picker-row')).toHaveCount(1);
        await search.press('ArrowDown');
        await expect(panel.locator('.sb-chat-picker-row')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(panel).toHaveCount(0);
        await expect(trigger).toContainText('Market debate');
        await expect(page.locator('#chat')).toContainText('Scene 1: a cup of tea.');
        await trigger.click();
        await expect(panel.locator('[aria-current="true"]')).toContainText('Market debate');
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await trigger.click();
        await page.locator('#sb-persona-bubble').click();
        await expect(panel).toHaveCount(0);
        // Opening the chat browser dismisses the neighbouring persona browser.
        await trigger.click();
        await expect(page.locator('#sb-persona-picker')).toHaveCount(0);
        await page.route('**/api/characters/chats', route => route.fulfill({ status: 503, json: { error: true } }));
        await panel.getByRole('button', { name: 'Close', exact: true }).click();
        await trigger.click();
        await expect(panel.getByRole('status')).toContainText('Chats could not load');
        await panel.getByRole('button', { name: 'Try again', exact: true }).click();
        await page.unroute('**/api/characters/chats');
        await expect(panel.getByRole('status')).toBeHidden();
        await expect(panel.locator('.sb-chat-picker-row')).toHaveCount(20);
        for (const tone of ['Dark', 'Light']) {
            const themeName = `Neconyan Calico${tone === 'Dark' ? ' Dark' : ''}`;
            await page.locator('#themes').selectOption(themeName, { force: true });
            if (!await panel.count()) await trigger.click();
            await expect(panel).toBeVisible();
            for (const accent of ['rgb(214, 146, 112)', 'rgb(216, 241, 226)', 'rgb(67, 25, 53)']) {
                await page.evaluate(accent => document.documentElement.style.setProperty('--SmartThemeQuoteColor', accent), accent);
                const contrast = await panel.evaluate(async () => {
                    const { contrastRatio } = await import('/scripts/theme-contrast.js');
                    const context = document.createElement('canvas').getContext('2d');
                    const channels = colour => {
                        context.fillStyle = colour;
                        context.fillRect(0, 0, 1, 1);
                        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
                    };
                    return [...document.querySelectorAll('#sb-bottom-chat-picker button:not([hidden]), #sb-bottom-chat-picker-button')].map(button => {
                        const style = getComputedStyle(button);
                        return contrastRatio(channels(style.color), channels(style.backgroundColor));
                    });
                });
                expect(Math.min(...contrast), `${tone}, ${accent}: readable buttons`).toBeGreaterThanOrEqual(4.5);
            }
        }
        await page.close();
    });
}

test('group chat rows switch by their original IDs', async ({ app }) => {
    test.setTimeout(120000);
    const account = await app.account({ activeConnection: true });
    const names = ['Group scene - Morning', 'Group scene - Evening'];
    const directory = path.join(app.dataRoot, 'default-user', 'group chats');
    await fs.mkdir(directory, { recursive: true });
    for (const name of names) {
        await fs.writeFile(path.join(directory, `${name}.jsonl`), [
            { user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
            { name: 'Durable Nova', is_user: false, mes: `Retained ${name}.`, original_avatar: account.avatar, extra: {} },
        ].map(JSON.stringify).join('\n'));
    }
    const group = await account.post('/api/groups/create', { name: 'Group scene', members: [account.avatar], chat_id: names[0], chats: names });
    const page = await account.open({ workspace: false });
    await page.evaluate(async id => {
        const groups = await import('/scripts/group-chats.js');
        await groups.openGroupById(id, { switchMenu: false });
        await window.NeconyanShell.activateMode('roleplay');
    }, group.id);
    const trigger = page.locator('#sb-bottom-chat-picker-button');
    await expect(trigger).toContainText('Morning');
    await trigger.click();
    const panel = page.locator('#sb-bottom-chat-picker');
    await expect(panel.locator('.sb-chat-picker-row')).toHaveCount(2);
    await panel.getByRole('button', { name: /Evening/ }).click();
    await expect(trigger).toContainText('Evening');
    await expect(page.locator('#chat')).toContainText('Retained Group scene - Evening.');
    await page.close();
});
