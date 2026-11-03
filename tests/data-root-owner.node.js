import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { acquireDataRootOwner, DATA_ROOT_OWNER_DIRECTORY, describeDataRootOwner, inspectDataRootOwner, recoverDataRootOwner } from '../src/data-root-owner.js';

function root(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-root-owner-'));
    t.after(() => { t.mock.restoreAll(); fs.rmSync(directory, { recursive: true, force: true }); });
    return directory;
}

test('one owner excludes another and releases only its own record', t => {
    const directory = root(t);
    const owner = acquireDataRootOwner(directory, 'repair');
    assert.equal(inspectDataRootOwner(directory).purpose, 'repair');
    assert.throws(() => acquireDataRootOwner(directory, 'server'), { code: 'DATA_ROOT_OWNED' });
    owner.release();
    assert.equal(inspectDataRootOwner(directory), null);
    owner.release();
});

test('aliases use the same root-relative ownership', t => {
    const directory = root(t);
    const alias = path.join(directory, 'alias');
    fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const owner = acquireDataRootOwner(directory, 'server');
    assert.throws(() => acquireDataRootOwner(alias, 'repair'), { code: 'DATA_ROOT_OWNED' });
    owner.release();
});

test('a substituted owner is retained rather than removed', t => {
    const directory = root(t);
    const owner = acquireDataRootOwner(directory, 'repair');
    const filename = path.join(directory, DATA_ROOT_OWNER_DIRECTORY, 'owner.json');
    const value = JSON.parse(fs.readFileSync(filename));
    value.nonce = 'a'.repeat(32);
    fs.writeFileSync(filename, JSON.stringify(value));
    assert.throws(() => owner.release(), { code: 'DATA_ROOT_OWNED' });
    assert.equal(inspectDataRootOwner(directory).nonce, value.nonce);
});

test('a byte-identical replacement owner file is not removed', t => {
    const directory = root(t);
    const owner = acquireDataRootOwner(directory, 'repair');
    const filename = path.join(directory, DATA_ROOT_OWNER_DIRECTORY, 'owner.json');
    fs.copyFileSync(filename, filename + '.copy');
    fs.renameSync(filename + '.copy', filename);
    assert.throws(() => owner.release(), { code: 'DATA_ROOT_OWNED' });
    assert.ok(fs.existsSync(filename));
});

test('an incomplete owner is never treated as an expired lease', t => {
    const directory = root(t);
    fs.mkdirSync(path.join(directory, DATA_ROOT_OWNER_DIRECTORY));
    assert.throws(() => inspectDataRootOwner(directory), { code: 'DATA_ROOT_OWNED' });
    assert.throws(() => acquireDataRootOwner(directory, 'repair'), { code: 'DATA_ROOT_OWNED' });
    const token = describeDataRootOwner(directory).token;
    recoverDataRootOwner(directory, token);
    assert.equal(inspectDataRootOwner(directory), null);
});

test('explicit recovery refuses a live owner and a changed ownership record', t => {
    const directory = root(t);
    const owner = acquireDataRootOwner(directory, 'server');
    const token = describeDataRootOwner(directory).token;
    assert.throws(() => recoverDataRootOwner(directory, token), { code: 'DATA_ROOT_OWNED' });
    const filename = path.join(directory, DATA_ROOT_OWNER_DIRECTORY, 'owner.json');
    fs.appendFileSync(filename, ' ');
    assert.throws(() => recoverDataRootOwner(directory, token), { code: 'DATA_ROOT_OWNED' });
    assert.ok(fs.existsSync(filename));
    // The owner bytes changed, so it deliberately cannot release someone else's evidence.
    assert.throws(() => owner.release(), { code: 'DATA_ROOT_OWNED' });
});

test('a FIFO ownership file is refused without waiting for a writer', { skip: process.platform === 'win32' }, t => {
    const directory = root(t);
    const lock = path.join(directory, DATA_ROOT_OWNER_DIRECTORY);
    fs.mkdirSync(lock);
    execFileSync('mkfifo', [path.join(lock, 'owner.json')]);
    assert.throws(() => describeDataRootOwner(directory), { code: 'DATA_ROOT_OWNED' });
});

