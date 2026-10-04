/* eslint playwright/expect-expect: off -- Assertions use the Node test runner. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { initialiseRoleplayAccount, withRoleplayAccount, roleplayStoreDirectory, roleplayLease } = await import('../src/roleplay-store.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { router, retireNavigationPersona } = await import('../src/endpoints/chat-navigation.js');
const { readNavigationState, writeNavigationState, acceptNavigationPointer, clearNavigationPointer, enrolNavigationAlias } = await import('../src/chat-navigation-state.js');
const { prepareSettingsSave } = await import('../src/settings-version.js');
const { protectConversationNavigation } = await import('../src/conversation-navigation-identity.js');
const { commitRoleplayLifecycleLocked, reconcilePendingChatWrite } = await import('../src/roleplay-lifecycle.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

async function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-navigation-test-'));
    const users = {};
    for (const handle of ['alice', 'bob']) {
        const home = path.join(root, handle);
        const directories = Object.fromEntries(['chats', 'groupChats', 'characters', 'groups', 'avatars'].map(name => [name, path.join(home, name)]));
        directories.root = home;
        for (const folder of Object.values(directories)) fs.mkdirSync(folder, { recursive: true });
        fs.mkdirSync(path.join(directories.chats, 'Nova'));
        fs.writeFileSync(path.join(directories.characters, 'Nova.png'), writeCard(png, JSON.stringify({ name: 'Nova', description: 'Saved character' })));
        fs.writeFileSync(path.join(directories.avatars, 'User.png'), png);
        for (const chat of ['A', 'B']) fs.writeFileSync(path.join(directories.chats, 'Nova', `${chat}.jsonl`),
            [{ user_name: 'User', character_name: 'Nova', chat_metadata: {} }, { name: 'User', is_user: true, mes: 'Saved ' + chat }].map(row => JSON.stringify(row)).join('\n'));
        const threadKey = 'persona:User.png:Nova.png';
        const branch = { id: 'main', name: 'Main', lifetimeSeed: randomUUID(), createdAt: 1700000000000, messages: [{ id: 'message-a', role: 'user', name: 'User', mes: 'Exact saved Conversation', timestamp: 1700000000000 }] };
        const settings = { _version: 1, _settingsRevision: 1, power_user: { auto_load_chat: false }, extension_settings: { neconyan_conversation: {
            version: 1, settings: {}, groups: [], characters: { [threadKey]: { threadAvatar: 'Nova.png', groupId: '', activeBranchId: 'main', settings: { enabled: true }, branches: { main: branch } } },
        } } };
        fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
        users[handle] = { profile: { handle }, directories, scope: initialiseRoleplayAccount({ owner: handle, directories }), threadKey };
    }
    const app = express();
    app.use(express.json());
    // The real application's auth and CSRF middleware are covered by browser tests.
    app.use((req, res, next) => { req.user = users[req.get('Fixture-Account') || 'alice']; next(); });
    app.use('/navigation', router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { cancelAutoSaves(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const post = async (action, data = {}, handle = 'alice', headers = {}) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/navigation/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Fixture-Account': handle, ...headers }, body: JSON.stringify(data) });
        return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
    };
    const state = await post('state');
    const account = state.body.account;
    const establish = async (chat = 'A') => {
        const result = await post('establish', { account, mode: 'roleplay', locator: { group: false, avatar: 'Nova.png', chat } });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return { id: result.body.id, mode: result.body.mode };
    };
    const change = fn => {
        const file = path.join(users.alice.directories.root, 'settings.json');
        const previous = JSON.parse(fs.readFileSync(file));
        const incoming = structuredClone(previous);
        fn(incoming);
        const result = prepareSettingsSave(incoming, previous, { conversationOnly: true });
        assert.equal(result.ok, true);
        fs.writeFileSync(file, JSON.stringify(result.settings));
        return result.settings;
    };
    return { users, post, account, establish, change, root };
}

test('fresh account reads do not write navigation or enrol resources; resolution is read-only', async t => {
    const f = await fixture(t);
    const navfile = path.join(roleplayStoreDirectory(f.users.alice.scope), 'navigation.json');
    assert.equal(fs.existsSync(navfile), false);
    assert.deepEqual((await f.post('state')).body.pointer, null);
    const result = await f.post('resolve', { destination: { id: randomUUID(), mode: 'roleplay' } });
    assert.equal(result.status, 404);
    assert.equal(result.cache, 'no-store');
    assert.equal(fs.existsSync(navfile), false);
    assert.equal(Object.keys(withRoleplayAccount(f.users.alice.scope, null, lease => roleplayLease(lease).state.resources)).length, 0);
    const original = fs.readFileSync(path.join(f.users.alice.directories.chats, 'Nova', 'A.jsonl'));
    const destination = await f.establish();
    const navbytes = fs.readFileSync(navfile);
    assert.equal((await f.post('resolve', { destination })).status, 200);
    assert.deepEqual(fs.readFileSync(navfile), navbytes);
    assert.deepEqual(fs.readFileSync(path.join(f.users.alice.directories.chats, 'Nova', 'A.jsonl')), original);
});

test('account ownership, stamp and malformed identifiers fail closed', async t => {
    const f = await fixture(t);
    const destination = await f.establish();
    assert.equal((await f.post('resolve', { destination }, 'bob')).status, 404);
    assert.equal((await f.post('resolve', { destination }, 'alice', { 'X-Neconyan-Account': 'bob' })).status, 409);
    assert.equal((await f.post('establish', { mode: 'roleplay', locator: { group: false, avatar: 'Nova.png', chat: 'A' } })).status, 400);
    assert.equal((await f.post('establish', { account: { ...f.account, dataEpoch: f.account.dataEpoch + 1 }, mode: 'roleplay', locator: { group: false, avatar: 'Nova.png', chat: 'A' } })).status, 409);
    for (const bad of [{ id: '../settings.json', mode: 'roleplay' }, { ...destination, id: [destination.id] }, { ...destination, owner: 'bob' }, { ...destination, mode: 'meower' }, { id: 'a'.repeat(4000), mode: 'roleplay' }]) {
        assert.equal((await f.post('resolve', { destination: bad })).status, 400);
    }
    f.change(settings => { settings.power_user.auto_load_chat = true; });
    assert.equal((await f.post('remember', { account: f.account, destination, clientId: [randomUUID()], sequence: 1 })).status, 400);
});

test('stale visible chat and branch evidence cannot enrol a replacement destination', async t => {
    const f = await fixture(t);
    const a = await f.establish();
    assert.equal((await f.post('establish', { account: f.account, mode: 'roleplay', sourceId: randomUUID(), locator: { group: false, avatar: 'Nova.png', chat: 'A' } })).status, 404);
    assert.equal((await f.post('establish', { account: f.account, mode: 'roleplay', sourceId: a.id, locator: { group: false, avatar: 'Nova.png', chat: 'A' } })).body.id, a.id);
    const target = { avatar: 'Nova.png', personaId: 'User.png', groupId: '', branchId: 'main' };
    const saved = JSON.parse(fs.readFileSync(path.join(f.users.alice.directories.root, 'settings.json'))).extension_settings.neconyan_conversation.characters[f.users.alice.threadKey].branches.main;
    const expectedBranch = { navigationId: null, lifetimeSeed: saved.lifetimeSeed, createdAt: String(saved.createdAt) };
    const first = await f.post('establish', { account: f.account, mode: 'conversation', target, expectedBranch });
    assert.equal(first.status, 200);
    f.change(settings => { settings.extension_settings.neconyan_conversation.characters[f.users.alice.threadKey].branches.main.lifetimeSeed = randomUUID(); });
    assert.equal((await f.post('establish', { account: f.account, mode: 'conversation', target, expectedBranch })).status, 404);
});

test('enrolment is concurrent and restart-safe; native chat moves keep the exact identity', async t => {
    const f = await fixture(t);
    const results = await Promise.all(Array.from({ length: 6 }, () => f.establish()));
    assert.equal(new Set(results.map(result => result.id)).size, 1);
    const other = await f.establish('B');
    assert.notEqual(results[0].id, other.id);
    initialiseRoleplayAccount({ owner: 'alice', directories: f.users.alice.directories });
    withRoleplayAccount(f.users.alice.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
        action: 'chat-rename', intent: { from: 'A', to: 'Renamed' }, steps: [{ op: 'move', kind: 'chat', locator: { group: false, avatar: 'Nova.png', chat: 'A' }, destination: { group: false, avatar: 'Nova.png', chat: 'Renamed' } }],
    }));
    const result = await f.post('resolve', { destination: results[0] });
    assert.equal(result.status, 200);
    assert.equal(result.body.locator.chat, 'Renamed');
    assert.equal(result.body.id, results[0].id);
});

test('sequence ordering, cross-device acceptance and revision-checked clearing never refresh an old pointer', async t => {
    const f = await fixture(t);
    const a = await f.establish();
    const b = await f.establish('B');
    const clientId = randomUUID();
    assert.equal((await f.post('remember', { account: f.account, destination: a, clientId, sequence: 1 })).body.accepted, false);
    f.change(settings => { settings.power_user.auto_load_chat = true; });
    const remember = (destination, sequence, client = clientId) => f.post('remember', { account: f.account, destination, clientId: client, sequence });
    assert.equal((await remember(a, 2)).body.accepted, true);
    const latest = await remember(b, 3);
    assert.equal((await remember(a, 1)).body.accepted, false);
    assert.equal((await remember(b, 3)).body.accepted, false);
    const otherDevice = await remember(a, 1, randomUUID());
    assert.equal(otherDevice.body.pointer.id, a.id);
    assert.equal(otherDevice.body.pointer.revision, latest.body.pointer.revision + 1);
    assert.equal((await f.post('clear-stale', { account: f.account, revision: latest.body.pointer.revision })).body.cleared, false);
    assert.equal((await f.post('clear-stale', { account: f.account, revision: otherDevice.body.pointer.revision })).body.cleared, false);
    withRoleplayAccount(f.users.alice.scope, null, lease => commitRoleplayLifecycleLocked(lease, { action: 'chat-delete', intent: 'A', steps: [{ op: 'delete', kind: 'chat', locator: { group: false, avatar: 'Nova.png', chat: 'A' } }] }));
    assert.equal((await f.post('clear-stale', { account: f.account, revision: otherDevice.body.pointer.revision })).body.cleared, true);
    assert.equal((await f.post('state')).body.pointer, null);
    assert.equal(fs.existsSync(path.join(f.users.alice.directories.chats, 'Nova', 'A.jsonl')), false);
});

test('migration is repeat-safe and does not overwrite a newer device', async t => {
    const f = await fixture(t);
    f.change(settings => { settings.power_user.auto_load_chat = true; });
    const a = await f.establish();
    const b = await f.establish('B');
    const first = await f.post('migrate', { account: f.account, destination: a, clientId: randomUUID(), sequence: 1 });
    assert.equal(first.body.migrated, true);
    await f.post('remember', { account: f.account, destination: b, clientId: randomUUID(), sequence: 1 });
    const retry = await f.post('migrate', { account: f.account, destination: a, clientId: randomUUID(), sequence: 1 });
    assert.equal(retry.body.migrated, false);
    assert.equal(retry.body.pointer.id, b.id);
});

test('Conversation enrolment, edits, resets, imports and persona retirement protect branch incarnations', async t => {
    const f = await fixture(t);
    const target = { avatar: 'Nova.png', personaId: 'User.png', groupId: '', branchId: 'main' };
    const enrol = () => f.post('establish', { account: f.account, mode: 'conversation', target });
    const results = await Promise.all([enrol(), enrol(), enrol()]);
    for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(new Set(results.map(result => result.body.id)).size, 1);
    const destination = { id: results[0].body.id, mode: 'conversation' };
    assert.equal((await f.post('resolve', { destination })).status, 200);
    f.change(settings => { settings.extension_settings.neconyan_conversation.characters[f.users.alice.threadKey].branches.main.messages[0].mes = 'Edited exact chat'; });
    assert.equal((await f.post('resolve', { destination })).status, 200);
    f.change(settings => {
        const store = settings.extension_settings.neconyan_conversation;
        store.characters['persona:User.png:Copy.png'] = structuredClone(store.characters[f.users.alice.threadKey]);
    });
    const store = JSON.parse(fs.readFileSync(path.join(f.users.alice.directories.root, 'settings.json'))).extension_settings.neconyan_conversation;
    assert.equal(store.characters['persona:User.png:Copy.png'].branches.main.navigationId, undefined);
    f.change(settings => { settings.extension_settings.neconyan_conversation.characters[f.users.alice.threadKey].branches.main.lifetimeSeed = randomUUID(); });
    assert.equal((await f.post('resolve', { destination })).status, 404);
    const replacement = await enrol();
    assert.equal(replacement.status, 200);
    assert.notEqual(replacement.body.id, destination.id);
    retireNavigationPersona({ user: f.users.alice }, 'User.png', () => fs.unlinkSync(path.join(f.users.alice.directories.avatars, 'User.png')));
    fs.writeFileSync(path.join(f.users.alice.directories.avatars, 'User.png'), png);
    assert.equal((await f.post('resolve', { destination: { id: replacement.body.id, mode: 'conversation' } })).status, 404);
    assert.equal((await enrol()).status, 200);
});

test('protected branch index follows only exact canonical group moves, not merged or copied history', () => {
    const id = randomUUID();
    const branch = { id: 'main', navigationId: id, lifetimeSeed: randomUUID(), createdAt: 1, messages: [{ mes: 'Saved' }] };
    const before = { characters: { 'persona:User.png:group:g:A.png': { groupId: 'g', threadAvatar: 'A.png', branches: { main: branch } } }, navigationTargets: { [id]: { threadKey: 'persona:User.png:group:g:A.png', branchId: 'main' } } };
    const next = { characters: { 'persona:User.png:group:g:B.png': { groupId: 'g', threadAvatar: 'B.png', branches: { main: structuredClone(branch) } } } };
    assert.equal(protectConversationNavigation(next, before).navigationTargets[id].threadKey, 'persona:User.png:group:g:B.png');
    next.characters['persona:User.png:group:g:B.png'].branches.main.messages.push({ mes: 'Different merged history' });
    assert.equal(protectConversationNavigation(next, before).characters['persona:User.png:group:g:B.png'].branches.main.navigationId, undefined);
    assert.equal(protectConversationNavigation(before, before, { restoreSnapshot: true }).characters['persona:User.png:group:g:A.png'].branches.main.navigationId, undefined);
});

test('damaged navigation fails closed; stale epochs never reuse aliases', async t => {
    const f = await fixture(t);
    const destination = await f.establish();
    const filename = path.join(roleplayStoreDirectory(f.users.alice.scope), 'navigation.json');
    const saved = fs.readFileSync(filename);
    fs.writeFileSync(filename, JSON.stringify({ schema: 1, revision: 0, migration: 0, aliases: [], clients: {}, personas: {}, pointer: null }));
    assert.equal((await f.post('state')).status, 503);
    const malformed = JSON.stringify({ ...JSON.parse(saved), aliases: { [destination.id]: false } });
    fs.writeFileSync(filename, malformed);
    assert.equal((await f.post('resolve', { destination })).status, 503);
    assert.equal(fs.readFileSync(filename, 'utf8'), malformed);
    fs.writeFileSync(filename, saved);
    withRoleplayAccount(f.users.alice.scope, null, lease => {
        const document = readNavigationState(lease);
        document.dataEpoch += 1;
        writeNavigationState(lease, document);
    });
    assert.equal((await f.post('resolve', { destination })).status, 404);
    assert.deepEqual((await f.post('state')).body.pointer, null);
});

test('an interrupted lifecycle blocks resolution until recovery, without a replacement save', async t => {
    const f = await fixture(t);
    const destination = await f.establish();
    assert.throws(() => withRoleplayAccount(f.users.alice.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
        action: 'chat-delete', intent: 'A', steps: [{ op: 'delete', kind: 'chat', locator: { group: false, avatar: 'Nova.png', chat: 'A' } }],
    }, { clearDeferred() { throw new Error('Test-owned interruption'); } })), /Test-owned interruption/);
    assert.equal((await f.post('resolve', { destination })).status, 503);
    assert.equal(fs.existsSync(path.join(f.users.alice.directories.chats, 'Nova', 'A.jsonl')), false);
});

test('pure pointer ordering rejects invalid sequences and clearing unrelated revisions', () => {
    const value = { revision: 0, clients: {}, pointer: null };
    const input = { destination: { id: randomUUID(), mode: 'story' }, clientId: randomUUID(), sequence: 2 };
    assert.equal(acceptNavigationPointer(value, input), true);
    assert.equal(acceptNavigationPointer(value, { ...input, sequence: 1 }), false);
    assert.throws(() => acceptNavigationPointer(value, { ...input, sequence: Number.MAX_SAFE_INTEGER + 1 }));
    assert.equal(clearNavigationPointer(value, 2), false);
    assert.equal(clearNavigationPointer(value, 1), true);
    const aliases = { aliases: {} };
    assert.throws(() => enrolNavigationAlias(aliases, randomUUID(), { kind: 'conversation', ownerId: randomUUID(), persona: randomUUID(), target: { avatar: 'Nova.png', personaId: 'User.png', branchId: 'main', groupId: 'g' }, groupOwner: { kind: 'conversation' } }), { status: 503 });
    assert.deepEqual(aliases.aliases, {});
});

test('character rename preserves solo, group and Conversation identities through interrupted recovery', async t => {
    const f = await fixture(t);
    const solo = await f.establish();
    const conversation = await f.post('establish', { account: f.account, mode: 'conversation', target: { avatar: 'Nova.png', groupId: '', personaId: 'User.png', branchId: 'main' } });
    assert.equal(conversation.status, 200);
    const directories = f.users.alice.directories;
    fs.writeFileSync(path.join(directories.groups, 'group.json'), JSON.stringify({ id: 'group', name: 'Saved group', members: ['Nova.png'], disabled_members: [], chats: ['Group A'], chat_id: 'Group A' }));
    fs.writeFileSync(path.join(directories.groupChats, 'Group A.jsonl'), [{ chat_metadata: {} }, { name: 'User', is_user: true, mes: 'Exact group' }].map(row => JSON.stringify(row)).join('\n'));
    const group = await f.post('establish', { account: f.account, mode: 'roleplay', locator: { group: true, chat: 'Group A' }, groupId: 'group' });
    assert.equal(group.status, 200);
    const bytes = writeCard(png, JSON.stringify({ name: 'Renamed', description: 'Same saved character' }));
    assert.throws(() => withRoleplayAccount(f.users.alice.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
        operationKey: 'test-character-rename', action: 'character-rename', intent: { from: 'Nova.png', to: 'Renamed.png' }, steps: [
            { op: 'create', kind: 'character', locator: { avatar: 'Renamed.png' }, bytes },
            { op: 'move', kind: 'chat', locator: { group: false, avatar: 'Nova.png', chat: 'A' }, destination: { group: false, avatar: 'Renamed.png', chat: 'A' } },
            { op: 'delete', kind: 'character', locator: { avatar: 'Nova.png' } },
        ],
    }, { clearDeferred() { throw new Error('Test-owned rename interruption'); } })), /Test-owned rename interruption/);
    assert.equal((await f.post('resolve', { destination: solo })).status, 503);
    reconcilePendingChatWrite(f.users.alice.scope, {});
    assert.equal((await f.post('resolve', { destination: solo })).body.locator.avatar, 'Renamed.png');
    const resolved = await f.post('resolve', { destination: { id: conversation.body.id, mode: 'conversation' } });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.target.avatar, 'Renamed.png');
    assert.equal((await f.post('resolve', { destination: { id: group.body.id, mode: 'roleplay' } })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directories.groups, 'group.json'))).members, ['Renamed.png']);
});

test('an occupied Conversation rename destination is refused before files or pending state change', async t => {
    const f = await fixture(t);
    await f.post('establish', { account: f.account, mode: 'conversation', target: { avatar: 'Nova.png', groupId: '', personaId: 'User.png', branchId: 'main' } });
    f.change(settings => {
        settings.extension_settings.neconyan_conversation.characters['persona:User.png:Renamed.png'] = structuredClone(settings.extension_settings.neconyan_conversation.characters[f.users.alice.threadKey]);
    });
    assert.throws(() => withRoleplayAccount(f.users.alice.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
        action: 'character-rename', intent: { from: 'Nova.png', to: 'Renamed.png' }, steps: [
            { op: 'create', kind: 'character', locator: { avatar: 'Renamed.png' }, bytes: writeCard(png, JSON.stringify({ name: 'Renamed', description: 'Same character' })) },
            { op: 'delete', kind: 'character', locator: { avatar: 'Nova.png' } },
        ],
    })), /already occupied/);
    assert.equal(fs.existsSync(path.join(f.users.alice.directories.characters, 'Nova.png')), true);
    assert.equal(fs.existsSync(path.join(f.users.alice.directories.characters, 'Renamed.png')), false);
    assert.equal(withRoleplayAccount(f.users.alice.scope, null, lease => roleplayLease(lease).state.pending), null);
});

test('saved Conversation groups retain an exact canonical move, but not a recreated group', async t => {
    const f = await fixture(t);
    fs.writeFileSync(path.join(f.users.alice.directories.characters, 'Kit.png'), writeCard(png, JSON.stringify({ name: 'Kit', description: 'Other saved member' })));
    const originalKey = 'persona:User.png:group:cg:Nova.png';
    const movedKey = 'persona:User.png:group:cg:Kit.png';
    f.change(settings => {
        const store = settings.extension_settings.neconyan_conversation;
        store.groups.push({ id: 'cg', name: 'Saved Conversation group', personaId: 'User.png', members: ['Nova.png', 'Kit.png'], disabled_members: [], createdAt: 1, lifetimeSeed: 'first-group' });
        store.characters[originalKey] = { ...structuredClone(store.characters[f.users.alice.threadKey]), groupId: 'cg' };
    });
    const target = { avatar: 'Nova.png', groupId: 'cg', personaId: 'User.png', branchId: 'main' };
    const first = await f.post('establish', { account: f.account, mode: 'conversation', target });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const destination = { id: first.body.id, mode: 'conversation' };
    f.change(settings => {
        const store = settings.extension_settings.neconyan_conversation;
        store.characters[movedKey] = { ...store.characters[originalKey], threadAvatar: 'Kit.png' };
        delete store.characters[originalKey];
        store.groups[0].disabled_members = ['Nova.png'];
    });
    const moved = await f.post('resolve', { destination });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.target.avatar, 'Kit.png');
    f.change(settings => { settings.extension_settings.neconyan_conversation.groups[0].lifetimeSeed = 'replacement-group'; });
    assert.equal((await f.post('resolve', { destination })).status, 404);
    const replacement = await f.post('establish', { account: f.account, mode: 'conversation', target: { ...target, avatar: 'Kit.png' } });
    assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
    assert.notEqual(replacement.body.id, destination.id);
});

test('a deleted Conversation group thread reports the link as gone and lets a stale pointer clear', async t => {
    const f = await fixture(t);
    fs.writeFileSync(path.join(f.users.alice.directories.characters, 'Kit.png'), writeCard(png, JSON.stringify({ name: 'Kit', description: 'Saved member' })));
    const threadKey = 'persona:User.png:group:cg:Nova.png';
    f.change(settings => {
        const store = settings.extension_settings.neconyan_conversation;
        store.groups.push({ id: 'cg', personaId: 'User.png', members: ['Nova.png', 'Kit.png'], disabled_members: [], createdAt: 1, lifetimeSeed: 'group-life' });
        store.characters[threadKey] = { ...structuredClone(store.characters[f.users.alice.threadKey]), groupId: 'cg' };
    });
    const established = await f.post('establish', { account: f.account, mode: 'conversation', target: { avatar: 'Nova.png', groupId: 'cg', personaId: 'User.png', branchId: 'main' } });
    assert.equal(established.status, 200, JSON.stringify(established.body));
    const destination = { id: established.body.id, mode: 'conversation' };
    f.change(settings => { settings.power_user.auto_load_chat = true; });
    const remembered = await f.post('remember', { account: f.account, destination, clientId: randomUUID(), sequence: 1 });
    assert.equal(remembered.body.accepted, true);
    f.change(settings => {
        const store = settings.extension_settings.neconyan_conversation;
        delete store.characters[threadKey];
        store.groups = [];
    });
    const resolved = await f.post('resolve', { destination });
    assert.equal(resolved.status, 404, JSON.stringify(resolved.body));
    const cleared = await f.post('clear-stale', { account: f.account, revision: remembered.body.pointer.revision });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.cleared, true);
    assert.equal((await f.post('state')).body.pointer, null);
});

test('Conversation group replacement during metadata enrolment cannot bind or corrupt the old identity', async t => {
    const f = await fixture(t);
    fs.writeFileSync(path.join(f.users.alice.directories.characters, 'Kit.png'), writeCard(png, JSON.stringify({ name: 'Kit', description: 'Saved member' })));
    const threadKey = 'persona:User.png:group:cg:Nova.png';
    f.change(settings => {
        const store = settings.extension_settings.neconyan_conversation;
        store.groups.push({ id: 'cg', personaId: 'User.png', members: ['Nova.png', 'Kit.png'], disabled_members: [], createdAt: 1, lifetimeSeed: 'original-group' });
        store.characters[threadKey] = { ...structuredClone(store.characters[f.users.alice.threadKey]), groupId: 'cg' };
    });
    const filename = path.join(f.users.alice.directories.root, 'settings.json');
    const rename = fs.renameSync;
    let interrupted = false;
    t.mock.method(fs, 'renameSync', (from, to) => {
        const result = rename(from, to);
        if (!interrupted && to === filename) {
            interrupted = true;
            queueMicrotask(() => f.change(settings => { settings.extension_settings.neconyan_conversation.groups[0].lifetimeSeed = 'replacement-group'; }));
        }
        return result;
    });
    const result = await f.post('establish', { account: f.account, mode: 'conversation', target: { avatar: 'Nova.png', groupId: 'cg', personaId: 'User.png', branchId: 'main' } });
    assert.equal(interrupted, true);
    assert.equal(result.status, 404, JSON.stringify(result.body));
    assert.equal((await f.post('state')).status, 200);
    withRoleplayAccount(f.users.alice.scope, null, lease => assert.deepEqual(readNavigationState(lease).aliases, {}));
});
