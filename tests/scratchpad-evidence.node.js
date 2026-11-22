import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE = 'false';

const { acceptJob, setJobState } = await import('../src/jobs/store.js');
const { createRequestTrace, getRecentRequestEntries, getRecentRequests } = await import('../src/request-trace.js');
const { initialiseCrashDiagnostics, writeCrashReport } = await import('../src/crash-diagnostics.js');
const { collectAccountEvidence, collectAdminEvidence, ownJobEvidence, ownRequestEvidence } = await import('../src/scratchpad/evidence.js');
const { router } = await import('../src/endpoints/scratchpad.js');
const { formatAppEvidence } = await import('../public/scripts/scratchpad/evidence.js');

const PLANTED = ['sk-PLANTEDsecretKEY1234567890', 'hunter2-planted', 'PlantedCookieValue99', 'planted-url-token-abc', 'my planted chat line', 'bob-private-prompt'];

function assertClean(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of PLANTED) assert.ok(!text.includes(secret), `leaked ${secret}`);
}

function listen(app) {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function call(port, method, url, { headers = {}, body = '' } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, method, path: url, headers: { 'content-length': Buffer.byteLength(body), 'content-type': 'application/json', ...headers } }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject);
        request.end(body);
    });
}

test('own request evidence lists only this account\'s failed or slow requests, without handles or query strings', async t => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-trace-'));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    const app = express();
    app.use(createRequestTrace(path.join(work, 'requests.txt')));
    app.use((request, _response, next) => { request.user = { profile: { handle: request.get('x-handle') } }; next(); });
    app.post('/api/chats/save', (_request, response) => response.status(500).json({ error: 'bob-private-prompt' }));
    app.post('/api/settings/save', (_request, response) => response.status(200).end('ok'));
    app.get('/api/characters/all', (_request, response) => response.status(404).end());
    const server = await listen(app);
    t.after(() => { server.closeAllConnections(); server.close(); });
    const { port } = server.address();

    await call(port, 'POST', '/api/chats/save?api_key=planted-url-token-abc', { headers: { 'x-handle': 'alice' }, body: '{"chat":"my planted chat line"}' });
    await call(port, 'POST', '/api/settings/save', { headers: { 'x-handle': 'alice' }, body: '{}' });
    await call(port, 'GET', '/api/characters/all', { headers: { 'x-handle': 'bob' } });
    await new Promise(resolve => setTimeout(resolve, 30));

    const alice = ownRequestEvidence('alice');
    assert.equal(alice.total, 1);
    assert.equal(alice.items[0].status, 500);
    assert.equal(alice.items[0].method, 'POST');
    assert.deepEqual(Object.keys(alice.items[0]).sort(), ['at', 'closed', 'method', 'ms', 'path', 'status']);
    assertClean(alice);
    const bob = ownRequestEvidence('bob');
    assert.equal(bob.total, 1);
    assert.equal(bob.items[0].status, 404);
    assert.equal(ownRequestEvidence('').total, 0);
    assert.equal(ownRequestEvidence('carol').total, 0);

    // The existing text trace is unchanged and the handle stays inside the module.
    assert.ok(getRecentRequests().every(line => typeof line === 'string'));
    assert.ok(getRecentRequestEntries().some(entry => entry.handle === 'bob'));
});

test('own job evidence skips other accounts, finished jobs and everything that can hold prompt text', t => {
    const f = fixture(t, false, 'alice');
    const base = { owner: 'alice', directories: f.scope.directories };
    const make = (owner, key, state, error = null) => {
        const { job } = acceptJob(base.directories, { owner, type: 'scratchpad.reply', submissionKey: key, label: 'my planted chat line', intent: { text: 'bob-private-prompt' }, config: { note: 'bob-private-prompt' } });
        if (state) setJobState(base.directories, job.id, state, { error });
        return job;
    };
    make('alice', 'a-ok', 'completed');
    make('alice', 'a-fail', 'failed', { code: 'PROVIDER_FAILED', message: 'Upstream said Authorization: Bearer sk-PLANTEDsecretKEY1234567890 for https://u:hunter2-planted@h.example/x?token=planted-url-token-abc' });
    make('bob', 'b-fail', 'failed', { code: 'BOB_ONLY', message: 'bob-private-prompt' });

    const evidence = ownJobEvidence(base);
    assert.equal(evidence.total, 1);
    assert.equal(evidence.items[0].code, 'PROVIDER_FAILED');
    assert.equal(evidence.items[0].state, 'failed');
    assert.deepEqual(Object.keys(evidence.items[0]).sort(), ['at', 'code', 'message', 'stage', 'state', 'type']);
    assertClean(evidence);
    assert.ok(!JSON.stringify(evidence).includes('BOB_ONLY'));
});

