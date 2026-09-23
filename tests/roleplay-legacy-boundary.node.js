import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { fixture, png, writeJournal } from './roleplay-transactions-fixture.js';
import { write as writeCard } from '../src/character-card-parser.js';
import { roleplayNativeHost } from '../src/endpoints/chats.js';
import { migrateGroupChatsMetadataFormat } from '../src/endpoints/groups.js';
import { assertRoleplaySource, readRoleplayChat } from '../src/generation/roleplay-source.js';
import { bootstrapRoleplayAccount } from '../src/roleplay-lifecycle.js';
import { readRoleplayFile, roleplayLease, roleplayPathKey, roleplayStoreDirectory, saveRoleplayAccount, withRoleplayAccountLock } from '../src/roleplay-store.js';
import { recoverFileWriteSync } from '../src/util.js';

test('legacy group migration leaves an enrolled headerless chat and its metadata intact', async t => {
    const f = fixture(t, true, 'legacy-protected-group');
    fs.writeFileSync(f.filename, [{ name: 'Legacy header' }, ...f.records.slice(1)].map(JSON.stringify).join('\n'));
    const groupFile = path.join(f.scope.directories.groups, 'group.json');
    const group = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
    group.chat_id = 'Source';
    group.chat_metadata = { note: 'old metadata' };
    fs.writeFileSync(groupFile, JSON.stringify(group));
    const source = f.source();
    const chatBefore = fs.readFileSync(f.filename);
    const groupBefore = fs.readFileSync(groupFile);
    await migrateGroupChatsMetadataFormat([f.scope.directories]);
    assert.deepEqual(fs.readFileSync(f.filename), chatBefore);
    assert.deepEqual(fs.readFileSync(groupFile), groupBefore);
    assert.equal(readRoleplayChat(f.scope, f.locator).rawHash, source.rawHash);
});

test('generic card recovery keeps newer protected bytes and the older journal', t => {
    const f = fixture(t, false, 'legacy-protected-card');
    const filename = path.join(f.scope.directories.characters, 'Nova.png');
    const journal = writeJournal({ filename });
    fs.writeFileSync(filename, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Newer card' })));
    const source = f.source();
    const before = readRoleplayFile(filename);
    const journalBefore = readRoleplayFile(journal.filename);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    assert.equal(recoverFileWriteSync(filename), false);
    assert.deepEqual(readRoleplayFile(filename), before);
    assert.deepEqual(readRoleplayFile(journal.filename), journalBefore);
    assert.doesNotThrow(() => assertRoleplaySource(f.scope, source));
});

test('character list and direct read leave an enrolled card journal untouched', async t => {
    const f = fixture(t, false, 'legacy-character-routes');
    const filename = path.join(f.scope.directories.characters, 'Nova.png');
    const journal = writeJournal({ filename });
    fs.writeFileSync(filename, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Newer protected card' })));
    const source = f.source();
    const before = readRoleplayFile(filename);
    const journalBefore = readRoleplayFile(journal.filename);
    const previousCache = process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE;
    process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE = 'false';
    const { router } = await import('../src/endpoints/characters.js');
    t.after(() => {
        if (previousCache === undefined) delete process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE;
        else process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE = previousCache;
    });
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: f.scope.owner }, directories: f.scope.directories };
        next();
    });
    app.use('/api/characters', router);
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const post = route => fetch(`http://127.0.0.1:${server.address().port}/api/characters/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar_url: 'Nova.png' }),
    });
    const list = await post('all');
    assert.equal(list.status, 200);
    assert.equal((await list.json()).find(card => card.avatar === 'Nova.png').avatar, 'Nova.png');
    const direct = await post('get');
    assert.equal(direct.status, 200);
    assert.match(JSON.stringify(await direct.json()), /Newer protected card/);
    assert.deepEqual(readRoleplayFile(filename), before);
    assert.deepEqual(readRoleplayFile(journal.filename), journalBefore);
    assert.doesNotThrow(() => assertRoleplaySource(f.scope, source));
});

test('a moved protected identity cannot be recovered through a new name', t => {
    const f = fixture(t, false, 'legacy-moved-card');
    f.source();
    const moved = path.join(f.scope.directories.characters, 'Moved.png');
    fs.renameSync(path.join(f.scope.directories.characters, 'Nova.png'), moved);
    const journal = writeJournal({ filename: moved });
    fs.writeFileSync(moved, writeCard(png, JSON.stringify({ name: 'Moved', description: 'Newer card' })));
    const before = readRoleplayFile(moved);
    assert.equal(recoverFileWriteSync(moved), false);
    assert.equal(readRoleplayFile(moved).rawHash, before.rawHash);
    assert.equal(fs.existsSync(journal.filename), true);
});

test('damaged protected evidence leaves a legacy target and journal untouched', t => {
    const f = fixture(t, false, 'legacy-damaged');
    const filename = path.join(f.scope.directories.characters, 'Nova.png');
    const journal = writeJournal({ filename });
    const before = readRoleplayFile(filename);
    fs.writeFileSync(path.join(roleplayStoreDirectory(f.scope), 'state.json'), '{damaged');
    assert.equal(recoverFileWriteSync(filename), false);
    assert.equal(readRoleplayFile(filename).rawHash, before.rawHash);
    assert.equal(fs.existsSync(journal.filename), true);
});

test('a recorded deletion is not recreated from an old journal', t => {
    const f = fixture(t, false, 'legacy-deleted');
    const source = f.source();
    const journal = writeJournal({ filename: f.filename });
    fs.unlinkSync(f.filename);
    withRoleplayAccountLock(f.scope, lease => {
        const { state } = roleplayLease(lease);
        state.resources[source.instanceId].status = 'deleted';
        state.paths[roleplayPathKey(state, 'chat', f.locator)].instanceId = null;
        saveRoleplayAccount(lease);
    });
    assert.equal(recoverFileWriteSync(f.filename), false);
    assert.equal(fs.existsSync(f.filename), false);
    assert.equal(fs.existsSync(journal.filename), true);
});

test('untracked card recovery and group metadata migration still work', async t => {
    const f = fixture(t, false, 'legacy-untracked');
    const card = path.join(f.scope.directories.characters, 'Other.png');
    fs.writeFileSync(card, writeCard(png, JSON.stringify({ name: 'Other', description: 'Original' })));
    const journal = writeJournal({ filename: card });
    fs.writeFileSync(card, writeCard(png, JSON.stringify({ name: 'Other', description: 'Interrupted' })));
    assert.equal(recoverFileWriteSync(card), true);
    assert.equal(readRoleplayFile(card).rawHash, journal.record.originalHash);
    assert.equal(fs.existsSync(journal.filename), false);

    const groupFile = path.join(f.scope.directories.groups, 'plain.json');
    const chatFile = path.join(f.scope.directories.groupChats, 'Plain.jsonl');
    fs.writeFileSync(groupFile, JSON.stringify({ id: 'plain', chat_id: 'Plain', chats: ['Plain'], chat_metadata: { note: 'move me' } }));
    fs.writeFileSync(chatFile, JSON.stringify({ name: 'Old header' }));
    await migrateGroupChatsMetadataFormat([f.scope.directories]);
    assert.equal(JSON.parse(fs.readFileSync(groupFile, 'utf8')).chat_metadata, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(chatFile, 'utf8').split('\n')[0]).chat_metadata, { note: 'move me' });
});
