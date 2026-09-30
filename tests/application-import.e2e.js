/* eslint-env browser */
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(300000);

async function showImporter(account) {
    const page = await account.open({ workspace: false, readyTimeout: 60000, timeout: 60000 });
    await page.waitForFunction(async () => {
        const { eventSource, event_types } = await import('/scripts/events.js');
        return eventSource.autoFireLastArgs.has(event_types.APP_READY);
    }, undefined, { timeout: 60000 });
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

test('phone ZIP import resumes automatically after the server process is killed', async ({ app, browser }) => {
    const account = await app.account({ phone: true });
    const archive = archiver('zip'); const chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    const folder = account.avatar.replace(/\.png$/i, '');
    for (let index = 0; index < 120; index++) {
        archive.append([
            { user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
            { name: 'Durable Nova', is_user: false, mes: `Imported reply ${index}` },
        ].map(row => JSON.stringify(row)).join('\n'), { name: `default-user/chats/${folder}/Restart ${index}.jsonl` });
    }
    await archive.finalize();
    const { page, card } = await showImporter(account);
    const submitted = await submit(page, () => card.getByLabel('Choose a SillyTavern backup ZIP').setInputFiles({
        name: 'restart.zip', mimeType: 'application/zip', buffer: Buffer.concat(chunks),
    }));
    await expect(card).toContainText('Saving imported files', { timeout: 60000 });
    await closeAll(page, browser);
    await app.restart();
    // The import resumes during startup, without submitting another operation or pressing Recover.
    const csrf = await (await account.context.request.get('/csrf-token')).json();
    Object.assign(account.headers, { 'X-CSRF-Token': csrf.token });
    await account.post('/api/users/login', { handle: 'default-user', password: '' });
    const job = await account.settled(submitted.job.id);
    expect(job.attempt).toBeGreaterThan(1);
    for (let index = 0; index < 120; index++) {
        const rows = (await fs.readFile(path.join(app.directory, 'data/default-user/chats', folder, `Restart ${index}.jsonl`), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
        expect(rows[1].mes).toBe(`Imported reply ${index}`);
    }
    const reopened = await showImporter(account);
    await reopened.card.getByLabel('Saved account imports').selectOption(submitted.record.key);
    await expect(reopened.card.getByRole('button', { name: 'Reload imported account', exact: true })).toBeVisible();
});

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
    test(`${viewport} backup import keeps pending background settings saves from changing its destination`, async ({ app }) => {
        const account = await app.account({ phone });
        const { page, card } = await showImporter(account);
        const settings = JSON.parse((await account.post('/api/settings/get')).settings);
        settings.username = 'Imported backup user';
        const archive = archiver('zip'); const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.append(JSON.stringify(settings), { name: 'default-user/settings.json' });
        // Keep the result open until Reload, so stale settings saves are checked after completion too.
        archive.append(Buffer.alloc(8), { name: 'default-user/characters/Damaged.png' });
        for (let index = 0; index < 120; index++) {
            archive.append([
                { user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
                { name: 'Durable Nova', is_user: false, mes: `Imported reply ${index}` },
            ].map(JSON.stringify).join('\n'), { name: `default-user/chats/Imported/History ${index}.jsonl` });
        }
        await archive.finalize();
        await page.route('**/api/operations/submit', async route => {
            await page.evaluate(async () => { (await import('/script.js')).saveSettingsDebounced(); });
            await route.continue();
        });
        const submitted = await submit(page, () => card.getByLabel('Choose a SillyTavern backup ZIP').setInputFiles({
            name: 'default-user.zip', mimeType: 'application/zip', buffer: Buffer.concat(chunks),
        }));
        await expect(card).toContainText('Saving imported files', { timeout: 60000 });
        await expect(card.locator('progress')).not.toHaveAttribute('value', /.+/);
        await account.settled(submitted.job.id);
        await expect(card.getByRole('button', { name: 'Reload to use the imported data' })).toBeVisible();
        await expect(card.locator('progress')).toBeHidden();
        expect(await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }))).toBe(false);
        expect(JSON.parse(await fs.readFile(path.join(app.directory, 'data/default-user/settings.json'), 'utf8')).username).toBe('Imported backup user');
        expect(await fs.readFile(path.join(app.directory, 'data/default-user/chats/Imported/History 119.jsonl'), 'utf8')).toContain('Imported reply 119');
    });

    test(`${viewport} backup ZIP skips a damaged file, imports the rest and lists the skip after reopening`, async ({ app }) => {
        const account = await app.account({ phone });
        const relative = `characters/${'LongCharacterName'.repeat(6)}.png`;
        const archive = archiver('zip'); const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.append(Buffer.alloc(8), { name: `data/default-user/${relative}` });
        archive.append('Healthy file', { name: 'data/default-user/user/files/healthy.txt' });
        await archive.finalize();
        const { page, card } = await showImporter(account);
        await page.evaluate(() => { window.__importPageMarker = true; });
        const submitted = await submit(page, () => card.getByLabel('Choose a SillyTavern backup ZIP').setInputFiles({
            name: 'damaged-card.zip', mimeType: 'application/zip', buffer: Buffer.concat(chunks),
        }));
        const note = card.locator('.sb-import-note');
        await expect(note).toContainText(relative, { timeout: 60000 });
        await expect(note).toContainText('Backup ZIP imported.');
        await expect(note).toContainText('1 file was damaged and could not be imported:');
        await expect(note).toContainText('The file is not a valid PNG image.');
        await expect(note).toContainText('Everything else was imported.');
        await expect(note.getByRole('button', { name: 'Reload to use the imported data' })).toBeVisible();
        expect(await page.evaluate(() => window.__importPageMarker)).toBe(true);
        expect(await fs.readFile(path.join(app.directory, 'data/default-user/user/files/healthy.txt'), 'utf8')).toBe('Healthy file');
        await note.scrollIntoViewIfNeeded();
        const geometry = await note.evaluate(element => ({
            width: element.clientWidth, scrollWidth: element.scrollWidth,
            height: element.clientHeight, scrollHeight: element.scrollHeight,
            whiteSpace: getComputedStyle(element).whiteSpace,
            right: element.getBoundingClientRect().right, viewportWidth: window.innerWidth,
        }));
        expect(geometry.width).toBeGreaterThan(200);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
        expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.height + 1);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
        expect(geometry.whiteSpace).not.toBe('nowrap');
        await test.info().attach(`${viewport}-import-diagnostic`, { body: await page.screenshot(), contentType: 'image/png' });
        await page.close();
        const reopened = await showImporter(account);
        await reopened.card.getByLabel('Saved account imports').selectOption(submitted.record.key);
        const savedStatus = reopened.card.getByRole('status').filter({ hasText: relative });
        await expect(savedStatus).toContainText('1 file was damaged and could not be imported:');
        await expect(savedStatus).toContainText(`Cannot read '${relative}': The file is not a valid PNG image.`);
        const savedGeometry = await savedStatus.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
        expect(savedGeometry.scrollWidth).toBeLessThanOrEqual(savedGeometry.width + 1);
        expect(await fs.access(path.join(app.directory, 'data/default-user', relative)).then(() => true, () => false)).toBe(false);
    });

    test(`${viewport} backup ZIP imports branch chats that name their parent the older SillyTavern ways`, async ({ app }) => {
        const account = await app.account({ phone });
        const folder = account.avatar.replace(/\.png$/i, '');
        const parents = [1687345678901, `${folder}: Branch`, 'Trailing dot.', ['list']];
        const refused = `chats/${folder}/Negative zero.jsonl`;
        const archive = archiver('zip'); const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        parents.forEach((main_chat, index) => archive.append([
            { user_name: 'User', character_name: 'Durable Nova', chat_metadata: { main_chat } },
            { name: 'Durable Nova', is_user: false, mes: `Branch reply ${index}` },
        ].map(row => JSON.stringify(row)).join('\n'), { name: `default-user/chats/${folder}/Branch ${index}.jsonl` }));
        archive.append(`${JSON.stringify({ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} })}\n{"name":"Durable Nova","is_user":false,"mes":"Refused","n":-0.0}`, { name: `default-user/${refused}` });
        await archive.finalize();
        const { page, card } = await showImporter(account);
        await submit(page, () => card.getByLabel('Choose a SillyTavern backup ZIP').setInputFiles({
            name: 'default-user.zip', mimeType: 'application/zip', buffer: Buffer.concat(chunks),
        }));
        const note = card.locator('.sb-import-note');
        await expect(note).toContainText('Backup ZIP imported.', { timeout: 60000 });
        await expect(note).toContainText('1 file was damaged and could not be imported:');
        await expect(note).toContainText(`Cannot import '${refused}': Roleplay identity requires JSON-only values.`);
        await expect(card).not.toContainText('Invalid Roleplay source identifier');
        for (const [index, main_chat] of parents.entries()) {
            const rows = (await fs.readFile(path.join(app.directory, 'data/default-user/chats', folder, `Branch ${index}.jsonl`), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
            expect(rows[0].chat_metadata.main_chat).toEqual(main_chat);
            expect(rows[1].mes).toBe(`Branch reply ${index}`);
        }
        expect(await fs.access(path.join(app.directory, 'data/default-user', refused)).then(() => true, () => false)).toBe(false);
    });

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
