/* global window */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

for (const phone of [false, true]) {
    test(`player memory stays separate from NPCs on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        const account = await app.account({ phone, configureSettings: settings => {
            settings.username = 'Robin';
            settings.power_user.default_persona = settings.user_avatar;
            settings.power_user.persona_description = 'Robin is a mapmaker with a blue coat and a brass compass.';
            settings.power_user.personas[settings.user_avatar] = 'Robin';
            settings.power_user.persona_descriptions[settings.user_avatar] = {
                description: settings.power_user.persona_description, position: 0, depth: 2, role: 0,
                lorebook: '', connections: [], title: '', appendices: [], activeAppendices: {},
            };
        } });
        const chat = 'Player memory';
        const locator = { avatar: account.avatar, chat, group: false };
        const vacant = await account.context.request.post('/api/chats/get', { headers: account.headers,
            data: { avatar_url: account.avatar, file_name: chat, allow_create: true } });
        expect(vacant.ok()).toBe(true);
        const vacancy = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
        await account.post('/api/chats/save', { avatar_url: account.avatar, file_name: chat,
            chat: [{ chat_metadata: {} },
                { name: 'Robin', is_user: true, mes: 'I give Nova the harbour key.', send_date: '2026-01-01' },
                { name: 'Nova', is_user: false, mes: 'Nova puts the key in her pocket.', send_date: '2026-01-02' }],
            roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() },
        });
        app.provider.mode.reply = body => {
            const input = JSON.parse(body.messages.at(-1).content);
            expect(input.sources.find(source => source.entityId === 'player').text).toBe('Robin');
            expect(input.existing.find(record => record.entityId === 'player').text).toBe('Robin');
            expect(JSON.stringify(input)).not.toContain('mapmaker with a blue coat and a brass compass');
            const refs = input.sources.filter(source => source.type === 'chat').map(({ id, revision }) => ({ id, revision }));
            return { choices: [{ message: { role: 'assistant', content: JSON.stringify({
                records: [{ id: 'state:player', kind: 'state', entityId: 'player', text: 'Robin has given Nova the harbour key.', refs }],
                activeNpcIds: [], interviews: [],
            }) } }] };
        };
        const { config } = await account.post('/api/mewmory/config/get');
        config.autoUpdate = false;
        config.excludeHistory = false;
        config.writerTokenizer = 'cl100k_base';
        for (const role of Object.values(config.roles)) role.enabled = false;
        Object.assign(config.roles.extractor, { enabled: true, useShared: false, endpoint: app.provider.url, model: 'extractor' });
        await account.post('/api/mewmory/config/save', { config });
        const initial = await account.post('/api/mewmory/inspect', { locator });
        await account.post('/api/mewmory/enabled', { locator, revision: initial.revision, enabled: true });
        const processed = await account.post('/api/mewmory/process', { locator, all: true });
        expect(processed.playerReferences.records).toHaveLength(2);
        expect(processed.activeReferences.ids).toEqual([]);
        expect(processed.entities.find(record => record.entityId === 'player').isCharacter).toBe(false);

        const page = await account.open({ workspace: false });
        const open = async () => page.evaluate(async ({ avatar, chat }) => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            await (await import('/script.js')).openCharacterChat(chat);
            window.NeconyanShell.openTab('left', 'mewmory');
        }, { avatar: account.avatar, chat });
        await open();
        const workspace = page.locator('#mewmory-workspace');
        await workspace.getByRole('tab', { name: 'Now', exact: true }).click();
        const player = workspace.locator('.mewmory-section').filter({ has: page.getByRole('heading', { name: 'Your character', exact: true }) });
        await expect(player).toContainText('Robin');
        await expect(player).not.toContainText('blue coat and a brass compass');
        await expect(player).toContainText('Robin has given Nova the harbour key.');
        await expect(player).toContainText('unless you ask the AI to write them');
        await expect(player.locator('.mewmory-badge')).toHaveText('Your character');
        const cast = workspace.locator('.mewmory-section').filter({ has: page.getByRole('heading', { name: 'Active NPCs', exact: true }) });
        await expect(cast.getByLabel('Robin', { exact: true })).toHaveCount(0);
        await player.getByRole('heading', { name: 'Your character', exact: true }).scrollIntoViewIfNeeded();
        await player.evaluate(element => {
            const tabs = element.closest('#mewmory-workspace').querySelector('[role="tablist"]');
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(window.getComputedStyle(parent).overflowY)) {
                    parent.scrollTop += element.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom - 16;
                    break;
                }
            }
        });
        await expect(page.locator('#toast-container')).toBeHidden({ timeout: 20000 });
        const bounds = await player.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        const screenshot = info.outputPath(`mewmory-player-${phone ? 'phone' : 'desktop'}.png`);
        await page.screenshot({ path: screenshot });
        await info.attach('Player memory', { path: screenshot, contentType: 'image/png' });
        if (process.env.NECONYAN_SCREENSHOT_DIRECTORY) {
            await fs.mkdir(process.env.NECONYAN_SCREENSHOT_DIRECTORY, { recursive: true });
            await fs.copyFile(screenshot, path.join(process.env.NECONYAN_SCREENSHOT_DIRECTORY, `mewmory-player-${phone ? 'phone' : 'desktop'}-after.png`));
        }

        await player.locator('[data-kind="entity"]').getByRole('button', { name: 'Edit', exact: true }).click();
        const editor = workspace.locator('#mewmory-editor');
        await expect(editor).toContainText('Your character is user-controlled');
        await expect(editor.getByLabel('AI-controlled character', { exact: true })).toHaveCount(0);
        await editor.getByRole('button', { name: 'Cancel edit', exact: true }).click();
        await workspace.getByRole('button', { name: 'Preview next memory', exact: true }).click();
        const preview = workspace.locator('.mewmory-prompt');
        await expect(preview).not.toContainText('user-controlled player reference');
        await expect(preview).not.toContainText('mapmaker with a blue coat and a brass compass');
        await expect(preview).toContainText('unless the user asks');
        await expect(preview).toContainText('Robin has given Nova the harbour key.');
        expect(app.provider.calls.filter(call => call.model === 'extractor').length).toBeGreaterThan(0);
        expect(app.provider.calls.some(call => call.model === 'pawspective')).toBe(false);
    });
}
