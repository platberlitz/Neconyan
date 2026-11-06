import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { acquireDataRootOwner, DATA_ROOT_OWNER_DIRECTORY, describeDataRootOwner, inspectDataRootOwner, recoverDataRootOwner } from '../src/data-root-owner.js';
import * as ownerModule from '../src/data-root-owner.js';

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

// Android app lease policy (AND-LEASE-01).
const android = { androidAppServer: true };
const linux = process.platform === 'linux';
const canSeeForeignPid = linux && process.getuid?.() !== 0 && (() => {
    try { process.kill(1, 0); return false; } catch (error) { return error.code === 'EPERM'; }
})();

function plantLease(directory, change = () => {}) {
    const moduleUrl = new URL('../src/data-root-owner.js', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { acquireDataRootOwner } from ${JSON.stringify(moduleUrl)}; acquireDataRootOwner(process.argv[1], 'server');`, directory], { windowsHide: true, timeout: 10000 });
    const filename = path.join(directory, DATA_ROOT_OWNER_DIRECTORY, 'owner.json');
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    change(value);
    const bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(filename, bytes);
    return { filename, value, bytes };
}

function procStart(pid) {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

async function liveChild(t) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    await once(child, 'spawn');
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    });
    return child;
}

const bump = value => String(BigInt(value) + 1n);

test('the Android app reclaims a dead lease with a foreign hostname', t => {
    const directory = root(t);
    plantLease(directory, value => { value.hostname = 'foreign-host'; });
    const owner = acquireDataRootOwner(directory, 'server', android);
    assert.equal(owner.reclaimed.reason, 'process-ended');
    assert.deepEqual(owner.reclaimed.details.differs, ['hostname']);
    const record = inspectDataRootOwner(directory);
    assert.equal(record.pid, process.pid);
    assert.equal(record.hostname, os.hostname());
    owner.release();
    assert.equal(inspectDataRootOwner(directory), null);
});

test('the Android app reclaims a dead lease with a foreign root device and inode', t => {
    const directory = root(t);
    plantLease(directory, value => { value.root.dev = bump(value.root.dev); value.root.ino = bump(value.root.ino); });
    const owner = acquireDataRootOwner(directory, 'server', android);
    assert.deepEqual(owner.reclaimed.details.differs, ['root.dev', 'root.ino']);
    owner.release();
});

test('the Android app reclaims a dead lease with a foreign platform', t => {
    const directory = root(t);
    plantLease(directory, value => { value.platform = 'foreign-os'; });
    const owner = acquireDataRootOwner(directory, 'server', android);
    assert.deepEqual(owner.reclaimed.details.differs, ['platform']);
    owner.release();
});

test('the Android app reclaims a lease whose PID belongs to another app', { skip: !canSeeForeignPid }, t => {
    const directory = root(t);
    plantLease(directory, value => { value.pid = 1; value.processStart = bump(procStart(1)); });
    const owner = acquireDataRootOwner(directory, 'server', android);
    assert.equal(owner.reclaimed.reason, 'pid-of-another-app');
    owner.release();
});

test('the Android app refuses a lease held by a visible live process it cannot signal', { skip: !canSeeForeignPid }, t => {
    const directory = root(t);
    const planted = plantLease(directory, value => { value.pid = 1; value.processStart = procStart(1); });
    assert.throws(() => acquireDataRootOwner(directory, 'server', android), error => {
        assert.equal(error.code, 'DATA_ROOT_OWNED');
        assert.match(error.message, /force stop/);
        assert.equal(error.details.owner.pid, 1);
        return true;
    });
    assert.deepEqual(fs.readFileSync(planted.filename), planted.bytes);
});

test('the Android app reclaims a lease whose PID was reused by a live process', { skip: !linux }, async t => {
    const directory = root(t);
    const child = await liveChild(t);
    plantLease(directory, value => { value.pid = child.pid; value.processStart = '1'; });
    const owner = acquireDataRootOwner(directory, 'server', android);
    assert.equal(owner.reclaimed.reason, 'pid-reused');
    owner.release();
});

test('the Android app refuses a lease held by a live process with the same start', { skip: !linux }, async t => {
    const directory = root(t);
    const child = await liveChild(t);
    const planted = plantLease(directory, value => { value.pid = child.pid; value.processStart = procStart(child.pid); });
    assert.throws(() => acquireDataRootOwner(directory, 'server', android), error => {
        assert.equal(error.code, 'DATA_ROOT_OWNED');
        assert.match(error.message, /force stop/);
        assert.equal(error.details.owner.pid, child.pid);
        return true;
    });
    assert.deepEqual(fs.readFileSync(planted.filename), planted.bytes);
});

test('the Android app refuses a live process it cannot identify', async t => {
    const directory = root(t);
    const child = await liveChild(t);
    const planted = plantLease(directory, value => { value.pid = child.pid; value.processStart = null; });
    assert.throws(() => acquireDataRootOwner(directory, 'server', android), error => {
        assert.equal(error.code, 'DATA_ROOT_OWNED');
        assert.match(error.message, /force stop/);
        return true;
    });
    assert.deepEqual(fs.readFileSync(planted.filename), planted.bytes);
});

test('the Android app reclaims a lease naming its own PID that it does not hold', t => {
    const directory = root(t);
    plantLease(directory, value => { value.pid = process.pid; value.hostname = 'foreign-host'; });
    const owner = acquireDataRootOwner(directory, 'server', android);
    assert.equal(owner.reclaimed.reason, 'pid-reused');
    owner.release();
});

test('a second Android acquisition of one root in this process is refused', t => {
    const directory = root(t);
    const first = acquireDataRootOwner(directory, 'server', android);
    assert.throws(() => acquireDataRootOwner(directory, 'server', android), { code: 'DATA_ROOT_OWNED' });
    first.release();
    assert.equal(inspectDataRootOwner(directory), null);
});

test('the Android app reclaims each incomplete lease record', async t => {
    const cases = {
        'empty directory': () => {},
        'empty owner file': lock => fs.writeFileSync(path.join(lock, 'owner.json'), ''),
        'partial JSON': lock => fs.writeFileSync(path.join(lock, 'owner.json'), '{'),
        'wrong schema version': lock => fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ version: 2 })),
    };
    for (const [name, build] of Object.entries(cases)) await t.test(name, t => {
        const { directory, lock } = ownedFixture(t);
        fs.mkdirSync(lock);
        build(lock);
        const owner = acquireDataRootOwner(directory, 'server', android);
        assert.equal(owner.reclaimed.reason, 'incomplete-record');
        assert.equal(inspectDataRootOwner(directory).pid, process.pid);
        owner.release();
    });
});

function evidence(lock) {
    const stat = fs.lstatSync(lock);
    if (stat.isSymbolicLink()) return { link: fs.readlinkSync(lock) };
    return fs.readdirSync(lock).sort().map(name => {
        const file = path.join(lock, name);
        const entry = fs.lstatSync(file);
        const kind = entry.isSymbolicLink() ? 'link:' + fs.readlinkSync(file) : entry.isFIFO() ? 'fifo'
            : entry.isFile() ? 'file:' + fs.readFileSync(file).toString('hex') : 'other';
        return [name, kind, entry.nlink];
    });
}

test('the Android app refuses unsafe lease evidence and leaves it untouched', async t => {
    const unsafe = {
        'an extra file': { build: ({ directory, lock }) => {
            plantLease(directory);
            fs.writeFileSync(path.join(lock, 'extra'), 'x');
        } },
        'a symlinked owner file': { skip: process.platform === 'win32', build: ({ parent, directory }) => {
            const planted = plantLease(directory);
            const outside = path.join(parent, 'outside-owner.json');
            fs.renameSync(planted.filename, outside);
            fs.symlinkSync(outside, planted.filename);
            return () => { assert.ok(fs.lstatSync(planted.filename).isSymbolicLink()); assert.deepEqual(fs.readFileSync(outside), planted.bytes); };
        } },
        'a symlinked lease directory': { skip: process.platform === 'win32', build: ({ parent, lock }) => {
            const target = path.join(parent, 'outside-empty');
            fs.mkdirSync(target);
            fs.symlinkSync(target, lock, 'dir');
            return () => { assert.ok(fs.lstatSync(lock).isSymbolicLink()); assert.deepEqual(fs.readdirSync(target), []); };
        } },
        'a hard-linked owner file': { build: ({ parent, directory }) => {
            const planted = plantLease(directory);
            fs.linkSync(planted.filename, path.join(parent, 'second-link'));
        } },
        'a FIFO owner file': { skip: process.platform === 'win32', build: ({ lock }) => {
            fs.mkdirSync(lock);
            execFileSync('mkfifo', [path.join(lock, 'owner.json')]);
        } },
        'an oversized owner file': { build: ({ lock }) => {
            fs.mkdirSync(lock);
            fs.writeFileSync(path.join(lock, 'owner.json'), Buffer.alloc(5000, 0x20));
        } },
    };
    for (const [name, entry] of Object.entries(unsafe)) {
        await t.test(name, { skip: entry.skip }, t => {
            const fixture = ownedFixture(t);
            const extra = entry.build(fixture);
            const before = evidence(fixture.lock);
            assert.throws(() => acquireDataRootOwner(fixture.directory, 'server', android));
            assert.deepEqual(evidence(fixture.lock), before);
            if (typeof extra === 'function') extra();
        });
    }
});

test('default mode still refuses dead leases from a foreign host, root or platform', async t => {
    const cases = {
        hostname: value => { value.hostname = 'foreign-host'; },
        root: value => { value.root.dev = bump(value.root.dev); value.root.ino = bump(value.root.ino); },
        platform: value => { value.platform = 'foreign-os'; },
    };
    for (const [name, change] of Object.entries(cases)) await t.test(name, t => {
        const { directory } = ownedFixture(t);
        const planted = plantLease(directory, change);
        const injection = failedOpen(t, directory);
        assert.throws(() => acquireDataRootOwner(directory, 'server'), { code: 'DATA_ROOT_OWNED' });
        assert.equal(injection.reached(), false);
        assert.deepEqual(fs.readFileSync(planted.filename), planted.bytes);
    });
});

test('a default-mode refusal carries the lease evidence but never the nonce', t => {
    const directory = root(t);
    const planted = plantLease(directory, value => { value.hostname = 'foreign-host'; });
    assert.throws(() => acquireDataRootOwner(directory, 'server'), error => {
        assert.equal(error.code, 'DATA_ROOT_OWNED');
        assert.deepEqual(Object.keys(error.details.owner).sort(), ['hostname', 'pid', 'platform', 'processStart', 'purpose', 'root']);
        assert.deepEqual(error.details.differs, ['hostname']);
        assert.ok(error.message.includes(`Lease record: pid=${planted.value.pid}`));
        assert.ok(error.message.endsWith('differs: hostname.'));
        assert.ok(!error.message.includes(planted.value.nonce));
        assert.ok(!JSON.stringify(error.details).includes(planted.value.nonce));
        return true;
    });
});

test('default mode reports an unsignalable PID as a refusal, not a raw EPERM', { skip: !canSeeForeignPid }, t => {
    const directory = root(t);
    plantLease(directory, value => { value.pid = 1; });
    assert.throws(() => acquireDataRootOwner(directory, 'server'), error => {
        assert.equal(error.code, 'DATA_ROOT_OWNED');
        assert.ok(error.details);
        return true;
    });
});

test('a default-mode dead-owner reclaim reports why', t => {
    const directory = root(t);
    plantLease(directory);
    const owner = acquireDataRootOwner(directory, 'repair');
    assert.equal(owner.reclaimed.reason, 'process-ended');
    owner.release();
});

test('the Android option is validated', t => {
    const directory = root(t);
    assert.throws(() => acquireDataRootOwner(directory, 'repair', android), TypeError);
    assert.throws(() => acquireDataRootOwner(directory, 'server', { androidAppServer: 'yes' }), TypeError);
});

test('the Android server is recognised only with the platform, the marker and the app binding', () => {
    const marker = { NECONYAN_ANDROID_APP: '1' };
    const binding = () => ({});
    const check = options => {
        const warnings = [];
        const result = ownerModule.isAndroidAppServer({ warn: message => warnings.push(message), ...options });
        return { result, warnings };
    };
    assert.deepEqual(check({ platform: 'android', env: marker, linkedBinding: binding }), { result: true, warnings: [] });
    assert.deepEqual(check({ platform: 'android', env: {}, linkedBinding: binding }), { result: false, warnings: [] });
    assert.deepEqual(check({ platform: 'linux', env: marker, linkedBinding: binding }), { result: false, warnings: [] });
    for (const linkedBinding of [() => { throw new Error('No such binding'); }, () => undefined]) {
        const { result, warnings } = check({ platform: 'android', env: marker, linkedBinding });
        assert.equal(result, false);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /neconyan_fs binding is missing/);
    }
});

test('an Android lease that vanishes while it is checked is refused', t => {
    const { directory, lock } = ownedFixture(t);
    const planted = plantLease(directory, value => { value.hostname = 'foreign-host'; });
    const lstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', function (name, ...args) {
        if (name === lock) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return lstat.call(fs, name, ...args);
    });
    assert.throws(() => acquireDataRootOwner(directory, 'server', android), error => {
        assert.equal(error.code, 'DATA_ROOT_OWNED');
        assert.match(error.message, /force stop/);
        assert.match(error.message, /Lease record: incomplete or unreadable/);
        assert.equal(error.details.owner, null);
        return true;
    });
    t.mock.restoreAll();
    assert.deepEqual(fs.readFileSync(planted.filename), planted.bytes);
});

for (const [name, failingRead] of [['the ownership record changed', 1], ['the recovery check sees a changed record', 2]]) {
    test(`default mode refuses with details when ${name}`, { skip: process.platform === 'win32' }, t => {
        const { directory } = ownedFixture(t);
        const planted = plantLease(directory);
        const read = fs.readFileSync;
        let snapshots = 0;
        t.mock.method(fs, 'readFileSync', function (file, ...args) {
            if (typeof file === 'number' && args.length === 0 && ++snapshots === failingRead) {
                return Buffer.from(JSON.stringify({ ...planted.value, nonce: 'b'.repeat(32) }));
            }
            return read.call(fs, file, ...args);
        });
        assert.throws(() => acquireDataRootOwner(directory, 'server'), error => {
            assert.equal(error.code, 'DATA_ROOT_OWNED');
            assert.ok(error.details);
            return true;
        });
        t.mock.restoreAll();
        assert.deepEqual(fs.readFileSync(planted.filename), planted.bytes);
    });
}

// iOS app lease policy (IOS-LEASE-01).
const ios = { iosAppServer: true };

test('the iOS app reclaims a dead lease with a foreign hostname', t => {
    const directory = root(t);
    plantLease(directory, value => { value.hostname = 'foreign-host'; });
    const owner = acquireDataRootOwner(directory, 'server', ios);
    assert.equal(owner.reclaimed.reason, 'process-ended');
    assert.deepEqual(owner.reclaimed.details.differs, ['hostname']);
    assert.ok(owner.reclaimed.message.startsWith('Reclaimed a stale data folder lease (process-ended).'));
    const record = inspectDataRootOwner(directory);
    assert.equal(record.pid, process.pid);
    assert.equal(record.hostname, os.hostname());
    owner.release();
    assert.equal(inspectDataRootOwner(directory), null);
});

test('the iOS app reclaims a dead lease with a foreign root device and inode', t => {
    const directory = root(t);
    plantLease(directory, value => { value.root.dev = bump(value.root.dev); value.root.ino = bump(value.root.ino); });
    const owner = acquireDataRootOwner(directory, 'server', ios);
    assert.deepEqual(owner.reclaimed.details.differs, ['root.dev', 'root.ino']);
    owner.release();
});

test('the iOS app reclaims a dead lease with a foreign platform', t => {
    const directory = root(t);
    plantLease(directory, value => { value.platform = 'ios'; });
    const owner = acquireDataRootOwner(directory, 'server', ios);
    assert.deepEqual(owner.reclaimed.details.differs, ['platform']);
    owner.release();
});

test('the iOS app reclaims a lease whose PID belongs to another app', { skip: !canSeeForeignPid }, t => {
    const directory = root(t);
    plantLease(directory, value => { value.pid = 1; value.processStart = null; });
    const owner = acquireDataRootOwner(directory, 'server', ios);
    assert.equal(owner.reclaimed.reason, 'pid-of-another-app');
    owner.release();
});

function assertIosBusy(error, pid) {
    assert.equal(error.code, 'DATA_ROOT_OWNED');
    assert.match(error.message, /app switcher/);
    assert.match(error.message, /restart the iPhone/);
    assert.doesNotMatch(error.message, /force stop/);
    assert.equal(error.details.owner.pid, pid);
    return true;
}

test('the iOS app refuses a lease held by a live process it can signal', { skip: !linux }, async t => {
    const directory = root(t);
    const child = await liveChild(t);
    const planted = plantLease(directory, value => { value.pid = child.pid; value.processStart = null; });
    assert.throws(() => acquireDataRootOwner(directory, 'server', ios), error => assertIosBusy(error, child.pid));
    assert.deepEqual(fs.readFileSync(planted.filename), planted.bytes);
});

test('the iOS app refuses a lease held by a live process with the same start', { skip: !linux }, async t => {
    const directory = root(t);
    const child = await liveChild(t);
    const planted = plantLease(directory, value => { value.pid = child.pid; value.processStart = procStart(child.pid); });
    assert.throws(() => acquireDataRootOwner(directory, 'server', ios), error => assertIosBusy(error, child.pid));
    assert.deepEqual(fs.readFileSync(planted.filename), planted.bytes);
});

test('the iOS app reclaims a lease naming its own PID that it does not hold', t => {
    const directory = root(t);
    plantLease(directory, value => { value.pid = process.pid; value.hostname = 'foreign-host'; });
    const owner = acquireDataRootOwner(directory, 'server', ios);
    assert.equal(owner.reclaimed.reason, 'pid-reused');
    owner.release();
});

test('a second iOS acquisition of one root in this process is refused', t => {
    const directory = root(t);
    const first = acquireDataRootOwner(directory, 'server', ios);
    assert.throws(() => acquireDataRootOwner(directory, 'server', ios), { code: 'DATA_ROOT_OWNED' });
    first.release();
    assert.equal(inspectDataRootOwner(directory), null);
});

test('the iOS app reclaims each incomplete lease record', async t => {
    const cases = {
        'empty directory': () => {},
        'empty owner file': lock => fs.writeFileSync(path.join(lock, 'owner.json'), ''),
        'partial JSON': lock => fs.writeFileSync(path.join(lock, 'owner.json'), '{'),
        'wrong schema version': lock => fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ version: 2 })),
    };
    for (const [name, build] of Object.entries(cases)) await t.test(name, t => {
        const { directory, lock } = ownedFixture(t);
        fs.mkdirSync(lock);
        build(lock);
        const owner = acquireDataRootOwner(directory, 'server', ios);
        assert.equal(owner.reclaimed.reason, 'incomplete-record');
        assert.equal(inspectDataRootOwner(directory).pid, process.pid);
        owner.release();
    });
});

test('the iOS app refuses unsafe lease evidence and leaves it untouched', async t => {
    const unsafe = {
        'an extra file': ({ directory, lock }) => {
            plantLease(directory);
            fs.writeFileSync(path.join(lock, 'extra'), 'x');
        },
        'an oversized owner file': ({ lock }) => {
            fs.mkdirSync(lock);
            fs.writeFileSync(path.join(lock, 'owner.json'), Buffer.alloc(5000, 0x20));
        },
    };
    for (const [name, build] of Object.entries(unsafe)) await t.test(name, t => {
        const fixture = ownedFixture(t);
        build(fixture);
        const before = evidence(fixture.lock);
        assert.throws(() => acquireDataRootOwner(fixture.directory, 'server', ios), error => {
            assert.match(error.message, /Keep Neconyan installed/);
            return true;
        });
        assert.deepEqual(evidence(fixture.lock), before);
    });
});

test('an iOS lease that vanishes while it is checked is refused', t => {
    const { directory, lock } = ownedFixture(t);
    const planted = plantLease(directory, value => { value.hostname = 'foreign-host'; });
    const lstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', function (name, ...args) {
        if (name === lock) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return lstat.call(fs, name, ...args);
    });
    assert.throws(() => acquireDataRootOwner(directory, 'server', ios), error => {
        assert.equal(error.code, 'DATA_ROOT_OWNED');
        assert.match(error.message, /app switcher/);
        assert.match(error.message, /Lease record: incomplete or unreadable/);
        return true;
    });
    t.mock.restoreAll();
    assert.deepEqual(fs.readFileSync(planted.filename), planted.bytes);
});

test('the iOS option is validated', t => {
    const directory = root(t);
    assert.throws(() => acquireDataRootOwner(directory, 'server', { iosAppServer: 'yes' }), TypeError);
    assert.throws(() => acquireDataRootOwner(directory, 'repair', ios), TypeError);
    assert.throws(() => acquireDataRootOwner(directory, 'server', { iosAppServer: true, androidAppServer: true }), TypeError);
});

test('the iOS server is recognised only with the marker and the iOS platform or container path', () => {
    const marker = { NECONYAN_IOS_APP: '1' };
    const uuid = '0A1B2C3D-0000-4000-8000-00000000ABCD';
    const container = `/var/mobile/Containers/Data/Application/${uuid}/Library/Application Support/Neconyan/data`;
    const simulator = `/Users/x/Library/Developer/CoreSimulator/Devices/${uuid}/data/Containers/Data/Application/${uuid}/Library/Application Support/Neconyan/data`;
    const check = ({ realpath = () => { throw new Error('unexpected'); }, ...options }) => {
        const warnings = [];
        let realpathCalls = 0;
        const result = ownerModule.isIosAppServer({ dataRoot: '/data', warn: message => warnings.push(message),
            ...options, realpath: value => { realpathCalls++; return realpath(value); } });
        return { result, warnings, realpathCalls };
    };
    const real = value => () => value;
    let outcome = check({ platform: 'ios', env: marker });
    assert.deepEqual(outcome, { result: true, warnings: [], realpathCalls: 0 });
    for (const candidate of [container, `/private${container}`]) {
        outcome = check({ platform: 'darwin', env: marker, realpath: real(candidate) });
        assert.deepEqual(outcome, { result: true, warnings: [], realpathCalls: 1 });
    }
    for (const [platform, env] of [['ios', {}], ['darwin', {}], ['ios', { NECONYAN_IOS_APP: 'true' }], ['darwin', { NECONYAN_IOS_APP: 'true' }]]) {
        outcome = check({ platform, env, realpath: real(container) });
        assert.equal(outcome.result, false);
        assert.deepEqual(outcome.warnings, []);
    }
    for (const platform of ['linux', 'android', 'win32']) {
        outcome = check({ platform, env: marker, realpath: real(container) });
        assert.equal(outcome.result, false);
        assert.equal(outcome.warnings.length, 1);
        assert.ok(outcome.warnings[0].includes(platform));
    }
    const falseRealpaths = [real('/Users/x/Library/Application Support/Neconyan/data'), real(simulator), real(`${container}/sub`),
        () => { throw new Error('gone'); }];
    for (const realpath of falseRealpaths) {
        outcome = check({ platform: 'darwin', env: marker, realpath });
        assert.equal(outcome.result, false);
        assert.equal(outcome.warnings.length, 1);
        assert.ok(outcome.warnings[0].includes('darwin'));
    }
});
