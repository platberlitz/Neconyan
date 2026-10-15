import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';

const { deleteSpriteFiles, exportSpriteFiles, listSpriteFiles, saveSpriteFiles } = await import('../src/generation/sprite-storage.js');
const { importRisuSprites, router } = await import('../src/endpoints/sprites.js');
const { getImageBuffers } = await import('../src/util.js');
const { captureSpriteRequest, admitSpriteJob } = await import('../src/generation/sprite-jobs.js');
const { roleplayAccountStamp } = await import('../src/roleplay-store.js');

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM7kAAAAASUVORK5CYII=', 'base64');

test('ordinary sprite writers retain the existing format until the replacement is confirmed', t => {
    const f = fixture(t);
    const directory = path.join(f.scope.directories.characters, 'Nova');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'joy.jpg'), image);
    assert.throws(() => saveSpriteFiles(f.scope.directories, 'Nova', [{ filename: 'joy.png', bytes: image }], {
        beforePublish: () => { throw new Error('simulated write failure'); },
    }), /simulated write failure/);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'joy.jpg')), image);
    assert.equal(fs.existsSync(path.join(directory, 'joy.png')), false);
    assert.equal(saveSpriteFiles(f.scope.directories, 'Nova', [{ filename: 'joy.png', bytes: image }]), 1);
    assert.deepEqual(fs.readdirSync(directory), ['joy.png']);
    const saved = listSpriteFiles(f.scope.directories, 'Nova');
    assert.equal(saved[0].label, 'joy');
    assert.match(saved[0].path, /^\/characters\/Nova\/joy.png\?t=\d+/);
    assert.equal(deleteSpriteFiles(f.scope.directories, 'Nova', 'joy'), 1);
    assert.deepEqual(listSpriteFiles(f.scope.directories, 'Nova'), []);
});

test('sprite HTTP/import writers reject symlink folders and exact-path aliases', t => {
    const f = fixture(t);
    const directory = path.join(f.scope.directories.characters, 'Nova');
    const outside = path.join(f.root, 'outside-sprites');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'joy.png'), image);
    fs.symlinkSync(outside, directory);
    assert.throws(() => saveSpriteFiles(f.scope.directories, 'Nova', [{ filename: 'joy.png', bytes: image }]));
    assert.throws(() => deleteSpriteFiles(f.scope.directories, 'Nova', 'joy'));
    assert.throws(() => listSpriteFiles(f.scope.directories, 'Nova'));
    assert.throws(() => exportSpriteFiles(f.scope.directories, 'Nova'));
    assert.deepEqual(fs.readdirSync(outside), ['joy.png']);
    for (const name of ['../Nova', 'Nova/../other', 'Nova/x/extra', '/Nova', 'Nova\\x']) {
        assert.throws(() => saveSpriteFiles(f.scope.directories, name, [{ filename: 'joy.png', bytes: image }]), { code: 'SPRITE_INVALID' });
    }
});

test('sprite export preserves all variants and formats, isolates the selected set, and can be reimported', t => {
    const f = fixture(t);
    const original = [{ filename: 'joy.png', bytes: image }, { filename: 'joy-2.webp', bytes: Buffer.from('webp fixture') }];
    saveSpriteFiles(f.scope.directories, 'cast/mira', original);
    saveSpriteFiles(f.scope.directories, 'cast/sol', [{ filename: 'anger.png', bytes: image }]);
    const exported = exportSpriteFiles(f.scope.directories, 'cast/mira');
    assert.deepEqual(exported, [original[1], original[0]]);
    saveSpriteFiles(f.scope.directories, 'restored', exported);
    assert.deepEqual(exportSpriteFiles(f.scope.directories, 'restored'), exported);
    assert.deepEqual(exportSpriteFiles(f.scope.directories, 'missing'), []);
    assert.throws(() => exportSpriteFiles(f.scope.directories, '../outside'), { code: 'SPRITE_INVALID' });
});

