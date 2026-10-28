/* global globalThis */
/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-jobs-http-'));
globalThis.DATA_ROOT = root;

const { router: jobsRouter } = await import('../src/endpoints/jobs.js');
const { JOB_INTENT_LIMIT_BYTES, JOB_INTENT_MAX_BYTES, acceptJob, attachOwnedChild, getJob, setJobState, updateJob } = await import('../src/jobs/store.js');
const { roleplayHash, roleplayAccountStamp, initialiseRoleplayAccount, roleplayStoreDirectory } = await import('../src/roleplay-store.js');
const { publishRoleplayPreview, subscribeRoleplayPreview } = await import('../src/generation/roleplay-preview.js');
const { publishConversationPreview } = await import('../src/generation/conversation-preview.js');
const { registerHandler, setDirectoriesResolver, abortJob, testExports: runner } = await import('../src/jobs/runner.js');
const { writeArtifact } = await import('../src/jobs/artifacts.js');
const { pcmWave } = await import('../src/jobs/audio-artifacts.js');
const { notifyJobsChanged } = await import('../src/jobs/notifications.js');
const { beginDiagnosticAgent, endDiagnosticAgent } = await import('../src/diagnostic-activity.js');

process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

function account(name) {
    const userRoot = path.join(root, name);
    fs.mkdirSync(userRoot, { recursive: true });
    return { root: userRoot };
}

const aliceDirs = account('alice');
const bobDirs = account('bob');
const accounts = { alice: aliceDirs, bob: bobDirs };

const app = express();
// The real server mounts a jobs-specific parser before its 500mb parser. This
// mirrors that boundary so an oversized intent is rejected without crashing.
app.use('/api/jobs', express.json({ limit: JOB_INTENT_LIMIT_BYTES }));
app.use(express.json({ limit: '500mb' }));
app.use((request, _response, next) => {
    request.user = { profile: { handle: request.headers['x-account'] }, directories: accounts[request.headers['x-account']] };
    next();
});
app.use('/api/jobs', jobsRouter);
app.use((error, _request, response, _next) => {
    // Express body-parser errors carry a status; the process must stay alive.
    response.status(error.status ?? 500).json({ error: error.message });
});

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));

