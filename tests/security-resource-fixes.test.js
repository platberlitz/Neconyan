/* global globalThis */
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import archiver from 'archiver';
import express from 'express';
import multer from 'multer';

const mockPipeline = jest.fn(async (_task, model) => {
    const pipe = async () => model;
    pipe.dispose = async () => {};
    return pipe;
});

jest.unstable_mockModule('sillytavern-transformers', () => ({
    pipeline: mockPipeline,
    env: { backends: { onnx: { wasm: {} } } },
    RawImage: {},
}));

const {
    extractFileFromZipBuffer,
    extractFilesFromZipBuffer,
    setConfigFilePath,
} = await import('../src/util.js');
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const { getPipeline, validateForcedModelId } = await import('../src/transformers.js');
const { createUploadStorage } = await import('../src/middleware/uploadStorage.js');
const {
    default: multerMonkeyPatch,
    resolveOwnedUploadPath,
} = await import('../src/middleware/multerMonkeyPatch.js');

function buildZipBuffer(entries) {
    return new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 6 } });
        const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.on('error', reject);
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        for (const { name, data } of entries) {
            archive.append(Buffer.isBuffer(data) ? data : Buffer.from(data), { name });
        }
        archive.finalize();
    });
}

describe('ZIP and Gzip decompression limits (FN-MEDIUM-3)', () => {
    test('extractFileFromZipBuffer returns the first matching entry within maxEntryBytes and rejects oversized entries', async () => {
        const zipBuffer = await buildZipBuffer([
            { name: 'first.json', data: JSON.stringify({ ok: true, id: 1 }) },
            { name: 'second.json', data: JSON.stringify({ ok: true, id: 2 }) },
            { name: 'huge.bin', data: Buffer.alloc(4096, 0x41) },
        ]);

        const extracted = await extractFileFromZipBuffer(zipBuffer, '.json', { maxEntryBytes: 1024 });
        expect(extracted).not.toBeNull();
        expect(JSON.parse(extracted.toString('utf8'))).toEqual({ ok: true, id: 1 });

        const blockedHuge = await extractFileFromZipBuffer(zipBuffer, 'huge.bin', { maxEntryBytes: 1024 });
        expect(blockedHuge).toBeNull();
    });

    test('extractFilesFromZipBuffer enforces per-entry and cumulative maxTotalBytes limits', async () => {
        const zipBuffer = await buildZipBuffer([
            { name: 'assets/a.png', data: Buffer.alloc(600, 0x01) },
            { name: 'assets/b.png', data: Buffer.alloc(600, 0x02) },
            { name: 'assets/too-big.png', data: Buffer.alloc(2000, 0x03) },
        ]);

        const perEntryFiltered = await extractFilesFromZipBuffer(
            zipBuffer,
            ['assets/a.png', 'assets/too-big.png', 'assets/b.png'],
            { maxEntryBytes: 1000, maxTotalBytes: 5000 },
        );
        expect([...perEntryFiltered.keys()]).toEqual(['assets/a.png', 'assets/b.png']);

        const totalCapped = await extractFilesFromZipBuffer(
            zipBuffer,
            ['assets/a.png', 'assets/b.png'],
            { maxEntryBytes: 1000, maxTotalBytes: 900 },
        );
        expect(totalCapped.size).toBe(1);
        expect(totalCapped.has('assets/a.png')).toBe(true);
        expect(totalCapped.has('assets/b.png')).toBe(false);
    });

    test('zlib.gunzipSync maxOutputLength cap blocks oversized gzip payloads', () => {
        const bombPayload = zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x61));
        expect(() => zlib.gunzipSync(bombPayload, { maxOutputLength: 64 * 1024 })).toThrow();
    });
});

