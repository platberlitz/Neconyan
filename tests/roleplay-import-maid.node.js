import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';
import { readRoleplayChat, readRoleplayEntity, ROLEPLAY_METADATA_KEY } from '../src/generation/roleplay-source.js';
import { write as writeCard } from '../src/character-card-parser.js';
import { readRoleplayAccount, resetRoleplayAccount, roleplayAccountStamp, roleplayPathKey } from '../src/roleplay-store.js';
import { importUserFile } from '../src/endpoints/users-private.js';
import { deleteDataMaidFiles } from '../src/endpoints/data-maid.js';

const jsonl = records => Buffer.from(records.map(row => JSON.stringify(row)).join('\n'));
const slot = (f, kind, locator) => {
    const state = readRoleplayAccount(f.scope);
    return state.paths[roleplayPathKey(state, kind, locator)];
};

test('imports replace tracked chats and cards with recorded writes', async t => {
    const f = fixture(t, false, 'import-tracked');
    const before = readRoleplayChat(f.scope, f.locator);
    const card = readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const imported = structuredClone(f.records);
    imported[0].chat_metadata[ROLEPLAY_METADATA_KEY] = { schema: 1, instanceId: crypto.randomUUID(), revision: 9, writeId: crypto.randomUUID() };
    imported.push({ name: 'Nova', is_user: false, mes: 'Imported' });
    assert.equal(importUserFile(f.scope, f.filename, jsonl(imported)), true);
    const after = readRoleplayChat(f.scope, f.locator);
    assert.equal(after.instanceId, before.instanceId);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.records.at(-1).mes, 'Imported');
    const cardFile = path.join(f.scope.directories.characters, 'Nova.png');
    assert.equal(importUserFile(f.scope, cardFile, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Imported' }))), true);
    const updated = readRoleplayEntity(f.scope, 'character', 'Nova.png');
    assert.equal(updated.instanceId, card.instanceId);
    assert.equal(updated.revision, card.revision + 1);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('imports refuse damaged replacements for tracked files and keep the current file', async t => {
    const f = fixture(t, false, 'import-damaged');
    readRoleplayChat(f.scope, f.locator);
    const bytes = fs.readFileSync(f.filename);
    assert.equal(importUserFile(f.scope, f.filename, Buffer.from('not json')), false);
    assert.deepEqual(fs.readFileSync(f.filename), bytes);
});

test('imports new chats through recorded writes without foreign markers and recreates retired paths', async t => {
    const f = fixture(t, false, 'import-untracked');
    const target = path.join(f.scope.directories.chats, 'Nova', 'Other.jsonl');
    const imported = structuredClone(f.records);
    imported[0].chat_metadata[ROLEPLAY_METADATA_KEY] = { schema: 1, instanceId: crypto.randomUUID(), revision: 1, writeId: crypto.randomUUID() };
    assert.equal(importUserFile(f.scope, target, jsonl(imported)), true);
    const written = JSON.parse(fs.readFileSync(target, 'utf8').split('\n')[0]);
    const newChat = readRoleplayChat(f.scope, { group: false, chat: 'Other', avatar: 'Nova.png' });
    assert.equal(written.chat_metadata[ROLEPLAY_METADATA_KEY].instanceId, newChat.instanceId);
    assert.notEqual(newChat.instanceId, imported[0].chat_metadata[ROLEPLAY_METADATA_KEY].instanceId);
    assert.equal(newChat.revision, 1);

    readRoleplayChat(f.scope, f.locator);
    deleteDataMaidFiles(f.scope, [f.filename]);
    assert.equal(fs.existsSync(f.filename), false);
    assert.equal(slot(f, 'chat', f.locator).instanceId, null);
    assert.equal(importUserFile(f.scope, f.filename, jsonl(f.records)), true);
    const recreated = slot(f, 'chat', f.locator);
    assert.equal(recreated.generation, 2);
    assert.equal(readRoleplayChat(f.scope, f.locator).instanceId, recreated.instanceId);
});

test('first-time card and group imports create protected identities before returning', t => {
    const f = fixture(t, false, 'import-first');
    const card = path.join(f.scope.directories.characters, 'New.png');
    const group = path.join(f.scope.directories.groups, 'new-group.json');
    assert.equal(importUserFile(f.scope, card, writeCard(png, JSON.stringify({ name: 'New', description: 'Imported' }))), true);
    assert.equal(importUserFile(f.scope, group, Buffer.from(JSON.stringify({ id: 'new-group', members: ['New.png'], chats: [] }))), true);
    const cardIdentity = readRoleplayEntity(f.scope, 'character', 'New.png');
    const groupIdentity = readRoleplayEntity(f.scope, 'group', 'new-group');
    assert.equal(slot(f, 'character', { avatar: 'New.png' }).instanceId, cardIdentity.instanceId);
    assert.equal(slot(f, 'group', { groupId: 'new-group' }).instanceId, groupIdentity.instanceId);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('Data Maid deletes tracked files through a recorded lifecycle and untracked files directly', async t => {
    const f = fixture(t, false, 'maid');
    const chat = readRoleplayChat(f.scope, f.locator);
    const stray = path.join(f.scope.directories.chats, 'Nova', 'Stray.jsonl');
    fs.writeFileSync(stray, jsonl(f.records));
    const ordinary = path.join(f.scope.directories.backups, 'old.bak');
    fs.writeFileSync(ordinary, 'x');
    deleteDataMaidFiles(f.scope, [f.filename, stray, ordinary]);
    for (const file of [f.filename, stray, ordinary]) assert.equal(fs.existsSync(file), false);
    const state = readRoleplayAccount(f.scope);
    assert.equal(state.resources[chat.instanceId].status, 'deleted');
    assert.equal(state.pending, null);
});

test('Data Maid refuses a tracked chat changed out of band and keeps it', async t => {
    const f = fixture(t, false, 'maid-changed');
    readRoleplayChat(f.scope, f.locator);
    fs.appendFileSync(f.filename, '\n' + JSON.stringify({ name: 'User', is_user: true, mes: 'late' }));
    assert.throws(() => deleteDataMaidFiles(f.scope, [f.filename]), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(fs.existsSync(f.filename), true);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('retiring and restoring a bundled card goes through recorded lifecycles', async t => {
    const { archiveRetiredContent, restoreRetiredContent, getRetiredContentHash } = await import('../src/endpoints/content-manager.js');
    const f = fixture(t, false, 'retire');
    fs.rmSync(path.join(f.scope.directories.groups, 'group.json'));
    fs.rmSync(path.join(f.scope.directories.chats, 'Nova'), { recursive: true });
    const card = readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const file = path.join(f.scope.directories.characters, 'Nova.png');
    const filename = 'characters/Nova.png';
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    const item = { stableName: 'nova', filename, filenameHash: digest(filename), type: 'character', hashes: [getRetiredContentHash(file)] };
    fs.writeFileSync(path.join(f.scope.directories.root, 'content.log'), `${filename}\n`);
    const archived = archiveRetiredContent(f.scope.directories, ['nova'], [item]);
    assert.equal(archived.results[0].ok, true, JSON.stringify(archived));
    assert.equal(fs.existsSync(file), false);
    assert.equal(readRoleplayAccount(f.scope).resources[card.instanceId].status, 'deleted');
    const record = JSON.parse(fs.readFileSync(path.join(f.scope.directories.backups, '_neconyan-retired-content', 'index.json'), 'utf8')).records[0];
    const restored = restoreRetiredContent(f.scope.directories, record.id, [item]);
    assert.equal(restored.name, 'Nova.png');
    const again = slot(f, 'character', { avatar: 'Nova.png' });
    assert.equal(again.generation, 2);
    assert.notEqual(again.instanceId, card.instanceId);
    assert.equal(readRoleplayEntity(f.scope, 'character', 'Nova.png').instanceId, again.instanceId);
});

test('Data Maid deletes names the store cannot track as ordinary files and refuses a report from an earlier epoch', async t => {
    const f = fixture(t, false, 'maid-untrackable');
    const odd = path.join(f.scope.directories.chats, 'Nova', 'odd?name.jsonl');
    fs.writeFileSync(odd, fs.readFileSync(f.filename));
    deleteDataMaidFiles(f.scope, [odd]);
    assert.equal(fs.existsSync(odd), false);

    const stamp = roleplayAccountStamp(f.scope);
    resetRoleplayAccount(f.scope, null, 'reset');
    const loose = path.join(f.scope.directories.root, 'loose.txt');
    fs.writeFileSync(loose, 'kept');
    assert.throws(() => deleteDataMaidFiles(f.scope, [loose], stamp), error => error.code === 'ROLEPLAY_ACCOUNT_CHANGED');
    assert.equal(fs.existsSync(loose), true);
});