test('a dead local owner is reclaimed without a timeout', t => {
    const directory = root(t);
    const moduleUrl = new URL('../src/data-root-owner.js', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { acquireDataRootOwner } from ${JSON.stringify(moduleUrl)}; acquireDataRootOwner(process.argv[1], 'server');`, directory]);
    const previous = inspectDataRootOwner(directory);
    assert.notEqual(previous.pid, process.pid);
    const owner = acquireDataRootOwner(directory, 'repair');
    assert.equal(inspectDataRootOwner(directory).pid, process.pid);
    owner.release();
});

function failedOpen(t, directory, action = () => {}) {
    const filename = path.join(directory, DATA_ROOT_OWNER_DIRECTORY, 'owner.json');
    const original = fs.openSync;
    const error = Object.assign(new Error('injected create failure'), { code: 'EINJECTED' });
    let reached = false;
    t.mock.method(fs, 'openSync', function (name, flags, ...args) {
        if (name === filename && flags === (fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0))) {
            reached = true;
            action();
            throw error;
        }
        return original.call(fs, name, flags, ...args);
    });
    return { error, reached: () => reached };
}

function ownedFixture(t) {
    const parent = root(t);
    const directory = path.join(parent, 'data');
    fs.mkdirSync(directory);
    return { parent, directory, lock: path.join(directory, DATA_ROOT_OWNER_DIRECTORY) };
}

for (const purpose of ['server', 'repair']) {
    test(`failed ${purpose} create removes only its empty directory and permits retry`, t => {
        const { directory, lock } = ownedFixture(t);
        const injection = failedOpen(t, directory);
        assert.throws(() => acquireDataRootOwner(directory, purpose), error => error === injection.error);
        assert.ok(injection.reached());
        assert.equal(fs.existsSync(lock), false);
        t.mock.restoreAll();
        const owner = acquireDataRootOwner(directory, purpose);
        assert.equal(inspectDataRootOwner(directory).purpose, purpose);
        owner.release();
    });
}

test('pre-existing empty and foreign ownership evidence is refused before create', t => {
    const { directory, lock } = ownedFixture(t);
    fs.mkdirSync(lock);
    const injection = failedOpen(t, directory);
    assert.throws(() => acquireDataRootOwner(directory, 'server'), { code: 'DATA_ROOT_OWNED' });
    assert.equal(injection.reached(), false);
    assert.ok(fs.existsSync(lock));
    t.mock.restoreAll();
    fs.rmdirSync(lock);
    const owner = acquireDataRootOwner(directory, 'server');
    const filename = path.join(lock, 'owner.json');
    const value = JSON.parse(fs.readFileSync(filename));
    value.hostname = 'foreign-host';
    const bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(filename, bytes);
    const foreign = failedOpen(t, directory);
    assert.throws(() => acquireDataRootOwner(directory, 'repair'), { code: 'DATA_ROOT_OWNED' });
    assert.equal(foreign.reached(), false);
    assert.deepEqual(fs.readFileSync(filename), bytes);
    assert.ok(fs.existsSync(lock));
    void owner;
});

test('replacement directory and original survive failed create', t => {
    const { parent, directory, lock } = ownedFixture(t);
    const old = path.join(parent, 'old-lock');
    const injection = failedOpen(t, directory, () => { fs.renameSync(lock, old); fs.mkdirSync(lock); });
    assert.throws(() => acquireDataRootOwner(directory, 'server'), error => error === injection.error);
    assert.ok(fs.existsSync(lock)); assert.ok(fs.existsSync(old));
});

test('replacement junction and target survive failed create', t => {
    const { parent, directory, lock } = ownedFixture(t);
    const old = path.join(parent, 'old-lock');
    const target = path.join(parent, 'target'); fs.mkdirSync(target);
    const injection = failedOpen(t, directory, () => {
        fs.renameSync(lock, old); fs.symlinkSync(target, lock, process.platform === 'win32' ? 'junction' : 'dir');
    });
    assert.throws(() => acquireDataRootOwner(directory, 'server'), error => error === injection.error);
    assert.ok(fs.lstatSync(lock).isSymbolicLink()); assert.ok(fs.existsSync(target)); assert.ok(fs.existsSync(old));
});

test('nonempty ownership evidence survives failed create', t => {
    const { directory, lock } = ownedFixture(t);
    const bytes = Buffer.from('foreign owner bytes');
    const injection = failedOpen(t, directory, () => fs.writeFileSync(path.join(lock, 'owner.json'), bytes));
    assert.throws(() => acquireDataRootOwner(directory, 'server'), error => error === injection.error);
    assert.deepEqual(fs.readFileSync(path.join(lock, 'owner.json')), bytes);
});

test('content inserted at native rmdir survives failed create', t => {
    const { directory, lock } = ownedFixture(t);
    const bytes = Buffer.from('concurrent content');
    const original = fs.rmdirSync; let attempted = false;
    t.mock.method(fs, 'rmdirSync', function (name, ...args) {
        if (name === lock) { attempted = true; fs.writeFileSync(path.join(lock, 'concurrent'), bytes); }
        return original.call(fs, name, ...args);
    });
    const injection = failedOpen(t, directory);
    assert.throws(() => acquireDataRootOwner(directory, 'server'), error => error === injection.error);
    assert.ok(attempted);
    assert.deepEqual(fs.readFileSync(path.join(lock, 'concurrent')), bytes);
});

for (const replaceWithLink of [false, true]) {
    test(`replaced root${replaceWithLink ? ' junction' : ''} survives failed create`, t => {
        const { parent, directory } = ownedFixture(t);
        const old = path.join(parent, 'old-root');
        const injection = failedOpen(t, directory, () => {
            fs.renameSync(directory, old);
            if (replaceWithLink) fs.symlinkSync(old, directory, process.platform === 'win32' ? 'junction' : 'dir');
            else fs.mkdirSync(directory);
        });
        assert.throws(() => acquireDataRootOwner(directory, 'server'), error => error === injection.error);
        assert.ok(fs.existsSync(path.join(old, DATA_ROOT_OWNER_DIRECTORY)));
        assert.ok(fs.existsSync(directory));
        if (replaceWithLink) assert.ok(fs.lstatSync(directory).isSymbolicLink());
    });
}

test('unusable inode and inspection or removal failures preserve evidence and original error', async t => {
    for (const kind of ['zero', 'inspection', 'removal']) await t.test(kind, t => {
        const { directory, lock } = ownedFixture(t);
        const lstat = fs.lstatSync; const rmdir = fs.rmdirSync; let opened = false;
        t.mock.method(fs, 'lstatSync', function (name, ...args) {
            if (name === lock && kind === 'zero') {
                const stat = lstat.call(fs, name, ...args); return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: 0n });
            }
            if (name === lock && opened && kind === 'inspection') throw new Error('inspection failure');
            return lstat.call(fs, name, ...args);
        });
        t.mock.method(fs, 'rmdirSync', function (name, ...args) {
            if (name === lock && kind === 'removal') throw new Error('removal failure');
            return rmdir.call(fs, name, ...args);
        });
        const injection = failedOpen(t, directory, () => { opened = true; });
        assert.throws(() => acquireDataRootOwner(directory, 'server'), error => error === injection.error);
        assert.ok(fs.existsSync(lock));
    });
});

test('failed create after dead-owner reclaim cleans the newly created directory', t => {
    const { directory, lock } = ownedFixture(t);
    const moduleUrl = new URL('../src/data-root-owner.js', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { acquireDataRootOwner } from ${JSON.stringify(moduleUrl)}; acquireDataRootOwner(process.argv[1], 'server');`, directory], { windowsHide: true, timeout: 10000 });
    const injection = failedOpen(t, directory);
    assert.throws(() => acquireDataRootOwner(directory, 'repair'), error => error === injection.error);
    assert.ok(injection.reached()); assert.equal(fs.existsSync(lock), false);
});

