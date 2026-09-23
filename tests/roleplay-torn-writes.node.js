import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { readRoleplayEntity } = await import('../src/generation/roleplay-source.js');
const { readRoleplayAccount, withRoleplayAccount } = await import('../src/roleplay-store.js');
const { bootstrapRoleplayAccount, commitRoleplayLifecycleLocked, commitSingleGroupUpdate } = await import('../src/roleplay-lifecycle.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');

/** Fails the `nth` write to a matching file descriptor, as a full disk would. */
function failWrite(t, matches, nth = 1) {
    const original = fs.writeSync;
    let count = 0;
    fs.writeSync = function (fd, ...rest) {
        let hit = false;
        try { hit = matches(fs.fstatSync(fd)); } catch { /* not a file descriptor we track */ }
        if (hit && ++count === nth) {
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        }
        return original.call(fs, fd, ...rest);
    };
    const restore = () => { fs.writeSync = original; };
    t.after(restore);
    return restore;
}

const lifecycle = (f, key, op, avatar, bytes) => withRoleplayAccount(f.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
    operationKey: key, action: `character-${op}`, intent: { avatar }, steps: [{ op, kind: 'character', locator: { avatar }, bytes }] }));

test('a failed card update leaves its previous bytes intact and finishes at startup', t => {
    const f = fixture(t, false, 'torn-update');
    const card = path.join(f.scope.directories.characters, 'Nova.png');
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const original = fs.readFileSync(card);
    const bytes = writeCard(png, JSON.stringify({ name: 'Nova', description: 'Edited '.repeat(200) }));
    const restore = failWrite(t, () => fs.readdirSync(f.scope.directories.characters).some(name => name.endsWith('.tmp')));
    assert.throws(() => lifecycle(f, 'edit', 'update', 'Nova.png', bytes), error => error.code === 'ENOSPC' && error.roleplayWritePending);
    restore();
    assert.deepEqual(fs.readFileSync(card), original);
    assert.equal(readRoleplayAccount(f.scope).pending.kind, 'lifecycle');
    bootstrapRoleplayAccount({ owner: 'torn-update', directories: f.scope.directories }, roleplayNativeHost);
    assert.deepEqual(fs.readFileSync(card), bytes);
    assert.notDeepEqual(fs.readFileSync(card), original);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    assert.equal(lifecycle(f, 'edit', 'update', 'Nova.png', bytes).action, 'character-update');
});

test('a card create that fails part-way never leaves a partial card', t => {
    const f = fixture(t, false, 'torn-create');
    const target = path.join(f.scope.directories.characters, 'Fresh.png');
    const bytes = writeCard(png, JSON.stringify({ name: 'Fresh', description: 'New' }));
    const restore = failWrite(t, () => fs.readdirSync(f.scope.directories.characters).some(name => name.endsWith('.tmp')));
    assert.throws(() => lifecycle(f, 'create', 'create', 'Fresh.png', bytes), error => error.roleplayWritePending);
    restore();
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(lifecycle(f, 'create', 'create', 'Fresh.png', bytes).action, 'character-create');
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.deepEqual(fs.readdirSync(f.scope.directories.characters).filter(name => name.endsWith('.tmp')), []);
});

test('a failed group update leaves its previous bytes intact and finishes at startup', t => {
    const f = fixture(t, true, 'torn-group');
    const groupFile = path.join(f.scope.directories.groups, 'group.json');
    const before = readRoleplayEntity(f.scope, 'group', 'group');
    const original = fs.readFileSync(groupFile);
    const group = { ...before.data, name: 'Edited group '.repeat(50) };
    const source = { instanceId: before.instanceId, revision: before.revision, rawHash: before.rawHash };
    const restore = failWrite(t, () => fs.readdirSync(f.scope.directories.groups).some(name => name.endsWith('.tmp')));
    assert.throws(() => commitSingleGroupUpdate(f.scope, { operationKey: 'edit', source, group }), error => error.roleplayWritePending);
    restore();
    assert.deepEqual(fs.readFileSync(groupFile), original);
    bootstrapRoleplayAccount({ owner: 'torn-group', directories: f.scope.directories }, roleplayNativeHost);
    assert.equal(JSON.parse(fs.readFileSync(groupFile, 'utf8')).name, group.name);
    assert.notDeepEqual(fs.readFileSync(groupFile), original);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});