function request(method, pathname, { account: who = 'alice', body, headers = {} } = {}) {
    return fetch(url + pathname, {
        method,
        headers: { 'X-Account': who, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

function submit(owner, { key = 'h1', intent = { operation: 'roleplay' } } = {}) {
    return request('POST', '/api/jobs/submit', { account: owner, body: { type: 'roleplay', submissionKey: key, intent } });
}

/** Reads `data:` frames from a fetched event stream, skipping keepalives. */
function sseReader(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return {
        reader,
        async nextFrame() {
            for (;;) {
                const boundary = buffer.indexOf('\n\n');
                if (boundary >= 0) {
                    const event = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    if (event.startsWith('data: ')) return JSON.parse(event.slice(6));
                    continue;
                }
                const chunk = await reader.read();
                if (chunk.done) return null;
                buffer += decoder.decode(chunk.value, { stream: true });
            }
        },
    };
}

function roleplayStreamContext(parentJobId, childId) {
    return { owner: 'alice', directories: aliceDirs, job: { id: childId,
        intent: { request: { characterName: 'Nova', workflowCandidate: { parentJobId } } } } };
}

test('native Conversation, Roleplay and media work cannot bypass its own acceptance endpoint', async () => {
    for (const type of ['conversation.reply', 'roleplay.reply', 'roleplay.caption', 'media.images', 'media.speech', 'media.sprites']) {
        const bypass = await request('POST', '/api/jobs/submit', {
            account: 'alice', body: { type, submissionKey: `bypass-${type}`, intent: {} },
        });
        assert.equal(bypass.status, 400, `the generic route refuses ${type}`);
    }
});

test('stale browser account headers refuse every job route before accessing the new account', async () => {
    const { job } = await (await submit('bob', { key: 'stale-tab' })).json();
    const before = await (await request('GET', '/api/jobs/list', { account: 'bob' })).json();
    for (const [method, suffix] of [['GET', '/list'], ['GET', '/events'], ['GET', '/capacity'], ['GET', `/${job.id}`], ['GET', `/${job.id}/result`], ['GET', `/${job.id}/preview`],
        ['POST', '/submit'], ['POST', `/${job.id}/cancel`], ['POST', `/${job.id}/dismiss`], ['POST', `/${job.id}/retry`]]) {
        const response = await request(method, '/api/jobs' + suffix, { account: 'bob', headers: { 'X-Neconyan-Account': 'alice' },
            body: method === 'POST' ? { type: 'roleplay', submissionKey: 'blocked', intent: {} } : undefined });
        assert.equal(response.status, 409, suffix);
        assert.equal((await response.json()).error, 'account_changed');
    }
    assert.deepEqual(await (await request('GET', '/api/jobs/list', { account: 'bob', headers: { 'X-Neconyan-Account': 'bob' } })).json(), before);
});

test('change streams announce only the signed-in account and never carry job content', async () => {
    const controller = new AbortController();
    const response = await fetch(url + '/api/jobs/events', {
        headers: { 'X-Account': 'alice', 'X-Neconyan-Account': 'alice' }, signal: controller.signal,
    });
    const reader = response.body.getReader();
    try {
        assert.match(response.headers.get('content-type'), /text\/event-stream/);
        assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {}\n\n');
        await submit('bob', { key: 'private-change', intent: { private: 'must never appear' } });
        const pending = reader.read();
        assert.equal(await Promise.race([pending.then(() => 'received'), new Promise(resolve => setTimeout(() => resolve('quiet'), 60))]), 'quiet');
        const { job } = await (await submit('alice', { key: 'visible-change' })).json();
        updateJob(aliceDirs, job.id, { state: 'completed', result: { private: 'also not streamed' } });
        assert.equal(new TextDecoder().decode((await pending).value), 'data: {}\n\n');
        assert.equal(getJob(aliceDirs, job.id).state, 'completed');
    } finally { controller.abort(); reader.releaseLock(); }
});

test('an oversized or ill-typed job request cannot crash the server', async () => {
    const huge = await request('POST', '/api/jobs/submit', {
        body: { type: 'roleplay', submissionKey: 'big', intent: { blob: 'x'.repeat(JOB_INTENT_LIMIT_BYTES + 1024) } },
    });
    assert.equal(huge.status, 413, 'the jobs parser refuses an oversized body before the general one');

    const bad = await request('POST', '/api/jobs/submit', { body: { type: 123, submissionKey: { a: 1 }, intent: 'nope' } });
    assert.equal(bad.status, 400);
    const stillAlive = await request('GET', '/api/jobs/list');
    assert.equal(stillAlive.status, 200, 'the process is still serving after a bad request');

    // An intent inside the HTTP limit but over the store limit is still refused.
    const tooBigForLedger = await request('POST', '/api/jobs/submit', {
        body: { type: 'roleplay', submissionKey: 'ledger', intent: { blob: 'x'.repeat(JOB_INTENT_MAX_BYTES + 1024) } },
    });
    assert.equal(tooBigForLedger.status, 400);
});

test('job reads, cancels and capacity are isolated between two accounts', async () => {
    const aliceJob = await (await submit('alice', { key: 'iso-a' })).json();
    const bobJob = await (await submit('bob', { key: 'iso-b' })).json();
    assert.notEqual(aliceJob.job.id, bobJob.job.id);

    // Bob cannot read or cancel Alice's job by id.
    assert.equal((await request('GET', `/api/jobs/${aliceJob.job.id}`, { account: 'bob' })).status, 404);
    assert.equal((await request('POST', `/api/jobs/${aliceJob.job.id}/cancel`, { account: 'bob' })).status, 404);
    assert.equal((await request('GET', `/api/jobs/${aliceJob.job.id}`, { account: 'alice' })).status, 200);

    // Cancelling through the endpoint is durable and owner-scoped.
    const cancelled = await request('POST', `/api/jobs/${bobJob.job.id}/cancel`, { account: 'bob' });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).job.state, 'cancelled');
    assert.equal((await request('GET', `/api/jobs/${bobJob.job.id}`, { account: 'bob' })).status, 200);

    // Capacity reports global totals and the caller's own count only.
    const capacity = await (await request('GET', '/api/jobs/capacity', { account: 'alice' })).json();
    assert.ok(capacity.capacity.global >= 0);
    assert.equal(typeof capacity.capacity.you, 'number');
    assert.equal(capacity.capacity.users, undefined, 'other account handles must not be exposed');
    assert.equal(JSON.stringify(capacity).includes('bob'), false, 'no other account name leaks');

    const aliceList = await (await request('GET', '/api/jobs/list', { account: 'alice' })).json();
    assert.ok(aliceList.jobs.every(job => job.owner === 'alice'));
});

test('prepared audio artifacts are owner-scoped and served as bytes', async () => {
    const { job } = await (await submit('alice', { key: 'audio-a' })).json();
    const name = 'narration:reply:0';
    const wave = pcmWave(Buffer.alloc(480));
    writeArtifact(aliceDirs, job.id, name, { mimeType: 'audio/wav', base64: wave.toString('base64') });
    const path = `/api/jobs/${job.id}/audio/${encodeURIComponent(name)}`;

    const mine = await request('GET', path, { account: 'alice' });
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get('content-type'), 'audio/wav');
    assert.equal(mine.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await mine.arrayBuffer()), wave);

    assert.equal((await request('GET', path, { account: 'bob' })).status, 404, 'another account cannot read the audio');
    assert.equal((await request('GET', `/api/jobs/${job.id}/audio/missing`, { account: 'alice' })).status, 404, 'a missing artifact is not found');
    const truncatedWave = Buffer.from(wave.subarray(0, wave.length - 2));
    for (const invalid of [{ mimeType: 'text/html', base64: 'PHNjcmlwdD4=' },
        { mimeType: 'audio/wav', base64: Buffer.from('RIFFfake').toString('base64') },
        { mimeType: 'audio/wav', base64: Buffer.from('RIFF\x04\x00\x00\x00WAVE', 'binary').toString('base64') },
        { mimeType: 'audio/wav', base64: truncatedWave.toString('base64') }]) {
        writeArtifact(aliceDirs, job.id, name, invalid);
        assert.equal((await request('GET', path, { account: 'alice' })).status, 409, 'corrupt saved audio requires recovery');
    }
    writeArtifact(aliceDirs, job.id, name, { ok: false, error: 'offline' });
    assert.equal((await request('GET', path, { account: 'alice' })).status, 404);
});

