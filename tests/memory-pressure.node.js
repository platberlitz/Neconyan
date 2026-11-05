/* eslint playwright/expect-expect: off -- Node assertions cover server cache reclamation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createMemoryPressureCheck, isMemoryPressure } from '../src/memory-pressure.js';
import { readParsedSettingsFile } from '../src/settings-file-cache.js';

test('either available RAM or heap pressure triggers cleanup, missing counters do not', () => {
    assert.equal(isMemoryPressure({}), false);
    assert.equal(isMemoryPressure({ available: -1, total: 1e9, heapUsed: 10, heapLimit: 0 }), false);
    assert.equal(isMemoryPressure({ available: 32e6, total: 2e9 }), true);
    assert.equal(isMemoryPressure({ available: 2e9, total: 4e9, heapUsed: 800, heapLimit: 1000 }), true);
    assert.equal(isMemoryPressure({ available: 2e9, total: 4e9, heapUsed: 700, heapLimit: 1000 }), false);
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
