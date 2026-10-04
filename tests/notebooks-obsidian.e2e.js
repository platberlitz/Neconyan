/* global getComputedStyle */
import { expect, test as base } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expectSourceText, fillSource, notesApi, openNotes, showNotebooks, sourceText } from './notebooks-browser-fixture.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// An owned local stand-in for the 'ob' client; it never connects to a network or an Obsidian account.
const CLIENT = `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const folder = args[args.indexOf('--path') + 1];
if (!folder || !['sync-status', 'sync'].includes(args[0])) process.exit(10);
const record = path.join(path.dirname(folder), '.obsidian-test-' + path.basename(folder) + '.ndjson');
fs.appendFileSync(record, JSON.stringify({ args, pid: process.pid }) + '\\n');
if (args[0] === 'sync-status') {
    if (fs.existsSync(path.join(folder, '.fixture-status-hangs'))) {
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 1000);
    } else {
        process.stdout.write(JSON.stringify({ configured: true, secret: 'PRIVATE-CLIENT-OUTPUT' }));
        process.exit(fs.existsSync(path.join(folder, '.fixture-not-prepared')) ? 2 : 0);
    }
} else {
    if (!args.includes('--continuous')) process.exit(11);
    fs.writeFileSync(path.join(folder, '.fixture-client-pid'), String(process.pid));
    process.stdout.write('PRIVATE-CLIENT-OUTPUT');
    process.stderr.write('PRIVATE-CLIENT-ERROR');
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => process.exit(0));
}
`;

