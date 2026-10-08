/* global globalThis, innerWidth, innerHeight */
import { test } from './neconyan-conversation-durable-fixture.js';
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

async function search(page, query) {
    await page.evaluate(() => globalThis.NeconyanWelcome.activateRoute('search'));
    await page.locator('#sb-universal-search-input').fill(query);
}

for (const phone of [false, true]) {
    test(`global search ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone });
        const notebook = await account.post('/api/notebooks/create', { operationId: 'search:notebook', name: 'Moonlight notebook' });
        await account.post('/api/notebooks/notes/create', { operationId: 'search:note', notebookId: notebook.notebook.id, title: 'Moonlight note', text: 'A sapphire dragon sleeps here.' });
        const worlds = path.join(app.directory, 'data', 'default-user', 'worlds');
        await fs.writeFile(path.join(worlds, 'Moonlight.json'), JSON.stringify({ entries: { 0: {
            uid: 0, comment: 'Moonlight legend', key: ['sapphire'], content: 'A sapphire dragon guards the moon.', disable: false,
        } } }));
        const page = await account.open({ workspace: false });
        await page.evaluate(() => globalThis.NeconyanWelcome.activateRoute('search'));
        const input = page.locator('#sb-universal-search-input');
        await expect(input).toBeVisible();
        await input.fill('notebok');
        const directory = path.resolve('..', 'screenshots');
        await fs.mkdir(directory, { recursive: true });
        await expect(page.locator('.sb-search-result strong', { hasText: 'Notebooks' })).toBeVisible();
        await page.screenshot({ path: path.join(directory, `search-${phone ? 'phone' : 'desktop'}-after.png`) });
        await search(page, 'saphire');
        const note = page.locator('.sb-search-result', { has: page.locator('strong', { hasText: 'Moonlight note' }) });
        await expect(note).toBeVisible();
        await expect(page.locator('.sb-search-result strong', { hasText: 'Moonlight legend' })).toBeVisible();
        const geometry = await page.locator('#sb-universal-search-results').evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, bottom: rect.bottom, height: rect.height, width: innerWidth, viewportHeight: innerHeight };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.width);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
        expect(geometry.height).toBeGreaterThan(0);
        await page.screenshot({ path: path.join(directory, `search-${phone ? 'phone' : 'desktop'}-saved.png`) });
        await note.click();
        await expect(page.getByRole('textbox', { name: 'Note name', exact: true })).toHaveValue('Moonlight note', { timeout: 30000 });
        await search(page, 'moonlight legend');
        await page.locator('.sb-search-result', { has: page.locator('strong', { hasText: 'Moonlight legend' }) }).click();
        await expect(page.locator('#world_editor_select')).toHaveValue('0');
        await expect(page.locator('#world_popup')).toContainText('Moonlight legend');
        await search(page, 'original question');
        const chat = page.locator('.sb-search-result').filter({ hasText: 'Open chat' });
        await expect(chat).toHaveCount(1);
        await chat.click();
        await expect(page.locator('#sb_conversation_input')).toBeVisible();
        await expect(page.locator('#sb_conversation_timeline')).toContainText('Original question');
        expect(app.provider.calls).toHaveLength(0);
    });
}

test('saved search rejects foreign account headers and ignores stale responses', async ({ app }) => {
    test.setTimeout(120000);
    const account = await app.account();
    const forbidden = await account.context.request.post('/api/account-search', {
        headers: { ...account.headers, 'X-Neconyan-Account': 'another-user' }, data: { query: 'Nova' },
    });
    expect(forbidden.status()).toBe(409);
    const page = await account.open({ workspace: false });
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { started = resolve; });
    await page.route('**/api/account-search', async route => {
        if (route.request().postDataJSON().query !== 'oldquery') return route.continue();
        started();
        await gate;
        await route.fulfill({ json: { results: [{ id: 'old', kind: 'note', title: 'Stale result', target: {} }], unavailable: [], nextOffset: null } });
    });
    await search(page, 'oldquery');
    await waiting;
    await search(page, 'notebok');
    release();
    await expect(page.locator('.sb-search-result strong', { hasText: 'Notebooks' })).toBeVisible();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('#sb-universal-search-results')).not.toContainText('Searching saved content');
    await expect(page.locator('#sb-universal-search-results')).not.toContainText('Stale result');
});

test('saved search pages through results, retries errors and opens personas, characters and saved roleplay', async ({ app }) => {
    test.setTimeout(120000);
    const account = await app.account({ configureSettings: saved => {
        saved.power_user.personas[saved.user_avatar] = 'Amethyst traveller';
        saved.power_user.persona_descriptions[saved.user_avatar] = { description: 'A traveller who studies comets.' };
    } });
    const root = path.join(app.directory, 'data', 'default-user');
    await fs.writeFile(path.join(root, 'worlds', 'Many.json'), JSON.stringify({ entries: Object.fromEntries(
        Array.from({ length: 65 }, (_, uid) => [uid, { uid, comment: `Quetzal ${uid}`, key: ['quetzal'], content: 'A rare bird.' }]),
    ) }));
    const chats = path.join(root, 'chats', account.avatar.slice(0, -4));
    await fs.mkdir(chats, { recursive: true });
    await fs.writeFile(path.join(chats, 'Saved expedition.jsonl'), [
        { user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
        { name: 'Durable Nova', is_user: false, mes: 'The heliotrope expedition has arrived.' },
    ].map(row => JSON.stringify(row)).join('\n'));
    await fs.writeFile(path.join(root, 'chats', 'Lost expedition.jsonl'), [
        { user_name: 'User', character_name: 'Lost character', chat_metadata: {} },
        { name: 'Lost character', is_user: false, mes: 'The chrysanthemum expedition is preserved.' },
    ].map(row => JSON.stringify(row)).join('\n'));
    const page = await account.open({ workspace: false });
    await search(page, 'quetzal');
    const entries = page.locator('.sb-search-result').filter({ hasText: 'Open entry' });
    await expect(entries).toHaveCount(30);
    await page.getByRole('option', { name: 'More saved results', exact: true }).click();
    await expect(entries).toHaveCount(60);
    await page.getByRole('option', { name: 'More saved results', exact: true }).click();
    await expect(entries).toHaveCount(65);
    await expect(page.getByRole('option', { name: 'More saved results', exact: true })).toHaveCount(0);
    const unavailable = route => route.request().postDataJSON().query === 'notebok'
        ? route.fulfill({ status: 503, json: {} }) : route.continue();
    await page.route('**/api/account-search', unavailable);
    await search(page, 'notebok');
    await expect(page.locator('.sb-search-result strong', { hasText: 'Notebooks' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Retry saved-content search', exact: true })).toBeVisible();
    await page.unroute('**/api/account-search', unavailable);
    await page.getByRole('option', { name: 'Retry saved-content search', exact: true }).click();
    await expect(page.locator('#sb-universal-search-results')).not.toContainText('Searching saved content');
    await expect(page.getByRole('option', { name: 'Retry saved-content search', exact: true })).toHaveCount(0);
    await search(page, 'amethist traveller');
    await page.locator('.sb-search-result').filter({ hasText: 'Find persona' }).click();
    await expect(page.locator('#persona_search_bar')).toHaveValue('Amethyst traveller');
    await expect(page.locator('#user_avatar_block .avatar-container').filter({ hasText: 'Amethyst traveller' })).toBeVisible();
    await search(page, 'durable nova');
    await page.locator('.sb-search-result').filter({ hasText: 'Open character' }).click();
    await expect(page.locator('#character_name_pole')).toHaveValue('Durable Nova');
    await expect(page.locator('.sb-character-shell-header .sb-shell-title')).toHaveText('Editor');
    await expect(page.locator('.sb-character-shell-header .sb-shell-title')).toBeVisible();
    await search(page, 'heliotrope');
    await page.locator('.sb-search-result').filter({ hasText: 'Open chat' }).click();
    await expect(page.locator('#chat')).toContainText('The heliotrope expedition has arrived.');
    await search(page, 'chrysanthemum');
    await page.locator('.sb-search-result').filter({ hasText: 'Find in Chat Archive' }).click();
    await expect(page.locator('.sbca-dialog')).toContainText('The chrysanthemum expedition is preserved.');
    expect(app.provider.calls).toHaveLength(0);
});
