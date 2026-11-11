import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';

const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const store = await import('../src/scratchpad/store.js');
const search = await import('../src/scratchpad/search.js');
const { router } = await import('../src/endpoints/scratchpad.js');

after(() => cancelAutoSaves());

const NOVA = { kind: 'roleplay', key: 'Nova.png::Source', label: 'Nova' };
const TALK = { kind: 'conversation', key: 'Mira.png::main', label: 'Mira' };
const GENERAL = { kind: 'general', key: 'general', label: 'General Scratchpad' };

function account(t) {
    const f = fixture(t, false, 'scratch-search');
    const directories = f.scope.directories;
    const request = body => ({ user: { profile: { handle: f.scope.owner }, directories }, get: () => undefined, body });
    const base = store.scratchpadAccountBase(request({}));
    const add = (source, name, messages, extra = {}) => store.mutateBucket(base, source, bucket => {
        store.createSession(bucket, { assistant: 'taro', name, messages, ...extra });
        return bucket;
    }).sessions[0];
    const find = query => store.withScratchpad(base, lease => search.searchSessionsLocked(lease, query));
    return { f, directories, base, add, find };
}

const talk = (...lines) => lines.map((text, index) => index % 2 ? { role: 'assistant', assistant: 'taro', text } : { role: 'user', text });

test('search finds sessions by name or message text in every list of the account', t => {
    const a = account(t);
    const nova = a.add(NOVA, 'Harbour plans', talk('Where does the lighthouse keeper sleep?', 'Above the lamp room.'));
    const mira = a.add(TALK, 'Small talk', talk(`${'Padding. '.repeat(30)}The LIGHTHOUSE is closed in winter, ${'and more. '.repeat(40)}`, 'Noted.'));
    a.add(GENERAL, 'Lighthouse recipes', talk('Soup?', 'Soup.'));
    a.add(GENERAL, 'Unrelated', talk('Tea?', 'Tea.'));

    const found = a.find('  lighthouse ');
    assert.equal(found.more, false);
    assert.deepEqual(found.results.map(item => item.name).sort(), ['Harbour plans', 'Lighthouse recipes', 'Small talk']);
    const byName = Object.fromEntries(found.results.map(item => [item.name, item]));
    assert.equal(byName['Harbour plans'].kind, 'roleplay');
    assert.equal(byName['Harbour plans'].where, 'Nova');
    assert.equal(byName['Harbour plans'].sessionId, nova.id);
    assert.equal(byName['Harbour plans'].messages, 2);
    assert.equal(byName['Harbour plans'].snippet, 'Where does the lighthouse keeper sleep?');
    assert.match(byName['Harbour plans'].list, /^[a-f0-9]{40}$/);
    assert.equal(byName['Small talk'].sessionId, mira.id);
    assert.match(byName['Small talk'].snippet, /^….*The LIGHTHOUSE is closed in winter.*…$/);
    assert.ok(byName['Small talk'].snippet.length < 220);
    assert.equal(byName['Lighthouse recipes'].snippet, '', 'a match in the name alone has no snippet');
    assert.equal(byName['Lighthouse recipes'].where, 'General Scratchpad');
    assert.deepEqual(a.find('no such words').results, []);

    for (const query of ['', ' a ', 7, 'x'.repeat(201)]) {
        assert.throws(() => a.find(query), { code: 'SCRATCHPAD_SEARCH_INVALID' });
    }
});

test('search skips temporary sessions, files that are not session lists and other accounts', t => {
    const a = account(t);
    const b = account(t);
    a.add(NOVA, 'Kept', talk('The orchard gate is locked.', 'Yes.'));
    a.add(TALK, 'Passing', talk('The orchard is empty.', 'Yes.'), { temporary: true });
    b.add(NOVA, 'Someone else', talk('Their orchard.', 'Yes.'));
    const directory = path.join(a.directories.root, 'scratchpad');
    fs.writeFileSync(path.join(directory, `${'a'.repeat(40)}.json`), '{ damaged');
    fs.writeFileSync(path.join(directory, `${'b'.repeat(40)}.json`), JSON.stringify({ version: 1, activeSessionId: 'orchard' }));
    fs.writeFileSync(path.join(directory, `${'c'.repeat(40)}.json`), JSON.stringify({ version: 1, source: { kind: 'nonsense', key: 'x' }, sessions: [{ id: 'x', name: 'orchard', messages: [] }] }));
    fs.writeFileSync(path.join(directory, `${'d'.repeat(40)}.json`), JSON.stringify({
        version: 1, source: { kind: 'roleplay', key: 'shared:character:Juniper.png', label: '' },
        sessions: [{ id: 'f'.repeat(24), name: 'Shared', updated: '2026-01-05T00:00:00.000Z', messages: [{ role: 'user', text: 'An orchard for everyone.' }] }],
    }));
    fs.writeFileSync(path.join(directory, 'quick-prompts.json'), JSON.stringify({ version: 1, revision: 1, prompts: [{ label: 'orchard', text: 'orchard' }] }));

    const found = a.find('orchard');
    assert.deepEqual(found.results.map(item => item.name).sort(), ['Kept', 'Shared']);
    assert.equal(found.results.find(item => item.name === 'Shared').where, 'Juniper');
    assert.deepEqual(b.find('orchard').results.map(item => item.name), ['Someone else']);
});

