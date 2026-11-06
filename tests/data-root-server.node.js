import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { DATA_ROOT_OWNER_DIRECTORY, inspectDataRootOwner } from '../src/data-root-owner.js';

const app = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const result = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return result;
}
function probe(portNumber) {
    return new Promise(resolve => {
        const request = http.get({ hostname: '127.0.0.1', port: portNumber, path: '/csrf-token', timeout: 1000 }, response => {
            response.resume(); resolve(response.statusCode === 200);
        });
        request.on('error', () => resolve(false));
        request.on('timeout', () => request.destroy());
    });
}
async function waitReady(child, portNumber, output) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited before ready: ${output()}`);
        if (await probe(portNumber)) return;
        await sleep(250);
    }
    throw new Error(`Server did not become ready: ${output()}`);
}

function serverFixture(dataName) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-owner-server-'));
    const data = path.join(directory, dataName);
    const configPath = path.join(directory, 'config.yaml');
    const config = YAML.parse(fs.readFileSync(path.join(app, 'default/config.yaml'), 'utf8'));
    Object.assign(config, { dataRoot: data, listen: false, enableUserAccounts: false, enableDownloadableTokenizers: false,
        enableServerPlugins: false, enableServerPluginsAutoUpdate: false });
    config.browserLaunch.enabled = false;
    config.extensions.autoUpdate = false;
    config.extensions.models.autoDownload = false;
    config.performance.frontendBuild.enabled = false;
    fs.writeFileSync(configPath, YAML.stringify(config));
    return { directory, data, configPath };
}

test('server owns a fresh root, refuses overlap and reclaims a dead owner before restart', { timeout: 180000 }, async t => {
    const { directory, data, configPath } = serverFixture('new-data');
    const portNumber = await port();
    const children = [];
    t.after(async () => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL'); await once(child, 'exit');
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });
    let logs = '';
    const start = () => {
        const child = spawn(process.execPath, ['server.js', '--configPath', configPath, '--dataRoot', data,
            '--port', String(portNumber), '--browserLaunchEnabled', 'false'], {
            cwd: app, windowsHide: true, env: { ...process.env, NECONYAN_SUPERVISED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', chunk => { logs += chunk; });
        child.stderr.on('data', chunk => { logs += chunk; });
        children.push(child);
        return child;
    };
    const first = start();
    await waitReady(first, portNumber, () => logs);
    assert.equal(inspectDataRootOwner(data).pid, first.pid);
    const second = start();
    await once(second, 'exit');
    assert.notEqual(second.exitCode, 0);
    assert.match(logs, /repair-data-identity\.js status/);
    assert.equal(inspectDataRootOwner(data).pid, first.pid);
    first.kill('SIGKILL');
    await once(first, 'exit');
    const third = start();
    await waitReady(third, portNumber, () => logs);
    assert.equal(inspectDataRootOwner(data).pid, third.pid);
    third.kill('SIGTERM');
    await once(third, 'exit');
    assert.ok(fs.existsSync(path.join(data, DATA_ROOT_OWNER_DIRECTORY)), 'ownership stays until its process is dead');
    fs.mkdirSync(path.join(data, '_neconyan-policy-repair'));
    const blocked = start();
    await once(blocked, 'exit');
    assert.notEqual(blocked.exitCode, 0);
    assert.match(logs, /identity repair is unfinished/);
});

// Simulated Android app starts (AND-LEASE-01). The real server.js runs; only the platform and the app binding are faked.
const ownerModuleUrl = new URL('../src/data-root-owner.js', import.meta.url).href;
const bump = value => String(BigInt(value) + 1n);

function preload(directory, bindingWorks) {
    const file = path.join(directory, 'android-preload.mjs');
    fs.writeFileSync(file, `Object.defineProperty(process, 'platform', { value: 'android' });
