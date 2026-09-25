import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { deleteSpriteFiles, listSpriteFiles, saveSpriteFiles } = await import('../src/generation/sprite-storage.js');
const { importRisuSprites } = await import('../src/endpoints/sprites.js');
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
    assert.deepEqual(fs.readdirSync(outside), ['joy.png']);
    for (const name of ['../Nova', 'Nova/../other', 'Nova/x/extra', '/Nova', 'Nova\\x']) {
        assert.throws(() => saveSpriteFiles(f.scope.directories, name, [{ filename: 'joy.png', bytes: image }]), { code: 'SPRITE_INVALID' });
    }
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
