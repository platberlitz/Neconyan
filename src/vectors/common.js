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

/** Preserve definite provider refusals without treating an unreadable success as safe to repeat. */
export async function readEmbeddingResponse(response, providerName) {
    if (!response.ok) {
        response.body?.destroy?.();
        throw Object.assign(new Error(`${providerName}: embedding request failed (${response.status}).`),
            { status: response.status, embeddingResponse: true });
    }
    const limit = 16 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) {
        response.body?.destroy?.();
        throw new Error(`${providerName}: embedding response exceeds the saved-result limit.`);
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) {
            response.body?.destroy?.();
            throw new Error(`${providerName}: embedding response exceeds the saved-result limit.`);
        }
        chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
