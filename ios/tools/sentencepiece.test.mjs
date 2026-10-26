import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { lowerPrivateSentencePiece, prepareSentencePiece } from './prepare-sentencepiece.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
test('private-memory lowering rejects any unreviewed binary', async () => {
    await assert.rejects(lowerPrivateSentencePiece(new Uint8Array()), /Unexpected SentencePiece binary/);
});
test('single-threaded SentencePiece matches the original across every bundled model', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-private-sp-'));
    const relative = 'node_modules/@agnai/sentencepiece-js/dist/index.js';
    try {
        fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
        fs.copyFileSync(path.join(root, relative), path.join(directory, relative));
        await prepareSentencePiece(directory);
        const Original = require('@agnai/sentencepiece-js').SentencePieceProcessor;
        const Lowered = require(path.join(directory, relative)).SentencePieceProcessor;
        const texts = ['', 'Hello from a standalone Neconyan.', '  hello\n\nthere\t ', '猫🐱 café\r\n123456789', '<s>test</s><unk>', 'I can\'t...   Do YOU?', '\u0000\u0001\ufffd', 'a'.repeat(4096)];
        let seed = 3197;
        const alphabet = Array.from('abcoCAT0123 \t\n\r.,!?é猫🐱☃\u0301\u2581');
        for (let i = 0; i < 100; i++) {
            let text = '';
            for (let j = 0; j < 64; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += alphabet[seed % alphabet.length]; }
            texts.push(text);
        }
        for (const model of fs.readdirSync(path.join(root, 'src/tokenizers')).filter(name => name.endsWith('.model'))) {
            const original = new Original();
            const lowered = new Lowered();
            await original.load(path.join(root, 'src/tokenizers', model));
            await lowered.load(path.join(root, 'src/tokenizers', model));
            for (const text of texts) {
                const expected = original.encodeIds(text);
                assert.deepEqual(lowered.encodeIds(text), expected, model + ': ' + JSON.stringify(text));
                assert.equal(lowered.decodeIds(expected), original.decodeIds(expected), model);
            }
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
