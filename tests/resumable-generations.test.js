import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import express from 'express';
import { Response } from 'node-fetch';

import { REQUEST_CANCELLATION_ABORT_REASON, observeRequestCancellation } from '../src/request-cancellation.js';
import {
    ResumableGeneration,
    resumableGenerationMiddleware,
    router,
    testExports,
} from '../src/resumable-generations.js';
import { forwardFetchResponse } from '../src/util.js';

function createMockRequest(id = 'test-generation-1') {
    const headers = { 'x-generation-id': id };
    return Object.assign(new EventEmitter(), {
        headers,
        socket: new EventEmitter(),
        user: { profile: { handle: 'tester' } },
        get(name) {
            return headers[String(name).toLowerCase()];
        },
    });
}

function createMockResponse() {
    const response = new PassThrough();
    response.statusCode = 200;
    response.statusMessage = '';
    response.socket = {};
    response.getHeader = () => undefined;
    return response;
}

/**
 * Runs the middleware and hands back the registered generation.
 */
function registerGeneration(id) {
    const request = createMockRequest(id);
    const response = createMockResponse();
    const next = jest.fn();
    resumableGenerationMiddleware(request, response, next);
    expect(next).toHaveBeenCalledTimes(1);
    return { request, response, generation: request.resumableGeneration };
}

function collect(generation, offset = 0) {
    return new Promise(resolve => {
        const chunks = [];
        generation.subscribe(offset, {
            onChunk: chunk => chunks.push(chunk),
            onEnd: () => resolve(Buffer.concat(chunks).toString('utf8')),
        });
    });
}

afterEach(() => {
    jest.restoreAllMocks();
    testExports.generations.clear();
    testExports.setTotalBufferedBytes(0);
});

