import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { fixture, png } from './roleplay-transactions-fixture.js';
import { readRoleplayChat, readRoleplayEntity } from '../src/generation/roleplay-source.js';
import { router as characterRouter } from '../src/endpoints/characters.js';
import { write as writeCard } from '../src/character-card-parser.js';
import { readRoleplayAccount, roleplayPathKey } from '../src/roleplay-store.js';
import { bootstrapRoleplayAccount } from '../src/roleplay-lifecycle.js';
import { roleplayNativeHost } from '../src/endpoints/chats.js';

const v2 = { name: 'Nova', description: 'Original', personality: '', scenario: '', first_mes: '', mes_example: '' };
v2.spec = 'chara_card_v2';
v2.spec_version = '2.0';
v2.data = { ...v2, creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '', extensions: {} };
delete v2.data.spec;
delete v2.data.spec_version;

async function characterServer(t, f) {
    fs.writeFileSync(path.join(f.scope.directories.characters, 'Nova.png'), writeCard(png, JSON.stringify(v2)));
    const directories = { ...f.scope.directories, thumbnailsAvatar: path.join(f.root, 'thumbs'), thumbnailsAvatarMobile: path.join(f.root, 'thumbs-mobile') };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { profile: { handle: f.scope.owner }, directories }; next(); });
    app.use('/api/characters', characterRouter);
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}/api/characters`;
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

test('card edits and duplicates are recorded lifecycle writes', async t => {
    const f = fixture(t, false, 'character-edit');
    const post = await characterServer(t, f);
    const before = readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const edit = await post('/edit-attribute', { avatar_url: 'Nova.png', ch_name: 'Nova', field: 'description', value: 'Changed' });
    assert.equal(edit.status, 200);
    const after = readRoleplayEntity(f.scope, 'character', 'Nova.png');
    assert.equal(after.instanceId, before.instanceId);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.data.data.description, 'Changed');
    const duplicate = await post('/duplicate', { avatar_url: 'Nova.png' });
    assert.equal(duplicate.body.path, 'Nova_1.png');
    const copy = slot(f, 'character', { avatar: 'Nova_1.png' });
    assert.equal(readRoleplayAccount(f.scope).resources[copy.instanceId].revision, 1);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('a character rename moves the card and its protected chats with their identities', async t => {
    const f = fixture(t, false, 'character-rename');
    const post = await characterServer(t, f);
    const chat = readRoleplayChat(f.scope, f.locator);
    const inode = fs.statSync(f.filename).ino;
    const renamed = await post('/rename', { avatar_url: 'Nova.png', new_name: 'Star' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.avatar, 'Star.png');
    const moved = path.join(f.scope.directories.chats, 'Star', 'Source.jsonl');
    assert.equal(fs.existsSync(path.join(f.scope.directories.characters, 'Nova.png')), false);
    assert.equal(fs.existsSync(path.join(f.scope.directories.chats, 'Nova')), false);
    assert.equal(fs.statSync(moved).ino, inode);
    const destination = { group: false, chat: 'Source', avatar: 'Star.png' };
    assert.equal(readRoleplayChat(f.scope, destination).instanceId, chat.instanceId);
    assert.equal(readRoleplayEntity(f.scope, 'character', 'Star.png').data.data.name, 'Star');
    assert.equal(slot(f, 'character', { avatar: 'Nova.png' }).instanceId, null);
    assert.equal(slot(f, 'chat', f.locator).instanceId, null);
});

test('a character delete retires the card and chats, and refuses out-of-band chat edits', async t => {
    const f = fixture(t, false, 'character-delete');
    const post = await characterServer(t, f);
    const chat = readRoleplayChat(f.scope, f.locator);
    fs.appendFileSync(f.filename, '\n{"name":"Nova","mes":"outside"}');
    const refused = await post('/delete', { avatar_url: 'Nova.png', delete_chats: true });
    assert.equal(refused.body.code, 'ROLEPLAY_SOURCE_CHANGED');
    assert.equal(fs.existsSync(f.filename), true);
    assert.equal(fs.existsSync(path.join(f.scope.directories.characters, 'Nova.png')), true);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
    fs.rmSync(f.filename);
    fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
    // A replaced inode is still an out-of-band change.
    assert.equal((await post('/delete', { avatar_url: 'Nova.png', delete_chats: true })).body.code, 'ROLEPLAY_SOURCE_CHANGED');
    fs.rmSync(f.filename);
    const deleted = await post('/delete', { avatar_url: 'Nova.png', delete_chats: true });
    assert.equal(deleted.status, 200);
    const state = readRoleplayAccount(f.scope);
    assert.equal(state.resources[chat.instanceId].status, 'deleted');
    assert.equal(fs.existsSync(path.join(f.scope.directories.characters, 'Nova.png')), false);
    assert.equal(fs.existsSync(path.join(f.scope.directories.chats, 'Nova')), false);
});

test('a conditional character delete refuses a card that changed after it was checked', async t => {
    const f = fixture(t, false, 'character-conditional-delete');
    const post = await characterServer(t, f);
    const card = path.join(f.scope.directories.characters, 'Nova.png');
    const checked = crypto.createHash('sha256').update(fs.readFileSync(card)).digest('hex');
    const invalid = await post('/delete', { avatar_url: 'Nova.png', delete_chats: false, expected_revision: 'nope' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'ROLEPLAY_CHARACTER_REVISION_INVALID');
    assert.equal((await post('/edit-attribute', { avatar_url: 'Nova.png', ch_name: 'Nova', field: 'description', value: 'Later edit' })).status, 200);
    const refused = await post('/delete', { avatar_url: 'Nova.png', delete_chats: false, expected_revision: checked });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'ROLEPLAY_CHARACTER_CHANGED');
    assert.equal(readRoleplayEntity(f.scope, 'character', 'Nova.png').data.data.description, 'Later edit');
    const current = crypto.createHash('sha256').update(fs.readFileSync(card)).digest('hex');
    const deleted = await post('/delete', { avatar_url: 'Nova.png', delete_chats: false, expected_revision: current });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(fs.existsSync(card), false);
});

test('a rename retires a vanished protected chat, and a delete removes hard-linked loose chats', async t => {
    const f = fixture(t, false, 'character-loose');
    const post = await characterServer(t, f);
    const chat = readRoleplayChat(f.scope, f.locator);
    fs.rmSync(f.filename);
    const renamed = await post('/rename', { avatar_url: 'Nova.png', new_name: 'Star' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(readRoleplayAccount(f.scope).resources[chat.instanceId].status, 'deleted');
    const loose = path.join(f.scope.directories.chats, 'Star', 'Loose.jsonl');
    fs.mkdirSync(path.dirname(loose), { recursive: true });
    fs.writeFileSync(loose, f.records.map(row => JSON.stringify(row)).join('\n'));
    fs.linkSync(loose, path.join(f.root, 'alias.jsonl'));
    const deleted = await post('/delete', { avatar_url: 'Star.png', delete_chats: true });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(fs.existsSync(loose), false);
    assert.equal(fs.existsSync(path.join(f.scope.directories.characters, 'Star.png')), false);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('loose file removal cannot fail after a protected character rename has closed', async t => {
    const f = fixture(t, false, 'character-loose-interrupted');
    const post = await characterServer(t, f);
    const loose = path.join(f.scope.directories.characters, 'Nova.png');
    fs.linkSync(loose, path.join(f.root, 'untracked-alias.png'));
    const original = fs.unlinkSync;
    let failed = false;
    fs.unlinkSync = function (name, ...args) {
        if (!failed && name === loose) {
            failed = true;
            throw Object.assign(new Error('interrupted loose-file cleanup'), { code: 'EIO' });
        }
        return original.call(fs, name, ...args);
    };
    try {
        const response = await post('/rename', { avatar_url: 'Nova.png', new_name: 'Star' });
        assert.equal(response.status, 503);
    } finally { fs.unlinkSync = original; }
    assert.equal(fs.existsSync(loose), true);
    assert.equal(readRoleplayAccount(f.scope).pending?.kind, 'lifecycle');
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    assert.equal(fs.existsSync(loose), false);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});
