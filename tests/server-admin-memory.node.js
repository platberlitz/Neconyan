/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import express from 'express';

import { registerGracefulShutdown } from '../src/shutdown.js';
import { setConfigFilePath } from '../src/util.js';

let tempDir;
let configPath;
let server;
let baseUrl;
let previousCommandLineArgs;
let isHeapSupervisorManaged;
let isExternalHeapOverrideActive;

async function postJson(endpoint, body = {}, { admin = true } = {}) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(admin ? { 'X-Test-Admin': 'true' } : {}),
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let data = text;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }
    return { status: response.status, data };
}

before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-server-admin-memory-'));
    configPath = path.join(tempDir, 'config.yaml');
    fs.writeFileSync(configPath, [
        '# top-level comment',
        'port: 4433',
        'performance:',
        '  # preserve comment',
        '  useDiskCache: true',
        '  maxOldSpaceSizeMb: null',
        '',
    ].join('\n'));

    previousCommandLineArgs = globalThis.COMMAND_LINE_ARGS;
    globalThis.COMMAND_LINE_ARGS = { ...(previousCommandLineArgs ?? {}), configPath };
    setConfigFilePath(configPath);

    const serverAdmin = await import('../src/endpoints/server-admin.js');
    isHeapSupervisorManaged = serverAdmin.isHeapSupervisorManaged;
    isExternalHeapOverrideActive = serverAdmin.isExternalHeapOverrideActive;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { admin: req.headers['x-test-admin'] === 'true' } };
        next();
    });
    app.use('/api/server-admin', serverAdmin.router);

    await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/server-admin`;
});

after(async () => {
    registerGracefulShutdown(null);
    if (previousCommandLineArgs === undefined) {
        delete globalThis.COMMAND_LINE_ARGS;
    } else {
        globalThis.COMMAND_LINE_ARGS = previousCommandLineArgs;
    }
    if (server) {
        await new Promise(resolve => server.close(resolve));
    }
    if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('non-admin requests receive 403 on memory get and save', async () => {
    const getRes = await postJson('/config/memory/get', {}, { admin: false });
    assert.equal(getRes.status, 403);

    const saveRes = await postJson('/config/memory/save', { maxOldSpaceSizeMb: 4096 }, { admin: false });
    assert.equal(saveRes.status, 403);
});

test('admin memory get returns state, presets, and supervision metadata', async () => {
    const { status, data } = await postJson('/config/memory/get');
    assert.equal(status, 200);
    assert.equal(data.path, configPath);
    assert.equal(data.supported, true);
    assert.equal(data.configuredMb, null);
    assert.equal(typeof data.heapLimitMb, 'number');
    assert.ok(data.heapLimitMb > 0);
    assert.equal(typeof data.totalMemoryMb, 'number');
    assert.ok(data.totalMemoryMb > 0);
    assert.ok(Array.isArray(data.presetsMb));
    assert.deepEqual(data.presetsMb.slice(0, 4), [1536, 2048, 3072, 4096]);
    assert.equal(typeof data.supervised, 'boolean');
    assert.equal(typeof data.externalOverride, 'boolean');
    assert.equal(data.canRestart, true);
    assert.equal(typeof data.lastModifiedMs, 'number');
    assert.ok(data.lastModifiedMs > 0);
});

test('supervision and external override helpers distinguish supervisor-applied flags from user overrides', () => {
    const send = () => {};
    assert.equal(isHeapSupervisorManaged({
        env: { NECONYAN_SUPERVISED: '1', NECONYAN_EXTERNAL_HEAP_OVERRIDE: '0' },
        send,
    }), true);
    assert.equal(isHeapSupervisorManaged({
        env: { NECONYAN_SUPERVISED: '1' },
        send,
    }), false);
    assert.equal(isHeapSupervisorManaged({
        env: { NECONYAN_SUPERVISED: '1', NECONYAN_EXTERNAL_HEAP_OVERRIDE: '0' },
        send: undefined,
    }), false);

    assert.equal(isExternalHeapOverrideActive({
        env: { NECONYAN_SUPERVISED: '1', NECONYAN_EXTERNAL_HEAP_OVERRIDE: '0' },
        execArgv: ['--max-old-space-size=4096'],
        send,
    }), false);
    assert.equal(isExternalHeapOverrideActive({
        env: { NECONYAN_SUPERVISED: '1', NECONYAN_EXTERNAL_HEAP_OVERRIDE: '1' },
        execArgv: [],
        send,
    }), true);
    assert.equal(isExternalHeapOverrideActive({
        env: { NECONYAN_SUPERVISED: '1', NECONYAN_SERVER_PLUGIN_UPDATE_API: '1', NODE_OPTIONS: '--max-old-space-size=3072' },
        execArgv: ['--max-old-space-size=4096'],
        send,
    }), true);
    assert.equal(isExternalHeapOverrideActive({
        env: { NECONYAN_SUPERVISED: '1', NECONYAN_SERVER_PLUGIN_UPDATE_API: '1' },
        execArgv: ['--max-old-space-size=4096'],
        send,
    }), false);
    assert.equal(isExternalHeapOverrideActive({
        env: {},
        execArgv: ['--max-old-space-size=4096'],
        send: undefined,
    }), true);
});

test('admin memory save persists caps, preserves comments, handles missing/empty performance keys, and enforces validation & mtime', async () => {
    const initial = await postJson('/config/memory/get');
    assert.equal(initial.status, 200);

    const saved4096 = await postJson('/config/memory/save', {
        maxOldSpaceSizeMb: 4096,
        expectedLastModifiedMs: initial.data.lastModifiedMs,
        restart: false,
    });
    assert.equal(saved4096.status, 200);
    assert.equal(saved4096.data.ok, true);
    assert.equal(saved4096.data.restarting, false);
    assert.equal(saved4096.data.configuredMb, 4096);
    assert.equal(saved4096.data.maxOldSpaceSizeMb, 4096);

    const yamlText = fs.readFileSync(configPath, 'utf8');
    assert.match(yamlText, /# top-level comment/);
    assert.match(yamlText, /# preserve comment/);
    assert.match(yamlText, /maxOldSpaceSizeMb: 4096/);

    const stale = await postJson('/config/memory/save', {
        maxOldSpaceSizeMb: 2048,
        expectedLastModifiedMs: initial.data.lastModifiedMs - 1000,
    });
    assert.equal(stale.status, 409);

    for (const badValue of [0, 100, 'abc', 999999, 2048.5, true]) {
        const invalid = await postJson('/config/memory/save', {
            maxOldSpaceSizeMb: badValue,
            expectedLastModifiedMs: saved4096.data.lastModifiedMs,
        });
        assert.equal(invalid.status, 400, `expected 400 for ${JSON.stringify(badValue)}`);
    }

    const savedAuto = await postJson('/config/memory/save', {
        maxOldSpaceSizeMb: null,
        expectedLastModifiedMs: saved4096.data.lastModifiedMs,
    });
    assert.equal(savedAuto.status, 200);
    assert.equal(savedAuto.data.configuredMb, null);
    assert.match(fs.readFileSync(configPath, 'utf8'), /maxOldSpaceSizeMb: null/);

    // Missing performance key
    fs.writeFileSync(configPath, '# missing perf\nport: 4433\n');
    const missingPerfGet = await postJson('/config/memory/get');
    const missingPerfSave = await postJson('/config/memory/save', {
        maxOldSpaceSizeMb: 3072,
        expectedLastModifiedMs: missingPerfGet.data.lastModifiedMs,
    });
    assert.equal(missingPerfSave.status, 200);
    assert.equal(missingPerfSave.data.configuredMb, 3072);
    assert.match(fs.readFileSync(configPath, 'utf8'), /# missing perf/);

    // Empty performance key (scalar null)
    fs.writeFileSync(configPath, 'port: 4433\nperformance:\n');
    const emptyPerfGet = await postJson('/config/memory/get');
    const emptyPerfSave = await postJson('/config/memory/save', {
        maxOldSpaceSizeMb: 2048,
        expectedLastModifiedMs: emptyPerfGet.data.lastModifiedMs,
    });
    assert.equal(emptyPerfSave.status, 200);
    assert.equal(emptyPerfSave.data.configuredMb, 2048);
    assert.match(fs.readFileSync(configPath, 'utf8'), /maxOldSpaceSizeMb: 2048/);
});

test('native Android and iOS app flags mark server memory unsupported and reject saves with 400', async () => {
    const prevAndroid = process.env.NECONYAN_ANDROID_APP;
    const prevIos = process.env.NECONYAN_IOS_APP;
    try {
        for (const [key, expectedHost] of [['NECONYAN_ANDROID_APP', 'android'], ['NECONYAN_IOS_APP', 'ios']]) {
            delete process.env.NECONYAN_ANDROID_APP;
            delete process.env.NECONYAN_IOS_APP;
            process.env[key] = '1';

            const getRes = await postJson('/config/memory/get');
            assert.equal(getRes.status, 200);
            assert.equal(getRes.data.supported, false);
            assert.equal(getRes.data.host, expectedHost);
            assert.equal(getRes.data.heapLimitMb, null);

            const saveRes = await postJson('/config/memory/save', {
                maxOldSpaceSizeMb: 4096,
                expectedLastModifiedMs: getRes.data.lastModifiedMs,
            });
            assert.equal(saveRes.status, 400);
        }
    } finally {
        if (prevAndroid === undefined) delete process.env.NECONYAN_ANDROID_APP;
        else process.env.NECONYAN_ANDROID_APP = prevAndroid;
        if (prevIos === undefined) delete process.env.NECONYAN_IOS_APP;
        else process.env.NECONYAN_IOS_APP = prevIos;
    }
});

// Must run last because src/shutdown.js tracks isShutdownRequested at module scope.
test('admin memory save with restart: true returns 202 and schedules graceful exit 75', async () => {
    const exitCodes = [];
    let resolveExit;
    const exitPromise = new Promise(resolve => {
        resolveExit = resolve;
    });
    registerGracefulShutdown(code => {
        exitCodes.push(code);
        resolveExit(code);
    });

    const current = await postJson('/config/memory/get');
    const restartRes = await postJson('/config/memory/save', {
        maxOldSpaceSizeMb: 4096,
        expectedLastModifiedMs: current.data.lastModifiedMs,
        restart: true,
    });
    assert.equal(restartRes.status, 202);
    assert.equal(restartRes.data.ok, true);
    assert.equal(restartRes.data.restarting, true);
    assert.equal(typeof restartRes.data.serverBootId, 'string');
    assert.ok(restartRes.data.serverBootId.length > 0);
    assert.equal(restartRes.data.configuredMb, 4096);

    const exitCode = await exitPromise;
    assert.equal(exitCode, 75);
    assert.deepEqual(exitCodes, [75]);
});
