import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const enabled = process.env.NECONYAN_ANDROID_CONFIG_TEST_DISPOSABLE === '1';
const protectedRoute = '/api/server-admin/config/get';

// Use node:http: fetch adds Fetch Metadata and intentionally cannot use API Basic auth.
function request(host, port, route, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request({
            host, port, path: route, method, agent: false,
            headers: { accept: 'application/json', ...(payload === undefined ? {} : {
                'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
            }), ...headers },
        }, response => {
            let content = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { content += chunk; });
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, content }));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(Object.assign(new Error('Fixture HTTP request timed out.'), { code: 'ETIMEDOUT' })));
        req.end(payload);
    });
}

function json(response) {
    // Never let a parse failure echo the private config or session cookie.
    try { return JSON.parse(response.content); }
    catch { throw new Error(`Fixture expected JSON (HTTP ${response.status}).`); }
}

function client(host, port) {
    const cookies = new Map();
    let token;
    return {
        async send(route, body) {
            const response = await request(host, port, route, {
                method: body === undefined ? 'GET' : 'POST', body,
                headers: {
                    Cookie: [...cookies.values()].join('; '),
                    ...(token ? { 'X-CSRF-Token': token } : {}),
                },
            });
            for (const cookie of response.headers['set-cookie'] ?? []) {
                const pair = cookie.split(';')[0];
                cookies.set(pair.split('=')[0], pair);
            }
            return response;
        },
        async csrf() {
            const response = await this.send('/csrf-token');
            assert.equal(response.status, 200, 'CSRF endpoint is available');
            token = json(response).token;
            assert.equal(typeof token, 'string');
        },
        async signIn(password) {
            await this.csrf();
            const response = await this.send('/api/auth/browser/login', { username: 'neconyan', password, remember: false });
            assert.equal(response.status, 200, 'Fixture browser sign-in succeeds');
            await this.csrf();
        },
    };
}

async function unusedPort() {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, '0.0.0.0', resolve);
    });
    const port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    return port;
}

function stagePackage(directory) {
    if (!fs.existsSync(path.join(root, 'dist/frontend/asset-manifest.json'))) {
        throw new Error('Build the real frontend with npm run build:frontend before the opt-in Android restart fixture.');
    }
    const copy = (source, target) => fs.cpSync(path.join(root, source), path.join(directory, target), {
        recursive: true, mode: fs.constants.COPYFILE_FICLONE,
    });
    for (const name of ['src', 'default', 'public', 'dist/frontend', 'node_modules', 'package.json']) copy(name, name);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.js')) copy(entry.name, entry.name);
    }
    for (const name of ['server-bootstrap.mjs', 'bootstrap-config.mjs', 'file-stats.mjs']) copy(`android/${name}`, name);
    // Match the payload's extension inventory without invoking its networked ICU/npm build.
    const extensions = path.join(directory, 'public/scripts/extensions/third-party');
    fs.writeFileSync(path.join(directory, 'bundled-extensions.json'), JSON.stringify(
        fs.readdirSync(extensions, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(),
    ));
}

