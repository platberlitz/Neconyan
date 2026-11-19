import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import express from 'express';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { imageChangeHash } = await import('../src/scratchpad/image-state.js');
const { scratchpadGalleryLocked } = await import('../src/scratchpad/image-gallery.js');
const { scratchpadAccountBase, withScratchpad } = await import('../src/scratchpad/store.js');
const { router } = await import('../src/endpoints/scratchpad.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
after(() => cancelAutoSaves());

function account(t, owner = 'gallery') {
    const { scope } = fixture(t, false, owner);
    const user = { profile: { handle: owner }, directories: scope.directories };
    const base = scratchpadAccountBase({ user, get: () => undefined });
    const directory = path.join(scope.directories.root, 'scratchpad');
    fs.mkdirSync(directory);
    const save = (letter, sessions, kind = 'general') => fs.writeFileSync(path.join(directory, `${letter.repeat(40)}.json`), JSON.stringify({ source: { kind, key: kind }, sessions }));
    const image = (name, action = 'generate') => {
        const change = { type: 'image', action, target: 'image', prompt: `Picture ${name}`, negative: 'blur', reason: '',
            ...(action === 'edit' ? { source: { messageId: 'original', kind: 'generated', index: 0 } } : {}) };
        const url = `/user/images/Scratchpad/scratchpad-${name}.png`;
        const filename = path.join(scope.directories.root, url.slice(1));
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, png);
        const message = { role: 'assistant', state: 'done', text: '```scratchpad-change\n' + JSON.stringify(change) + '\n```',
            images: { 0: { state: 'done', target: 'image', prompt: change.prompt, negative: change.negative, changeHash: imageChangeHash(change),
                imageHash: createHash('sha256').update(png).digest('hex'), url, width: 1, height: 1 } } };
        return { message, filename, url };
    };
    return { user, base, directory, save, image, list: () => withScratchpad(base, scratchpadGalleryLocked) };
}

test('Gallery lists saved pictures and edits across lists and reply versions, once each, newest first', t => {
    const a = account(t);
    const original = a.image('original');
    const edited = a.image('edited', 'edit');
    fs.utimesSync(original.filename, 1000, 1000);
    fs.utimesSync(edited.filename, 2000, 2000);
    a.save('a', [{ messages: [{ ...edited.message, swipeIndex: 1, swipes: [original.message, null] }] }]);
    a.save('b', [{ messages: [original.message] }], 'conversation');
    const found = a.list();
    assert.deepEqual(found.map(image => image.url), [edited.url, original.url]);
    assert.equal(found[0].date, 2000000);
    assert.equal(found[0].prompt, 'Picture edited');
    assert.equal(found[0].negative, 'blur');
    assert.deepEqual(found[0].metadataSettings, { width: 1, height: 1 });
    assert.equal(JSON.stringify(found).includes('imageHash'), false);
    assert.deepEqual(fs.readFileSync(original.filename), png);
});

test('Gallery excludes temporary sessions, invalid receipts, backups, missing and unsafe files', t => {
    const a = account(t);
    const kept = a.image('kept');
    const temporary = a.image('temporary');
    const missing = a.image('missing');
    fs.unlinkSync(missing.filename);
    const linked = a.image('linked');
    fs.unlinkSync(linked.filename);
    fs.symlinkSync(kept.filename, linked.filename);
    a.image('avatar-before-backup');
    const invalid = [{ state: 'pending' }, { state: 'failed' }, { imageHash: '' }, { changeHash: '0'.repeat(64) },
        { url: '/user/images/Scratchpad/../../settings.json' }, { url: 'https://example.test/picture.png' }].map(patch => {
        const message = structuredClone(kept.message);
        Object.assign(message.images[0], patch);
        return message;
    });
    a.save('a', [{ messages: [kept.message, missing.message, linked.message, ...invalid] }, { temporary: true, messages: [temporary.message] }]);
    fs.writeFileSync(path.join(a.directory, `${'b'.repeat(40)}.json`), '{broken');
    a.save('c', [{ messages: [temporary.message] }], 'invalid');
    fs.symlinkSync(path.join(a.directory, `${'a'.repeat(40)}.json`), path.join(a.directory, `${'d'.repeat(40)}.json`));
    assert.deepEqual(a.list().map(image => image.url), [kept.url]);
    a.save('a', []);
    assert.deepEqual(a.list(), [], 'deleting a saved session removes its Gallery entries');
});

test('the Gallery endpoint uses the signed-in account and rejects a stale account header', async t => {
    const a = account(t, 'first');
    const b = account(t, 'second');
    const first = a.image('first');
    const keep = a.image('keep');
    const second = b.image('second');
    const sharedName = b.image('first');
    a.save('a', [{ messages: [first.message, keep.message] }]);
    b.save('a', [{ messages: [second.message, sharedName.message] }]);
    const listPath = path.join(a.directory, `${'a'.repeat(40)}.json`);
    const originalList = fs.readFileSync(listPath);
    let active = a;
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.user = active.user; next(); });
    app.use(router);
    const server = await new Promise(resolve => { const opened = app.listen(0, '127.0.0.1', () => resolve(opened)); });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const post = (owner, ids) => fetch(`http://127.0.0.1:${server.address().port}/images/gallery${ids ? '/remove' : ''}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Neconyan-Account': owner, Connection: 'close' }, body: JSON.stringify({ ids }) });
    assert.equal((await post('second')).status, 409);
    const firstId = `scratchpad:${first.url}`;
    const secondId = `scratchpad:${second.url}`;
    assert.equal((await post('second', [firstId])).status, 409);
    assert.equal((await post('first', [firstId, 'scratchpad:/../settings.json'])).status, 400);
    assert.equal((await (await post('first')).json()).images.length, 2);
    assert.deepEqual(await (await post('first', [firstId, secondId, firstId])).json(), { removed: [firstId] });
    assert.deepEqual(await (await post('first', [firstId])).json(), { removed: [firstId] });
    assert.deepEqual((await (await post('first')).json()).images.map(image => image.url), [keep.url]);
    assert.deepEqual(fs.readFileSync(first.filename), png);
    assert.deepEqual(fs.readFileSync(listPath), originalList);
    active = b;
    assert.equal((await post('first')).status, 409);
    assert.deepEqual(new Set((await (await post('second')).json()).images.map(image => image.url)), new Set([second.url, sharedName.url]));
});
