/* global document, window, innerWidth */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { test, expect } from '@playwright/test';
import { decrypt, encrypt, entry } from '../src/device-sync/protocol.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const passphrase = 'disposable shared sync passphrase';
const credentials = { username: 'sync-fixture', password: 'disposable-basic-password' };
test.describe.configure({ mode: 'serial' });
let apps = [], directory;

async function appFixture(name) {
    const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const config = YAML.parse(await fs.readFile(path.join(root, 'default/config.yaml'), 'utf8'));
    Object.assign(config, { dataRoot: path.join(directory, name), port, listen: true, listenAddress: { ipv4: '127.0.0.1', ipv6: '[::1]' }, enableUserAccounts: true,
        enableDownloadableTokenizers: false, enableServerPlugins: false, enableServerPluginsAutoUpdate: false,
        basicAuthMode: true, basicAuthUser: credentials });
    config.browserLaunch.enabled = false; config.extensions.autoUpdate = false; config.extensions.models.autoDownload = false;
    config.performance.frontendBuild.enabled = false;
    const configPath = path.join(directory, name + '.yaml'); await fs.writeFile(configPath, YAML.stringify(config));
    const child = spawn(process.execPath, ['server.js', '--configPath', configPath, '--dataRoot', config.dataRoot,
        '--port', String(port), '--browserLaunchEnabled', 'false'], { cwd: root, env: { ...process.env, NECONYAN_SUPERVISED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    const app = { url: `http://127.0.0.1:${port}`, child, dataRoot: config.dataRoot,
        async stop() {
            await fs.writeFile(path.join(directory, name + '.log'), output);
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = once(child, 'exit'); child.kill('SIGTERM');
            const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
            try { await exited; } finally { clearTimeout(timeout); }
        } };
    apps.push(app);
    await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(output);
        return raw(app.url + '/csrf-token', { basic: true }).then(reply => reply.status === 200).catch(() => false);
    }, { timeout: 60000 }).toBe(true);
    return app;
}

function raw(url, { method = 'GET', body, headers = {}, basic = false } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request(url, { method, headers: { ...(basic ? { Authorization: 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64') } : {}),
            ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, res => {
            const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                resolve({ status: res.statusCode, text, headers: res.headers, json: () => JSON.parse(text) });
            });
        });
        req.on('error', reject); req.end(data);
    });
}

async function account(browser, app, phone = false, handle = 'default-user') {
    const context = await browser.newContext({ baseURL: app.url, httpCredentials: credentials, serviceWorkers: 'block', reducedMotion: 'reduce',
        viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone });
    const csrf = await (await context.request.get('/csrf-token')).json();
    const headers = { 'X-CSRF-Token': csrf.token, 'X-Neconyan-Account': handle };
    const signedIn = await context.request.post('/api/auth/browser/login', { headers, data: credentials });
    expect(signedIn.ok(), await signedIn.text()).toBe(true);
    const post = async (route, body = {}) => {
        const response = await context.request.post(route.startsWith('/') ? route : '/api/device-sync/' + route, { headers, data: body });
        expect(response.ok(), route + ': ' + await response.text()).toBe(true); return response.json();
    };
    await post('/api/users/login', { handle, password: '' });
    return { context, headers, post, async status() { return (await context.request.get('/api/device-sync/status', { headers })).json(); } };
}

async function openSync(page) {
    await page.waitForFunction(() => window.__syncFixtureReady === true);
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skip.isVisible()) { await skip.click(); await expect(skip).toBeHidden(); }
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    await page.locator('.sb-settings-tab-btn[data-tab="device-sync"]').click();
    await expect(page.locator('#nn-device-sync-ready')).toBeVisible();
}

