/* global globalThis */
/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-jobs-http-'));
globalThis.DATA_ROOT = root;

const { router: jobsRouter } = await import('../src/endpoints/jobs.js');
const { JOB_INTENT_LIMIT_BYTES, JOB_INTENT_MAX_BYTES, acceptJob, attachOwnedChild, getJob } = await import('../src/jobs/store.js');
const { roleplayHash, roleplayAccountStamp, initialiseRoleplayAccount } = await import('../src/roleplay-store.js');
const { publishRoleplayPreview, subscribeRoleplayPreview } = await import('../src/generation/roleplay-preview.js');
const { registerHandler, setDirectoriesResolver, abortJob, testExports: runner } = await import('../src/jobs/runner.js');
const { writeArtifact } = await import('../src/jobs/artifacts.js');
const { pcmWave } = await import('../src/jobs/audio-artifacts.js');

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
    for (const [method, suffix] of [['GET', '/list'], ['GET', '/capacity'], ['GET', `/${job.id}`], ['GET', `/${job.id}/result`], ['GET', `/${job.id}/preview`],
        ['POST', '/submit'], ['POST', `/${job.id}/cancel`], ['POST', `/${job.id}/dismiss`], ['POST', `/${job.id}/retry`]]) {
        const response = await request(method, '/api/jobs' + suffix, { account: 'bob', headers: { 'X-Neconyan-Account': 'alice' },
            body: method === 'POST' ? { type: 'roleplay', submissionKey: 'blocked', intent: {} } : undefined });
        assert.equal(response.status, 409, suffix);
        assert.equal((await response.json()).error, 'account_changed');
    }
    assert.deepEqual(await (await request('GET', '/api/jobs/list', { account: 'bob', headers: { 'X-Neconyan-Account': 'bob' } })).json(), before);
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
    await reader.read();
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
