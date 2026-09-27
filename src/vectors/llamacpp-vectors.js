import fetch from 'node-fetch';
import urlJoin from 'url-join';
import { setAdditionalHeadersByType } from '../additional-headers.js';
import { TEXTGEN_TYPES } from '../constants.js';
import { trimV1 } from '../util.js';
import { createSingleVectorFn, extractOpenAIEmbeddings, readEmbeddingResponse } from './common.js';

/**
 * Gets the vector for the given text from LlamaCpp
 * @param {string[]} texts - The array of texts to get the vectors for
 * @param {string} apiUrl - The API URL
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @returns {Promise<number[][]>} - The array of vectors for the texts
 */
export async function getLlamaCppBatchVector(texts, apiUrl, directories, { fetchImpl = fetch, signal } = {}) {
    const url = new URL(urlJoin(trimV1(apiUrl), '/v1/embeddings'));

    const headers = {};
    setAdditionalHeadersByType(headers, TEXTGEN_TYPES.LLAMACPP, apiUrl, directories);

    const response = await fetchImpl(url, {
        signal,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers,
        },
        body: JSON.stringify({ input: texts }),
    });

    const data = await readEmbeddingResponse(response, 'LlamaCpp');
    return extractOpenAIEmbeddings(data, 'LlamaCpp');
}

/**
 * Gets the vector for the given text from LlamaCpp
 * @param {string} text - The text to get the vector for
 * @param {string} apiUrl - The API URL
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @returns {Promise<number[]>} - The vector for the text
 */
export const getLlamaCppVector = createSingleVectorFn(getLlamaCppBatchVector);
