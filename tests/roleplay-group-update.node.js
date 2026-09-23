import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { parse } from 'acorn';
import { fixture } from './roleplay-transactions-fixture.js';
import { assertRoleplaySource, readRoleplayEntity } from '../src/generation/roleplay-source.js';
import { commitSingleGroupUpdate, commitSingleChatImport } from '../src/roleplay-lifecycle.js';
import { convertImportedChatFile, roleplayNativeHost } from '../src/endpoints/chats.js';
import { readRoleplayAccount, readRoleplayFile } from '../src/roleplay-store.js';
import { router as groupRouter } from '../src/endpoints/groups.js';
import { beginRoleplaySave, bindRoleplayAccount, finishRoleplaySave, rememberRoleplayRead, roleplayAccountStamp, sendRoleplaySave } from '../public/scripts/roleplay-save-chain.js';
import { fetchWithCsrfRetry } from '../public/scripts/csrf-token-refresh.js';

const sourceOf = saved => ({ instanceId: saved.instanceId, revision: saved.revision, rawHash: saved.rawHash });
const groupSource = fs.readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
const groupAst = parse(groupSource, { ecmaVersion: 'latest', sourceType: 'module' });

function loadGroupFunctions(runtime, names) {
    for (const name of names) {
        const node = groupAst.body.map(row => row.declaration ?? row).find(row => row.id?.name === name);
        vm.runInContext(groupSource.slice(node.start, node.end), runtime);
    }
}

async function groupHttpRuntime(t, owner) {
    const f = fixture(t, true, owner);
    const filename = path.join(f.scope.directories.groups, 'group.json');
    const group = JSON.parse(fs.readFileSync(filename, 'utf8'));
    group.chat_id = 'Source';
    fs.writeFileSync(filename, JSON.stringify(group));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { profile: { handle: f.scope.owner }, directories: f.scope.directories }; next(); });
    app.use('/api/groups', groupRouter);
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    bindRoleplayAccount(f.scope.owner, { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch });
    const base = `http://127.0.0.1:${server.address().port}`;
    const sends = [];
    const runtime = vm.createContext({
        groups: [], characters: [{ name: 'Nova', avatar: 'Nova.png' }], groupReadEvidence: new WeakMap(),
        selected_group: 'group',
        groupBackgroundState: new WeakMap(), queuedGroupMetadataById: new Map(), groupListReadGeneration: 0,
        groupSaveStates: new Map(), groupMetadataSaveQueue: Promise.resolve(), pendingGroupMetadataSaves: new Map(),
        debounce_timeout: { relaxed: 1 }, console, structuredClone, uuidv4: randomUUID,
        onlyUnique: (value, index, values) => values.indexOf(value) === index,
        getCurrentUserHandle: () => f.scope.owner, roleplayAccountStamp, rememberRoleplayRead, beginRoleplaySave,
        finishRoleplaySave, sendRoleplaySave, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        refreshCsrfToken: async () => {}, printCharacters: async () => {}, setGroupSaveStatus: () => {},
        clearTimeout, setTimeout,
        fetch: async (url, options) => {
            if (url.endsWith('/edit')) sends.push(options.body);
            return fetch(base + url, options);
        },
        fetchWithCsrfRetry: (url, build, options) => fetchWithCsrfRetry(url, build, { ...options, fetchFn: runtime.fetch }),
    });
    loadGroupFunctions(runtime, ['markGroupSaveDirty', 'snapshotGroupMetadata', 'saveGroupDebounced', '_save', 'getGroups',
        'editGroup', 'captureGroupImportTarget', 'applyGroupImportResult']);
    await runtime.getGroups();
    assert.equal(runtime.groups.length, 1);
    return { f, runtime, sends, filename };
}

test('import receipt keeps an independently changed local group draft on its stale authority', async t => {
    const { f, runtime, filename } = await groupHttpRuntime(t, 'group-import-draft');
    const target = await runtime.captureGroupImportTarget('group');
    const result = commitSingleChatImport(f.scope, { operationKey: 'group-import-draft',
        bytes: Buffer.from(f.records.map(JSON.stringify).join('\n')), originalName: 'draft.jsonl', format: 'jsonl',
        userName: 'User', characterName: 'Nova', target: { group: true, groupId: 'group', source: target.source } },
    roleplayNativeHost, convertImportedChatFile);
    runtime.groups[0].name = 'Local draft after upload started';
    runtime.applyGroupImportResult(target, { fileNames: result.names, roleplay: result });
    assert.equal(runtime.groups[0].name, 'Local draft after upload started');
    assert.equal(JSON.stringify(runtime.groups[0].chats.slice(-1)), JSON.stringify(result.names));
    assert.equal(runtime.groupReadEvidence.get(runtime.groups[0]), target.readEvidence);
    await assert.rejects(runtime.editGroup('group', true, false), /Could not save group/);
    assert.notEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).name, 'Local draft after upload started');
});