test('live reply previews are account-scoped and disconnecting never cancels the job', async () => {
    const base = { owner: 'alice', directories: aliceDirs };
    initialiseRoleplayAccount(base);
    const account = roleplayAccountStamp(base);
    const { job } = acceptJob(aliceDirs, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: 'live-preview',
        intent: { media: account, request: {} } });
    const child = { id: 'preview-child', intent: { request: { characterName: 'Nova', workflowCandidate: { parentJobId: job.id } } } };
    const context = { ...base, job: child };
    const pathname = `/api/jobs/${job.id}/preview`;
    assert.equal((await request('GET', pathname, { account: 'bob' })).status, 404);
    const response = await request('GET', pathname);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const initialFrame = new TextDecoder().decode((await reader.read()).value).split('\n\n').find(line => line.startsWith('data: '));
    const initialValue = JSON.parse(initialFrame.slice(6));
    assert.ok(Number.isFinite(initialValue.serverTime));
    assert.ok(Math.abs(Date.now() - initialValue.serverTime) < 10000);
    const unsubscribe = subscribeRoleplayPreview('alice', job.id, () => { throw new Error('lost viewer'); });
    assert.doesNotThrow(() => publishRoleplayPreview(context, { stage: 'generating', text: 'First token' }));
    unsubscribe();
    let received = '';
    while (!received.includes('First token')) received += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.equal(getJob(aliceDirs, job.id).cancellation.requested, false);
    publishRoleplayPreview(context, { stage: 'companions', text: 'Completed main reply' });
    const reopened = await request('GET', pathname);
    const reopenedReader = reopened.body.getReader();
    assert.match(new TextDecoder().decode((await reopenedReader.read()).value), /Completed main reply/);
    await reopenedReader.cancel();
    assert.equal(getJob(aliceDirs, job.id).cancellation.requested, false);
});