describe('resumable generation registry', () => {
    test('ignores requests without a usable generation id', () => {
        const request = createMockRequest('not valid!');
        const response = createMockResponse();
        const next = jest.fn();

        resumableGenerationMiddleware(request, response, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(request.resumableGeneration).toBeUndefined();
        expect(testExports.generations.size).toBe(0);
    });

    test('mirrors everything the handler writes and replays it from an offset', async () => {
        const { response, generation } = registerGeneration('mirror-1');
        response.statusCode = 201;
        const headers = { 'content-type': 'text/plain' };
        response.getHeader = name => headers[String(name).toLowerCase()];

        response.write('hello ');
        response.end('world');

        expect(generation.done).toBe(true);
        expect(generation.statusCode).toBe(201);
        expect(generation.contentType).toBe('text/plain');
        expect(generation.size).toBe(11);
        expect(testExports.totalBufferedBytes).toBe(11);
        await expect(collect(generation)).resolves.toBe('hello world');
        await expect(collect(generation, 6)).resolves.toBe('world');
        expect(testExports.generations.get('tester:mirror-1')).toBe(generation);
    });

    test('live subscribers get the bytes written after they attached', async () => {
        const { response, generation } = registerGeneration('live-stream-1');

        response.write('one,');
        const collected = collect(generation, 2);
        response.write('two,');
        response.end('three');

        await expect(collected).resolves.toBe('e,two,three');
    });

    test('discards an overflowing generation and releases its buffered bytes', () => {
        const { generation } = registerGeneration('overflow-1');
        const subscriber = {
            onChunk: jest.fn(),
            onEnd: jest.fn(),
            onFail: jest.fn(),
        };
        generation.subscribe(0, subscriber);
        const cancelHook = jest.fn();
        generation.onCancel(cancelHook);

        generation.write(Buffer.alloc(testExports.MAX_BUFFER_BYTES));
        generation.write('overflow');

        expect(subscriber.onChunk).toHaveBeenCalledTimes(1);
        expect(subscriber.onFail).toHaveBeenCalledTimes(1);
        expect(subscriber.onEnd).not.toHaveBeenCalled();
        expect(cancelHook).toHaveBeenCalledTimes(1);
        expect(generation.cancelled).toBe(true);
        expect(generation.done).toBe(true);
        expect(testExports.generations.has('tester:overflow-1')).toBe(false);
        expect(generation.chunks).toHaveLength(0);
        expect(generation.size).toBe(0);
    });

    test('does not double-end the attached response when overflow cancellation ends it', async () => {
        const { response, generation } = registerGeneration('overflow-response');
        const errors = [];
        response.on('error', error => errors.push(error));
        generation.onCancel(() => response.end());

        response.write(Buffer.alloc(testExports.MAX_BUFFER_BYTES));
        response.end('overflow');
        await new Promise(resolve => setImmediate(resolve));

        expect(errors).toHaveLength(0);
        expect(generation.done).toBe(true);
    });

    test('discarding an active generation cancels, finishes, and releases it', () => {
        const { response, generation } = registerGeneration('capacity-active');
        response.write('buffered');
        const subscriber = {
            onChunk: jest.fn(),
            onEnd: jest.fn(),
            onFail: jest.fn(),
        };
        generation.subscribe(0, subscriber);
        const cancelHook = jest.fn(() => response.end());
        generation.onCancel(cancelHook);

        generation.forceDiscard();

        expect(cancelHook).toHaveBeenCalledTimes(1);
        expect(subscriber.onFail).toHaveBeenCalledTimes(1);
        expect(subscriber.onEnd).not.toHaveBeenCalled();
        expect(generation.cancelled).toBe(true);
        expect(generation.done).toBe(true);
        expect(testExports.generations.has('tester:capacity-active')).toBe(false);
        expect(generation.chunks).toHaveLength(0);
        expect(generation.size).toBe(0);
    });

    test('evicting a finished generation does not cancel it', () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { response, generation } = registerGeneration('capacity-finished');
        const cancelHook = jest.fn();
        generation.onCancel(cancelHook);
        response.end('buffered');

        for (let index = 0; index < testExports.MAX_GENERATIONS; index++) {
            registerGeneration(`finished-${index}`);
        }

        expect(cancelHook).not.toHaveBeenCalled();
        expect(generation.cancelled).toBe(false);
        expect(generation.done).toBe(true);
        expect(testExports.generations.has('tester:capacity-finished')).toBe(false);
        expect(generation.chunks).toHaveLength(0);
        expect(generation.size).toBe(0);
    });

    test('re-registering an id cancels the superseded generation', () => {
        jest.spyOn(console, 'info').mockImplementation(() => undefined);
        const first = registerGeneration('replayed-1');
        const cancelHook = jest.fn();
        first.generation.onCancel(cancelHook);

        const second = registerGeneration('replayed-1');

        expect(cancelHook).toHaveBeenCalledTimes(1);
        expect(first.generation.cancelled).toBe(true);
        expect(first.generation.done).toBe(true);
        expect(second.generation).not.toBe(first.generation);
        expect(testExports.generations.get('tester:replayed-1')).toBe(second.generation);
    });

    test('re-registering an id drops the finished reply\'s buffered copy', () => {
        const first = registerGeneration('replayed-2');
        first.response.end('all done');
        const cancelHook = jest.fn();
        first.generation.onCancel(cancelHook);

        registerGeneration('replayed-2');

        expect(cancelHook).not.toHaveBeenCalled();
        expect(first.generation.done).toBe(true);
        expect(first.generation.size).toBe(0);
        expect(testExports.totalBufferedBytes).toBe(0);
    });

    test('cancel runs each hook once and removes recovery even after the reply finished', () => {
        const generation = new ResumableGeneration('tester:hooks');
        const hook = jest.fn();
        generation.onCancel(hook);

        expect(generation.cancel()).toBe(true);
        expect(generation.cancel()).toBe(false);
        expect(hook).toHaveBeenCalledTimes(1);

        const finished = new ResumableGeneration('tester:finished');
        finished.context = { chatId: 'chat-a' };
        const lateHook = jest.fn();
        finished.end();
        finished.onCancel(lateHook);

        expect(finished.cancel()).toBe(false);
        expect(lateHook).not.toHaveBeenCalled();
        expect(finished.context).toBeNull();
    });

    test('sweep drops finished replies after retention and cancels ones that ran too long', () => {
        const { response: finishedResponse, generation: finished } = registerGeneration('sweep-finished');
        finishedResponse.end('done');
        const { generation: running } = registerGeneration('sweep-running');
        const hook = jest.fn();
        running.onCancel(hook);

        const now = Date.now();
        testExports.sweepGenerations(now + testExports.FINISHED_RETENTION_MS - 1000);
        expect(testExports.generations.has('tester:sweep-finished')).toBe(true);
        expect(testExports.generations.has('tester:sweep-running')).toBe(true);

        testExports.sweepGenerations(now + testExports.FINISHED_RETENTION_MS + 1000);
        expect(testExports.generations.has('tester:sweep-finished')).toBe(false);
        expect(testExports.generations.has('tester:sweep-running')).toBe(true);
        expect(hook).not.toHaveBeenCalled();

        testExports.sweepGenerations(now + testExports.MAX_LIFETIME_MS + 1000);
        expect(testExports.generations.has('tester:sweep-running')).toBe(false);
        expect(hook).toHaveBeenCalledTimes(1);
        expect(running.done).toBe(true);
        expect(finished.done).toBe(true);
    });

    test('waiting for headers can be cancelled when the waiting client disappears', async () => {
        const { generation } = registerGeneration('waiter-1');
        const wait = generation.waitForHeaders();
        expect(generation.headerWaiters).toHaveLength(1);

        wait.cancel();
        await expect(wait.promise).resolves.toBeUndefined();
        expect(generation.headerWaiters).toHaveLength(0);

        const late = generation.waitForHeaders();
        generation.captureHeaders({ statusCode: 201, statusMessage: '', getHeader: () => undefined });
        await expect(late.promise).resolves.toBeUndefined();
        expect(generation.headerWaiters).toHaveLength(0);
    });

    test('request aborted without response close detaches the generation while keeping provider work and retained bytes intact', async () => {
        const { request, response, generation } = registerGeneration('request-aborted-only');
        const cancelHook = jest.fn();
        generation.onCancel(cancelHook);

        expect(generation.attached).toBe(true);
        response.write('before-abort ');
        request.emit('aborted');
        expect(generation.attached).toBe(false);
        expect(generation.cancelled).toBe(false);
        expect(cancelHook).not.toHaveBeenCalled();

        // Provider continues writing and finishes after the client request aborted.
        response.write('after-abort ');
        response.end('complete');
        // Repeated disconnect/completion signals are harmless.
        request.emit('aborted');
        response.emit('finish');
        response.emit('close');

        expect(generation.attached).toBe(false);
        expect(generation.done).toBe(true);
        expect(generation.cancelled).toBe(false);
        expect(cancelHook).not.toHaveBeenCalled();
        await expect(collect(generation, 0)).resolves.toBe('before-abort after-abort complete');
        await expect(collect(generation, 13)).resolves.toBe('after-abort complete');
    });

    test('abandoned pre-header and live /resume requests release waiters and subscriptions on request aborted', async () => {
        const { response: originResponse, generation } = registerGeneration('resume-request-aborted');
        const cancelHook = jest.fn();
        generation.onCancel(cancelHook);
        const resumeHandler = router.stack.find(layer => layer.route?.path === '/resume').route.stack[0].handle;

        // 1. Pre-header resume abandoned via request 'aborted' only.
        const preReq = Object.assign(new EventEmitter(), {
            user: { profile: { handle: 'tester' } },
            body: { id: 'resume-request-aborted', offset: 0 },
        });
        const preWrites = [];
        const preRes = Object.assign(new EventEmitter(), {
            status: () => preRes,
            setHeader() {},
            flushHeaders() {},
            sendStatus: jest.fn(),
            write: chunk => preWrites.push(chunk),
            end() { this.writableEnded = true; },
            destroy() { this.destroyed = true; },
        });
        const prePromise = resumeHandler(preReq, preRes);
        expect(generation.headerWaiters).toHaveLength(1);
        preReq.emit('aborted');
        await prePromise;
        expect(generation.headerWaiters).toHaveLength(0);
        expect(generation.subscribers.size).toBe(0);
        expect(preRes.sendStatus).not.toHaveBeenCalled();

        // 2. Headers arrive and first chunk is written; live resume attaches and then aborts via request 'aborted' only.
        originResponse.write('chunk-1 ');
        expect(preWrites).toHaveLength(0);

        const liveReq = Object.assign(new EventEmitter(), {
            user: { profile: { handle: 'tester' } },
            body: { id: 'resume-request-aborted', offset: 0 },
        });
        const liveWrites = [];
        const liveRes = Object.assign(new EventEmitter(), {
            status: () => liveRes,
            setHeader() {},
            flushHeaders() {},
            sendStatus: jest.fn(),
            write: chunk => liveWrites.push(chunk),
            end() { this.writableEnded = true; },
            destroy() { this.destroyed = true; },
        });
        await resumeHandler(liveReq, liveRes);
        expect(generation.subscribers.size).toBe(1);
        expect(Buffer.concat(liveWrites).toString('utf8')).toBe('chunk-1 ');

        liveReq.emit('aborted');
        liveReq.emit('aborted');
        liveRes.emit('finish');
        liveRes.emit('close');
        expect(generation.subscribers.size).toBe(0);
        expect(generation.cancelled).toBe(false);
        expect(cancelHook).not.toHaveBeenCalled();

        // Further provider writes are retained on the generation without writing to the abandoned resume response.
        originResponse.end('chunk-2');
        expect(Buffer.concat(liveWrites).toString('utf8')).toBe('chunk-1 ');
        await expect(collect(generation, 0)).resolves.toBe('chunk-1 chunk-2');
    });

    test('Bun native handle onabort rebinds after request close, detaches generation, releases resume reader, and runs original callback once', async () => {
        const handleSymbol = Symbol('handle');
        const originOriginalOnAbort = jest.fn();
        const originHandle = { aborted: false, onabort: originOriginalOnAbort };
        const originReq = createMockRequest('bun-handle-abort');
        const originRes = createMockResponse();
        originRes[handleSymbol] = originHandle;
        resumableGenerationMiddleware(originReq, originRes, jest.fn());
        const generation = originReq.resumableGeneration;

        // Simulate Bun's IncomingMessage._destroy clearing handle.onabort right before request 'close'.
        originHandle.onabort = undefined;
        originReq.emit('close');
        expect(typeof originHandle.onabort).toBe('function');

        originRes.write('live-part ');
        const resumeHandler = router.stack.find(layer => layer.route?.path === '/resume').route.stack[0].handle;
        const resumeOriginalOnAbort = jest.fn();
        const resumeHandle = { aborted: false, onabort: resumeOriginalOnAbort };
        const resumeReq = Object.assign(new EventEmitter(), {
            user: { profile: { handle: 'tester' } },
            body: { id: 'bun-handle-abort', offset: 0 },
        });
        const resumeRes = Object.assign(new EventEmitter(), {
            [Symbol('handle')]: resumeHandle,
            status: () => resumeRes,
            setHeader() {},
            flushHeaders() {},
            sendStatus: jest.fn(),
            write() {},
            end() { this.writableEnded = true; },
            destroy() { this.destroyed = true; },
        });
        await resumeHandler(resumeReq, resumeRes);
        expect(generation.subscribers.size).toBe(1);

        resumeHandle.onabort = undefined;
        resumeReq.emit('close');
        expect(typeof resumeHandle.onabort).toBe('function');

        originHandle.onabort();
        expect(generation.attached).toBe(false);
        expect(originOriginalOnAbort).toHaveBeenCalledTimes(1);
        expect(originHandle.onabort).toBe(originOriginalOnAbort);

        resumeHandle.onabort();
        expect(generation.subscribers.size).toBe(0);
        expect(resumeOriginalOnAbort).toHaveBeenCalledTimes(1);
        expect(resumeHandle.onabort).toBe(resumeOriginalOnAbort);
    });
});

