import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';
import { publicationFilesystem } from './roleplay-publication-fixture.js';
import { write as writeCard } from '../src/character-card-parser.js';
import { readRoleplayAccount, readRoleplayFile, roleplayStoreDirectory, withRoleplayAccount } from '../src/roleplay-store.js';
import { commitRoleplayLifecycleLocked, commitSingleGroupUpdate, commitSingleChatImport, reconcilePendingChatWrite } from '../src/roleplay-lifecycle.js';
import { readRoleplayEntity } from '../src/generation/roleplay-source.js';
import { roleplayNativeHost, convertImportedChatFile } from '../src/endpoints/chats.js';

const bytes = writeCard(png, JSON.stringify({ name: 'Probe', description: 'Saved' }));
function create(f) {
    return withRoleplayAccount(f.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
        operationKey: 'probe', action: 'character-create', intent: { avatar: 'Probe.png' },
        steps: [{ op: 'create', kind: 'character', locator: { avatar: 'Probe.png' }, bytes }],
    }));
}

for (const family of ['lifecycle', 'group', 'import-character', 'import-group']) {
    test(`inode-changing publication preserves ${family} receipt and exact head`, t => {
        const f = fixture(t, false, family);
        const mock = publicationFilesystem(t);
        let run;
        if (family === 'lifecycle') run = () => create(f);
        else if (family === 'group') {
            const before = readRoleplayEntity(f.scope, 'group', 'group');
            run = () => commitSingleGroupUpdate(f.scope, { operationKey: 'group', source: before, group: { ...before.data, name: 'Changed' } });
        } else {
            const group = family === 'import-group';
            const input = { operationKey: family, bytes: Buffer.from(f.records.map(JSON.stringify).join('\n')),
                originalName: 'Imported.jsonl', format: 'jsonl', userName: 'User', characterName: 'Nova',
                importAsNewInstance: !group, target: group
                    ? { group: true, groupId: 'group', source: readRoleplayEntity(f.scope, 'group', 'group') }
                    : { group: false, avatar: 'Nova.png' } };
            run = () => commitSingleChatImport(f.scope, input, roleplayNativeHost, convertImportedChatFile);
        }
        const result = run();
        const state = readRoleplayAccount(f.scope);
        assert.equal(state.pending, null);
        assert.ok(mock.renames > 0);
        for (const filename of mock.published.keys()) {
            const file = readRoleplayFile(filename);
            assert.ok(Object.values(state.resources).some(resource => resource.head?.rawHash === file.rawHash
                && JSON.stringify(resource.head.physical) === JSON.stringify(file.physical)));
        }
        const count = mock.renames;
        assert.deepEqual(run(), result);
        assert.equal(mock.renames, count);
        assert.equal(mock.descriptors.size, 0);
        readRoleplayEntity(f.scope, 'character', 'Nova.png');
    });
}

for (const fault of ['dev', 'birthtimeNs', 'path-only-inode', 'hardlink', 'size', 'bytes']) {
    test(`publication refuses ${fault} changes and preserves pending evidence`, t => {
        const f = fixture(t, false, fault);
        const filename = path.join(f.scope.directories.characters, 'Probe.png');
        const mock = publicationFilesystem(t, {
            field: ['dev', 'birthtimeNs'].includes(fault) ? fault : 'ino',
            alterStat(stat, _filename, descriptor) {
                if (fault === 'path-only-inode' && !descriptor) stat.ino++;
                if (fault === 'hardlink') stat.nlink = 2n;
                if (fault === 'size') stat.size = 3000000000n;
            },
            afterRename(target) { if (fault === 'bytes') fs.writeFileSync(target, 'tampered'); },
        });
        assert.throws(() => create(f));
        assert.equal(readRoleplayAccount(f.scope).pending.kind, 'lifecycle');
        assert.deepEqual(fs.readFileSync(filename), fault === 'bytes' ? Buffer.from('tampered') : bytes);
        assert.equal(mock.descriptors.size, 0);
        assert.throws(() => reconcilePendingChatWrite(f.scope, roleplayNativeHost));
    });
}