test('a roleplay preview opens full and then sends only appended deltas', async () => {
    const base = { owner: 'alice', directories: aliceDirs };
    initialiseRoleplayAccount(base);
    const { job } = acceptJob(aliceDirs, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: 'delta-frames',
        intent: { media: roleplayAccountStamp(base), request: {} } });
    const context = roleplayStreamContext(job.id, 'delta-child');
    const controller = new AbortController();
    const response = await fetch(`${url}/api/jobs/${job.id}/preview?frames=delta`, { headers: { 'X-Account': 'alice' }, signal: controller.signal });
    const stream = sseReader(response);
    try {
        const initial = await stream.nextFrame();
        assert.equal(initial.preview.stage, 'preparing', 'every connection opens with a full snapshot');
        assert.equal(initial.delta, undefined);
        publishRoleplayPreview(context, { stage: 'generating', text: 'Hello' });
        const first = await stream.nextFrame();
        assert.equal(first.preview?.text, 'Hello', 'a candidate and stage change is a full snapshot, written at once');
        assert.equal(first.delta, undefined);
        // A measurable moment later, so the snapshot's own timestamp has moved.
        await new Promise(resolve => setTimeout(resolve, 5));
        publishRoleplayPreview(context, { text: 'Hello world' });
        const second = await stream.nextFrame();
        assert.equal(second.preview, undefined);
        assert.equal(second.delta.text, ' world', 'growth arrives as the appended suffix only');
        assert.ok(Number.isFinite(second.serverTime));
        assert.equal(second.delta.set?.stage, undefined, 'unchanged metadata is omitted');
        assert.ok(second.delta.set?.updatedAt, 'changed metadata rides along');
        publishRoleplayPreview(context, { stage: 'agents', text: 'Hello world!' });
        const third = await stream.nextFrame();
        assert.equal(third.delta.text, '!');
        assert.equal(third.delta.set.stage, 'agents', 'a stage change bypasses the write limit');
        // The finished job writes its final frame against this connection's
        // baseline, then the terminal state, and closes.
        setJobState(aliceDirs, job.id, 'completed');
        notifyJobsChanged({ owner: 'alice', id: job.id });
        const finalFrame = await stream.nextFrame();
        assert.equal(finalFrame.state, undefined, 'the retained preview is written before the state');
        assert.deepEqual(finalFrame.delta, {}, 'the final frame carries nothing the reader is missing');
        const stateFrame = await stream.nextFrame();
        assert.equal(stateFrame.state, 'completed');
    } finally { controller.abort(); stream.reader.releaseLock(); }
});

test('a roleplay preview without the delta opt-in keeps receiving full snapshots', async () => {
    const base = { owner: 'alice', directories: aliceDirs };
    const { job } = acceptJob(aliceDirs, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: 'full-frames-compat',
        intent: { media: roleplayAccountStamp(base), request: {} } });
    const context = roleplayStreamContext(job.id, 'compat-child');
    const controller = new AbortController();
    // An already-open older reader uses exactly this URL and parses only `preview`.
    const response = await fetch(`${url}/api/jobs/${job.id}/preview`, { headers: { 'X-Account': 'alice' }, signal: controller.signal });
    const stream = sseReader(response);
    try {
        const initial = await stream.nextFrame();
        assert.equal(initial.preview.stage, 'preparing');
        assert.equal(initial.delta, undefined);
        publishRoleplayPreview(context, { stage: 'generating', text: 'Hello' });
        const first = await stream.nextFrame();
        assert.equal(first.preview?.text, 'Hello');
        assert.equal(first.delta, undefined);
        publishRoleplayPreview(context, { text: 'Hello again' });
        const second = await stream.nextFrame();
        assert.equal(second.preview?.text, 'Hello again', 'growth is still a complete snapshot');
        assert.equal(second.delta, undefined);
        publishRoleplayPreview(context, { stage: 'agents', text: 'Hello again!' });
        const third = await stream.nextFrame();
        assert.equal(third.preview?.text, 'Hello again!');
        assert.equal(third.preview?.stage, 'agents');
        assert.equal(third.delta, undefined);
        // The finished job still writes the whole reply and then the state.
        setJobState(aliceDirs, job.id, 'completed');
        notifyJobsChanged({ owner: 'alice', id: job.id });
        let frame = await stream.nextFrame();
        while (frame && !frame.state) {
            assert.equal(frame.delta, undefined, 'every frame before the state is a full snapshot');
            assert.equal(frame.preview.text, 'Hello again!', 'the terminal frame repeats the whole reply');
            frame = await stream.nextFrame();
        }
        assert.equal(frame?.state, 'completed');
    } finally { controller.abort(); stream.reader.releaseLock(); }
});

