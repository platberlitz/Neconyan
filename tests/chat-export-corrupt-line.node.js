import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

// A damaged export line used to throw inside a readline 'line' callback, which
// escapes the router's try/catch and terminates the whole server process. The
// tests below drive the real route; surviving them is part of the assertion.
process.on('uncaughtException', error => {
    console.error('uncaughtException during chat export test (this means the route leaked an error):', error);
    process.exit(1);
});

const { router } = await import('../src/endpoints/chats.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-chat-export-'));
const chatsDirectory = path.join(tempRoot, 'chats', 'seraphina');
fs.mkdirSync(chatsDirectory, { recursive: true });

function writeChat(name, lines) {
    const file = path.join(chatsDirectory, name);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return name;
}

const app = express();
app.use(express.json());
app.use((request, _response, next) => {
    request.user = { profile: { handle: 'tester' }, directories: { chats: path.join(tempRoot, 'chats'), groupChats: path.join(tempRoot, 'group-chats') } };
    next();
});
app.use(router);

let server;
let port;

before(async () => {
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = server.address().port;
});

after(async () => {
    // Focused cleanup; the suite owns the temporary directory.
    server?.closeAllConnections();
    await new Promise(resolve => server?.close(resolve));
    for (const name of fs.readdirSync(chatsDirectory)) {
        const target = path.join(chatsDirectory, name);
        if (fs.statSync(target).isDirectory()) fs.rmdirSync(target);
        else fs.unlinkSync(target);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function postExport(body) {
    return await new Promise((resolvePromise, rejectPromise) => {
        const request = http.request({
            hostname: '127.0.0.1', port, path: '/export', method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, response => {
            let data = '';
            response.on('data', chunk => { data += chunk; });
            response.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* non-JSON error bodies stay raw */ }
                resolvePromise({ status: response.statusCode, body: json, raw: data });
            });
        });
        request.on('error', rejectPromise);
        request.end(JSON.stringify(body));
    });
}

const message = { name: 'Seraphina', is_user: false, mes: 'Hello there.', extra: {} };
const userMessage = { name: 'You', is_user: true, mes: 'Hi!', extra: {} };
const hidden = { name: 'System', is_system: true, mes: 'hidden prompt' };

test('a healthy chat exports its visible messages', async () => {
    const file = writeChat('healthy.jsonl', [JSON.stringify(message), JSON.stringify(userMessage)]);
    const result = await postExport({ avatar_url: 'seraphina.png', file, is_group: false, exportfilename: 'healthy.txt', format: 'txt' });
    assert.equal(result.status, 200);
    assert.equal(result.body.result, 'Seraphina: Hello there.\n\nYou: Hi!\n\n');
});

test('blank lines between chat entries are ignored, not fatal', async () => {
    const file = writeChat('blank-lines.jsonl', [JSON.stringify(message), '', JSON.stringify(userMessage), '']);
    const result = await postExport({ avatar_url: 'seraphina.png', file, is_group: false, exportfilename: 'blank.txt', format: 'txt' });
    assert.equal(result.status, 200);
    assert.equal(result.body.result, 'Seraphina: Hello there.\n\nYou: Hi!\n\n');
});

test('a damaged line returns a controlled error and the process survives', async () => {
    const file = writeChat('damaged.jsonl', [JSON.stringify(message), '{"name": "Broken", "mes":', JSON.stringify(userMessage)]);
    const result = await postExport({ avatar_url: 'seraphina.png', file, is_group: false, exportfilename: 'damaged.txt', format: 'txt' });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /damaged line/);
});

test('a failing read stream returns a controlled error and the process survives', async () => {
    // existsSync passes for a directory, but createReadStream then fails with EISDIR.
    fs.mkdirSync(path.join(chatsDirectory, 'unreadable.jsonl'), { recursive: true });
    const result = await postExport({ avatar_url: 'seraphina.png', file: 'unreadable.jsonl', is_group: false, exportfilename: 'unreadable.txt', format: 'txt' });
    assert.equal(result.status, 400);
});

for (const entry of [null, [], 42, { mes: 123 }, { mes: 'text', extra: { display_text: {} } }]) {
    test(`invalid entry ${JSON.stringify(entry)} returns an error without ending the server`, async () => {
        const file = writeChat('invalid-entry.jsonl', [JSON.stringify(entry)]);
        const result = await postExport({ avatar_url: 'seraphina.png', file, exportfilename: 'invalid.txt', format: 'txt' });
        assert.equal(result.status, 400);
        assert.match(result.body.message, /damaged line/);
    });
}

test('hidden system messages are still skipped after the rewrite', async () => {
    const file = writeChat('hidden.jsonl', [JSON.stringify(hidden), JSON.stringify(message)]);
    const result = await postExport({ avatar_url: 'seraphina.png', file, is_group: false, exportfilename: 'hidden.txt', format: 'txt' });
    assert.equal(result.status, 200);
    assert.equal(result.body.result, 'Seraphina: Hello there.\n\n');
});
