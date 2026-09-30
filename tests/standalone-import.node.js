import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import archiver from 'archiver';
import '../src/fetch-patch.js';
import { fixture, png } from './roleplay-transactions-fixture.js';
import { router as characterRouter } from '../src/endpoints/characters.js';
import { router as avatarRouter } from '../src/endpoints/avatars.js';
import { router as worldRouter } from '../src/endpoints/worldinfo.js';
import { router as chatRouter } from '../src/endpoints/chats.js';
import { read as readCard } from '../src/character-card-parser.js';

async function server(t) {
    const f = fixture(t, false, 'standalone-import');
    const avatars = path.join(f.scope.directories.root, 'avatars');
    fs.mkdirSync(avatars);
    const worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(worlds);
    const directories = { ...f.scope.directories, avatars, worlds, thumbnailsAvatar: path.join(f.root, 'thumbs'), thumbnailsAvatarMobile: path.join(f.root, 'thumbs-mobile') };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { handle: f.scope.owner }, directories };
        req.file = { destination: f.root, filename: req.body.upload, originalname: req.body.originalname ?? 'card.json' };
        next();
    });
    app.use('/characters', characterRouter);
    app.use('/avatars', avatarRouter);
    app.use('/worlds', worldRouter);
    app.use('/chats', chatRouter);
    const listener = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    t.after(() => new Promise(resolve => { listener.closeAllConnections(); listener.close(resolve); }));
    let sequence = 0;
    return { f, directories, async post(route, bytes, body = {}) {
        const upload = `upload-${sequence++}`;
        const filename = path.join(f.root, upload);
        fs.writeFileSync(filename, bytes);
        const response = await fetch(`http://127.0.0.1:${listener.address().port}${route}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, upload }),
        });
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); } catch { result = text; }
        return { status: response.status, result, filename };
    } };
}

test('concurrent imports with the same character name preserve both cards', async t => {
    const s = await server(t);
    const results = await Promise.all(['first', 'second'].map(description => s.post('/characters/import',
        JSON.stringify({ name: 'Concurrent', description }), { file_type: 'json' })));
    assert.deepEqual(results.map(row => row.status), [200, 200]);
    assert.equal(new Set(results.map(row => row.result.file_name)).size, 2);
    const descriptions = results.map(row => JSON.parse(readCard(fs.readFileSync(path.join(s.directories.characters, row.result.file_name + '.png')))).description);
    assert.deepEqual(descriptions.sort(), ['first', 'second']);
    assert.ok(results.every(row => !fs.existsSync(row.filename)));
});

test('refused character imports always remove their temporary upload', async t => {
    const s = await server(t);
    for (const body of [{ file_type: 'png' }, { file_type: 'unsupported' }, { file_type: 'constructor' },
        { file_type: 'json', preserved_name: 'Nova.png', expected_revision: 'invalid' }]) {
        const result = await s.post('/characters/import', 'broken', body);
        assert.equal(fs.existsSync(result.filename), false, JSON.stringify(body));
        assert.ok(result.status >= 400 || result.result.error === true);
    }
});

test('avatar uploads accept no crop and remove rejected image uploads', async t => {
    const s = await server(t);
    const valid = await s.post('/avatars/upload?crop=null', png);
    assert.equal(valid.status, 200);
    assert.ok(fs.existsSync(path.join(s.directories.avatars, valid.result.path)));
    const invalid = await s.post('/avatars/upload', 'not an image');
    assert.equal(invalid.status, 400);
    assert.equal(fs.existsSync(invalid.filename), false);
    assert.equal(fs.existsSync(valid.filename), false);
    const invalidName = await s.post('/avatars/upload', png, { overwrite_name: '../escape.png' });
    assert.equal(invalidName.status, 400);
    assert.equal(fs.existsSync(invalidName.filename), false);
});

test('lorebook imports accept a BOM and refuse damaged text without replacing the existing book', async t => {
    const s = await server(t);
    const book = { entries: { 0: { uid: 0, key: ['cat'], content: '猫' } } };
    const imported = await s.post('/worlds/import', '\uFEFF' + JSON.stringify(book), { name: 'Imported book' });
    assert.equal(imported.status, 200);
    const filename = path.join(s.directories.worlds, 'Imported book.json');
    const before = fs.readFileSync(filename);
    assert.deepEqual(JSON.parse(before), book);
    const invalid = await s.post('/worlds/import', Buffer.concat([
        Buffer.from('{"entries":{"0":{"content":"'), Buffer.from([0xff]), Buffer.from('"}}}'),
    ]), { name: 'Imported book' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.equal(fs.existsSync(imported.filename), false);
    assert.equal(fs.existsSync(invalid.filename), false);
});

test('a malformed persona library creates no partial pictures', async t => {
    const s = await server(t);
    const result = await s.post('/avatars/import-persona', JSON.stringify({
        personas: { 'valid.png': 'Valid', 'invalid.png': 42 }, persona_descriptions: {},
    }));
    assert.equal(result.status, 400);
    assert.deepEqual(fs.readdirSync(s.directories.avatars), []);
    assert.equal(fs.existsSync(result.filename), false);
});

test('refused chat imports remove their upload even when the avatar path is invalid', async t => {
    const s = await server(t);
    const result = await s.post('/chats/import', 'broken', { avatar_url: '../escape.png' });
    assert.equal(result.status, 400);
    assert.equal(fs.existsSync(result.filename), false);
});

test('legacy character JSON accepts a UTF-8 BOM and uses its real name for the chat', async t => {
    const s = await server(t);
    const result = await s.post('/characters/import', '\uFEFF' + JSON.stringify({ char_name: 'Legacy', char_persona: 'Original description' }), { file_type: 'json' });
    assert.equal(result.status, 200);
    const card = JSON.parse(readCard(fs.readFileSync(path.join(s.directories.characters, result.result.file_name + '.png'))));
    assert.equal(card.description, 'Original description');
    assert.ok(card.chat.startsWith('Legacy - '));
});

test('BYAF reads only the uploaded buffer slice, including small pooled uploads', async t => {
    const s = await server(t);
    const archive = archiver('zip');
    const chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    archive.append(JSON.stringify({ characters: ['character.json'] }), { name: 'manifest.json' });
    archive.append(JSON.stringify({ name: 'Pooled', persona: 'Original BYAF description' }), { name: 'character.json' });
    await archive.finalize();
    const readFile = fs.promises.readFile;
    t.mock.method(fs.promises, 'readFile', async function (filename, ...args) {
        const bytes = await readFile.call(this, filename, ...args);
        if (!String(filename).startsWith(path.join(s.f.root, 'upload-'))) return bytes;
        const pooled = Buffer.alloc(bytes.length + 256, 0xff);
        bytes.copy(pooled, 128);
        return pooled.subarray(128, 128 + bytes.length);
    });
    const result = await s.post('/characters/import', Buffer.concat(chunks), { file_type: 'byaf', user_name: 'User' });
    assert.equal(result.status, 200);
    assert.equal(result.result.file_name, 'Pooled');
    const card = JSON.parse(readCard(fs.readFileSync(path.join(s.directories.characters, 'Pooled.png'))));
    assert.equal(card.description, 'Original BYAF description');
    assert.equal(fs.existsSync(result.filename), false);
});