test('a burst of roleplay publishes coalesces into a single trailing delta frame', async () => {
    const base = { owner: 'alice', directories: aliceDirs };
    const { job } = acceptJob(aliceDirs, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: 'delta-burst',
        intent: { media: roleplayAccountStamp(base), request: {} } });
    const context = roleplayStreamContext(job.id, 'burst-child');
    const controller = new AbortController();
    const response = await fetch(`${url}/api/jobs/${job.id}/preview?frames=delta`, { headers: { 'X-Account': 'alice' }, signal: controller.signal });
    const stream = sseReader(response);
    try {
        await stream.nextFrame();
        publishRoleplayPreview(context, { stage: 'generating', text: 'one' });
        const first = await stream.nextFrame();
        assert.equal(first.preview?.text, 'one');
        for (let index = 2; index <= 20; index++) publishRoleplayPreview(context, { text: 'one' + 'x'.repeat(index * 3) });
        const frame = await stream.nextFrame();
        assert.equal(frame.delta.text, 'x'.repeat(60), 'the whole burst arrives as one appended suffix');
        const raced = await Promise.race([
            stream.nextFrame().then(received => (received ? 'frame' : 'closed')).catch(() => 'aborted'),
            new Promise(resolve => setTimeout(() => resolve('quiet'), 300)),
        ]);
        assert.equal(raced, 'quiet', 'a coalesced burst writes exactly one delta');
    } finally { controller.abort(); stream.reader.releaseLock(); }
});

test('roleplay preview writes pause on backpressure, coalesce while draining and keep one drain listener', async () => {
    const base = { owner: 'alice', directories: aliceDirs };
    const { job } = acceptJob(aliceDirs, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: 'preview-backpressure',
        intent: { media: roleplayAccountStamp(base), request: {} } });
    const request = Object.assign(new EventEmitter(), {
        user: { profile: { handle: 'alice' }, directories: aliceDirs }, params: { id: job.id }, get: () => 'alice',
        query: { frames: 'delta' },
    });
    const writes = [];
    let flow = true;
    const response = Object.assign(new EventEmitter(), {
        set: () => response, flushHeaders() {}, writableLength: 0,
        write: value => { writes.push(value); return flow; },
        end() { this.writableEnded = true; },
    });
    const context = roleplayStreamContext(job.id, 'pressure-child');
    try {
        jobsRouter.stack.find(layer => layer.route?.path === '/:id/preview').route.stack[0].handle(request, response);
        flow = false;
        publishRoleplayPreview(context, { stage: 'generating', text: 'first' });
        const afterFirst = writes.length;
        assert.equal(response.listenerCount('drain'), 1, 'a full socket buffer arms exactly one drain listener');
        publishRoleplayPreview(context, { text: 'first second' });
        publishRoleplayPreview(context, { text: 'first second third' });
        assert.equal(writes.length, afterFirst, 'nothing is written while the socket drains');
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(writes.length, afterFirst, 'the throttle keeps coalescing while draining');
        flow = true;
        response.emit('drain');
        assert.equal(writes.length, afterFirst + 1, 'the coalesced latest preview is written once after drain');
        const frame = JSON.parse(writes[writes.length - 1].slice('data: '.length).split('\n\n')[0]);
        assert.equal(frame.delta.text, ' second third');
        assert.equal(response.listenerCount('drain'), 0, 'the drain listener is consumed and not re-armed while flowing');
        // A reader that never drains hits the byte cutoff instead of growing forever.
        response.writableLength = 2 * 1024 * 1024;
        publishRoleplayPreview(context, { stage: 'agents', text: 'too much' });
        assert.equal(response.writableEnded, true, 'the byte cutoff ends the stream');
        const finalWrites = writes.length;
        response.emit('close');
        publishRoleplayPreview(context, { text: 'after close' });
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(writes.length, finalWrites, 'cleanup unsubscribes the abandoned stream');
    } finally {
        response.emit('close');
    }
});