test('partial owner write retains exact bytes and the write error', t => {
    const { directory, lock } = ownedFixture(t);
    const original = fs.writeFileSync; const bytes = Buffer.from('partial owner'); const error = new Error('write failure');
    t.mock.method(fs, 'writeFileSync', function (file, ...args) {
        if (typeof file === 'number') { original.call(fs, file, bytes); throw error; }
        return original.call(fs, file, ...args);
    });
    assert.throws(() => acquireDataRootOwner(directory, 'server'), cause => cause === error);
    assert.deepEqual(fs.readFileSync(path.join(lock, 'owner.json')), bytes);
});

test('missing identity or directory timestamp evidence preserves the failed owner directory', async t => {
    for (const [target, field] of [['root', 'dev'], ['root', 'ino'], ['directory', 'dev'], ['directory', 'ino'], ['directory', 'ctimeNs'], ['directory', 'mtimeNs']]) {
        await t.test(`${target} ${field}`, t => {
            const { directory, lock } = ownedFixture(t);
            const method = target === 'root' ? 'statSync' : 'lstatSync';
            const original = fs[method];
            t.mock.method(fs, method, function (name, ...args) {
                const stat = original.call(fs, name, ...args);
                if (name !== (target === 'root' ? directory : lock)) return stat;
                return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { [field]: undefined });
            });
            const injection = failedOpen(t, directory);
            assert.throws(() => acquireDataRootOwner(directory, 'server'), error => error === injection.error);
            assert.ok(fs.existsSync(lock));
        });
    }
});