test.beforeAll(async () => {
    test.setTimeout(120000);
    if (process.env.NECONYAN_DEVICE_SYNC_DISPOSABLE !== '1') throw new Error('Set NECONYAN_DEVICE_SYNC_DISPOSABLE=1 for these two owned disposable installations.');
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neconyan-device-sync-browser-'));
    await appFixture('one'); await appFixture('two');
});
test.afterAll(async ({}, testInfo) => {
    for (const app of apps) await app.stop();
    if (directory) for (const name of ['one', 'two']) {
        const log = path.join(directory, name + '.log');
        try { await testInfo.attach(name + '-server.log', { path: log, contentType: 'text/plain' }); } catch { /* A failed startup may have no log yet. */ }
    }
    if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test('real pairing route exchanges two accounts behind basic auth, does not grant browser/API admission, and revokes fail closed', async ({ browser }) => {
    const a = await account(browser, apps[0]), b = await account(browser, apps[1]);
    try {
        for (const f of [a, b]) {
            expect(Object.values((await f.status()).methods).every(method => !method.enabled)).toBe(true);
            await f.post('configure', { passphrase, categories: ['presets'], method: 'pairing', enabled: true });
        }
        await fs.writeFile(path.join(apps[0].dataRoot, 'default-user/instruct/Device Sync Fixture.json'), '{"text":"from A"}');
        const grant = await b.post('grant');
        const code = 'neconyan-sync:' + Buffer.from(JSON.stringify({ url: apps[1].url, owner: grant.owner, id: grant.id, token: grant.token })).toString('base64url');
        expect(code).not.toContain(credentials.password);
        await a.post('configure', { method: 'pairing', enabled: true, config: { code } });
        const paired = await a.post('now', { method: 'pairing' }); expect(paired.published).toBe(true);
        const file = path.join(apps[1].dataRoot, 'default-user/instruct/Device Sync Fixture.json');
        expect(await fs.readFile(file, 'utf8')).toBe('{"text":"from A"}');
        await fs.writeFile(file, '{"text":"from B"}'); await a.post('now', { method: 'pairing' });
        expect(await fs.readFile(path.join(apps[0].dataRoot, 'default-user/instruct/Device Sync Fixture.json'), 'utf8')).toBe('{"text":"from B"}');
        const authorization = { Authorization: 'NeconyanPair ' + grant.token };
        const endpoint = `${apps[1].url}/api/device-sync/pair/${grant.owner}/${grant.id}`;
        expect((await raw(apps[1].url + '/api/device-sync/status', { headers: authorization })).status).toBe(401);
        expect((await raw(endpoint, { headers: authorization })).status).toBe(401);
        expect((await raw(endpoint, { method: 'POST', headers: { ...authorization, Origin: apps[0].url }, body: {} })).status).toBe(403);
        expect((await raw(endpoint, { method: 'POST', headers: { ...authorization, 'Sec-Fetch-Mode': 'cors' }, body: {} })).status).toBe(403);
        await b.post('/api/users/create', { handle: 'isolated', name: 'Isolated', password: '' });
        const isolated = await account(browser, apps[1], false, 'isolated');
        try {
            expect(Object.values((await isolated.status()).methods).every(method => !method.enabled)).toBe(true);
            const wrongAccount = await isolated.context.request.get('/api/device-sync/status', { headers: { ...isolated.headers, 'X-Neconyan-Account': 'default-user' } });
            expect(wrongAccount.status()).toBe(409);
            expect((await raw(endpoint.replace('/default-user/', '/isolated/'), { method: 'POST', headers: authorization, body: {} })).status).toBe(409);
        } finally { await isolated.context.close(); }
        await b.post('revoke', { id: grant.id });
        expect((await raw(endpoint, { method: 'POST', headers: authorization, body: {} })).status).toBe(403);
        const second = await b.post('grant'); await b.post('configure', { method: 'pairing', enabled: false });
        expect((await raw(`${apps[1].url}/api/device-sync/pair/${second.owner}/${second.id}`, { method: 'POST', headers: { Authorization: 'NeconyanPair ' + second.token }, body: {} })).status).toBe(409);
        expect((await b.status()).grants).toHaveLength(0);
        const serialized = JSON.stringify(await b.status()); expect(serialized).not.toContain(passphrase); expect(serialized).not.toContain(grant.token);
    } finally { await a.context.close(); await b.context.close(); }
});

for (const phone of [false, true]) test(`settings ${phone ? 'phone' : 'desktop'} performs explicit file download/import and conflict choice without external requests`, async ({ browser }) => {
    test.setTimeout(90000);
    const a = await account(browser, apps[0], phone);
    try {
        // Reset only this feature's disposable configuration, never application files.
        for (const method of ['file', 'webdav', 'gist', 'pairing']) await a.post('configure', { method, enabled: false });
        await a.post('configure', { passphrase, categories: ['presets'] });
        const page = await a.context.newPage(), external = [];
        await page.addInitScript(() => {
            window.addEventListener('neconyan:ready', () => { window.__syncFixtureReady = true; });
        });
        const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
        page.on('request', req => { if (!req.url().startsWith(apps[0].url) && /^https?:/.test(req.url())) external.push(req.url()); });
        await page.goto('/'); await page.waitForLoadState('domcontentloaded');
        await page.waitForFunction(() => window.__syncFixtureReady === true);
        if (await skip.isVisible()) {
            await skip.click();
            await expect(skip).toBeHidden();
        }
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
        await page.locator('.sb-settings-tab-btn[data-tab="device-sync"]').click();
        const sync = page.locator('#nn-device-sync'); await expect(sync.locator('#nn-device-sync-ready')).toBeVisible();
        expect(external).toEqual([]);
        await expect(sync.locator('.nn-sync-method input[type="checkbox"]:checked')).toHaveCount(0);
        const file = sync.locator('[data-method="file"]'); await file.locator('input[type="checkbox"]').check();
        await expect(file.getByRole('button', { name: 'Download encrypted file', exact: true })).toBeVisible();
        const downloadReady = page.waitForEvent('download'); await file.getByRole('button', { name: 'Download encrypted file', exact: true }).click();
        const download = await downloadReady; const downloaded = await download.path();
        const envelope = JSON.parse(await fs.readFile(downloaded, 'utf8')); expect(envelope.format).toBe('neconyan-encrypted-sync');
        await expect(sync).not.toHaveAttribute('aria-busy', 'true');
        await file.locator('input[type="file"]').setInputFiles(downloaded); await file.getByRole('button', { name: 'Import encrypted file', exact: true }).click();
        await expect(sync.locator('[role="status"]')).toContainText('imported');
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        for (const button of await sync.locator('button:visible').all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
        const other = await account(browser, apps[1]);
        try {
            await other.post('configure', { method: 'file', enabled: true, passphrase, categories: ['presets'] });
            const relative = `instruct/Browser ${phone ? 'Phone' : 'Desktop'}.json`;
            await fs.writeFile(path.join(apps[1].dataRoot, 'default-user', relative), '{"text":"incoming"}');
            await fs.writeFile(path.join(apps[0].dataRoot, 'default-user', relative), '{"text":"mine"}');
            const incoming = await other.post('export');
            await file.locator('input[type="file"]').setInputFiles({ name: 'incoming.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming)) });
            await file.getByRole('button', { name: 'Import encrypted file', exact: true }).click();
            const conflict = sync.locator('.nn-sync-conflict').filter({ hasText: relative }); await expect(conflict).toBeVisible();
            await test.step('choose the incoming conflict through the visible settings control', async () => {
                await conflict.getByRole('button', { name: 'Use incoming copy', exact: true }).click({ timeout: 10000 });
                const reload = page.getByRole('button', { name: 'Reload imported data', exact: true });
                await expect(reload).toBeVisible();
                await Promise.all([page.waitForEvent('domcontentloaded'), reload.click()]); await openSync(page);
                await expect(conflict).toContainText('Resolved'); expect(await fs.readFile(path.join(apps[0].dataRoot, 'default-user', relative), 'utf8')).toBe('{"text":"incoming"}');
            });
        } finally { await other.context.close().catch(() => {}); }
        await fs.mkdir(path.join(root, 'screenshots'), { recursive: true });
        await page.screenshot({ path: path.join(root, `screenshots/device-sync-${phone ? 'phone' : 'desktop'}-flow.png`) });
    } finally { await a.context.close().catch(() => {}); }
});

for (const phone of [false, true]) test(`settings ${phone ? 'phone' : 'desktop'} protects a pending save, imports appearance/persona, reloads and accepts the next ordinary save`, async ({ browser }) => {
    test.setTimeout(90000);
    const a = await account(browser, apps[0], phone);
    let releaseSave;
    try {
        await a.post('configure', { method: 'file', enabled: true, passphrase, categories: ['appearance', 'personas'] });
        const page = await a.context.newPage();
        await page.addInitScript(() => { window.addEventListener('neconyan:ready', () => { window.__syncFixtureReady = true; }); });
        await page.goto('/'); await openSync(page);
        await page.evaluate(async () => {
            window.$('#themes').val('Neconyan Calico Dark').trigger('change');
            const core = await import('/script.js');
            if (!await core.saveSettings(0, { returnResult: true })) throw new Error('Could not save the fixture theme');
        });
        const baseline = await decrypt(await a.post('export'), passphrase);
        const appearance = baseline.entries.find(item => item.path === 'portable/appearance.json');
        const power = JSON.parse(Buffer.from(appearance.data, 'base64'));
        power.font_scale = phone ? 1.1 : 1.2;
        const updated = entry(appearance.path, Buffer.from(JSON.stringify(power)));
        updated.bases = [{ deviceId: baseline.deviceId, hash: appearance.hash }];
        const avatar = `review-${phone ? 'phone' : 'desktop'}.png`;
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
        const incoming = await encrypt({ format: 'neconyan-device-sync', version: 1, deviceId: randomUUID(), sequence: 1,
            categories: ['appearance', 'personas'], entries: [updated, entry('User Avatars/' + avatar, png),
                entry('portable/personas/' + avatar + '.json', Buffer.from(JSON.stringify({ name: 'Imported review persona', description: { description: 'Imported description' } }))) ] }, passphrase);
        let intercepted = false, importDispatched = false;
        const blocked = new Promise(resolve => { releaseSave = resolve; });
        await page.route('**/api/settings/save', async route => {
            if (!intercepted && route.request().postDataJSON()?.power_user?.auto_scroll_chat_to_bottom === false) {
                intercepted = true; await blocked;
            }
            await route.continue();
        });
        page.on('request', req => { if (req.url().endsWith('/api/device-sync/import')) importDispatched = true; });
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            const core = await import('/script.js');
            power_user.auto_scroll_chat_to_bottom = false;
            window.__syncPendingSave = core.saveSettings(0, { returnResult: true });
        });
        await expect.poll(() => intercepted).toBe(true);
        const file = page.locator('#nn-device-sync [data-method="file"]');
        await file.locator('input[type="file"]').setInputFiles({ name: 'review-settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming)) });
        await file.getByRole('button', { name: 'Import encrypted file', exact: true }).click();
        const modal = page.locator('#nn-sync-protected-reload');
        await expect(modal).toContainText('Saving current work before syncing');
        expect(importDispatched).toBe(false);
        expect(await page.evaluate(() => document.querySelector('#nn-sync-protected-reload').closest('dialog').matches(':modal'))).toBe(true);
        releaseSave();
        await expect(modal).toContainText('The transferred data is saved.');
        expect(await page.evaluate(() => window.__syncPendingSave)).toBe(true);
        const savedBeforeReload = JSON.parse(await fs.readFile(path.join(apps[0].dataRoot, 'default-user/settings.json'), 'utf8'));
        expect(savedBeforeReload.power_user.auto_scroll_chat_to_bottom).toBe(false);
        expect(savedBeforeReload.power_user.font_scale).toBe(power.font_scale);
        expect(savedBeforeReload.power_user.personas[avatar]).toBe('Imported review persona');
        await fs.mkdir(path.join(root, 'screenshots'), { recursive: true });
        await page.screenshot({ path: path.join(root, `screenshots/device-sync-${phone ? 'phone' : 'desktop'}-protected-reload.png`) });
        const reload = modal.getByRole('button', { name: 'Reload imported data', exact: true });
        expect((await reload.boundingBox()).height).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        await Promise.all([page.waitForEvent('domcontentloaded'), reload.click()]); await page.waitForFunction(() => window.__syncFixtureReady === true);
        const after = await page.evaluate(async avatar => {
            const { power_user } = await import('/scripts/power-user.js');
            return { scale: power_user.font_scale, name: power_user.personas[avatar], description: power_user.persona_descriptions[avatar].description,
                appliedScale: document.documentElement.style.getPropertyValue('--fontScale') };
        }, avatar);
        expect(after).toEqual({ scale: power.font_scale, name: 'Imported review persona', description: 'Imported description', appliedScale: String(power.font_scale) });
        expect(await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.auto_scroll_chat_to_bottom = true;
            return (await import('/script.js')).saveSettings(0, { returnResult: true });
        })).toBe(true);
        const savedAfter = JSON.parse(await fs.readFile(path.join(apps[0].dataRoot, 'default-user/settings.json'), 'utf8'));
        expect(savedAfter.power_user.font_scale).toBe(power.font_scale);
        expect(savedAfter.power_user.personas[avatar]).toBe('Imported review persona');
        expect(savedAfter.power_user.persona_descriptions[avatar].description).toBe('Imported description');
        expect(savedAfter.power_user.auto_scroll_chat_to_bottom).toBe(true);
    } finally { releaseSave?.(); await a.context.close().catch(() => {}); }
});