describe('registry capacity', () => {
    /**
     * Registers a generation for a synthetic profile, bypassing the tester helper.
     */
    function registerFor(handle, id) {
        const request = createMockRequest(id);
        request.user = { profile: { handle } };
        const response = createMockResponse();
        const next = jest.fn();
        resumableGenerationMiddleware(request, response, next);
        expect(next).toHaveBeenCalledTimes(1);
        return { request, response, generation: request.resumableGeneration };
    }

    let fillerCount = 0;

    /**
     * Adds a live filler registration spread over synthetic profiles.
     */
    function addLiveFiller() {
        const bucket = Math.floor(fillerCount / testExports.MAX_GENERATIONS_PER_PROFILE);
        fillerCount++;
        return registerFor(`filler-${bucket}`, `filler${String(fillerCount).padStart(6, '0')}`);
    }

    afterEach(() => {
        fillerCount = 0;
    });

    test('a full registry never discards another profile\'s live generation', () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const victim = registerGeneration('victim-1');
        victim.response.write('live');
        const cancelHook = jest.fn();
        victim.generation.onCancel(cancelHook);

        while (testExports.generations.size < testExports.MAX_GENERATIONS) {
            addLiveFiller();
        }
        expect(testExports.generations.size).toBe(testExports.MAX_GENERATIONS);

        const latecomer = registerFor('filler-late', 'latecomer-00001');

        expect(latecomer.generation).toBeUndefined();
        expect(cancelHook).not.toHaveBeenCalled();
        expect(victim.generation.cancelled).toBe(false);
        expect(testExports.generations.has('tester:victim-1')).toBe(true);
        expect(testExports.generations.size).toBe(testExports.MAX_GENERATIONS);
    });

    test('an over-cap profile keeps its live generations and serves the newest without resume support', () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const first = registerGeneration('own-000000');
        const cancelHook = jest.fn();
        first.generation.onCancel(cancelHook);
        for (let index = 1; index < testExports.MAX_GENERATIONS_PER_PROFILE; index++) {
            registerGeneration(`own-${String(index).padStart(6, '0')}`);
        }
        expect(testExports.generations.size).toBe(testExports.MAX_GENERATIONS_PER_PROFILE);

        const newest = registerGeneration('own-newest');

        expect(newest.generation).toBeUndefined();
        expect(cancelHook).not.toHaveBeenCalled();
        expect(first.generation.cancelled).toBe(false);
        expect(first.generation.done).toBe(false);
        expect(testExports.generations.has('tester:own-000000')).toBe(true);
        expect(testExports.generations.has('tester:own-newest')).toBe(false);
        expect(testExports.generations.size).toBe(testExports.MAX_GENERATIONS_PER_PROFILE);
    });

    test('an over-cap profile makes room from its finished replies first, then from ones it already cancelled', () => {
        const finished = registerGeneration('own-finished');
        finished.response.end('cached');
        const stopped = registerGeneration('own-stopped');
        stopped.generation.cancel();
        for (let index = 2; index < testExports.MAX_GENERATIONS_PER_PROFILE; index++) {
            registerGeneration(`own-${String(index).padStart(6, '0')}`);
        }

        expect(registerGeneration('own-after-finished').generation).toBeDefined();
        expect(testExports.generations.has('tester:own-finished')).toBe(false);
        expect(testExports.generations.has('tester:own-stopped')).toBe(true);

        expect(registerGeneration('own-after-stopped').generation).toBeDefined();
        expect(testExports.generations.has('tester:own-stopped')).toBe(false);
        expect(testExports.generations.size).toBe(testExports.MAX_GENERATIONS_PER_PROFILE);
    });

    test('global pressure drops finished replies before touching live ones', () => {
        const finished = registerGeneration('finished-spare');
        finished.response.end('cached');
        const live = registerGeneration('live-keep');
        live.response.write('running');

        while (testExports.generations.size < testExports.MAX_GENERATIONS) {
            addLiveFiller();
        }
        addLiveFiller();

        expect(testExports.generations.has('tester:finished-spare')).toBe(false);
        expect(finished.generation.cancelled).toBe(false);
        expect(testExports.generations.has('tester:live-keep')).toBe(true);
        expect(live.generation.cancelled).toBe(false);
        expect(testExports.generations.size).toBe(testExports.MAX_GENERATIONS);
    });

    test('the global byte budget frees finished replies before overflowing a live one', () => {
        const spare = registerGeneration('budget-spare');
        spare.response.write(Buffer.alloc(1000));
        spare.response.end();

        const live = registerGeneration('budget-live');
        testExports.setTotalBufferedBytes(testExports.MAX_TOTAL_BUFFER_BYTES - 500);

        live.response.write(Buffer.alloc(800));

        expect(testExports.generations.has('tester:budget-spare')).toBe(false);
        expect(live.generation.overflowed).toBe(false);
        expect(live.generation.size).toBe(800);
        expect(testExports.totalBufferedBytes).toBe(testExports.MAX_TOTAL_BUFFER_BYTES - 700);
    });

    test('a live reply overflows instead of breaking the global byte budget', () => {
        const live = registerGeneration('budget-overflow');
        const subscriber = { onChunk: jest.fn(), onEnd: jest.fn(), onFail: jest.fn() };
        live.generation.subscribe(0, subscriber);
        testExports.setTotalBufferedBytes(testExports.MAX_TOTAL_BUFFER_BYTES);

        live.generation.write('too much');

        expect(live.generation.overflowed).toBe(true);
        expect(subscriber.onFail).toHaveBeenCalledTimes(1);
        expect(live.generation.size).toBe(0);
        // Only the simulated outside pressure remains; the discarded reply gave its bytes back.
        expect(testExports.totalBufferedBytes).toBe(testExports.MAX_TOTAL_BUFFER_BYTES);
        expect(testExports.generations.has('tester:budget-overflow')).toBe(false);
    });
});

