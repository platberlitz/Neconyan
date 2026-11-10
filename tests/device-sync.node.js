/* eslint playwright/expect-expect: off -- These tests use node:assert on real disposable files and transports. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { USER_DIRECTORY_TEMPLATE } = await import('../src/constants.js');
const { initialiseRoleplayAccount, withRoleplayAccountLock, roleplayLease, saveRoleplayAccount } = await import('../src/roleplay-store.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const { categories, categoryFor, decrypt, encrypt, entry, reconcile, validateSnapshot, LIMITS } = await import('../src/device-sync/protocol.js');
const { snapshotLocked, publishEntry, currentEntry, validateData, discardEntryStage } = await import('../src/device-sync/data.js');
const { withSync } = await import('../src/device-sync/store.js');
const { configureSync, createGrant, authoriseGrant, revokeGrant, readSyncState, manualSync, exportEnvelope, importEnvelope, resolveConflict, recoverSync, forgetConflict, conflictCopy } = await import('../src/device-sync/service.js');
const { webdavSync, gistSync, validateConfig } = await import('../src/device-sync/transports.js');
const { targetUrl, request } = await import('../src/device-sync/network.js');
const password = 'shared test secret, never a real credential';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

function fixture(t, name = 'fixture') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-sync-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const root = path.join(directory, name);
    const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, relative]) => [key, path.join(root, relative)]));
    for (const dir of Object.values(directories)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ power_user: {} }));
    const base = { owner: name, directories };
    const scope = initialiseRoleplayAccount(base);
    const account = { accountId: scope.accountId, dataEpoch: scope.dataEpoch };
    const enable = (method = 'file', config) => configureSync(base, account, { method, enabled: true, passphrase: password, config });
    const write = (relative, value) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), value); };
    const send = () => manualSync(base, account, 'file', async context => ({ envelope: await exportEnvelope(context) })).then(value => value.envelope);
    const receive = envelope => manualSync(base, account, 'file', context => importEnvelope(context, envelope, 'file'));
    return { directory, root, base, scope, account, enable, write, send, receive };
}
const snapshot = (entries, overrides = {}) => ({ format: 'neconyan-device-sync', version: 1, deviceId: randomUUID(), sequence: 1, categories: ['presets'], entries, ...overrides });
const response = (status, value, headers = {}) => ({ status, headers, value: () => value });

test('all four methods start off, categories are bounded, status reveals no secrets and disabled work never runs', async t => {
    const f = fixture(t);
    const status = readSyncState(f.base, f.account);
    assert.deepEqual(Object.values(status.methods).map(value => value.enabled), [false, false, false, false]);
    for (const method of Object.keys(status.methods)) await assert.rejects(() => manualSync(f.base, f.account, method, () => assert.fail('disabled side effect')), /switched off/);
    assert.throws(() => categories(['secrets'])); assert.throws(() => categories(['presets', 'presets']));
    f.enable(); f.enable('gist', { token: 'private-token' });
    configureSync(f.base, f.account, { method: 'file', enabled: false });
    assert.equal(readSyncState(f.base, f.account).methods.gist.enabled, true);
    const exposed = JSON.stringify(readSyncState(f.base, f.account));
    assert.ok(!exposed.includes(password)); assert.ok(!exposed.includes('private-token')); assert.ok(!exposed.includes(f.directory));
});

test('authenticated encryption rejects the wrong passphrase and every tampered field before import', async () => {
    const value = snapshot([entry('instruct/One.json', Buffer.from('{"name":"One"}'))]);
    const encrypted = await encrypt(value, password);
    assert.deepEqual(await decrypt(encrypted, password), value);
    assert.ok(!JSON.stringify(encrypted).includes('One.json'));
    await assert.rejects(() => decrypt(encrypted, 'another wrong passphrase'), /wrong|changed/);
    for (const field of ['data', 'iv', 'salt', 'tag']) {
        const changed = { ...encrypted, [field]: (encrypted[field][0] === 'A' ? 'B' : 'A') + encrypted[field].slice(1) };
        await assert.rejects(() => decrypt(changed, password));
    }
    await assert.rejects(() => decrypt({ ...encrypted, kdf: 'scrypt-999999999' }, password), /Unsupported/);
});

test('manifest rejects traversal, ambiguous names, duplicate paths, links-as-entries and unsupported formats', () => {
    for (const name of ['../settings.json', '/instruct/One.json', 'instruct/../One.json', 'instruct/One%2ejson', 'instruct/One\\two.json', 'instruct/One.json.', 'instruct/CON.json', 'secrets.json', 'settings.json']) assert.throws(() => categoryFor(name));
    const one = entry('instruct/One.json', Buffer.from('{}'));
    assert.throws(() => validateSnapshot(snapshot([one, one])), /repeats/);
    assert.throws(() => validateSnapshot(snapshot([one, { ...one, path: 'instruct/one.json' }])), /repeats/);
    assert.throws(() => validateSnapshot(snapshot([{ ...one, type: 'symlink' }])), /Invalid/);
    assert.throws(() => validateSnapshot(snapshot([{ ...one, hash: 'bad' }])), /hash/);
    assert.throws(() => validateSnapshot(snapshot([{ ...one, bases: [{ deviceId: randomUUID(), hash: 'bad' }] }])), /history/);
    for (const sequence of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateSnapshot(snapshot([{ ...one,
        bases: [{ deviceId: randomUUID(), hash: one.hash, sequence }] }])), /history/);
    assert.throws(() => validateSnapshot(snapshot([one], { version: 2 })), /Unsupported/);
    assert.throws(() => validateSnapshot(snapshot([entry('chats/Nova/Story.jsonl', Buffer.from('{}'))], { categories: ['characters'] })), /missing/);
});

test('three-way reconciliation never treats an unknown difference or deletion as permission to overwrite', () => {
    assert.equal(reconcile('local', 'remote', null), 'conflict');
    assert.equal(reconcile(null, 'remote', null), 'incoming');
    assert.equal(reconcile('same', 'same', null), 'equal');
    assert.equal(reconcile('changed', 'old', { local: 'old', remote: 'old' }), 'local');
    assert.equal(reconcile('old', 'changed', { local: 'old', remote: 'old' }), 'incoming');
    assert.equal(reconcile(null, 'changed', { local: 'old', remote: 'old' }), 'conflict');
    assert.equal(reconcile('both-a', 'both-b', { local: 'old', remote: 'old' }), 'conflict');
});

test('files transfer native cards and metadata-rich chats through protected writers, then replay without duplicate data', async t => {
    const a = fixture(t, 'a'), b = fixture(t, 'b'); a.enable(); b.enable();
    const card = writeCard(png, JSON.stringify({ name: 'Nova', description: 'Embedded data', extensions: { custom: 'keep' } }));
    a.write('characters/Nova.png', card);
    const records = [{ user_name: 'Me', character_name: 'Nova', unknown: true, chat_metadata: { custom: { important: true } } },
        { name: 'Nova', is_user: false, mes: 'Hello', swipes: ['Hello', 'Other'], swipe_id: 0, swipe_info: [{ extra: { reasoning: 'kept' } }, {}], extra: { custom: 'also kept' } }];
    a.write('chats/Nova/Story.jsonl', records.map(JSON.stringify).join('\n'));
    const envelope = await a.send();
    const result = await b.receive(envelope);
    assert.equal(result.imported, 2);
    assert.ok(fs.readFileSync(path.join(b.root, 'characters/Nova.png')).equals(card));
    const saved = fs.readFileSync(path.join(b.root, 'chats/Nova/Story.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(saved[1], records[1]); assert.equal(saved[0].unknown, true);
    assert.deepEqual(saved[0].chat_metadata.custom, records[0].chat_metadata.custom);
    assert.ok(saved[0].chat_metadata.neconyan_roleplay);
    assert.equal((await b.receive(envelope)).replayed, true);
});

test('concurrent edits preserve both versions; explicit choices and stale snapshots cannot undo a later edit', async t => {
    const a = fixture(t, 'a'), b = fixture(t, 'b'); a.enable(); b.enable();
    a.write('instruct/One.json', '{"text":"first"}'); const first = await a.send(); await b.receive(first);
    a.write('instruct/One.json', '{"text":"remote"}'); b.write('instruct/One.json', '{"text":"local"}');
    const next = await a.send(); assert.equal((await b.receive(next)).conflicts, 1);
    const conflict = readSyncState(b.base, b.account).conflicts[0];
    assert.equal(fs.readFileSync(path.join(b.root, 'instruct/One.json'), 'utf8'), '{"text":"local"}');
    resolveConflict(b.base, b.account, conflict.id, 'incoming');
    assert.equal(fs.readFileSync(path.join(b.root, 'instruct/One.json'), 'utf8'), '{"text":"remote"}');
    assert.equal(readSyncState(b.base, b.account).conflicts[0].resolved, true);
    b.write('instruct/One.json', '{"text":"later"}'); await b.receive(first); await b.receive(next);
    assert.equal(fs.readFileSync(path.join(b.root, 'instruct/One.json'), 'utf8'), '{"text":"later"}');
    withSync(b.base, b.account, ({ state }) => {
        assert.equal(Buffer.from(state.conflicts[conflict.id].local.data, 'base64').toString(), '{"text":"local"}');
        assert.equal(Buffer.from(state.conflicts[conflict.id].remote.data, 'base64').toString(), '{"text":"remote"}');
    });
});

test('offline files return one-sided edits using recognised shared history, but unknown history cannot overwrite a first difference', async t => {
    const a = fixture(t, 'a'), b = fixture(t, 'b'); a.enable(); b.enable();
    a.write('instruct/History.json', '{"value":"A"}'); await b.receive(await a.send());
    b.write('instruct/History.json', '{"value":"B"}');
    const returned = await b.send(); assert.equal((await a.receive(returned)).imported, 1);
    assert.equal(fs.readFileSync(path.join(a.root, 'instruct/History.json'), 'utf8'), '{"value":"B"}');
    const c = fixture(t, 'c'), d = fixture(t, 'd'); c.enable(); d.enable();
    c.write('instruct/Deleted.json', '{"value":"C"}'); await d.receive(await c.send());
    fs.unlinkSync(path.join(c.root, 'instruct/Deleted.json')); d.write('instruct/Deleted.json', '{"value":"D"}');
    assert.equal((await c.receive(await d.send())).conflicts, 1);
    assert.equal(fs.existsSync(path.join(c.root, 'instruct/Deleted.json')), false);
    const value = await decrypt(returned, password);
    value.deviceId = randomUUID(); value.entries[0].data = Buffer.from('{"value":"X"}').toString('base64');
    Object.assign(value.entries[0], entry('instruct/History.json', Buffer.from('{"value":"X"}')));
    value.entries[0].bases = [{ deviceId: withSync(a.base, a.account, ({ state }) => state.deviceId), hash: 'f'.repeat(64) }];
    assert.equal((await a.receive(await encrypt(value, password))).conflicts, 1);
    assert.equal(fs.readFileSync(path.join(a.root, 'instruct/History.json'), 'utf8'), '{"value":"B"}');
});

test('a concurrent local save after staging is retained, recovery preserves the conflict and removes restrictive plaintext staging', t => {
    const f = fixture(t); f.enable(); f.write('instruct/Local.json', '{"base":true}');
    let temporary;
    withSync(f.base, f.account, ({ lease, state, save }) => {
        const remote = entry('instruct/Local.json', Buffer.from('{"remote":true}'));
        const before = entry(remote.path, Buffer.from('{"base":true}')).hash;
        const effect = {};
        state.targets.test = { accepted: {} };
        state.journal = { id: randomUUID(), target: 'test', method: 'file', items: [{ before, remote, effect }], next: 0, result: { imported: 0, conflicts: 0, unchanged: 0 } }; save();
        assert.throws(() => publishEntry(lease, remote, effect, 'device-sync:interrupted-save', () => {
            save();
            if (effect.staged && !temporary) {
                temporary = path.join(f.root, effect.staged.temporary);
                assert.equal(fs.statSync(temporary).mode & 0o777, 0o600);
                f.write(remote.path, '{"later":true}');
            }
        }));
    });
    assert.equal(recoverSync(f.base, f.account, 'file').conflicts, 1);
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(fs.readFileSync(path.join(f.root, 'instruct/Local.json'), 'utf8'), '{"later":true}');
    const privateRoot = path.join(f.directory, '_device-sync');
    const privateFile = fs.readdirSync(path.join(privateRoot, fs.readdirSync(privateRoot)[0]))[0];
    assert.equal(fs.statSync(path.join(privateRoot, fs.readdirSync(privateRoot)[0], privateFile)).mode & 0o777, 0o600);
});

test('whole-package format validation happens before any mutation; links and hardlinks fail closed', async t => {
    const f = fixture(t); f.enable();
    const bad = snapshot([entry('instruct/Valid.json', Buffer.from('{}')), entry('instruct/Broken.json', Buffer.from('broken'))]);
    const encrypted = await encrypt(bad, password);
    await assert.rejects(() => f.receive(encrypted), /UTF-8 JSON/);
    assert.equal(fs.existsSync(path.join(f.root, 'instruct/Valid.json')), false);
    f.write('instruct/Source.json', '{}'); fs.linkSync(path.join(f.root, 'instruct/Source.json'), path.join(f.root, 'instruct/Hard.json'));
    await assert.rejects(() => f.send());
    fs.unlinkSync(path.join(f.root, 'instruct/Hard.json'));
    fs.symlinkSync(path.join(f.root, 'instruct/Source.json'), path.join(f.root, 'instruct/Link.json'));
    await assert.rejects(() => f.send(), /Linked/);
});

test('portable settings never copy credentials, connections, active navigation or device options', async t => {
    const a = fixture(t, 'a'), b = fixture(t, 'b'); a.enable(); b.enable();
    a.write('settings.json', JSON.stringify({ oai_settings: { api_key: 'never-copy' }, active_character: 'source', power_user: { font_scale: 1.2, chat_width: 80, mobileWidth: 23,
        personas: { 'me.png': 'My persona' }, persona_descriptions: { 'me.png': { description: 'Persona words', position: 0, depth: 2, role: 0, private: 'excluded' } } } }));
    a.write('User Avatars/me.png', png);
    b.write('settings.json', JSON.stringify({ oai_settings: { custom_url: 'https://keep.invalid' }, power_user: { mobileWidth: 51 } }));
    const value = await decrypt(await a.send(), password);
    assert.ok(!JSON.stringify(value).includes('never-copy')); assert.ok(!JSON.stringify(value).includes('excluded'));
    await b.receive(await encrypt(value, password));
    const saved = JSON.parse(fs.readFileSync(path.join(b.root, 'settings.json')));
    assert.equal(saved.oai_settings.custom_url, 'https://keep.invalid'); assert.equal(saved.power_user.mobileWidth, 51);
    assert.equal(saved.power_user.font_scale, 1.2); assert.equal(saved.power_user.personas['me.png'], 'My persona');
});

test('persona return edits preserve every nonportable descriptor field and omit only supported fields', async t => {
    const a = fixture(t, 'a'), b = fixture(t, 'b'); a.enable(); b.enable();
    const extra = { title: 'Local title', lorebook: 'Important lore', connections: [{ type: 'character', id: 'Nova.png' }],
        appendices: [{ id: 'extra', description: 'Keep this' }], activeAppendices: ['extra'], custom: { nested: true } };
    for (const f of [a, b]) {
        f.write('User Avatars/me.png', png);
        f.write('settings.json', JSON.stringify({ power_user: { personas: { 'me.png': 'Me' }, persona_descriptions: {
            'me.png': { ...extra, description: 'Base', position: 0, depth: 2, role: 0 },
        } } }));
    }
    await b.receive(await a.send());
    const changed = JSON.parse(fs.readFileSync(path.join(b.root, 'settings.json')));
    changed.power_user.persona_descriptions['me.png'].description = 'Returned edit';
    delete changed.power_user.persona_descriptions['me.png'].depth;
    b.write('settings.json', JSON.stringify(changed));
    assert.equal((await a.receive(await b.send())).imported, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(a.root, 'settings.json'))).power_user.persona_descriptions['me.png'];
    assert.deepEqual(saved, { ...extra, description: 'Returned edit', position: 0, role: 0 });
});

test('consumed staging cleanup recovers after rename then a newer local save, and rejects a replaced temporary file', t => {
    const f = fixture(t); f.enable(); f.write('instruct/Rename.json', '{"v":0}');
    let stage;
    withSync(f.base, f.account, ({ lease, state, save }) => {
        const remote = entry('instruct/Rename.json', Buffer.from('{"v":1}')), effect = {};
        state.targets.test = { accepted: {} };
        state.journal = { id: randomUUID(), method: 'file', target: 'test', next: 0,
            items: [{ before: currentEntry(lease, remote.path).hash, remote, effect }], result: { imported: 0, conflicts: 0, unchanged: 0 } }; save();
        publishEntry(lease, remote, effect, 'rename-interruption', save);
        stage = effect.staged;
        assert.equal(fs.existsSync(path.join(f.root, stage.temporary)), false);
    });
    f.write('instruct/Rename.json', '{"v":2}');
    assert.equal(recoverSync(f.base, f.account, 'file').conflicts, 1);
    assert.equal(readSyncState(f.base, f.account).recoveryPending, false);
    assert.equal(fs.readFileSync(path.join(f.root, 'instruct/Rename.json'), 'utf8'), '{"v":2}');
    assert.equal(recoverSync(f.base, f.account, 'file').conflicts, 0);
    withSync(f.base, f.account, ({ lease }) => {
        f.write(stage.temporary, 'unrelated replacement');
        assert.throws(() => discardEntryStage(lease, { staged: stage }), { code: 'AUTHORING_SOURCE_CHANGED' });
        assert.equal(fs.readFileSync(path.join(f.root, stage.temporary), 'utf8'), 'unrelated replacement');
    });
});

test('ordinary recovery settles an already-published authoring write before its journal cursor advanced', t => {
    const f = fixture(t); f.enable(); f.write('instruct/Applied.json', '{"v":0}');
    withSync(f.base, f.account, ({ lease, state, save }) => {
        const remote = entry('instruct/Applied.json', Buffer.from('{"v":1}')), effect = {};
        state.targets.test = { accepted: {} };
        state.journal = { id: randomUUID(), method: 'file', target: 'test', next: 0, items: [{ before: currentEntry(lease, remote.path).hash, remote, effect }],
            result: { imported: 0, conflicts: 0, unchanged: 0 } }; save();
        publishEntry(lease, remote, effect, 'already-published', save);
    });
    assert.equal(recoverSync(f.base, f.account, 'file').imported, 1);
    assert.equal(recoverSync(f.base, f.account, 'file').imported, 0);
    assert.equal(readSyncState(f.base, f.account).recoveryPending, false);
    assert.equal(fs.readFileSync(path.join(f.root, 'instruct/Applied.json'), 'utf8'), '{"v":1}');
});

for (const kind of ['appearance', 'persona']) for (const point of ['selected', 'staged', 'published']) {
    test(`portable ${kind} recovery rebases unrelated settings after interruption at ${point}`, t => {
        const f = fixture(t); f.enable();
        const relative = kind === 'appearance' ? 'portable/appearance.json' : 'portable/personas/me.png.json';
        const before = { power_user: { font_scale: 1, personas: { 'me.png': 'Me' }, persona_descriptions: { 'me.png': { description: 'Before', title: 'Keep title' } } }, unrelated: 'old' };
        f.write('settings.json', JSON.stringify(before));
        const remote = entry(relative, Buffer.from(JSON.stringify(kind === 'appearance' ? { font_scale: 1.2 } : { name: 'Me', description: { description: 'Incoming' } })));
        withSync(f.base, f.account, ({ lease, state, save }) => {
            const effect = {};
            state.targets.test = { accepted: {} };
            state.journal = { id: randomUUID(), method: 'file', target: 'test', next: 0,
                items: [{ before: currentEntry(lease, relative).hash, remote, effect }], result: { imported: 0, conflicts: 0, unchanged: 0 } }; save();
            if (point === 'published') publishEntry(lease, remote, effect, 'virtual-interruption', save);
            else assert.throws(() => publishEntry(lease, remote, effect, 'virtual-interruption', () => {
                save();
                if (point === 'selected' || effect.staged) throw new Error('Injected durable interruption');
            }), /Injected/);
        });
        const later = JSON.parse(fs.readFileSync(path.join(f.root, 'settings.json')));
        later.unrelated = 'latest'; later.power_user.anotherLocalPreference = 42;
        later.power_user.persona_descriptions['me.png'].title = 'Latest local title';
        f.write('settings.json', JSON.stringify(later));
        assert.equal(recoverSync(f.base, f.account, 'file').imported, 1);
        const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'settings.json')));
        assert.equal(saved.unrelated, 'latest'); assert.equal(saved.power_user.anotherLocalPreference, 42);
        assert.equal(kind === 'appearance' ? saved.power_user.font_scale : saved.power_user.persona_descriptions['me.png'].description, kind === 'appearance' ? 1.2 : 'Incoming');
        assert.equal(saved.power_user.persona_descriptions['me.png'].title, 'Latest local title');
        assert.equal(readSyncState(f.base, f.account).recoveryPending, false);
        assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.author-')), false);
    });
}

test('a later edit of the portable settings projection becomes a recoverable conflict, not a stale rebase', t => {
    const f = fixture(t); f.enable(); f.write('settings.json', '{"power_user":{"font_scale":1},"unrelated":"old"}');
    withSync(f.base, f.account, ({ lease, state, save }) => {
        const remote = entry('portable/appearance.json', Buffer.from('{"font_scale":1.2}')), effect = {};
        state.targets.test = { accepted: {} };
        state.journal = { id: randomUUID(), method: 'file', target: 'test', next: 0, items: [{ before: currentEntry(lease, remote.path).hash, remote, effect }],
            result: { imported: 0, conflicts: 0, unchanged: 0 } }; save();
        assert.throws(() => publishEntry(lease, remote, effect, 'projection-race', () => { save(); if (effect.staged) throw new Error('Injected interruption'); }), /Injected/);
    });
    f.write('settings.json', '{"power_user":{"font_scale":1.4},"unrelated":"new"}');
    assert.equal(recoverSync(f.base, f.account, 'file').conflicts, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'settings.json'))), { power_user: { font_scale: 1.4 }, unrelated: 'new' });
    assert.equal(readSyncState(f.base, f.account).recoveryPending, false);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.author-')), false);
});

test('new accepted and explicit keep-mine decisions outrank old ancestry across fresh one-way snapshots', async t => {
    const a = fixture(t, 'a'), b = fixture(t, 'b'); a.enable(); b.enable();
    a.write('instruct/Decisions.json', '{"v":0}'); await b.receive(await a.send());
    for (const v of [1, 2, 3]) {
        b.write('instruct/Decisions.json', JSON.stringify({ v }));
        assert.equal((await a.receive(await b.send())).imported, 1);
        assert.equal(fs.readFileSync(path.join(a.root, 'instruct/Decisions.json'), 'utf8'), JSON.stringify({ v }));
    }
    a.write('instruct/Decisions.json', '{"v":"mine"}'); b.write('instruct/Decisions.json', '{"v":4}');
    assert.equal((await a.receive(await b.send())).conflicts, 1);
    const conflict = readSyncState(a.base, a.account).conflicts.find(value => !value.resolved);
    resolveConflict(a.base, a.account, conflict.id, 'local');
    for (let index = 0; index < 3; index++) assert.equal((await a.receive(await b.send())).conflicts, 0);
    assert.equal(readSyncState(a.base, a.account).conflicts.filter(value => !value.resolved).length, 0);
    assert.equal(fs.readFileSync(path.join(a.root, 'instruct/Decisions.json'), 'utf8'), '{"v":"mine"}');
});

for (const start of ['a', 'b']) test(`alternating one-sided edits starting at ${start} share newer history in both directions, including repeated bytes`, async t => {
    const devices = { a: fixture(t, 'a'), b: fixture(t, 'b') };
    const first = devices[start], second = devices[start === 'a' ? 'b' : 'a'];
    first.enable(); second.enable();
    const relative = 'instruct/Alternating.json';
    const packets = [];
    let sender = first, receiver = second;
    // Repeated content must refer to the actual later export, not its first use.
    for (const v of [0, 1, 2, 3, 0, 1, 2, 3]) {
        sender.write(relative, JSON.stringify({ v }));
        const packet = await sender.send();
        packets.push({ receiver, packet });
        assert.deepEqual(await receiver.receive(packet), { imported: 1, conflicts: 0, unchanged: 0 });
        // Another destination can retain an older relationship with this same
        // device. Its insertion order must not hide the newer common revision.
        if (packets.length === 1) await manualSync(receiver.base, receiver.account, 'file', context => importEnvelope(context, packet, 'older-destination'));
        assert.equal(fs.readFileSync(path.join(receiver.root, relative), 'utf8'), JSON.stringify({ v }));
        [sender, receiver] = [receiver, sender];
    }
    for (const { receiver: destination, packet } of packets.slice(0, -2)) assert.equal((await destination.receive(packet)).replayed, true);
    for (const device of Object.values(devices)) {
        assert.equal(fs.readFileSync(path.join(device.root, relative), 'utf8'), '{"v":3}');
        assert.equal(readSyncState(device.base, device.account).conflicts.length, 0);
    }
});

test('obsolete matching ancestry cannot overwrite a simultaneous reversion, and even a newer matching hint cannot undo keep-mine', async t => {
    const a = fixture(t, 'a'), b = fixture(t, 'b'); a.enable(); b.enable();
    const relative = 'instruct/Reverted.json';
    a.write(relative, '{"v":0}'); await b.receive(await a.send());
    b.write(relative, '{"v":1}'); await a.receive(await b.send());
    a.write(relative, '{"v":0}'); b.write(relative, '{"v":2}');
    // The obsolete base has exactly the current local bytes, but both edited
    // since v1. Matching an old hash is not proof of a newer shared version.
    const competing = await b.send();
    assert.deepEqual(await a.receive(competing), { imported: 0, conflicts: 1, unchanged: 0 });
    const conflict = readSyncState(a.base, a.account).conflicts.find(value => !value.resolved);
    resolveConflict(a.base, a.account, conflict.id, 'local');
    const acceptedExport = await a.send();
    assert.equal((await b.receive(acceptedExport)).imported, 0);
    const fresh = await b.send();
    const hint = (await decrypt(fresh, password)).entries[0].bases[0];
    assert.equal(hint.sequence, (await decrypt(acceptedExport, password)).sequence);
    assert.deepEqual(await a.receive(fresh), { imported: 0, conflicts: 0, unchanged: 1 });
    assert.equal((await a.receive(competing)).replayed, true);
    assert.equal(fs.readFileSync(path.join(a.root, relative), 'utf8'), '{"v":0}');
    assert.equal(readSyncState(a.base, a.account).conflicts.filter(value => !value.resolved).length, 0);
});

test('a claimed newer export sequence is not shared ancestry without the exact locally recorded hash and sequence', async t => {
    const a = fixture(t, 'a'), b = fixture(t, 'b'); a.enable(); b.enable();
    const relative = 'instruct/Invented.json';
    a.write(relative, '{"v":0}'); await b.receive(await a.send());
    b.write(relative, '{"v":1}'); await a.receive(await b.send());
    a.write(relative, '{"v":0}'); b.write(relative, '{"v":2}');
    const claimed = await decrypt(await b.send(), password);
    claimed.entries[0].bases[0].sequence += 100;
    assert.deepEqual(await a.receive(await encrypt(claimed, password)), { imported: 0, conflicts: 1, unchanged: 0 });
    assert.equal(fs.readFileSync(path.join(a.root, relative), 'utf8'), '{"v":0}');
    fs.unlinkSync(path.join(a.root, relative));
    const withoutHint = await decrypt(await b.send(), password);
    delete withoutHint.entries[0].bases;
    assert.deepEqual(await a.receive(await encrypt(withoutHint, password)), { imported: 0, conflicts: 1, unchanged: 0 });
    assert.equal(fs.existsSync(path.join(a.root, relative)), false);
});

test('downloaded preserved copies restore through real routes after resolution/removal without disabling ordinary self-replay', async t => {
    const f = fixture(t); f.enable(); f.write('instruct/Restore.json', '{"v":"mine"}');
    const ordinary = await f.send();
    await f.receive(await encrypt(snapshot([entry('instruct/Restore.json', Buffer.from('{"v":"incoming"}'))]), password));
    const conflict = readSyncState(f.base, f.account).conflicts.find(value => !value.resolved);
    const { default: express } = await import('express');
    const { router } = await import('../src/endpoints/device-sync.js');
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { profile: { handle: f.base.owner }, directories: f.base.directories }; next(); }); app.use('/sync', router);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const post = async (route, body) => {
        const reply = await fetch(`http://127.0.0.1:${server.address().port}/sync/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(reply.status, 200); return reply.json();
    };
    const copy = await post('conflict-copy', { id: conflict.id, side: 'remote' });
    assert.ok((await decrypt(copy, password)).recovery);
    await post('resolve', { id: conflict.id, choice: 'local' }); await post('forget-conflict', { id: conflict.id });
    assert.equal((await post('import', { envelope: copy })).conflicts, 1);
    const restored = readSyncState(f.base, f.account).conflicts.find(value => !value.resolved);
    await post('resolve', { id: restored.id, choice: 'incoming' });
    assert.equal(fs.readFileSync(path.join(f.root, 'instruct/Restore.json'), 'utf8'), '{"v":"incoming"}');
    assert.equal((await post('import', { envelope: ordinary })).replayed, true);
    assert.equal(fs.readFileSync(path.join(f.root, 'instruct/Restore.json'), 'utf8'), '{"v":"incoming"}');
    f.enable('webdav');
    await assert.rejects(() => manualSync(f.base, f.account, 'webdav', context => importEnvelope(context, copy, 'dav')), /Encrypted file/);
});

test('chat personas require consent on export/receive and retain all dependencies through conflicts and recovery', async t => {
    const a = fixture(t, 'a'), b = fixture(t, 'b'); a.enable(); b.enable();
    a.write('characters/Nova.png', writeCard(png, '{"name":"Nova"}'));
    a.write('User Avatars/me.png', png);
    a.write('settings.json', JSON.stringify({ power_user: { personas: { 'me.png': 'Me' }, persona_descriptions: { 'me.png': { description: 'Incoming persona' } } } }));
    a.write('chats/Nova/Locked.jsonl', '{"chat_metadata":{"persona":"me.png"}}\n{"is_user":true,"name":"Me","mes":"Hello","force_avatar":"/User Avatars/me.png"}\n');
    configureSync(a.base, a.account, { categories: ['characters'] });
    await assert.rejects(() => a.send(), /Select Personas and avatars/);
    configureSync(a.base, a.account, { categories: ['characters', 'personas'] });
    const envelope = await a.send(), value = await decrypt(envelope, password);
    const missing = { ...value, entries: value.entries.filter(item => item.category !== 'personas'), categories: ['characters'] };
    assert.throws(() => validateData(missing), /Select Personas and avatars/);
    configureSync(b.base, b.account, { categories: ['characters'] });
    await assert.rejects(() => b.receive(envelope), /Select Personas and avatars/);
    assert.equal(fs.existsSync(path.join(b.root, 'characters/Nova.png')), false);
    configureSync(b.base, b.account, { categories: ['characters', 'personas'] });
    b.write('User Avatars/me.png', png);
    b.write('settings.json', JSON.stringify({ power_user: { personas: { 'me.png': 'Me' }, persona_descriptions: { 'me.png': { description: 'Mine' } } } }));
    assert.equal((await b.receive(envelope)).conflicts, 2);
    const conflicts = readSyncState(b.base, b.account).conflicts;
    const chat = conflicts.find(item => item.path.startsWith('chats/')), persona = conflicts.find(item => item.path.startsWith('portable/personas/'));
    const preserved = conflictCopy(b.base, b.account, chat.id, 'remote');
    validateData(snapshot([...preserved.companions, preserved.entry], { categories: ['characters', 'personas'] }));
    configureSync(b.base, b.account, { categories: ['characters'] });
    assert.throws(() => conflictCopy(b.base, b.account, chat.id, 'remote'), /original data categories before exporting/);
    configureSync(b.base, b.account, { categories: ['characters', 'personas'] });
    assert.throws(() => resolveConflict(b.base, b.account, chat.id, 'incoming'), /incoming character card or avatar/);
    resolveConflict(b.base, b.account, persona.id, 'incoming'); resolveConflict(b.base, b.account, chat.id, 'incoming');
    assert.match(fs.readFileSync(path.join(b.root, 'chats/Nova/Locked.jsonl'), 'utf8'), /me.png/);
    // A receiver may leave a category unchecked only when its required content already matches exactly.
    const c = fixture(t, 'c'); c.enable();
    c.write('User Avatars/me.png', png); c.write('settings.json', fs.readFileSync(path.join(a.root, 'settings.json')));
    configureSync(c.base, c.account, { categories: ['characters'] }); assert.equal((await c.receive(envelope)).imported, 2);
    const d = fixture(t, 'd'); d.enable();
    for (const item of preserved.companions) if (!item.path.startsWith('portable/')) d.write(item.path, Buffer.from(item.data, 'base64'));
    withSync(d.base, d.account, ({ state, save }) => {
        state.targets.test = { accepted: {} };
        state.journal = { id: randomUUID(), method: 'file', target: 'test', next: 0,
            items: [{ before: null, remote: preserved.entry, companions: { remote: preserved.companions } }], result: { imported: 0, conflicts: 0, unchanged: 0 } }; save();
    });
    configureSync(d.base, d.account, { categories: ['characters'] });
    assert.throws(() => recoverSync(d.base, d.account, 'file'), /Select Personas and avatars/);
    assert.equal(fs.existsSync(path.join(d.root, 'chats/Nova/Locked.jsonl')), false);
    configureSync(d.base, d.account, { categories: ['characters', 'personas'] });
    assert.equal(recoverSync(d.base, d.account, 'file').conflicts, 1);
    assert.equal(readSyncState(d.base, d.account).recoveryPending, false);
});

test('account epoch changes and disabling a method invalidate in-flight work; grants are scoped, expiring and revocable', async t => {
    const f = fixture(t); f.enable('pairing');
    const grant = createGrant(f.base, f.account);
    authoriseGrant(f.base, f.account, grant.id, grant.token);
    assert.throws(() => authoriseGrant(f.base, f.account, grant.id, 'incorrect'), /invalid/);
    revokeGrant(f.base, f.account, grant.id);
    assert.throws(() => authoriseGrant(f.base, f.account, grant.id, grant.token), /invalid/);
    createGrant(f.base, f.account);
    await assert.rejects(() => manualSync(f.base, f.account, 'pairing', async context => {
        configureSync(f.base, f.account, { method: 'pairing', enabled: false });
        context.guard(); return {};
    }));
    assert.equal(readSyncState(f.base, f.account).grants.length, 0);
    f.enable();
    await assert.rejects(() => manualSync(f.base, f.account, 'file', async context => {
        withRoleplayAccountLock(f.scope, lease => { roleplayLease(lease).state.dataEpoch += 1; saveRoleplayAccount(lease); });
        context.guard(); return {};
    }), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
});

test('WebDAV always uses conditional publication and refuses missing ETags or concurrent writes', async t => {
    const f = fixture(t); f.enable('webdav', { url: 'https://dav.invalid/sync.json' });
    let stored = null, calls = [];
    const send = async (_context, _url, options = {}) => {
        calls.push(options);
        if (options.method === 'PUT') { assert.equal(options.headers['If-None-Match'], '*'); stored = options.body; return response(201, {}); }
        return stored ? response(200, stored, { etag: '"one"' }) : response(404, {});
    };
    const result = await manualSync(f.base, f.account, 'webdav', context => webdavSync(context, send));
    assert.equal(result.published, true); assert.equal(calls.length, 3);
    await assert.rejects(() => manualSync(f.base, f.account, 'webdav', context => webdavSync(context, async () => response(200, stored))), /ETag/);
    calls = [];
    await assert.rejects(() => manualSync(f.base, f.account, 'webdav', context => webdavSync(context, async (_ctx, _url, options = {}) => {
        if (options.method === 'PUT') { assert.equal(options.headers['If-Match'], '"one"'); return response(412, {}); }
        return response(200, stored, { etag: '"one"' });
    })), /Another device/);
});

test('Gist creates only on explicit request, uses immutable files and never follows truncation URLs', async t => {
    const f = fixture(t); f.enable('gist', { token: 'test-token' });
    let files = {}, calls = [];
    const send = async (_context, url, options = {}) => {
        calls.push({ url, options });
        if (options.method === 'POST') { assert.equal(options.body.public, false); files = options.body.files; return response(201, { id: 'abcde' }); }
        if (options.method === 'PATCH') { assert.equal(Object.keys(options.body.files).length, 1); files = { ...files, ...options.body.files }; }
        return response(200, { public: false, files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, { ...value, size: Buffer.byteLength(value.content), truncated: false }])) });
    };
    await assert.rejects(() => manualSync(f.base, f.account, 'gist', context => gistSync(context, { send })), /Choose/);
    await manualSync(f.base, f.account, 'gist', context => gistSync(context, { create: true, send }));
    assert.equal(readSyncState(f.base, f.account).methods.gist.gistId, 'abcde');
    const original = Object.keys(files)[0]; files['unrelated.txt'] = { content: 'keep me' };
    await manualSync(f.base, f.account, 'gist', context => gistSync(context, { send }));
    assert.ok(files[original]); assert.equal(files['unrelated.txt'].content, 'keep me');
    calls = [];
    await assert.rejects(() => manualSync(f.base, f.account, 'gist', context => gistSync(context, { send: async () => response(200, { public: false, files: { [original]: { truncated: true, raw_url: 'http://169.254.169.254/token' } } }) })), /truncated/);
    assert.equal(calls.length, 0);
    await assert.rejects(() => manualSync(f.base, f.account, 'gist', context => gistSync(context, { send: async () => response(429, {}) })), /rate/);
});

test('network admission rejects metadata, embedded credentials and insecure non-LAN pairing', async () => {
    for (const url of ['http://example.com/file', 'https://user:password@example.com/file', 'https://169.254.169.254/token', 'https://[::ffff:a9fe:a9fe]/token', 'https://[fd00:ec2::254]/token', 'https://224.0.0.2/', 'https://metadata.google.internal/file', 'https://example.com/file#token']) assert.throws(() => targetUrl(url));
    assert.equal(targetUrl('http://192.168.1.4:8000', { pairing: true }).protocol, 'http:');
    const context = { guard() {}, signal: new AbortController().signal };
    await assert.rejects(() => request(context, 'http://8.8.8.8/pair', { pairing: true }), /not an allowed/);
    assert.throws(() => validateConfig('gist', { gistId: 'wrong/id' }));
});

test('saved interrupted journal recovers idempotently and does not overwrite a later local edit', t => {
    const f = fixture(t); f.enable();
    const remote = entry('instruct/One.json', Buffer.from('{"remote":true}'));
    withSync(f.base, f.account, ({ state, save }) => {
        state.targets.test = { accepted: {} };
        state.journal = { id: randomUUID(), method: 'file', target: 'test', items: [{ before: null, remote }], next: 0, result: { imported: 0, conflicts: 0, unchanged: 0 } }; save();
    });
    f.write('instruct/One.json', '{"later":true}');
    assert.equal(recoverSync(f.base, f.account, 'file').conflicts, 1);
    assert.equal(fs.readFileSync(path.join(f.root, 'instruct/One.json'), 'utf8'), '{"later":true}');
    assert.equal(readSyncState(f.base, f.account).recoveryPending, false);
    assert.equal(recoverSync(f.base, f.account, 'file').imported, 0);
    withSync(f.base, f.account, ({ lease, state }) => assert.ok(snapshotLocked(lease, state.deviceId, 1, ['presets']).entries.length));
});

test('bounded content and noncanonical portable settings are refused before publishing any valid sibling', async t => {
    const f = fixture(t); f.enable();
    assert.throws(() => entry('instruct/Huge.json', Buffer.alloc(LIMITS.file + 1)), /limit|large|size/i);
    const many = Array.from({ length: LIMITS.entries + 1 }, (_, index) => entry(`instruct/${index}.json`, Buffer.from('{}')));
    assert.throws(() => validateSnapshot(snapshot(many)), { message: 'Unsupported or oversized sync manifest.' });
    const bad = snapshot([entry('instruct/Valid.json', Buffer.from('{}')), entry('portable/appearance.json', Buffer.from('{ "font_scale": 1.2 }'))], { categories: ['presets', 'appearance'] });
    await assert.rejects(async () => f.receive(await encrypt(bad, password)), /canonical/);
    assert.equal(fs.existsSync(path.join(f.root, 'instruct/Valid.json')), false);
});

test('a conflicting parent preserves its incoming chat too; reversed parent order still publishes cleanly', async t => {
    const a = fixture(t, 'a'), b = fixture(t, 'b'), c = fixture(t, 'c'); for (const f of [a, b, c]) f.enable();
    a.write('characters/Nova.png', writeCard(png, '{"name":"Nova","description":"incoming"}'));
    a.write('chats/Nova/Story.jsonl', '{"user_name":"Me","character_name":"Nova","chat_metadata":{}}\n{"name":"Nova","is_user":false,"mes":"Hello"}\n');
    b.write('characters/Nova.png', writeCard(png, '{"name":"Nova","description":"mine"}'));
    const value = await decrypt(await a.send(), password); value.entries.reverse(); const encrypted = await encrypt(value, password);
    assert.equal((await c.receive(encrypted)).imported, 2);
    assert.equal((await b.receive(encrypted)).conflicts, 2);
    assert.equal(fs.existsSync(path.join(b.root, 'chats/Nova/Story.jsonl')), false);
    const conflicts = readSyncState(b.base, b.account).conflicts;
    const chat = conflicts.find(item => item.path.startsWith('chats/'));
    assert.throws(() => resolveConflict(b.base, b.account, chat.id, 'incoming'), /incoming character card or avatar/);
    const copy = conflictCopy(b.base, b.account, chat.id, 'remote');
    assert.equal(copy.companions[0].path, 'characters/Nova.png');
    validateSnapshot(snapshot([...copy.companions, copy.entry], { categories: ['characters'] }));
    const card = conflicts.find(item => item.path.startsWith('characters/'));
    assert.throws(() => forgetConflict(b.base, b.account, card.id), /resolve/);
    resolveConflict(b.base, b.account, card.id, 'local');
    assert.throws(() => resolveConflict(b.base, b.account, card.id, 'incoming'), /unresolved/);
    forgetConflict(b.base, b.account, card.id);
    assert.equal(readSyncState(b.base, b.account).conflicts.length, 1);
    const d = fixture(t, 'd'); d.enable();
    d.write('characters/Nova.png', writeCard(png, '{"name":"Nova","description":"mine"}'));
    await d.receive(encrypted);
    const pending = readSyncState(d.base, d.account).conflicts;
    resolveConflict(d.base, d.account, pending.find(item => item.path.startsWith('characters/')).id, 'incoming');
    resolveConflict(d.base, d.account, pending.find(item => item.path.startsWith('chats/')).id, 'incoming');
    assert.match(fs.readFileSync(path.join(d.root, 'chats/Nova/Story.jsonl'), 'utf8'), /Hello/);
    const e = fixture(t, 'e'); e.enable();
    e.write('characters/Nova.png', writeCard(png, '{"name":"Nova","description":"changed after interruption"}'));
    withSync(e.base, e.account, ({ state, save }) => {
        state.targets.test = { accepted: {} };
        state.journal = { id: randomUUID(), method: 'file', target: 'test', next: 0,
            items: [{ before: null, remote: copy.entry, companions: { remote: copy.companions } }], result: { imported: 0, conflicts: 0, unchanged: 0 } }; save();
    });
    assert.equal(recoverSync(e.base, e.account, 'file').conflicts, 1);
    assert.equal(fs.existsSync(path.join(e.root, 'chats/Nova/Story.jsonl')), false);
});

// Real wire adapter: only the provider origin is substituted. Request bodies,
// methods, authentication, response parsing and provider state cross an HTTP socket.
async function provider(t, handler) {
    const server = http.createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks);
            const body = raw.length ? JSON.parse(raw) : null;
            const reply = await handler(req, body);
            res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
            res.end(JSON.stringify(reply.body ?? {}));
        } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return { origin, send: (context, url, options = {}) => request(context, origin + new URL(url).pathname, { ...options, pairing: true }) };
}

test('real HTTP WebDAV transfers both directions, preserves a concurrent edit and never retries a refused PUT', async t => {
    const a = fixture(t, 'a'), b = fixture(t, 'b');
    let stored = null, revision = 0, race = false, puts = 0;
    const dav = await provider(t, (req, body) => {
        assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('name:secret').toString('base64'));
        if (req.method === 'PUT') {
            puts++;
            if (race || stored && req.headers['if-match'] !== `"${revision}"` || !stored && req.headers['if-none-match'] !== '*') return { status: 412 };
            stored = body; revision++; return { status: 201 };
        }
        return stored ? { body: stored, headers: { ETag: `"${revision}"` } } : { status: 404 };
    });
    for (const f of [a, b]) f.enable('webdav', { url: 'https://dav.invalid/sync.json', username: 'name', password: 'secret' });
    const sync = f => manualSync(f.base, f.account, 'webdav', context => webdavSync(context, dav.send));
    a.write('instruct/Wire.json', '{"text":"A"}'); await sync(a); await sync(b);
    assert.equal(fs.readFileSync(path.join(b.root, 'instruct/Wire.json'), 'utf8'), '{"text":"A"}');
    b.write('instruct/Wire.json', '{"text":"B"}'); await sync(b); await sync(a);
    assert.equal(fs.readFileSync(path.join(a.root, 'instruct/Wire.json'), 'utf8'), '{"text":"B"}');
    a.write('instruct/Wire.json', '{"text":"local"}'); b.write('instruct/Wire.json', '{"text":"remote"}');
    await sync(b); assert.equal((await sync(a)).conflicts, 1);
    const before = puts; race = true;
    await assert.rejects(() => sync(a), /Another device/); assert.equal(puts, before + 1);
    assert.equal(fs.readFileSync(path.join(a.root, 'instruct/Wire.json'), 'utf8'), '{"text":"local"}');
});

test('real HTTP Gist transfers both directions and append-only concurrent clients retain every immutable file', async t => {
    const a = fixture(t, 'a'), b = fixture(t, 'b');
    let files = {}, mode = '', patches = 0;
    const gist = await provider(t, (req, body) => {
        assert.equal(req.headers.authorization, 'Bearer wire-token');
        if (mode === 'rate') return { status: 429 };
        if (req.method === 'POST') { assert.equal(body.public, false); files = body.files; return { status: 201, body: { id: 'abcde' } }; }
        if (req.method === 'PATCH') {
            patches++;
            for (const name of Object.keys(body.files)) assert.equal(Object.hasOwn(files, name), false);
            files = { ...files, ...body.files };
        }
        return { body: { public: false, files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, { ...file, size: Buffer.byteLength(file.content), truncated: mode === 'truncated' && name.startsWith('neconyan-sync-'), raw_url: 'http://169.254.169.254/credentials' }])) } };
    });
    a.enable('gist', { token: 'wire-token' }); b.enable('gist', { token: 'wire-token', gistId: 'abcde' });
    const sync = (f, create = false) => manualSync(f.base, f.account, 'gist', context => gistSync(context, { create, send: gist.send }));
    a.write('instruct/Wire.json', '{"text":"A"}'); await sync(a, true);
    files['unrelated.txt'] = { content: 'untouched' };
    await sync(b); assert.equal(fs.readFileSync(path.join(b.root, 'instruct/Wire.json'), 'utf8'), '{"text":"A"}');
    b.write('instruct/Wire.json', '{"text":"B"}'); await sync(b); await sync(a);
    assert.equal(fs.readFileSync(path.join(a.root, 'instruct/Wire.json'), 'utf8'), '{"text":"B"}');
    const before = Object.keys(files).length; await Promise.all([sync(a), sync(b)]);
    assert.equal(Object.keys(files).length, before + 2); assert.equal(files['unrelated.txt'].content, 'untouched');
    const count = patches; mode = 'truncated'; await assert.rejects(() => sync(a), /truncated/); assert.equal(patches, count);
    mode = 'rate'; await assert.rejects(() => sync(a), /rate/);
});

test('real network requests refuse redirects, compressed or oversized replies, credentials and cancellation stay origin-bound', async t => {
    let calls = 0;
    const wire = await provider(t, req => {
        calls++;
        if (req.url === '/redirect') return { status: 302, headers: { Location: 'http://169.254.169.254/token' } };
        if (req.url === '/compressed') return { headers: { 'Content-Encoding': 'gzip' } };
        return { body: { content: 'x'.repeat(100) } };
    });
    const controller = new AbortController(), context = { guard() {}, signal: controller.signal };
    await assert.rejects(() => request(context, wire.origin + '/redirect', { pairing: true, headers: { Authorization: 'secret' } }), /redirects/);
    assert.equal(calls, 1);
    await assert.rejects(() => request(context, wire.origin + '/compressed', { pairing: true }), /compressed/);
    await assert.rejects(() => request(context, wire.origin + '/large', { pairing: true, max: 10 }), /oversized|size/);
    controller.abort(); await assert.rejects(() => request(context, wire.origin + '/aborted', { pairing: true }));
    assert.equal(calls, 3);
});
