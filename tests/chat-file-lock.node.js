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
import { acquireDataRootOwner, DATA_ROOT_OWNER_DIRECTORY, isPathUnderOwnedDataRoot } from '../src/data-root-owner.js';
import { acquireChatFileLock, acquireChatFileLocks, acquireLocalFileLock, getChatFileLockPath, withChatFileLocks } from '../src/chat-file-lock.js';

const require = createRequire(new URL('../src/chat-file-lock.js', import.meta.url));
const graceful = require('graceful-fs');
const lockfileCore = require('proper-lockfile/lib/lockfile.js');

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

for (const window of ['after-mkdir', 'before-rmdir']) {
    test(`an owned data root immediately reclaims a child lock killed in the ${window} window`, async t => {
        const [filename] = fixture(t);
        const root = path.dirname(filename);
        const lockPath = getChatFileLockPath(filename);
        const module = new URL('../src/chat-file-lock.js', import.meta.url).href;
        const ownerModule = new URL('../src/data-root-owner.js', import.meta.url).href;
        const child = spawn(process.execPath, ['--input-type=module', '-e', `
            import { createRequire } from 'node:module';
            import { acquireDataRootOwner } from ${JSON.stringify(ownerModule)};
            import { acquireChatFileLock } from ${JSON.stringify(module)};
            acquireDataRootOwner(${JSON.stringify(root)}, 'server');
            const graceful = createRequire(${JSON.stringify(module)})('graceful-fs');
            if (${JSON.stringify(window)} === 'after-mkdir') {
                const mkdir = graceful.mkdirSync;
                graceful.mkdirSync = function (target, ...args) {
                    const result = mkdir.call(this, target, ...args);
                    if (target === ${JSON.stringify(lockPath)}) {
                        process.stdout.write('window');
                        for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
                    }
                    return result;
                };
                acquireChatFileLock(${JSON.stringify(filename)});
            } else {
                const release = acquireChatFileLock(${JSON.stringify(filename)});
                graceful.rmdirSync = function (target) {
                    if (target === ${JSON.stringify(lockPath)}) {
                        process.stdout.write('window');
                        for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
                    }
                };
                release();
            }
        `], { stdio: ['ignore', 'pipe', 'pipe'] });
        t.after(() => child.kill('SIGKILL'));
        await once(child.stdout, 'data');
        assert.ok(fs.existsSync(lockPath));
        assert.equal(fs.existsSync(lockPath + '.owner'), false, 'Window leaves an ownerless lock directory');
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;

        const owner = acquireDataRootOwner(root, 'server');
        t.after(() => { try { owner.release(); } catch { /* Best effort. */ } });
        const started = Date.now();
        acquireChatFileLock(filename)();
        assert.ok(Date.now() - started < 1000, `Owned root must reclaim ${window} orphan lock immediately`);
        assert.equal(fs.existsSync(lockPath), false);
        assert.equal(fs.existsSync(lockPath + '.owner'), false);
    });
}

