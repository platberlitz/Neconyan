import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';
import { readRoleplayChat } from '../src/generation/roleplay-source.js';
import { commitRoleplayLifecycleLocked, reconcilePendingChatWrite } from '../src/roleplay-lifecycle.js';
import { router as chatRouter, roleplayNativeHost } from '../src/endpoints/chats.js';
import { readRoleplayAccount, readRoleplayFile, roleplayPathKey, withRoleplayAccountLock } from '../src/roleplay-store.js';

async function chatServer(t, f) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { profile: { handle: f.scope.owner }, directories: f.scope.directories }; next(); });
    app.use('/api/chats', chatRouter);
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}/api/chats`;
    return async (route, body) => {
        const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* status-only responses */ }
        return { status: response.status, body: json };
    };
}

const slot = (f, locator) => {
    const state = readRoleplayAccount(f.scope);
    return state.paths[roleplayPathKey(state, 'chat', locator)];
};

for (const group of [false, true]) {
    const label = group ? 'group' : 'solo';

    test(`${label}: a protected chat delete is recorded, retires the path and replays by key`, async t => {
        const f = fixture(t, group, `delete-${label}`);
        const post = await chatServer(t, f);
        const saved = readRoleplayChat(f.scope, f.locator);
        const route = group ? '/group/delete' : '/delete';
        const body = group ? { id: 'Source', roleplay: { operationKey: 'del-1' } }
            : { chatfile: 'Source.jsonl', avatar_url: 'Nova.png', roleplay: { operationKey: 'del-1' } };
        const first = await post(route, body);
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(first.body.roleplay.result.action, 'chat-delete');
        assert.equal(fs.existsSync(f.filename), false);
        const state = readRoleplayAccount(f.scope);
        assert.equal(state.pending, null);
        assert.equal(state.resources[saved.instanceId].status, 'deleted');
        assert.deepEqual(slot(f, f.locator), { generation: 1, instanceId: null });
        // Replaying the same request never recreates or re-deletes anything.
        const replay = await post(route, body);
        assert.equal(replay.status, 200);
        assert.deepEqual(replay.body.roleplay.result, first.body.roleplay.result);
        // The same key for different work conflicts; an unkeyed repeat finds nothing live.
        const other = group ? { id: 'Other', roleplay: { operationKey: 'del-1' } }
            : { chatfile: 'Other.jsonl', avatar_url: 'Nova.png', roleplay: { operationKey: 'del-1' } };
        assert.equal((await post(route, other)).body.code, 'ROLEPLAY_INTENT_CONFLICT');
        const again = await post(route, { ...body, roleplay: undefined });
        assert.equal(again.status, 404);
    });

    test(`${label}: a protected rename moves the same file and its identity`, async t => {
        const f = fixture(t, group, `rename-${label}`);
        const post = await chatServer(t, f);
        const saved = readRoleplayChat(f.scope, f.locator);
        const inode = fs.statSync(f.filename).ino;
        const body = { original_file: 'Source.jsonl', renamed_file: 'Renamed.jsonl', is_group: group,
            avatar_url: group ? undefined : 'Nova.png', roleplay: { operationKey: 'mv-1' } };
        const first = await post('/rename', body);
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(first.body.sanitizedFileName, 'Renamed');
        const renamed = path.join(path.dirname(f.filename), 'Renamed.jsonl');
        assert.equal(fs.existsSync(f.filename), false);
        assert.equal(fs.statSync(renamed).ino, inode);
        const destination = { ...f.locator, chat: 'Renamed' };
        assert.deepEqual(slot(f, f.locator), { generation: 1, instanceId: null });
        assert.deepEqual(slot(f, destination), { generation: 1, instanceId: saved.instanceId });
        const reread = readRoleplayChat(f.scope, destination);
        assert.equal(reread.instanceId, saved.instanceId);
        assert.equal(reread.rawHash, saved.rawHash);
        assert.equal((await post('/rename', body)).status, 200);
        assert.equal(fs.statSync(renamed).ino, inode);
    });

    test(`${label}: rename refuses an occupied name and a changed source keeps evidence`, async t => {
        const f = fixture(t, group, `refuse-${label}`);
        const post = await chatServer(t, f);
        readRoleplayChat(f.scope, f.locator);
        const occupied = path.join(path.dirname(f.filename), 'Taken.jsonl');
        fs.writeFileSync(occupied, fs.readFileSync(f.filename));
        const body = { original_file: 'Source.jsonl', renamed_file: 'Taken.jsonl', is_group: group, avatar_url: group ? undefined : 'Nova.png' };
        assert.equal((await post('/rename', body)).body.code, 'ROLEPLAY_TARGET_EXISTS');
        fs.appendFileSync(f.filename, '\n{"name":"Outside","mes":"edit"}');
        const changed = await post('/rename', { ...body, renamed_file: 'Free.jsonl' });
        assert.equal(changed.body.code, 'ROLEPLAY_SOURCE_CHANGED');
        assert.match(fs.readFileSync(f.filename, 'utf8'), /Outside/);
        assert.equal(readRoleplayAccount(f.scope).pending, null);
    });
}

test('an untracked legacy chat keeps the ordinary delete and rename paths', async t => {
    const f = fixture(t, false, 'legacy-lifecycle');
    const post = await chatServer(t, f);
    assert.equal((await post('/rename', { original_file: 'Source.jsonl', renamed_file: 'Moved.jsonl', avatar_url: 'Nova.png' })).body.sanitizedFileName, 'Moved');
    assert.equal((await post('/delete', { chatfile: 'Moved.jsonl', avatar_url: 'Nova.png' })).body.ok, true);
    assert.equal(fs.readdirSync(path.dirname(f.filename)).length, 0);
    assert.equal(Object.keys(readRoleplayAccount(f.scope).paths).length, 0);
});

test('a protected rename records the stable chat identity before moving', async t => {
    const f = fixture(t, false, 'identity-lifecycle');
    const post = await chatServer(t, f);
    readRoleplayChat(f.scope, f.locator);
    const result = await post('/rename', { original_file: 'Source.jsonl', renamed_file: 'Stamped.jsonl', avatar_url: 'Nova.png',
        chat_id_hash: 1234, roleplay: { operationKey: 'stamp' } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const moved = readRoleplayChat(f.scope, { ...f.locator, chat: 'Stamped' });
    assert.equal(moved.records[0].chat_metadata.chat_id_hash, 1234);
    assert.equal(moved.revision, 2);
});

test('an interrupted lifecycle finishes on reconciliation without repeating file work', t => {
    const f = fixture(t, false, 'interrupted-lifecycle');
    readRoleplayChat(f.scope, f.locator);
    const failing = { ...roleplayNativeHost, clearDeferred: () => { throw Object.assign(new Error('crash'), { code: 'EIO' }); } };
    assert.throws(() => withRoleplayAccountLock(f.scope, lease => commitRoleplayLifecycleLocked(lease, {
        operationKey: 'crash', action: 'chat-delete', intent: { locator: f.locator },
        steps: [{ op: 'delete', kind: 'chat', locator: f.locator }],
        auxiliary: [{ task: 'chat-memory-remove', locator: f.locator }],
    }, failing)), error => error.roleplayWritePending === true);
    assert.equal(fs.existsSync(f.filename), false);
    assert.equal(readRoleplayAccount(f.scope).pending.phase, 'prepared');
    const result = reconcilePendingChatWrite(f.scope, roleplayNativeHost);
    assert.equal(result.action, 'chat-delete');
    const state = readRoleplayAccount(f.scope);
    assert.equal(state.pending, null);
    assert.equal(Object.values(state.submissions).at(-1).state, 'closed');
    assert.equal(readRoleplayFile(f.filename, 1024, { allowMissingParent: true }), null);
});
