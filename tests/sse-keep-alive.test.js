import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { PassThrough } from 'node:stream';
import express from 'express';
import { Response } from 'node-fetch';

import {
    SSE_KEEP_ALIVE_COMMENT,
    endsAtEventBoundary,
    isEventStreamContentType,
    setEventStreamHeaders,
    startSseKeepAlive,
    testExports as keepAliveTestExports,
} from '../src/sse-keep-alive.js';
import {
    resumableGenerationMiddleware,
    router as resumableRouter,
    testExports as resumableTestExports,
} from '../src/resumable-generations.js';
import { forwardFetchResponse } from '../src/util.js';

const INTERVAL_MS = 30;
const COMMENT = SSE_KEEP_ALIVE_COMMENT;

function createFakeTimers() {
    const pending = new Map();
    let nextId = 1;
    return {
        pending,
        setTimer: jest.fn((callback, delay) => {
            const id = nextId++;
            pending.set(id, { callback, delay });
            return id;
        }),
        clearTimer: jest.fn(id => {
            pending.delete(id);
        }),
        fire() {
            const [id, entry] = [...pending][0];
            pending.delete(id);
            entry.callback();
        },
    };
}

function startWithFakeTimers(options = {}) {
    const timers = createFakeTimers();
    const write = jest.fn();
    const keepAlive = startSseKeepAlive({
        write,
        intervalMs: 1000,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        ...options,
    });
    return { timers, write, keepAlive };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('SSE keep-alive timer', () => {
    test('writes a comment only after a full quiet interval, and every chunk restarts the wait', () => {
        const { timers, write, keepAlive } = startWithFakeTimers();
        expect([...timers.pending.values()].map(entry => entry.delay)).toEqual([1000]);

        keepAlive.touch('data: {"a":1}\n\n');
        keepAlive.touch('data: {"b":2}\n\n');
        expect(timers.pending.size).toBe(1);
        expect(write).not.toHaveBeenCalled();

        timers.fire();
        expect(write).toHaveBeenCalledWith(COMMENT);
        expect(timers.pending.size).toBe(1);

        timers.fire();
        expect(write).toHaveBeenCalledTimes(2);
        keepAlive.stop();
    });

    test('never writes a comment inside an event that is still arriving', () => {
        const { timers, write, keepAlive } = startWithFakeTimers();
        keepAlive.touch(Buffer.from('data: {"par'));
        timers.fire();
        keepAlive.touch('tial":1}\n');
        timers.fire();
        expect(write).not.toHaveBeenCalled();
        expect(timers.pending.size).toBe(1);

        keepAlive.touch(new Uint8Array([10]));
        timers.fire();
        expect(write).toHaveBeenCalledWith(COMMENT);
        keepAlive.stop();
    });

    test('stop clears the waiting timer once and later chunks do not restart it', () => {
        const { timers, write, keepAlive } = startWithFakeTimers();
        keepAlive.stop();
        keepAlive.stop();
        expect(timers.pending.size).toBe(0);
        expect(timers.clearTimer).toHaveBeenCalledTimes(1);
        expect(keepAlive.stopped).toBe(true);

        keepAlive.touch('data: late\n\n');
        expect(timers.pending.size).toBe(0);
        expect(write).not.toHaveBeenCalled();
    });

    test('stops itself when the stream can no longer take writes or a write fails', () => {
        const closed = startWithFakeTimers({ isOpen: () => false });
        closed.timers.fire();
        expect(closed.write).not.toHaveBeenCalled();
        expect(closed.timers.pending.size).toBe(0);
        expect(closed.keepAlive.stopped).toBe(true);

        const failing = startWithFakeTimers({ write: jest.fn(() => { throw new Error('write after end'); }) });
        failing.timers.fire();
        expect(failing.timers.pending.size).toBe(0);
        expect(failing.keepAlive.stopped).toBe(true);
    });

    test('recognises event boundaries for LF and CRLF streams', () => {
        expect(endsAtEventBoundary('')).toBe(true);
        expect(endsAtEventBoundary('ta\n\n')).toBe(true);
        expect(endsAtEventBoundary('\r\n\r\n')).toBe(true);
        expect(endsAtEventBoundary('a\r\n\n')).toBe(true);
        expect(endsAtEventBoundary('ta: x')).toBe(false);
        expect(endsAtEventBoundary(' x\r\n')).toBe(false);
        expect(endsAtEventBoundary('ta\n')).toBe(false);
        // A lone CR may be the first half of a CRLF.
        expect(endsAtEventBoundary('\r\n\r')).toBe(false);
    });

    test('marks event-stream responses as unbuffered and keeps an existing content type', () => {
        const headers = new Map([['content-type', 'text/event-stream; charset=utf-8']]);
        const response = {
            headersSent: false,
            getHeader: name => headers.get(name.toLowerCase()),
            setHeader: (name, value) => headers.set(name.toLowerCase(), value),
        };
        expect(setEventStreamHeaders(response)).toBe(true);
        expect(Object.fromEntries(headers)).toEqual({
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'x-accel-buffering': 'no',
        });
        expect(setEventStreamHeaders({ ...response, headersSent: true })).toBe(false);
        expect(isEventStreamContentType(' Text/Event-Stream; charset=utf-8')).toBe(true);
        expect(isEventStreamContentType('application/json')).toBe(false);
        expect(isEventStreamContentType(null)).toBe(false);
    });
});

describe('streamed replies through the server', () => {
    let server;
    let baseUrl;
    const providers = new Map();
    const commentWrites = new Map();
    const closedResponses = new Set();
    let originalInterval;

    beforeAll(async () => {
        originalInterval = keepAliveTestExports.intervalMs;
        keepAliveTestExports.intervalMs = INTERVAL_MS;
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'sse-tester' } };
            next();
        });
        app.use('/api/resumable-generations', resumableRouter);
        app.use(resumableGenerationMiddleware);
        app.post('/stream', async (request, response) => {
            const id = request.get('x-test-id');
            const upstream = new PassThrough();
            providers.set(id, upstream);
            commentWrites.set(id, 0);
            const write = response.write;
            response.write = function (chunk, ...rest) {
                if (chunk === COMMENT) {
                    commentWrites.set(id, commentWrites.get(id) + 1);
                }
                return write.call(this, chunk, ...rest);
            };
            response.once('close', () => closedResponses.add(id));
            const provider = new Response(upstream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
            await forwardFetchResponse(provider, response, request);
        });
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        keepAliveTestExports.intervalMs = originalInterval;
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    });

    afterEach(() => {
        for (const upstream of providers.values()) {
            upstream.destroy();
        }
        providers.clear();
        resumableTestExports.generations.clear();
    });

    async function waitUntil(check, attempts = 200) {
        for (let attempt = 0; attempt < attempts && !check(); attempt++) {
            await sleep(5);
        }
        expect(check()).toBeTruthy();
    }

    async function openStream(id, headers = {}, signal = undefined) {
        const response = await fetch(`${baseUrl}/stream`, {
            method: 'POST',
            headers: { 'X-Test-Id': id, ...headers },
            signal,
        });
        await waitUntil(() => providers.has(id));
        return response;
    }

    function createReader(response) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const state = { text: '', bytes: 0 };
        return {
            state,
            reader,
            async readUntil(predicate) {
                while (!predicate(state.text)) {
                    const { value, done } = await reader.read();
                    if (done) {
                        break;
                    }
                    state.bytes += value.byteLength;
                    state.text += decoder.decode(value, { stream: true });
                }
                return state.text;
            },
        };
    }

    test('a plain streamed reply is unbuffered and stays alive through a quiet spell, then its timer stops', async () => {
        const id = 'plain-quiet';
        const response = await openStream(id);
        providers.get(id).write('data: {"a":1}\n\n');
        const reader = createReader(response);
        await reader.readUntil(text => text.includes(`data: {"a":1}\n\n${COMMENT}`));

        expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
        expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
        expect(response.headers.get('x-accel-buffering')).toBe('no');

        providers.get(id).end('data: [DONE]\n\n');
        const text = await reader.readUntil(() => false);
        expect(text).toMatch(/^(: keep-alive\n\n)*data: \{"a":1\}\n\n(: keep-alive\n\n)+data: \[DONE\]\n\n$/);

        const written = commentWrites.get(id);
        await sleep(INTERVAL_MS * 5);
        expect(commentWrites.get(id)).toBe(written);
    });

    test('a comment waits for an event that is still arriving', async () => {
        const id = 'plain-split';
        const response = await openStream(id);
        const reader = createReader(response);
        providers.get(id).write('data: {"par');
        await sleep(INTERVAL_MS * 4);
        providers.get(id).write('tial":1}\n\n');
        await reader.readUntil(text => text.endsWith(COMMENT));
        providers.get(id).end('data: [DONE]\n\n');
        const text = await reader.readUntil(() => false);
        expect(text).toMatch(/^(: keep-alive\n\n)*data: \{"partial":1\}\n\n(: keep-alive\n\n)+data: \[DONE\]\n\n$/);
    });

    test('a client that hangs up stops the comments and the provider stream', async () => {
        const id = 'plain-abort';
        const controller = new AbortController();
        const response = await openStream(id, {}, controller.signal);
        providers.get(id).write('data: {"a":1}\n\n');
        await createReader(response).readUntil(text => text.includes(COMMENT));

        const upstream = providers.get(id);
        controller.abort();
        await waitUntil(() => closedResponses.has(id));
        await waitUntil(() => upstream.destroyed);
        const written = commentWrites.get(id);
        await sleep(INTERVAL_MS * 5);
        expect(commentWrites.get(id)).toBe(written);
    });

    test('a resumable reply records its comments so a resumed reader keeps its place', async () => {
        const id = 'sse-resume-1';
        const response = await openStream(id, { 'X-Generation-Id': id });
        expect(response.headers.get('x-accel-buffering')).toBe('no');
        providers.get(id).write('data: {"a":1}\n\n');
        const reader = createReader(response);
        await reader.readUntil(text => text.includes(`data: {"a":1}\n\n${COMMENT}`));

        const generation = resumableTestExports.generations.get(`sse-tester:${id}`);
        expect(generation.keepAlive).not.toBeNull();
        await reader.reader.cancel();
        await waitUntil(() => !generation.attached);

        // Nobody is reading, so the stored reply does not grow with comments.
        const detachedSize = generation.size;
        await sleep(INTERVAL_MS * 5);
        expect(generation.size).toBe(detachedSize);

        providers.get(id).end('data: [DONE]\n\n');
        await waitUntil(() => generation.done);
        expect(generation.keepAlive).toBeNull();

        const resumed = await fetch(`${baseUrl}/api/resumable-generations/resume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, offset: reader.state.bytes }),
        });
        expect(resumed.status).toBe(200);
        expect(resumed.headers.get('x-accel-buffering')).toBe('no');
        expect(resumed.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
        const rest = await resumed.text();
        expect(rest).toMatch(/^(: keep-alive\n\n)*data: \[DONE\]\n\n$/);
        expect(reader.state.text + rest).toMatch(/^(: keep-alive\n\n)*data: \{"a":1\}\n\n(: keep-alive\n\n)+data: \[DONE\]\n\n$/);
    });

    test('a resume reader of a quiet reply gets comments too, and cancelling stops them', async () => {
        const id = 'sse-resume-live';
        const response = await openStream(id, { 'X-Generation-Id': id });
        providers.get(id).write('data: {"a":1}\n\n');
        const reader = createReader(response);
        await reader.readUntil(text => text.includes('data: {"a":1}'));
        const generation = resumableTestExports.generations.get(`sse-tester:${id}`);
        await reader.reader.cancel();
        await waitUntil(() => !generation.attached);

        const resumed = await fetch(`${baseUrl}/api/resumable-generations/resume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, offset: 0 }),
        });
        const resumeReader = createReader(resumed);
        await resumeReader.readUntil(text => text.includes(`data: {"a":1}\n\n${COMMENT}`));

        expect(generation.cancel()).toBe(true);
        expect(generation.keepAlive).toBeNull();
        const size = generation.size;
        await sleep(INTERVAL_MS * 5);
        expect(generation.size).toBe(size);
        const text = await resumeReader.readUntil(() => false);
        expect(text).toMatch(/^(: keep-alive\n\n)*data: \{"a":1\}\n\n(: keep-alive\n\n)+$/);
    });

    test('an in-process capture never receives comments', async () => {
        const capture = new PassThrough();
        capture.statusCode = 200;
        capture.socket = {};
        const headers = new Map();
        capture.getHeader = name => headers.get(name.toLowerCase());
        capture.setHeader = (name, value) => headers.set(name.toLowerCase(), value);
        const chunks = [];
        capture.on('data', chunk => chunks.push(chunk));
        const upstream = new PassThrough();
        const provider = new Response(upstream, { headers: { 'Content-Type': 'text/event-stream' } });

        await forwardFetchResponse(provider, capture, {});
        upstream.write('data: {"a":1}\n\n');
        await sleep(INTERVAL_MS * 4);
        upstream.end('data: [DONE]\n\n');
        await new Promise(resolve => capture.once('finish', resolve));

        expect(Buffer.concat(chunks).toString('utf8')).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
        expect(headers.get('x-accel-buffering')).toBe('no');
    });
});
