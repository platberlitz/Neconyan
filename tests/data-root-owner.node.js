import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { acquireDataRootOwner, DATA_ROOT_OWNER_DIRECTORY, describeDataRootOwner, inspectDataRootOwner, recoverDataRootOwner } from '../src/data-root-owner.js';

function root(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-root-owner-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
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
