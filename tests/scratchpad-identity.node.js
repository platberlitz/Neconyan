import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { readRoleplayChat } from '../src/generation/roleplay-source.js';
import { commitRoleplayLifecycleLocked, commitSingleChatWrite, reconcilePendingChatWrite } from '../src/roleplay-lifecycle.js';
import express from 'express';
import { roleplayNativeHost, router as chatsRouter } from '../src/endpoints/chats.js';
import { readRoleplayAccount, withRoleplayAccountLock } from '../src/roleplay-store.js';
import * as store from '../src/scratchpad/store.js';

const legacySource = (f, groupId = 'group', chat = f.locator.chat) => ({ kind: 'roleplay',
    key: f.locator.group ? `group:${groupId}:${chat}` : `character:${f.locator.avatar}:${chat}`, label: chat });
const stableSource = (id, legacy, groupId = '') => ({ kind: 'roleplay',
    key: `roleplay:${id}${groupId ? `:group:${groupId}` : ''}`, legacyKey: legacy.key, label: legacy.label });
const read = (f, source) => withRoleplayAccountLock(f.scope, lease => store.readBucketLocked(lease, source));
const seed = (f, source, name = 'Kept planning') => withRoleplayAccountLock(f.scope, lease => {
    const bucket = store.readBucketLocked(lease, source);
    const session = store.createSession(bucket, { name, settings: { depth: 7, notes: [{ notebookId: 'nb', noteId: 'note' }] },
        messages: [{ role: 'user', text: 'An existing thought.' }] });
    session.messages.push({ id: 'reply', role: 'assistant', state: 'done', text: 'An existing answer.', reasoning: 'Private reasoning.',
        proposals: { 0: 'applied' }, notebookProposals: { 1: { id: `p_${'a'.repeat(24)}`, changeHash: 'b'.repeat(64) } } });
    store.writeBucketLocked(lease, bucket);
    return session.id;
});
const move = (f, from, chat, operationKey = `rename:${chat}`, host = roleplayNativeHost) => withRoleplayAccountLock(f.scope, lease =>
    commitRoleplayLifecycleLocked(lease, { operationKey, action: 'chat-rename', intent: { from, chat },
        steps: [{ op: 'move', kind: 'chat', locator: from, destination: { ...from, chat } }] }, host));

for (const group of [false, true]) {
    const label = group ? 'group' : 'solo';
    test(`${label}: a stable chat adopts its old Scratchpad without moving or rewriting it`, t => {
        const f = fixture(t, group, `scratchpad-adopt-${label}`);
        const id = readRoleplayChat(f.scope, f.locator).instanceId;
        const legacy = legacySource(f);
        const sessionId = seed(f, legacy);
        const filename = store.scratchpadFile(f.scope.directories.root, legacy);
        const before = fs.readFileSync(filename);
        const source = stableSource(id, legacy, group ? 'group' : '');
        const adopted = read(f, source);
        assert.equal(adopted.source.key, source.key);
        assert.equal(adopted.activeSessionId, sessionId);
        assert.equal(adopted.sessions[0].messages[1].reasoning, 'Private reasoning.');
        assert.deepEqual(adopted.sessions[0].messages[1].notebookProposals, { 1: { id: `p_${'a'.repeat(24)}`, changeHash: 'b'.repeat(64) } });
        assert.deepEqual(fs.readFileSync(filename), before);
        assert.equal(fs.existsSync(store.scratchpadFile(f.scope.directories.root, source)), false);
        withRoleplayAccountLock(f.scope, lease => {
            const bucket = store.readBucketLocked(lease, source);
            store.updateSession(bucket, sessionId, { name: 'Still the same session' });
            store.writeBucketLocked(lease, bucket);
        });
        assert.equal(read(f, legacy).sessions[0].name, 'Still the same session');
        assert.equal(JSON.parse(fs.readFileSync(filename)).source.key, legacy.key);
    });

    test(`${label}: renaming before opening the updated Scratchpad preserves sessions and old-name reuse stays separate`, t => {
        const f = fixture(t, group, `scratchpad-rename-${label}`);
        const originalId = readRoleplayChat(f.scope, f.locator).instanceId;
        const legacy = legacySource(f);
        const sessionId = seed(f, legacy);
        move(f, f.locator, 'Renamed');
        const renamed = { ...f.locator, chat: 'Renamed' };
        assert.equal(readRoleplayChat(f.scope, renamed).instanceId, originalId);
        const source = stableSource(originalId, legacySource(f, 'group', 'Renamed'), group ? 'group' : '');
        assert.equal(read(f, source).activeSessionId, sessionId);
        assert.equal(read(f, source).sessions[0].settings.depth, 7);
        // A new physical chat may use the old name, but must never adopt the old planning.
        const replacementId = commitSingleChatWrite(f.scope, { operationKey: 'reuse-old-name', sourceKind: 'storage',
            mode: 'create', destination: f.locator, expectedVacancy: 1, records: f.records, backup: { deferBackup: true } }, roleplayNativeHost).instanceId;
        assert.notEqual(replacementId, originalId);
        const replacement = stableSource(replacementId, legacy, group ? 'group' : '');
        assert.equal(read(f, replacement).sessions.length, 0);
        seed(f, replacement, 'New chat planning');
        assert.equal(read(f, replacement).sessions[0].name, 'New chat planning');
        assert.equal(read(f, source).sessions[0].name, 'Kept planning');
        move(f, renamed, 'Renamed again');
        const twice = stableSource(originalId, legacySource(f, 'group', 'Renamed again'), group ? 'group' : '');
        assert.equal(read(f, twice).activeSessionId, sessionId);
    });
}

