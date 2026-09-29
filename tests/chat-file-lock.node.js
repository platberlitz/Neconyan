/* global AggregateError */
/* eslint playwright/expect-expect: off -- Uses node:assert with real disposable locks. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { acquireChatFileLock, acquireChatFileLocks, acquireLocalFileLock, getChatFileLockPath, withChatFileLocks } from '../src/chat-file-lock.js';

const graceful = createRequire(new URL('../src/chat-file-lock.js', import.meta.url))('graceful-fs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-lock-drain-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return ['one', 'two', 'three'].map(name => path.join(root, name));
}

test('a killed process releases its locks immediately without stealing a live process lock', async t => {
    const [filename] = fixture(t);
    const metadata = filename + '.metadata';
    const options = { lockfilePath: metadata + '.lock', realpath: false, stale: 30000, update: 10000 };
    const module = new URL('../src/chat-file-lock.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { acquireChatFileLock, acquireLocalFileLock } from ${JSON.stringify(module)};
        acquireChatFileLock(${JSON.stringify(filename)});
        acquireLocalFileLock(${JSON.stringify(metadata)}, ${JSON.stringify(options)});
        process.stdout.write('locked');
        setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    await once(child.stdout, 'data');
    assert.throws(() => acquireChatFileLock(filename), { code: 'ELOCKED' });
    assert.throws(() => acquireLocalFileLock(metadata, options), { code: 'ELOCKED' });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const started = Date.now();
    acquireChatFileLock(filename)();
    acquireLocalFileLock(metadata, options)();
    assert.ok(Date.now() - started < 1000, 'Dead-owner recovery must not wait for the five-minute stale timeout');
    assert.equal(fs.existsSync(getChatFileLockPath(filename) + '.owner'), false);
});

for (const count of [1, 3]) {
    test(`all locks receive a release attempt when ${count} cleanup calls throw`, t => {
        const files = fixture(t);
        const release = acquireChatFileLocks([...files, files[0]]);
        const remove = graceful.rmdirSync;
        const attempted = [];
        t.mock.method(graceful, 'rmdirSync', function (filename, ...args) {
            const result = remove.call(this, filename, ...args);
            attempted.push(filename);
            if (attempted.length <= count) throw Object.assign(new Error('Cleanup failed'), { code: 'EIO' });
            return result;
        });
        assert.throws(release, error => count === 1 ? error.code === 'EIO' : error instanceof AggregateError && error.errors.length === 3);
        assert.equal(attempted.length, 3);
        release();
        assert.equal(attempted.length, 3);
        t.mock.restoreAll();
        acquireChatFileLocks(files)();
    });
}

test('a partial acquisition error survives cleanup failure and releases the other locks', t => {
    const files = fixture(t).sort((a, b) => getChatFileLockPath(a).localeCompare(getChatFileLockPath(b)));
    const releaseLast = acquireChatFileLock(files[2]);
    const remove = graceful.rmdirSync;
    const attempted = [];
    t.mock.method(console, 'warn', () => {});
    t.mock.method(graceful, 'rmdirSync', function (filename, ...args) {
        remove.call(this, filename, ...args);
        attempted.push(filename);
        throw Object.assign(new Error('Cleanup failed'), { code: 'EIO' });
    });
    assert.throws(() => acquireChatFileLocks(files), { code: 'ELOCKED' });
    assert.equal(attempted.length, 2);
    t.mock.restoreAll();
    releaseLast();
    acquireChatFileLocks(files)();
});

for (const original of [Object.freeze(Object.assign(new Error('Original write failure'), { chatWriteUncertain: true, integrity: 'saved' })), 'original value']) {
    test(`nested cleanup preserves the exact ${typeof original} body failure`, t => {
        const files = fixture(t);
        const remove = graceful.rmdirSync;
        const attempted = [];
        t.mock.method(console, 'warn', () => {});
        t.mock.method(graceful, 'rmdirSync', function (filename, ...args) {
            remove.call(this, filename, ...args);
            attempted.push(filename);
            throw new Error('Cleanup failed');
        });
        assert.throws(() => withChatFileLocks([files[0]], () => withChatFileLocks(files.slice(1), () => { throw original; })), error => error === original);
        assert.equal(attempted.length, 3);
        t.mock.restoreAll();
        acquireChatFileLocks(files)();
    });
}

test('a failed removal retains its lock directory but does not abandon releasable locks', t => {
    const files = fixture(t);
    const release = acquireChatFileLocks(files);
    const remove = graceful.rmdirSync;
    let retained;
    t.mock.method(graceful, 'rmdirSync', function (filename, ...args) {
        if (!retained) { retained = filename; throw new Error('Removal refused'); }
        return remove.call(this, filename, ...args);
    });
    assert.throws(release, /Removal refused/);
    t.mock.restoreAll();
    assert.ok(fs.existsSync(retained));
    for (const file of files.filter(file => getChatFileLockPath(file) !== retained)) acquireChatFileLock(file)();
});

test('async callbacks are rejected before execution and thenables release their locks', t => {
    const files = fixture(t);
    let called = false;
    assert.throws(() => withChatFileLocks(files, async () => { called = true; }), TypeError);
    assert.equal(called, false);
    assert.throws(() => withChatFileLocks(files, () => Promise.reject(new Error('Rejected result'))), TypeError);
    acquireChatFileLocks(files)();
});
