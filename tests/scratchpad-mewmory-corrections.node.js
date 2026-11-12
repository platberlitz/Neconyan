import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';

const core = await import('../src/mewmory/core.js');
const memoryStore = await import('../src/mewmory/store.js');
const { readContextSourcesSync } = await import('../src/mewmory/sources.js');
const store = await import('../src/scratchpad/store.js');
const { router } = await import('../src/endpoints/scratchpad.js');
const { acceptScratchpadReply, registerScratchpadJobs } = await import('../src/scratchpad/jobs.js');
const { getJob } = await import('../src/jobs/store.js');
const { setDirectoriesResolver, testExports: { runJob } } = await import('../src/jobs/runner.js');
const { normaliseChange, splitReply } = await import('../public/scripts/scratchpad/proposals.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
after(() => cancelAutoSaves());

async function account(t, { share = true } = {}) {
    const f = fixture(t, false, 'scratch-memory-fix');
    const directories = f.scope.directories;
    directories.worlds = path.join(directories.root, 'worlds');
    fs.mkdirSync(directories.worlds);
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({
        _version: 0, extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    const request = body => ({ user: { profile: { handle: f.scope.owner }, directories }, get: () => undefined, body });
    const base = store.scratchpadAccountBase(request({}));
    const source = { kind: 'roleplay', key: 'character:Nova.png:Source', label: 'Source' };
    const archive = core.newState(f.locator);
    core.syncSources(archive, f.records.slice(1), readContextSourcesSync(directories, f.locator, archive));
    const add = (id, text, options = {}) => core.putRecord(archive, core.validateRecord(archive, {
        id, kind: 'event', text, refs: [archive.timeline[0]], ...options,
    }));
    add('ferry', 'The ferry leaves at dawn.');
    add('hidden', 'HIDDEN-MEMORY', { refs: [archive.timeline[1]] });
    add('excluded', 'EXCLUDED-MEMORY', { excluded: true });
    const filename = memoryStore.statePath(directories, f.locator);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(archive));
    const session = store.mutateBucket(base, source, bucket => store.createSession(bucket, {
        settings: { include: { mewmory: share }, connection: { kind: 'profile', profileId: 'saved' } },
    }));
    setDirectoriesResolver(() => directories);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = request({}).user; next(); });
    app.use('/scratchpad', router);
    const server = await new Promise(resolve => { const opened = app.listen(0, '127.0.0.1', () => resolve(opened)); });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const post = async (route, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/scratchpad/${route}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
            body: JSON.stringify({ source, sessionId: session.id, ...body }),
        });
        return { status: response.status, body: await response.json() };
    };
    const saved = () => JSON.parse(fs.readFileSync(filename, 'utf8'));
    const record = id => saved().records.find(item => item.id === id);
    const hideSecondMessage = () => {
        f.records[2].is_system = true;
        fs.writeFileSync(f.filename, f.records.map(item => JSON.stringify(item)).join('\n'));
    };
    return { f, directories, base, source, session, request, post, filename, saved, record, hideSecondMessage };
}

