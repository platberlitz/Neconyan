import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import multer from 'multer';
import { fixture, memoryParent } from './roleplay-transactions-fixture.js';
import { convertImportedChatFile, roleplayNativeHost, router as chatRouter } from '../src/endpoints/chats.js';
import { commitSingleChatImport, commitSingleChatWrite, reconcilePendingChatWrite } from '../src/roleplay-lifecycle.js';
import { assertRoleplaySource, captureRoleplaySource, readRoleplayChat, readRoleplayEntity } from '../src/generation/roleplay-source.js';
import { readRoleplayAccount, readRoleplayFile } from '../src/roleplay-store.js';
import { canonicalMemoryPaths } from '../src/mewmory/prepared-branch.js';

function input(f, overrides = {}) {
    return { operationKey: 'import-one', bytes: Buffer.from(f.records.map(JSON.stringify).join('\n')),
        originalName: 'Old story.jsonl', format: 'jsonl', userName: 'User', characterName: 'Nova',
        target: { group: false, avatar: 'Nova.png' }, ...overrides };
}

test('one native upload creates one recorded chat and replays its receipt', t => {
    const f = fixture(t, false, 'import-solo');
    const request = input(f);
    const result = commitSingleChatImport(f.scope, request, roleplayNativeHost, convertImportedChatFile);
    assert.equal(result.kind, 'import');
    assert.equal(result.names.length, 1);
    const filename = path.join(f.scope.directories.chats, 'Nova', result.names[0] + '.jsonl');
    const file = readRoleplayFile(filename);
    assert.equal(file.rawHash, result.outputs[0].rawHash);
    assert.equal(JSON.parse(file.bytes.toString().split('\n')[0]).chat_metadata.neconyan_roleplay.instanceId, result.instanceId);
    const imported = file.bytes.toString().trim().split('\n').map(JSON.parse);
    assert.equal(imported[1].extra.file, 'attachment.txt');
    assert.deepEqual(imported[2].swipes, ['Answer', 'Other']);
    assert.equal(imported[2].swipe_info[0].extra.reasoning, 'hidden');
    assert.equal(imported[0].unknown, true);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    assert.deepEqual(commitSingleChatImport(f.scope, request, roleplayNativeHost, convertImportedChatFile), result);
    assert.throws(() => commitSingleChatImport(f.scope, { ...request, userName: 'Different' },
        roleplayNativeHost, convertImportedChatFile), { code: 'ROLEPLAY_INTENT_CONFLICT' });
    assert.throws(() => commitSingleChatImport(f.scope, { ...request, target: { group: false, avatar: 'Other.png' } },
        roleplayNativeHost, convertImportedChatFile), { code: 'ROLEPLAY_INTENT_CONFLICT' });
    fs.appendFileSync(filename, '\n{"later":"edit"}');
    const later = readRoleplayFile(filename);
    assert.deepEqual(commitSingleChatImport(f.scope, request, roleplayNativeHost, convertImportedChatFile), result);
    assert.deepEqual(readRoleplayFile(filename), later);
    fs.unlinkSync(filename);
    assert.deepEqual(commitSingleChatImport(f.scope, request, roleplayNativeHost, convertImportedChatFile), result);
    assert.equal(fs.existsSync(filename), false);
});

test('long Unicode names avoid occupied destinations', t => {
    const f = fixture(t, false, 'import-collisions');
    t.mock.method(Date, 'now', () => 1760000000000);
    const records = structuredClone(f.records);
    const characterName = '猫'.repeat(200);
    const first = commitSingleChatImport(f.scope, input(f, { characterName,
        bytes: Buffer.from(records.map(JSON.stringify).join('\n')) }), roleplayNativeHost, convertImportedChatFile);
    const second = commitSingleChatImport(f.scope, input(f, { operationKey: 'second-import', characterName,
        bytes: Buffer.from(records.map(JSON.stringify).join('\n')) }), roleplayNativeHost, convertImportedChatFile);
    assert.notEqual(first.names[0], second.names[0]);
    for (const result of [first, second]) {
        assert.ok(Buffer.byteLength(result.names[0] + '.jsonl') <= 255);
        const filename = path.join(path.dirname(f.filename), result.names[0] + '.jsonl');
        const header = JSON.parse(readRoleplayFile(filename).bytes.toString().split('\n')[0]);
        assert.equal(header.chat_metadata.neconyan_roleplay.instanceId, result.instanceId);
        assert.notEqual(header.chat_metadata.neconyan_roleplay.instanceId, 'foreign-instance');
    }
});