test('admin evidence redacts crash reports and keeps only problem lines from the server log', t => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-crash-'));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    initialiseCrashDiagnostics(work);
    const error = new Error('Crash with Authorization: Bearer sk-PLANTEDsecretKEY1234567890 and COOKIE: sid=PlantedCookieValue99');
    error.stack = `Error: ${error.message}\n    at f (https://h.example/a.js?token=planted-url-token-abc:1:1)`;
    writeCrashReport('uncaughtException', error);
    console.error('Provider error: password=hunter2-planted from https://u:hunter2-planted@h.example');
    console.log('Chat text: my planted chat line');
    console.log('Server is listening');

    const evidence = collectAdminEvidence();
    assert.equal(evidence.serverCrashes.total >= 1, true);
    assert.equal(evidence.serverCrashes.items[0].kind, 'uncaughtException');
    const lines = evidence.logLines.items.map(line => line.message).join('\n');
    assert.match(lines, /Provider error/);
    assert.doesNotMatch(lines, /Server is listening|Chat text/);
    assertClean(evidence);
    assertClean(formatAppEvidence({ ...evidence }));
});

test('the evidence routes need a signed-in account and the admin route refuses everyone else on the server', async t => {
    const f = fixture(t, false, 'alice');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-route-'));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    initialiseCrashDiagnostics(work);
    writeCrashReport('uncaughtException', new Error('Crash for admins only'));
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        const role = request.get('x-role');
        if (role) request.user = { profile: { handle: 'alice', admin: role === 'admin' }, directories: f.scope.directories };
        next();
    });
    app.use('/api/scratchpad', router);
    const server = await listen(app);
    t.after(() => { server.closeAllConnections(); server.close(); });
    const { port } = server.address();

    const anonymous = await call(port, 'POST', '/api/scratchpad/evidence/admin', { body: '{}' });
    assert.equal(anonymous.status, 403);
    const member = await call(port, 'POST', '/api/scratchpad/evidence/admin', { headers: { 'x-role': 'user' }, body: '{}' });
    assert.equal(member.status, 403);
    assert.doesNotMatch(member.text, /Crash for admins only/);
    const admin = await call(port, 'POST', '/api/scratchpad/evidence/admin', { headers: { 'x-role': 'admin' }, body: '{}' });
    assert.equal(admin.status, 200);
    assert.match(admin.text, /Crash for admins only/);

    const ownMember = await call(port, 'POST', '/api/scratchpad/evidence', { headers: { 'x-role': 'user' }, body: '{}' });
    assert.equal(ownMember.status, 200);
    const body = JSON.parse(ownMember.text);
    assert.ok(body.environment && body.requests && body.jobs);
    assert.equal(body.serverCrashes, undefined);
    assert.equal(body.logLines, undefined);
    assert.equal((await call(port, 'POST', '/api/scratchpad/evidence', { body: '{}' })).status >= 400, true);
});

test('account evidence reports the runtime and never the handle', async t => {
    const f = fixture(t, false, 'alice');
    const evidence = await collectAccountEvidence({ owner: 'alice', directories: f.scope.directories });
    assert.match(evidence.environment.runtime, /Node|Bun/);
    assert.match(evidence.environment.platform, /\S+ \S+/);
    assert.equal(typeof evidence.environment.frontendBuild, 'boolean');
    assert.ok(!JSON.stringify(evidence).includes('alice'));
});