describe('multerMonkeyPatch upload cleanup and path ownership (FN-MEDIUM-4)', () => {
    let tempRoot;
    let uploadsDir;
    let oldDataRoot;
    let server;
    let port;
    let queuedEnteredResolve;
    let queuedReleaseGatePromise;
    let queuedHandlerFinishedPromise;
    let queuedHandlerResult;

    beforeAll(async () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-multer-cleanup-'));
        uploadsDir = path.join(tempRoot, '_uploads');
        oldDataRoot = globalThis.DATA_ROOT;
        globalThis.DATA_ROOT = tempRoot;

        const storage = createUploadStorage(uploadsDir);
        const upload = multer({
            storage,
            limits: { fileSize: 1024 * 1024, files: 1 },
        }).single('avatar');

        const app = express();
        app.use(upload);
        app.use(multerMonkeyPatch);

        // Route that ignores req.file altogether
        app.post('/api/ping', (_req, res) => res.sendStatus(204));

        // Route that fails early before unlinking req.file (like missing API key on speech transcribe)
        app.post('/api/early-fail', (_req, res) => res.sendStatus(400));

        // Async route that reads req.file across an await before responding
        app.post('/api/async-read', async (req, res) => {
            await new Promise(resolve => setTimeout(resolve, 25));
            const existsDuringHandler = Boolean(req.file?.path && fs.existsSync(req.file.path));
            res.json({
                existsDuringHandler,
                originalName: req.file?.originalname ?? null,
                size: existsDuringHandler ? fs.statSync(req.file.path).size : 0,
            });
        });

        // Queued consumer route where the client socket closes BEFORE the handler opens req.file.path
        app.post('/api/queued-retain', async (req, res) => {
            let finishHandler;
            queuedHandlerFinishedPromise = new Promise((resolve) => {
                finishHandler = resolve;
            });
            try {
                queuedEnteredResolve?.();
                await queuedReleaseGatePromise;
                const content = fs.readFileSync(req.file.path, 'utf8');
                // Also verify that routes calling fs.unlinkSync(req.file.path) after await do not hit ENOENT
                fs.unlinkSync(req.file.path);
                queuedHandlerResult = { ok: true, content };
                res.json({ ok: true });
            } catch (error) {
                queuedHandlerResult = { ok: false, code: error.code, message: error.message };
                res.status(500).json({ error: error.message });
            } finally {
                finishHandler();
            }
        });

        // Queued consumer route where the handler does NOT manually unlink, relying on res.end cleanup even after early socket close
        app.post('/api/queued-no-unlink', async (req, res) => {
            let finishHandler;
            queuedHandlerFinishedPromise = new Promise((resolve) => {
                finishHandler = resolve;
            });
            try {
                queuedEnteredResolve?.();
                await queuedReleaseGatePromise;
                const content = fs.readFileSync(req.file.path, 'utf8');
                queuedHandlerResult = { ok: true, content, path: req.file.path };
                res.sendStatus(200);
            } finally {
                finishHandler();
            }
        });

        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                resolve();
            });
        });
    });

    afterAll(async () => {
        globalThis.DATA_ROOT = oldDataRoot;
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    function postMultipart(routePath, filename, contentBuffer) {
        const boundary = '----NeconyanTestBoundary7MA4YWxkTrZu0gW';
        const head = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="avatar"; filename="${filename}"\r\n` +
            'Content-Type: application/octet-stream\r\n\r\n',
            'utf8',
        );
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1');
        const body = Buffer.concat([head, contentBuffer, tail]);

        return new Promise((resolve, reject) => {
            const req = http.request(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: routePath,
                    method: 'POST',
                    headers: {
                        'Content-Type': `multipart/form-data; boundary=${boundary}`,
                        'Content-Length': body.length,
                    },
                },
                (res) => {
                    const chunks = [];
                    res.on('data', chunk => chunks.push(chunk));
                    res.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        resolve({ status: res.statusCode, text });
                    });
                },
            );
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    test('cleans up orphaned uploads on non-upload and early-failing routes while preserving file during async handler', async () => {
        const pingRes = await postMultipart('/api/ping', 'orphan.bin', Buffer.from('hello-orphan'));
        expect(pingRes.status).toBe(204);
        expect(fs.readdirSync(uploadsDir)).toEqual([]);

        const failRes = await postMultipart('/api/early-fail', 'failed.bin', Buffer.from('hello-fail'));
        expect(failRes.status).toBe(400);
        expect(fs.readdirSync(uploadsDir)).toEqual([]);

        const asyncRes = await postMultipart('/api/async-read', 'caf\u00e9.bin', Buffer.from('async-payload'));
        expect(asyncRes.status).toBe(200);
        expect(JSON.parse(asyncRes.text)).toEqual({
            existsDuringHandler: true,
            originalName: 'café.bin',
            size: 13,
        });
        expect(fs.readdirSync(uploadsDir)).toEqual([]);
    });

    test('preserves uploaded file when client socket closes early while queued consumer awaits prior work, then cleans up on completion', async () => {
        const boundary = '----NeconyanTestBoundary7MA4YWxkTrZu0gW';
        const buildMultipartBody = (filename, payload) => Buffer.concat([
            Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="avatar"; filename="${filename}"\r\n` +
                'Content-Type: application/octet-stream\r\n\r\n',
                'utf8',
            ),
            Buffer.from(payload, 'utf8'),
            Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
        ]);

        // Case 1: Queued handler reads and unlinks req.file.path AFTER client socket disconnects mid-flight
        let releaseGate;
        queuedReleaseGatePromise = new Promise((resolve) => {
            releaseGate = resolve;
        });
        const enteredPromise = new Promise((resolve) => {
            queuedEnteredResolve = resolve;
        });
        queuedHandlerResult = null;

        const body1 = buildMultipartBody('queued-1.zip', 'queued-archive-bytes-1');
        const req1 = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/api/queued-retain',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body1.length,
            },
        });
        req1.on('error', () => {});
        req1.write(body1);
        req1.end();

        // Wait until Multer has finished writing the upload and the route handler is waiting on the queue gate
        await enteredPromise;
        expect(fs.readdirSync(uploadsDir).length).toBe(1);

        // Abruptly destroy the client socket before the queued consumer opens req.file.path
        req1.destroy();
        await new Promise(resolve => setImmediate(resolve));

        // The uploaded file MUST still exist on disk while the queued handler is waiting
        expect(fs.readdirSync(uploadsDir).length).toBe(1);

        // Release the queue gate and wait for the handler to finish reading + unlinking
        releaseGate();
        await queuedHandlerFinishedPromise;
        expect(queuedHandlerResult).toEqual({
            ok: true,
            content: 'queued-archive-bytes-1',
        });
        expect(fs.readdirSync(uploadsDir)).toEqual([]);

        // Case 2: Queued handler does NOT unlink manually, client disconnects early, res.end still cleans up afterwards
        let releaseGate2;
        queuedReleaseGatePromise = new Promise((resolve) => {
            releaseGate2 = resolve;
        });
        const enteredPromise2 = new Promise((resolve) => {
            queuedEnteredResolve = resolve;
        });
        queuedHandlerResult = null;

        const body2 = buildMultipartBody('queued-2.zip', 'queued-archive-bytes-2');
        const req2 = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/api/queued-no-unlink',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body2.length,
            },
        });
        req2.on('error', () => {});
        req2.write(body2);
        req2.end();

        await enteredPromise2;
        expect(fs.readdirSync(uploadsDir).length).toBe(1);

        req2.destroy();
        await new Promise(resolve => setImmediate(resolve));
        expect(fs.readdirSync(uploadsDir).length).toBe(1);

        releaseGate2();
        await queuedHandlerFinishedPromise;
        await new Promise(resolve => setImmediate(resolve));
        expect(queuedHandlerResult?.ok).toBe(true);
        expect(queuedHandlerResult?.content).toBe('queued-archive-bytes-2');
        expect(fs.readdirSync(uploadsDir)).toEqual([]);
    });

    test('resolveOwnedUploadPath refuses paths outside the upload directory or with traversal segments', () => {
        expect(resolveOwnedUploadPath(null)).toBeNull();
        expect(resolveOwnedUploadPath({ destination: uploadsDir, filename: '../outside.txt' })).toBeNull();
        expect(resolveOwnedUploadPath({ destination: path.join(tempRoot, 'other'), filename: 'file.bin' })).toBeNull();
        expect(
            resolveOwnedUploadPath({
                destination: uploadsDir,
                filename: 'valid.bin',
                path: path.join(tempRoot, 'valid.bin'),
            }),
        ).toBeNull();

        const validPath = path.join(uploadsDir, 'abc123');
        expect(
            resolveOwnedUploadPath({
                destination: uploadsDir,
                filename: 'abc123',
                path: validPath,
            }),
        ).toBe(validPath);
    });
});