test('the export endpoint downloads a usable ZIP with original filenames and rejects missing or unsafe sets', async t => {
    const f = fixture(t);
    const files = [{ filename: 'joy.png', bytes: image }, { filename: 'joy-2.png', bytes: image }];
    saveSpriteFiles(f.scope.directories, 'Persona/set', files);
    const app = express();
    app.use(express.json(), (request, response, next) => { request.user = { directories: f.scope.directories }; next(); }, router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const request = name => fetch(`http://127.0.0.1:${server.address().port}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const response = await request('Persona/set');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /Persona-set-expressions.zip/);
    const zip = path.join(f.root, 'export.zip');
    fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
    const unpacked = await getImageBuffers(zip);
    assert.deepEqual(unpacked.map(([filename, bytes]) => ({ filename, bytes })), [files[1], files[0]]);
    assert.equal((await request('missing')).status, 404);
    assert.equal((await request('../outside')).status, 409);
});

test('custom labels and rapid replacements retain their identity and invalidate the image URL', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ extension_settings: { expressions: { custom: ['joy-soft'] } } }));
    saveSpriteFiles(f.scope.directories, 'cast/mira', [{ filename: 'joy-soft-2.png', bytes: image }]);
    const filename = path.join(f.scope.directories.characters, 'cast', 'mira', 'joy-soft-2.png');
    fs.utimesSync(filename, 1000, 1000.1);
    const first = listSpriteFiles(f.scope.directories, 'cast/mira')[0];
    fs.utimesSync(filename, 1000, 1000.2);
    const second = listSpriteFiles(f.scope.directories, 'cast/mira')[0];
    assert.equal(first.label, 'joy-soft');
    assert.equal(second.label, 'joy-soft');
    assert.notEqual(first.path, second.path);
});

test('ordinary sprite writes cannot absorb a native accepted target or another account epoch', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ extension_settings: {
        expressions: {}, 'quick-image-gen': { provider: 'together', togetherKey: 'fixture-key' },
    } }));
    const account = roleplayAccountStamp(f.scope);
    const source = f.source();
    const request = captureSpriteRequest(f.scope, account, source, { avatar: 'Nova.png', labels: ['joy'] });
    admitSpriteJob(f.scope, account, { operationKey: 'busy', source, request });
    assert.throws(() => saveSpriteFiles(f.scope.directories, 'Nova', [{ filename: 'joy.png', bytes: image }]), { code: 'MEDIA_TARGET_BUSY' });
    assert.throws(() => deleteSpriteFiles(f.scope.directories, 'Nova', 'joy'), { code: 'MEDIA_TARGET_BUSY' });
    assert.deepEqual(listSpriteFiles(f.scope.directories, 'Nova'), []);
    assert.throws(() => saveSpriteFiles(f.scope.directories, 'Other', [{ filename: 'joy.png', bytes: image }], {
        account: { ...account, dataEpoch: account.dataEpoch + 1 },
    }), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
});

test('Risu sprites keep existing named variants and remove embedded assets only after successful import', t => {
    const f = fixture(t);
    saveSpriteFiles(f.scope.directories, 'Nova', [{ filename: 'joy.png', bytes: image }]);
    const card = { data: { name: 'Nova', extensions: { risuai: {
        additionalAssets: [['joy', Buffer.from('other bytes').toString('base64')]],
        emotions: [['anger', image.toString('base64')]],
    } } } };
    importRisuSprites(f.scope.directories, card);
    assert.deepEqual(fs.readFileSync(path.join(f.scope.directories.characters, 'Nova', 'joy.png')), image);
    assert.deepEqual(Object.keys(card.data.extensions.risuai), []);
    assert.equal(listSpriteFiles(f.scope.directories, 'Nova').length, 2);
    const invalid = { data: { name: 'Nova', extensions: { risuai: { emotions: [['../escape', image.toString('base64')]] } } } };
    assert.throws(() => importRisuSprites(f.scope.directories, invalid), { code: 'SPRITE_INVALID' });
    assert.equal(invalid.data.extensions.risuai.emotions.length, 1);
});
