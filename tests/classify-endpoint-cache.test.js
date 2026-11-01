import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import http from 'node:http';
import express from 'express';

const pipelineCalls = [];
const mockPipe = jest.fn(async (text, options) => {
    pipelineCalls.push({ text, options });
    return [
        { label: 'neutral', score: 0.2 },
        { label: 'joy', score: 0.9 },
        { label: 'surprise', score: 0.5 },
    ];
});
mockPipe.model = {
    config: {
        label2id: {
            joy: 0,
            surprise: 1,
            neutral: 2,
        },
    },
};

const mockRunPipeline = jest.fn(async (_task, _forceModel, operation) => operation(mockPipe));

jest.unstable_mockModule('../src/transformers.js', () => ({
    runPipeline: mockRunPipeline,
}));

const {
    CLASSIFY_CACHE_MAX_ENTRIES,
    CLASSIFY_CACHE_MAX_KEY_CHARS,
    CLASSIFY_CACHE_MAX_TOTAL_CHARS,
    clearClassifyCache,
    getClassifyCacheStats,
    router,
} = await import('../src/endpoints/classify.js');

function requestJson(port, method, routePath, body) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: routePath,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try {
                        json = JSON.parse(text);
                    } catch {
                        // non-JSON response
                    }
                    resolve({ status: res.statusCode, text, json });
                });
            },
        );
        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

describe('src/endpoints/classify.js bounded classification cache', () => {
    let server;
    let port;
    let debugSpy;

    beforeAll(async () => {
        debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
        const app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use('/api/extra/classify', router);
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                resolve();
            });
        });
    });

    afterAll(async () => {
        debugSpy?.mockRestore();
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    beforeEach(() => {
        clearClassifyCache();
        pipelineCalls.length = 0;
        mockPipe.mockClear();
        mockRunPipeline.mockClear();
    });

    test('returns sorted classification results and serves repeat queries from cache without re-running pipeline', async () => {
        const first = await requestJson(port, 'POST', '/api/extra/classify', { text: 'Hello there!' });
        expect(first.status).toBe(200);
        expect(first.json).toEqual({
            classification: [
                { label: 'joy', score: 0.9 },
                { label: 'surprise', score: 0.5 },
                { label: 'neutral', score: 0.2 },
            ],
        });
        expect(mockPipe).toHaveBeenCalledTimes(1);
        expect(pipelineCalls[0]).toEqual({ text: 'Hello there!', options: { topk: 5 } });

        const second = await requestJson(port, 'POST', '/api/extra/classify', { text: 'Hello there!' });
        expect(second.status).toBe(200);
        expect(second.json).toEqual(first.json);
        expect(mockPipe).toHaveBeenCalledTimes(1);
        expect(getClassifyCacheStats()).toEqual({
            entries: 1,
            totalChars: 'Hello there!'.length,
            keys: ['Hello there!'],
        });
    });

    test('bypasses cache for oversized single inputs while still returning classification output', async () => {
        const oversized = 'a'.repeat(CLASSIFY_CACHE_MAX_KEY_CHARS + 1);
        const first = await requestJson(port, 'POST', '/api/extra/classify', { text: oversized });
        expect(first.status).toBe(200);
        expect(first.json.classification[0].label).toBe('joy');
        expect(getClassifyCacheStats()).toEqual({
            entries: 0,
            totalChars: 0,
            keys: [],
        });

        const second = await requestJson(port, 'POST', '/api/extra/classify', { text: oversized });
        expect(second.status).toBe(200);
        expect(mockPipe).toHaveBeenCalledTimes(2);
    });

    test('evicts least-recently-used entries when entry count exceeds CLASSIFY_CACHE_MAX_ENTRIES', async () => {
        for (let i = 0; i < CLASSIFY_CACHE_MAX_ENTRIES; i++) {
            const res = await requestJson(port, 'POST', '/api/extra/classify', { text: `msg-${i}` });
            expect(res.status).toBe(200);
        }
        expect(getClassifyCacheStats().entries).toBe(CLASSIFY_CACHE_MAX_ENTRIES);
        expect(mockPipe).toHaveBeenCalledTimes(CLASSIFY_CACHE_MAX_ENTRIES);

        // Refresh msg-0 so msg-1 becomes the oldest LRU key
        await requestJson(port, 'POST', '/api/extra/classify', { text: 'msg-0' });
        expect(mockPipe).toHaveBeenCalledTimes(CLASSIFY_CACHE_MAX_ENTRIES);

        // Insert one more entry to trigger eviction of msg-1
        await requestJson(port, 'POST', '/api/extra/classify', { text: 'msg-new' });
        const stats = getClassifyCacheStats();
        expect(stats.entries).toBe(CLASSIFY_CACHE_MAX_ENTRIES);
        expect(stats.keys).toContain('msg-0');
        expect(stats.keys).toContain('msg-new');
        expect(stats.keys).not.toContain('msg-1');
    });

    test('evicts oldest entries when total retained input characters exceed CLASSIFY_CACHE_MAX_TOTAL_CHARS', async () => {
        const chunkLen = CLASSIFY_CACHE_MAX_KEY_CHARS;
        const maxFittingKeys = Math.floor(CLASSIFY_CACHE_MAX_TOTAL_CHARS / chunkLen);

        for (let i = 0; i < maxFittingKeys + 2; i++) {
            const prefix = `${i}:`;
            const key = prefix + 'x'.repeat(chunkLen - prefix.length);
            const res = await requestJson(port, 'POST', '/api/extra/classify', { text: key });
            expect(res.status).toBe(200);
        }

        const stats = getClassifyCacheStats();
        expect(stats.totalChars).toBeLessThanOrEqual(CLASSIFY_CACHE_MAX_TOTAL_CHARS);
        expect(stats.entries).toBe(maxFittingKeys);
        expect(stats.keys[0].startsWith('2:')).toBe(true);
    });

    test('rejects non-string text payloads with 400 without invoking pipeline or polluting cache', async () => {
        for (const badBody of [{}, { text: null }, { text: 123 }, { text: ['hi'] }, { text: { a: 1 } }]) {
            const res = await requestJson(port, 'POST', '/api/extra/classify', badBody);
            expect(res.status).toBe(400);
        }
        expect(mockPipe).not.toHaveBeenCalled();
        expect(getClassifyCacheStats().entries).toBe(0);
    });

    test('returns model label keys from /labels', async () => {
        const res = await requestJson(port, 'POST', '/api/extra/classify/labels', {});
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ labels: ['joy', 'surprise', 'neutral'] });
    });
});