test('conversation previews keep sending unchanged full snapshots', async () => {
    const { job } = acceptJob(aliceDirs, { owner: 'alice', type: 'conversation.reply', submissionKey: 'conversation-full-frames', intent: {} });
    const controller = new AbortController();
    const response = await fetch(`${url}/api/jobs/${job.id}/preview`, { headers: { 'X-Account': 'alice' }, signal: controller.signal });
    const stream = sseReader(response);
    const speaker = { owner: 'alice', job: { id: 'speaker-a', parentId: job.id } };
    const snapshot = { target: { avatar: 'one.png', branchId: 'main' }, speaker: { avatar: 'one.png', name: 'One' } };
    try {
        const initial = await stream.nextFrame();
        assert.deepEqual(initial.preview, { participants: [] });
        publishConversationPreview(speaker, snapshot, { text: 'Hello', token_count: 1 });
        const first = await stream.nextFrame();
        assert.equal(first.preview.participants[0].text, 'Hello');
        assert.equal(first.delta, undefined);
        await new Promise(resolve => setTimeout(resolve, 80));
        publishConversationPreview(speaker, snapshot, { text: 'Hello there', token_count: 2 });
        const second = await stream.nextFrame();
        assert.equal(second.preview.participants[0].text, 'Hello there', 'conversation growth is still a full snapshot');
        assert.equal(second.delta, undefined, 'the conversation protocol is unchanged');
        publishConversationPreview(speaker, snapshot, null);
    } finally { controller.abort(); stream.reader.releaseLock(); }
});

for (const routePath of ['/events', '/:id/preview']) {
    test(`${routePath} releases its timers when Bun aborts only the request`, async () => {
        const base = { owner: 'alice', directories: aliceDirs };
        const { job } = acceptJob(aliceDirs, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: `abort-${routePath}`,
            intent: { media: roleplayAccountStamp(base), request: {} } });
        const request = Object.assign(new EventEmitter(), {
            user: { profile: { handle: 'alice' }, directories: aliceDirs }, params: { id: job.id }, get: () => 'alice',
        });
        const writes = [];
        const response = Object.assign(new EventEmitter(), {
            set: () => response, flushHeaders() {}, write: value => writes.push(value), end() { this.writableEnded = true; },
        });
        const timers = new Set();
        const setInterval = globalThis.setInterval;
        const clearInterval = globalThis.clearInterval;
        globalThis.setInterval = callback => { timers.add(callback); return callback; };
        globalThis.clearInterval = timer => { if (!timers.delete(timer)) clearInterval(timer); };
        try {
            jobsRouter.stack.find(layer => layer.route?.path === routePath).route.stack[0].handle(request, response);
            assert.equal(timers.size, 1);
            // Bun 1.3 reports request.aborted without response.close on client disconnect.
            request.emit('aborted');
            assert.equal(timers.size, 0, 'an abandoned preview must stop re-reading the account and job');
            const before = writes.length;
            updateJob(aliceDirs, job.id, { progress: { message: 'Still running without its viewer' } });
            publishRoleplayPreview({ ...base, job: { id: 'aborted-child', intent: { request: { workflowCandidate: { parentJobId: job.id } } } } },
                { stage: 'generating', text: 'Still running' });
            await new Promise(resolve => setTimeout(resolve, 80));
            assert.equal(writes.length, before, 'the abandoned stream unsubscribes from further updates');
            assert.equal(getJob(aliceDirs, job.id).cancellation.requested, false);
            response.emit('finish');
            response.emit('close');
            assert.equal(timers.size, 0, 'cleanup tolerates later completion signals');
        } finally {
            response.emit('close');
            globalThis.setInterval = setInterval;
            globalThis.clearInterval = clearInterval;
        }
    });
}