test('foreign origins require explicit adoption, which isolates every selected history and protects subsequent writes', t => {
    const f = fixture(t, false, 'adopt-foreign');
    const originalCharacter = readRoleplayEntity(f.scope, 'character', 'Nova.png', { storage: true });
    const originalChat = readRoleplayFile(f.filename);
    const parent = memoryParent(f);
    const records = structuredClone(f.records);
    records[0].chat_metadata = { neconyan_roleplay: { schema: 1, instanceId: 'foreign-instance', revision: 90, writeId: 'foreign-write' },
        integrity: 'foreign-seal', main_chat: 'Parent', chat_id_hash: 'source-hash' };
    records[1].extra.bookmark_link = 'Source checkpoint';
    records[2].extra = { branches: ['Source branch'], reasoning: 'keep this' };
    records[2].swipe_info[0].extra.bookmark_link = 'Source checkpoint';
    records[2].swipe_info[0].extra.branches = ['Source branch'];
    const bytes = Buffer.from(records.map(JSON.stringify).join('\n'));
    assert.throws(() => commitSingleChatImport(f.scope, input(f, { bytes }), roleplayNativeHost, convertImportedChatFile),
        { code: 'ROLEPLAY_FOREIGN_SOURCE', roleplayImportUnaccepted: true });
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    assert.deepEqual(fs.readdirSync(f.scope.directories.characters), ['Nova.png']);
    const request = input(f, { importAsNewInstance: true, format: 'instance-batch', bytes: Buffer.from(JSON.stringify([
        { format: 'jsonl', content: bytes.toString() }, { format: 'jsonl', content: bytes.toString() },
    ])) });
    const result = commitSingleChatImport(f.scope, request, roleplayNativeHost, convertImportedChatFile);
    assert.notEqual(result.character.avatar, 'Nova.png');
    assert.notEqual(result.character.instanceId, originalCharacter.instanceId);
    assert.equal(readRoleplayEntity(f.scope, 'character', result.character.avatar).instanceId, result.character.instanceId);
    assert.equal(result.names.length, 2);
    assert.notEqual(result.outputs[0].instanceId, result.outputs[1].instanceId);
    for (const [index, chat] of result.names.entries()) {
        const locator = { group: false, avatar: result.character.avatar, chat };
        const loaded = readRoleplayChat(f.scope, locator);
        assert.equal(loaded.records.length, records.length);
        assert.equal(loaded.instanceId, result.outputs[index].instanceId);
        assert.notEqual(loaded.records[0].chat_metadata.integrity, 'foreign-seal');
        assert.equal(loaded.records[0].chat_metadata.main_chat, undefined);
        assert.equal(loaded.records[0].chat_metadata.chat_id_hash, undefined);
        assert.equal(loaded.records[1].extra.bookmark_link, undefined);
        assert.equal(loaded.records[2].extra.branches, undefined);
        assert.equal(loaded.records[2].extra.reasoning, 'keep this');
        assert.deepEqual(loaded.records[2].swipe_info[0].extra, { reasoning: 'hidden' });
        assert.deepEqual(loaded.records[2].swipes, records[2].swipes);
        const source = captureRoleplaySource(f.scope, { locator });
        assertRoleplaySource(f.scope, source);
        const updated = [...loaded.records, { name: 'Nova', mes: 'A native reply', is_user: false }];
        commitSingleChatWrite(f.scope, { mode: 'update', operationKey: `native-${index}`, source, records: updated }, roleplayNativeHost);
        assert.throws(() => assertRoleplaySource(f.scope, source), { code: 'ROLEPLAY_SOURCE_CHANGED' });
        const stale = { mode: 'update', operationKey: `ghost-${index}`, source, records: records.slice(0, 2) };
        assert.throws(() => commitSingleChatWrite(f.scope, stale, roleplayNativeHost));
        assert.equal(readRoleplayChat(f.scope, locator).records.length, updated.length);
        assert.equal(fs.existsSync(canonicalMemoryPaths(f.scope.directories, locator).archive), false);
    }
    assert.deepEqual(readRoleplayFile(f.filename), originalChat);
    assert.equal(readRoleplayEntity(f.scope, 'character', 'Nova.png').rawHash, originalCharacter.rawHash);
    assert.deepEqual(JSON.parse(fs.readFileSync(parent.paths.archive, 'utf8')), parent.state);
    assert.deepEqual(commitSingleChatImport(f.scope, request, roleplayNativeHost, convertImportedChatFile), result);
    assert.throws(() => commitSingleChatImport(f.scope, { ...request, importAsNewInstance: false }, roleplayNativeHost, convertImportedChatFile));
});