test('groups sharing one chat file keep their separate Scratchpads through a rename', t => {
    const f = fixture(t, true, 'scratchpad-groups');
    fs.writeFileSync(path.join(f.scope.directories.groups, 'Other group.json'), JSON.stringify({ id: 'Other group', chats: ['Source'] }));
    const id = readRoleplayChat(f.scope, f.locator).instanceId;
    const firstId = seed(f, legacySource(f), 'First group planning');
    const secondId = seed(f, legacySource(f, 'Other group'), 'Other group planning');
    move(f, f.locator, 'Renamed');
    const first = stableSource(id, legacySource(f, 'group', 'Renamed'), 'group');
    const second = stableSource(id, legacySource(f, 'Other group', 'Renamed'), 'Other group');
    assert.notEqual(first.key, second.key);
    assert.equal(read(f, first).activeSessionId, firstId);
    assert.equal(read(f, second).activeSessionId, secondId);
});

test('Scratchpad identity is durable before an interrupted rename and survives reconciliation', t => {
    const f = fixture(t, false, 'scratchpad-interrupted');
    const id = readRoleplayChat(f.scope, f.locator).instanceId;
    const legacy = legacySource(f);
    const sessionId = seed(f, legacy);
    const before = fs.readFileSync(store.scratchpadFile(f.scope.directories.root, legacy));
    const failing = { ...roleplayNativeHost, clearDeferred: () => { throw Object.assign(new Error('interrupted'), { code: 'EIO' }); } };
    assert.throws(() => move(f, f.locator, 'Renamed', 'interrupted', failing), error => error.roleplayWritePending === true);
    assert.ok(readRoleplayAccount(f.scope).pending);
    assert.ok(fs.existsSync(path.join(f.scope.directories.root, 'scratchpad', 'identities.json')));
    assert.deepEqual(fs.readFileSync(store.scratchpadFile(f.scope.directories.root, legacy)), before);
    reconcilePendingChatWrite(f.scope, roleplayNativeHost);
    assert.equal(read(f, stableSource(id, legacySource(f, 'group', 'Renamed'))).activeSessionId, sessionId);
});

test('an existing canonical Scratchpad wins over a legacy candidate and accounts stay isolated', t => {
    const f = fixture(t, false, 'scratchpad-canonical');
    const id = readRoleplayChat(f.scope, f.locator).instanceId;
    const legacy = legacySource(f);
    const source = stableSource(id, legacy);
    const canonicalId = seed(f, { kind: 'roleplay', key: source.key, label: 'New format' }, 'Canonical planning');
    seed(f, legacy, 'Legacy planning');
    assert.equal(read(f, source).activeSessionId, canonicalId);
    move(f, f.locator, 'Renamed');
    assert.equal(read(f, stableSource(id, legacySource(f, 'group', 'Renamed'))).activeSessionId, canonicalId);
    const other = fixture(t, false, 'scratchpad-other');
    assert.equal(read(other, source).sessions.length, 0);
});

// The rename route answers a damaged Scratchpad file with the file's own explanation, and writes nothing.
async function renameThroughRoute(f, to) {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: f.scope.owner }, directories: f.scope.directories };
        next();
    });
    app.use('/api/chats', chatsRouter);
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chats/rename`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar_url: f.locator.avatar, original_file: `${f.locator.chat}.jsonl`, renamed_file: `${to}.jsonl`,
                is_group: false, roleplay: { operationKey: `rename-route:${to}` } }) });
        return { status: response.status, body: await response.json() };
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

for (const [damage, spoil, message] of [
    ['identity registry', f => fs.writeFileSync(path.join(f.scope.directories.root, 'scratchpad', 'identities.json'), '{damaged'),
        'Scratchpad\'s saved chat identities could not be read. The original files were kept.'],
    ['session file', (f, legacy) => fs.writeFileSync(store.scratchpadFile(f.scope.directories.root, legacy), '{damaged'),
        'This Scratchpad file could not be read.'],
]) {
    test(`a damaged Scratchpad ${damage} makes the rename route say so and change nothing`, async t => {
        const f = fixture(t, false, 'scratchpad-damaged-route');
        readRoleplayChat(f.scope, f.locator);
        const legacy = legacySource(f);
        seed(f, legacy);
        const before = fs.readFileSync(f.filename);
        spoil(f, legacy);
        const { status, body } = await renameThroughRoute(f, 'Renamed');
        assert.equal(status, 422);
        assert.deepEqual(body, { error: 'scratchpad_damaged', code: 'SCRATCHPAD_DAMAGED', message });
        assert.deepEqual(fs.readFileSync(f.filename), before);
        assert.equal(fs.existsSync(path.join(path.dirname(f.filename), 'Renamed.jsonl')), false);
        assert.equal(readRoleplayAccount(f.scope).pending, null);
    });
}

test('a damaged identity registry refuses a rename without changing either file', t => {
    const f = fixture(t, false, 'scratchpad-damaged-identity');
    readRoleplayChat(f.scope, f.locator);
    const legacy = legacySource(f);
    seed(f, legacy);
    const before = fs.readFileSync(f.filename);
    const registry = path.join(f.scope.directories.root, 'scratchpad', 'identities.json');
    fs.writeFileSync(registry, '{damaged');
    assert.throws(() => move(f, f.locator, 'Renamed'), error => error.code === 'SCRATCHPAD_DAMAGED');
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.equal(fs.readFileSync(registry, 'utf8'), '{damaged');
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});