process._linkedBinding = name => { if (${bindingWorks} && name === 'neconyan_fs') return {}; throw new Error('No such binding'); };
`);
    return pathToFileURL(file).href;
}

function plantDeadLease(data, change) {
    fs.mkdirSync(data, { recursive: true });
    execFileSync(process.execPath, ['--input-type=module', '-e',
        `import { acquireDataRootOwner } from ${JSON.stringify(ownerModuleUrl)}; acquireDataRootOwner(process.argv[1], 'server');`, data],
    { windowsHide: true, timeout: 10000 });
    const filename = path.join(data, DATA_ROOT_OWNER_DIRECTORY, 'owner.json');
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    change(value);
    fs.writeFileSync(filename, JSON.stringify(value));
    return { filename, bytes: fs.readFileSync(filename) };
}

async function runFailingStart(t, { dataName = 'data', change, preloadBinding, repairMarker = false }) {
    const fixture = serverFixture(dataName);
    const tmp = path.join(fixture.directory, 'tmp');
    fs.mkdirSync(tmp);
    t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
    const planted = plantDeadLease(fixture.data, change);
    if (repairMarker) fs.mkdirSync(path.join(fixture.data, '_neconyan-policy-repair'));
    const args = ['server.js', '--configPath', fixture.configPath, '--dataRoot', fixture.data,
        '--port', String(await port()), '--browserLaunchEnabled', 'false'];
    if (preloadBinding !== undefined) args.unshift('--import', preload(fixture.directory, preloadBinding));
    const child = spawn(process.execPath, args, { cwd: app, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NECONYAN_SUPERVISED: '1', NECONYAN_ANDROID_APP: '1', TMPDIR: tmp } });
    let logs = '';
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } });
    await once(child, 'exit');
    return { ...fixture, tmp, child, logs, planted };
}

for (const variant of ['hostname', 'root']) {
    test(`a simulated Android app start reclaims a dead lease with a foreign ${variant}`, { timeout: 120000, skip: process.platform !== 'linux' }, async t => {
        const change = value => {
            value.platform = 'android';
            if (variant === 'hostname') value.hostname = 'foreign-host';
            else { value.root.dev = bump(value.root.dev); value.root.ino = bump(value.root.ino); }
        };
        const run = await runFailingStart(t, { change, preloadBinding: true, repairMarker: true });
        assert.notEqual(run.child.exitCode, 0);
        assert.match(run.logs, /Reclaimed a stale data folder lease \(process-ended\)/);
        assert.match(run.logs, variant === 'hostname' ? /differs: hostname\./ : /differs: root\.dev, root\.ino\./);
        assert.match(run.logs, /identity repair is unfinished/);
        assert.doesNotMatch(run.logs, /already owned/);
        assert.equal(inspectDataRootOwner(run.data).pid, run.child.pid);
    });
}

test('the app marker alone keeps the strict lease checks and reports the evidence', { timeout: 120000 }, async t => {
    const run = await runFailingStart(t, { change: value => { value.hostname = 'foreign-host'; } });
    assert.notEqual(run.child.exitCode, 0);
    assert.match(run.logs, /Lease record: pid=/);
    assert.match(run.logs, /differs: hostname/);
    assert.doesNotMatch(run.logs, /repair-data-identity\.js/);
    const note = fs.readFileSync(path.join(run.tmp, 'startup-status.txt'), 'utf8');
    assert.ok(note.startsWith('Could not start Neconyan: The data folder is already owned or needs its ownership checked.'));
    assert.ok(note.includes('differs: hostname'));
    assert.ok(note.endsWith('Saved data has been kept.'));
    assert.deepEqual(fs.readFileSync(run.planted.filename), run.planted.bytes);
});

test('a Termux-like start without the app binding keeps the strict lease checks', { timeout: 120000, skip: process.platform !== 'linux' }, async t => {
    const run = await runFailingStart(t, { change: value => { value.platform = 'android'; value.hostname = 'foreign-host'; }, preloadBinding: false });
    assert.notEqual(run.child.exitCode, 0);
    assert.deepEqual(fs.readFileSync(run.planted.filename), run.planted.bytes);
    assert.equal(run.logs.split('neconyan_fs binding is missing').length - 1, 1);
});
