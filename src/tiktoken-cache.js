import tiktoken from 'tiktoken';

/** @type {Map<string, import('tiktoken').Tiktoken>} */
const encodings = new Map();

/**
 * Return a shared Tiktoken WASM instance for an encoding name so server
 * tokenizer routes and Mewmory do not allocate duplicate encoder tables.
 *
 * @param {string} encoding Tiktoken encoding name (for example `o200k_base`).
 * @returns {import('tiktoken').Tiktoken}
 */
export function getTiktokenEncoding(encoding) {
    let instance = encodings.get(encoding);
    if (!instance) {
        instance = tiktoken.get_encoding(/** @type {import('tiktoken').TiktokenEncoding} */ (encoding));
        encodings.set(encoding, instance);
    }
    return instance;
}
