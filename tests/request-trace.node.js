import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { createRequestTrace } from '../src/request-trace.js';

function listen(app) {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function send(port, method, url, body = '') {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, method, path: url, headers: { 'content-length': Buffer.byteLength(body) } }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
        request.end(body);
    });
}

test('the request trace records in-flight and finished requests without query strings or bodies', async t => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'request-trace-'));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    const file = path.join(work, 'requests.txt');
    const app = express();
    app.use(createRequestTrace(file, { limit: 3 }));
    let release;
    const held = new Promise(resolve => { release = resolve; });
    app.post('/api/backends/chat-completions/generate', async (request, response) => {
        await held;
        response.status(200).end('ok');
    });
    app.get('/api/other', (request, response) => response.status(404).end());
    const server = await listen(app);
    t.after(() => server.close());
    const { port } = server.address();

    const generate = send(port, 'POST', '/api/backends/chat-completions/generate?secret=1', '{"messages":[{"content":"private text"}]}');
    await new Promise(resolve => setTimeout(resolve, 50));
    let trace = fs.readFileSync(file, 'utf8');
    assert.match(trace, /^\S+ POST \/api\/backends\/chat-completions\/generate 41B in flight\n$/);
    assert.doesNotMatch(trace, /secret|private text/);

    release();
    assert.equal(await generate, 200);
    trace = fs.readFileSync(file, 'utf8');
    assert.match(trace, /^\S+ POST \/api\/backends\/chat-completions\/generate 41B -> 200 \d+ms\n$/);

    for (let index = 0; index < 4; index++) assert.equal(await send(port, 'GET', `/api/other?n=${index}`), 404);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, 'only the newest requests are kept');
    assert.ok(lines.every(line => / GET \/api\/other 0B -> 404 \d+ms$/.test(line)), lines.join('\n'));
});

test('a trace file that cannot be written does not break the request', async t => {
    const app = express();
    app.use(createRequestTrace(path.join(os.tmpdir(), 'missing-dir-' + process.pid, 'nested', 'requests.txt')));
    app.get('/ok', (request, response) => response.end('fine'));
    const server = await listen(app);
    t.after(() => server.close());
    assert.equal(await send(server.address().port, 'GET', '/ok'), 200);
});
