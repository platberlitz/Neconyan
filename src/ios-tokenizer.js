import { PreTrainedTokenizer } from 'sillytavern-transformers/src/tokenizers.js';

/**
 * The iOS Node runtime cannot execute the atomic WASM instructions used by
 * @agnai/web-tokenizers. Use the same Hugging Face model in the existing JS
 * tokenizer implementation, with the same no-added-tokens encode contract.
 * @param {string} json Hugging Face tokenizer JSON
 * @returns {{encode: (text: string) => Int32Array, decode: (ids: ArrayLike<number>) => string}}
 */
export function createIOSTokenizer(json) {
    const tokenizer = new PreTrainedTokenizer(JSON.parse(json), { clean_up_tokenization_spaces: false });
    return {
        encode: text => Int32Array.from(tokenizer.encode(text, null, { add_special_tokens: false })),
        decode: ids => ids.length ? tokenizer.decode(Array.from(ids), { skip_special_tokens: false, clean_up_tokenization_spaces: false }) : '',
    };
}
