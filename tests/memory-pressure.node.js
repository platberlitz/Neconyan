/* eslint playwright/expect-expect: off -- Node assertions cover server cache reclamation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { createMemoryPressureCheck, createMemorySampleReporter, isMemoryPressure, readMemorySample } from '../src/memory-pressure.js';
import { decisionCache } from '../src/decision-cache.js';
import { isConstrainedMobileRuntime } from '../src/runtime.js';
import { SERVER_MEMORY_SAMPLE_MESSAGE } from '../src/server-plugin-update-ipc.js';
import { parseMemorySample } from '../src/server-crash-evidence.js';
import { readParsedSettingsFile } from '../src/settings-file-cache.js';

test('either available RAM or heap pressure triggers cleanup, missing counters do not', () => {
    assert.equal(isMemoryPressure({}), false);
    assert.equal(isMemoryPressure({ available: -1, total: 1e9, heapUsed: 10, heapLimit: 0 }), false);
    assert.equal(isMemoryPressure({ available: 32e6, total: 2e9 }), true);
    assert.equal(isMemoryPressure({ available: 2e9, total: 4e9, heapUsed: 800, heapLimit: 1000 }), true);
    assert.equal(isMemoryPressure({ available: 2e9, total: 4e9, heapUsed: 700, heapLimit: 1000 }), false);
    assert.equal(isMemoryPressure({ available: 4e9, total: 8e9, heapUsed: 400e6, heapLimit: 2048e6, rss: 1800e6 }), true);
    assert.equal(isMemoryPressure({ available: 4e9, total: 8e9, heapUsed: 400e6, heapLimit: 2048e6, rss: 1400e6 }), false);
});

test('constrained mobile runtimes trigger memory pressure earlier on heap and RSS', () => {
    const MiB = 1024 * 1024;
    assert.equal(isMemoryPressure({ available: 4096 * MiB, total: 12288 * MiB, heapUsed: 400 * MiB, heapLimit: 2048 * MiB, rss: 800 * MiB, constrained: true }), true);
    assert.equal(isMemoryPressure({ available: 4096 * MiB, total: 12288 * MiB, heapUsed: 400 * MiB, heapLimit: 2048 * MiB, rss: 600 * MiB, constrained: true }), false);
    assert.equal(isMemoryPressure({ available: 4096 * MiB, total: 12288 * MiB, heapUsed: 700 * MiB, heapLimit: 1024 * MiB, rss: 500 * MiB, constrained: true }), true);
    assert.equal(isConstrainedMobileRuntime({ platform: 'linux', env: {} }), false);
    assert.equal(isConstrainedMobileRuntime({ platform: 'android', env: {} }), true);
    assert.equal(isConstrainedMobileRuntime({ platform: 'linux', env: { TERMUX_VERSION: '0.118.1' } }), true);
    assert.equal(isConstrainedMobileRuntime({ platform: 'linux', env: { PREFIX: '/data/data/com.termux/files/usr' } }), true);
    assert.equal(isConstrainedMobileRuntime({ platform: 'linux', env: { HOME: '/data/data/com.termux/files/home' } }), true);
    assert.equal(isConstrainedMobileRuntime({ platform: 'linux', env: { NECONYAN_ANDROID_APP: '1' } }), true);
    assert.equal(isConstrainedMobileRuntime({ platform: 'darwin', env: { NECONYAN_IOS_APP: '1' } }), true);
});

test('decision cache clears when memory pressure triggers registered reclaimers', () => {
    decisionCache.clear();
    decisionCache.set('k1', { value: 'cached' });
    assert.deepEqual(decisionCache.get('k1'), { value: 'cached' });
    const check = createMemoryPressureCheck({ sample: () => ({ heapUsed: 900, heapLimit: 1000 }) });
    assert.equal(check(), true);
    assert.equal(decisionCache.get('k1'), undefined);
});

test('cooldown avoids repeatedly rebuilding caches under sustained pressure', () => {
    let time = 0; let calls = 0;
    const check = createMemoryPressureCheck({ sample: () => ({ heapUsed: 900, heapLimit: 1000 }), now: () => time, clients: new Set([() => calls++]) });
    assert.equal(check(), true); assert.equal(check(), false);
    time = 30_000;
    assert.equal(check(), true); assert.equal(calls, 2);
    assert.equal(createMemoryPressureCheck({ sample: () => { throw Error('unavailable'); } })(), false);
});

test('pressure releases parsed settings without mutating live readers or files, then reloads normally', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neco-memory-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'settings.json');
    const text = '{"draft":"keep me","extension_settings":{"agents":{"enabled":true}}}';
    fs.writeFileSync(file, text);
    const before = readParsedSettingsFile(file, 'memory-test');
    assert.strictEqual(readParsedSettingsFile(file, 'memory-test'), before);
    assert.equal(createMemoryPressureCheck({ sample: () => ({ heapUsed: 900, heapLimit: 1000 }) })(), true);
    const after = readParsedSettingsFile(file, 'memory-test');
    assert.notStrictEqual(after, before);
    assert.deepEqual(after, before);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.strictEqual(readParsedSettingsFile(file, 'memory-test'), after);
});

test('a memory reading is plain numbers in bytes that the supervisor accepts', () => {
    const sample = readMemorySample();
    assert.deepEqual(Object.keys(sample).sort(), ['arrayBuffers', 'at', 'deviceAvailable', 'deviceTotal', 'external', 'heapLimit', 'heapTotal', 'heapUsed', 'rss', 'uptimeSeconds']);
    assert.equal(Number.isFinite(Date.parse(sample.at)), true);
    assert.ok(sample.heapLimit > sample.heapUsed && sample.rss > 0 && sample.deviceTotal > 0);
    assert.deepEqual(Object.keys(parseMemorySample(JSON.parse(JSON.stringify(sample)))).sort(), Object.keys(sample).sort());
});

test('the reporter sends one reading per call, and nothing without a connected channel', () => {
    const sent = [];
    const reading = { at: new Date().toISOString() };
    const processObject = { send: (message, callback) => { sent.push(message); callback(); }, connected: true };
    const report = createMemorySampleReporter({ processObject, read: () => reading });
    report(); report();
    assert.deepEqual(sent, [{ type: SERVER_MEMORY_SAMPLE_MESSAGE, sample: reading }, { type: SERVER_MEMORY_SAMPLE_MESSAGE, sample: reading }]);

    for (const missing of [{}, { send: () => assert.fail('sent'), connected: false }, { send: 'not a function' }]) {
        assert.doesNotThrow(() => createMemorySampleReporter({ processObject: missing, read: () => reading })());
    }
});

test('the reporter swallows a failing channel and a counter that cannot be read', () => {
    const reading = { at: new Date().toISOString() };
    assert.doesNotThrow(() => createMemorySampleReporter({ processObject: { send() { throw new Error('channel closed'); } }, read: () => reading })());
    assert.doesNotThrow(() => createMemorySampleReporter({ processObject: { send: (_message, callback) => callback(new Error('EPIPE')) }, read: () => reading })());
    let sent = 0;
    assert.doesNotThrow(() => createMemorySampleReporter({ processObject: { send: () => { sent++; } }, read: () => { throw new Error('no counters'); } })());
    assert.equal(sent, 0);
});

test('a supervised process reports its first reading as the monitor starts and does not stay alive for it', { timeout: 30_000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neco-memory-fork-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, 'monitor.mjs');
    fs.writeFileSync(script, `import { startMemoryPressureMonitor } from ${JSON.stringify(new URL('../src/memory-pressure.js', import.meta.url).href)}; startMemoryPressureMonitor();`);
    const child = fork(script, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    t.after(() => child.kill('SIGKILL'));
    const messages = [];
    child.on('message', message => messages.push(message));
    // A message can still arrive after 'exit', so wait for the channel to close as well.
    const [[code, signal]] = await Promise.all([once(child, 'exit'), once(child, 'disconnect')]);
    assert.deepEqual([code, signal], [0, null]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, SERVER_MEMORY_SAMPLE_MESSAGE);
    assert.notEqual(parseMemorySample(messages[0].sample), null);
});