test('search returns the most recent matches first and says when there are more', t => {
    const a = account(t);
    const directory = path.join(a.directories.root, 'scratchpad');
    fs.mkdirSync(directory, { recursive: true });
    for (const [index, letter] of ['a', 'b'].entries()) {
        fs.writeFileSync(path.join(directory, `${letter.repeat(40)}.json`), JSON.stringify({
            version: 1, source: { kind: 'conversation', key: `Chat${index}`, label: `Chat ${index}` },
            sessions: Array.from({ length: 30 }, (_, at) => ({ id: `${letter}${at}`, name: `Kettle ${letter}${at}`, updated: new Date(Date.UTC(2026, index, at + 1)).toISOString(), messages: [] })),
        }));
    }
    const found = a.find('kettle');
    assert.equal(found.results.length, search.MAX_SEARCH_RESULTS);
    assert.equal(found.more, true);
    assert.equal(found.results[0].name, 'Kettle b29');
    assert.ok(found.results.every((item, index, all) => !index || all[index - 1].updated >= item.updated));
});

test('a found session is copied through the import rules and the original stays', async t => {
    const a = account(t);
    const original = a.add(NOVA, 'Harbour plans', talk('Where is the ferry?', 'At the east pier.'));
    store.mutateBucket(a.base, NOVA, bucket => {
        const session = store.findSession(bucket, original.id);
        session.messages[1].proposals = { 0: 'applied' };
        session.messages.push({ id: 'p'.repeat(24), role: 'assistant', assistant: 'taro', text: '', state: 'pending', created: 1 });
        session.settings.picked = [3];
        return bucket;
    });
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: a.f.scope.owner }, directories: a.directories };
        next();
    });
    app.use('/scratchpad', router);
    const server = await new Promise(resolve => {
        const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const post = (route, body, owner = a.f.scope.owner) => fetch(`http://127.0.0.1:${server.address().port}/scratchpad${route}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close', 'X-Neconyan-Account': owner }, body: JSON.stringify(body) });

    assert.equal((await post('/search', { query: 'f' })).status, 400);
    assert.equal((await post('/search', { query: 'ferry' }, 'someone-else')).status, 409);
    const answer = await post('/search', { query: 'ferry' });
    assert.equal(answer.status, 200);
    const [result] = (await answer.json()).results;
    assert.equal(result.sessionId, original.id);

    assert.equal((await post('/search/copy', { source: GENERAL, list: '../identities', sessionId: original.id })).status, 404);
    assert.equal((await post('/search/copy', { source: GENERAL, list: result.list, sessionId: 'e'.repeat(24) })).status, 404);
    const copied = await post('/search/copy', { source: GENERAL, list: result.list, sessionId: result.sessionId });
    assert.equal(copied.status, 200, await copied.clone().text());
    const { bucket } = await copied.json();
    const [session] = bucket.sessions;
    assert.equal(bucket.activeSessionId, session.id);
    assert.notEqual(session.id, original.id);
    assert.equal(session.name, 'Harbour plans');
    assert.deepEqual(session.messages.map(item => [item.role, item.text]), [['user', 'Where is the ferry?'], ['assistant', 'At the east pier.']]);
    assert.equal(session.messages[1].proposals, undefined, 'change card marks do not travel');
    assert.deepEqual(session.settings.picked, []);
    assert.notEqual(session.messages[0].id, original.messages[0].id);

    const kept = store.withScratchpad(a.base, lease => store.readBucketLocked(lease, NOVA));
    assert.equal(kept.sessions.length, 1);
    assert.equal(kept.sessions[0].id, original.id);
});