test('a rename that throws after publishing never grants authority to rebind', t => {
    const f = fixture(t);
    const mock = publicationFilesystem(t, { afterRename() { throw new Error('rename result uncertain'); } });
    assert.throws(() => create(f), /rename result uncertain/);
    assert.throws(() => reconcilePendingChatWrite(f.scope, roleplayNativeHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(mock.descriptors.size, 0);
    assert.equal(readRoleplayAccount(f.scope).pending.kind, 'lifecycle');
});

test('a same-byte substituted stage is refused before publication', t => {
    const f = fixture(t);
    const mock = publicationFilesystem(t);
    const open = fs.openSync;
    const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
    let replacement;
    t.mock.method(fs, 'openSync', (filename, ...args) => {
        if (!replacement && path.basename(String(filename)).startsWith('.neconyan-roleplay-') && String(filename).endsWith('.tmp')
            && JSON.parse(fs.readFileSync(statePath, 'utf8')).state.pending?.steps[0].physical) {
            replacement = String(filename);
            const copy = replacement + '.substitute';
            fs.writeFileSync(copy, fs.readFileSync(replacement));
            fs.renameSync(copy, replacement);
        }
        return open(filename, ...args);
    });
    assert.throws(() => create(f), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.ok(replacement);
    assert.equal(fs.existsSync(path.join(f.scope.directories.characters, 'Probe.png')), false);
    assert.deepEqual(fs.readFileSync(replacement), bytes);
    assert.notDeepEqual(readRoleplayFile(replacement).physical, readRoleplayAccount(f.scope).pending.steps[0].physical);
    assert.equal(mock.descriptors.size, 0);
    assert.throws(() => reconcilePendingChatWrite(f.scope, roleplayNativeHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('a same-byte destination appearing before rename is never adopted', t => {
    const f = fixture(t);
    const mock = publicationFilesystem(t);
    const open = fs.openSync;
    const target = path.join(f.scope.directories.characters, 'Probe.png');
    const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
    let substituted = false;
    t.mock.method(fs, 'openSync', (filename, ...args) => {
        const fd = open(filename, ...args);
        if (!substituted && String(filename).endsWith('.tmp') && path.basename(String(filename)).startsWith('.neconyan-roleplay-')
            && JSON.parse(fs.readFileSync(statePath, 'utf8')).state.pending?.steps[0].physical) {
            substituted = true;
            fs.writeFileSync(target, bytes);
        }
        return fd;
    });
    assert.throws(() => create(f), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(substituted, true);
    assert.equal(mock.renames, 0);
    assert.equal(mock.descriptors.size, 0);
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.throws(() => reconcilePendingChatWrite(f.scope, roleplayNativeHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

for (const alias of ['symlink-file', 'ancestor-alias']) {
    test(`publication rejects a deterministic ${alias} after rename`, t => {
        const f = fixture(t);
        const mock = publicationFilesystem(t);
        const lstat = fs.lstatSync;
        t.mock.method(fs, 'lstatSync', (filename, ...args) => {
            const stat = lstat(filename, ...args);
            if (mock.renames && (alias === 'symlink-file' ? mock.published.has(String(filename)) : String(filename) === f.scope.directories.characters)) {
                stat.isSymbolicLink = () => true;
                stat.isFile = () => false;
                stat.isDirectory = () => false;
            }
            return stat;
        });
        assert.throws(() => create(f));
        assert.equal(mock.descriptors.size, 0);
        assert.deepEqual(fs.readFileSync(path.join(f.scope.directories.characters, 'Probe.png')), bytes);
        assert.equal(readRoleplayAccount(f.scope).pending.kind, 'lifecycle');
    });
}

for (const update of [false, true]) for (const fault of ['write', 'flush', 'before-rename']) {
    test(`failed stage ${fault} preserves ${update ? 'old card' : 'vacancy'} and permits a strict retry`, t => {
        const f = fixture(t);
        const avatar = update ? 'Nova.png' : 'Probe.png';
        const target = path.join(f.scope.directories.characters, avatar);
        const originalBytes = update ? fs.readFileSync(target) : null;
        if (update) readRoleplayEntity(f.scope, 'character', avatar);
        const save = () => withRoleplayAccount(f.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
            operationKey: 'fault', action: update ? 'character-update' : 'character-create', intent: { avatar },
            steps: [{ op: update ? 'update' : 'create', kind: 'character', locator: { avatar }, bytes }],
        }));
        let injected = false;
        const mock = publicationFilesystem(t, { beforeRename(from) {
            if (fault === 'before-rename' && from.endsWith('.tmp') && path.basename(from).startsWith('.neconyan-roleplay-')) {
                injected = true;
                throw new Error('before-rename fault');
            }
        } });
        const key = fault === 'write' ? 'writeSync' : 'fsyncSync';
        const original = fs[key];
        const injection = t.mock.method(fs, key, (fd, ...args) => {
            const filename = mock.descriptors.get(fd);
            if (fault !== 'before-rename' && filename && path.basename(filename).startsWith('.neconyan-roleplay-')) {
                injected = true;
                throw Object.assign(new Error('stage fault'), { code: 'ENOSPC' });
            }
            return original(fd, ...args);
        });
        assert.throws(save);
        assert.equal(injected, true);
        assert.equal(readRoleplayAccount(f.scope).pending.kind, 'lifecycle');
        if (update) assert.deepEqual(fs.readFileSync(target), originalBytes);
        else assert.equal(fs.existsSync(target), false);
        assert.equal(mock.descriptors.size, 0);
        injection.mock.restore();
        // Restore the rename hook too; the saved stage still has its exact original identity.
        t.mock.restoreAll();
        reconcilePendingChatWrite(f.scope, roleplayNativeHost);
        assert.equal(readRoleplayAccount(f.scope).pending, null);
        assert.deepEqual(fs.readFileSync(target), bytes);
    });
}

test('same-byte destination replacement after the destination read fails the final held-file check', t => {
    const f = fixture(t);
    let replaced = false;
    const mock = publicationFilesystem(t, { alterStat(stat, _filename, descriptor) {
        if (replaced && !descriptor) stat.ino++;
    } });
    const open = fs.openSync, close = fs.closeSync;
    const destinationHandles = new Set();
    t.mock.method(fs, 'openSync', (filename, ...args) => {
        const fd = open(filename, ...args);
        if (mock.published.has(String(filename))) destinationHandles.add(fd);
        return fd;
    });
    t.mock.method(fs, 'closeSync', fd => {
        if (destinationHandles.delete(fd)) replaced = true;
        return close(fd);
    });
    assert.throws(() => create(f), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.equal(replaced, true);
    assert.equal(mock.descriptors.size, 0);
    const target = path.join(f.scope.directories.characters, 'Probe.png');
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.notEqual(readRoleplayAccount(f.scope).pending.steps[0].physical.ino, String(fs.lstatSync(target, { bigint: true }).ino));
});

test('native same-byte replacement during publication is refused by the OS or by protected verification', t => {
    const f = fixture(t);
    let replacementError, replacementSucceeded = false;
    const mock = publicationFilesystem(t, { afterRename(target) {
        const replacement = target + '.replacement';
        fs.writeFileSync(replacement, bytes);
        try { fs.renameSync(replacement, target); replacementSucceeded = true; } catch (error) { replacementError = error; }
    } });
    let failure;
    try { create(f); } catch (error) { failure = error; }
    if (replacementError) {
        assert.equal(replacementError.code, 'EPERM');
        assert.equal(replacementSucceeded, false);
        assert.equal(failure, undefined);
        assert.equal(readRoleplayAccount(f.scope).pending, null);
    } else {
        assert.equal(replacementSucceeded, true);
        assert.equal(failure?.code, 'ROLEPLAY_STORE_DAMAGED');
        assert.equal(readRoleplayAccount(f.scope).pending.kind, 'lifecycle');
    }
    assert.equal(mock.descriptors.size, 0);
    assert.deepEqual(fs.readFileSync(path.join(f.scope.directories.characters, 'Probe.png')), bytes);
});

test('repeated saves release every descriptor and keep completed identities strict', t => {
    const f = fixture(t);
    const mock = publicationFilesystem(t);
    create(f);
    const target = path.join(f.scope.directories.characters, 'Probe.png');
    for (let index = 0; index < 12; index++) {
        const next = writeCard(png, JSON.stringify({ name: 'Probe', description: String(index) }));
        withRoleplayAccount(f.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
            operationKey: `repeat-${index}`, action: 'character-update', intent: { index },
            steps: [{ op: 'update', kind: 'character', locator: { avatar: 'Probe.png' }, bytes: next }],
        }));
        assert.equal(mock.descriptors.size, 0);
        assert.equal(readRoleplayEntity(f.scope, 'character', 'Probe.png').revision, index + 2);
    }
    const replacement = target + '.replacement';
    const finalBytes = fs.readFileSync(target);
    fs.writeFileSync(replacement, finalBytes);
    fs.renameSync(replacement, target);
    assert.throws(() => readRoleplayEntity(f.scope, 'character', 'Probe.png'), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.deepEqual(fs.readFileSync(target), finalBytes);
});