describe('transformers forced-model path validation (FN-MEDIUM-5)', () => {
    let tempRoot;
    let oldDataRoot;

    beforeAll(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-transformers-model-'));
        oldDataRoot = globalThis.DATA_ROOT;
        globalThis.DATA_ROOT = tempRoot;
    });

    afterAll(() => {
        globalThis.DATA_ROOT = oldDataRoot;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('accepts empty/omitted forceModel, valid HuggingFace repo IDs, and single-folder local model IDs', async () => {
        expect(validateForcedModelId('')).toBe('');
        expect(validateForcedModelId(undefined)).toBe('');
        expect(validateForcedModelId('Xenova/whisper-small')).toBe('Xenova/whisper-small');
        expect(validateForcedModelId('Cohee/distilbert-base-uncased-go-emotions-onnx')).toBe('Cohee/distilbert-base-uncased-go-emotions-onnx');
        expect(validateForcedModelId('local-custom-model_v1.0')).toBe('local-custom-model_v1.0');

        const pipe = await getPipeline('automatic-speech-recognition', 'Xenova/whisper-small');
        expect(await pipe()).toBe('Xenova/whisper-small');
    });

    test('rejects path traversal, URLs, Windows separators, and multi-segment paths in forceModel', async () => {
        const invalidModels = [
            '../outside',
            'Xenova/../outside',
            'Xenova/../../etc/passwd',
            '/etc/passwd',
            'C:\\Windows\\System32',
            'Xenova\\whisper-small',
            'https://evil.example/model',
            'Xenova/whisper-small/extra-segment',
            'Xenova/whisper?query=1',
            'Xenova/whisper#hash',
            '.hidden/model',
            'Xenova/.hidden',
            { bad: 'object' },
        ];

        for (const candidate of invalidModels) {
            expect(() => validateForcedModelId(candidate)).toThrow('Invalid local model identifier.');
            await expect(getPipeline('automatic-speech-recognition', candidate)).rejects.toThrow('Invalid local model identifier.');
        }
    });
});
