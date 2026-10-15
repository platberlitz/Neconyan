import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { installSpriteModel, processSpriteModel, verifySpriteModel, validateSpriteModelInput } from '../src/generation/sprite-models.js';
import { matteSprite } from '../src/generation/sprite-model-pixels.js';
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { router } = await import('../src/endpoints/sprites.js');

test('model files must match both the expected size and SHA-256 and may not be symlinks', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-model-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filename = path.join(root, 'model'), bytes = Buffer.from('verified model');
    const model = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    assert.equal(await verifySpriteModel(filename, model), false);
    fs.writeFileSync(filename, bytes);
    assert.equal(await verifySpriteModel(filename, model), true);
    fs.writeFileSync(filename, Buffer.alloc(bytes.length));
    assert.equal(await verifySpriteModel(filename, model), false);
    fs.symlinkSync(filename, path.join(root, 'link'));
    assert.equal(await verifySpriteModel(path.join(root, 'link'), model), false);
});

test('invalid and oversized images are rejected before loading a model', () => {
    assert.throws(() => validateSpriteModelInput('other', {}), /Unknown/);
    assert.throws(() => validateSpriteModelInput('matting', { width: 1, height: 1, data: new Uint8Array(3) }), /Invalid/);
});

test('failed model download never installs a partial file; inference never downloads implicitly', async t => {
    const previous = global.DATA_ROOT, root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-model-'));
    global.DATA_ROOT = root;
    t.after(() => { global.DATA_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
    await assert.rejects(installSpriteModel('matting', { fetchImpl: async () => new Response('wrong model') }), /verified/);
    assert.deepEqual(fs.readdirSync(path.join(root, '_cache', 'sprite-models')), []);
    await assert.rejects(processSpriteModel('matting', { width: 1, height: 1, data: new Uint8Array(4), scale: 2 }), /Download/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(processSpriteModel('matting', { width: 1, height: 1, data: new Uint8Array(4) }, { signal: abort.signal }), { name: 'AbortError' });
    const app = express().use(express.json()).use('/api/sprites', router);
    const server = app.listen(0, '127.0.0.1');
    t.after(() => server.close());
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/sprites/process?kind=matting&width=1&height=1`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(4) });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Download/);
});

test('matting letterboxes an opaque wide image and restores the mask coordinates', async () => {
    const data = new Uint8Array(8 * 4 * 4).fill(255);
    const result = await matteSprite({ data, width: 8, height: 4 }, async (input, width, height) => {
        assert.equal(width, 1024); assert.equal(height, 1024);
        assert.equal(input[0], 0);
        assert.equal(input[256 * width], 1);
        const mask = new Float32Array(width * height);
        for (let y = 256; y < 768; y++) for (let x = 512; x < width; x++) mask[y * width + x] = 1;
        return mask;
    });
    assert.equal(result.data[0], 0);
    assert.equal(result.data[7], 255);
    assert.equal(result.data[31], 255);
});
