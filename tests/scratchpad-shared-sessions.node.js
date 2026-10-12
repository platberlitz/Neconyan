import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { withRoleplayAccountLock } from '../src/roleplay-store.js';
import { readRoleplayChat } from '../src/generation/roleplay-source.js';
import { AUTHORING_FILE_LIMIT } from '../src/authoring-store.js';
import * as store from '../src/scratchpad/store.js';

const legacy = chat => ({ kind: 'roleplay', key: `character:Nova.png:${chat}`, label: chat });
const shared = chat => ({ ...legacy(chat), scope: { kind: 'character', id: 'Nova.png' } });
const read = (f, source) => withRoleplayAccountLock(f.scope, lease => store.readBucketLocked(lease, source));
const mutate = (f, source, change) => withRoleplayAccountLock(f.scope, lease => {
    const bucket = store.readBucketLocked(lease, source);
    const result = change(bucket);
    store.writeBucketLocked(lease, bucket);
    return result;
});
const seed = (f, source, name) => mutate(f, source, bucket => store.createSession(bucket, { name,
    settings: { picked: ['0'], depth: 7 }, messages: [{ role: 'user', text: 'A saved thought.' }] }).id);

test('all chats and Conversation branches for a character share sessions and the active selection', t => {
    const f = fixture(t);
    const first = seed(f, legacy('First'), 'First ideas');
    const second = seed(f, legacy('Second'), 'Second ideas');
    const conversation = { kind: 'conversation', key: 'conversation:persona:User%3Aone:Nova.png:main', label: 'Main' };
    const third = seed(f, conversation, 'Conversation ideas');
    const before = fs.readFileSync(store.scratchpadFile(f.scope.directories.root, legacy('First')));
    assert.deepEqual(new Set(read(f, shared('Third')).sessions.map(session => session.id)), new Set([first, second, third]));
    assert.deepEqual(fs.readFileSync(store.scratchpadFile(f.scope.directories.root, legacy('First'))), before);
    mutate(f, shared('Third'), bucket => store.activateSession(bucket, first));
    assert.equal(read(f, { ...conversation, scope: shared('').scope }).activeSessionId, first);
    const fresh = seed(f, shared('Third'), 'Character ideas');
    assert.equal(read(f, shared('Fourth')).activeSessionId, fresh);
    mutate(f, shared('Fourth'), bucket => store.updateSession(bucket, first, { name: 'Revised ideas' }));
    assert.equal(read(f, legacy('First')).sessions[0].name, 'Revised ideas');
    mutate(f, shared('Fourth'), bucket => store.deleteSession(bucket, second));
    assert.equal(read(f, shared('First')).sessions.some(session => session.id === second), false);
    assert.equal(fs.existsSync(store.scratchpadFile(f.scope.directories.root, legacy('Second'))), false);
});

test('permanent Roleplay identities and old filename aliases are included without duplicating sessions', t => {
    const f = fixture(t);
    const id = readRoleplayChat(f.scope, f.locator).instanceId;
    const oldId = seed(f, legacy('Source'), 'Legacy ideas');
    const source = { kind: 'roleplay', key: `roleplay:${id}`, legacyKey: legacy('Source').key, scope: shared('').scope };
    const bucket = read(f, source);
    assert.deepEqual(bucket.sessions.map(session => session.id), [oldId]);
    assert.equal(bucket.sessions[0].messages[0].contextSource.key, source.key);
    assert.equal(bucket.sessions[0].settings.pickedSource.key, source.key);
    mutate(f, legacy('Source'), current => {
        current.sessions[0].messages.push({ id: 'pending', role: 'assistant', state: 'done', text: 'Finished after switching chats.' });
    });
    assert.equal(read(f, shared('Other')).sessions[0].messages.at(-1).text, 'Finished after switching chats.');
});

test('unbound permanent chat buckets are found through their character ownership', t => {
    const f = fixture(t);
    const id = readRoleplayChat(f.scope, f.locator).instanceId;
    const source = { kind: 'roleplay', key: `roleplay:${id}`, label: 'Permanent' };
    const sessionId = seed(f, source, 'Permanent ideas');
    assert.equal(read(f, shared('Other')).sessions[0].id, sessionId);
});

test('other characters, groups, notes and accounts stay separate', t => {
    const f = fixture(t), other = fixture(t);
    seed(f, shared('Source'), 'Nova ideas');
    seed(f, { kind: 'roleplay', key: 'group:group:First' }, 'Group ideas');
    seed(f, { kind: 'conversation', key: 'conversation:persona:User:group:group:Kit.png:main' }, 'Group Conversation ideas');
    seed(f, { kind: 'notebook', key: 'notebook:book:note' }, 'Note ideas');
    assert.equal(read(f, { ...shared('Source'), scope: { kind: 'character', id: 'Kit.png' } }).sessions.length, 0);
    assert.equal(read(other, shared('Source')).sessions.length, 0);
    const group = read(f, { kind: 'roleplay', key: 'group:group:Other', scope: { kind: 'group', id: 'group' } });
    assert.deepEqual(new Set(group.sessions.map(session => session.name)), new Set(['Group ideas', 'Group Conversation ideas']));
    assert.equal(read(f, shared('Source')).sessions.length, 1);
});

