import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { test } from 'node:test';
import archiver from 'archiver';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';

const { router } = await import('../src/endpoints/operations.js');
const { readOperation } = await import('../src/operations/store.js');

const TOKEN = '0123abcd-0000-4000-8000-0123456789ab';

async function serve(t, f, owner) {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.user = { profile: { handle: owner }, directories: f.scope.directories }; next(); });
    app.use('/api/operations', router);
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    t.after(() => server.close());
    const { port } = server.address();
    return body => fetch(`http://127.0.0.1:${port}/api/operations/import-input-local`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function pickedZip(inbox) {
    fs.mkdirSync(inbox, { recursive: true });
    const filename = path.join(inbox, `${TOKEN}.zip`);
    const output = fs.createWriteStream(filename);
    const done = finished(output);
    const zip = archiver('zip');
    zip.pipe(output);
    zip.append('{"name1":"Imported"}', { name: 'data/default-user/settings.json' });
    await zip.finalize(); await done;
    return filename;
}

function setup(t) {
    const owner = 'fixture';
    const f = fixture(t, false, owner);
    const inbox = path.join(path.dirname(f.scope.directories.root), 'import-inbox');
    const previous = process.env.NECONYAN_LOCAL_IMPORT_DIR;
    process.env.NECONYAN_LOCAL_IMPORT_DIR = inbox;
    t.after(() => { if (previous === undefined) delete process.env.NECONYAN_LOCAL_IMPORT_DIR; else process.env.NECONYAN_LOCAL_IMPORT_DIR = previous; });
    return { f, owner, inbox };
}

test('a ZIP picked in the iPhone app is retained once, removed from the inbox and found again on a repeated request', async t => {
    const p = setup(t);
    const post = await serve(t, p.f, p.owner);
    const picked = await pickedZip(p.inbox);
    const first = await post({ key: 'upload', token: TOKEN });
    assert.equal(first.status, 200);
    const retained = await first.json();
    assert.match(retained.inputId, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(picked), false);
    const repeated = await post({ key: 'upload', token: TOKEN });
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), retained);
    const unknown = await post({ key: 'other', token: TOKEN });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /backup ZIP is required/);
});

test('the server starts the planned import itself, so a paused page cannot hold it back', async t => {
    const p = setup(t);
    const post = await serve(t, p.f, p.owner);
    await pickedZip(p.inbox);
    const input = { mode: 'zip', content: 'core', parts: ['chats'] };
    const response = await post({ key: 'upload', token: TOKEN, submission: { kind: 'account-import', key: 'import', input } });
    assert.equal(response.status, 200);
    const value = await response.json();
    const record = readOperation({ owner: p.owner, directories: p.f.scope.directories }, 'import');
    assert.equal(value.submitError, null);
    assert.equal(record.kind, 'account-import');
    const resumed = await fetch(response.url.replace('/import-input-local', '/submit'), { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, inputId: value.inputId, kind: 'account-import', key: 'import' }) });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).created, false);
});

test('unreadable hand-overs and hand-overs outside the iPhone app are refused before touching files', async t => {
    const p = setup(t);
    const post = await serve(t, p.f, p.owner);
    const picked = await pickedZip(p.inbox);
    for (const body of [{ key: 'upload', token: '../../settings' }, { key: '', token: TOKEN },
        { key: 'upload', token: TOKEN, submission: { kind: 'account-backup', key: 'import', input: {} } },
        { key: 'upload', token: TOKEN, submission: { kind: 'account-import', key: 'import', input: [] } }]) {
        assert.equal((await post(body)).status, 400);
    }
    delete process.env.NECONYAN_LOCAL_IMPORT_DIR;
    assert.equal((await post({ key: 'upload', token: TOKEN })).status, 404);
    assert.equal(fs.existsSync(picked), true);
});
