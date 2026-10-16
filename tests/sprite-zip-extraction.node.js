import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import { getImageBuffers } from '../src/util.js';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM7kAAAAASUVORK5CYII=', 'base64');

function temporary(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-sprite-zip-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeZip(t, entries) {
    const zipPath = path.join(temporary(t), 'sprites.zip');
    fs.writeFileSync(zipPath, Buffer.from(zipSync(entries, { level: 6 })));
    return zipPath;
}

test('a small image ZIP is unpacked in archive order', async t => {
    const zip = writeZip(t, { 'joy.png': image, 'anger.png': Buffer.from('other bytes') });
    assert.deepEqual(await getImageBuffers(zip), [['joy.png', image], ['anger.png', Buffer.from('other bytes')]]);
});

test('the unpacked total is capped and rejects with 413', async t => {
    const zip = writeZip(t, { 'joy.png': Buffer.alloc(4096, 'a'), 'anger.png': Buffer.alloc(4096, 'b') });
    await assert.rejects(getImageBuffers(zip, { maxTotalBytes: 6144 }), { status: 413 });
    assert.equal((await getImageBuffers(zip, { maxTotalBytes: 8192 })).length, 2);
});

test('a corrupt deflated entry rejects instead of crashing the process', async t => {
    const zip = writeZip(t, { 'joy.png': Buffer.alloc(4096, 'pixels') });
    const bytes = fs.readFileSync(zip);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    const dataStart = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
    bytes.fill(0, dataStart, dataStart + bytes.readUInt32LE(18));
    fs.writeFileSync(zip, bytes);
    await assert.rejects(getImageBuffers(zip), { code: 'Z_DATA_ERROR' });
});

test('maxFiles stops reading before later entries', async t => {
    const zip = writeZip(t, { 'joy.png': image, 'anger.png': image, 'sadness.png': image });
    assert.deepEqual((await getImageBuffers(zip, { maxFiles: 2 })).map(([filename]) => filename), ['joy.png', 'anger.png']);
});