let app;
const test = base.extend({
    obsidianApp: [async ({}, use) => {
        if (process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1') {
            throw new Error('Set NECONYAN_CONVERSATION_TEST_DISPOSABLE=1 to run this owned, disposable fixture.');
        }
        const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'notebooks-obsidian-')));
        const executable = path.join(directory, 'headless-fixture');
        await fs.writeFile(executable, `#!${process.execPath}\n${CLIENT}`, { mode: 0o755 });
        const reservation = createServer();
        reservation.listen(0, '127.0.0.1');
        await once(reservation, 'listening');
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        const config = YAML.parse(await fs.readFile(path.join(root, 'default/config.yaml'), 'utf8'));
        Object.assign(config, {
            dataRoot: path.join(directory, 'data'), port, listen: false,
            enableDownloadableTokenizers: false, enableServerPlugins: false, enableServerPluginsAutoUpdate: false,
        });
        config.browserLaunch.enabled = false;
        config.extensions.autoUpdate = false;
        config.extensions.models.autoDownload = false;
        config.performance.frontendBuild.enabled = process.env.NECONYAN_TEST_FRONTEND_BUILD === '1';
        config.notebooks.obsidianHeadless = { ...config.notebooks.obsidianHeadless,
            enabled: true, executable, allowedRoots: ['$ACCOUNT_ROOT/notebooks'], pollIntervalMs: 1000 };
        await fs.mkdir(config.dataRoot);
        if (process.env.NECONYAN_TEST_LIBRARY_CACHE) await fs.cp(process.env.NECONYAN_TEST_LIBRARY_CACHE, path.join(config.dataRoot, '_webpack'), { recursive: true });
        const configPath = path.join(directory, 'config.yaml');
        await fs.writeFile(configPath, YAML.stringify(config));
        let output = '';
        const child = spawn(process.execPath, ['server.js', '--configPath', configPath, '--dataRoot', config.dataRoot,
            '--port', String(port), '--browserLaunchEnabled', 'false'], {
            cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NECONYAN_SUPERVISED: '1' },
        });
        child.stdout.on('data', data => { output += data; });
        child.stderr.on('data', data => { output += data; });
        const url = `http://127.0.0.1:${port}`;
        try {
            const deadline = Date.now() + 120000;
            while (!await fetch(url + '/csrf-token').then(response => response.ok).catch(() => false)) {
                if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Disposable server exited: ${output}`);
                if (Date.now() > deadline) throw new Error(`Disposable server did not become ready: ${output}`);
                await delay(250);
            }
            app = { url, directory, dataRoot: config.dataRoot };
            await use(app);
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                const exited = once(child, 'exit');
                child.kill('SIGTERM');
                const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
                try { await exited; } finally { clearTimeout(timer); }
            }
            await fs.rm(directory, { recursive: true, force: true });
        }
    }, { scope: 'worker' }],
    baseURL: async ({ obsidianApp }, use) => use(obsidianApp.url),
});

test.use({ hasTouch: true, serviceWorkers: 'block' });
test.setTimeout(180000);
const states = new WeakMap();
test.beforeEach(async ({ page }) => states.set(page, { gates: [], notebooks: [] }));
test.afterEach(async ({ page }) => {
    const state = states.get(page);
    for (const release of state.gates) release();
    await page.unrouteAll({ behavior: 'wait' });
    for (const notebookId of state.notebooks) await notesApi(page, '/obsidian/stop', { notebookId });
});

async function setup(page, viewport) {
    await openNotes(page, viewport);
    const created = await notesApi(page, '/create', { operationId: `sync:${randomUUID()}`, name: `Sync checks ${randomUUID()}` });
    expect(created.status).toBe('success');
    const notebookId = created.notebook.id;
    states.get(page).notebooks.push(notebookId);
    const text = '# Original\r\nOwner note stays private unless the owner shares it.\r\n';
    const note = await notesApi(page, '/notes/create', { notebookId, operationId: `sync:${randomUUID()}`, title: 'Original', folder: '', text });
    expect(note.status).toBe('success');
    const policy = await notesApi(page, '/policies/get', { notebookId });
    await notesApi(page, '/policies/update', { notebookId, operationId: `sync:${randomUUID()}`, expectedRevision: policy.policy.revision, patch: { assistant: 'edit', assistantPublish: true } });
    await page.evaluate(async notebookId => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(notebookId), notebookId);
    await showNotebooks(page, viewport);
    await page.locator('.notes-pane-nav .notes-note-title').getByText('Original', { exact: true }).first().click();
    await expectSourceText(page, text.replace(/\r\n/g, '\n'));
    const account = await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().state.account);
    const folder = path.join(app.dataRoot, account, 'notebooks', notebookId);
    expect(await fs.realpath(folder)).toBe(folder);
    return { notebookId, folder, noteId: note.noteId, text };
}

async function openSync(page, viewport) {
    await showNotebooks(page, viewport);
    await page.locator('.notes-pane-nav').getByRole('button', { name: 'Obsidian sync', exact: true }).click();
    const popup = page.locator('dialog.popup:visible');
    await expect(popup.getByRole('heading', { name: 'Obsidian sync', exact: true })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Approve folder', exact: true })).toBeEnabled({ timeout: 30000 });
    return popup;
}

async function approve(popup) {
    await popup.getByRole('checkbox').check();
    await popup.getByRole('button', { name: 'Approve folder', exact: true }).click();
    await expect(popup).toContainText('The folder is approved. Start client is a separate action.', { timeout: 30000 });
}

const logPath = folder => path.join(path.dirname(folder), `.obsidian-test-${path.basename(folder)}.ndjson`);
const commands = async folder => {
    try { return (await fs.readFile(logPath(folder), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).args); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test(`optional sync is explicit, single-folder, private and recorded at ${viewport.width}px`, async ({ page }, testInfo) => {
        const modules = [];
        page.on('request', request => { if (request.url().includes('/notebooks/obsidian-dialogs.js')) modules.push(request.url()); });
        const f = await setup(page, viewport);
        expect(modules).toHaveLength(0);
        const popup = await openSync(page, viewport);
        expect(modules).toHaveLength(1);
        await expect(popup.getByRole('textbox', { name: 'Content folder', exact: true })).toHaveValue(f.folder);
        expect(await commands(f.folder)).toEqual([]);
        await popup.getByRole('button', { name: 'Approve folder', exact: true }).click();
        await expect(popup).toContainText('Confirm that the folder is prepared');
        expect(await commands(f.folder)).toEqual([]);
        await approve(popup);
        expect(await commands(f.folder)).toEqual([]);
        await popup.getByRole('button', { name: 'Start client', exact: true }).click();
        await expect(popup).toContainText('Client running.', { timeout: 30000 });
        await expect(popup.getByRole('button', { name: 'Start client', exact: true })).toBeDisabled();
        expect(await commands(f.folder)).toEqual([['sync-status', '--path', f.folder, '--json'], ['sync', '--path', f.folder, '--continuous']]);
        await expect(popup).not.toContainText('PRIVATE-CLIENT');

        const incoming = '---\r\ntitle: Arrived from sync\r\nassistant: edit\r\nassistantPublish: true\r\n---\r\n# Arrived\r\nExact incoming bytes.\r\n';
        const binary = Buffer.from([0, 255, 12, 10, 201]);
        const canvas = { future: { untouched: true }, nodes: [{ id: 'external', type: 'text', x: 0, y: 0, width: 320, height: 180, text: 'Synced planning text.', plugin: { keep: 7 } }] };
        await fs.writeFile(path.join(f.folder, 'Arrived.md'), incoming);
        await fs.writeFile(path.join(f.folder, 'Snapshot.csv'), binary);
        await fs.writeFile(path.join(f.folder, 'External.canvas'), `${JSON.stringify(canvas)}\r\n`);
        await fs.mkdir(path.join(f.folder, '.obsidian'), { recursive: true });
        await fs.writeFile(path.join(f.folder, '.obsidian', 'never-execute.js'), 'throw new Error("Do not execute imported plugins.");');
        await expect.poll(async () => (await notesApi(page, '/notes/list', { notebookId: f.notebookId })).notes.some(note => note.title === 'Arrived from sync'), { timeout: 30000 }).toBe(true);
        const listed = await notesApi(page, '/notes/list', { notebookId: f.notebookId });
        const arrived = listed.notes.find(note => note.title === 'Arrived from sync');
        const saved = await notesApi(page, '/notes/read', { notebookId: f.notebookId, noteId: arrived.id });
        expect(saved.note.text).toBe(incoming);
        const policy = await notesApi(page, '/policies/get', { notebookId: f.notebookId });
        expect(policy.policy.assistant).toBe('edit');
        expect(policy.policy.notes[arrived.id]).toMatchObject({ assistant: 'none', context: { mode: 'off' } });
        const boards = await notesApi(page, '/canvas/list', { notebookId: f.notebookId });
        const board = await notesApi(page, '/canvas/read', { notebookId: f.notebookId, canvasId: boards.canvases.find(item => item.path === 'External.canvas').id });
        expect(board.canvas.document).toEqual(canvas);

        await popup.getByRole('button', { name: 'Check external changes', exact: true }).click();
        const historyRow = popup.locator('.notes-obsidian-history-row').filter({ hasText: 'Snapshot.csv' }).first();
        await expect(historyRow).toBeVisible({ timeout: 30000 });
        const downloadPromise = page.waitForEvent('download');
        await historyRow.getByRole('button', { name: 'Download snapshot', exact: true }).click();
        const downloaded = await downloadPromise;
        expect(await fs.readFile(await downloaded.path())).toEqual(binary);
        const geometry = await popup.locator('.notes-obsidian-dialog').evaluate(element => {
            const style = getComputedStyle(element);
            const sample = element.ownerDocument.createElement('canvas');
            sample.width = sample.height = 1;
            const context = sample.getContext('2d');
            context.fillStyle = style.backgroundColor;
            context.fillRect(0, 0, 1, 1);
            return {
                width: element.getBoundingClientRect().width, font: style.fontFamily, background: style.backgroundColor,
                backgroundAlpha: context.getImageData(0, 0, 1, 1).data[3],
                buttons: Array.from(element.querySelectorAll('button')).map(button => ({ label: button.textContent, height: button.getBoundingClientRect().height })),
                confirmation: element.querySelector('.notes-obsidian-confirm').getBoundingClientRect().height,
            };
        });
        expect(geometry.width).toBeLessThanOrEqual(viewport.width);
        expect(geometry.backgroundAlpha).toBe(255);
        expect(geometry.buttons.every(button => button.height >= 44)).toBe(true);
        expect(geometry.confirmation).toBeGreaterThanOrEqual(44);
        await testInfo.attach('sync-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await popup.screenshot({ path: testInfo.outputPath('obsidian-sync.png') });
        await popup.getByRole('button', { name: 'Stop client', exact: true }).click();
        await expect(popup).toContainText('Client stopped.', { timeout: 30000 });
        await popup.getByRole('button', { name: 'Done', exact: true }).click();
        const original = await notesApi(page, '/notes/read', { notebookId: f.notebookId, noteId: f.noteId });
        expect(original.note.text).toBe(f.text);
        expect(await fs.readFile(path.join(f.folder, 'Snapshot.csv'))).toEqual(binary);
    });

    test(`optional sync refuses outside roots and an unprepared client at ${viewport.width}px`, async ({ page }) => {
        const f = await setup(page, viewport);
        const popup = await openSync(page, viewport);
        await popup.getByRole('checkbox').check();
        await popup.getByRole('textbox', { name: 'Content folder', exact: true }).fill(path.join(app.directory, 'not-a-notebook'));
        await popup.getByRole('button', { name: 'Approve folder', exact: true }).click();
        await expect(popup).toContainText('this notebook', { timeout: 30000 });
        await expect(popup.getByRole('textbox', { name: 'Content folder', exact: true })).toHaveValue(path.join(app.directory, 'not-a-notebook'));
        expect(await commands(f.folder)).toEqual([]);
        await popup.getByRole('textbox', { name: 'Content folder', exact: true }).fill(f.folder);
        await approve(popup);
        await fs.writeFile(path.join(f.folder, '.fixture-not-prepared'), 'No prepared client.');
        await popup.getByRole('button', { name: 'Start client', exact: true }).click();
        await expect(popup).toContainText('no installation or sign-in was attempted', { timeout: 30000 });
        expect(await commands(f.folder)).toEqual([['sync-status', '--path', f.folder, '--json']]);
        await fs.unlink(path.join(f.folder, '.fixture-not-prepared'));
        await popup.getByRole('button', { name: 'Done', exact: true }).click();
        expect((await notesApi(page, '/notes/read', { notebookId: f.notebookId, noteId: f.noteId })).note.text).toBe(f.text);
    });

    test(`an old lazy sync dialog cannot open over a later notebook at ${viewport.width}px`, async ({ page }) => {
        const f = await setup(page, viewport);
        let release;
        const gate = new Promise(done => { release = done; });
        states.get(page).gates.push(release);
        let announce;
        const pending = new Promise(done => { announce = done; });
        await page.route('**/scripts/notebooks/obsidian-dialogs.js', async route => { announce(); await gate; await route.continue(); });
        await showNotebooks(page, viewport);
        await page.locator('.notes-pane-nav').getByRole('button', { name: 'Obsidian sync', exact: true }).click();
        await pending;
        const other = await notesApi(page, '/create', { operationId: `sync:${randomUUID()}`, name: `Later sync choice ${randomUUID()}` });
        await page.evaluate(async id => (await import('/scripts/notebooks/notes-app.js')).notesApp().loadNotebooks(id), other.notebook.id);
        release();
        await page.waitForResponse(response => response.url().includes('/notebooks/obsidian-dialogs.js'));
        await expect(page.locator('dialog.popup:visible .notes-obsidian-dialog')).toHaveCount(0);
        expect(await commands(f.folder)).toEqual([]);
    });

    test(`observed sync changes update a clean note without replacing an active draft at ${viewport.width}px`, async ({ page }) => {
        const f = await setup(page, viewport);
        const popup = await openSync(page, viewport);
        await approve(popup);
        await popup.getByRole('button', { name: 'Start client', exact: true }).click();
        await expect(popup).toContainText('Client running.', { timeout: 30000 });
        await popup.getByRole('button', { name: 'Done', exact: true }).click();
        if (viewport.width < 768) await page.locator('.notes-pane-tabs').getByRole('button', { name: 'Note', exact: true }).click();
        const first = '# Original\r\nExternal update while the editor is clean.\r\n';
        await fs.writeFile(path.join(f.folder, 'Original.md'), first);
        await expect.poll(() => sourceText(page), { timeout: 30000 }).toBe(first.replace(/\r\n/g, '\n'));
        await page.route('**/api/notebooks/notes/update', route => route.abort('failed'));
        const draft = '# Original\nKeep my current device draft.\n';
        await fillSource(page, draft);
        const second = '# Original\r\nA newer external saved version.\r\n';
        await fs.writeFile(path.join(f.folder, 'Original.md'), second);
        await expect(page.locator('.notes-banner[data-banner="remote"]')).toContainText('Your text is still here.', { timeout: 30000 });
        await expectSourceText(page, draft);
        expect(await fs.readFile(path.join(f.folder, 'Original.md'), 'utf8')).toBe(second);
        const history = await notesApi(page, '/notes/history', { notebookId: f.notebookId, noteId: f.noteId });
        expect(history.history.filter(item => item.origin === 'external')).toHaveLength(2);
    });
}
