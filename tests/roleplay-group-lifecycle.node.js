import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';
import { readRoleplayChat, readRoleplayEntity } from '../src/generation/roleplay-source.js';
import { router as groupRouter } from '../src/endpoints/groups.js';
import { readRoleplayAccount, roleplayPathKey } from '../src/roleplay-store.js';

async function groupServer(t, f) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { profile: { handle: f.scope.owner }, directories: f.scope.directories }; next(); });
    app.use('/api/groups', groupRouter);
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}/api/groups`;
    return async (route, body) => {
        const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* status-only responses */ }
        return { status: response.status, body: json };
    };
}

const slot = (f, kind, locator) => {
    const state = readRoleplayAccount(f.scope);
    return state.paths[roleplayPathKey(state, kind, locator)];
};

test('a group create is recorded and a replay returns the same group', async t => {
    const f = fixture(t, true, 'group-create');
    const post = await groupServer(t, f);
    const body = { name: 'Crew', members: ['Nova.png'], chats: [], chat_id: '', roleplay: { operationKey: 'create-1' } };
    const first = await post('/create', body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const id = first.body.id;
    const file = path.join(f.scope.directories.groups, `${id}.json`);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'Crew');
    assert.equal(first.body.__roleplay.source.revision, 1);
    assert.equal(readRoleplayEntity(f.scope, 'group', id).instanceId, first.body.__roleplay.source.instanceId);
    const replay = await post('/create', body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, id);
    assert.equal(fs.readdirSync(f.scope.directories.groups).filter(name => name !== 'group.json').length, 1);
    const conflict = await post('/create', { ...body, name: 'Different' });
    assert.equal(conflict.body.code, 'ROLEPLAY_INTENT_CONFLICT');
});

test('a protected group delete retires the group and its tracked chats and replays by key', async t => {
    const f = fixture(t, true, 'group-delete');
    const post = await groupServer(t, f);
    const group = readRoleplayEntity(f.scope, 'group', 'group');
    const chat = readRoleplayChat(f.scope, f.locator);
    // An untracked chat listed by the group is discarded with it.
    const untracked = path.join(f.scope.directories.groupChats, 'New.jsonl');
    fs.writeFileSync(untracked, fs.readFileSync(f.filename));
    const body = { id: 'group', roleplay: { operationKey: 'drop-1' } };
    const first = await post('/delete', body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.roleplay.result.action, 'group-delete');
    for (const file of [f.filename, untracked, path.join(f.scope.directories.groups, 'group.json')]) assert.equal(fs.existsSync(file), false, file);
    const state = readRoleplayAccount(f.scope);
    assert.equal(state.pending, null);
    assert.equal(state.resources[group.instanceId].status, 'deleted');
    assert.equal(state.resources[chat.instanceId].status, 'deleted');
    assert.deepEqual(slot(f, 'group', { groupId: 'group' }), { generation: 1, instanceId: null });
    const replay = await post('/delete', body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.roleplay.result, first.body.roleplay.result);
});

test('a group delete refuses an out-of-band edit and keeps every file', async t => {
    const f = fixture(t, true, 'group-changed');
    const post = await groupServer(t, f);
    readRoleplayEntity(f.scope, 'group', 'group');
    readRoleplayChat(f.scope, f.locator);
    fs.appendFileSync(f.filename, '\n{"name":"Nova","mes":"outside"}');
    const result = await post('/delete', { id: 'group', roleplay: { operationKey: 'drop-2' } });
    assert.equal(result.body.code, 'ROLEPLAY_SOURCE_CHANGED');
    assert.equal(fs.existsSync(f.filename), true);
    assert.equal(fs.existsSync(path.join(f.scope.directories.groups, 'group.json')), true);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('an untracked group still deletes through the legacy path', async t => {
    const f = fixture(t, true, 'group-legacy');
    const post = await groupServer(t, f);
    const result = await post('/delete', { id: 'group' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(fs.existsSync(path.join(f.scope.directories.groups, 'group.json')), false);
    assert.equal(fs.existsSync(f.filename), false);
});
