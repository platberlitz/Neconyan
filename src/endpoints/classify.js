import express from 'express';

import { runPipeline } from '../transformers.js';

const TASK = 'text-classification';

export const CLASSIFY_CACHE_MAX_ENTRIES = 256;
export const CLASSIFY_CACHE_MAX_KEY_CHARS = 4096;
export const CLASSIFY_CACHE_MAX_TOTAL_CHARS = 256 * 1024;

export const router = express.Router();

/**
 * @type {Map<string, object>} Bounded LRU cache for classification results
 */
const cacheObject = new Map();
let cachedTotalChars = 0;

/**
 * Clear the classification cache and reset retained character tracking.
 */
export function clearClassifyCache() {
    cacheObject.clear();
    cachedTotalChars = 0;
}

/**
 * Inspect the current classification cache state for diagnostics and tests.
 * @returns {{ entries: number, totalChars: number, keys: string[] }}
 */
export function getClassifyCacheStats() {
    return {
        entries: cacheObject.size,
        totalChars: cachedTotalChars,
        keys: Array.from(cacheObject.keys()),
    };
}

/**
 * Read a cached classification result and refresh its LRU order.
 * @param {string} text
 * @returns {object|undefined}
 */
function readCachedClassification(text) {
    if (typeof text !== 'string' || !cacheObject.has(text)) {
        return undefined;
    }

    const cached = cacheObject.get(text);
    cacheObject.delete(text);
    cacheObject.set(text, cached);
    return cached;
}

/**
 * Store a classification result when its key fits within the cache bounds,
 * evicting oldest entries to keep entry count and retained key characters bounded.
 * @param {string} text
 * @param {object} result
 */
function writeCachedClassification(text, result) {
    if (typeof text !== 'string' || text.length > CLASSIFY_CACHE_MAX_KEY_CHARS || text.length > CLASSIFY_CACHE_MAX_TOTAL_CHARS) {
        return;
    }

    if (cacheObject.has(text)) {
        cacheObject.delete(text);
        cachedTotalChars -= text.length;
    }

    while (
        cacheObject.size > 0 &&
        (cacheObject.size >= CLASSIFY_CACHE_MAX_ENTRIES || cachedTotalChars + text.length > CLASSIFY_CACHE_MAX_TOTAL_CHARS)
    ) {
        const oldestKey = cacheObject.keys().next().value;
        cacheObject.delete(oldestKey);
        cachedTotalChars -= oldestKey.length;
    }

    cacheObject.set(text, result);
    cachedTotalChars += text.length;
}

router.post('/labels', async (req, res) => {
    try {
        const result = await runPipeline(TASK, '', pipe => Object.keys(pipe.model.config.label2id));
        return res.json({ labels: result });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

router.post('/', async (req, res) => {
    try {
        const { text } = req.body ?? {};
        if (typeof text !== 'string') {
            return res.sendStatus(400);
        }

        /**
         * Get classification result for a given text
         * @param {string} text Text to classify
         * @returns {Promise<object>} Classification result
         */
        const getResult = async (text) => {
            const cached = readCachedClassification(text);
            if (cached !== undefined) {
                return cached;
            }

            const result = await runPipeline(TASK, '', pipe => pipe(text, { topk: 5 }));
            result.sort((a, b) => b.score - a.score);
            writeCachedClassification(text, result);
            return result;
        };

        console.debug('Classify input:', text);
        const result = await getResult(text);
        console.debug('Classify output:', result);

        return res.json({ classification: result });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});