test('strict import accepts only a current local origin and seal, without weakening normal reads', t => {
    const f = fixture(t, false, 'import-strict-origin');
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    const bytes = fs.readFileSync(f.filename);
    commitSingleChatImport(f.scope, input(f, { bytes }), roleplayNativeHost, convertImportedChatFile);
    for (const field of ['integrity', 'revision', 'message']) {
        const records = bytes.toString().trim().split('\n').map(JSON.parse);
        if (field === 'integrity') records[0].chat_metadata.integrity = 'wrong';
        if (field === 'revision') records[0].chat_metadata.neconyan_roleplay.revision++;
        if (field === 'message') records[1].mes = 'Changed outside this instance';
        assert.throws(() => commitSingleChatImport(f.scope, input(f, { operationKey: field,
            bytes: Buffer.from(records.map(JSON.stringify).join('\n')) }), roleplayNativeHost, convertImportedChatFile),
        { code: 'ROLEPLAY_IMPORT_ORIGIN_CHANGED', roleplayImportUnaccepted: true });
    }
    const foreign = structuredClone(f.records);
    foreign[0].chat_metadata.neconyan_roleplay = { schema: 1, instanceId: 'foreign-instance', revision: 1, writeId: 'foreign-write' };
    fs.writeFileSync(path.join(path.dirname(f.filename), 'Foreign.jsonl'), foreign.map(JSON.stringify).join('\n'));
    assert.throws(() => readRoleplayChat(f.scope, { ...f.locator, chat: 'Foreign' }), { code: 'ROLEPLAY_FOREIGN_SOURCE' });
});