describe('resumable generations and the disconnect guards', () => {
    test('drains a reply whose client disappeared before the provider sent headers', async () => {
        const { request, response, generation } = registerGeneration('forward-before-headers');
        response.emit('close');
        response.socket = null;
        const upstreamBody = new PassThrough();
        const collected = collect(generation);
        await forwardFetchResponse(new Response(upstreamBody), response, request);
        upstreamBody.end('complete reply');
        await expect(collected).resolves.toBe('complete reply');
    });

    test('retains the remaining bytes even when the disconnected response is already ended', async () => {
        const { request, response, generation } = registerGeneration('forward-ended-client');
        const upstreamBody = new PassThrough();
        const collected = collect(generation);
        await forwardFetchResponse(new Response(upstreamBody), response, request);
        upstreamBody.write('first ');
        response.emit('close');
        Object.defineProperty(response, 'writableEnded', { value: true });
        upstreamBody.end('last');
        await expect(collected).resolves.toBe('first last');
    });

    test('forwardFetchResponse keeps draining upstream after the client response closes', async () => {
        const { request, response, generation } = registerGeneration('forward-1');
        const upstreamBody = new PassThrough();
        const destroySpy = jest.spyOn(upstreamBody, 'destroy');
        const onDisconnect = jest.fn();
        const collected = collect(generation);

        await forwardFetchResponse(new Response(upstreamBody), response, request, onDisconnect);
        upstreamBody.write('data: first\n\n');
        response.emit('close');
        expect(destroySpy).not.toHaveBeenCalled();
        expect(onDisconnect).not.toHaveBeenCalled();

        // Everything upstream sends after the client left still lands in the generation.
        upstreamBody.write('data: second\n\n');
        upstreamBody.end('data: [DONE]\n\n');

        await expect(collected).resolves.toBe('data: first\n\ndata: second\n\ndata: [DONE]\n\n');
        expect(onDisconnect).not.toHaveBeenCalled();
        expect(generation.done).toBe(true);
    });

    test('cancelling a forwarded generation runs the provider hook and destroys upstream', async () => {
        const { request, response, generation } = registerGeneration('forward-cancel');
        const upstreamBody = new PassThrough();
        const destroySpy = jest.spyOn(upstreamBody, 'destroy');
        const onDisconnect = jest.fn();

        await forwardFetchResponse(new Response(upstreamBody), response, request, onDisconnect);
        upstreamBody.write('data: first\n\n');
        expect(generation.cancel()).toBe(true);

        expect(onDisconnect).toHaveBeenCalledTimes(1);
        expect(destroySpy).toHaveBeenCalledTimes(1);
        expect(generation.done).toBe(true);
        expect(response.writableEnded).toBe(true);
    });

    test('an upstream failure mid-reply is reported and still ends the held reply', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { request, response, generation } = registerGeneration('forward-upstream-error');
        response.reportStreamError = jest.fn();
        const upstreamBody = new PassThrough();
        const collected = collect(generation);
        await forwardFetchResponse(new Response(upstreamBody), response, request);
        upstreamBody.write('data: first\n\n');
        upstreamBody.destroy(new Error('socket hang up'));
        await expect(collected).resolves.toBe('data: first\n\n');
        expect(response.reportStreamError).toHaveBeenCalledWith(expect.objectContaining({ message: 'socket hang up' }));
        expect(generation.done).toBe(true);
    });

    test('observeRequestCancellation ignores client disconnects and aborts on an explicit cancel', () => {
        const { request, response, generation } = registerGeneration('observe-1');
        const controller = new AbortController();

        observeRequestCancellation(request, response, { controller });
        response.emit('close');
        request.socket.emit('close');
        expect(controller.signal.aborted).toBe(false);

        generation.cancel();
        expect(controller.signal.aborted).toBe(true);
        expect(controller.signal.reason).toBe(REQUEST_CANCELLATION_ABORT_REASON);
    });

    test('observeRequestCancellation still aborts on disconnect for ordinary requests', () => {
        const request = { socket: new EventEmitter() };
        const response = createMockResponse();
        const controller = new AbortController();

        observeRequestCancellation(request, response, { controller });
        response.emit('close');

        expect(controller.signal.aborted).toBe(true);
    });
});

