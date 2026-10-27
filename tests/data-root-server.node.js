import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
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

test('server owns a fresh root, refuses overlap and reclaims a dead owner before restart', { timeout: 180000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-owner-server-'));
    const data = path.join(directory, 'new-data');
    const configPath = path.join(directory, 'config.yaml');
    const config = YAML.parse(fs.readFileSync(path.join(app, 'default/config.yaml'), 'utf8'));
    Object.assign(config, { dataRoot: data, listen: false, enableUserAccounts: false, enableDownloadableTokenizers: false,
        enableServerPlugins: false, enableServerPluginsAutoUpdate: false });
    config.browserLaunch.enabled = false;
    config.extensions.autoUpdate = false;
    config.extensions.models.autoDownload = false;
    config.performance.frontendBuild.enabled = false;
    fs.writeFileSync(configPath, YAML.stringify(config));
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
