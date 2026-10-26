/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createIOSTokenizer } from '../src/ios-tokenizer.js';

// Reference IDs from Hugging Face's Rust tokenizer, without added special tokens.
const cases = [
    ['Hello from a standalone Neconyan.', [9906, 505, 264, 44488, 4275, 444, 8503, 13]],
    [' hello\n\nthere', [24748, 271, 19041]],
    ['猫🐱 café\r\n123456789', [108429, 9468, 238, 109, 53050, 319, 4513, 10961, 16474]],
    ['<|begin_of_text|>test<|eot_id|>', [128000, 1985, 128009]],
    ['I can\'t...   Do YOU?', [40, 649, 956, 1131, 256, 3234, 15334, 30]],
    ['', []],
];
test('iOS tokenizer preserves reference token IDs and text without native WebAssembly', () => {
    const wasm = globalThis.WebAssembly;
    try {
        globalThis.WebAssembly = undefined;
        const tokenizer = createIOSTokenizer(fs.readFileSync(new URL('../src/tokenizers/llama3.json', import.meta.url), 'utf8'));
        for (const [text, expected] of cases) {
            assert.deepEqual(Array.from(tokenizer.encode(text)), expected, text);
            assert.equal(tokenizer.decode(expected), text);
        }
    } finally {
        globalThis.WebAssembly = wasm;
    }
});