test('interrupted adoption resumes one character and refuses an occupied character destination', t => {
    for (const occupy of [false, true]) {
        const f = fixture(t, false, `adopt-recovery-${occupy}`);
        const request = input(f, { importAsNewInstance: true, format: 'instance-batch', bytes: Buffer.from(JSON.stringify([
            { format: 'jsonl', content: input(f).bytes.toString() }, { format: 'jsonl', content: input(f).bytes.toString() },
        ])) });
        let count = 0;
        assert.throws(() => commitSingleChatImport(f.scope, request, { ...roleplayNativeHost, publish(args) {
            if (++count === 2) throw new Error('interrupted');
            return roleplayNativeHost.publish(args);
        } }, convertImportedChatFile), /interrupted/);
        const pending = readRoleplayAccount(f.scope).pending;
        const filename = path.join(f.scope.directories.characters, pending.newCharacter.locator.avatar);
        assert.equal(fs.existsSync(filename), false);
        if (occupy) {
            fs.writeFileSync(filename, 'Another card');
            assert.throws(() => reconcilePendingChatWrite(f.scope, roleplayNativeHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
            assert.equal(fs.readFileSync(filename, 'utf8'), 'Another card');
        } else {
            const result = reconcilePendingChatWrite(f.scope, roleplayNativeHost);
            assert.equal(result.character.instanceId, pending.newCharacter.instanceId);
            assert.equal(result.outputs[0].instanceId, pending.outputs[0].instanceId);
            assert.equal(fs.readdirSync(f.scope.directories.characters).length, 2);
            assert.deepEqual(commitSingleChatImport(f.scope, request, roleplayNativeHost, convertImportedChatFile), result);
        }
    }
});

test('adoption requires a boolean opt-in and rejects malformed batches before publication', t => {
    const f = fixture(t, false, 'adopt-invalid');
    for (const importAsNewInstance of ['true', 1, null]) {
        assert.throws(() => commitSingleChatImport(f.scope, input(f, { importAsNewInstance }), roleplayNativeHost, convertImportedChatFile),
            { code: 'ROLEPLAY_INVALID' });
    }
    const request = input(f, { importAsNewInstance: true, format: 'instance-batch', bytes: Buffer.from(JSON.stringify([
        { format: 'jsonl', content: input(f).bytes.toString() }, { format: 'jsonl', content: 'broken' },
    ])) });
    assert.throws(() => commitSingleChatImport(f.scope, request, roleplayNativeHost, convertImportedChatFile));
    assert.deepEqual(fs.readdirSync(f.scope.directories.characters), ['Nova.png']);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('a character avatar with an embedded .png uses its exact existing chat folder mapping', t => {
    const f = fixture(t, false, 'import-embedded-avatar');
    fs.copyFileSync(path.join(f.scope.directories.characters, 'Nova.png'),
        path.join(f.scope.directories.characters, 'Nova.png.variant.png'));
    const result = commitSingleChatImport(f.scope, input(f, { target: { group: false, avatar: 'Nova.png.variant.png' } }),
        roleplayNativeHost, convertImportedChatFile);
    assert.ok(readRoleplayFile(path.join(f.scope.directories.chats, 'Nova.variant.png', result.names[0] + '.jsonl')));
    assert.equal(fs.existsSync(path.join(f.scope.directories.chats, 'Nova.png.variant', result.names[0] + '.jsonl')), false);
});

test('all supported converters use the captured timestamp and CAI keeps every history', () => {
    const timestamp = Date.UTC(2025, 0, 2);
    const cases = [
        { data_visible: [['hello', 'world']] },
        { messages: [{ userId: 'one', msg: 'hello' }, { msg: 'world' }] },
        { savedsettings: { chatname: 'User', chatopponent: 'Nova' }, actions: ['{{[OUTPUT]}}world'] },
        { type: 'risuChat', data: { message: [{ role: 'char', data: 'world' }] } },
        { histories: { histories: [{ msgs: [{ src: { is_human: true }, text: 'one' }] },
            { msgs: [{ src: { is_human: false }, text: 'two' }] }] } },
    ];
    for (const value of cases) {
        const converted = convertImportedChatFile(Buffer.from(JSON.stringify(value)),
            { format: 'json', userName: 'User', characterName: 'Nova', timestamp });
        assert.equal(converted.length, value.histories ? 2 : 1);
        for (const history of converted) {
            const rows = history.split('\n').map(JSON.parse);
            assert.equal(rows[1].send_date, '2025-01-02T00:00:00.000Z');
        }
    }
});

test('malformed uploaded histories refuse before publishing a file or pending evidence', t => {
    const f = fixture(t, false, 'import-invalid');
    assert.throws(() => commitSingleChatImport(f.scope, input(f, { bytes: Buffer.from('{broken') }),
        roleplayNativeHost, convertImportedChatFile), error => error.roleplayImportUnaccepted === true);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    assert.deepEqual(fs.readdirSync(path.dirname(f.filename)), ['Source.jsonl']);
});

test('Chub histories retain empty message and swipe text', t => {
    const f = fixture(t, false, 'import-chub-empty');
    const records = structuredClone(f.records);
    records[2].mes = { message: '' };
    records[2].swipes = [{ message: '' }, { message: 'Other' }];
    const result = commitSingleChatImport(f.scope, input(f, { bytes: Buffer.from(records.map(JSON.stringify).join('\n')) }),
        roleplayNativeHost, convertImportedChatFile);
    const imported = fs.readFileSync(path.join(path.dirname(f.filename), result.names[0] + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(imported[2].mes, '');
    assert.deepEqual(imported[2].swipes, ['', 'Other']);
});

test('over-capacity multi-history upload refuses before staging or linking', t => {
    const f = fixture(t, true, 'import-over-capacity');
    const saved = readRoleplayEntity(f.scope, 'group', 'group', { storage: true });
    const before = readRoleplayFile(path.join(f.scope.directories.groups, 'group.json'));
    const request = input(f, { format: 'json', originalName: 'too-many.json',
        bytes: Buffer.from(JSON.stringify({ histories: { histories: Array.from({ length: 65 }, () => ({ msgs: [] })) } })),
        target: { group: true, groupId: 'group', source: { instanceId: saved.instanceId,
            revision: saved.revision, rawHash: saved.rawHash } } });
    assert.throws(() => commitSingleChatImport(f.scope, request, roleplayNativeHost, convertImportedChatFile), { code: 'ROLEPLAY_INVALID' });
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    assert.deepEqual(readRoleplayFile(path.join(f.scope.directories.groups, 'group.json')), before);
    assert.deepEqual(fs.readdirSync(f.scope.directories.groupChats), ['Source.jsonl']);
});

test('a changed published import output retains pending evidence and refuses replay', t => {
    const f = fixture(t, true, 'import-third-state');
    const saved = readRoleplayEntity(f.scope, 'group', 'group', { storage: true });
    const request = input(f, { format: 'json', originalName: 'two.json',
        bytes: Buffer.from(JSON.stringify({ histories: { histories: [
            { msgs: [{ src: { is_human: true }, text: 'one' }] },
            { msgs: [{ src: { is_human: true }, text: 'two' }] },
        ] } })),
        target: { group: true, groupId: 'group', source: { instanceId: saved.instanceId,
            revision: saved.revision, rawHash: saved.rawHash } } });
    let published = 0;
    const interrupted = { ...roleplayNativeHost, publish(args) {
        if (++published === 2) throw new Error('interrupted before second chat');
        return roleplayNativeHost.publish(args);
    } };
    assert.throws(() => commitSingleChatImport(f.scope, request, interrupted, convertImportedChatFile),
        error => error.message.includes('interrupted') && error.roleplayWritePending === true && !error.roleplayImportUnaccepted);
    const pending = readRoleplayAccount(f.scope).pending;
    assert.equal(pending.kind, 'chat-import');
    const firstFile = path.join(f.scope.directories.groupChats, pending.outputs[0].locator.chat + '.jsonl');
    fs.appendFileSync(firstFile, '\n{}');
    const altered = readRoleplayFile(firstFile);
    assert.throws(() => reconcilePendingChatWrite(f.scope, roleplayNativeHost),
        error => error.code === 'ROLEPLAY_SOURCE_CHANGED' && !error.roleplayImportUnaccepted);
    assert.deepEqual(readRoleplayFile(firstFile), altered);
    assert.equal(readRoleplayAccount(f.scope).pending.kind, 'chat-import');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.scope.directories.groups, 'group.json'), 'utf8')).chats,
        ['Source', 'New']);
});

test('a newly occupied import vacancy is never overwritten or linked', t => {
    const f = fixture(t, true, 'import-occupied');
    const saved = readRoleplayEntity(f.scope, 'group', 'group', { storage: true });
    const request = input(f, { target: { group: true, groupId: 'group', source: { instanceId: saved.instanceId,
        revision: saved.revision, rawHash: saved.rawHash } } });
    let occupied;
    const interrupted = { ...roleplayNativeHost, publish(args) {
        occupied = args.filePath;
        fs.writeFileSync(occupied, 'Other writer owns this name.');
        return roleplayNativeHost.publish(args);
    } };
    assert.throws(() => commitSingleChatImport(f.scope, request, interrupted, convertImportedChatFile));
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'Other writer owns this name.');
    assert.throws(() => reconcilePendingChatWrite(f.scope, roleplayNativeHost));
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'Other writer owns this name.');
    assert.equal(readRoleplayAccount(f.scope).pending.kind, 'chat-import');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.scope.directories.groups, 'group.json'), 'utf8')).chats,
        ['Source', 'New']);
});

