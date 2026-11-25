import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';

const { SETTINGS_FILE } = await import('../src/constants.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { setDirectoriesResolver } = await import('../src/jobs/runner.js');
const store = await import('../src/scratchpad/store.js');
const history = await import('../src/scratchpad/change-history.js');
const { buildScratchpadSystemPrompt } = await import('../src/scratchpad/prompt.js');
const { router } = await import('../src/endpoints/scratchpad.js');

after(() => cancelAutoSaves());

const NOVA = { kind: 'roleplay', key: 'Nova.png::Source', label: 'Nova' };
const CHANGE = 'Here you go.\n```scratchpad-change\n{"type":"character","character":"Nova","field":"description","value":"Brave."}\n```';

function account(t) {
    const f = fixture(t, false, 'scratch-history');
    const directories = f.scope.directories;
    fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify({ _version: 0,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-test' }] } },
        oai_settings: { chat_completion_source: 'openai' } }));
    setDirectoriesResolver(() => directories);
    const request = body => ({ user: { profile: { handle: f.scope.owner }, directories }, get: () => undefined, body });
    const base = store.scratchpadAccountBase(request({}));
    return {
        f,
        directories,
        mutate: (source, change) => store.mutateBucket(base, source, change),
        read: source => store.withScratchpad(base, lease => store.readBucketLocked(lease, source)),
    };
}

function seed(a, source = NOVA) {
    return a.mutate(source, bucket => store.createSession(bucket, { assistant: 'taro', name: 'Edits',
        messages: [{ role: 'user', text: 'Make Nova braver.' }, { role: 'assistant', assistant: 'taro', text: CHANGE }] }));
}

function receipt(extra = {}) {
    return {
        type: 'character', action: 'edit', description: 'Change the description of Nova',
        target: { kind: 'character', label: 'Nova', character: 'Nova' }, field: 'Description',
        before: 'Shy.', after: 'Brave.', undoable: true,
        undo: { kind: 'character', avatar: 'Nova.png', field: 'description', before: 'Shy.', after: 'Brave.' },
        ...extra,
    };
}

