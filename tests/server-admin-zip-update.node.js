import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import archiver from 'archiver';
import { createZipReleaseChecker, stageZipReleaseUpdate } from '../src/server-admin-zip-update.js';
import { applyReleaseOverlay, rollbackOverlay } from '../src/zip-update-helper.js';

const version = '1.4.1.1';
const assetUrl = `https://github.com/platberlitz/Neconyan/releases/download/v${version}/Neconyan-${version}-source.zip`;
const asset = { name: `Neconyan-${version}-source.zip`, browser_download_url: assetUrl, size: 100, digest: 'sha256:' + 'a'.repeat(64) };
const release = (assets = [asset]) => ({ tag_name: `v${version}`, draft: false, prerelease: false, assets });
const response = value => new Response(JSON.stringify(value));

function temporary(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-zip-update-test-'));
    // The detached restart fixture can still be releasing its working directory
    // immediately after writing the marker, which briefly locks it on Windows.
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    return root;
}

function write(root, relative, value) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, value);
}

async function sourceZip(extra = {}, packageName = 'neconyan') {
    const archive = archiver('zip');
    const chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    const done = new Promise((resolve, reject) => { archive.on('end', resolve); archive.on('error', reject); });
    for (const [name, content] of Object.entries({
        'package.json': JSON.stringify({ name: packageName, version }),
        'package-lock.json': '{}', 'server.js': '// server', 'src/server-main.js': '// main', 'public/index.html': '<html></html>',
        ...extra,
    })) archive.append(content, { name: `Neconyan-${version}/${name}` });
    archive.symlink(`Neconyan-${version}/CLAUDE.md`, 'AGENTS.md');
    await archive.finalize();
    await done;
    return Buffer.concat(chunks);
}

