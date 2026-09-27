/* eslint-env browser */
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(300000);

async function showImporter(account) {
    const page = await account.open({ workspace: false, readyTimeout: 60000 });
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    const categories = page.locator('.sb-settings-category-select');
    if (await categories.isVisible()) await categories.selectOption('system-device');
    else await page.locator('.sb-settings-tab-btn[data-tab="system-device"]').click();
    const section = page.locator('#SillyTavernImportSection');
    if (!await page.locator('#sb-import-path-input').isVisible()) await section.locator('.inline-drawer-toggle').first().click();
    const card = page.locator('#sb-import-card');
    await expect(card.getByLabel('Saved account imports')).toBeVisible();
    const geometry = await card.evaluate(element => ({ width: element.getBoundingClientRect().width, display: getComputedStyle(element).display }));
    expect(geometry.width).toBeGreaterThan(250); expect(geometry.display).not.toBe('none');
    page.on('dialog', dialog => dialog.accept());
    return { page, card };
}

async function submit(page, action) {
    const response = page.waitForResponse(value => value.url().endsWith('/api/operations/submit') && value.request().postDataJSON()?.kind === 'account-import');
    await action();
    const accepted = await response;
    expect(accepted.status(), await accepted.text()).toBe(202);
    return { ...await accepted.json(), requestBody: accepted.request().postDataJSON() };
}

async function closeAll(page, browser) {
    await page.close(); expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    for (const mode of ['folder', 'zip']) test(`${viewport} whole ${mode} account import finishes with pages closed and does not repeat after deletion`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        const fields = { avatar_url: account.avatar, file_name: 'Imported history' };
        const vacant = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
        const vacancy = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
        const old = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {}, preserved: true },
            { name: 'Durable Nova', is_user: false, mes: 'Old selected reply.', swipes: ['Old first reply.', 'Old selected reply.'], swipe_id: 1, extra: {} }];
        await account.post('/api/chats/save', { ...fields, chat: old, roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
        const rows = structuredClone(old); rows[1].mes = 'Imported selected reply.'; rows[1].swipes = ['Imported first reply.', rows[1].mes];
        rows[1].extra.reasoning = 'Imported selected reasoning.';
        rows[1].swipe_info = [{ extra: { reasoning: 'First alternative reasoning.' } }, { extra: { reasoning: rows[1].extra.reasoning } }];
        const relative = `chats/${account.avatar.replace(/\.png$/i, '')}/${fields.file_name}.jsonl`;
        const text = rows.map(row => JSON.stringify(row)).join('\n');
        const source = path.join(app.directory, 'source-account');
        await fs.mkdir(path.join(source, path.dirname(relative)), { recursive: true });
        await fs.writeFile(path.join(source, relative), text);
        await fs.mkdir(path.join(source, 'user/files'), { recursive: true });
        await fs.writeFile(path.join(source, 'user/files/imported.bin'), Buffer.alloc(2 * 1024 * 1024 + 31, 73));
        const { page, card } = await showImporter(account);
        let submitted;
        if (mode === 'folder') {
            await card.getByLabel('SillyTavern folder path').fill(source);
            submitted = await submit(page, () => card.getByRole('button', { name: 'Import Folder', exact: true }).click());
        } else {
            const archive = archiver('zip'); const chunks = []; archive.on('data', chunk => chunks.push(chunk));
            archive.directory(source, 'default-user'); await archive.finalize();
            submitted = await submit(page, () => card.getByLabel('Choose a SillyTavern backup ZIP').setInputFiles({ name: 'account.zip', mimeType: 'application/zip', buffer: Buffer.concat(chunks) }));
        }
        await closeAll(page, browser);
        await account.settled(submitted.job.id);
        const destination = path.join(app.directory, 'data/default-user', relative);
        const saved = (await fs.readFile(destination, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
        expect(saved[0].preserved).toBe(true); expect(saved.slice(1)).toEqual(rows.slice(1));
        expect((await fs.stat(path.join(app.directory, 'data/default-user/user/files/imported.bin'))).size).toBe(2 * 1024 * 1024 + 31);
        await fs.rm(destination);
        const replay = await account.post('/api/operations/submit', submitted.requestBody);
        expect(replay.record.state).toBe('completed');
        expect(await fs.access(destination).then(() => true, () => false)).toBe(false);
        const reopened = await showImporter(account);
        await reopened.card.getByLabel('Saved account imports').selectOption(submitted.record.key);
        await expect(reopened.card.getByRole('button', { name: 'Reload imported account', exact: true })).toBeVisible();
        await expect(reopened.card.getByText(/imported files are saved/)).toBeVisible();
        expect(await fs.access(destination).then(() => true, () => false)).toBe(false);
        expect(app.provider.calls).toHaveLength(0);
    });

    test(`${viewport} extension replacement finishes with pages closed and retains its manifest report`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        const source = path.join(app.directory, 'source-extensions');
        const folder = path.join(source, 'extensions/ImportedTool');
        await fs.mkdir(path.join(folder, '.git'), { recursive: true });
        await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ display_name: 'Imported Tool', version: '1.2', author: 'Fixture', js: 'index.js' }));
        await fs.writeFile(path.join(folder, 'index.js'), 'export const imported = true;');
        await fs.writeFile(path.join(folder, '.git/config'), 'Do not copy Git metadata.');
        const target = path.join(app.directory, 'data/default-user/extensions/ImportedTool');
        await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'obsolete.txt'), 'Old helper');
        const { page, card } = await showImporter(account);
        await card.getByLabel('SillyTavern folder path').fill(source);
        const submitted = await submit(page, () => card.getByRole('button', { name: 'Sync Extensions', exact: true }).click());
        await closeAll(page, browser); await account.settled(submitted.job.id);
        expect(await fs.readFile(path.join(target, 'index.js'), 'utf8')).toBe('export const imported = true;');
        expect(await fs.access(path.join(target, 'obsolete.txt')).then(() => true, () => false)).toBe(false);
        expect(await fs.access(path.join(target, '.git/config')).then(() => true, () => false)).toBe(false);
        await fs.writeFile(path.join(target, 'obsolete.txt'), 'A later helper');
        expect((await account.post('/api/operations/submit', submitted.requestBody)).record.state).toBe('completed');
        expect(await fs.readFile(path.join(target, 'obsolete.txt'), 'utf8')).toBe('A later helper');
        const reopened = await showImporter(account);
        await reopened.card.getByLabel('Saved account imports').selectOption(submitted.record.key);
        await expect(reopened.card.locator('.sb-import-report')).toContainText('Imported Tool');
        await expect(reopened.card.locator('.sb-import-report .sb-server-pill')).toHaveText('Ready');
        expect(app.provider.calls).toHaveLength(0);
    });
}
