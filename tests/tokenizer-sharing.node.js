/* eslint playwright/expect-expect: off -- Node assertions verify real tokenizer instances and token IDs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import tiktoken from 'tiktoken';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { getTiktokenTokenizer, getTokenizerModel, TEXT_COMPLETION_MODELS } = await import('../src/endpoints/tokenizers.js');

test('models with the same encoding share one tokenizer allocation', () => {
    assert.equal(getTiktokenTokenizer('gpt-3.5-turbo'), getTiktokenTokenizer('gpt-4'));
    assert.equal(getTiktokenTokenizer('gpt-4'), getTiktokenTokenizer('gpt-4-32k'));
    assert.equal(getTiktokenTokenizer('gpt-4o'), getTiktokenTokenizer('o1'));
    assert.notEqual(getTiktokenTokenizer('gpt-4'), getTiktokenTokenizer('gpt-4o'));
});

test('shared encodings preserve token IDs and decoding for all supported OpenAI model families', () => {
    const models = [...new Set(['gpt2', 'gpt-3.5-turbo', 'gpt-3.5-turbo-0301', 'gpt-4', 'gpt-4-32k', 'gpt-4o', 'o1', ...TEXT_COMPLETION_MODELS])];
    const samples = ['Hello world!', '日本語 café 👋\nTabs\tand punctuation.', '<|endoftext|> <|fim_prefix|> <|im_start|>'];
    for (const model of models) {
        const reference = tiktoken.encoding_for_model(model);
        try {
            const shared = getTiktokenTokenizer(model);
            for (const text of samples) {
                const expected = reference.encode(text, [], []);
                assert.deepEqual(shared.encode(text, [], []), expected, model);
                assert.deepEqual(shared.decode(expected), reference.decode(expected), model);
            }
        } finally {
            reference.free();
        }
    }
    assert.equal(getTiktokenTokenizer(getTokenizerModel('gpt-6-astra')), getTiktokenTokenizer('o1'));
});

test('unsupported models still fail instead of receiving a different encoding', () => {
    assert.throws(() => getTiktokenTokenizer('unknown-model'));
});
