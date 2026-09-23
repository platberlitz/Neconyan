/* eslint playwright/expect-expect: off -- Uses node:assert against real disposable storage. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { canonical } from '../src/jobs/store.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { initialiseRoleplayAccount, readRoleplayAccount, withRoleplayAccountLock, roleplayLease, saveRoleplayAccount,
    roleplayStoreDirectory, roleplayHash, readRoleplayFile, reconcileRoleplayAccount, assertRoleplayTransactionCapacity,
    withRoleplayAccount, ROLEPLAY_STORE_MAX_BYTES } = await import('../src/roleplay-store.js');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-roleplay-store-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const input = { owner: 'fixture', directories: { root: path.join(root, 'fixture') } };
    fs.mkdirSync(input.directories.root);
    return { input, initialise: () => initialiseRoleplayAccount(input), directory: roleplayStoreDirectory(input) };
}

test('explicit bootstrap persists account identity outside resettable user data', t => {
    const f = fixture(t);
    const scope = f.initialise();
    assert.equal(readRoleplayAccount(scope).revision, 0);
    assert.deepEqual(f.initialise(), scope);
    fs.rmSync(scope.directories.root, { recursive: true });
    fs.mkdirSync(scope.directories.root);
    assert.deepEqual(f.initialise(), scope);
    assert.notEqual(path.dirname(f.directory), scope.directories.root);
});

test('missing ready ledger and changed checksum fail closed, including bootstrap', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const state = path.join(f.directory, 'state.json');
    const original = fs.readFileSync(state, 'utf8');
    fs.unlinkSync(state);
    assert.throws(() => readRoleplayAccount(scope), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.throws(f.initialise, { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.equal(fs.existsSync(state), false);
    const changed = JSON.parse(original);
    changed.state.dataEpoch += 1;
    fs.writeFileSync(state, JSON.stringify(changed));
    assert.throws(() => readRoleplayAccount(scope), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.throws(f.initialise, { code: 'ROLEPLAY_STORE_DAMAGED' });
});

test('account and epoch are required for every normal read and mutation', t => {
    const f = fixture(t);
    const scope = f.initialise();
    assert.throws(() => readRoleplayAccount(f.input), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    assert.throws(() => readRoleplayAccount({ ...scope, accountId: 'different' }), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    assert.throws(() => withRoleplayAccountLock({ ...scope, dataEpoch: 2 }, () => assert.fail()), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    withRoleplayAccountLock(scope, lease => {
        roleplayLease(lease).state.dataEpoch += 1;
        saveRoleplayAccount(lease);
    });
    assert.throws(() => readRoleplayAccount(scope), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    assert.equal(readRoleplayAccount({ ...scope, dataEpoch: 2 }).revision, 1);
});

test('current-account discovery never initialises missing protected storage', t => {
    const f = fixture(t);
    assert.throws(() => withRoleplayAccount(f.input, null, () => assert.fail()), { code: 'ROLEPLAY_ACCOUNT_UNAVAILABLE' });
    assert.equal(fs.existsSync(path.dirname(f.directory)), false);
    fs.mkdirSync(f.directory, { recursive: true });
    assert.throws(() => withRoleplayAccount(f.input, null, () => assert.fail()), { code: 'ROLEPLAY_ACCOUNT_UNAVAILABLE' });
    assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('current-account leases check the supplied stamp and never refresh stale authority', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const expected = { accountId: scope.accountId, dataEpoch: scope.dataEpoch };
    const statePath = path.join(f.directory, 'state.json');
    const before = fs.readFileSync(statePath);
    let captured;
    assert.deepEqual(withRoleplayAccount(f.input, null, (lease, current) => {
        captured = lease;
        assert.deepEqual(roleplayLease(lease).scope, scope);
        return current;
    }), expected);
    assert.throws(() => roleplayLease(captured), /active Roleplay account lock/);
    assert.deepEqual(fs.readFileSync(statePath), before);
    withRoleplayAccount(f.input, expected, lease => {
        roleplayLease(lease).state.dataEpoch++;
        saveRoleplayAccount(lease);
    });
    assert.throws(() => withRoleplayAccount(f.input, expected, () => assert.fail()), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    assert.throws(() => withRoleplayAccountLock(scope, () => assert.fail()), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    assert.deepEqual(withRoleplayAccount(f.input, null, (lease, current) => current), { ...expected, dataEpoch: 2 });
});

test('current-account discovery refuses damaged and non-ready stores without rewriting them', t => {
    const f = fixture(t);
    f.initialise();
    const statePath = path.join(f.directory, 'state.json');
    withRoleplayAccount(f.input, null, lease => {
        roleplayLease(lease).state.status = 'deleted';
        saveRoleplayAccount(lease);
    });
    const before = fs.readFileSync(statePath);
    assert.throws(() => withRoleplayAccount(f.input, null, () => assert.fail()), { code: 'ROLEPLAY_ACCOUNT_UNAVAILABLE' });
    assert.deepEqual(fs.readFileSync(statePath), before);
    fs.unlinkSync(statePath);
    assert.throws(() => withRoleplayAccount(f.input, null, () => assert.fail()), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.equal(fs.existsSync(statePath), false);
});

test('current-account leases retain synchronous and failed-publication restrictions', async t => {
    const f = fixture(t);
    f.initialise();
    assert.throws(() => withRoleplayAccount(f.input, null, async () => {}), /synchronous/);
    assert.throws(() => withRoleplayAccount(f.input, null, () => Promise.reject(new Error('not synchronous'))), /promises/);
    const statePath = path.join(f.directory, 'state.json');
    assert.throws(() => withRoleplayAccount(f.input, null, lease => {
        fs.writeFileSync(statePath, 'changed evidence');
        assert.throws(() => saveRoleplayAccount(lease), { code: 'ROLEPLAY_STORE_CHANGED' });
        assert.throws(() => roleplayLease(lease), { code: 'ROLEPLAY_STORE_CHANGED' });
    }), { code: 'ROLEPLAY_STORE_CHANGED' });
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'changed evidence');
    await new Promise(resolve => setImmediate(resolve));
});

test('opaque account lease expires after the synchronous operation and releases after failure', async t => {
    const f = fixture(t);
    const scope = f.initialise();
    let savedLease;
    withRoleplayAccountLock(scope, lease => { savedLease = lease; });
    assert.throws(() => roleplayLease(savedLease), /active Roleplay account lock/);
    assert.throws(() => saveRoleplayAccount({}), /active Roleplay account lock/);
    assert.throws(() => withRoleplayAccountLock(scope, async () => {}), /synchronous/);
    assert.throws(() => withRoleplayAccountLock(scope, () => Promise.reject(new Error('Rejected asynchronous work'))), /promises/);
    const failure = new Error('Original callback failure');
    assert.throws(() => withRoleplayAccountLock(scope, () => { throw failure; }), error => error === failure);
    withRoleplayAccountLock(scope, lease => assert.equal(roleplayLease(lease).state.revision, 0));
    await new Promise(resolve => setImmediate(resolve));
});

test('a maintenance barrier rejects normal work without changing its evidence', t => {
    const f = fixture(t);
    const scope = f.initialise();
    withRoleplayAccountLock(scope, lease => {
        roleplayLease(lease).state.status = 'maintenance';
        saveRoleplayAccount(lease);
    });
    const before = fs.readFileSync(path.join(f.directory, 'state.json'));
    assert.throws(() => readRoleplayAccount(scope), { code: 'ROLEPLAY_ACCOUNT_UNAVAILABLE' });
    assert.throws(() => withRoleplayAccountLock(scope, () => assert.fail()), { code: 'ROLEPLAY_ACCOUNT_UNAVAILABLE' });
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'state.json')), before);
});

test('canonical identity retains array order and missing versus null fields', () => {
    assert.equal(roleplayHash({ b: 2, a: 1 }), roleplayHash({ a: 1, b: 2 }));
    assert.notEqual(roleplayHash({}), roleplayHash({ a: null }));
    assert.notEqual(roleplayHash([1, 2]), roleplayHash([2, 1]));
    assert.throws(() => roleplayHash({ a: undefined }), { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => roleplayHash([NaN]), { code: 'ROLEPLAY_INVALID' });
});

test('symlinked protected storage is refused before bootstrap writes', t => {
    const f = fixture(t);
    const other = path.join(path.dirname(f.input.directories.root), 'other');
    fs.mkdirSync(other);
    fs.symlinkSync(other, path.dirname(f.directory));
    assert.throws(f.initialise, { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.deepEqual(fs.readdirSync(other), []);
});

test('initialisation resumes the same identity after a state publication interruption', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const markerPath = path.join(f.directory, 'identity.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    fs.writeFileSync(markerPath, JSON.stringify({ ...marker, phase: 'initialising' }));
    fs.unlinkSync(path.join(f.directory, 'state.json'));
    assert.deepEqual(f.initialise(), scope);
    assert.equal(readRoleplayAccount(scope).revision, 0);
});

test('initialisation preserves an existing invalid JSON value instead of treating it as absent', t => {
    const f = fixture(t);
    f.initialise();
    const markerPath = path.join(f.directory, 'identity.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    fs.writeFileSync(markerPath, JSON.stringify({ ...marker, phase: 'initialising' }));
    const statePath = path.join(f.directory, 'state.json');
    fs.writeFileSync(statePath, 'null');
    assert.throws(f.initialise, { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'null');
});

test('changed ledger evidence is not overwritten by an earlier lease', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const statePath = path.join(f.directory, 'state.json');
    const replacement = JSON.stringify({ hash: 'wrong', state: { retained: 'evidence' } });
    assert.throws(() => withRoleplayAccountLock(scope, lease => {
        fs.writeFileSync(statePath, replacement);
        assert.throws(() => saveRoleplayAccount(lease), { code: 'ROLEPLAY_STORE_CHANGED' });
        assert.throws(() => saveRoleplayAccount(lease), { code: 'ROLEPLAY_STORE_CHANGED' });
    }), { code: 'ROLEPLAY_STORE_CHANGED' });
    assert.equal(fs.readFileSync(statePath, 'utf8'), replacement);
});

test('short writes are completed before the new ledger is published', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const original = fs.writeSync;
    let shortened = 0;
    t.mock.method(fs, 'writeSync', (fd, buffer, offset, length, position) => {
        const amount = length > 1 ? Math.floor(length / 2) : length;
        if (amount !== length) shortened += 1;
        return original(fd, buffer, offset, amount, position);
    });
    withRoleplayAccountLock(scope, lease => saveRoleplayAccount(lease));
    assert.ok(shortened > 0);
    assert.equal(readRoleplayAccount(scope).revision, 1);
});

test('a substituted destination link never publishes into another account', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const otherInput = { owner: 'other', directories: { root: path.join(path.dirname(f.input.directories.root), 'other') } };
    fs.mkdirSync(otherInput.directories.root);
    const otherScope = initialiseRoleplayAccount(otherInput);
    const target = path.join(f.directory, 'state.json');
    const other = path.join(roleplayStoreDirectory(otherScope), 'state.json');
    const otherBytes = fs.readFileSync(other);
    const original = fs.openSync;
    let substituted = false;
    t.mock.method(fs, 'openSync', (filename, ...args) => {
        if (!substituted && path.dirname(String(filename)) === path.dirname(target)
            && path.basename(String(filename)).startsWith('.sillybunny-write-') && args[0] === 'wx') {
            fs.unlinkSync(target);
            fs.symlinkSync(other, target);
            substituted = true;
        }
        return original(filename, ...args);
    });
    assert.throws(() => withRoleplayAccountLock(scope, lease => saveRoleplayAccount(lease)), { roleplayWriteUncertain: true });
    assert.equal(substituted, true);
    assert.deepEqual(fs.readFileSync(other), otherBytes);
    assert.equal(readRoleplayAccount(otherScope).revision, 0);
});

test('a growing file cannot increase the allocated read buffer beyond the checked limit', t => {
    const f = fixture(t);
    const filename = path.join(f.input.directories.root, 'bounded');
    fs.writeFileSync(filename, '12345678');
    const original = fs.readSync;
    let grown = false;
    let largest = 0;
    t.mock.method(fs, 'readSync', (fd, buffer, ...args) => {
        largest = Math.max(largest, buffer.length);
        if (!grown) {
            fs.writeFileSync(filename, Buffer.alloc(4096));
            grown = true;
        }
        return original(fd, buffer, ...args);
    });
    assert.throws(() => readRoleplayFile(filename, 8), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.equal(grown, true);
    assert.equal(largest, 8);
});

for (const change of ['bytes', 'growth', 'link']) {
    test(`replacement refuses a late observed ${change} change without overwriting it`, t => {
        const f = fixture(t);
        const scope = f.initialise();
        const filename = path.join(f.directory, 'state.json');
        const before = fs.readFileSync(filename);
        const alias = filename + '.alias';
        const open = fs.openSync;
        let changed = false;
        t.mock.method(fs, 'openSync', (target, ...args) => {
            if (!changed && path.dirname(String(target)) === path.dirname(filename)
                && path.basename(String(target)).startsWith('.sillybunny-write-') && args[0] === 'wx') {
                changed = true;
                if (change === 'link') fs.linkSync(filename, alias);
                else fs.writeFileSync(filename, change === 'growth' ? Buffer.alloc(ROLEPLAY_STORE_MAX_BYTES + 1) : 'changed evidence');
            }
            return open(target, ...args);
        });
        assert.throws(() => withRoleplayAccountLock(scope, lease => saveRoleplayAccount(lease)), { roleplayWriteUncertain: true });
        assert.equal(changed, true);
        assert.deepEqual(fs.readFileSync(filename), change === 'link' ? before
            : change === 'growth' ? Buffer.alloc(ROLEPLAY_STORE_MAX_BYTES + 1) : Buffer.from('changed evidence'));
    });
}

test('all publication validation reads stay bounded', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (filename, ...args) => {
        assert.notEqual(filename, path.join(f.directory, 'state.json'));
        assert.notEqual(filename, path.join(f.directory, 'identity.json'));
        return read(filename, ...args);
    });
    withRoleplayAccountLock(scope, lease => saveRoleplayAccount(lease));
    assert.equal(readRoleplayAccount(scope).revision, 1);
});

test('the final pathname observation refuses a newly linked file', t => {
    const f = fixture(t);
    const filename = path.join(f.input.directories.root, 'source');
    fs.writeFileSync(filename, 'source');
    const stat = fs.lstatSync;
    let seen = 0;
    t.mock.method(fs, 'lstatSync', (target, ...args) => {
        if (target === filename && ++seen === 2) fs.linkSync(filename, filename + '.alias');
        return stat(target, ...args);
    });
    assert.throws(() => readRoleplayFile(filename), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.equal(seen, 2);
});

test('failed creation retains a changed ready ledger instead of deleting it by inode', t => {
    const f = fixture(t);
    const fsync = fs.fsyncSync;
    let changed = false;
    let evidence;
    const filename = path.join(f.directory, 'state.json');
    const mock = t.mock.method(fs, 'fsyncSync', fd => {
        if (!changed && fs.existsSync(filename) && fs.fstatSync(fd).ino === fs.statSync(filename).ino) {
            const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
            saved.state.revision = 7;
            saved.hash = roleplayHash(saved.state);
            evidence = JSON.stringify(saved);
            fs.writeFileSync(filename, evidence);
            fsync(fd);
            changed = true;
            throw Object.assign(new Error('Failed creation flush'), { code: 'EIO' });
        }
        return fsync(fd);
    });
    assert.throws(f.initialise, { roleplayWriteUncertain: true });
    mock.mock.restore();
    assert.equal(changed, true);
    assert.equal(fs.readFileSync(filename, 'utf8'), evidence);
    assert.throws(f.initialise, { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.equal(fs.readFileSync(filename, 'utf8'), evidence);
});

test('partial protected creation survives the error and cannot become empty bootstrap', t => {
    const f = fixture(t);
    const write = fs.writeSync;
    const mock = t.mock.method(fs, 'writeSync', (fd, buffer, offset, length, position) => {
        write(fd, buffer, offset, 1, position);
        throw Object.assign(new Error('Partial protected creation'), { code: 'EIO' });
    });
    assert.throws(f.initialise, { roleplayWriteUncertain: true });
    mock.mock.restore();
    const filename = path.join(f.directory, 'identity.json');
    assert.equal(fs.statSync(filename).size, 1);
    assert.throws(f.initialise, { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.equal(fs.statSync(filename).size, 1);
});

test('fresh reconciliation flushes the exact uncertain result without another revision', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const fsync = fs.fsyncSync;
    const mock = t.mock.method(fs, 'fsyncSync', fd => {
        if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('Failed directory flush'), { code: 'EIO' });
        return fsync(fd);
    });
    let failure;
    assert.throws(() => withRoleplayAccountLock(scope, lease => saveRoleplayAccount(lease)), error => {
        failure = error;
        return error.roleplayWriteUncertain === true;
    });
    mock.mock.restore();
    assert.equal(readRoleplayAccount(scope).revision, 1);
    assert.equal(reconcileRoleplayAccount(scope, failure.intendedHash).revision, 1);
    assert.equal(readRoleplayAccount(scope).revision, 1);
    assert.throws(() => reconcileRoleplayAccount(scope, '0'.repeat(64)), { code: 'ROLEPLAY_PUBLICATION_DIFFERENT' });
});

test('successive saves preserve the live state reference within one lease', t => {
    const f = fixture(t);
    const scope = f.initialise();
    withRoleplayAccountLock(scope, lease => {
        const { state } = roleplayLease(lease);
        state.status = 'maintenance';
        saveRoleplayAccount(lease);
        assert.equal(roleplayLease(lease).state, state);
        state.status = 'ready';
        saveRoleplayAccount(lease);
    });
    assert.equal(readRoleplayAccount(scope).revision, 2);
    assert.equal(readRoleplayAccount(scope).status, 'ready');
});

test('retrying a ready bootstrap still confirms its durability', t => {
    const f = fixture(t);
    const fsync = fs.fsyncSync;
    const marker = path.join(f.directory, 'identity.json');
    let failures = 0;
    const mock = t.mock.method(fs, 'fsyncSync', fd => {
        if (fs.fstatSync(fd).isDirectory() && fs.existsSync(marker)
            && JSON.parse(fs.readFileSync(marker, 'utf8')).phase === 'ready') {
            failures += 1;
            throw Object.assign(new Error('Ready marker flush failed'), { code: 'EIO' });
        }
        return fsync(fd);
    });
    assert.throws(f.initialise, { roleplayWriteUncertain: true });
    assert.throws(f.initialise, { code: 'EIO' });
    assert.equal(failures, 2);
    mock.mock.restore();
    assert.equal(readRoleplayAccount(f.initialise()).revision, 0);
});

test('exact maintenance publication can be confirmed without lifting its barrier', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const fsync = fs.fsyncSync;
    const mock = t.mock.method(fs, 'fsyncSync', fd => {
        if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('Maintenance flush failed'), { code: 'EIO' });
        return fsync(fd);
    });
    let failure;
    assert.throws(() => withRoleplayAccountLock(scope, lease => {
        roleplayLease(lease).state.status = 'maintenance';
        saveRoleplayAccount(lease);
    }), error => { failure = error; return error.roleplayWriteUncertain === true; });
    mock.mock.restore();
    assert.equal(reconcileRoleplayAccount(scope, failure.intendedHash).status, 'maintenance');
    assert.throws(() => readRoleplayAccount(scope), { code: 'ROLEPLAY_ACCOUNT_UNAVAILABLE' });
    assert.throws(() => reconcileRoleplayAccount({ ...scope, dataEpoch: 2 }, failure.intendedHash), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
});

test('separate processes serialise ledger publications through the account lock', { timeout: 15000 }, async t => {
    const f = fixture(t);
    const scope = f.initialise();
    const release = path.join(f.input.directories.root, 'release');
    const moduleUrl = new URL('../src/roleplay-store.js', import.meta.url).href;
    const utilUrl = new URL('../src/util.js', import.meta.url).href;
    const config = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
    const child = first => {
        const code = `import fs from 'node:fs'; import {createRequire} from 'node:module';
            import {setConfigFilePath} from ${JSON.stringify(utilUrl)}; setConfigFilePath(${JSON.stringify(config)});
            const {withRoleplayAccountLock,saveRoleplayAccount}=await import(${JSON.stringify(moduleUrl)});
            const locking=createRequire(${JSON.stringify(new URL('../src/chat-file-lock.js', import.meta.url).href)})('proper-lockfile');
            const lock=locking.lockSync; locking.lockSync=(...args)=>{try{return lock(...args);}catch(e){if(e.code==='ELOCKED')process.stdout.write('contended\\n');throw e;}};
            withRoleplayAccountLock(${JSON.stringify(scope)},lease=>{
                if(${first}) {process.stdout.write('held\\n');while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
                saveRoleplayAccount(lease);
            });`;
        const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
        t.after(() => process.kill());
        let output = '';
        const waiters = [];
        process.stdout.on('data', data => { output += data; for (const waiter of waiters) if (output.includes(waiter.text)) waiter.resolve(); });
        let errors = '';
        process.stderr.on('data', data => { errors += data; });
        const done = new Promise((resolve, reject) => {
            process.on('error', reject);
            process.on('exit', code => {
                if (code === 0) resolve();
                else reject(new Error(`Ledger child failed: ${code}: ${errors}`));
            });
        });
        return { done, wait: text => output.includes(text) ? Promise.resolve() : new Promise(resolve => waiters.push({ text, resolve })) };
    };
    const first = child(true);
    await first.wait('held');
    const second = child(false);
    await second.wait('contended');
    fs.writeFileSync(release, 'release');
    await Promise.all([first.done, second.done]);
    assert.equal(readRoleplayAccount(scope).revision, 2);
});

function storedResource(scope, kind = 'chat', locator = { group: false, chat: 'Source', avatar: 'Nova.png' }) {
    return { accountId: scope.accountId, dataEpoch: scope.dataEpoch, kind, locator, status: 'live', revision: 1,
        head: { rawHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), writeId: null,
            physical: { dev: '1', ino: '2', birthtimeNs: '3' } }, busySubmission: null };
}

function storedResult(instanceId) {
    return { instanceId, revision: 1, rawHash: 'a'.repeat(64), integrity: '', writeId: crypto.randomUUID(), changed: false, mode: 'update' };
}

function storedReceipt(scope, instanceId, key) {
    const result = storedResult(instanceId);
    return { accountId: scope.accountId, dataEpoch: scope.dataEpoch, intentHash: 'f'.repeat(64), jobId: null,
        targetInstanceId: instanceId, state: 'closed', reservedReceiptBytes: 0, outcome: result,
        effects: { [key]: { effectHash: 'f'.repeat(64), writeId: result.writeId, instanceId, appliedRevision: 1, result: { ...result } } } };
}

test('malformed persisted resources and receipts fail closed on load and before a save writes', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const statePath = path.join(f.directory, 'state.json');
    const baseline = fs.readFileSync(statePath);
    const resourceId = crypto.randomUUID();
    const receiptKey = 'c'.repeat(64);
    const cases = [
        ['chat locator traversal', state => { state.resources[resourceId] = storedResource(scope); state.resources[resourceId].locator.chat = '../Other'; }],
        ['chat locator extra key', state => { state.resources[resourceId] = storedResource(scope); state.resources[resourceId].locator.owner = 'someone'; }],
        ['solo locator without avatar', state => { state.resources[resourceId] = storedResource(scope); delete state.resources[resourceId].locator.avatar; }],
        ['character locator with extra key', state => {
            state.resources[resourceId] = storedResource(scope, 'character', { avatar: 'Nova.png' });
            state.resources[resourceId].locator.chat = 'Source';
        }],
        ['group locator traversal', state => { state.resources[resourceId] = storedResource(scope, 'group', { groupId: '../Other' }); }],
        ['resource physical missing field', state => { state.resources[resourceId] = storedResource(scope); delete state.resources[resourceId].head.physical.ino; }],
        ['resource physical non-numeric', state => { state.resources[resourceId] = storedResource(scope); state.resources[resourceId].head.physical.birthtimeNs = 'later'; }],
        ['closed receipt without outcome', state => {
            state.resources[resourceId] = storedResource(scope);
            state.submissions[receiptKey] = storedReceipt(scope, resourceId, receiptKey);
            delete state.submissions[receiptKey].outcome;
        }],
        ['closed receipt malformed outcome', state => {
            state.resources[resourceId] = storedResource(scope);
            state.submissions[receiptKey] = storedReceipt(scope, resourceId, receiptKey);
            state.submissions[receiptKey].outcome.writeId = 'not-a-uuid';
        }],
        ['closed receipt oversized outcome', state => {
            state.resources[resourceId] = storedResource(scope);
            state.submissions[receiptKey] = storedReceipt(scope, resourceId, receiptKey);
            state.submissions[receiptKey].outcome.padding = 'x'.repeat(3000);
        }],
        ['closed receipt without effects', state => {
            state.resources[resourceId] = storedResource(scope);
            state.submissions[receiptKey] = storedReceipt(scope, resourceId, receiptKey);
            state.submissions[receiptKey].effects = {};
        }],
        ['closed receipt without effect result', state => {
            state.resources[resourceId] = storedResource(scope);
            state.submissions[receiptKey] = storedReceipt(scope, resourceId, receiptKey);
            state.submissions[receiptKey].effects[receiptKey].result = null;
        }],
    ];
    for (const [name, mutate] of cases) {
        const malformed = JSON.parse(baseline.toString());
        mutate(malformed.state);
        fs.writeFileSync(statePath, JSON.stringify({ hash: roleplayHash(malformed.state), state: malformed.state }));
        assert.throws(() => readRoleplayAccount(scope), { code: 'ROLEPLAY_STORE_DAMAGED' }, `${name} must not load`);
        fs.writeFileSync(statePath, baseline);
        const before = fs.readFileSync(statePath);
        assert.throws(() => withRoleplayAccountLock(scope, lease => {
            mutate(roleplayLease(lease).state);
            saveRoleplayAccount(lease);
        }), { code: 'ROLEPLAY_STORE_DAMAGED' }, `${name} must not save`);
        assert.deepEqual(fs.readFileSync(statePath), before, `${name} must leave the ledger untouched`);
    }
});

test('receipt outcomes accept exactly 2048 canonical bytes and refuse 2049 before publication', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const statePath = path.join(f.directory, 'state.json');
    const baseline = fs.readFileSync(statePath);
    const resourceId = crypto.randomUUID();
    const candidate = size => {
        const saved = JSON.parse(baseline.toString());
        saved.state.resources[resourceId] = storedResource(scope);
        const receipt = storedReceipt(scope, resourceId, 'c'.repeat(64));
        receipt.outcome.integrity = 'x'.repeat(size - Buffer.byteLength(canonical(receipt.outcome)));
        receipt.effects['c'.repeat(64)].result = structuredClone(receipt.outcome);
        assert.equal(Buffer.byteLength(canonical(receipt.outcome)), size);
        saved.state.submissions['c'.repeat(64)] = receipt;
        return saved.state;
    };
    for (const size of [2047, 2048]) {
        const state = candidate(size);
        withRoleplayAccountLock(scope, lease => {
            Object.assign(roleplayLease(lease).state, state);
            saveRoleplayAccount(lease);
        });
        assert.equal(Buffer.byteLength(canonical(readRoleplayAccount(scope).submissions['c'.repeat(64)].outcome)), size);
        fs.writeFileSync(statePath, baseline);
    }
    const oversized = candidate(2049);
    assert.throws(() => withRoleplayAccountLock(scope, lease => {
        Object.assign(roleplayLease(lease).state, oversized);
        assert.throws(() => saveRoleplayAccount(lease), { code: 'ROLEPLAY_STORE_DAMAGED' });
        assert.throws(() => roleplayLease(lease), { code: 'ROLEPLAY_STORE_DAMAGED' });
    }), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.deepEqual(fs.readFileSync(statePath), baseline);
    fs.writeFileSync(statePath, JSON.stringify({ hash: roleplayHash(oversized), state: oversized }));
    assert.throws(() => readRoleplayAccount(scope), { code: 'ROLEPLAY_STORE_DAMAGED' });
    fs.writeFileSync(statePath, baseline);
});

test('retained historical paths and receipts remain valid without claiming current ownership', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const resourceId = crypto.randomUUID();
    const receiptKey = 'c'.repeat(64);
    const locator = { group: false, chat: 'Source', avatar: 'Nova.png' };
    const oldPathKey = roleplayHash([scope.accountId, scope.dataEpoch, 'chat', locator]);
    const accountId = crypto.randomUUID();
    withRoleplayAccountLock(scope, lease => {
        const { state } = roleplayLease(lease);
        state.resources[resourceId] = { ...storedResource(scope), status: 'replaced' };
        state.paths[oldPathKey] = { generation: 1, instanceId: resourceId };
        state.submissions[receiptKey] = storedReceipt(scope, resourceId, receiptKey);
        state.accountId = accountId;
        state.dataEpoch = 2;
        saveRoleplayAccount(lease);
    });
    assert.throws(() => readRoleplayAccount(scope), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    const retained = readRoleplayAccount({ ...scope, accountId, dataEpoch: 2 });
    assert.equal(retained.paths[oldPathKey].instanceId, resourceId);
    assert.equal(retained.submissions[receiptKey].accountId, scope.accountId);
    assert.equal(retained.resources[resourceId].dataEpoch, 1);
});

test('publication reserve and pre-transaction capacity refuse before any write', t => {
    const f = fixture(t);
    const scope = f.initialise();
    const statePath = path.join(f.directory, 'state.json');
    const before = fs.readFileSync(statePath);
    withRoleplayAccountLock(scope, lease => assertRoleplayTransactionCapacity(lease, null, roleplayLease(lease).state));
    assert.deepEqual(fs.readFileSync(statePath), before);
    const reserve = state => {
        const resourceId = crypto.randomUUID();
        state.resources[resourceId] = storedResource(scope);
        state.submissions['a'.repeat(64)] = { accountId: scope.accountId, dataEpoch: scope.dataEpoch,
            intentHash: 'b'.repeat(64), jobId: null, targetInstanceId: resourceId, state: 'preparing',
            reservedReceiptBytes: ROLEPLAY_STORE_MAX_BYTES, effects: {} };
    };
    assert.throws(() => withRoleplayAccountLock(scope, lease => {
        reserve(roleplayLease(lease).state);
        saveRoleplayAccount(lease);
    }), { code: 'ROLEPLAY_STORE_FULL' });
    assert.deepEqual(fs.readFileSync(statePath), before);
    assert.throws(() => withRoleplayAccountLock(scope, lease => {
        reserve(roleplayLease(lease).state);
        assertRoleplayTransactionCapacity(lease, null, roleplayLease(lease).state);
    }), { code: 'ROLEPLAY_STORE_FULL' });
    assert.deepEqual(fs.readFileSync(statePath), before);
});