test('a live reply preview re-reads the protected account only after its job changes', async () => {
    const base = { owner: 'alice', directories: aliceDirs };
    const { job } = acceptJob(aliceDirs, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: 'preview-change-driven',
        intent: { media: roleplayAccountStamp(base), request: {} } });
    const stateFile = path.join(roleplayStoreDirectory(base), 'state.json');
    const original = fs.readFileSync(stateFile);
    const request = Object.assign(new EventEmitter(), {
        user: { profile: { handle: 'alice' }, directories: aliceDirs }, params: { id: job.id }, get: () => 'alice',
    });
    const writes = [];
    const response = Object.assign(new EventEmitter(), {
        set: () => response, flushHeaders() {}, write: value => writes.push(value), end() { this.writableEnded = true; },
    });
    const timers = new Set();
    const setInterval = globalThis.setInterval;
    const clearInterval = globalThis.clearInterval;
    globalThis.setInterval = callback => { timers.add(callback); return callback; };
    globalThis.clearInterval = timer => { if (!timers.delete(timer)) clearInterval(timer); };
    try {
        jobsRouter.stack.find(layer => layer.route?.path === '/:id/preview').route.stack[0].handle(request, response);
        const [tick] = timers;
        // Damaged account bytes go unnoticed while nothing changes: a quiet tick only sends a keepalive.
        fs.writeFileSync(stateFile, '{}');
        const before = writes.length;
        tick();
        assert.equal(response.writableEnded, undefined);
        assert.deepEqual(writes.slice(before), [': keepalive\n\n']);
        fs.writeFileSync(stateFile, original);
        setJobState(aliceDirs, job.id, 'completed');
        tick();
        assert.equal(response.writableEnded, true);
        assert.match(writes.join(''), /"state":"completed"/);
    } finally {
        fs.writeFileSync(stateFile, original);
        response.emit('close');
        globalThis.setInterval = setInterval;
        globalThis.clearInterval = clearInterval;
    }
});

test('cancelling a root interrupts a running vector grandchild before another stage', { timeout: 10000 }, async () => {
    const root = acceptJob(aliceDirs, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: 'nested-root', intent: {} }).job;
    const reply = acceptJob(aliceDirs, { owner: 'alice', type: 'roleplay.reply', submissionKey: 'nested-reply', intent: {} }).job;
    const vectors = acceptJob(aliceDirs, { owner: 'alice', type: 'operations.vectors', submissionKey: 'nested-vectors', intent: {} }).job;
    for (const [parent, child] of [[root, reply], [reply, vectors]]) attachOwnedChild(aliceDirs, parent.id, child.id,
        { parentIntentHash: roleplayHash(parent.intent), childIntentHash: roleplayHash(child.intent) });
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    let aborted = false;
    registerHandler('operations.vectors', async ({ signal }) => {
        started();
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
            aborted = true;
            reject(signal.reason);
        }, { once: true }));
        assert.fail('Cancelled retrieval must not dispatch another stage');
    });
    setDirectoriesResolver(() => aliceDirs);
    const running = runner.runJob(vectors);
    try {
        await ready;
        const response = await request('POST', `/api/jobs/${root.id}/cancel`);
        assert.equal(response.status, 200);
        assert.equal(getJob(aliceDirs, root.id).state, 'cancelled',
            'a vector grandchild never defers the reply root terminal state');
        await running;
        assert.equal(aborted, true);
        assert.equal(getJob(aliceDirs, vectors.id).state, 'cancelled');
        assert.equal(getJob(aliceDirs, reply.id).cancellation.requested, true);
    } finally {
        abortJob(vectors.id);
        await running;
        setDirectoriesResolver(null);
    }
});

