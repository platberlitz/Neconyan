import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import multer from 'multer';
import { fixture, png } from './roleplay-transactions-fixture.js';
import '../src/fetch-patch.js';
import * as store from '../src/scratchpad/store.js';
import { imageChangeHash } from '../src/scratchpad/image-state.js';
import { roleplayEntityContent } from '../src/generation/roleplay-source.js';
import { write as writeCard } from '../src/character-card-parser.js';

process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE = 'false';
const { router } = await import('../src/endpoints/characters.js');

test('multipart avatar replacement keeps metadata/filename, returns 409 on stale revisions and removes refused uploads', async t => {
    const f = fixture(t, false, 'avatar-test');
    const directories = f.scope.directories;
    for (const key of ['thumbnailsAvatar', 'thumbnailsAvatarMobile', 'worlds']) {
        directories[key] = path.join(directories.root, key); fs.mkdirSync(directories[key]);
    }
    const uploads = path.join(directories.root, 'uploads'); fs.mkdirSync(uploads);
    const filename = path.join(directories.characters, 'Nova.png');
    const originalMetadata = { spec: 'chara_card_v3', spec_version: '3.0', name: 'Nova', description: 'Keep this description.', personality: 'Patient.', creator_notes: 'Private creator note.',
        data: { name: 'Nova', description: 'Keep this description.', personality: 'Patient.', alternate_greetings: ['Keep this greeting.'], extensions: { custom_marker: { keep: 'exactly' } } }, extra: { untouched: true } };
    fs.writeFileSync(filename, writeCard(png, JSON.stringify(originalMetadata)));
    const before = fs.readFileSync(filename);
    const revision = createHash('sha256').update(before).digest('hex');
    const app = express();
    app.use((request, _response, next) => { request.user = { profile: { handle: f.scope.owner }, directories }; next(); });
    app.use(multer({ dest: uploads }).single('avatar'));
    app.use('/api/characters', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const post = async expected => {
        const form = new FormData(); form.set('avatar', new Blob([png], { type: 'image/png' }), 'portrait.png');
        form.set('avatar_url', 'Nova.png'); form.set('expected_revision', expected);
        return fetch(`http://127.0.0.1:${server.address().port}/api/characters/edit-avatar`, { method: 'POST', body: form });
    };
    const stale = await post('b'.repeat(64));
    assert.equal(stale.status, 409);
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.deepEqual(fs.readdirSync(uploads), []);
    const invalid = await post('bad-revision'); assert.equal(invalid.status, 400);
    assert.deepEqual(fs.readdirSync(uploads), []);
    const changed = await post(revision); assert.equal(changed.status, 200, await changed.text());
    const after = fs.readFileSync(filename);
    assert.deepEqual(roleplayEntityContent('character', 'Nova.png', after).data, originalMetadata);
    assert.deepEqual(fs.readdirSync(directories.characters), ['Nova.png']);
    assert.deepEqual(fs.readdirSync(uploads), []);
    assert.notEqual(createHash('sha256').update(after).digest('hex'), revision);
    const secondStale = await post(revision); assert.equal(secondStale.status, 409);
    assert.deepEqual(fs.readFileSync(filename), after);
    assert.deepEqual(fs.readdirSync(uploads), []);
});

test('an ordinary avatar upload without an expected revision still succeeds', async t => {
    const f = fixture(t, false, 'avatar-plain');
    const directories = f.scope.directories;
    for (const key of ['thumbnailsAvatar', 'thumbnailsAvatarMobile', 'worlds']) {
        directories[key] = path.join(directories.root, key); fs.mkdirSync(directories[key]);
    }
    const uploads = path.join(directories.root, 'uploads'); fs.mkdirSync(uploads);
    const filename = path.join(directories.characters, 'Nova.png');
    fs.writeFileSync(filename, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Keep this description.' })));
    const before = fs.readFileSync(filename);
    const app = express();
    app.use((request, _response, next) => { request.user = { profile: { handle: f.scope.owner }, directories }; next(); });
    app.use(multer({ dest: uploads }).single('avatar'));
    app.use('/api/characters', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const form = new FormData(); form.set('avatar', new Blob([png], { type: 'image/png' }), 'portrait.png');
    form.set('avatar_url', 'Nova.png');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/characters/edit-avatar`, { method: 'POST', body: form });
    assert.equal(response.status, 200, await response.text());
    assert.notEqual(createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), createHash('sha256').update(before).digest('hex'));
    assert.deepEqual(fs.readdirSync(uploads), []);
});

test('a corrupt saved Scratchpad avatar is refused without replacing the card', async t => {
    const f = fixture(t, false, 'avatar-scratchpad');
    const directories = f.scope.directories;
    for (const key of ['thumbnailsAvatar', 'thumbnailsAvatarMobile', 'worlds']) {
        directories[key] = path.join(directories.root, key); fs.mkdirSync(directories[key]);
    }
    const uploads = path.join(directories.root, 'uploads'); fs.mkdirSync(uploads);
    directories.userImages = path.join(directories.root, 'user/images');
    const filename = path.join(directories.characters, 'Nova.png');
    fs.writeFileSync(filename, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Keep this description.' })));
    const before = fs.readFileSync(filename);
    const revision = createHash('sha256').update(before).digest('hex');
    const imageDirectory = path.join(directories.userImages, 'Scratchpad');
    fs.mkdirSync(imageDirectory, { recursive: true });
    fs.writeFileSync(path.join(imageDirectory, 'scratchpad-previous.png'), before);
    const corrupt = Buffer.from('this is not an image');
    fs.writeFileSync(path.join(imageDirectory, 'scratchpad-proposed.png'), corrupt);
    const source = { kind: 'roleplay', key: 'character:Nova.png:Chat', label: 'Nova', scope: { kind: 'character', id: 'Nova.png' } };
    const change = { type: 'image', action: 'generate', target: 'avatar', character: 'Nova', prompt: 'Portrait.', reason: 'Test.' };
    const request = { user: { profile: { handle: f.scope.owner }, directories }, get: () => undefined };
    const session = store.mutateBucket(store.scratchpadAccountBase(request), source, bucket => {
        const session = store.createSession(bucket);
        session.messages.push({ id: 'reply', role: 'assistant', state: 'done',
            text: '```scratchpad-change\n' + JSON.stringify(change) + '\n```', contextSource: source,
            targets: [{ avatar: 'Nova.png', name: 'Nova' }],
            images: { 0: { state: 'done', target: 'avatar', avatar: 'Nova.png', changeHash: imageChangeHash(change),
                previousAvatarRevision: revision, previousAvatarUrl: '/user/images/Scratchpad/scratchpad-previous.png',
                url: '/user/images/Scratchpad/scratchpad-proposed.png', imageHash: createHash('sha256').update(corrupt).digest('hex') } } });
        return session;
    });
    const app = express();
    app.use((req, _response, next) => { req.user = { profile: { handle: f.scope.owner }, directories }; next(); });
    app.use(multer({ dest: uploads }).single('avatar'));
    app.use('/api/characters', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const form = new FormData();
    form.set('avatar_url', 'Nova.png');
    form.set('expected_revision', revision);
    form.set('scratchpad_avatar_review', JSON.stringify({ source, sessionId: session.id, messageId: 'reply', index: 0 }));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/characters/edit-avatar`, { method: 'POST', body: form });
    const text = await response.text();
    assert.equal(response.status, 409, text);
    assert.equal(JSON.parse(text).message, 'The saved avatar picture could not be used. Review it again.');
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.deepEqual(fs.readdirSync(uploads), []);
});
