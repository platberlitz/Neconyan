import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';
import { readRoleplayChat, readRoleplayEntity, ROLEPLAY_METADATA_KEY } from '../src/generation/roleplay-source.js';
import { write as writeCard } from '../src/character-card-parser.js';
import { readRoleplayAccount, roleplayPathKey, withRoleplayAccount } from '../src/roleplay-store.js';
import { importTestFile } from './application-import-fixture.js';
import { commitRoleplayLifecycleLocked } from '../src/roleplay-lifecycle.js';

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
    assert.equal((await importTestFile(f.scope, f.filename, jsonl(imported))).state, 'completed');
    const after = readRoleplayChat(f.scope, f.locator);
    assert.equal(after.instanceId, before.instanceId);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.records.at(-1).mes, 'Imported');
    const cardFile = path.join(f.scope.directories.characters, 'Nova.png');
    assert.equal((await importTestFile(f.scope, cardFile, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Imported' })))).state, 'completed');
    const updated = readRoleplayEntity(f.scope, 'character', 'Nova.png');
    assert.equal(updated.instanceId, card.instanceId);
    assert.equal(updated.revision, card.revision + 1);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('imports skip damaged replacements for tracked files and keep the current file', async t => {
    const f = fixture(t, false, 'import-damaged');
    readRoleplayChat(f.scope, f.locator);
    const bytes = fs.readFileSync(f.filename);
    const record = await importTestFile(f.scope, f.filename, Buffer.from('not json'));
    assert.equal(record.state, 'completed');
    assert.equal(record.result.skippedCount, 1);
    assert.match(record.result.skipped[0].reason, /Line 1 of the chat file is not valid JSON/);
    assert.deepEqual(fs.readFileSync(f.filename), bytes);
});

test('imports new chats through recorded writes without foreign markers and recreates retired paths', async t => {
    const f = fixture(t, false, 'import-untracked');
    const target = path.join(f.scope.directories.chats, 'Nova', 'Other.jsonl');
    const imported = structuredClone(f.records);
    imported[0].chat_metadata[ROLEPLAY_METADATA_KEY] = { schema: 1, instanceId: crypto.randomUUID(), revision: 1, writeId: crypto.randomUUID() };
    assert.equal((await importTestFile(f.scope, target, jsonl(imported))).state, 'completed');
    const written = JSON.parse(fs.readFileSync(target, 'utf8').split('\n')[0]);
    const newChat = readRoleplayChat(f.scope, { group: false, chat: 'Other', avatar: 'Nova.png' });
    assert.equal(written.chat_metadata[ROLEPLAY_METADATA_KEY].instanceId, newChat.instanceId);
    assert.notEqual(newChat.instanceId, imported[0].chat_metadata[ROLEPLAY_METADATA_KEY].instanceId);
    assert.equal(newChat.revision, 1);

    readRoleplayChat(f.scope, f.locator);
    withRoleplayAccount(f.scope, f.scope, lease => commitRoleplayLifecycleLocked(lease, {
        operationKey: 'before-import', action: 'chat-delete', intent: { locator: f.locator },
        steps: [{ op: 'delete', kind: 'chat', locator: f.locator }],
    }));
    assert.equal(fs.existsSync(f.filename), false);
    assert.equal(slot(f, 'chat', f.locator).instanceId, null);
    assert.equal((await importTestFile(f.scope, f.filename, jsonl(f.records))).state, 'completed');
    const recreated = slot(f, 'chat', f.locator);
    assert.equal(recreated.generation, 2);
    assert.equal(readRoleplayChat(f.scope, f.locator).instanceId, recreated.instanceId);
});

test('first-time card and group imports create protected identities before returning', async t => {
    const f = fixture(t, false, 'import-first');
    const card = path.join(f.scope.directories.characters, 'New.png');
    const group = path.join(f.scope.directories.groups, 'new-group.json');
    assert.equal((await importTestFile(f.scope, card, writeCard(png, JSON.stringify({ name: 'New', description: 'Imported' })))).state, 'completed');
    assert.equal((await importTestFile(f.scope, group, Buffer.from(JSON.stringify({ id: 'new-group', members: ['New.png'], chats: [] })))).state, 'completed');
    const cardIdentity = readRoleplayEntity(f.scope, 'character', 'New.png');
    const groupIdentity = readRoleplayEntity(f.scope, 'group', 'new-group');
    assert.equal(slot(f, 'character', { avatar: 'New.png' }).instanceId, cardIdentity.instanceId);
    assert.equal(slot(f, 'group', { groupId: 'new-group' }).instanceId, groupIdentity.instanceId);
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