describe('resumable generation routes', () => {
    let server;
    let baseUrl;
    /** @type {Map<string, () => void>} */
    const pendingHandlers = new Map();
    /** @type {Map<string, () => void>} */
    const heldReleases = new Map();
    const cancelled = new Set();

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'route-tester' } };
            next();
        });
        app.use('/api/resumable-generations', router);
        app.use(resumableGenerationMiddleware);
        app.post('/generate', (request, response) => {
            const id = request.get('x-generation-id');
            request.resumableGeneration.onCancel(() => {
                cancelled.add(id);
                response.end();
            });
            response.status(201);
            response.setHeader('Content-Type', 'text/plain');
            const release = () => {
                response.write('first-');
                pendingHandlers.set(id, () => {
                    response.write('second-');
                    response.end('done');
                });
            };
            if (new URL(request.url, 'http://localhost').searchParams.has('hold')) {
                heldReleases.set(id, release);
            } else {
                release();
            }
        });

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    });

    async function waitUntil(check) {
        for (let attempt = 0; attempt < 200 && !check(); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    function postJson(path, body, init = {}) {
        return fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            ...init,
        });
    }

    async function startGeneration(id, query = '') {
        const promise = fetch(`${baseUrl}/generate${query}`, { method: 'POST', headers: { 'X-Generation-Id': id } });
        if (query) {
            // A held handler writes nothing, so the response headers only arrive on release.
            return promise;
        }
        const original = await promise;
        await original.body.getReader().read();
        return original;
    }

    test('resume is a 404 for a reply the server does not have', async () => {
        const response = await postJson('/api/resumable-generations/resume', { id: 'never-registered', offset: 0 });
        expect(response.status).toBe(404);
    });

    test('replays the rest of a reply whose client went away, with the original status', async () => {
        const id = 'route-resume-1';
        const original = await fetch(`${baseUrl}/generate`, { method: 'POST', headers: { 'X-Generation-Id': id } });
        const reader = original.body.getReader();
        const first = await reader.read();
        expect(original.status).toBe(201);
        expect(new TextDecoder().decode(first.value)).toBe('first-');

        // The client drops off mid-reply; the handler only finishes afterwards.
        await reader.cancel();
        pendingHandlers.get(id)();

        const resumed = await postJson('/api/resumable-generations/resume', { id, offset: 6 });
        expect(resumed.status).toBe(200);
        expect(resumed.headers.get('x-generation-status')).toBe('201');
        expect(resumed.headers.get('content-type')).toContain('text/plain');
        expect(resumed.headers.get('cache-control')).toContain('no-store');
        await expect(resumed.text()).resolves.toBe('second-done');

        const fromStart = await postJson('/api/resumable-generations/resume', { id, offset: 0 });
        await expect(fromStart.text()).resolves.toBe('first-second-done');

        const beyond = await postJson('/api/resumable-generations/resume', { id, offset: 999 });
        expect(beyond.status).toBe(416);
    });

    test('a resume that attaches before the reply finishes streams the live tail', async () => {
        const id = 'route-resume-live';
        const original = await fetch(`${baseUrl}/generate`, { method: 'POST', headers: { 'X-Generation-Id': id } });
        await original.body.getReader().read();

        const resumedPromise = postJson('/api/resumable-generations/resume', { id, offset: 0 });
        await new Promise(resolve => setTimeout(resolve, 50));
        pendingHandlers.get(id)();

        const resumed = await resumedPromise;
        await expect(resumed.text()).resolves.toBe('first-second-done');
    });

    test('cancel stops a running reply and reports 404 afterwards for unknown ids', async () => {
        const id = 'route-cancel-1';
        const original = await fetch(`${baseUrl}/generate`, { method: 'POST', headers: { 'X-Generation-Id': id } });
        await original.body.getReader().read();

        const cancel = await postJson('/api/resumable-generations/cancel', { id });
        expect(cancel.status).toBe(204);
        expect(cancelled.has(id)).toBe(true);

        const unknown = await postJson('/api/resumable-generations/cancel', { id: 'nobody-home' });
        expect(unknown.status).toBe(404);
    });

    test('a reply serves at most MAX_RESUME_CLIENTS concurrent resumes', async () => {
        const id = 'route-subscriber-limit';
        await startGeneration(id);

        const openReaders = Array.from({ length: testExports.MAX_RESUME_CLIENTS }, () =>
            postJson('/api/resumable-generations/resume', { id, offset: 0 }));
        await new Promise(resolve => setTimeout(resolve, 50));

        const rejected = await postJson('/api/resumable-generations/resume', { id, offset: 0 });
        expect(rejected.status).toBe(429);

        pendingHandlers.get(id)();
        for (const reader of await Promise.all(openReaders)) {
            expect(reader.status).toBe(200);
            await expect(reader.text()).resolves.toBe('first-second-done');
        }
    });

    test('at most MAX_RESUME_CLIENTS resumes may queue for a slow handler', async () => {
        const id = 'route-waiter-limit';
        const original = startGeneration(id, '?hold=1');

        const waiting = Array.from({ length: testExports.MAX_RESUME_CLIENTS }, () =>
            postJson('/api/resumable-generations/resume', { id, offset: 0 }));
        await new Promise(resolve => setTimeout(resolve, 50));

        const rejected = await postJson('/api/resumable-generations/resume', { id, offset: 0 });
        expect(rejected.status).toBe(503);

        heldReleases.get(id)();
        pendingHandlers.get(id)();
        await (await original).text();
        for (const reader of await Promise.all(waiting)) {
            expect(reader.status).toBe(200);
            await expect(reader.text()).resolves.toBe('first-second-done');
        }
    });

    test('a resume whose connection dies while waiting frees its waiter slot', async () => {
        const id = 'route-waiter-gone';
        const original = startGeneration(id, '?hold=1');

        const waiting = Array.from({ length: testExports.MAX_RESUME_CLIENTS - 1 }, () =>
            postJson('/api/resumable-generations/resume', { id, offset: 0 }));
        const aborter = new AbortController();
        const doomed = postJson('/api/resumable-generations/resume', { id, offset: 0 }, { signal: aborter.signal });
        await new Promise(resolve => setTimeout(resolve, 50));

        aborter.abort();
        await expect(doomed).rejects.toThrow();
        await new Promise(resolve => setTimeout(resolve, 50));

        // The freed slot must admit a fresh waiter instead of answering 503.
        const accepted = postJson('/api/resumable-generations/resume', { id, offset: 0 });
        await new Promise(resolve => setTimeout(resolve, 50));
        heldReleases.get(id)();
        pendingHandlers.get(id)();
        await (await original).text();

        for (const reader of await Promise.all([...waiting, accepted])) {
            expect(reader.status).toBe(200);
            await expect(reader.text()).resolves.toBe('first-second-done');
        }
    });

    const encodeContext = (context) => Buffer.from(JSON.stringify(context), 'utf8').toString('base64');

    test('list shows only jobs that carried a context, with attach state, and discard drops them', async () => {
        const context = { v: 1, chatId: 'chat-1', type: 'normal', name2: 'Néko' };
        const heldId = 'route-list-held';
        const original = await fetch(`${baseUrl}/generate`, {
            method: 'POST',
            headers: { 'X-Generation-Id': heldId, 'X-Generation-Context': encodeContext(context) },
        });
        const reader = original.body.getReader();
        await reader.read();
        const plain = await fetch(`${baseUrl}/generate`, { method: 'POST', headers: { 'X-Generation-Id': 'route-list-plain' } });
        const plainReader = plain.body.getReader();
        await plainReader.read();
        pendingHandlers.get('route-list-plain')();
        while (!(await plainReader.read()).done) { /* drain */ }

        let listed = await (await postJson('/api/resumable-generations/list', {})).json();
        let job = listed.jobs.find(entry => entry.id === heldId);
        expect(listed.jobs.map(entry => entry.id)).not.toContain('route-list-plain');
        expect(job).toMatchObject({ id: heldId, status: 'running', attached: true, context, statusCode: 201 });

        await reader.cancel();
        pendingHandlers.get(heldId)();
        await new Promise(resolve => setTimeout(resolve, 50));

        listed = await (await postJson('/api/resumable-generations/list', {})).json();
        job = listed.jobs.find(entry => entry.id === heldId);
        expect(job).toMatchObject({ status: 'finished', attached: false, size: 'first-second-done'.length });
        expect(typeof job.finishedAt).toBe('number');

        // A context-bearing reply outlives the short retention window.
        testExports.sweepGenerations(job.finishedAt + testExports.FINISHED_RETENTION_MS + 1);
        expect(testExports.generations.has(`route-tester:${heldId}`)).toBe(true);
        expect(testExports.generations.has('route-tester:route-list-plain')).toBe(false);

        expect((await postJson('/api/resumable-generations/discard', { id: heldId })).status).toBe(204);
        expect((await postJson('/api/resumable-generations/discard', { id: heldId })).status).toBe(404);
        listed = await (await postJson('/api/resumable-generations/list', {})).json();
        expect(listed.jobs.map(entry => entry.id)).not.toContain(heldId);
    });

    test('cancel forgets the context and malformed or oversized contexts are ignored', async () => {
        const cancelledId = 'route-list-cancelled';
        const original = await fetch(`${baseUrl}/generate`, {
            method: 'POST',
            headers: { 'X-Generation-Id': cancelledId, 'X-Generation-Context': encodeContext({ v: 1 }) },
        });
        const cancelledReader = original.body.getReader();
        await cancelledReader.read();
        await postJson('/api/resumable-generations/cancel', { id: cancelledId });
        while (!(await cancelledReader.read()).done) { /* drain */ }

        for (const [id, raw] of [['route-ctx-bad', 'not base64 json'], ['route-ctx-big', encodeContext({ pad: 'x'.repeat(9000) })], ['route-ctx-array', encodeContext([1, 2])]]) {
            const response = await fetch(`${baseUrl}/generate`, { method: 'POST', headers: { 'X-Generation-Id': id, 'X-Generation-Context': raw } });
            const reader = response.body.getReader();
            await reader.read();
            expect(testExports.generations.get(`route-tester:${id}`).context).toBeNull();
            pendingHandlers.get(id)();
            while (!(await reader.read()).done) { /* drain */ }
        }

        const listed = await (await postJson('/api/resumable-generations/list', {})).json();
        expect(listed.jobs.map(entry => entry.id)).toEqual(expect.not.arrayContaining([cancelledId, 'route-ctx-bad', 'route-ctx-big', 'route-ctx-array']));
    });

    test('real HTTP disconnects before headers and during live resume release waiters, subscriptions and attachment', async () => {
        const id = 'route-http-disconnect-probe';
        const port = server.address().port;
        const context = { v: 1, chatId: 'chat-probe', type: 'normal' };

        const origReq = http.request({
            host: '127.0.0.1',
            port,
            path: '/generate?hold=1',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Generation-Id': id,
                'X-Generation-Context': encodeContext(context),
            },
        });
        origReq.on('error', () => {});
        origReq.end('{}');
        await waitUntil(() => testExports.generations.has(`route-tester:${id}`));

        const generation = testExports.generations.get(`route-tester:${id}`);
        expect(generation).toBeDefined();
        origReq.destroy();
        await waitUntil(() => !generation.attached);
        expect(generation.attached).toBe(false);
        expect(generation.cancelled).toBe(false);

        const abandonedPreHeader = http.request({
            host: '127.0.0.1',
            port,
            path: '/api/resumable-generations/resume',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        abandonedPreHeader.on('error', () => {});
        abandonedPreHeader.end(JSON.stringify({ id, offset: 0 }));
        await waitUntil(() => generation.headerWaiters.length === 1);
        expect(generation.headerWaiters).toHaveLength(1);
        abandonedPreHeader.destroy();
        await waitUntil(() => generation.headerWaiters.length === 0);
        expect(generation.headerWaiters).toHaveLength(0);

        heldReleases.get(id)();
        const abandonedLive = http.request({
            host: '127.0.0.1',
            port,
            path: '/api/resumable-generations/resume',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        abandonedLive.on('error', () => {});
        abandonedLive.end(JSON.stringify({ id, offset: 0 }));
        await waitUntil(() => generation.subscribers.size === 1);
        expect(generation.subscribers.size).toBe(1);
        abandonedLive.destroy();
        await waitUntil(() => generation.subscribers.size === 0);
        expect(generation.subscribers.size).toBe(0);

        pendingHandlers.get(id)();
        await waitUntil(() => generation.done);
        expect(generation.done).toBe(true);
        expect(generation.attached).toBe(false);
        expect(generation.cancelled).toBe(false);

        const listed = await (await postJson('/api/resumable-generations/list', {})).json();
        expect(listed.jobs.find(entry => entry.id === id)).toMatchObject({
            id,
            status: 'finished',
            attached: false,
            size: 'first-second-done'.length,
        });

        const fullReplay = await postJson('/api/resumable-generations/resume', { id, offset: 0 });
        await expect(fullReplay.text()).resolves.toBe('first-second-done');
        const offsetReplay = await postJson('/api/resumable-generations/resume', { id, offset: 6 });
        await expect(offsetReplay.text()).resolves.toBe('second-done');
    });
});
