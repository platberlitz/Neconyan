/* eslint-env browser */
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(240000);

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Mewmory shares native prefixes and retrieves file passages`, async ({ app }, info) => {
        app.provider.mode.reply = body => ({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
        const account = await app.account({ phone, configureSettings(saved) {
            saved.extension_settings.vectors = { source: 'llamacpp', use_alt_endpoint: true, alt_endpoint_url: app.provider.url,
                enabled_chats: false, enabled_files: false, enabled_world_info: false };
            saved.extension_settings.attachments = [{ url: '/user/files/rag-reference.txt', name: 'RAG reference' }];
        } });
        await fs.writeFile(path.join(app.directory, 'data/default-user/user/files/rag-reference.txt'), 'The lunar garden has a silver gate. The key is kept beneath the blue flowerpot.');
        const chat = 'RAG fixture';
        const fields = { avatar_url: account.avatar, file_name: chat };
        const vacant = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
        expect(vacant.ok()).toBe(true);
        const vacancy = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
        await account.post('/api/chats/save', { ...fields, chat: [{ chat_metadata: {} },
            { name: 'Nova', is_user: false, mes: 'Tell me about the lunar garden.' }],
        roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
        const page = await account.open({ workspace: false });
        await page.waitForLoadState('networkidle'); // eslint-disable-line playwright/no-networkidle -- Inspect the loaded extension workspace before interacting.
        await page.evaluate(async fields => {
            const core = await import('/script.js');
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await core.selectCharacterById(context.characters.findIndex(character => character.avatar === fields.avatar_url), { switchMenu: false });
            await core.openCharacterChat(fields.file_name);
            window.NeconyanShell.openTab('right', 'extensions');
        }, fields);
        await page.getByRole('group', { name: 'Extension settings scope' }).getByRole('button', { name: 'Built-in', exact: true }).click();
        const vectors = page.locator('#vectors_container');
        if (!await vectors.locator('.vectors-nav').isVisible()) await vectors.locator('.inline-drawer-toggle').click();
        await vectors.locator('[data-vectors-tab="connection"]').click();
        await vectors.getByLabel('Prefix preset', { exact: true }).selectOption('1');
        await expect(vectors.getByLabel('Query prefix', { exact: true })).toHaveValue('query: ');
        await vectors.getByLabel('Document prefix', { exact: true }).fill('passage: \n ');
        await page.evaluate(async () => { await (await import('/script.js')).saveSettings(); });
        await vectors.getByLabel('Document prefix', { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath('native-prefixes.png') });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        const workspace = page.locator('#mewmory-workspace');
        await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
        await workspace.getByLabel('Update automatically during play', { exact: true }).uncheck();
        await workspace.getByLabel('Writer tokenizer', { exact: true }).selectOption('o200k_base');
        await workspace.getByLabel('Passage size, characters', { exact: true }).fill('800');
        await workspace.getByLabel('Passage overlap, characters', { exact: true }).fill('100');
        await workspace.getByLabel('Meaning weight, 0 to 1', { exact: true }).fill('0.7');
        await workspace.getByLabel('Maximum selected results', { exact: true }).fill('4');
        await workspace.locator('#mewmory-role-embedding').click();
        await workspace.getByLabel('Enable this role', { exact: true }).check();
        await workspace.getByLabel('Embedding connection', { exact: true }).selectOption('native');
        await workspace.getByRole('button', { name: 'Save configuration', exact: true }).click();
        await expect(workspace.locator('#mewmory-settings-status')).toHaveText('Configuration saved.');
        await expect(workspace.getByLabel('Query prefix, optional', { exact: true })).toHaveValue('query: ');
        await expect(workspace.getByLabel('Document prefix, optional', { exact: true })).toHaveValue('passage: \n ');
        await expect(workspace.getByLabel('Document prefix, optional', { exact: true })).toBeDisabled();
        await workspace.getByLabel('Use Mewmory in this chat', { exact: true }).check();
        await expect(workspace.getByText('Facts and events is switched off. Original passages remain searchable.', { exact: true })).toBeVisible();
        const locator = { avatar: account.avatar, chat, group: false };
        const saved = (await account.post('/api/mewmory/config/get')).config;
        expect(saved.retrieval).toMatchObject({ chunkSize: 800, chunkOverlap: 100, semanticWeight: 0.7, resultLimit: 4 });
        expect(saved.roles.embedding.native.documentPrefix).toBe('passage: \n ');
        expect((await account.post('/api/mewmory/index', { locator })).remaining).toBe(0);
        expect(app.provider.calls.flatMap(call => call.input || []).some(text => text.startsWith('passage: \n ')
            && text.includes('The lunar garden has a silver gate.'))).toBe(true);
        await workspace.getByRole('tab', { name: 'Archive', exact: true }).click();
        await workspace.getByLabel('Search memories and original messages', { exact: true }).fill('garden');
        await workspace.getByLabel('Search source', { exact: true }).selectOption('file');
        await workspace.getByLabel('Search method', { exact: true }).selectOption('semantic');
        await workspace.getByRole('button', { name: 'Search archive', exact: true }).click();
        await expect(workspace.getByText('Search used semantic matching across 1 passages.', { exact: true })).toBeVisible();
        await expect(workspace.getByText(/Meaning similarity: 1.000/)).toBeVisible();
        await expect(workspace.getByText(/The key is kept beneath the blue flowerpot/)).toBeVisible();
        expect(app.provider.calls.at(-1).input).toEqual(['query: garden']);
        const recalled = await account.post('/api/mewmory/recall', { locator, query: 'garden' });
        expect(recalled.memoryText).toContain('blue flowerpot');
        expect(recalled.inspection.retrieval.aiSelection).toBe(false);
        await workspace.getByRole('button', { name: 'Refresh', exact: true }).click();
        await workspace.getByRole('tab', { name: 'Recall', exact: true }).click();
        await expect(workspace.getByRole('heading', { name: 'Included passages and memories', exact: true }).first()).toBeVisible();
        await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
        // The completed refresh can replace the settings fields once after switching tabs.
        await expect(async () => {
            await workspace.getByLabel('Passage size, characters', { exact: true }).scrollIntoViewIfNeeded();
            await expect(workspace.getByLabel('Passage size, characters', { exact: true })).toBeInViewport();
        }).toPass({ timeout: 10000 });
        const geometry = await workspace.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth,
            font: getComputedStyle(element.querySelector('input')).fontSize,
            controls: [...element.querySelectorAll('.mewmory-fields input, .mewmory-fields select, .mewmory-fields textarea')]
                .map(control => ({ width: control.getBoundingClientRect().width, height: control.getBoundingClientRect().height })),
            pageWidth: document.documentElement.clientWidth, pageScroll: document.documentElement.scrollWidth }));
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
        expect(geometry.pageScroll).toBeLessThanOrEqual(geometry.pageWidth + 1);
        expect(geometry.controls.every(control => control.width > 100 && control.height >= 32)).toBe(true);
        await info.attach('RAG geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('mewmory-rag-settings.png') });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
        await expect(workspace.getByLabel('Passage size, characters', { exact: true })).toHaveValue('800');
        await workspace.locator('#mewmory-role-embedding').click();
        await expect(workspace.getByLabel('Embedding connection', { exact: true })).toHaveValue('native');
        await expect(workspace.getByLabel('Document prefix, optional', { exact: true })).toHaveValue('passage: \n ');
    });
}