test('a physically replaced group blocks a pending composite link even with identical bytes', t => {
    const f = fixture(t, true, 'import-replaced-group');
    const saved = readRoleplayEntity(f.scope, 'group', 'group', { storage: true });
    const groupFile = path.join(f.scope.directories.groups, 'group.json');
    const request = input(f, { target: { group: true, groupId: 'group', source: { instanceId: saved.instanceId,
        revision: saved.revision, rawHash: saved.rawHash } } });
    assert.throws(() => commitSingleChatImport(f.scope, request, { ...roleplayNativeHost,
        publish() { throw new Error('pause before chat'); } }, convertImportedChatFile), /pause before chat/);
    const original = fs.readFileSync(groupFile);
    const replacement = groupFile + '.replacement';
    fs.writeFileSync(replacement, original);
    fs.renameSync(replacement, groupFile);
    const changed = readRoleplayFile(groupFile);
    assert.notDeepEqual(changed.physical, saved.physical);
    assert.throws(() => reconcilePendingChatWrite(f.scope, roleplayNativeHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.deepEqual(readRoleplayFile(groupFile), changed);
    assert.equal(readRoleplayAccount(f.scope).pending.kind, 'chat-import');
});

test('one imported branch publishes its prepared Mewmory pair and retains parent state', t => {
    const f = fixture(t, false, 'import-memory');
    const parent = memoryParent(f);
    const records = structuredClone(f.records);
    records[0].chat_metadata.main_chat = 'Parent';
    const result = commitSingleChatImport(f.scope, input(f, { bytes: Buffer.from(records.map(JSON.stringify).join('\n')) }),
        roleplayNativeHost, convertImportedChatFile);
    const child = canonicalMemoryPaths(f.scope.directories, { group: false, avatar: 'Nova.png', chat: result.names[0] });
    assert.ok(readRoleplayFile(child.guard));
    assert.ok(readRoleplayFile(child.archive));
    assert.deepEqual(JSON.parse(fs.readFileSync(parent.paths.archive, 'utf8')), parent.state);
});

test('one CAI upload links every history to the captured group in one receipt', t => {
    const f = fixture(t, true, 'import-group-multiple');
    const groupFile = path.join(f.scope.directories.groups, 'group.json');
    const original = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
    original.chat_id = 'Source';
    original.chat_metadata = { note: 'retained' };
    fs.writeFileSync(groupFile, JSON.stringify(original));
    const saved = readRoleplayEntity(f.scope, 'group', 'group', { storage: true });
    const request = input(f, { format: 'json', originalName: 'CAI stories.json',
        bytes: Buffer.from(JSON.stringify({ histories: { histories: [
            { msgs: [{ src: { is_human: true }, text: 'One' }] },
            { msgs: [{ src: { is_human: false }, text: 'Two' }] },
        ] } })),
        target: { group: true, groupId: 'group', source: { instanceId: saved.instanceId, revision: saved.revision, rawHash: saved.rawHash } } });
    const result = commitSingleChatImport(f.scope, request, roleplayNativeHost, convertImportedChatFile);
    assert.equal(result.names.length, 2);
    assert.equal(new Set(result.names).size, 2);
    const group = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
    assert.deepEqual(group.chats.slice(-2), result.names);
    assert.equal(group.chat_id, 'Source');
    assert.deepEqual(group.chat_metadata, { note: 'retained' });
    assert.notDeepEqual(readRoleplayFile(groupFile).physical, saved.physical);
    assert.deepEqual(readRoleplayFile(groupFile).physical, readRoleplayAccount(f.scope).resources[saved.instanceId].head.physical);
    for (const name of result.names) {
        const file = readRoleplayFile(path.join(f.scope.directories.groupChats, name + '.jsonl'));
        assert.ok(file);
    }
    assert.equal(Object.values(readRoleplayAccount(f.scope).submissions).at(-1).outcome.kind, 'import');
});

test('supported legacy group link retains its original history, members and metadata', t => {
    const f = fixture(t, true, 'import-legacy-group');
    const filename = path.join(f.scope.directories.groups, 'group.json');
    fs.writeFileSync(filename, JSON.stringify({ id: 'group', name: 'Legacy', members: ['Nova'],
        chat_metadata: { note: 'retained' }, past_metadata: { group: { note: 'past' } } }));
    const source = readRoleplayEntity(f.scope, 'group', 'group', { storage: true });
    const result = commitSingleChatImport(f.scope, input(f, { target: { group: true, groupId: 'group',
        source: { instanceId: source.instanceId, revision: source.revision, rawHash: source.rawHash } } }),
    roleplayNativeHost, convertImportedChatFile);
    const group = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(group.chat_id, 'group');
    assert.deepEqual(group.chats, ['group', ...result.names]);
    assert.deepEqual(group.members, ['Nova.png']);
    assert.deepEqual(group.chat_metadata, { note: 'retained' });
    assert.deepEqual(group.past_metadata, { group: { note: 'past' } });
});

test('HTTP import replays one group file exactly and rejects changed intent or a deleted target', async t => {
    const f = fixture(t, true, 'import-http');
    const group = readRoleplayEntity(f.scope, 'group', 'group', { storage: true });
    const app = express();
    app.use(multer({ dest: path.join(f.root, 'uploads') }).single('avatar'));
    app.use((request, _response, next) => { request.user = { profile: { handle: f.scope.owner }, directories: f.scope.directories }; next(); });
    app.use('/api/chats', chatRouter);
    const server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const post = (key, bytes = Buffer.from(f.records.map(JSON.stringify).join('\n'))) => {
        const body = new FormData();
        body.set('avatar', new Blob([bytes]), 'my story.jsonl');
        body.set('file_type', 'jsonl');
        body.set('user_name', 'User');
        body.set('character_name', 'Nova');
        body.set('group_id', 'group');
        body.set('roleplay', JSON.stringify({ account: { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch },
            operationKey: key, source: { instanceId: group.instanceId, revision: group.revision, rawHash: group.rawHash } }));
        return fetch(`http://127.0.0.1:${server.address().port}/api/chats/group/import`, {
            method: 'POST', headers: { 'X-Neconyan-Account': f.scope.owner }, body,
        });
    };
    const malformed = await post('malformed', Buffer.from('{broken'));
    assert.equal(malformed.status, 400);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    const first = await post('stable-http-key');
    assert.equal(first.status, 200, await first.clone().text());
    const accepted = await first.json();
    assert.equal(accepted.fileNames.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.scope.directories.groups, 'group.json'), 'utf8')).chats.slice(-1), accepted.fileNames);
    const replay = await post('stable-http-key');
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), accepted);
    assert.equal((await post('stable-http-key', Buffer.from('different'))).status, 409);
    fs.unlinkSync(path.join(f.scope.directories.groups, 'group.json'));
    assert.equal((await post('new-key')).status, 404);
    const afterDeletion = await post('stable-http-key');
    assert.equal(afterDeletion.status, 200);
    assert.deepEqual(await afterDeletion.json(), accepted);
    assert.equal(fs.existsSync(path.join(f.scope.directories.groups, 'group.json')), false);
});

