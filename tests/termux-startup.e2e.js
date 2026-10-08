/* eslint-env browser */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import archiver from 'archiver';
import { write as writeCard } from '../src/character-card-parser.js';
import { test } from './neconyan-conversation-durable-fixture.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const legacy = process.env.NECONYAN_TERMUX_V121_ROOT;
const ctimePreload = path.join(root, 'tests/termux-ctime-fixture.js');
const marker = '_termux-file-identity.json';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

test.setTimeout(180000);
test.skip(process.env.NECONYAN_TERMUX_AUTO_START_TEST !== '1', 'Opt in to disposable Termux automatic-startup tests.');

async function importBackup(account, filename) {
    const page = await account.open({ workspace: false });
    await page.waitForFunction(async () => {
        const { eventSource, event_types } = await import('/scripts/events.js');
        return eventSource.autoFireLastArgs.has(event_types.APP_READY);
    });
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    const categories = page.locator('.sb-settings-category-select');
    if (await categories.isVisible()) await categories.selectOption('system-device');
    else await page.locator('.sb-settings-tab-btn[data-tab="system-device"]').click();
    if (!await page.locator('#sb-import-path-input').isVisible()) {
        await page.locator('#SillyTavernImportSection .inline-drawer-toggle').first().click();
    }
    const archive = archiver('zip'); const chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    archive.append('Saved Termux import', { name: `default-user/user/files/${filename}` });
    archive.append(writeCard(png, JSON.stringify({ name: 'Termux Import', description: 'Preserved during an upgrade.' })), { name: 'default-user/characters/Termux Import.png' });
    archive.append('{}', { name: 'default-user/settings.json' });
    await archive.finalize();
    const uploaded = page.waitForResponse(response => response.url().endsWith('/api/operations/import-input') && response.request().method() === 'POST');
    page.on('dialog', dialog => dialog.accept());
    const card = page.locator('#sb-import-card');
    await card.getByLabel('Choose a SillyTavern backup ZIP').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.concat(chunks) });
    const response = await uploaded;
    expect(response.ok()).toBe(true);
    await expect(card.locator('.sb-import-note')).toContainText('Backup ZIP imported.', { timeout: 60000 });
    await expect(card.locator('.sb-import-note')).not.toContainText('could not be imported');
    return { page, receipt: await response.json(), key: response.request().postDataBuffer().toString().match(/name="key"\r\n\r\n([^\r]+)/)[1] };
}

for (const phone of [false, true]) {
    test(`new Termux install imports and restarts through normal startup on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        const account = await app.account({ phone });
        const saved = await importBackup(account, 'fresh.txt');
        expect(JSON.parse(await fs.readFile(path.join(app.dataRoot, marker), 'utf8'))).toEqual({ version: 1, birthtime: 'zero' });
        await saved.page.close();
        await app.restart();
        const receipt = await account.context.request.get(`/api/operations/import-input/${saved.key}`);
        expect(receipt.ok()).toBe(true);
        expect(await receipt.json()).toEqual(saved.receipt);
        expect(await fs.readFile(path.join(app.dataRoot, 'default-user/user/files/fresh.txt'), 'utf8')).toBe('Saved Termux import');
        const reopened = await account.open({ workspace: false });
        await expect.poll(() => reopened.evaluate(() => window.SillyTavern.getContext().characters.some(character => character.name === 'Termux Import'))).toBe(true);
    });
}

test.describe('upgrade from the actual 1.2.1 recovery runtime', () => {
    test.skip(!legacy, 'Set NECONYAN_TERMUX_V121_ROOT to an owned v1.2.1 checkout with dependencies and the old recovery preload.');
    test.use({ dataRootName: 'neconyan-import-recovery', initialServerOptions: {
        checkoutRoot: legacy || root,
        env: { NODE_OPTIONS: `--import=${ctimePreload} --import=${path.join(legacy || root, 'src/termux-file-stats.js')}` },
    } });

    for (const phone of [false, true]) {
        test(`normal startup after update retains the recovery import on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
            const account = await app.account({ phone });
            const saved = await importBackup(account, 'upgraded.txt');
            expect(await fs.access(path.join(app.dataRoot, marker)).then(() => true, () => false)).toBe(false);
            const home = app.directory;
            await fs.symlink(root, path.join(home, 'Neconyan'), 'dir');
            await fs.writeFile(path.join(home, '.neconyan-import-folder'), app.dataRoot + '\n');
            await saved.page.close();
            await app.stop();
            const configPath = path.join(app.directory, 'config.yaml');
            const config = YAML.parse(await fs.readFile(configPath, 'utf8'));
            config.dataRoot = './data';
            await fs.writeFile(configPath, YAML.stringify(config));
            // No compatibility preload and no explicit --dataRoot: this is normal updated startup.
            await app.start({ useConfigDataRoot: true, env: {
                NODE_OPTIONS: `--import=${ctimePreload}`, NECONYAN_TERMUX_TEST_HOME: home,
                NECONYAN_TERMUX_ZERO_BIRTHTIME_DEVICE: '',
            } });
            const receipt = await account.context.request.get(`/api/operations/import-input/${saved.key}`);
            expect(receipt.ok(), await receipt.text()).toBe(true);
            expect(await receipt.json()).toEqual(saved.receipt);
            expect(await fs.readFile(path.join(app.dataRoot, 'default-user/user/files/upgraded.txt'), 'utf8')).toBe('Saved Termux import');
            expect(JSON.parse(await fs.readFile(path.join(app.dataRoot, marker), 'utf8'))).toEqual({ version: 1, birthtime: 'zero' });
            expect(app.serverOutput).toContain(`Continuing the saved Termux recovery data folder: ${app.dataRoot}`);
            const reopened = await account.open({ workspace: false });
            await expect.poll(() => reopened.evaluate(() => window.SillyTavern.getContext().characters.some(character => character.name === 'Termux Import'))).toBe(true);
        });
    }
});