test('more than forty existing sessions remain available and writable without silent truncation', t => {
    const f = fixture(t);
    for (const chat of ['First', 'Second']) {
        mutate(f, legacy(chat), bucket => {
            for (let i = 0; i < 25; i++) store.createSession(bucket, { name: `${chat} ${i}` });
        });
    }
    assert.equal(read(f, shared('Other')).sessions.length, 50);
    assert.throws(() => mutate(f, shared('Other'), current => store.createSession(current)), { code: 'SCRATCHPAD_SESSION_LIMIT' });
    mutate(f, shared('Other'), current => store.updateSession(current, current.sessions[0].id, { name: 'Still editable' }));
    assert.equal(read(f, shared('Other')).sessions.length, 50);
    assert.equal(read(f, shared('Other')).sessions.some(session => session.name === 'Still editable'), true);
});

for (const enabled of [false, true]) {
    test(`a shared file just below its byte limit keeps every session with cleanup ${enabled ? 'on' : 'off'}`, t => {
        const f = fixture(t);
        const old = seed(f, shared('First'), 'Older ideas');
        const active = seed(f, shared('First'), 'Current ideas');
        const storage = { kind: 'roleplay', key: 'shared:character:Nova.png', label: '' };
        withRoleplayAccountLock(f.scope, lease => store.updateCleanupLocked(lease, { enabled, keep: 40 }));
        mutate(f, shared('Other'), bucket => {
            const session = bucket.sessions.find(item => item.id === active);
            session.messages = Array.from({ length: 16 }, (_, index) => ({
                id: `long-${index}`, role: 'assistant', state: 'done', created: session.created,
                text: index < 15 ? 'x'.repeat(store.MAX_MESSAGE_BYTES) : '',
            }));
            const bytes = Buffer.byteLength(JSON.stringify({ ...bucket, cleanup: undefined, source: storage }, null, 2) + '\n');
            session.messages.at(-1).text = 'x'.repeat(AUTHORING_FILE_LIMIT - 16 - bytes);
        });
        const saved = read(f, shared('Other'));
        assert.deepEqual(new Set(saved.sessions.map(session => session.id)), new Set([old, active]));
        assert.equal(saved.sessions.find(session => session.id === active).messages.length, 16);
        assert.equal(fs.statSync(store.scratchpadFile(f.scope.directories.root, storage)).size, AUTHORING_FILE_LIMIT - 16);
    });
}

test('cleanup applies to the combined list while protecting active and pending sessions', t => {
    const f = fixture(t);
    const active = seed(f, legacy('First'), 'Active');
    const pending = seed(f, legacy('Second'), 'Pending');
    mutate(f, legacy('Second'), bucket => bucket.sessions[0].messages.push({ id: 'reply', role: 'assistant', state: 'pending', text: '' }));
    seed(f, legacy('Third'), 'Old');
    withRoleplayAccountLock(f.scope, lease => store.updateCleanupLocked(lease, { enabled: true, keep: 1 }));
    mutate(f, shared('Other'), bucket => store.activateSession(bucket, active));
    const kept = read(f, shared('Other')).sessions.map(session => session.id);
    assert.ok(kept.includes(active));
    assert.ok(kept.includes(pending));
});

test('a reply accepted by an older client cannot clean up the shared active session', t => {
    const f = fixture(t);
    const active = seed(f, legacy('First'), 'Active');
    const pending = seed(f, legacy('First'), 'Pending');
    mutate(f, legacy('First'), bucket => bucket.sessions.find(session => session.id === pending).messages.push({ id: 'reply', role: 'assistant', state: 'pending', text: '' }));
    withRoleplayAccountLock(f.scope, lease => store.updateCleanupLocked(lease, { enabled: true, keep: 1 }));
    mutate(f, shared('Other'), bucket => store.activateSession(bucket, active));
    mutate(f, legacy('First'), bucket => {
        const session = bucket.sessions.find(session => session.id === pending);
        session.messages.at(-1).state = 'done';
        session.updated = new Date(Date.now() + 1000).toISOString();
    });
    const kept = read(f, shared('Other')).sessions.map(session => session.id);
    assert.ok(kept.includes(active));
    assert.ok(kept.includes(pending));
});

test('earlier per-chat cleanup needs fresh consent before pruning combined sessions', t => {
    const f = fixture(t);
    seed(f, legacy('First'), 'First');
    seed(f, legacy('Second'), 'Second');
    seed(f, legacy('Third'), 'Third');
    const filename = path.join(f.scope.directories.root, 'scratchpad', 'cleanup.json');
    const previous = JSON.stringify({ version: 1, enabled: true, keep: 1 });
    fs.writeFileSync(filename, previous);
    assert.deepEqual(read(f, shared('Other')).cleanup, { enabled: false, keep: 1 });
    mutate(f, shared('Other'), () => {});
    assert.equal(read(f, shared('Other')).sessions.length, 3);
    assert.equal(fs.readFileSync(filename, 'utf8'), previous);
    withRoleplayAccountLock(f.scope, lease => store.updateCleanupLocked(lease, { enabled: true }));
    mutate(f, shared('Other'), () => {});
    assert.equal(read(f, shared('Other')).sessions.length, 1);
});

test('damaged identity metadata preserves the original files', t => {
    const f = fixture(t);
    seed(f, legacy('First'), 'First');
    const file = store.scratchpadFile(f.scope.directories.root, legacy('First'));
    const before = fs.readFileSync(file);
    fs.writeFileSync(path.join(f.scope.directories.root, 'scratchpad', 'identities.json'), '{damaged');
    assert.throws(() => read(f, shared('Other')), { code: 'SCRATCHPAD_DAMAGED' });
    assert.deepEqual(fs.readFileSync(file), before);
});