test('data-root lease reclamation requires live verified ownership, realpath containment, and never steals self-held locks', async t => {
    const [filename] = fixture(t);
    const root = path.dirname(filename);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-lock-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

    // Without a held root lease, an ownerless lock directory is NOT reclaimed early.
    const orphanChatLock = getChatFileLockPath(filename);
    fs.mkdirSync(orphanChatLock);
    assert.equal(isPathUnderOwnedDataRoot(orphanChatLock), false);
    assert.throws(() => acquireLocalFileLock(filename, { lockfilePath: orphanChatLock, realpath: false, stale: 300_000, update: 100_000 }), { code: 'ELOCKED' });

    // Acquiring the data-root lease enables immediate reclamation of the orphan lock inside the root.
    const owner = acquireDataRootOwner(root, 'server');
    assert.equal(isPathUnderOwnedDataRoot(orphanChatLock), true);
    const releaseChat = acquireChatFileLock(filename);

    // A lock held by another live local process (with a valid .owner sidecar) is NEVER stolen even under an owned data root.
    const liveExternalFile = path.join(root, 'external-live');
    const liveExternalLock = getChatFileLockPath(liveExternalFile);
    const module = new URL('../src/chat-file-lock.js', import.meta.url).href;
    const externalChild = spawn(process.execPath, ['--input-type=module', '-e', `
        import { acquireChatFileLock } from ${JSON.stringify(module)};
        const release = acquireChatFileLock(${JSON.stringify(liveExternalFile)});
        process.stdout.write('locked');
        process.stdin.once('data', () => { release(); process.exit(0); });
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => externalChild.kill('SIGKILL'));
    await once(externalChild.stdout, 'data');
    assert.throws(() => acquireLocalFileLock(liveExternalFile, { lockfilePath: liveExternalLock, realpath: false, stale: 300_000, update: 100_000 }), { code: 'ELOCKED' });
    const externalExited = once(externalChild, 'exit');
    externalChild.stdin.write('release');
    await externalExited;

    // The probe during acquisition must record a real non-zero mtime on the held lock entry.
    const activeLocksMap = lockfileCore.getLocks();
    assert.ok(activeLocksMap[path.resolve(filename)]?.mtime?.getTime() > 0, 'Acquired lock under owned data root must record non-zero mtime');

    // Self-held locks (direct, nested, or through a symlinked directory alias) are never reclaimed by nested callers.
    assert.throws(() => acquireChatFileLock(filename), { code: 'ELOCKED' });
    assert.throws(() => acquireLocalFileLock(filename, { lockfilePath: orphanChatLock, realpath: false, stale: 300_000, update: 100_000 }), { code: 'ELOCKED' });
    const aliasDir = path.join(root, 'self-alias');
    fs.symlinkSync(root, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => acquireLocalFileLock(path.join(aliasDir, path.basename(filename)), {
        lockfilePath: path.join(aliasDir, path.basename(orphanChatLock)),
        realpath: false,
        stale: 300_000,
        update: 100_000,
    }), { code: 'ELOCKED' });

    // Heartbeat updates under an owned data root must succeed past 1s without throwing ECOMPROMISED.
    const localMeta = path.join(root, 'entity-meta');
    const localMetaLock = `${localMeta}.lock`;
    let compromisedError = null;
    const releaseMeta = acquireLocalFileLock(localMeta, {
        lockfilePath: localMetaLock,
        realpath: false,
        stale: 2000,
        update: 1000,
        onCompromised: error => { compromisedError = error; },
    });
    assert.ok(lockfileCore.getLocks()[path.resolve(localMeta)]?.mtime?.getTime() > 0);
    assert.throws(() => acquireLocalFileLock(localMeta, { lockfilePath: localMetaLock, realpath: false, stale: 2000, update: 1000 }), { code: 'ELOCKED' });
    await new Promise(resolve => setTimeout(resolve, 1250));
    assert.equal(compromisedError, null, 'Heartbeat update must not see mtime 0 or mark the lock compromised');
    assert.ok(lockfileCore.getLocks()[path.resolve(localMeta)]?.mtime?.getTime() > 0);
    releaseMeta();
    releaseChat();

    // A nested child data root with its own .neconyan-root-owner directory is excluded from parent-root reclamation.
    const childRoot = path.join(root, 'nested-data-root');
    fs.mkdirSync(path.join(childRoot, DATA_ROOT_OWNER_DIRECTORY), { recursive: true });
    const childFile = path.join(childRoot, 'chat.jsonl');
    const childLock = getChatFileLockPath(childFile);
    fs.mkdirSync(childLock);
    assert.equal(isPathUnderOwnedDataRoot(childLock), false, 'Nested data-root boundary must not be reclaimed by parent root lease');
    assert.throws(() => acquireLocalFileLock(childFile, { lockfilePath: childLock, realpath: false, stale: 300_000, update: 100_000 }), { code: 'ELOCKED' });
    fs.rmdirSync(childLock);

    // A lock outside the owned root or escaping via a symlink inside the owned root is never treated as under the owned root.
    const outsideFile = path.join(outside, 'foreign');
    const outsideLock = getChatFileLockPath(outsideFile);
    fs.mkdirSync(outsideLock);
    assert.equal(isPathUnderOwnedDataRoot(outsideLock), false);
    assert.throws(() => acquireLocalFileLock(outsideFile, { lockfilePath: outsideLock, realpath: false, stale: 300_000, update: 100_000 }), { code: 'ELOCKED' });

    const escapeDir = path.join(root, 'escape-link');
    fs.symlinkSync(outside, escapeDir, process.platform === 'win32' ? 'junction' : 'dir');
    const escapedLock = path.join(escapeDir, path.basename(outsideLock));
    assert.equal(isPathUnderOwnedDataRoot(escapedLock), false);
    assert.throws(() => acquireLocalFileLock(path.join(escapeDir, 'foreign'), { lockfilePath: escapedLock, realpath: false, stale: 300_000, update: 100_000 }), { code: 'ELOCKED' });

    // Releasing the lease disables early reclamation immediately.
    owner.release();
    assert.equal(isPathUnderOwnedDataRoot(orphanChatLock), false);
    fs.mkdirSync(orphanChatLock);
    assert.throws(() => acquireLocalFileLock(filename, { lockfilePath: orphanChatLock, realpath: false, stale: 300_000, update: 100_000 }), { code: 'ELOCKED' });
    fs.rmdirSync(orphanChatLock);

    // If the on-disk owner.json is tampered with or replaced (stolen lease), the predicate returns false and refuses early reclamation.
    acquireDataRootOwner(root, 'server');
    assert.equal(isPathUnderOwnedDataRoot(orphanChatLock), true);
    const ownerJsonPath = path.join(root, DATA_ROOT_OWNER_DIRECTORY, 'owner.json');
    const parsedOwner = JSON.parse(fs.readFileSync(ownerJsonPath, 'utf8'));
    parsedOwner.nonce = 'f'.repeat(32);
    fs.writeFileSync(ownerJsonPath, JSON.stringify(parsedOwner));
    assert.equal(isPathUnderOwnedDataRoot(orphanChatLock), false);
    fs.mkdirSync(orphanChatLock);
    assert.throws(() => acquireLocalFileLock(filename, { lockfilePath: orphanChatLock, realpath: false, stale: 300_000, update: 100_000 }), { code: 'ELOCKED' });
});

for (const count of [1, 3]) {
    test(`all locks receive a release attempt when ${count} cleanup calls throw`, t => {
        const files = fixture(t);
        const root = path.dirname(files[0]);
        const owner = acquireDataRootOwner(root, 'server');
        t.after(() => { try { owner.release(); } catch { /* Best effort. */ } });
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
    const retainedFile = files.find(file => getChatFileLockPath(file) === retained);
    assert.throws(() => acquireLocalFileLock(retainedFile, { lockfilePath: retained, realpath: false, stale: 300_000, update: 100_000 }), { code: 'ELOCKED' });
    for (const file of files.filter(file => getChatFileLockPath(file) !== retained)) acquireChatFileLock(file)();
});

test('under an owned data root a failed removal propagates its error and recovers once rmdir succeeds', t => {
    const [filename] = fixture(t);
    const root = path.dirname(filename);
    const lockPath = getChatFileLockPath(filename);
    const owner = acquireDataRootOwner(root, 'server');
    t.after(() => { try { owner.release(); } catch { /* Best effort. */ } });
    const release = acquireChatFileLock(filename);
    const remove = graceful.rmdirSync;
    t.mock.method(graceful, 'rmdirSync', function (target, ...args) {
        if (target === lockPath) throw Object.assign(new Error('Release rmdir failed'), { code: 'EIO' });
        return remove.call(this, target, ...args);
    });
    assert.throws(release, { code: 'EIO' });
    assert.ok(fs.existsSync(lockPath));
    // While rmdirSync continues to fail, reclamation also fails with EIO.
    assert.throws(() => acquireChatFileLock(filename), { code: 'EIO' });
    t.mock.restoreAll();
    // Once rmdirSync works again, reconciliation under the owned data root reclaims the retained lock immediately.
    acquireChatFileLock(filename)();
    assert.equal(fs.existsSync(lockPath), false);
});

test('mkdir stat failure removes the newly created directory and probe failure cleans up tracking', t => {
    const [first, second] = fixture(t);
    const root = path.dirname(first);
    const owner = acquireDataRootOwner(root, 'server');
    t.after(() => { try { owner.release(); } catch { /* Best effort. */ } });

    const firstLock = getChatFileLockPath(first);
    const realStat = fs.statSync;
    t.mock.method(fs, 'statSync', function (target, ...args) {
        if (target === firstLock) throw Object.assign(new Error('Immediate stat failed'), { code: 'EIO' });
        return realStat.call(this, target, ...args);
    });
    assert.throws(() => acquireChatFileLock(first), { code: 'EIO' });
    t.mock.restoreAll();
    assert.equal(fs.existsSync(firstLock), false, 'Best-effort rmdir cleans up lock directory when statSync fails after mkdirSync');
    acquireChatFileLock(first)();

    const secondLock = getChatFileLockPath(second);
    const realUtimes = graceful.utimesSync;
    t.mock.method(graceful, 'utimesSync', function (target, ...args) {
        if (target === secondLock) throw Object.assign(new Error('Precision probe failed'), { code: 'EIO' });
        return realUtimes.call(this, target, ...args);
    });
    assert.throws(() => acquireLocalFileLock(second, { lockfilePath: secondLock, realpath: false, stale: 300_000, update: 100_000 }), { code: 'EIO' });
    t.mock.restoreAll();
    assert.equal(fs.existsSync(secondLock), false);
    acquireLocalFileLock(second, { lockfilePath: secondLock, realpath: false, stale: 300_000, update: 100_000 })();
});

test('async callbacks are rejected before execution and thenables release their locks', t => {
    const files = fixture(t);
    let called = false;
    assert.throws(() => withChatFileLocks(files, async () => { called = true; }), TypeError);
    assert.equal(called, false);
    assert.throws(() => withChatFileLocks(files, () => Promise.reject(new Error('Rejected result'))), TypeError);
    acquireChatFileLocks(files)();
});
