import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { DATA_IDENTITY_REPAIR_DIRECTORY } from '../src/data-identity-repair-inspection.js';
import { DATA_ROOT_OWNER_DIRECTORY } from '../src/data-root-owner.js';
import { roleplayHash, roleplayStoreDirectory } from '../src/roleplay-store.js';

const cli = fileURLToPath(new URL('../scripts/repair-data-identity.js', import.meta.url));
const preload = fileURLToPath(new URL('./termux-ctime-fixture.js', import.meta.url));
function check(root, backup) {
    return spawnSync(process.execPath, ['--import', preload, cli, 'check', '--dataRoot', root, '--backupRoot', backup], {
        encoding: 'utf8', env: { ...process.env, NECONYAN_CONVERSATION_TEST_DISPOSABLE: '1' },
    });
}
function backup(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-repair-backup-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('read-only checks bind a stable token and retain the original ledger and files', t => {
    const f = fixture(t);
    f.source();
    const outside = backup(t);
    const state = path.join(roleplayStoreDirectory(f.scope), 'state.json');
    const before = fs.readFileSync(state);
    const beforeChat = fs.readFileSync(f.filename);
    const first = check(f.root, outside);
    assert.equal(first.status, 0, first.stderr);
    const second = check(f.root, outside);
    assert.equal(second.status, 0, second.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.token, JSON.parse(second.stdout).token);
    assert.equal(report.accounts[0].account, f.scope.owner);
    assert.equal(report.accounts[0].counts.chats, 1);
    assert.deepEqual(fs.readFileSync(state), before);
    assert.deepEqual(fs.readFileSync(f.filename), beforeChat);
    assert.equal(fs.existsSync(path.join(f.root, DATA_ROOT_OWNER_DIRECTORY)), false);
    assert.equal(fs.existsSync(path.join(f.root, '_termux-file-identity.json')), false);
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('existing repair gate, unsafe links and backup inside data are refused', t => {
    const f = fixture(t);
    f.source();
    const outside = backup(t);
    const marker = path.join(f.root, DATA_IDENTITY_REPAIR_DIRECTORY);
    fs.mkdirSync(marker);
    assert.notEqual(check(f.root, outside).status, 0);
    fs.rmdirSync(marker);
    const link = path.join(f.root, 'unsafe-link');
    fs.symlinkSync(f.filename, link);
    assert.notEqual(check(f.root, outside).status, 0);
    fs.unlinkSync(link);
    assert.notEqual(check(f.root, f.root).status, 0);
    assert.equal(fs.existsSync(path.join(f.root, DATA_ROOT_OWNER_DIRECTORY)), false);
});

test('a surviving reset with unfinished effects blocks a policy change', t => {
    const f = fixture(t);
    f.source();
    const outside = backup(t);
    const operations = path.join(roleplayStoreDirectory(f.scope), 'operations');
    fs.mkdirSync(operations);
    const filename = path.join(operations, 'a'.repeat(64) + '.json');
    const record = { version: 1, key: 'test', requestHash: 'a'.repeat(64), jobId: 'test-job', state: 'refused', kind: 'account-reset', account: { accountId: f.scope.accountId, dataEpoch: 1 },
        plan: {}, planHash: roleplayHash({}), effects: { reset: { state: 'prepared' } } };
    fs.writeFileSync(filename, JSON.stringify(record));
    const result = check(f.root, outside);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reset.*unfinished effects/i);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename)), record);
});

test('a valid earlier account incarnation remains preserved without blocking repair', t => {
    const f = fixture(t);
    f.source();
    const outside = backup(t);
    const operations = path.join(roleplayStoreDirectory(f.scope), 'operations');
    fs.mkdirSync(operations);
    const filename = path.join(operations, 'b'.repeat(64) + '.json');
    const record = { version: 1, key: 'test', requestHash: 'a'.repeat(64), jobId: 'test-job', state: 'accepted', kind: 'account-reset', account: { accountId: crypto.randomUUID(), dataEpoch: 1 },
        plan: {}, planHash: roleplayHash({}), effects: { reset: { state: 'prepared' } } };
    fs.writeFileSync(filename, JSON.stringify(record));
    const result = check(f.root, outside);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename)), record);
});

test('a missing ready-account folder is not treated as an empty or retired account', t => {
    const f = fixture(t);
    const outside = backup(t);
    fs.rmSync(f.scope.directories.root, { recursive: true });
    const result = check(f.root, outside);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /active account folder is missing/i);
    assert.equal(fs.existsSync(f.scope.directories.root), false);
});