test('HTTP replay of a post-pending third state never claims the import was unaccepted', async t => {
    const f = fixture(t, true, 'import-pending-http');
    const saved = readRoleplayEntity(f.scope, 'group', 'group', { storage: true });
    const request = input(f, { target: { group: true, groupId: 'group', source: {
        instanceId: saved.instanceId, revision: saved.revision, rawHash: saved.rawHash } } });
    assert.throws(() => commitSingleChatImport(f.scope, request, { ...roleplayNativeHost, publish(args) {
        fs.writeFileSync(args.filePath, 'A foreign occupant.');
        throw new Error('Publication stopped after pending evidence.');
    } }, convertImportedChatFile), error => error.roleplayWritePending === true && !error.roleplayImportUnaccepted);
    const pending = readRoleplayAccount(f.scope).pending;
    assert.equal(pending.kind, 'chat-import');
    const app = express();
    app.use(multer({ dest: path.join(f.root, 'uploads') }).single('avatar'));
    app.use((incoming, _response, next) => { incoming.user = { profile: { handle: f.scope.owner }, directories: f.scope.directories }; next(); });
    app.use('/api/chats', chatRouter);
    const server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const body = new FormData();
    body.set('avatar', new Blob([request.bytes]), request.originalName);
    body.set('file_type', request.format);
    body.set('user_name', request.userName);
    body.set('character_name', request.characterName);
    body.set('group_id', request.target.groupId);
    body.set('roleplay', JSON.stringify({ account: { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch },
        operationKey: request.operationKey, source: request.target.source }));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chats/group/import`, {
        method: 'POST', headers: { 'X-Neconyan-Account': f.scope.owner }, body,
    });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('X-Neconyan-Import-Unaccepted'), null);
    assert.deepEqual(readRoleplayAccount(f.scope).pending, pending);
});
