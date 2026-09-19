/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
/* global globalThis */
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
const { JOB_INTENT_LIMIT_BYTES, JOB_INTENT_MAX_BYTES } = await import('../src/jobs/store.js');

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

test('reserved Conversation work cannot bypass its own acceptance endpoint', async () => {
    const bypass = await request('POST', '/api/jobs/submit', {
        account: 'alice', body: { type: 'conversation.reply', submissionKey: 'bypass', intent: {} },
    });
    assert.equal(bypass.status, 400, 'the generic route refuses a reserved job type');
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
