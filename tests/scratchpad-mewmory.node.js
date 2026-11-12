import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';

const core = await import('../src/mewmory/core.js');
const memoryStore = await import('../src/mewmory/store.js');
const { readContextSourcesSync } = await import('../src/mewmory/sources.js');
const { roleplayLease, saveRoleplayAccount } = await import('../src/roleplay-store.js');
const { readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { commitRoleplayLifecycleLocked } = await import('../src/roleplay-lifecycle.js');
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');
const store = await import('../src/scratchpad/store.js');
const bridge = await import('../src/scratchpad/mewmory.js');
const { router } = await import('../src/endpoints/scratchpad.js');
const { acceptScratchpadReply, registerScratchpadJobs } = await import('../src/scratchpad/jobs.js');
const { getJob } = await import('../src/jobs/store.js');
const { setDirectoriesResolver, testExports: { runJob } } = await import('../src/jobs/runner.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
after(() => cancelAutoSaves());

function account(t, group = false) {
    const f = fixture(t, group, 'scratch-memory');
    const directories = f.scope.directories;
    directories.worlds = path.join(directories.root, 'worlds');
    fs.mkdirSync(directories.worlds);
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({
        _version: 0, extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    const request = body => ({ user: { profile: { handle: f.scope.owner }, directories }, get: () => undefined, body });
    const base = store.scratchpadAccountBase(request({}));
    const source = { kind: 'roleplay', key: group ? 'group:group:Source' : 'character:Nova.png:Source', label: 'Source' };
    const run = operation => store.withScratchpad(base, operation);
    const context = (settings = { include: { mewmory: true } }, from = source) => run(lease => bridge.mewmoryContextLocked(lease, from, settings));
    const archive = core.newState(f.locator);
    const sync = () => core.syncSources(archive, f.records.slice(1), readContextSourcesSync(directories, f.locator, archive));
    sync();
    const filename = memoryStore.statePath(directories, f.locator);
    const save = () => {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, JSON.stringify(archive));
    };
    const add = (id, text, options = {}) => core.putRecord(archive, core.validateRecord(archive, {
        id, kind: 'event', text, refs: [archive.timeline[0]], ...options,
    }));
    setDirectoriesResolver(() => directories);
    return { f, directories, base, source, request, run, context, archive, filename, save, add, sync };
}

test('off and non-Roleplay contexts read nothing, and an empty archive is never created', t => {
    const a = account(t);
    assert.equal(store.normaliseSettings({}).include.mewmory, false);
    for (const source of [a.source, { kind: 'general', key: 'general' }, { kind: 'conversation', key: 'other' }]) {
        const context = a.context({ include: { mewmory: source.kind !== 'roleplay' } }, source);
        assert.equal(context.enabled, false);
        assert.equal(context.text, '');
    }
    const first = a.context();
    assert.equal(first.enabled, true);
    assert.equal(first.count, 0);
    assert.equal(first.fingerprint, a.context().fingerprint);
    assert.equal(fs.existsSync(a.filename), false);
});

test('server context excludes stale and hidden evidence without mutating the shared archive', t => {
    const a = account(t);
    a.add('visible', 'VISIBLE-FACT');
    a.add('hidden', 'HIDDEN-FACT', { refs: [a.archive.timeline[1]] });
    a.add('excluded', 'EXCLUDED-FACT', { excluded: true });
    a.add('invalidated', 'INVALIDATED-FACT', { status: 'invalidated' });
    a.add('dependent', 'DEPENDENT-FACT', { dependencies: [{ id: 'hidden', version: 1 }] });
    a.save();
    const bytes = fs.readFileSync(a.filename);
    const shared = memoryStore.readStateShared(a.directories, a.f.locator);
    const before = structuredClone(shared);
    assert.deepEqual(JSON.parse(a.context().text).records.map(record => record.id).sort(), ['dependent', 'hidden', 'visible']);
    a.f.records[2].is_system = true;
    fs.writeFileSync(a.f.filename, a.f.records.map(record => JSON.stringify(record)).join('\n'));
    const result = a.context();
    assert.deepEqual(JSON.parse(result.text).records.map(record => record.id), ['visible']);
    a.f.records[1].mes = 'Edited evidence';
    fs.writeFileSync(a.f.filename, a.f.records.map(record => JSON.stringify(record)).join('\n'));
    assert.equal(a.context().count, 0);
    assert.deepEqual(shared, before);
    assert.deepEqual(fs.readFileSync(a.filename), bytes);
});

test('entries hidden from assistants and dependent memories stay out even if the archive predates the hiding', t => {
    const a = account(t);
    a.f.records[0].chat_metadata.world_info = 'Harbour';
    fs.writeFileSync(a.f.filename, a.f.records.map(record => JSON.stringify(record)).join('\n'));
    const book = { entries: { 0: { comment: 'Secret', key: ['secret'], content: 'LORE-SECRET' } } };
    const file = path.join(a.directories.worlds, 'Harbour.json');
    fs.writeFileSync(file, JSON.stringify(book));
    a.sync();
    const ref = a.archive.contextSources.find(ref => a.archive.sources[ref.id].type === 'lore');
    assert.ok(ref);
    a.add('lore', 'LORE-SECRET', { refs: [ref] });
    a.add('derived', 'DERIVED-SECRET', { dependencies: [{ id: 'lore', version: 1 }] });
    a.save();
    assert.equal(a.context().count, 2);
    book.entries[0].agentBlacklisted = true;
    fs.writeFileSync(file, JSON.stringify(book));
    assert.equal(a.context().count, 0);
});

test('pinned memories come first, records remain whole and character knowledge keeps its owner', t => {
    const a = account(t);
    core.putRecord(a.archive, core.validateRecord(a.archive, {
        id: 'nova', kind: 'entity', entityId: 'npc-nova', name: 'Nova', isCharacter: true,
        text: 'Nova', refs: [a.archive.timeline[0]],
    }));
    core.putRecord(a.archive, core.validateRecord(a.archive, {
        id: 'knowledge', kind: 'knowledge', ownerId: 'npc-nova', subjectIds: ['ferry'], method: 'author',
        evidenceText: 'Original', text: 'Only Nova knows.', refs: [a.archive.timeline[0]], pinned: true,
    }));
    for (let index = 0; index < 150; index++) a.add(`event-${index}`, `FACT-${index}`);
    a.save();
    const context = a.context();
    const { records, notice } = JSON.parse(context.text);
    assert.equal(context.count, bridge.MAX_SCRATCHPAD_MEMORIES);
    assert.equal(context.omitted, 24);
    assert.equal(records[0].id, 'knowledge');
    assert.equal(records[0].ownerId, 'npc-nova');
    assert.match(notice, /not something every character knows/);
    assert.ok(Buffer.byteLength(context.text) <= bridge.MAX_SCRATCHPAD_MEMORY_BYTES);
    a.archive.records = [];
    for (let index = 0; index < 10; index++) a.add(`large-${index}`, '<'.repeat(31000));
    a.save();
    const large = a.context();
    assert.ok(Buffer.byteLength(large.text) <= bridge.MAX_SCRATCHPAD_MEMORY_BYTES);
    assert.ok(large.omitted > 0);
    for (const record of JSON.parse(large.text).records) assert.equal(record.text.length, 31000);
    assert.ok(!large.text.includes('</mewmory_context>'));
});

for (const group of [false, true]) {
    test(`resolves ${group ? 'group' : 'solo'} stable identities after a rename and refuses deleted identities`, t => {
        const a = account(t, group);
        const id = readRoleplayChat(a.f.scope, a.f.locator).instanceId;
        const source = { ...a.source, key: `roleplay:${id}${group ? ':group:group' : ''}`, legacyKey: a.source.key };
        a.run(lease => {
            assert.equal(bridge.scratchpadMewmoryLocator(lease, source).chat, 'Source');
            commitRoleplayLifecycleLocked(lease, { operationKey: 'rename-memory-chat', action: 'chat-rename',
                intent: { from: a.f.locator, chat: 'New' },
                steps: [{ op: 'move', kind: 'chat', locator: a.f.locator, destination: { ...a.f.locator, chat: 'New' } }],
            }, roleplayNativeHost);
        });
        assert.equal(a.run(lease => bridge.scratchpadMewmoryLocator(lease, source)).chat, 'New');
        a.run(lease => {
            roleplayLease(lease).state.resources[id].status = 'deleted';
            saveRoleplayAccount(lease);
        });
        assert.throws(() => a.context({ include: { mewmory: true } }, source), { code: 'SCRATCHPAD_MEWMORY_SOURCE' });
        if (group) assert.throws(() => a.context({ include: { mewmory: true } }, { ...a.source, key: 'group:other:Source' }), { code: 'SCRATCHPAD_MEWMORY_SOURCE' });
    });
}

test('preview and accepted prompts use server records, ignore forged records and respect the saved sharing choice', async t => {
    const a = account(t);
    a.add('server', 'SERVER-MEMORY');
    a.save();
    const session = store.mutateBucket(a.base, a.source, bucket => store.createSession(bucket, {
        settings: { include: { mewmory: true }, connection: { kind: 'profile', profileId: 'saved' } },
    }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = a.request({}).user; next(); });
    app.use('/scratchpad', router);
    const server = await new Promise(resolve => { const opened = app.listen(0, '127.0.0.1', () => resolve(opened)); });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const post = body => fetch(`http://127.0.0.1:${server.address().port}/scratchpad/mewmory/context`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body),
    });
    const body = { source: a.source, sessionId: session.id, records: [{ text: 'FORGED-MEMORY' }], settings: { include: { mewmory: false } } };
    const response = await post(body);
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.count, 1);
    const calls = [];
    registerScratchpadJobs({ generate: async options => { calls.push(options); return { text: 'Remembered.' }; } });
    const sent = { ...body, submissionKey: 'memory-send', text: 'What happened?', context: 'Story', names: { user: 'User', character: 'Nova' } };
    const accepted = await acceptScratchpadReply(a.request(sent), sent);
    const request = readArtifact(a.directories, accepted.job.id, 'request');
    assert.ok(JSON.stringify(request.messages).includes('SERVER-MEMORY'));
    await runJob(getJob(a.directories, accepted.job.id));
    const block = calls[0].messages.find(message => String(message.content).startsWith('<mewmory_context>'));
    assert.equal(block.content, `<mewmory_context>\n${preview.text}\n</mewmory_context>`);
    assert.ok(!JSON.stringify(calls).includes('FORGED-MEMORY'));
    store.mutateBucket(a.base, a.source, bucket => store.updateSession(bucket, session.id, { settings: { include: { mewmory: false } } }));
    const off = await (await post({ ...body, settings: { include: { mewmory: true } } })).json();
    assert.equal(off.enabled, false);
    const second = { ...sent, submissionKey: 'memory-off' };
    const next = await acceptScratchpadReply(a.request(second), second);
    assert.ok(!JSON.stringify(readArtifact(a.directories, next.job.id, 'request').messages).includes('SERVER-MEMORY'));
});
