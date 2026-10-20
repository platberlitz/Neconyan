import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import PNGtext from 'png-chunk-text';

import encode from '../src/png/encode.js';
import { parse, read, write } from '../src/character-card-parser.js';

const IMAGE_BYTES = 2 * 1024 * 1024;

function blankPng() {
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, 1);
    new DataView(ihdr.buffer).setUint32(4, 1);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.from(encode([
        { name: 'IHDR', data: ihdr },
        { name: 'IDAT', data: new Uint8Array(IMAGE_BYTES).fill(7) },
        { name: 'IEND', data: new Uint8Array(0) },
    ]));
}

function chunkOffset(png, name) {
    for (let offset = 8; offset < png.length;) {
        if (png.toString('latin1', offset + 4, offset + 8) === name) return offset;
        offset += png.readUInt32BE(offset) + 12;
    }
    throw new Error(`No ${name} chunk`);
}

function cardFile(t, bytes) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'card-parser-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'card.png');
    fs.writeFileSync(filename, bytes);
    return filename;
}

const card = { name: 'Mochi', data: { name: 'Mochi', description: 'Ünïcode café ☕'.repeat(2000), extensions: {} } };

test('card files are read without loading or checksumming the image data', async t => {
    const png = write(blankPng(), JSON.stringify(card));
    const idat = chunkOffset(png, 'IDAT');
    png[idat + 100] ^= 0xFF;
    const filename = cardFile(t, png);
    const reads = t.mock.method(fs, 'readSync');

    const parsed = JSON.parse(await parse(filename));

    assert.equal(parsed.spec, 'chara_card_v3');
    assert.equal(parsed.data.description, card.data.description);
    const bytesRead = reads.mock.calls.reduce((sum, call) => sum + call.result, 0);
    assert.ok(bytesRead < IMAGE_BYTES / 4, `read ${bytesRead} of ${png.length} bytes`);
    assert.equal(read(png), await parse(filename));
});

test('V3 card text wins over V2 and a card with neither is refused', t => {
    const v2Only = blankPng();
    const iend = chunkOffset(v2Only, 'IEND');
    const chara = PNGtext.encode('chara', Buffer.from('{"name":"Old"}').toString('base64'));
    const withChara = Buffer.from(encode([...splitChunks(v2Only.subarray(0, iend)), chara, { name: 'IEND', data: new Uint8Array(0) }]));
    assert.equal(read(withChara), '{"name":"Old"}');

    const both = write(withChara, JSON.stringify(card));
    assert.equal(JSON.parse(read(both)).spec, 'chara_card_v3');

    t.mock.method(console, 'error', () => {});
    assert.throws(() => read(blankPng()), /No PNG metadata/);
});

test('damaged card metadata and file structure are still refused', async t => {
    const png = write(blankPng(), JSON.stringify(card));
    const text = chunkOffset(png, 'tEXt');

    const badText = Buffer.from(png);
    badText[text + 20] ^= 0xFF;
    assert.throws(() => read(badText), /CRC values for tEXt header do not match/);
    await assert.rejects(parse(cardFile(t, badText)), /CRC values for tEXt header do not match/);

    const noEnd = png.subarray(0, chunkOffset(png, 'IEND'));
    assert.throws(() => read(noEnd), /no IEND header was found/);
    await assert.rejects(parse(cardFile(t, noEnd)), /no IEND header was found/);

    const truncated = png.subarray(0, text + 40);
    assert.throws(() => read(truncated), /Truncated PNG chunk/);
    await assert.rejects(parse(cardFile(t, truncated)), /Truncated PNG chunk/);

    const lineEndings = Buffer.from(png);
    lineEndings[4] = 0x0A;
    assert.throws(() => read(lineEndings), /DOS-Unix line ending conversion/);

    const nul = PNGtext.encode('chara', 'abc');
    nul.data[nul.data.length - 2] = 0;
    const withNul = Buffer.from(encode([...splitChunks(png.subarray(0, chunkOffset(png, 'IEND'))), nul, { name: 'IEND', data: new Uint8Array(0) }]));
    assert.throws(() => read(withNul), /Invalid NULL character/);
});

function splitChunks(png) {
    const chunks = [];
    for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset);
        chunks.push({ name: png.toString('latin1', offset + 4, offset + 8), data: new Uint8Array(png.subarray(offset + 8, offset + 8 + length)) });
        offset += length + 12;
    }
    return chunks;
}
