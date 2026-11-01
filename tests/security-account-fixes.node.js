/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import storage from 'node-persist';
import { fixture } from './roleplay-transactions-fixture.js';

const { acceptApplicationOperation, runOperation } = await import('../src/operations/jobs.js');
await import('../src/operations/account-import.js');
const { captureAccountBackup } = await import('../src/operations/account-backup.js');
const { captureFolderImport, captureZipImport } = await import('../src/operations/account-import-sources.js');
const { retainUploadedArchive } = await import('../src/operations/input-files.js');
const { readOperation } = await import('../src/operations/store.js');
const { getJob } = await import('../src/jobs/store.js');
const { router: usersAdminRouter } = await import('../src/endpoints/users-admin.js');
const { router: extensionsRouter } = await import('../src/endpoints/extensions.js');
const { initUserStorage, getUserDirectories, toKey } = await import('../src/users.js');
const { PUBLIC_DIRECTORIES } = await import('../src/constants.js');

function invokeRoute(router, routePath, method, req) {
    const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
    const handlers = layer.route.stack.map(s => s.handle);
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            body: undefined,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; resolve(this); return this; },
            send(payload) { this.body = payload; resolve(this); return this; },
            sendStatus(code) { this.statusCode = code; resolve(this); return this; },
        };
        let index = 0;
        const next = err => {
            if (err) return reject(err);
            const fn = handlers[index++];
            if (!fn) return resolve(res);
            Promise.resolve(fn(req, res, next)).catch(reject);
        };
        next();
    });
}

test('CRITICAL-1: non-admin folder import and active data root overlap are refused while external admin folder and ZIP imports work', async t => {
    const admin = fixture(t, false, 'default-user');
    const dataRoot = path.dirname(admin.scope.directories.root);
    const previousDataRoot = globalThis.DATA_ROOT;
    globalThis.DATA_ROOT = dataRoot;
    t.after(() => { globalThis.DATA_ROOT = previousDataRoot; });

    fs.writeFileSync(path.join(admin.scope.directories.root, 'secrets.json'), JSON.stringify({ api_key_openai: [{ id: '1', value: 'sk-victim-secret', label: 'main', active: true }] }));
    fs.writeFileSync(path.join(admin.scope.directories.root, 'settings.json'), JSON.stringify({ username: 'VictimAdmin' }));

    const aliceRoot = path.join(dataRoot, 'alice');
    const aliceDirs = Object.fromEntries(['chats', 'groupChats', 'characters', 'groups', 'backups', 'extensions'].map(k => [k, path.join(aliceRoot, k)]));
    aliceDirs.root = aliceRoot;
    for (const dir of Object.values(aliceDirs)) fs.mkdirSync(dir, { recursive: true });
    const { initialiseRoleplayAccount } = await import('../src/roleplay-store.js');
    initialiseRoleplayAccount({ owner: 'alice', directories: aliceDirs });

    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-ext-migration-'));
    t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(externalRoot, 'characters'), { recursive: true });
    fs.writeFileSync(path.join(externalRoot, 'settings.json'), JSON.stringify({ username: 'MigratedExternal' }));
    fs.mkdirSync(path.join(externalRoot, 'extensions/ExtOne'), { recursive: true });
    fs.writeFileSync(path.join(externalRoot, 'extensions/ExtOne/manifest.json'), JSON.stringify({ display_name: 'ExtOne', version: '1.0.0' }));
    fs.writeFileSync(path.join(externalRoot, 'extensions/ExtOne/index.js'), 'export default 1;');

    const nonAdminReq = {
        user: { profile: { handle: 'alice', admin: false }, directories: aliceDirs },
        get: () => undefined,
    };
    const adminReq = {
        user: { profile: { handle: 'default-user', admin: true }, directories: admin.scope.directories },
        get: () => undefined,
    };

    // 1. Non-admin cannot submit folder or extensions imports at all (even from external paths or victim paths)
    for (const mode of ['folder', 'extensions']) {
        for (const targetPath of [admin.scope.directories.root, dataRoot, externalRoot]) {
            await assert.rejects(
                acceptApplicationOperation(nonAdminReq, { key: `nonadmin-${mode}-${path.basename(targetPath)}`, kind: 'account-import', mode, path: targetPath }),
                error => error.status === 403,
                `Non-admin mode=${mode} path=${targetPath} must be rejected with 403`,
            );
        }
    }
    assert.equal(fs.existsSync(path.join(aliceRoot, 'secrets.json')), false);

    // 2. Admin cannot import from inside the active DATA_ROOT (e.g. another user's folder or DATA_ROOT itself) or server checkout root
    for (const badPath of [aliceRoot, dataRoot, path.dirname(dataRoot), process.cwd()]) {
        assert.throws(
            () => captureFolderImport({ owner: 'default-user', directories: admin.scope.directories }, badPath),
            error => error.status === 400,
            `captureFolderImport on ${badPath} must fail with 400`,
        );
        await assert.rejects(
            acceptApplicationOperation(adminReq, { key: `admin-bad-${path.basename(badPath)}`, kind: 'account-import', mode: 'folder', path: badPath }),
            error => error.status === 400,
            `Admin folder import on ${badPath} must fail with 400`,
        );
    }

    // 3. Admin external folder migration still succeeds
    const acceptedFolder = await acceptApplicationOperation(adminReq, {
        key: 'admin-ext-folder',
        kind: 'account-import',
        mode: 'folder',
        content: 'core',
        parts: ['personas'],
        path: externalRoot,
    });
    assert.equal(acceptedFolder.created, true);
    await runOperation({
        owner: 'default-user',
        directories: admin.scope.directories,
        job: getJob(admin.scope.directories, acceptedFolder.job.id),
        signal: new AbortController().signal,
        progress: async () => {},
    });
    assert.equal(readOperation({ owner: 'default-user', directories: admin.scope.directories }, 'admin-ext-folder').state, 'completed');

    // 4. Non-admin legitimate ZIP import still succeeds
    const archiver = (await import('archiver')).default;
    const { finished } = await import('node:stream/promises');
    const zipPath = path.join(externalRoot, 'legit.zip');
    const out = fs.createWriteStream(zipPath);
    const done = finished(out);
    const zip = archiver('zip');
    zip.pipe(out);
    zip.append(JSON.stringify({ power_user: { personas: { 'p.png': 'AlicePersona' }, persona_descriptions: {} } }), { name: 'default-user/settings.json' });
    await zip.finalize();
    await done;

    const { base: aliceBase, account: aliceAccount } = (await import('../src/operations/jobs.js')).operationAccount(nonAdminReq);
    const retained = await retainUploadedArchive(aliceBase, aliceAccount, 'alice-zip', zipPath);
    const acceptedZip = await acceptApplicationOperation(nonAdminReq, {
        key: 'alice-zip-import',
        kind: 'account-import',
        mode: 'zip',
        content: 'core',
        parts: ['personas'],
        inputId: retained.id,
    });
    assert.equal(acceptedZip.created, true);
});

