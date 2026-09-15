/**
 * Creates a single-text vector function from a batch vector function.
 * The returned function calls the batch function with a single-element array
 * and returns the first result.
 *
 * @template {any[]} TArgs
 * @param {(texts: string[], ...args: TArgs) => Promise<number[][]>} batchFn
 * @returns {(text: string, ...args: TArgs) => Promise<number[]>}
 */
export function createSingleVectorFn(batchFn) {
    return async function (text, ...args) {
        const vectors = await batchFn([text], ...args);
        return vectors[0];
    };
}

/**
 * Standard response extraction for OpenAI-compatible embedding endpoints.
 * Validates the response shape, sorts by index, and extracts embedding arrays.
 *
 * @param {any} data - The parsed response JSON
 * @param {string} providerName - Name of the provider for error messages
 * @returns {number[][]}
 */
export function extractOpenAIEmbeddings(data, providerName) {
    if (!Array.isArray(data?.data)) {
        throw new Error(`${providerName}: API response was not an array`);
    }

    data.data.sort((a, b) => a.index - b.index);
    return data.data.map(x => x.embedding);
}
