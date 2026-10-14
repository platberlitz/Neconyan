import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { roleplayLease, saveRoleplayAccount, withRoleplayAccountLock } from '../src/roleplay-store.js';
import { readRoleplayChat } from '../src/generation/roleplay-source.js';
import { AUTHORING_FILE_LIMIT } from '../src/authoring-store.js';
import { forgetSharedScratchpadsLocked, moveSharedScratchpadsLocked } from '../src/scratchpad/shared-sessions.js';
import * as store from '../src/scratchpad/store.js';

const legacy = chat => ({ kind: 'roleplay', key: `character:Nova.png:${chat}`, label: chat });
const shared = chat => ({ ...legacy(chat), scope: { kind: 'character', id: 'Nova.png' } });
const legacyChat = source => source.kind === 'roleplay' && !source.scope && /^(character|group):/.test(source.key);
const read = (f, source) => withRoleplayAccountLock(f.scope, lease => legacyChat(source)
    ? store.readChatBucketLocked(lease, source) : store.readBucketLocked(lease, source));
const mutate = (f, source, change) => withRoleplayAccountLock(f.scope, lease => {
    const direct = legacyChat(source);
    const bucket = direct ? store.readChatBucketLocked(lease, source) : store.readBucketLocked(lease, source);
    const result = change(bucket);
    if (direct) store.writeChatBucketLocked(lease, bucket);
    else store.writeBucketLocked(lease, bucket);
    return result;
});
const seed = (f, source, name) => mutate(f, source, bucket => store.createSession(bucket, { name,
    settings: { picked: ['0'], depth: 7 }, messages: [{ role: 'user', text: 'A saved thought.' }] }).id);

test('General never merges into chat, group, Conversation or Notebook lists, even with a selected card', t => {
    const f = fixture(t);
    const general = { kind: 'general', key: 'general', label: 'General Scratchpad', avatar: 'Nova.png', contextMode: 'roleplay', personaId: 'User.png' };
    const id = seed(f, general, 'General ideas');
    for (const source of [shared('Source'), { kind: 'conversation', key: 'conversation:Nova.png:main', scope: { kind: 'character', id: 'Nova.png' } },
        { kind: 'roleplay', key: 'group:group:Other', scope: { kind: 'group', id: 'group' } }, { kind: 'notebook', key: 'notebook:book:note' }]) {
        assert.equal(read(f, source).sessions.length, 0);
        seed(f, source, 'Other ideas');
        assert.equal(read(f, source).sessions.some(session => session.id === id), false);
    }
    const plain = { kind: 'general', key: 'general' };
    assert.deepEqual(read(f, plain).sessions.map(session => session.id), [id]);
    assert.deepEqual(read(f, { ...general, avatar: 'Kit.png' }).sessions.map(session => session.id), [id]);
});

test('Roleplay and Conversation sessions share only within their own character and persona space', t => {
    const f = fixture(t);
    const first = seed(f, legacy('First'), 'First ideas');
    const second = seed(f, legacy('Second'), 'Second ideas');
    const personaOne = { kind: 'conversation', key: 'conversation:persona:User%3Aone:Nova.png:main', label: 'Main', scope: { kind: 'character', id: 'Nova.png' } };
    const personaOneBranch = { ...personaOne, key: 'conversation:persona:User%3Aone:Nova.png:branch-two' };
    const personaTwo = { ...personaOne, key: 'conversation:persona:User%3Atwo:Nova.png:main' };
    const noPersona = { ...personaOne, key: 'conversation:Nova.png:main' };
    const third = seed(f, personaOne, 'Persona one ideas');
    const fourth = seed(f, personaOneBranch, 'Persona one branch ideas');
    const fifth = seed(f, personaTwo, 'Persona two ideas');
    const sixth = seed(f, noPersona, 'No persona ideas');
    const before = fs.readFileSync(store.scratchpadFile(f.scope.directories.root, legacy('First')));
    assert.deepEqual(new Set(read(f, shared('Third')).sessions.map(session => session.id)), new Set([first, second]));
    assert.deepEqual(new Set(read(f, personaOne).sessions.map(session => session.id)), new Set([third, fourth]));
    assert.deepEqual(read(f, personaTwo).sessions.map(session => session.id), [fifth]);
    assert.deepEqual(read(f, noPersona).sessions.map(session => session.id), [sixth]);
    assert.deepEqual(fs.readFileSync(store.scratchpadFile(f.scope.directories.root, legacy('First'))), before);
    mutate(f, shared('Third'), bucket => store.activateSession(bucket, first));
    assert.equal(read(f, personaOne).activeSessionId, fourth);
    const fresh = seed(f, shared('Third'), 'Character ideas');
    assert.equal(read(f, shared('Fourth')).activeSessionId, fresh);
    mutate(f, shared('Fourth'), bucket => store.updateSession(bucket, first, { name: 'Revised ideas' }));
    assert.equal(read(f, shared('First')).sessions.find(session => session.id === first).name, 'Revised ideas');
    mutate(f, shared('Fourth'), bucket => store.deleteSession(bucket, second));
    assert.equal(read(f, shared('First')).sessions.some(session => session.id === second), false);
    assert.equal(fs.existsSync(store.scratchpadFile(f.scope.directories.root, legacy('Second'))), false);
});