test('HIGH-1: POST /api/users/delete rejects traversal, internal directories, and non-existent users without touching disk, while deleting existing users works', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-users-delete-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dataRoot = path.join(root, 'data');
    const outsideCanary = path.join(root, 'outside-canary');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(outsideCanary, { recursive: true });
    fs.writeFileSync(path.join(outsideCanary, 'keep.txt'), 'survive');

    const previousDataRoot = globalThis.DATA_ROOT;
    globalThis.DATA_ROOT = dataRoot;
    t.after(() => { globalThis.DATA_ROOT = previousDataRoot; });

    await initUserStorage(dataRoot);
    const authDir = path.join(dataRoot, '_auth');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'sessions.json'), '{}');

    const unmatchedDir = path.join(dataRoot, 'unregistered-folder');
    fs.mkdirSync(unmatchedDir, { recursive: true });
    fs.writeFileSync(path.join(unmatchedDir, 'important.txt'), 'do not delete');

    const adminReq = body => ({
        body,
        user: { profile: { handle: 'default-user', admin: true }, directories: getUserDirectories('default-user') },
    });

    for (const badHandle of ['.', '..', '/', '../outside-canary', 'alice/../../outside-canary', '_storage', '_auth', '_roleplay', '_uploads']) {
        const res = await invokeRoute(usersAdminRouter, '/delete', 'post', adminReq({ handle: badHandle, purge: true }));
        assert.equal(res.statusCode, 400, `Expected 400 for handle=${badHandle}, got ${res.statusCode}`);
    }

    // Non-existent valid-looking handle returns 404 and does not rm its folder on disk
    const missingRes = await invokeRoute(usersAdminRouter, '/delete', 'post', adminReq({ handle: 'unregistered-folder', purge: true }));
    assert.equal(missingRes.statusCode, 404);

    assert.equal(fs.existsSync(path.join(outsideCanary, 'keep.txt')), true);
    assert.equal(fs.existsSync(path.join(authDir, 'sessions.json')), true);
    assert.equal(fs.existsSync(path.join(dataRoot, '_storage')), true);
    assert.equal(fs.existsSync(path.join(unmatchedDir, 'important.txt')), true);

    // Legitimate existing user deletion works with legacy underscore/mixed-case handle compatibility
    const bobHandle = 'Bob_Legacy.1';
    const bobDirs = getUserDirectories(bobHandle);
    fs.mkdirSync(bobDirs.root, { recursive: true });
    fs.writeFileSync(path.join(bobDirs.root, 'settings.json'), '{}');
    await storage.setItem(toKey(bobHandle), {
        handle: bobHandle,
        name: 'Bob',
        created: Date.now(),
        password: '',
        salt: '',
        admin: false,
        enabled: true,
    });

    const okRes = await invokeRoute(usersAdminRouter, '/delete', 'post', adminReq({ handle: bobHandle, purge: true }));
    assert.equal(okRes.statusCode, 204);
    assert.equal(await storage.getItem(toKey(bobHandle)), undefined);
    assert.equal(fs.existsSync(bobDirs.root), false);
});