test('a reviewed correction replaces only that memory, keeps its history and can be undone', async t => {
    const a = await account(t);
    const read = await a.post('mewmory/record', { recordId: 'ferry' });
    assert.equal(read.status, 200);
    assert.deepEqual({ text: read.body.text, version: read.body.version, kind: read.body.kind }, { text: 'The ferry leaves at dawn.', version: 1, kind: 'event' });
    const revision = a.saved().revision;
    const originalRefs = a.record('ferry').refs;
    const result = await a.post('mewmory/correct', { recordId: 'ferry',
        correction: { field: 'text', value: '  The ferry leaves at dusk.  ', expected: read.body.text, version: read.body.version } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.record.text, 'The ferry leaves at dusk.');
    const corrected = a.record('ferry');
    assert.equal(corrected.text, 'The ferry leaves at dusk.');
    assert.equal(corrected.version, 2);
    assert.equal(corrected.authorOverride, true);
    assert.deepEqual(corrected.refs, originalRefs);
    assert.equal(a.saved().revision, revision + 1);
    assert.equal(a.record('hidden').text, 'HIDDEN-MEMORY');
    assert.equal(a.saved().audit.at(-1).before.text, 'The ferry leaves at dawn.');
    const status = await a.post('mewmory/correct', { recordId: 'ferry', correction: { field: 'status', value: 'resolved', expected: 'active', version: 2 } });
    assert.equal(status.status, 200);
    assert.equal(a.record('ferry').status, 'resolved');
    const state = a.saved();
    core.undoRecord(state, 'ferry');
    assert.equal(state.records.find(item => item.id === 'ferry').status, 'active');
});

test('stale reviews are refused without touching the archive', async t => {
    const a = await account(t);
    const read = (await a.post('mewmory/record', { recordId: 'ferry' })).body;
    const bytes = fs.readFileSync(a.filename);
    for (const correction of [
        { field: 'text', value: 'New.', expected: read.text, version: read.version + 1 },
        { field: 'text', value: 'New.', expected: 'Something else.', version: read.version },
    ]) {
        const result = await a.post('mewmory/correct', { recordId: 'ferry', correction });
        assert.equal(result.status, 409);
        assert.equal(result.body.code, 'SCRATCHPAD_MEWMORY_CHANGED');
    }
    assert.deepEqual(fs.readFileSync(a.filename), bytes);
    // Another tab edits the memory after this review was prepared.
    const state = a.saved();
    core.putRecord(state, { ...state.records.find(item => item.id === 'ferry'), text: 'Edited in Mewmory.', origin: 'author', authorOverride: true }, { force: true });
    state.revision += 1;
    fs.writeFileSync(a.filename, JSON.stringify(state));
    const late = await a.post('mewmory/correct', { recordId: 'ferry', correction: { field: 'text', value: 'New.', expected: read.text, version: read.version } });
    assert.equal(late.status, 409);
    assert.equal(a.record('ferry').text, 'Edited in Mewmory.');
});

test('only shared, eligible memories can be read or corrected', async t => {
    const a = await account(t);
    for (const id of ['excluded', 'missing']) {
        const result = await a.post('mewmory/record', { recordId: id });
        assert.equal(result.status, 404);
        assert.equal(result.body.code, 'SCRATCHPAD_MEWMORY_RECORD');
    }
    assert.equal((await a.post('mewmory/record', { recordId: 'hidden' })).status, 200);
    a.hideSecondMessage();
    const hidden = await a.post('mewmory/correct', { recordId: 'hidden', correction: { field: 'text', value: 'Leaked.', expected: 'HIDDEN-MEMORY', version: 1 } });
    assert.equal(hidden.status, 404);
    assert.equal(a.record('hidden').text, 'HIDDEN-MEMORY');
    for (const correction of [
        { field: 'pinned', value: 'true', expected: '', version: 1 },
        { field: 'status', value: 'deleted', expected: 'active', version: 1 },
        { field: 'text', value: '   ', expected: 'The ferry leaves at dawn.', version: 1 },
    ]) assert.equal((await a.post('mewmory/correct', { recordId: 'ferry', correction })).status, 400);
    assert.equal(a.record('ferry').version, 1);
});

test('turning Mewmory off for the session refuses corrections and removes the instructions', async t => {
    const a = await account(t, { share: false });
    const read = await a.post('mewmory/record', { recordId: 'ferry' });
    assert.equal(read.status, 403);
    assert.equal(read.body.code, 'SCRATCHPAD_MEWMORY_NOT_SHARED');
    const correct = await a.post('mewmory/correct', { recordId: 'ferry', correction: { field: 'text', value: 'X.', expected: 'The ferry leaves at dawn.', version: 1 } });
    assert.equal(correct.status, 403);
    const calls = [];
    registerScratchpadJobs({ generate: async options => { calls.push(options); return { text: 'Done.' }; } });
    const send = async (key, extra = {}) => {
        const body = { source: a.source, sessionId: a.session.id, submissionKey: key, text: 'Is the ferry memory right?', context: 'Story',
            names: { user: 'User', character: 'Nova' }, capabilities: { mewmory: true }, ...extra };
        const accepted = await acceptScratchpadReply(a.request(body), body);
        await runJob(getJob(a.directories, accepted.job.id));
        return calls.at(-1).messages[0].content;
    };
    assert.doesNotMatch(await send('off'), /"type":"mewmory"/);
    store.mutateBucket(a.base, a.source, bucket => store.updateSession(bucket, a.session.id, { settings: { include: { mewmory: true } } }));
    assert.match(await send('on'), /"type":"mewmory","action":"replace","record":"<exact record id>"/);
});

test('correction blocks are parsed strictly', () => {
    assert.deepEqual(normaliseChange({ type: 'mewmory', record: 'ferry', field: 'status', value: ' Resolved ', reason: 'It happened.' }),
        { type: 'mewmory', action: 'replace', record: 'ferry', field: 'status', value: 'resolved', reason: 'It happened.' });
    for (const bad of [
        { type: 'mewmory', record: 'ferry', field: 'pinned', value: 'true' },
        { type: 'mewmory', record: '../x', field: 'text', value: 'x' },
        { type: 'mewmory', record: 'ferry', field: 'status', value: 'deleted' },
        { type: 'mewmory', action: 'delete', record: 'ferry', field: 'text', value: 'x' },
    ]) assert.throws(() => normaliseChange(bad));
    const [part] = splitReply('```scratchpad-change\n{"type":"mewmory","record":"ferry","field":"text","value":"Dusk.","reason":"Message 2."}\n```').filter(item => item.type === 'change');
    assert.equal(part.change.value, 'Dusk.');
});
