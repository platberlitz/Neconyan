/* eslint-env browser */
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { write as writeCard } from '../src/character-card-parser.js';
import { test } from './neconyan-conversation-durable-fixture.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

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
        const currentUsername = settings.username;
        settings.username = 'Imported backup user';
        settings.power_user.personas = { ...settings.power_user.personas, 'Imported.png': 'Imported persona' };
        settings.power_user.persona_descriptions = { ...settings.power_user.persona_descriptions, 'Imported.png': { description: 'Imported persona description' } };
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
        const saved = JSON.parse(await fs.readFile(path.join(app.directory, 'data/default-user/settings.json'), 'utf8'));
        expect(saved.username).toBe(currentUsername);
        expect(saved.power_user.personas['Imported.png']).toBe('Imported persona');
        expect(saved.power_user.persona_descriptions['Imported.png'].description).toBe('Imported persona description');
        expect(await fs.readFile(path.join(app.directory, 'data/default-user/chats/Imported/History 119.jsonl'), 'utf8')).toContain('Imported reply 119');
    });

    test(`${viewport} core ZIP imports the four libraries and reports every deliberate exclusion after reopening`, async ({ app }) => {
        const account = await app.account({ phone });
        const { page, card } = await showImporter(account);
        for (const name of ['Chats', 'Personas', 'Character cards', 'Lorebooks']) {
            const choice = card.getByRole('checkbox', { name, exact: true });
            await expect(choice).toBeChecked();
            expect(await choice.evaluate(input => input.closest('label').getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        }
        const current = JSON.parse((await account.post('/api/settings/get')).settings);
        const archive = archiver('zip'); const chunks = [];
        const lorebook = { entries: { 0: { uid: 0, key: ['Harbour'], content: 'Imported harbour lore.', extensions: { foreign: true } } }, extensions: { foreign: 'retained' } };
        archive.on('data', chunk => chunks.push(chunk));
        archive.append(JSON.stringify(lorebook), { name: 'default-user/worlds/Imported lore.json' });
        archive.append(writeCard(png, JSON.stringify({ name: 'Imported card', description: 'Imported character description' })), { name: 'default-user/characters/Imported.png' });
        archive.append([
            { user_name: 'User', character_name: 'Imported card', chat_metadata: {} },
            { name: 'Imported card', is_user: false, mes: 'Imported history' },
        ].map(row => JSON.stringify(row)).join('\n'), { name: 'default-user/chats/Imported/History.jsonl' });
        archive.append(png, { name: 'default-user/User Avatars/Persona.png' });
        archive.append(JSON.stringify({ username: 'Must not replace current user', power_user: {
            personas: { 'Persona.png': 'Imported persona' }, persona_descriptions: { 'Persona.png': { description: 'Imported description', title: 'Imported title', position: 0, lorebook: 'Imported lore' } },
            custom_css: 'Must not replace current CSS', default_persona: 'Persona.png',
        } }), { name: 'default-user/settings.json' });
        archive.append(JSON.stringify({ id: 'Imported', members: ['Imported.png'], chats: ['Imported group'] }), { name: 'default-user/groups/Imported.json' });
        archive.append([
            { user_name: 'User', character_name: 'Imported card', chat_metadata: {} },
            { name: 'Imported card', is_user: false, mes: 'Imported group history' },
        ].map(row => JSON.stringify(row)).join('\n'), { name: 'default-user/group chats/Imported group.jsonl' });
        archive.append('Imported attachment', { name: 'default-user/user/files/attachment.txt' });
        archive.append('Not even valid bookkeeping', { name: 'default-user/entity-date-added.json' });
        archive.append('Must not read API keys', { name: 'default-user/secrets.json' });
        for (let index = 0; index < 25; index++) archive.append('Unused theme', { name: `default-user/themes/Unused ${index}.json` });
        await archive.finalize();
        const submitted = await submit(page, () => card.getByLabel('Choose a SillyTavern backup ZIP').setInputFiles({
            name: 'default-user.zip', mimeType: 'application/zip', buffer: Buffer.concat(chunks),
        }));
        expect(submitted.requestBody.content).toBe('core');
        expect(submitted.requestBody.parts).toEqual(['chats', 'personas', 'characters', 'lorebooks']);
        await account.settled(submitted.job.id);
        const note = card.locator('.sb-import-note');
        await expect(note).toContainText('27 files were left out on purpose:', { timeout: 60000 });
        await expect(note).toContainText('entity-date-added.json: Account bookkeeping is not needed');
        await expect(note).toContainText('secrets.json: API keys and passwords are not imported.');
        await expect(note).toContainText('7 more. Download the report for the full list.');
        await expect(note).not.toContainText('damaged');
        await expect(note).not.toContainText('An import destination changed');
        const downloadButton = note.getByRole('button', { name: 'Download skipped-files report' });
        const downloading = page.waitForEvent('download');
        await downloadButton.click();
        const download = await downloading;
        const report = await fs.readFile(await download.path(), 'utf8');
        expect(report).toContain('themes/Unused 24.json: Themes are not part of this import.');
        expect(report).toContain('settings.json: Only persona names and descriptions were imported');
        expect(report).not.toContain('Must not read API keys');
        const saved = JSON.parse(await fs.readFile(path.join(app.directory, 'data/default-user/settings.json'), 'utf8'));
        expect(saved.username).toBe(current.username); expect(saved.power_user.custom_css).toBe(current.power_user.custom_css);
        expect(saved.power_user.default_persona).toBe(current.power_user.default_persona);
        expect(saved.power_user.personas['Persona.png']).toBe('Imported persona');
        expect(saved.power_user.persona_descriptions['Persona.png'].description).toBe('Imported description');
        expect(saved.power_user.persona_descriptions['Persona.png'].lorebook).toBe('Imported lore');
        expect(await account.post('/api/worldinfo/get', { name: 'Imported lore' })).toEqual(lorebook);
        expect(saved.extension_settings.neconyan_conversation.characters[account.threadKey].branches.main.messages[0].mes).toBe('Original question.');
        const root = path.join(app.directory, 'data/default-user');
        expect(await fs.readFile(path.join(root, 'characters/Imported.png'))).toEqual(writeCard(png, JSON.stringify({ name: 'Imported card', description: 'Imported character description' })));
        expect(await fs.readFile(path.join(root, 'User Avatars/Persona.png'))).toEqual(png);
        expect(await fs.readFile(path.join(root, 'chats/Imported/History.jsonl'), 'utf8')).toContain('Imported history');
        expect(await fs.readFile(path.join(root, 'group chats/Imported group.jsonl'), 'utf8')).toContain('Imported group history');
        expect(JSON.parse(await fs.readFile(path.join(root, 'groups/Imported.json'), 'utf8')).chats).toContain('Imported group');
        expect(await fs.readFile(path.join(root, 'user/files/attachment.txt'), 'utf8')).toBe('Imported attachment');
        expect(await fs.access(path.join(root, 'themes/Unused 24.json')).then(() => true, () => false)).toBe(false);
        await note.scrollIntoViewIfNeeded();
        const geometry = await note.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
            right: element.getBoundingClientRect().right, viewport: window.innerWidth, whiteSpace: getComputedStyle(element).whiteSpace,
        }));
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
        expect(geometry.whiteSpace).not.toBe('nowrap');
        expect((await downloadButton.boundingBox()).height).toBeGreaterThanOrEqual(44);
        await test.info().attach(`${viewport}-core-import-report`, { body: await page.screenshot(), contentType: 'image/png' });
        await page.close();
        const reopened = await showImporter(account);
        await reopened.card.getByLabel('Saved account imports').selectOption(submitted.record.key);
        await expect(reopened.card.getByRole('status').filter({ hasText: 'entity-date-added.json' })).toContainText('27 files were left out on purpose:');
        await expect(reopened.card.getByRole('button', { name: 'Download skipped-files report' })).toBeVisible();
        await reopened.page.evaluate(() => window.NeconyanShell.openTab('characters', 'world-info'));
        await expect(reopened.page.getByRole('button', { name: 'Open Imported lore', exact: true })).toBeVisible();
    });

    test(`${viewport} ZIP imports only the chosen persona library and refuses an empty selection before uploading`, async ({ app }) => {
        const account = await app.account({ phone });
        const { page, card } = await showImporter(account);
        const current = JSON.parse((await account.post('/api/settings/get')).settings);
        const archive = archiver('zip'); const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.append('Damaged card in an unselected library', { name: 'default-user/characters/Not selected.png' });
        archive.append('Damaged history in an unselected library', { name: 'default-user/chats/Not selected/History.jsonl' });
        archive.append(png, { name: 'default-user/User Avatars/Chosen.png' });
        archive.append(JSON.stringify({ username: 'Unwanted account settings', power_user: { personas: { 'Chosen.png': 'Chosen persona' },
            persona_descriptions: { 'Chosen.png': { description: 'Chosen description' } } } }), { name: 'default-user/settings.json' });
        await archive.finalize();
        const file = { name: 'default-user.zip', mimeType: 'application/zip', buffer: Buffer.concat(chunks) };
        for (const name of ['Chats', 'Personas', 'Character cards', 'Lorebooks']) await card.getByRole('checkbox', { name, exact: true }).uncheck();
        let uploads = 0;
        page.on('request', request => { if (request.url().endsWith('/api/operations/import-input')) uploads++; });
        await card.getByLabel('Choose a SillyTavern backup ZIP').setInputFiles(file);
        await expect(card.locator('.sb-import-note')).toContainText('Choose at least one library to import');
        expect(uploads).toBe(0);
        await card.getByRole('checkbox', { name: 'Personas', exact: true }).check();
        await card.getByRole('group', { name: 'Choose what to import' }).scrollIntoViewIfNeeded();
        await test.info().attach(`${viewport}-import-library-choices`, { body: await page.screenshot(), contentType: 'image/png' });
        const submitted = await submit(page, () => card.getByLabel('Choose a SillyTavern backup ZIP').setInputFiles(file));
        expect(submitted.requestBody.parts).toEqual(['personas']);
        await account.settled(submitted.job.id);
        const note = card.locator('.sb-import-note');
        await expect(note).toContainText('Selected libraries: Personas.', { timeout: 60000 });
        await expect(note).toContainText('characters/Not selected.png: Character cards were not selected for this import.');
        await expect(note).toContainText('chats/Not selected/History.jsonl: Chats were not selected for this import.');
        await expect(note).not.toContainText('damaged and could not be imported');
        const root = path.join(app.directory, 'data/default-user');
        const saved = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8'));
        expect(saved.username).toBe(current.username);
        expect(saved.power_user.personas['Chosen.png']).toBe('Chosen persona');
        expect(saved.power_user.persona_descriptions['Chosen.png'].description).toBe('Chosen description');
        expect(await fs.readFile(path.join(root, 'User Avatars/Chosen.png'))).toEqual(png);
        expect(await fs.access(path.join(root, 'characters/Not selected.png')).then(() => true, () => false)).toBe(false);
        expect(await fs.access(path.join(root, 'chats/Not selected/History.jsonl')).then(() => true, () => false)).toBe(false);
        await page.close();
        const reopened = await showImporter(account);
        await reopened.card.getByLabel('Saved account imports').selectOption(submitted.record.key);
        await expect(reopened.card.getByRole('status').filter({ hasText: 'Selected libraries: Personas.' })).toContainText('2 files were left out on purpose:');
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
        await expect(note).toContainText('1 file could not be imported:');
        await expect(note).toContainText('The file is not a valid PNG image.');
        await expect(note).toContainText('Other selected files were imported.');
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
        await expect(savedStatus).toContainText('1 file could not be imported:');
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
        await expect(note).toContainText('1 file could not be imported:');
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