test('the server derives character and persona ownership instead of trusting a different client scope', t => {
    const f = fixture(t);
    const identity = readRoleplayChat(f.scope, f.locator).instanceId;
    const roleplaySource = { kind: 'roleplay', key: `roleplay:${identity}`, scope: { kind: 'character', id: 'Kit.png' } };
    const roleplayId = seed(f, roleplaySource, 'Nova roleplay');
    const roleplayBucket = read(f, roleplaySource);
    assert.deepEqual(roleplayBucket.source.scope, { kind: 'character', id: 'Nova.png' });
    assert.equal(roleplayBucket.sessions[0].id, roleplayId);
    const conversation = { kind: 'conversation', key: 'conversation:persona:User%3Aone:Nova.png:main', scope: { kind: 'character', id: 'Kit.png' } };
    const conversationId = seed(f, conversation, 'Nova conversation');
    assert.equal(read(f, conversation).sessions[0].id, conversationId);
    assert.deepEqual(read(f, conversation).source.scope, { kind: 'character', id: 'Nova.png' });
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

test('deleted permanent chat identities do not share sessions with a recreated character', t => {
    const f = fixture(t);
    const id = readRoleplayChat(f.scope, f.locator).instanceId;
    const source = { kind: 'roleplay', key: `roleplay:${id}` };
    const sessionId = withRoleplayAccountLock(f.scope, lease => {
        const bucket = store.readChatBucketLocked(lease, source);
        const session = store.createSession(bucket, { name: 'Old character ideas' });
        store.writeChatBucketLocked(lease, bucket);
        return session.id;
    });
    withRoleplayAccountLock(f.scope, lease => {
        const { state } = roleplayLease(lease);
        state.resources[id].status = 'deleted';
        saveRoleplayAccount(lease);
    });
    assert.equal(read(f, shared('New character chat')).sessions.some(session => session.id === sessionId), false);
});

test('other characters, groups, notes and accounts stay separate', t => {
    const f = fixture(t), other = fixture(t);
    seed(f, shared('Source'), 'Nova ideas');
    seed(f, { kind: 'roleplay', key: 'group:group:First' }, 'Group ideas');
    seed(f, { kind: 'conversation', key: 'conversation:persona:User:group:group:Kit.png:main', scope: { kind: 'group', id: 'group' } }, 'Group Conversation ideas');
    seed(f, { kind: 'notebook', key: 'notebook:book:note' }, 'Note ideas');
    const forged = read(f, { ...shared('Source'), scope: { kind: 'character', id: 'Kit.png' } });
    assert.equal(forged.sessions.length, 1);
    assert.deepEqual(forged.source.scope, { kind: 'character', id: 'Nova.png' });
    assert.equal(read(f, { kind: 'roleplay', key: 'character:Kit.png:Source', scope: { kind: 'character', id: 'Kit.png' } }).sessions.length, 0);
    assert.equal(read(other, shared('Source')).sessions.length, 0);
    const group = read(f, { kind: 'roleplay', key: 'group:group:Other', scope: { kind: 'group', id: 'group' } });
    assert.deepEqual(new Set(group.sessions.map(session => session.name)), new Set(['Group ideas']));
    const conversationGroup = read(f, { kind: 'conversation', key: 'conversation:persona:User:group:group:Kit.png:main', scope: { kind: 'group', id: 'group' } });
    assert.deepEqual(conversationGroup.sessions.map(session => session.name), ['Group Conversation ideas']);
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

test('reserved shared and selection sources are rejected from client input but remain readable in stored messages', t => {
    for (const key of ['shared:character:Nova.png', 'selection:character:Nova.png']) {
        assert.throws(() => store.normaliseSource({ kind: 'roleplay', key }), { code: 'SCRATCHPAD_SOURCE_INVALID' });
        assert.throws(() => store.normaliseSettings({ pickedSource: { kind: 'roleplay', key } }), { code: 'SCRATCHPAD_SOURCE_INVALID' });
    }
    const f = fixture(t);
    const source = legacy('Internal');
    const id = seed(f, source, 'Internal source tags');
    const file = store.scratchpadFile(f.scope.directories.root, source);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.sessions[0].settings.pickedSource = { kind: 'roleplay', key: 'shared:conversation:persona:character:Nova.png', label: '' };
    parsed.sessions[0].messages[0].contextSource = { kind: 'roleplay', key: 'selection:character:Nova.png', label: '' };
    fs.writeFileSync(file, JSON.stringify(parsed));
    const bucket = read(f, source);
    assert.equal(bucket.sessions.find(session => session.id === id).settings.pickedSource.key, 'shared:conversation:persona:character:Nova.png');
    assert.equal(bucket.sessions.find(session => session.id === id).messages[0].contextSource.key, 'selection:character:Nova.png');
});

test('a damaged non-canonical shard is skipped with a filename warning', t => {
    const f = fixture(t);
    const sessionId = seed(f, legacy('Source'), 'Readable ideas');
    const filename = path.join(f.scope.directories.root, 'scratchpad', `${'a'.repeat(40)}.json`);
    fs.writeFileSync(filename, '{damaged');
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    try {
        assert.equal(read(f, shared('Other')).sessions[0].id, sessionId);
    } finally { console.warn = original; }
    assert.ok(warnings.some(warning => warning.includes(filename)));
});

test('damaged canonical shared and selection files still fail rather than being skipped', t => {
    const f = fixture(t);
    const canonical = { kind: 'roleplay', key: 'shared:character:Nova.png' };
    const selection = { kind: 'roleplay', key: 'selection:character:Nova.png' };
    for (const source of [canonical, selection]) {
        const filename = store.scratchpadFile(f.scope.directories.root, source);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, '{damaged');
        assert.throws(() => read(f, shared('Other')), { code: 'SCRATCHPAD_DAMAGED' });
        fs.unlinkSync(filename);
    }
});

test('a write to another session does not persist old origin tags', t => {
    const f = fixture(t);
    const id = readRoleplayChat(f.scope, f.locator).instanceId;
    const oldSession = seed(f, legacy('Source'), 'Older session');
    const laterSession = seed(f, legacy('Source'), 'Later session');
    const stable = { kind: 'roleplay', key: `roleplay:${id}`, legacyKey: legacy('Source').key, scope: shared('').scope };
    withRoleplayAccountLock(f.scope, lease => {
        const bucket = store.readBucketLocked(lease, stable);
        const old = bucket.sessions.find(session => session.id === oldSession);
        assert.equal(old.messages[0].contextSource.key, stable.key);
        store.updateSession(bucket, laterSession, { name: 'Updated later session' });
        store.writeBucketLocked(lease, bucket);
        assert.equal(old.messages[0].contextSource.key, stable.key);
    });
    const saved = JSON.parse(fs.readFileSync(store.scratchpadFile(f.scope.directories.root, legacy('Source')), 'utf8'));
    assert.equal(saved.sessions.find(session => session.id === oldSession).messages[0].contextSource, undefined);
    assert.equal(saved.sessions.find(session => session.id === oldSession).settings.pickedSource, undefined);
});

test('shared roleplay files move on rename and are removed on delete', t => {
    const f = fixture(t);
    seed(f, shared('Source'), 'Shared ideas');
    const root = f.scope.directories.root;
    const oldShared = store.scratchpadFile(root, { kind: 'roleplay', key: 'shared:character:Nova.png' });
    const newShared = store.scratchpadFile(root, { kind: 'roleplay', key: 'shared:character:Star.png' });
    const oldSelection = store.scratchpadFile(root, { kind: 'roleplay', key: 'selection:character:Nova.png' });
    const newSelection = store.scratchpadFile(root, { kind: 'roleplay', key: 'selection:character:Star.png' });
    withRoleplayAccountLock(f.scope, lease => moveSharedScratchpadsLocked(lease, { kind: 'character', from: 'Nova.png', to: 'Star.png' }));
    assert.equal(fs.existsSync(oldShared), false);
    assert.equal(JSON.parse(fs.readFileSync(newShared, 'utf8')).source.key, 'shared:character:Star.png');
    assert.equal(fs.existsSync(oldSelection), false);
    assert.equal(fs.existsSync(newSelection), true);
    withRoleplayAccountLock(f.scope, lease => forgetSharedScratchpadsLocked(lease, { kind: 'character', id: 'Star.png' }));
    assert.equal(fs.existsSync(newShared), false);
    assert.equal(fs.existsSync(newSelection), false);
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