function stageStatus(bytes) {
    return { currentVersion: '1.4.1', latestVersion: version, assetName: asset.name, assetUrl,
        assetSize: bytes.length, assetDigest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
}

test('ZIP updates use official source assets and compare four-part versions without downgrading', async () => {
    let calls = 0;
    const check = createZipReleaseChecker({ fetchImpl: async url => {
        calls++;
        assert.equal(url, 'https://api.github.com/repos/platberlitz/Neconyan/releases/latest');
        return response(release());
    } });
    const update = await check('1.4.1');
    assert.equal(update.canUpdate, true);
    assert.equal(update.assetUrl, assetUrl);
    assert.equal((await check(version)).canUpdate, false);
    assert.equal((await check('1.5.0')).canUpdate, false);
    assert.equal(calls, 1);
    await check('1.4.1', { force: true });
    assert.equal(calls, 2);
});

test('ZIP checks refuse absent, unverified and off-repository assets, and report network failures', async () => {
    for (const assets of [[], [{ ...asset, digest: '' }], [{ ...asset, browser_download_url: 'https://example.test/update.zip' }]]) {
        const check = createZipReleaseChecker({ fetchImpl: async () => response(release(assets)) });
        const status = await check('1.0.0');
        assert.equal(status.checked, true);
        assert.equal(status.canUpdate, false);
    }
    for (const metadata of [{ ...release(), prerelease: true }, { ...release(), tag_name: 'vnext' }]) {
        const check = createZipReleaseChecker({ fetchImpl: async () => response(metadata) });
        assert.equal((await check('1.0.0')).checked, false);
    }
    const check = createZipReleaseChecker({ fetchImpl: async () => { throw new Error('offline'); } });
    assert.match((await check('1.0.0')).message, /Could not check GitHub/);
});

test('ZIP staging verifies bytes and application version, extracting only into its temporary folder', async t => {
    const root = temporary(t);
    const bytes = await sourceZip();
    const staged = await stageZipReleaseUpdate(stageStatus(bytes), { temporaryDirectory: root, fetchImpl: async () => new Response(bytes) });
    assert.equal(staged.version, version);
    assert.equal(JSON.parse(fs.readFileSync(path.join(staged.releaseRoot, 'package.json'))).name, 'neconyan');
    assert.equal(fs.existsSync(path.join(staged.releaseRoot, 'CLAUDE.md')), false);
    assert.equal(fs.existsSync(path.join(root, 'package.json')), false);
});

test('ZIP staging keeps no partial download after corruption or an invalid application', async t => {
    const root = temporary(t);
    const bytes = await sourceZip();
    await assert.rejects(stageZipReleaseUpdate(stageStatus(bytes), { temporaryDirectory: root, fetchImpl: async () => new Response(Buffer.alloc(bytes.length)) }), /does not match/);
    const wrong = await sourceZip({}, 'another-app');
    await assert.rejects(stageZipReleaseUpdate(stageStatus(wrong), { temporaryDirectory: root, fetchImpl: async () => new Response(wrong) }), /wrong application/);
    assert.deepEqual(fs.readdirSync(root), []);
    await assert.rejects(stageZipReleaseUpdate({ ...stageStatus(bytes), assetUrl: 'https://example.test/update.zip' }, {
        fetchImpl: () => assert.fail('must not fetch an untrusted URL'),
    }), /verified Neconyan/);
});

test('ZIP staging rejects Windows path aliases and case-insensitive duplicates', async t => {
    const root = temporary(t);
    for (const extra of [{ 'unsafe:stream': 'bad' }, { 'trailing.': 'bad' }, { 'PUBLIC/index.html': 'duplicate' }, { 'con.txt': 'bad' }]) {
        const bytes = await sourceZip(extra);
        await assert.rejects(stageZipReleaseUpdate(stageStatus(bytes), { temporaryDirectory: root, fetchImpl: async () => new Response(bytes) }), /unsafe filename|duplicate filename/);
        assert.deepEqual(fs.readdirSync(root), []);
    }
});

test('ZIP overlay preserves data and custom config paths, updates app files and rolls back exactly', t => {
    const root = temporary(t);
    const installDir = path.join(root, 'installed');
    const releaseRoot = path.join(root, 'release');
    const backupRoot = path.join(root, 'backup');
    fs.mkdirSync(backupRoot);
    const logPath = path.join(backupRoot, 'update.log');
    for (const [name, content] of Object.entries({
        'server.js': 'old', 'config.yaml': 'secret', 'data/chat.jsonl': 'chat', 'profiles/config.yml': 'custom secret',
        'my-data/chat.jsonl': 'custom chat', 'plugins/local.js': 'local', 'dist/frontend/asset-manifest.json': '{}',
    })) write(installDir, name, content);
    for (const name of ['server.js', 'config.yaml', 'data/chat.jsonl', 'profiles/config.yml', 'my-data/chat.jsonl', 'plugins/local.js', 'new/file.js']) write(releaseRoot, name, 'new');
    const state = { backups: new Map(), createdPaths: [] };
    applyReleaseOverlay({ releaseRoot, installDir, backupRoot, logPath,
        preservePaths: [path.join(installDir, 'profiles/config.yml'), path.join(installDir, 'my-data')] }, state);
    assert.equal(fs.readFileSync(path.join(installDir, 'server.js'), 'utf8'), 'new');
    for (const [name, content] of Object.entries({ 'config.yaml': 'secret', 'data/chat.jsonl': 'chat', 'profiles/config.yml': 'custom secret', 'my-data/chat.jsonl': 'custom chat', 'plugins/local.js': 'local' })) {
        assert.equal(fs.readFileSync(path.join(installDir, name), 'utf8'), content);
    }
    assert.equal(fs.existsSync(path.join(installDir, 'dist/frontend/asset-manifest.json')), false);
    rollbackOverlay(installDir, state, logPath);
    assert.equal(fs.readFileSync(path.join(installDir, 'server.js'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(installDir, 'new')), false);
    assert.equal(fs.readFileSync(path.join(installDir, 'dist/frontend/asset-manifest.json'), 'utf8'), '{}');
});

test('ZIP overlay refuses an installed directory junction before modifying app files', t => {
    const root = temporary(t);
    const installDir = path.join(root, 'installed');
    const releaseRoot = path.join(root, 'release');
    const external = path.join(root, 'external');
    write(installDir, 'server.js', 'old');
    write(releaseRoot, 'server.js', 'new');
    write(releaseRoot, 'public/index.html', 'new');
    write(external, 'index.html', 'private');
    fs.symlinkSync(external, path.join(installDir, 'public'), 'junction');
    assert.throws(() => applyReleaseOverlay({ releaseRoot, installDir, backupRoot: root, logPath: path.join(root, 'log') },
        { backups: new Map(), createdPaths: [] }), /is a link/);
    assert.equal(fs.readFileSync(path.join(installDir, 'server.js'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(external, 'index.html'), 'utf8'), 'private');
});

test('ZIP overlay checks a linked frontend build before changing application files', t => {
    const root = temporary(t), installDir = path.join(root, 'installed'), releaseRoot = path.join(root, 'release');
    const external = path.join(root, 'external');
    write(installDir, 'server.js', 'old');
    write(releaseRoot, 'server.js', 'new');
    write(external, 'frontend/asset-manifest.json', 'private');
    fs.symlinkSync(external, path.join(installDir, 'dist'), 'junction');
    assert.throws(() => applyReleaseOverlay({ releaseRoot, installDir, backupRoot: root, logPath: path.join(root, 'log') },
        { backups: new Map(), createdPaths: [] }), /is a link/);
    assert.equal(fs.readFileSync(path.join(installDir, 'server.js'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(external, 'frontend/asset-manifest.json'), 'utf8'), 'private');
});

for (const failInstall of [false, true]) {
    test(`ZIP helper hands off, installs and restarts with matching files and dependencies (install fails: ${failInstall})`, { timeout: 60000 }, async t => {
        const root = temporary(t), installDir = path.join(root, 'installed app'), stagingRoot = path.join(root, 'staging');
        const releaseRoot = path.join(stagingRoot, 'release');
        const marker = path.join(root, 'restarted');
        write(installDir, 'package.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }));
        write(installDir, 'server.js', 'old');
        write(installDir, 'node_modules/old-dependency/index.js', 'old dependency');
        write(installDir, 'data/keep.txt', 'saved data');
        const pkg = { name: 'fixture', version: '2.0.0', scripts: { postinstall: failInstall ? 'node -e "process.exit(1)"' : 'node -e "process.exit(0)"' } };
        write(releaseRoot, 'package.json', JSON.stringify(pkg));
        write(releaseRoot, 'package-lock.json', JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { ...pkg, hasInstallScript: true } } }));
        write(releaseRoot, 'server.js', 'new');
        const restartScript = path.join(root, 'restart.cjs');
        fs.writeFileSync(restartScript, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'restarted')`);
        const restarted = new Promise((resolve, reject) => {
            const watcher = fs.watch(root, () => { if (fs.existsSync(marker)) { clearTimeout(timer); watcher.close(); resolve(); } });
            const timer = setTimeout(() => { watcher.close(); reject(new Error('The helper did not restart the application.')); }, 45000);
            t.after(() => { clearTimeout(timer); watcher.close(); });
        });
        // No parent exists at this PID; the helper can apply the staged release immediately.
        const payload = { parentPid: 2147483647, installDir, stagingRoot, releaseRoot, command: [process.execPath, restartScript] };
        const child = spawn(process.execPath, [fileURLToPath(new URL('../src/zip-update-helper.js', import.meta.url)), Buffer.from(JSON.stringify(payload)).toString('base64')], {
            env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let ready = false, output = '';
        child.on('message', message => { ready ||= message.type === 'zip-update-ready'; child.disconnect(); });
        child.stdout.on('data', bytes => { output += bytes; });
        child.stderr.on('data', bytes => { output += bytes; });
        const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        assert.equal(ready, true, output);
        assert.equal(exit, failInstall ? 1 : 0, output);
        await restarted;
        assert.equal(fs.readFileSync(path.join(installDir, 'server.js'), 'utf8'), failInstall ? 'old' : 'new');
        assert.equal(fs.existsSync(path.join(installDir, 'node_modules/old-dependency/index.js')), failInstall);
        assert.equal(fs.readFileSync(path.join(installDir, 'data/keep.txt'), 'utf8'), 'saved data');
        assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'))).version, failInstall ? '1.0.0' : '2.0.0');
    });
}