test('an account with a damaged ledger gets an actionable error while healthy accounts keep working', async () => {
    fs.mkdirSync(path.join(bobDirs.root, 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(bobDirs.root, 'jobs', 'index.json'), '{broken');
    const broken = await request('GET', '/api/jobs/list', { account: 'bob' });
    assert.equal(broken.status, 409);
    const body = await broken.json();
    assert.equal(body.code, 'JOB_STORE_RECOVERABLE');
    assert.match(body.error, /recovery|repair|trust/i);
    const healthy = await request('GET', '/api/jobs/list', { account: 'alice' });
    assert.equal(healthy.status, 200, 'the healthy account is unaffected by the damaged one');
});

test('a diagnostic-only change writes one diagnostics frame and never job content', async () => {
    const controller = new AbortController();
    const response = await fetch(url + '/api/jobs/events', {
        headers: { 'X-Account': 'alice', 'X-Neconyan-Account': 'alice' }, signal: controller.signal,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
        assert.equal(decoder.decode((await reader.read()).value), 'data: {}\n\n');
        // Regex steps skip the throttled hint, so this frame is exactly the one we trigger.
        const handle = beginDiagnosticAgent({ owner: 'alice', job: { id: 'hint-root', intent: {} } },
            { id: 'builtin', sourceTemplateId: 'tpl-proofreader', phase: 'regex' });
        try {
            notifyJobsChanged({ owner: 'alice', id: 'hint-root', diagnosticOnly: true });
            let frame = '';
            while (!frame.includes('diagnostics')) frame += decoder.decode((await reader.read()).value);
            assert.match(frame, /^data: /);
            const parsed = JSON.parse(frame.slice(6));
            assert.equal(parsed.diagnostics.id, 'hint-root');
            assert.equal(parsed.diagnostics.activity.agents.running[0].label, 'Proofreader');
            assert.equal(JSON.stringify(parsed).includes('private'), false);
            // A normal change still coalesces into an empty job-content frame.
            notifyJobsChanged({ owner: 'alice', id: 'hint-root' });
            let normal = '';
            while (!normal.includes('data: {}')) normal += decoder.decode((await reader.read()).value);
        } finally { endDiagnosticAgent(handle); }
    } finally { controller.abort(); reader.releaseLock(); }
});

test('a diagnostic-only change does not make the live preview re-read the job', async () => {
    const base = { owner: 'alice', directories: aliceDirs };
    const { job } = acceptJob(aliceDirs, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: 'preview-diagnostic-only',
        intent: { media: roleplayAccountStamp(base), request: {} } });
    const stateFile = path.join(roleplayStoreDirectory(base), 'state.json');
    const original = fs.readFileSync(stateFile);
    const request = Object.assign(new EventEmitter(), {
        user: { profile: { handle: 'alice' }, directories: aliceDirs }, params: { id: job.id }, get: () => 'alice',
    });
    const writes = [];
    const response = Object.assign(new EventEmitter(), {
        set: () => response, flushHeaders() {}, write: value => writes.push(value), end() { this.writableEnded = true; },
    });
    const timers = new Set();
    const setInterval = globalThis.setInterval;
    const clearInterval = globalThis.clearInterval;
    globalThis.setInterval = callback => { timers.add(callback); return callback; };
    globalThis.clearInterval = timer => { if (!timers.delete(timer)) clearInterval(timer); };
    try {
        jobsRouter.stack.find(layer => layer.route?.path === '/:id/preview').route.stack[0].handle(request, response);
        const [tick] = timers;
        // Damaged account bytes would end this stream on any real re-read, so a kept
        // keepalive proves the diagnostic-only change never set the preview's changed flag.
        fs.writeFileSync(stateFile, '{}');
        notifyJobsChanged({ owner: 'alice', id: job.id, diagnosticOnly: true });
        const before = writes.length;
        tick();
        assert.equal(response.writableEnded, undefined);
        assert.deepEqual(writes.slice(before), [': keepalive\n\n']);
        fs.writeFileSync(stateFile, original);
        setJobState(aliceDirs, job.id, 'completed');
        notifyJobsChanged({ owner: 'alice', id: job.id });
        tick();
        assert.equal(response.writableEnded, true);
        assert.match(writes.join(''), /"state":"completed"/);
    } finally {
        fs.writeFileSync(stateFile, original);
        response.emit('close');
        globalThis.setInterval = setInterval;
        globalThis.clearInterval = clearInterval;
    }
});

test('a final job state reaches an open preview without waiting for the one-second tick', async () => {
    const base = { owner: 'alice', directories: aliceDirs };
    initialiseRoleplayAccount(base);
    const { job } = acceptJob(aliceDirs, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: 'preview-terminal-event',
        intent: { media: roleplayAccountStamp(base), request: {} } });
    const request = Object.assign(new EventEmitter(), {
        user: { profile: { handle: 'alice' }, directories: aliceDirs }, params: { id: job.id }, get: () => 'alice',
    });
    const writes = [];
    const response = Object.assign(new EventEmitter(), {
        set: () => response, flushHeaders() {}, write: value => writes.push(value), end() { this.writableEnded = true; },
    });
    const timers = new Set();
    const setInterval = globalThis.setInterval;
    const clearInterval = globalThis.clearInterval;
    globalThis.setInterval = callback => { timers.add(callback); return callback; };
    globalThis.clearInterval = timer => { if (!timers.delete(timer)) clearInterval(timer); };
    try {
        jobsRouter.stack.find(layer => layer.route?.path === '/:id/preview').route.stack[0].handle(request, response);
        setJobState(aliceDirs, job.id, 'completed');
        // No interval tick is invoked: the committed state must schedule its own check.
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(response.writableEnded, true);
        assert.match(writes.join(''), /"state":"completed"/);
    } finally {
        response.emit('close');
        globalThis.setInterval = setInterval;
        globalThis.clearInterval = clearInterval;
    }
});
