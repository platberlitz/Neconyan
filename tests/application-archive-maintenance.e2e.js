/* eslint-env browser */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(300000);

async function accepted(page, kind, action) {
    const response = page.waitForResponse(value => value.url().endsWith('/api/operations/submit') && value.request().postDataJSON()?.kind === kind);
    await action();
    const result = await response;
    expect(result.status(), await result.text()).toBe(202);
    return { ...await result.json(), requestBody: result.request().postDataJSON() };
}

async function closeAll(page, browser) {
    await page.close();
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
}

async function showArchive(page) {
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        const { openArchive } = await import('/scripts/extensions/neconyan-chats-archive/src/ui.js');
        void openArchive(context);
    });
    const root = page.locator('.sbca-root');
    await expect(root).toBeVisible();
    const size = await root.evaluate(element => ({ width: element.getBoundingClientRect().width, display: getComputedStyle(element).display }));
    expect(size.width).toBeGreaterThan(250);
    expect(size.display).not.toBe('none');
    return root;
}

async function showMaintenance(account) {
    const page = await account.open({ workspace: false, readyTimeout: 60000 });
    await page.evaluate(() => document.getElementById('data_maid_button').click());
    const root = page.locator('.dataMaidDialogContainer');
    await expect(root).toBeVisible();
    const size = await root.evaluate(element => ({ width: element.getBoundingClientRect().width, display: getComputedStyle(element).display }));
    expect(size.width).toBeGreaterThan(250);
    expect(size.display).not.toBe('none');
    return { page, root };
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`${viewport} confirmed account reset survives page closure and cannot erase later data on replay`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        const filename = path.join(app.directory, 'data/default-user/reset-fixture.txt');
        await fs.writeFile(filename, 'Old account contents.');
        const page = await account.open({ workspace: false, readyTimeout: 60000 });
        await page.evaluate(() => document.getElementById('account_button').click());
        const panel = page.locator('.neconyan-account-panel');
        await panel.getByRole('button', { name: 'Reset Everything', exact: true }).click();
        const confirmation = page.locator('dialog[open]').filter({ has: page.locator('.resetCodeBlock') });
        await expect(confirmation).toBeVisible();
        const resetCode = () => [...app.serverOutput.replace(/\u001b\[[0-9;]*m/g, '').matchAll(/account reset code is: (\d{4})/g)].at(-1)?.[1];
        await expect.poll(resetCode).toMatch(/^\d{4}$/);
        await confirmation.locator('input[name="code"]').fill(resetCode());
        const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/users/reset-step2'));
        await confirmation.locator('.popup-button-ok').click();
        const response = await responsePromise;
        expect(response.status(), await response.text()).toBe(202);
        const acceptedReset = await response.json();
        const requestBody = response.request().postDataJSON();
        await closeAll(page, browser);
        await expect.poll(async () => {
            const saved = await account.context.request.get(`${app.url}/api/operations/records/${acceptedReset.record.key}`);
            return saved.ok() ? (await saved.json()).state : String(saved.status());
        }, { timeout: 60000 }).toBe('completed');
        expect(await fs.access(filename).then(() => true, () => false)).toBe(false);
        expect(JSON.parse(await fs.readFile(path.join(app.directory, 'data/default-user/settings.json'), 'utf8')).extension_settings).toBeTruthy();
        await fs.writeFile(filename, 'New account contents.');
        const replay = await account.post('/api/users/reset-step2', requestBody);
        expect(replay.record.state).toBe('completed');
        expect(await fs.readFile(filename, 'utf8')).toBe('New account contents.');
        const reopened = await account.open({ workspace: false, readyTimeout: 60000, skipTour: false });
        const imageSetup = reopened.getByRole('dialog').filter({ has: reopened.getByRole('heading', { name: 'Quick Image Gen', exact: true }) });
        await imageSetup.getByRole('button', { name: 'Cancel', exact: true }).click();
        const tourSkip = reopened.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
        if (await tourSkip.isVisible()) await tourSkip.click();
        await reopened.evaluate(() => document.getElementById('account_button').click());
        const savedPanel = reopened.locator('.neconyan-account-panel');
        await savedPanel.getByLabel('Saved account resets', { exact: true }).selectOption(acceptedReset.record.key);
        await expect(savedPanel.getByText('The account reset is complete.', { exact: true })).toBeVisible();
        await expect(savedPanel.getByRole('button', { name: 'Reload reset account', exact: true })).toBeVisible();
        expect(await fs.readFile(filename, 'utf8')).toBe('New account contents.');
        expect(app.provider.calls).toHaveLength(0);
    });

    test(`${viewport} account backup finishes with pages closed and downloads the retained archive`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        const filename = path.join(app.directory, 'data/default-user/backup-fixture.txt');
        await fs.writeFile(filename, 'Retained backup contents.');
        const page = await account.open({ workspace: false, readyTimeout: 60000 });
        await page.evaluate(() => document.getElementById('account_button').click());
        const panel = page.locator('.neconyan-account-panel');
        await expect(panel).toBeVisible();
        const geometry = await panel.evaluate(element => ({ width: element.getBoundingClientRect().width, display: getComputedStyle(element).display }));
        expect(geometry.width).toBeGreaterThan(250);
        expect(geometry.display).not.toBe('none');
        const backup = await accepted(page, 'account-backup', () => panel.getByRole('button', { name: 'Download Backup', exact: true }).click());
        await closeAll(page, browser);
        await account.settled(backup.job.id);
        await fs.writeFile(filename, 'Later account contents.');
        const reopened = await account.open({ workspace: false, readyTimeout: 60000 });
        await reopened.evaluate(() => document.getElementById('account_button').click());
        const saved = reopened.locator('.neconyan-account-panel');
        await saved.getByLabel('Saved account backups', { exact: true }).selectOption(backup.record.key);
        const download = reopened.waitForEvent('download');
        await saved.getByRole('button', { name: 'Download saved backup', exact: true }).click();
        const downloaded = await download;
        expect(downloaded.suggestedFilename()).toMatch(/^default-user-.*\.zip$/);
        const bytes = await fs.readFile(await downloaded.path());
        expect(await archiveFile(bytes, 'backup-fixture.txt')).toBe('Retained backup contents.');
        expect(await fs.readFile(filename, 'utf8')).toBe('Later account contents.');
        const response = await account.context.request.get(app.url + '/api/operations/records?kind=account-backup');
        expect(await response.json()).toHaveLength(1);
        expect(app.provider.calls).toHaveLength(0);
    });

    test(`${viewport} archive inventory and whole-content search retain results after page closure`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        const directory = path.join(app.directory, 'data/default-user/chats', account.avatar.replace(/\.png$/i, ''));
        await fs.mkdir(directory, { recursive: true });
        const filename = path.join(directory, 'Retained archive.jsonl');
        const original = [
            { chat_metadata: {}, user_name: 'User', character_name: 'Durable Nova' },
            { name: 'Durable Nova', is_user: false, mes: 'Opening message.' },
            { name: 'User', is_user: true, mes: 'The lunar secret is recorded here.' },
            { name: 'Durable Nova', is_user: false, mes: 'Closing message.' },
        ].map(value => JSON.stringify(value)).join('\n') + '\n';
        await fs.writeFile(filename, original);
        const page = await account.open({ workspace: false, readyTimeout: 60000 });
        const inventory = await accepted(page, 'archive-inventory', () => showArchive(page));
        await closeAll(page, browser);
        await account.settled(inventory.job.id);
        const inventoryResponse = await account.context.request.get(app.url + `/api/operations/records/${inventory.record.key}`);
        const inventoryRecord = await inventoryResponse.json();
        expect(inventoryRecord.result.rows.some(row => row.file_name === 'Retained archive.jsonl')).toBe(true);
        expect(await fs.readFile(filename, 'utf8')).toBe(original);

        const reopened = await account.open({ workspace: false, readyTimeout: 60000 });
        const root = await showArchive(reopened);
        await expect(root.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
        await root.getByLabel('Saved archive work', { exact: true }).selectOption(inventory.record.key);
        await expect(root.locator('.sbca-status')).toContainText('Saved archive work loaded');
        const search = await accepted(reopened, 'archive-search', async () => {
            await root.getByLabel('Search indexed chats', { exact: true }).fill('lunar secret');
            await root.getByLabel('Search indexed chats', { exact: true }).press('Enter');
        });
        await closeAll(reopened, browser);
        await account.settled(search.job.id);
        const searchResponse = await account.context.request.get(app.url + `/api/operations/records/${search.record.key}`);
        const searchRecord = await searchResponse.json();
        expect(searchRecord.result.rows).toHaveLength(1);
        expect(searchRecord.result.rows[0].mes).toContain('lunar secret');
        const third = await account.open({ workspace: false, readyTimeout: 60000 });
        const saved = await showArchive(third);
        await expect(saved.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
        await saved.getByLabel('Saved archive work', { exact: true }).selectOption(search.record.key);
        await expect(saved.locator('.sbca-status')).toContainText('Saved archive work loaded');
        await expect(saved.locator('.sbca-list')).toContainText('Retained archive');
        expect(await fs.readFile(filename, 'utf8')).toBe(original);
        expect(app.provider.calls).toHaveLength(0);
    });

    test(`${viewport} maintenance retains a report and finishes a separately reviewed deletion with pages closed`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        const directory = path.join(app.directory, 'data/default-user/user/files');
        await fs.mkdir(directory, { recursive: true });
        const filename = path.join(directory, 'Review this unused file.txt');
        await fs.writeFile(filename, 'A file selected for reviewed cleanup.');
        const { page, root } = await showMaintenance(account);
        const report = await accepted(page, 'maintenance-report', () => root.locator('.dataMaidStartButton').click());
        await closeAll(page, browser);
        await account.settled(report.job.id);
        expect(await fs.readFile(filename, 'utf8')).toContain('reviewed cleanup');
        const reopened = await showMaintenance(account);
        await reopened.root.getByLabel('Saved maintenance reports', { exact: true }).selectOption(report.record.key);
        const category = reopened.root.locator('.dataMaidCategory').filter({ hasText: 'Review this unused file.txt' });
        const item = category.locator('.dataMaidItem').filter({ hasText: 'Review this unused file.txt' });
        if (!await item.isVisible()) await category.locator('.inline-drawer-toggle').click();
        await expect(item).toBeVisible();
        await item.getByTitle('Delete this item', { exact: true }).click();
        const confirmation = reopened.page.locator('dialog.popup[open]').last();
        await expect(confirmation).toContainText('Are you sure?');
        const deletion = await accepted(reopened.page, 'maintenance-delete', () => confirmation.locator('.popup-button-ok').click());
        await closeAll(reopened.page, browser);
        await account.settled(deletion.job.id);
        await expect(fs.access(filename)).rejects.toMatchObject({ code: 'ENOENT' });
        const readback = await account.context.request.get(app.url + `/api/operations/records/${deletion.record.key}`);
        const result = await readback.json();
        expect(result.state).toBe('completed');
        await fs.writeFile(filename, 'A later replacement must remain.');
        const duplicate = await account.post('/api/operations/submit', deletion.requestBody);
        expect(duplicate.record.state).toBe('completed');
        expect(await fs.readFile(filename, 'utf8')).toBe('A later replacement must remain.');
        expect(app.provider.calls).toHaveLength(0);
    });
}

async function archiveFile(bytes, name) {
    return new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error);
        zip.on('error', reject);
        zip.on('end', () => reject(new Error(`Missing backup entry: ${name}`)));
        zip.on('entry', entry => {
            if (entry.fileName !== name) return zip.readEntry();
            zip.openReadStream(entry, (error, stream) => {
                if (error) return reject(error);
                const chunks = [];
                stream.on('error', reject); stream.on('data', chunk => chunks.push(chunk));
                stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks).toString('utf8')); });
            });
        });
        zip.readEntry();
    }));
}