test('Android config saves survive real restart, reopening and LAN binding with native authentication', {
    skip: enabled ? false : 'Set NECONYAN_ANDROID_CONFIG_TEST_DISPOSABLE=1 for the owned real-server fixture.',
    timeout: 240000,
}, async t => {
    const external = Object.values(os.networkInterfaces()).flat().find(address =>
        address && address.family === 'IPv4' && !address.internal && !address.address.startsWith('127.'))?.address;
    assert.ok(external, 'BLOCKED: the restart fixture needs a non-loopback IPv4 interface for actual LAN bind evidence.');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-android-config-'));
    const packageRoot = path.join(directory, 'package');
    const state = path.join(directory, 'private');
    const cache = path.join(directory, 'cache');
    const configPath = path.join(state, 'android-config.yaml');
    const readyPath = path.join(state, 'android-ready.json');
    const password = randomBytes(32).toString('hex');
    const port = await unusedPort();
    const records = [];
    let active;
    let api;
    let output = '';
    const redact = value => String(value).replaceAll(password, '[private]').replace(/[a-f0-9]{64}/gi, '[private]');
    const alive = record => !record.finished && record.child.exitCode === null && record.child.signalCode === null;
    const readConfig = () => YAML.parse(fs.readFileSync(configPath, 'utf8'));

    async function waitFor(predicate, description, timeout = 30000) {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
            if (await predicate()) return;
            await delay(50);
        }
        throw new Error(`Timed out: ${description}.`);
    }

    async function stop() {
        if (!active || !alive(active)) return;
        active.child.kill('SIGTERM');
        try { await waitFor(() => !alive(active), 'owned Android server stops', 10000); }
        catch {
            active.child.kill('SIGKILL');
            await active.exited;
        }
    }

    async function start(mode = 'normal') {
        assert.ok(!active || !alive(active), 'Previous owned process is stopped before starting another');
        assert.ok(!fs.existsSync(readyPath), 'The previous ready marker has been removed');
        const child = spawn(process.execPath, [path.join(packageRoot, 'server-bootstrap.mjs'), state, String(port), password, mode, cache], {
            cwd: packageRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NECONYAN_IOS_APP: '0', NECONYAN_SAFE_START: '0', NECONYAN_ANDROID_APP: '1' },
        });
        const record = { child, pid: child.pid, mode, finished: false };
        record.exited = new Promise(resolve => {
            child.once('error', () => { record.finished = true; record.launchFailed = true; resolve(); });
            child.once('exit', (code, signal) => { record.finished = true; record.code = code; record.signal = signal; resolve(); });
        });
        records.push(record);
        active = record;
        for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
            // Keep diagnostics in memory only; the temp tree, including private config, is removed.
            output = (output + redact(data)).slice(-16000);
        });
        await waitFor(() => {
            if (record.launchFailed) throw new Error('Could not launch the disposable Android server.');
            if (!alive(record)) throw new Error(`Android fixture exited before readiness (${record.code ?? record.signal}).`);
            if (!fs.existsSync(readyPath)) return false;
            const marker = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
            return marker.pid === child.pid && marker.port === port && marker.safe === (mode === 'safe');
        }, 'PID/port-gated native ready marker', 60000);
        api = client('127.0.0.1', port);
        await api.signIn(password);
        const version = await api.send('/version');
        assert.equal(version.status, 200, 'Loopback authenticates after every launch');
        record.bootId = json(version).serverBootId;
        assert.equal(typeof record.bootId, 'string');
        assert.ok(record.bootId.length > 0, 'Each process publishes a boot identity');
        for (const previous of records.slice(0, -1)) {
            assert.notEqual(record.pid, previous.pid, 'A fresh child owns the next launch');
            assert.notEqual(record.bootId, previous.bootId, 'A fresh server boot identity is published');
        }
        return record;
    }

    async function configDocument() {
        const response = await api.send(protectedRoute, {});
        assert.equal(response.status, 200, 'Authenticated config read succeeds');
        return json(response);
    }

    async function save(config, restart, expectedLastModifiedMs) {
        const document = await configDocument();
        return api.send('/api/server-admin/config/save', {
            content: YAML.stringify(config), restart,
            expectedLastModifiedMs: expectedLastModifiedMs ?? document.lastModifiedMs,
        });
    }

    async function saveAndRestart(config) {
        const record = active;
        const response = await save(config, true);
        assert.equal(response.status, 202, 'Save & Restart is accepted');
        assert.equal(json(response).restarting, true);
        await waitFor(() => !alive(record), 'Save & Restart exits the first process', 15000);
        await record.exited;
        assert.equal(record.code, 75, 'The real server requests launcher restart with exit 75');
        assert.equal(record.signal, null, 'Restart is a normal process exit');
        assert.ok(!fs.existsSync(readyPath), 'Exited process removes the native ready marker');
    }

    async function assertLiveAndUnchanged(before, mtime, pid) {
        assert.ok(fs.readFileSync(configPath).equals(before), 'Rejected save preserves exact private config bytes');
        assert.equal(fs.statSync(configPath).mtimeMs, mtime, 'Rejected save preserves file mtime');
        await delay(300); // Cross the real restart scheduler's 200 ms response delay.
        assert.ok(alive(active), 'Rejected save leaves the running process alive');
        assert.equal(active.pid, pid, 'Rejected save keeps the same PID');
        assert.equal(JSON.parse(fs.readFileSync(readyPath, 'utf8')).pid, pid, 'Ready marker still belongs to that process');
    }

    try {
        fs.mkdirSync(state, { recursive: true });
        fs.mkdirSync(cache);
        stagePackage(packageRoot);
        await start();
        assert.equal(readConfig().listenAddress.ipv4, '127.0.0.1', 'Fresh Android launch is loopback-only');
        const initial = readConfig();
        const authority = { dataRoot: initial.dataRoot, port: initial.port, basicAuthUser: { ...initial.basicAuthUser } };

        initial.listenAddress.ipv4 = '0.0.0.0';
        initial.protocol.ipv4 = 'auto';
        initial.whitelist = [...new Set([...initial.whitelist, external])];
        initial.logging.enableAccessLog = true;
        initial.performance.frontendBuild.enabled = false;
        initial.git.backend = 'auto';
        initial.enableServerPlugins = true;
        await saveAndRestart(initial);
        await start();
        // This assertion fails against the original bootstrap: saving works but relaunch overwrites it.
        assert.equal(readConfig().listenAddress.ipv4, '0.0.0.0', 'Saved wildcard survives the actual packaged bootstrap restart');
        assert.equal(readConfig().protocol.ipv4, 'auto', 'Detected IPv4 auto binds and reaches native readiness');
        assert.equal(readConfig().logging.enableAccessLog, true);
        assert.equal(readConfig().performance.frontendBuild.enabled, false);
        assert.equal(readConfig().git.backend, 'auto');
        assert.equal(readConfig().enableServerPlugins, true);
        assert.ok(readConfig().whitelist.includes(external), 'Explicit whitelist admission survives restart');

        const anonymous = await request(external, port, protectedRoute, { method: 'POST', body: {} });
        assert.equal(anonymous.status, 401, 'Actual non-loopback connection refuses unauthenticated protected access');
        const lan = client(external, port);
        await lan.csrf();
        const wrong = await lan.send('/api/auth/browser/login', { username: 'neconyan', password: 'incorrect-fixture-password' });
        assert.equal(wrong.status, 401, 'Wrong password cannot authenticate over the actual non-loopback interface');
        await lan.signIn(password);
        const remoteVersion = await lan.send('/version');
        assert.equal(remoteVersion.status, 200, 'Authenticated non-loopback browser reaches the real server');
        assert.equal(json(remoteVersion).serverBootId, active.bootId, 'LAN and native loopback reach the same owned process');
        assert.equal((await lan.send(protectedRoute, {})).status, 200, 'Authenticated LAN config access succeeds');
        t.diagnostic(`Wildcard IPv4 auto bound successfully on loopback and non-loopback ${external}:${port}; anonymous and wrong-password requests were refused.`);

        await stop();
        await start();
        assert.equal(readConfig().listenAddress.ipv4, '0.0.0.0', 'Wildcard survives ordinary reopening without another save');
        const omitted = readConfig();
        for (const key of Object.keys(authority)) delete omitted[key];
        const omittedResponse = await save(omitted, false);
        assert.equal(omittedResponse.status, 200, 'Save without restart accepts omitted launcher-managed fields');
        assert.equal(json(omittedResponse).restarting, false);
        assert.ok(!Object.hasOwn(readConfig(), 'port'), 'The saved document no longer supplies launcher port authority');
        assert.ok(!Object.hasOwn(readConfig(), 'basicAuthUser'), 'The saved document no longer supplies credential authority');

        const invalidEdits = [
            ['port', config => { config.port = port + 1; }],
            ['dataRoot', config => { config.dataRoot = path.join(directory, 'other-data'); }],
            ['basicAuthUser', config => { config.basicAuthUser = { username: 'neconyan', password: 'stale-fixture-password' }; }],
            ['basicAuthUser', config => { config.basicAuthUser = { ...authority.basicAuthUser, username: 'other-user' }; }],
            ['listenAddress.ipv4', config => { config.listenAddress.ipv4 = external; }],
            ['listenAddress.ipv4', config => { config.listenAddress.ipv4 = 'invalid-ipv4'; }],
            ['protocol.ipv4', config => { config.protocol.ipv4 = false; }],
            ['ssl.enabled', config => { config.ssl.enabled = true; }],
            ['listen', config => { config.listen = false; }],
            ['enableUserAccounts', config => { config.enableUserAccounts = true; }],
        ];
        for (const restart of [false, true]) {
            for (const [field, change] of invalidEdits) {
                const before = fs.readFileSync(configPath);
                const mtime = fs.statSync(configPath).mtimeMs;
                const invalid = readConfig();
                change(invalid);
                const response = await save(invalid, restart);
                assert.equal(response.status, 400, `Incompatible ${field} is rejected (${restart ? 'Save & Restart' : 'Save'})`);
                const error = json(response).error;
                assert.equal(typeof error, 'string', 'The existing editor receives an actionable error string');
                assert.ok(error.includes(field), `Error identifies incompatible ${field}`);
                assert.ok(error.length > field.length + 5, 'Error includes the reason for the APK requirement');
                assert.ok(!response.content.includes(password), 'Error response never includes launcher credentials');
                await assertLiveAndUnchanged(before, mtime, active.pid);
            }
        }
        const staleBefore = fs.readFileSync(configPath);
        const staleMtime = fs.statSync(configPath).mtimeMs;
        assert.equal((await save(readConfig(), true, staleMtime - 1000)).status, 409, 'Stale config mtime retains its conflict response');
        await assertLiveAndUnchanged(staleBefore, staleMtime, active.pid);

        const restored = { ...readConfig(), ...authority };
        // The second save uses actual launcher values although the on-disk document omitted them.
        await saveAndRestart(restored);
        await start();
        assert.equal(readConfig().listenAddress.ipv4, '0.0.0.0', 'Successive-save restart retains the wildcard');
        assert.equal(readConfig().port, port, 'Original running launcher port remains authoritative');
        assert.ok(readConfig().basicAuthUser.password === password, 'Original running launcher credentials remain authoritative');

        for (const kind of ['chat-completions', 'thumbnail-settings']) {
            const before = readConfig();
            const currentResponse = await api.send(`/api/server-admin/config/${kind}/get`, {});
            assert.equal(currentResponse.status, 200);
            const current = json(currentResponse);
            const response = await api.send(`/api/server-admin/config/${kind}/save`, {
                settings: current.settings, ...(current.mobileSettings ? { mobileSettings: current.mobileSettings } : {}),
                expectedLastModifiedMs: current.lastModifiedMs, restart: false,
            });
            assert.equal(response.status, 200, `Structured ${kind} save succeeds without restart`);
            const after = readConfig();
            for (const key of ['listenAddress', 'protocol', 'dataRoot', 'port', 'basicAuthUser', 'whitelist']) {
                assert.ok(JSON.stringify(after[key]) === JSON.stringify(before[key]), `Structured ${kind} save preserves ${key}`);
            }
            assert.ok(alive(active), 'Structured save leaves the real process running');
        }

        await stop();
        await start('safe');
        assert.equal(readConfig().listenAddress.ipv4, '0.0.0.0', 'Safe reopening also retains the explicitly saved wildcard');
        const loopback = readConfig();
        loopback.listenAddress.ipv4 = '127.0.0.1';
        await saveAndRestart(loopback);
        await start();
        assert.equal(readConfig().listenAddress.ipv4, '127.0.0.1', 'Endpoint save restores loopback-only listening');
        await assert.rejects(request(external, port, '/csrf-token'), { code: 'ECONNREFUSED' }, 'Actual external address stops accepting connections');
        assert.equal((await api.send(protectedRoute, {})).status, 200, 'Native loopback still authenticates after restoring phone-only listening');
        assert.equal((await request('127.0.0.1', port, protectedRoute, { method: 'POST', body: {} })).status, 401, 'Loopback still requires authentication');
        t.diagnostic(`Restored 127.0.0.1:${port}; non-loopback ${external}:${port} refused connections and authenticated loopback remained available. ${records.length} separate boot identities verified.`);
    } catch (error) {
        // Config assertions use booleans so node:test cannot print credentials as actual/expected values.
        t.diagnostic(`Private fixture output (redacted):\n${redact(output)}`);
        throw new Error(redact(error.message));
    } finally {
        await stop();
        for (const record of records) {
            if (alive(record)) {
                record.child.kill('SIGKILL');
                await record.exited;
            }
        }
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