test('records a saved change and marks its suggestion applied in the same write', t => {
    const a = account(t);
    const session = seed(a);
    const message = session.messages[1];
    const entry = a.mutate(NOVA, bucket => store.recordSavedChange(bucket, { ...receipt(), sessionId: session.id, messageId: message.id, proposalIndex: 0 }));
    assert.match(entry.id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(entry.status, 'applied');
    assert.equal(entry.undoable, true);
    assert.equal(entry.undoUnavailableReason, '');
    assert.ok(!Number.isNaN(Date.parse(entry.savedAt)));
    const bucket = a.read(NOVA);
    assert.equal(bucket.changeHistory.length, 1);
    assert.deepEqual(bucket.changeHistory[0], entry);
    assert.equal(bucket.sessions[0].messages[1].proposals['0'], 'applied');
    assert.deepEqual(store.publicBucket(bucket).changeHistory, [entry]);
});

test('keeps only allow-listed fields and drops unsafe undo keys', () => {
    const { entry } = history.recordChange([], { ...receipt(), status: 'undone', secret: 'x', target: { label: 'Nova', nested: { deep: 1 }, 'bad key': 1 },
        undo: JSON.parse('{"kind":"character","__proto__":{"polluted":true},"before":"Shy.","after":"Brave."}') }, { id: 'one', savedAt: '2026-11-25T10:00:00.000Z' });
    assert.equal(entry.status, 'applied');
    assert.equal(Object.hasOwn(entry, 'secret'), false);
    assert.deepEqual(entry.target, { label: 'Nova' });
    assert.equal(Object.hasOwn(entry.undo, '__proto__'), false);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(Object.keys(entry).sort(), ['action', 'after', 'before', 'description', 'field', 'id', 'messageId', 'proposalIndex',
        'savedAt', 'sessionId', 'status', 'target', 'type', 'undo', 'undoUnavailableReason', 'undoable', 'undoneAt'].sort());
    assert.equal(entry.undoneAt, null);
});

test('keeps the newest 50 entries, newest first', () => {
    let list = [];
    for (let index = 0; index < 55; index++) {
        list = history.recordChange(list, receipt({ description: `Change ${index}` }), { id: `entry-${index}`, savedAt: new Date(Date.UTC(2026, 10, 25, 0, index)).toISOString() }).history;
    }
    assert.equal(history.MAX_CHANGE_HISTORY, 50);
    assert.equal(list.length, 50);
    assert.equal(list[0].id, 'entry-54');
    assert.equal(list.at(-1).id, 'entry-5');
    assert.equal(list.some(entry => entry.id === 'entry-4'), false);
    assert.equal(history.normaliseChangeHistory([...list, ...list]).length, 50);
});

test('turns off automatic undo for an entry over the byte cap and says why', () => {
    const big = 'a'.repeat(history.MAX_HISTORY_ENTRY_BYTES);
    const { entry } = history.recordChange([], receipt({ before: big, undo: { kind: 'character', before: big, after: 'Brave.' } }), { id: 'big', savedAt: '2026-11-25T10:00:00.000Z' });
    assert.equal(entry.undoable, false);
    assert.equal(entry.undo, null);
    assert.equal(entry.undoUnavailableReason, history.TOO_LARGE_REASON);
    assert.ok(Buffer.byteLength(JSON.stringify(entry)) <= history.MAX_HISTORY_ENTRY_BYTES);
    assert.match(entry.before, /The text shown here was shortened\.$/);
    assert.throws(() => history.markChangeUndone([entry], 'big'), { code: 'SCRATCHPAD_HISTORY_NOT_UNDOABLE', status: 409 });
});

test('records non-undoable changes honestly', () => {
    const { entry } = history.recordChange([], { type: 'creator', action: 'create', description: 'Open a Catelier draft', undoable: true,
        undoUnavailableReason: 'Catelier drafts are not undone from Scratchpad.' }, { id: 'draft', savedAt: '2026-11-25T10:00:00.000Z' });
    assert.equal(entry.undoable, false);
    assert.equal(entry.undo, null);
    assert.equal(entry.undoUnavailableReason, 'Catelier drafts are not undone from Scratchpad.');
});

test('undo marks the entry and the suggestion undone, once', t => {
    const a = account(t);
    const session = seed(a);
    const message = session.messages[1];
    const entry = a.mutate(NOVA, bucket => store.recordSavedChange(bucket, { ...receipt(), sessionId: session.id, messageId: message.id, proposalIndex: 0 }));
    const undone = a.mutate(NOVA, bucket => store.markSavedChangeUndone(bucket, entry.id));
    assert.equal(undone.status, 'undone');
    assert.ok(!Number.isNaN(Date.parse(undone.undoneAt)));
    const bucket = a.read(NOVA);
    assert.equal(bucket.changeHistory[0].status, 'undone');
    assert.equal(bucket.changeHistory[0].undoneAt, undone.undoneAt);
    assert.equal(bucket.sessions[0].messages[1].proposals['0'], 'undone');
    assert.throws(() => a.mutate(NOVA, b => store.markSavedChangeUndone(b, entry.id)), { code: 'SCRATCHPAD_HISTORY_UNDONE', status: 409 });
    assert.throws(() => a.mutate(NOVA, b => store.markSavedChangeUndone(b, 'missing')), { code: 'SCRATCHPAD_HISTORY_MISSING', status: 404 });
});

test('undone is a valid suggestion state and survives a reload', t => {
    const a = account(t);
    const session = seed(a);
    const message = session.messages[1];
    a.mutate(NOVA, bucket => store.markProposal(bucket, session.id, message.id, 0, 'undone'));
    assert.equal(a.read(NOVA).sessions[0].messages[1].proposals['0'], 'undone');
    assert.throws(() => a.mutate(NOVA, bucket => store.markProposal(bucket, session.id, message.id, 0, 'maybe')), { code: 'SCRATCHPAD_PROPOSAL_INVALID' });
});

test('reads an older bucket without a history and keeps a history-only bucket on disk', t => {
    const a = account(t);
    const session = seed(a);
    const file = store.scratchpadFile(a.directories.root, NOVA);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete saved.changeHistory;
    fs.writeFileSync(file, JSON.stringify(saved));
    assert.deepEqual(a.read(NOVA).changeHistory, []);
    a.mutate(NOVA, bucket => { store.recordSavedChange(bucket, receipt()); });
    a.mutate(NOVA, bucket => { store.deleteSession(bucket, session.id); });
    const bucket = a.read(NOVA);
    assert.equal(bucket.sessions.length, 0);
    assert.equal(bucket.changeHistory.length, 1);
});

test('shared sessions keep one Change history across the chats that share them', t => {
    const a = account(t);
    const first = { kind: 'roleplay', key: 'Nova.png::First', label: 'Nova', scope: { kind: 'character', id: 'Nova.png' } };
    const second = { ...first, key: 'Nova.png::Second' };
    seed(a, first);
    a.mutate(first, bucket => { store.recordSavedChange(bucket, receipt()); });
    assert.equal(a.read(second).changeHistory.length, 1);
});

test('session exports never include Change history', t => {
    const a = account(t);
    const session = seed(a);
    a.mutate(NOVA, bucket => { store.recordSavedChange(bucket, { ...receipt(), sessionId: session.id, messageId: session.messages[1].id, proposalIndex: 0 }); });
    // Exports are built from one session (tests/scratchpad-export.test.js); the history lives on the bucket beside the sessions.
    const saved = a.read(NOVA);
    assert.equal(saved.changeHistory.length, 1);
    assert.doesNotMatch(JSON.stringify(saved.sessions), /changeHistory|Shy\./);
});

test('the system prompt is byte-identical with or without Change history', async t => {
    const a = account(t);
    const session = seed(a);
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.user = { profile: { handle: a.f.scope.owner }, directories: a.directories }; next(); });
    app.use('/scratchpad', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}/scratchpad`;
    const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close', 'X-Neconyan-Account': a.f.scope.owner }, body: JSON.stringify(body) });
    const ask = { source: NOVA, sessionId: session.id, assistant: 'taro', capabilities: { chat: true, character: true, lore: true }, names: { user: 'Kris', character: 'Nova' } };
    const direct = () => buildScratchpadSystemPrompt({ assistant: 'taro', sourceKind: 'roleplay', userName: 'Kris', characterName: 'Nova', capabilities: { chat: true, character: true } }).text;
    const beforePrompt = await (await post('/prompt', ask)).text();
    const beforeDirect = direct();

    const recorded = await post('/history/record', { source: NOVA, entry: { ...receipt(), sessionId: session.id, messageId: session.messages[1].id, proposalIndex: 0 } });
    assert.equal(recorded.status, 200);
    const body = await recorded.json();
    assert.equal(body.bucket.changeHistory.length, 1);
    assert.equal(body.bucket.sessions[0].messages[1].proposals['0'], 'applied');
    const undone = await post('/history/undo', { source: NOVA, entryId: body.entry.id });
    assert.equal(undone.status, 200);
    assert.equal((await undone.json()).bucket.changeHistory[0].status, 'undone');
    const again = await post('/history/undo', { source: NOVA, entryId: body.entry.id });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).message, 'That change was already undone.');

    assert.equal(await (await post('/prompt', ask)).text(), beforePrompt);
    assert.equal(direct(), beforeDirect);
    assert.doesNotMatch(beforePrompt, /Shy\.|changeHistory/);
});