test('MEDIUM-4: POST /api/extensions/version rejects global extension checks from non-admin users before git bootstrap or fetch', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-ext-version-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const original = { ...PUBLIC_DIRECTORIES };
    const local = path.join(root, 'local');
    const global = path.join(root, 'global');
    fs.mkdirSync(local, { recursive: true });
    fs.mkdirSync( path.join(global, 'SharedExt'), { recursive: true });
    fs.writeFileSync(path.join(global, 'SharedExt/manifest.json'), JSON.stringify({
        display_name: 'SharedExt',
        version: '1.0.0',
        homepage: 'http://127.0.0.1:1/unreachable.git',
    }));
    PUBLIC_DIRECTORIES.globalExtensions = global;
    t.after(() => Object.assign(PUBLIC_DIRECTORIES, original));

    const res = await invokeRoute(extensionsRouter, '/version', 'post', {
        body: { extensionName: 'SharedExt', global: true },
        user: { profile: { handle: 'alice', admin: false }, directories: { extensions: local } },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(fs.existsSync(path.join(global, 'SharedExt/.git')), false);
});

test('MEDIUM-6: secret-excluding account backups and folder/ZIP imports exclude .secret_key while preserving portable secret-inclusive backups', async t => {
    const p = fixture(t, false, 'backup-key-owner');
    const base = { owner: 'backup-key-owner', directories: p.scope.directories };
    fs.writeFileSync(path.join(base.directories.root, 'settings.json'), '{"username":"KeyOwner"}');
    fs.writeFileSync(path.join(base.directories.root, 'secrets.json'), '{"api_key_openai":[{"id":"1","value":"secret","label":"k","active":true}]}');
    fs.writeFileSync(path.join(base.directories.root, '.secret_key'), 'auto-generated-key-material');

    const excludedPlan = captureAccountBackup(base, p.scope, { handle: base.owner }, { includeSecrets: false });
    assert.equal(excludedPlan.files.some(f => f.relative === '.secret_key'), false, '.secret_key must be excluded when includeSecrets is false');
    assert.equal(excludedPlan.files.some(f => f.relative === 'secrets.json'), false);

    const includedPlan = captureAccountBackup(base, p.scope, { handle: base.owner }, { includeSecrets: true });
    assert.equal(includedPlan.files.some(f => f.relative === '.secret_key'), true, '.secret_key is preserved when includeSecrets is true');
    assert.equal(includedPlan.files.some(f => f.relative === 'secrets.json'), true);

    // Also verify importRelativePath / captureZipImport never imports .secret_key over an existing account key
    const archiver = (await import('archiver')).default;
    const { finished } = await import('node:stream/promises');
    const zipPath = path.join(path.dirname(base.directories.root), 'with-secret-key.zip');
    const out = fs.createWriteStream(zipPath);
    const done = finished(out);
    const zip = archiver('zip');
    zip.pipe(out);
    zip.append('{"username":"FromZip"}', { name: 'default-user/settings.json' });
    zip.append('foreign-secret-key', { name: 'default-user/.secret_key' });
    await zip.finalize();
    await done;

    const retained = await retainUploadedArchive(base, p.scope, 'zip-key-check', zipPath);
    const zipPlan = await captureZipImport(retained);
    assert.equal(zipPlan.files.some(f => f.relative === '.secret_key'), false);
});