test('import target waits for the captured group metadata edit before freezing its source', async t => {
    const { runtime, filename } = await groupHttpRuntime(t, 'group-import-flush');
    runtime.debounce_timeout.relaxed = 10000;
    runtime.setGroupSaveStatus = (status, id, revision) => runtime.groupSaveStates.set(id, { status, revision });
    runtime.groups[0].name = 'Metadata saved before import';
    await runtime.editGroup('group', false, false);
    const target = await runtime.captureGroupImportTarget('group');
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, 'Metadata saved before import');
    assert.equal(target.source.revision, 2);
    assert.equal(runtime.pendingGroupMetadataSaves.size, 0);
});

test('recorded group edit updates its semantic dependency and exact physical head', t => {
    const f = fixture(t, true, 'group-update');
    const generation = f.source();
    const groupFile = path.join(f.scope.directories.groups, 'group.json');
    const before = readRoleplayEntity(f.scope, 'group', 'group');
    const group = { ...before.data, name: 'Edited group' };
    const result = commitSingleGroupUpdate(f.scope, { operationKey: 'edit', source: sourceOf(before), group });
    assert.equal(result.changed, true);
    assert.equal(result.rawChanged, true);
    assert.equal(result.revision, before.revision + 1);
    assert.equal(JSON.parse(fs.readFileSync(groupFile, 'utf8')).name, 'Edited group');
    assert.notDeepEqual(readRoleplayFile(groupFile).physical, before.physical);
    assert.deepEqual(readRoleplayFile(groupFile).physical, readRoleplayAccount(f.scope).resources[before.instanceId].head.physical);
    assert.equal(readRoleplayAccount(f.scope).resources[before.instanceId].head.rawHash, result.rawHash);
    assert.throws(() => assertRoleplaySource(f.scope, generation), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.deepEqual(commitSingleGroupUpdate(f.scope, { operationKey: 'edit', source: sourceOf(before), group }), result);
    assert.throws(() => commitSingleGroupUpdate(f.scope, { operationKey: 'edit', source: sourceOf(before), group: { ...group, name: 'Different' } }),
        { code: 'ROLEPLAY_INTENT_CONFLICT' });
});

test('exact no-op and navigation-only edits keep the semantic group revision', t => {
    const f = fixture(t, true, 'group-navigation');
    const generation = f.source();
    const before = readRoleplayEntity(f.scope, 'group', 'group');
    const same = commitSingleGroupUpdate(f.scope, { operationKey: 'no-op', source: sourceOf(before), group: before.data });
    assert.equal(same.changed, false);
    assert.equal(same.rawChanged, false);
    assert.equal(same.revision, before.revision);
    const navigation = commitSingleGroupUpdate(f.scope, { operationKey: 'navigate', source: sourceOf(before),
        group: { ...before.data, chat_id: 'New' } });
    assert.equal(navigation.changed, false);
    assert.equal(navigation.rawChanged, true);
    assert.equal(navigation.revision, before.revision);
    assert.doesNotThrow(() => assertRoleplaySource(f.scope, generation));
});

test('HTTP group edit records authority, preserves legacy metadata and dates, and refuses deleted targets', async t => {
    const f = fixture(t, true, 'group-http-update');
    const groupFile = path.join(f.scope.directories.groups, 'group.json');
    const legacy = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
    legacy.chat_metadata = { note: 'retained metadata' };
    legacy.past_metadata = { Source: { note: 'retained past data' } };
    fs.writeFileSync(groupFile, JSON.stringify(legacy));
    const oldGeneration = f.source();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { profile: { handle: f.scope.owner }, directories: f.scope.directories }; next(); });
    app.use('/groups', groupRouter);
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const post = (route, body = {}) => fetch(`http://127.0.0.1:${server.address().port}/groups/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neconyan-Account': f.scope.owner }, body: JSON.stringify(body),
    });
    const listed = await post('all');
    assert.equal(listed.status, 200);
    const group = (await listed.json()).find(item => item.id === 'group');
    const dateAdded = group.date_added;
    const { __roleplay: read, ...display } = group;
    assert.equal(read.locator.groupId, 'group');
    const edit = await post('edit', { ...display, name: 'Updated group', roleplay: { account: read.account, source: read.source, operationKey: 'http-edit' } });
    assert.equal(edit.status, 200, await edit.text());
    assert.equal(JSON.parse(fs.readFileSync(groupFile, 'utf8')).chat_metadata.note, 'retained metadata');
    assert.equal(JSON.parse(fs.readFileSync(groupFile, 'utf8')).past_metadata.Source.note, 'retained past data');
    assert.throws(() => assertRoleplaySource(f.scope, oldGeneration), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.doesNotThrow(() => f.source());
    const afterList = await post('all');
    assert.equal((await afterList.json()).find(item => item.id === 'group').date_added, dateAdded);
    const stale = await post('edit', { ...display, name: 'Stale tab overwrite',
        roleplay: { account: read.account, source: read.source, operationKey: 'stale-tab-edit' } });
    assert.equal(stale.status, 409);
    assert.equal(JSON.parse(fs.readFileSync(groupFile, 'utf8')).name, 'Updated group');
    fs.unlinkSync(groupFile);
    const deleted = await post('edit', { ...display, name: 'Recreate attempt', roleplay: { account: read.account, source: read.source, operationKey: 'deleted-edit' } });
    assert.notEqual(deleted.status, 200);
    assert.equal(fs.existsSync(groupFile), false);
});

test('supported legacy group lists beside a healthy group and records its ordinary edit', async t => {
    const { f, runtime } = await groupHttpRuntime(t, 'group-legacy-storage');
    const filename = path.join(f.scope.directories.groups, 'legacy.json');
    fs.writeFileSync(filename, JSON.stringify({ id: 'legacy', name: 'Legacy', members: ['Nova'],
        chat_metadata: { note: 'retained' }, past_metadata: { old: { note: 'past' } } }));
    const before = readRoleplayFile(filename);
    const response = await runtime.fetch('/api/groups/all', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map(group => group.id).sort(), ['group', 'legacy']);
    await runtime.getGroups();
    assert.deepEqual(readRoleplayFile(filename), before, 'listing must not rewrite the legacy file');
    assert.throws(() => readRoleplayEntity(f.scope, 'group', 'legacy'), { code: 'ROLEPLAY_SOURCE_DAMAGED' });
    const legacy = runtime.groups.find(group => group.id === 'legacy');
    assert.deepEqual(legacy.members, ['Nova.png']);
    legacy.name = 'Recorded legacy edit';
    await runtime.editGroup('legacy', true, false);
    const edited = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(edited.name, 'Recorded legacy edit');
    assert.deepEqual(edited.chat_metadata, { note: 'retained' });
    assert.deepEqual(edited.past_metadata, { old: { note: 'past' } });
    assert.doesNotThrow(() => readRoleplayEntity(f.scope, 'group', 'legacy'));
});

test('browser group queue preserves successive edits and retries one immutable lost response', async t => {
    const { f, runtime, sends, filename } = await groupHttpRuntime(t, 'group-browser-queue');
    let release;
    let reached;
    const gate = new Promise(resolve => { release = resolve; });
    const paused = new Promise(resolve => { reached = resolve; });
    const originalFetch = runtime.fetch;
    let first = true;
    runtime.fetch = async (url, options) => {
        const response = await originalFetch(url, options);
        if (url.endsWith('/edit') && first) { first = false; reached(); await gate; }
        return response;
    };
    runtime.groups[0].name = 'First local edit';
    const firstSave = runtime.editGroup('group', true, false);
    await paused;
    runtime.groups[0].name = 'Latest local edit';
    const secondSave = runtime.editGroup('group', true, false);
    release();
    await Promise.all([firstSave, secondSave]);
    assert.deepEqual(sends.map(body => JSON.parse(body).name), ['First local edit', 'Latest local edit']);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, 'Latest local edit');
    assert.equal(readRoleplayAccount(f.scope).resources[readRoleplayEntity(f.scope, 'group', 'group').instanceId].revision, 3);

    runtime.fetch = async (url, options) => {
        const response = await originalFetch(url, options);
        if (url.endsWith('/edit') && sends.length === 3) throw new Error('response lost');
        return response;
    };
    runtime.groups[0].name = 'After lost response';
    await runtime.editGroup('group', true, false);
    assert.equal(sends.length, 4);
    assert.equal(sends[2], sends[3]);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, 'After lost response');
});

test('explicit background group edit never refreshes a stale editor source', async t => {
    const { runtime, filename } = await groupHttpRuntime(t, 'group-background');
    runtime.groups[0].conversation_settings = { reply_max_tokens: 128 };
    await runtime.editGroup('group', true, false, undefined, { background: true,
        backgroundChanges: { conversation_settings: runtime.groups[0].conversation_settings } });
    runtime.groups[0].name = 'Stale editor';
    await assert.rejects(runtime.editGroup('group', true, false), /Could not save group/);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).conversation_settings.reply_max_tokens, 128);
});

test('successive and rapid Conversation settings save from their own applied background contents', async t => {
    const { runtime, filename, sends } = await groupHttpRuntime(t, 'group-background-repeat');
    const settings = value => ({ conversation_settings: { reply_max_tokens: value } });
    runtime.groups[0].conversation_settings = settings(128).conversation_settings;
    await runtime.editGroup('group', true, false, undefined, { background: true, backgroundChanges: settings(128) });
    runtime.groups[0].conversation_settings = settings(256).conversation_settings;
    await runtime.editGroup('group', true, false, undefined, { background: true, backgroundChanges: settings(256) });
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).conversation_settings.reply_max_tokens, 256);
    assert.notEqual(JSON.parse(sends[0]).roleplay.source.rawHash, JSON.parse(sends[1]).roleplay.source.rawHash);

    runtime.debounce_timeout.relaxed = 50;
    runtime.groups[0].conversation_settings = settings(384).conversation_settings;
    await runtime.editGroup('group', false, false, undefined, { background: true, backgroundChanges: settings(384) });
    runtime.groups[0].conversation_settings = settings(512).conversation_settings;
    await runtime.editGroup('group', false, false, undefined, { background: true, backgroundChanges: settings(512) });
    await new Promise(resolve => setTimeout(resolve, 90));
    await runtime.groupMetadataSaveQueue;
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).conversation_settings.reply_max_tokens, 512);
    assert.equal(sends.length, 3, 'the cancelled intermediate settings value never writes');

    const current = runtime.groups[0];
    current.name = 'Independently stale editor';
    await assert.rejects(runtime.editGroup('group', true, false), /Could not save group/);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, undefined);
    await runtime.getGroups();
    assert.equal(runtime.groups[0], current, 'a failed local edit remains visible until explicit reload');
});

test('background debounce dispatches an earlier foreground draft before its settings patch', async t => {
    const { runtime, filename, sends } = await groupHttpRuntime(t, 'group-mixed-debounce');
    runtime.groups[0].name = 'Original saved name';
    await runtime.editGroup('group', true, false);
    runtime.debounce_timeout.relaxed = 30;
    runtime.groups[0].name = 'Foreground draft that must save';
    await runtime.editGroup('group', false, false);
    runtime.groups[0].conversation_settings = { reply_max_tokens: 128 };
    await runtime.editGroup('group', false, false, undefined, { background: true,
        backgroundChanges: { conversation_settings: { reply_max_tokens: 128 } } });
    await new Promise(resolve => setTimeout(resolve, 80));
    await runtime.groupMetadataSaveQueue;
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(saved.name, 'Foreground draft that must save');
    assert.equal(saved.conversation_settings.reply_max_tokens, 128);
    assert.deepEqual(sends.map(body => JSON.parse(body).name), ['Original saved name', 'Foreground draft that must save', 'Foreground draft that must save']);
    runtime.groups[0].name = 'Later editor without a fresh read';
    await assert.rejects(runtime.editGroup('group', true, false), /Could not save group/);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, 'Foreground draft that must save');
});

test('replacing deferred background work retains its in-flight source predecessor', async t => {
    const { runtime, filename, sends } = await groupHttpRuntime(t, 'group-background-replace');
    runtime.debounce_timeout.relaxed = 30;
    const actualFetch = runtime.fetch;
    let release;
    let reached;
    const gate = new Promise(resolve => { release = resolve; });
    const paused = new Promise(resolve => { reached = resolve; });
    let first = true;
    runtime.fetch = async (url, options) => {
        const response = await actualFetch(url, options);
        if (url.endsWith('/edit') && first) { first = false; reached(); await gate; }
        return response;
    };
    runtime.groups[0].conversation_settings = { reply_max_tokens: 128 };
    const active = runtime.editGroup('group', true, false, undefined, { background: true,
        backgroundChanges: { conversation_settings: { reply_max_tokens: 128 } } });
    await paused;
    for (const value of [256, 512]) {
        runtime.groups[0].conversation_settings = { reply_max_tokens: value };
        await runtime.editGroup('group', false, false, undefined, { background: true,
            backgroundChanges: { conversation_settings: { reply_max_tokens: value } } });
    }
    release();
    await active;
    await new Promise(resolve => setTimeout(resolve, 80));
    await runtime.groupMetadataSaveQueue;
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).conversation_settings.reply_max_tokens, 512);
    assert.equal(sends.length, 2);
    assert.equal(JSON.parse(sends[1]).roleplay.source.revision, JSON.parse(sends[0]).roleplay.source.revision + 1);
});

test('foreground debounce dispatches an earlier background patch and keeps its stale draft', async t => {
    const { runtime, filename, sends } = await groupHttpRuntime(t, 'group-background-then-foreground');
    runtime.debounce_timeout.relaxed = 30;
    runtime.groups[0].conversation_settings = { reply_max_tokens: 128 };
    await runtime.editGroup('group', false, false, undefined, { background: true,
        backgroundChanges: { conversation_settings: { reply_max_tokens: 128 } } });
    runtime.groups[0].name = 'Foreground draft';
    await assert.rejects(runtime.editGroup('group', true, false), /Could not save group/);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).conversation_settings.reply_max_tokens, 128);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, undefined);
    assert.equal(runtime.groups[0].name, 'Foreground draft');
    assert.equal(sends.length, 2, 'both actors dispatched; the editor was definitively refused');
});

test('replacing deferred foreground input retains its in-flight editor predecessor', async t => {
    const { runtime, filename, sends } = await groupHttpRuntime(t, 'group-foreground-replace');
    runtime.debounce_timeout.relaxed = 30;
    const actualFetch = runtime.fetch;
    let release;
    let reached;
    const gate = new Promise(resolve => { release = resolve; });
    const paused = new Promise(resolve => { reached = resolve; });
    let first = true;
    runtime.fetch = async (url, options) => {
        const response = await actualFetch(url, options);
        if (url.endsWith('/edit') && first) { first = false; reached(); await gate; }
        return response;
    };
    runtime.groups[0].name = 'Acknowledged first';
    const active = runtime.editGroup('group', true, false);
    await paused;
    for (const name of ['Deferred second', 'Latest third']) {
        runtime.groups[0].name = name;
        await runtime.editGroup('group', false, false);
    }
    release();
    await active;
    await new Promise(resolve => setTimeout(resolve, 80));
    await runtime.groupMetadataSaveQueue;
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, 'Latest third');
    assert.equal(runtime.groups[0].name, 'Latest third');
    assert.equal(sends.length, 2);
    assert.equal(JSON.parse(sends[1]).roleplay.source.revision, JSON.parse(sends[0]).roleplay.source.revision + 1);
});

test('ordinary rapid foreground input still coalesces to its latest complete snapshot', async t => {
    const { runtime, filename, sends } = await groupHttpRuntime(t, 'group-foreground-rapid');
    runtime.debounce_timeout.relaxed = 30;
    runtime.groups[0].name = 'First keystroke';
    await runtime.editGroup('group', false, false);
    runtime.groups[0].name = 'Final name';
    await runtime.editGroup('group', false, false);
    await new Promise(resolve => setTimeout(resolve, 80));
    await runtime.groupMetadataSaveQueue;
    assert.equal(sends.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, 'Final name');
    assert.equal(runtime.groups[0].name, 'Final name');
});

for (const uncertain of [false, true]) {
    test(`${uncertain ? 'unknown' : 'refused'} foreground work cannot authorise a following background debounce`, async t => {
        const { runtime, filename } = await groupHttpRuntime(t, `group-debounce-${uncertain ? 'unknown' : 'refused'}`);
        runtime.debounce_timeout.relaxed = 30;
        let attempts = 0;
        runtime.fetch = async (url, options) => {
            if (url.endsWith('/edit')) {
                attempts++;
                if (uncertain) throw new Error('offline');
                return Response.json({ error: 'roleplay_source_changed' }, { status: 409 });
            }
            return fetch(url, options);
        };
        runtime.groups[0].name = 'Unsaved foreground';
        await runtime.editGroup('group', false, false);
        runtime.groups[0].conversation_settings = { reply_max_tokens: 128 };
        await assert.rejects(runtime.editGroup('group', true, false, undefined, { background: true,
            backgroundChanges: { conversation_settings: { reply_max_tokens: 128 } } }));
        assert.equal(attempts, uncertain ? 3 : 1);
        const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
        assert.equal(saved.name, undefined);
        assert.equal(saved.conversation_settings, undefined);
        assert.equal(runtime.groups[0].name, 'Unsaved foreground');
        assert.equal(runtime.groups[0].conversation_settings.reply_max_tokens, 128);
    });
}

test('account switch blocks both actors after a deferred cross-actor flush', async t => {
    const { runtime, filename, sends } = await groupHttpRuntime(t, 'group-debounce-account');
    runtime.debounce_timeout.relaxed = 30;
    let release;
    runtime.groupMetadataSaveQueue = new Promise(resolve => { release = resolve; });
    runtime.groups[0].name = 'Unsaved foreground';
    await runtime.editGroup('group', false, false);
    runtime.groups[0].conversation_settings = { reply_max_tokens: 128 };
    const background = runtime.editGroup('group', true, false, undefined, { background: true,
        backgroundChanges: { conversation_settings: { reply_max_tokens: 128 } } });
    runtime.getCurrentUserHandle = () => 'another-account';
    release();
    await assert.rejects(background, /account_changed/);
    assert.equal(sends.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, undefined);
    assert.equal(runtime.groups[0].name, 'Unsaved foreground');
});

test('a second background settings save queued behind the first uses its frozen acknowledgement', async t => {
    const { runtime, filename, sends } = await groupHttpRuntime(t, 'group-background-queued');
    const actualFetch = runtime.fetch;
    let release;
    let reached;
    const gate = new Promise(resolve => { release = resolve; });
    const paused = new Promise(resolve => { reached = resolve; });
    let first = true;
    runtime.fetch = async (url, options) => {
        const response = await actualFetch(url, options);
        if (url.endsWith('/edit') && first) { first = false; reached(); await gate; }
        return response;
    };
    runtime.groups[0].conversation_settings = { reply_max_tokens: 128 };
    const earlier = runtime.editGroup('group', true, false, undefined, { background: true,
        backgroundChanges: { conversation_settings: { reply_max_tokens: 128 } } });
    await paused;
    runtime.groups[0].conversation_settings = { reply_max_tokens: 256 };
    const later = runtime.editGroup('group', true, false, undefined, { background: true,
        backgroundChanges: { conversation_settings: { reply_max_tokens: 256 } } });
    release();
    await Promise.all([earlier, later]);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).conversation_settings.reply_max_tokens, 256);
    assert.equal(JSON.parse(sends[1]).roleplay.source.revision, JSON.parse(sends[0]).roleplay.source.revision + 1);
    runtime.groups[0].name = 'Editor did not load background';
    await assert.rejects(runtime.editGroup('group', true, false), /Could not save group/);
});

test('background work queued behind foreground uses that frozen acknowledgement without saving an unrelated draft', async t => {
    const { f, runtime, filename, sends } = await groupHttpRuntime(t, 'group-background-after-foreground');
    const actualFetch = runtime.fetch;
    let release;
    let reached;
    const gate = new Promise(resolve => { release = resolve; });
    const paused = new Promise(resolve => { reached = resolve; });
    let first = true;
    runtime.fetch = async (url, options) => {
        const response = await actualFetch(url, options);
        if (url.endsWith('/edit') && first) { first = false; reached(); await gate; }
        return response;
    };
    runtime.groups[0].name = 'Foreground one';
    const foreground = runtime.editGroup('group', true, false);
    await paused;
    runtime.groups[0].name = 'Unqueued editor draft';
    runtime.markGroupSaveDirty('group');
    runtime.groups[0].conversation_settings = { reply_max_tokens: 333 };
    const background = runtime.editGroup('group', true, false, undefined, { background: true,
        backgroundChanges: { conversation_settings: { reply_max_tokens: 333 } } });
    release();
    await Promise.all([foreground, background]);
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(saved.name, 'Foreground one');
    assert.equal(saved.conversation_settings.reply_max_tokens, 333);
    const foregroundResult = Object.values(readRoleplayAccount(f.scope).submissions)
        .find(receipt => receipt.outcome?.revision === 2).outcome;
    assert.deepEqual(JSON.parse(sends[1]).roleplay.source, sourceOf(foregroundResult));
    assert.equal(runtime.groups[0].name, 'Unqueued editor draft');
    await assert.rejects(runtime.editGroup('group', true, false), /Could not save group/);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, 'Foreground one');
});

test('a refused background change stays locally visible without changing editor authority', async t => {
    const { f, runtime, filename } = await groupHttpRuntime(t, 'group-background-refusal');
    const serverRead = readRoleplayEntity(f.scope, 'group', 'group');
    commitSingleGroupUpdate(f.scope, { operationKey: 'external-edit', source: sourceOf(serverRead),
        group: { ...serverRead.data, name: 'External edit' } });
    const current = runtime.groups[0];
    current.conversation_settings = { reply_max_tokens: 128 };
    await assert.rejects(runtime.editGroup('group', true, false, undefined, { background: true,
        backgroundChanges: { conversation_settings: { reply_max_tokens: 128 } } }), /Could not save group/);
    await runtime.getGroups();
    assert.equal(runtime.groups[0], current);
    assert.equal(current.conversation_settings.reply_max_tokens, 128);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, 'External edit');
});

test('group member rename carries only its member change as explicit background work', async () => {
    const calls = [];
    const runtime = vm.createContext({
        groups: [{ id: 'group', name: 'Group', members: ['Nova.png'], chats: [] }],
        editGroup: async (...args) => { calls.push(args); }, getCurrentUserHandle: () => 'owner', console,
    });
    loadGroupFunctions(runtime, ['renameGroupMember']);
    await runtime.renameGroupMember('Nova.png', 'Renamed.png', 'Renamed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'group');
    assert.equal(calls[0][4].background, true);
    assert.equal(calls[0][4].backgroundChanges.memberRename.from, 'Nova.png');
    assert.equal(calls[0][4].backgroundChanges.memberRename.to, 'Renamed.png');
});

test('member rename records its patch without carrying an unrelated editor draft', async t => {
    const { runtime, filename } = await groupHttpRuntime(t, 'group-member-background');
    const current = runtime.groups[0];
    current.name = 'Unqueued editor draft';
    runtime.markGroupSaveDirty('group');
    current.members[0] = 'Renamed.png';
    await runtime.editGroup('group', true, false, undefined, { background: true,
        backgroundChanges: { memberRename: { from: 'Nova.png', to: 'Renamed.png' } } });
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.deepEqual(saved.members, ['Renamed.png']);
    assert.equal(saved.name, undefined);
    assert.equal(current.name, 'Unqueued editor draft');
});

test('group CSRF refresh reuses the exact queued JSON body and key', async t => {
    const { runtime, filename } = await groupHttpRuntime(t, 'group-csrf');
    const actualFetch = runtime.fetch;
    const bodies = [];
    let refreshes = 0;
    runtime.refreshCsrfToken = async () => { refreshes++; };
    runtime.fetch = async (url, options) => {
        if (url.endsWith('/edit')) {
            bodies.push(options.body);
            if (bodies.length === 1) return new Response('Invalid CSRF token', { status: 403 });
        }
        return actualFetch(url, options);
    };
    runtime.groups[0].name = 'After CSRF refresh';
    await runtime.editGroup('group', true, false);
    assert.equal(refreshes, 1);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, 'After CSRF refresh');
});

test('a late group listing cannot replace newer unsaved local edits', async t => {
    const { runtime } = await groupHttpRuntime(t, 'group-late-list');
    const current = runtime.groups[0];
    const actualFetch = runtime.fetch;
    let release;
    let reached;
    const gate = new Promise(resolve => { release = resolve; });
    const paused = new Promise(resolve => { reached = resolve; });
    runtime.fetch = async (url, options) => {
        const response = await actualFetch(url, options);
        if (url.endsWith('/all')) { reached(); await gate; }
        return response;
    };
    const listing = runtime.getGroups();
    await paused;
    current.name = 'Newer unsaved local text';
    runtime.markGroupSaveDirty('group');
    release();
    await listing;
    assert.equal(runtime.groups[0], current);
    assert.equal(runtime.groups[0].name, 'Newer unsaved local text');
});

test('an older listing cannot remove a group applied by a newer listing', async t => {
    const { f, runtime } = await groupHttpRuntime(t, 'group-list-order');
    const actualFetch = runtime.fetch;
    let release;
    let reached;
    const gate = new Promise(resolve => { release = resolve; });
    const paused = new Promise(resolve => { reached = resolve; });
    let first = true;
    runtime.fetch = async (url, options) => {
        const response = await actualFetch(url, options);
        if (url.endsWith('/all') && first) { first = false; reached(); await gate; }
        return response;
    };
    const old = runtime.getGroups();
    await paused;
    fs.writeFileSync(path.join(f.scope.directories.groups, 'new-group.json'), JSON.stringify({ id: 'new-group', members: ['Nova.png'],
        chats: ['Source'], chat_id: 'Source' }));
    await runtime.getGroups();
    const newGroup = runtime.groups.find(group => group.id === 'new-group');
    assert.ok(newGroup);
    newGroup.name = 'New unsaved draft';
    runtime.markGroupSaveDirty('new-group');
    release();
    await old;
    assert.equal(runtime.groups.find(group => group.id === 'new-group'), newGroup);
    assert.equal(newGroup.name, 'New unsaved draft');
});

test('old group receipt replay retains a later edit and deletion', t => {
    const f = fixture(t, true, 'group-replay');
    const filename = path.join(f.scope.directories.groups, 'group.json');
    const firstRead = readRoleplayEntity(f.scope, 'group', 'group');
    const firstInput = { operationKey: 'first', source: sourceOf(firstRead), group: { ...firstRead.data, name: 'First' } };
    const first = commitSingleGroupUpdate(f.scope, firstInput);
    const secondRead = readRoleplayEntity(f.scope, 'group', 'group');
    const second = commitSingleGroupUpdate(f.scope, { operationKey: 'second', source: sourceOf(secondRead),
        group: { ...secondRead.data, name: 'Second' } });
    const later = readRoleplayFile(filename);
    assert.notEqual(first.rawHash, second.rawHash);
    assert.deepEqual(commitSingleGroupUpdate(f.scope, firstInput), first);
    assert.deepEqual(readRoleplayFile(filename), later);
    fs.unlinkSync(filename);
    assert.deepEqual(commitSingleGroupUpdate(f.scope, firstInput), first);
    assert.equal(fs.existsSync(filename), false);
    fs.writeFileSync(filename, JSON.stringify({ ...firstRead.data, name: 'Replacement after deletion' }));
    const replacement = readRoleplayFile(filename);
    assert.deepEqual(commitSingleGroupUpdate(f.scope, firstInput), first);
    assert.deepEqual(readRoleplayFile(filename), replacement);
});

test('a replaced group and wrong account epoch cannot use an old update source', t => {
    const f = fixture(t, true, 'group-replaced');
    const filename = path.join(f.scope.directories.groups, 'group.json');
    const saved = readRoleplayEntity(f.scope, 'group', 'group');
    const input = { operationKey: 'replace-attempt', source: sourceOf(saved), group: { ...saved.data, name: 'Attempt' } };
    assert.throws(() => commitSingleGroupUpdate({ ...f.scope, dataEpoch: f.scope.dataEpoch + 1 }, input),
        { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    const replacement = filename + '.replacement';
    fs.writeFileSync(replacement, JSON.stringify({ ...saved.data, name: 'External replacement' }));
    fs.renameSync(replacement, filename);
    assert.throws(() => commitSingleGroupUpdate(f.scope, input), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).name, 'External replacement');
});

test('oversized group output refuses before any file or ledger effect', t => {
    const f = fixture(t, true, 'group-capacity');
    const filename = path.join(f.scope.directories.groups, 'group.json');
    const saved = readRoleplayEntity(f.scope, 'group', 'group');
    const beforeFile = readRoleplayFile(filename);
    const beforeState = readRoleplayAccount(f.scope);
    const group = { ...saved.data, name: 'x'.repeat(64 * 1024 * 1024) };
    assert.throws(() => commitSingleGroupUpdate(f.scope, { operationKey: 'too-large', source: sourceOf(saved), group }),
        { code: 'ROLEPLAY_STORE_FULL' });
    assert.deepEqual(readRoleplayFile(filename), beforeFile);
    assert.deepEqual(readRoleplayAccount(f.scope), beforeState);
});
