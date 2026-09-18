import { get_encoding } from 'tiktoken';
import { getTokenizerModel } from '../endpoints/tokenizers.js';
import { fail } from './core.js';

export { getTokenizerModel };
export const TOKENIZERS = ['auto', 'o200k_base', 'cl100k_base', 'gpt2', 'llama', 'llama3', 'mistral', 'gemma', 'claude', 'qwen2', 'deepseek', 'nemo', 'jamba', 'yi'];
const encodings = new Map();

export async function getCounter(choice = 'o200k_base', hint = {}) {
    if (choice === 'auto') {
        const names = { nerd: 'nerdstash', nerd2: 'nerdstash_v2', command_r: 'command-r', command_a: 'command-a' };
        choice = names[hint.tokenizerKey] || hint.tokenizerKey;
        if (choice === 'openai') {
            choice = getTokenizerModel(String(hint.tokenizerName || ''));
        }
        if (!choice || ['none', 'api_current', 'api_kobold', 'api_textgenerationwebui', 'best_match'].includes(choice)) {
            fail('Choose a local writer tokenizer in Mewmory settings. Automatic history exclusion cannot use a character estimate.', 409);
        }
    }
    if (['o200k_base', 'cl100k_base', 'gpt2'].includes(choice)) {
        if (!encodings.has(choice)) encodings.set(choice, get_encoding(choice));
        const encoder = encodings.get(choice);
        return { name: choice, count: value => encoder.encode(String(value), [], []).length };
    }
    const tokenizers = await import('../endpoints/tokenizers.js');
    if (tokenizers.sentencepieceTokenizers.includes(choice)) {
        const tokenizer = tokenizers.getSentencepiceTokenizer(choice);
        const encoder = await tokenizer?.get();
        if (!encoder) fail('The selected tokenizer is unavailable. History has been kept.', 503);
        if (tokenizer.fallback) fail('The ' + choice + ' tokenizer is unavailable; the loaded ' + tokenizer.loadedModel + ' substitute cannot be used for Mewmory. History has been kept.', 503);
        return { name: choice, count: value => encoder.encodeIds(String(value)).length };
    }
    if (tokenizers.webTokenizers.includes(choice)) {
        const tokenizer = tokenizers.getWebTokenizer(choice);
        const encoder = await tokenizer?.get();
        if (!encoder) fail('The selected tokenizer is unavailable. History has been kept.', 503);
        if (tokenizer.fallback) fail('The ' + choice + ' tokenizer is unavailable; the loaded ' + tokenizer.loadedModel + ' substitute cannot be used for Mewmory. History has been kept.', 503);
        return { name: choice, count: value => encoder.encode(String(value)).length };
    }
    if (/^(gpt-|o[134]|text-|code-)/.test(choice)) {
        const encoder = tokenizers.getTiktokenTokenizer(choice);
        return { name: choice, count: value => encoder.encode(String(value), [], []).length };
    }
    fail('Unsupported tokenizer. Choose a tokenizer in Mewmory settings.', 400);
}
