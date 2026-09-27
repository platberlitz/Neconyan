/* eslint playwright/expect-expect: off -- Uses node:assert against saved chat files. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { TavernCardValidator } from '../src/validator/TavernCardValidator.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { initialiseRoleplayAccount, readRoleplayAccount } = await import('../src/roleplay-store.js');
const { captureRoleplaySource, captureRoleplayStorageSource, assertRoleplaySource, readRoleplayChat, readRoleplayEntity, normaliseRoleplayLocator, roleplayGroupContentHash } = await import('../src/generation/roleplay-source.js');
const { read: readCard, write: writeCard } = await import('../src/character-card-parser.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

function fixture(t, group = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-roleplay-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const userRoot = path.join(root, 'fixture');
    const directories = { root: userRoot, chats: path.join(userRoot, 'chats'), groupChats: path.join(userRoot, 'group chats'),
        characters: path.join(userRoot, 'characters'), groups: path.join(userRoot, 'groups') };
    fs.mkdirSync(path.join(directories.chats, 'Nova'), { recursive: true });
    fs.mkdirSync(directories.groupChats);
    fs.mkdirSync(directories.characters);
    fs.mkdirSync(directories.groups);
    const cardPath = path.join(directories.characters, 'Nova.png');
    fs.writeFileSync(cardPath, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Original' })));
    const groupPath = path.join(directories.groups, 'group.json');
    const groupData = { id: 'group', members: ['Nova.png'], disabled_members: [], chats: ['Source'], chat_id: 'Source', member_models: {} };
    fs.writeFileSync(groupPath, JSON.stringify(groupData));
    const locator = group ? { group: true, chat: 'Source' } : { group: false, chat: 'Source', avatar: 'Nova.png' };
    const filename = path.join(group ? directories.groupChats : path.join(directories.chats, 'Nova'), 'Source.jsonl');
    const records = [{ user_name: 'User', character_name: 'Nova', chat_metadata: {}, extra_header: true },
        { name: 'User', is_user: true, mes: 'same', extra: { file: 'attachment.txt' } },
        { name: 'Nova', is_user: false, mes: 'same', swipe_id: 0, swipes: ['same', 'other'],
            swipe_info: [{ extra: { reasoning: 'reasoning' } }, { extra: {} }], extra: { reasoning: 'reasoning' } }];
    const write = () => fs.writeFileSync(filename, records.map(value => JSON.stringify(value)).join('\n'));
    write();
    return { scope: initialiseRoleplayAccount({ owner: 'fixture', directories }), locator, filename, records, write,
        cardPath, groupPath, groupData, groupId: group ? 'group' : undefined };
}

for (const group of [false, true]) {
    test(`${group ? 'group' : 'solo'} enrolment retains original bytes and exact indexed anchors`, t => {
        const f = fixture(t, group);
        const bytes = fs.readFileSync(f.filename);
        const inode = fs.statSync(f.filename).ino;
        const first = captureRoleplaySource(f.scope, { locator: f.locator, groupId: f.groupId, message: 0 });
        const second = captureRoleplaySource(f.scope, { locator: f.locator, groupId: f.groupId, message: 1, range: { start: 1, count: 1 } });
        assert.equal(first.instanceId, second.instanceId);
        assert.notEqual(first.message.recordHash, second.message.recordHash);
        assert.equal(second.message.selectedSwipeId, 0);
        assert.equal(assertRoleplaySource(f.scope, second).records[2].extra.reasoning, 'reasoning');
        assert.deepEqual(fs.readFileSync(f.filename), bytes);
        assert.equal(fs.statSync(f.filename).ino, inode);
        assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, group ? 3 : 2);
    });

    test(`${group ? 'group' : 'solo'} storage capture is explicit and does not enrol generation dependencies`, t => {
        const f = fixture(t, group);
        const before = fs.readFileSync(f.filename);
        fs.unlinkSync(f.cardPath);
        fs.unlinkSync(f.groupPath);
        const source = captureRoleplayStorageSource(f.scope, f.locator);
        assert.equal(source.kind, 'storage');
        assert.deepEqual(source.dependencies, []);
        assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 1);
        assert.deepEqual(assertRoleplaySource(f.scope, source).records, f.records);
        assert.deepEqual(fs.readFileSync(f.filename), before);
        assert.throws(() => assertRoleplaySource(f.scope, { ...source, kind: 'unknown' }), { code: 'ROLEPLAY_INVALID' });
        const untagged = structuredClone(source);
        delete untagged.kind;
        assert.throws(() => assertRoleplaySource(f.scope, untagged));
        assert.throws(() => assertRoleplaySource(f.scope, { ...source, range: { start: 0, count: 1 } }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
        assert.throws(() => assertRoleplaySource(f.scope, { ...source, revision: source.revision + 1 }), error => {
            assert.equal(error.code, 'ROLEPLAY_SOURCE_CHANGED');
            assert.deepEqual(error.current, { instanceId: source.instanceId, revision: source.revision, rawHash: source.rawHash });
            return true;
        });
    });
}

test('unchanged character decoding is reused without trusting mutated data or replaced files', t => {
    const f = fixture(t);
    let validations = 0;
    for (const method of ['validateV1', 'validateV2', 'validateV3']) {
        const original = TavernCardValidator.prototype[method];
        t.mock.method(TavernCardValidator.prototype, method, function (...args) {
            validations++;
            return original.apply(this, args);
        });
    }
    const first = readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const expected = structuredClone(first.data);
    const initialValidations = validations;
    assert.ok(initialValidations > 0);
    first.data.name = 'Locally changed';
    assert.deepEqual(readRoleplayEntity(f.scope, 'character', 'Nova.png').data, expected);
    assert.equal(validations, initialValidations);
    const originalBytes = fs.readFileSync(f.cardPath);
    fs.writeFileSync(f.cardPath, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Changed' })));
    assert.throws(() => readRoleplayEntity(f.scope, 'character', 'Nova.png'), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    fs.writeFileSync(f.cardPath, originalBytes);
    assert.deepEqual(readRoleplayEntity(f.scope, 'character', 'Nova.png').data, expected);
    const replacement = f.cardPath + '.replacement';
    fs.writeFileSync(replacement, originalBytes);
    fs.renameSync(replacement, f.cardPath);
    assert.throws(() => readRoleplayEntity(f.scope, 'character', 'Nova.png'), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('same-length text, hidden fields and selected swipe changes invalidate protected source', t => {
    const f = fixture(t);
    const source = captureRoleplaySource(f.scope, { locator: f.locator, message: 1 });
    const original = fs.readFileSync(f.filename);
    for (const change of [() => { f.records[2].mes = 'edit'; }, () => { f.records[2].extra.reasoning = 'different'; },
        () => { f.records[2].swipe_info[0].extra.reasoning = 'changed'; }, () => { f.records[2].swipe_id = 1; }]) {
        f.records = original.toString('utf8').split('\n').map(line => JSON.parse(line));
        change();
        fs.writeFileSync(f.filename, f.records.map(value => JSON.stringify(value)).join('\n'));
        assert.throws(() => assertRoleplaySource(f.scope, source), { code: 'ROLEPLAY_SOURCE_CHANGED' });
        fs.writeFileSync(f.filename, original);
    }
});

test('identical bytes at a replaced path cannot impersonate the enrolled file', t => {
    const f = fixture(t);
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const replacement = f.filename + '.replacement';
    fs.copyFileSync(f.filename, replacement);
    fs.renameSync(replacement, f.filename);
    assert.throws(() => assertRoleplaySource(f.scope, source), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('a copied native marker cannot enrol its former identity', t => {
    const f = fixture(t);
    f.records[0].chat_metadata.neconyan_roleplay = { schema: 1, instanceId: 'foreign', revision: 1, writeId: 'foreign' };
    f.write();
    assert.throws(() => readRoleplayChat(f.scope, f.locator), { code: 'ROLEPLAY_FOREIGN_SOURCE' });
    assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 0);
});

test('unsafe locators and linked sources are refused without recovering or creating them', t => {
    const f = fixture(t);
    assert.throws(() => normaliseRoleplayLocator({ ...f.locator, chat: '../Other' }), { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => normaliseRoleplayLocator({ ...f.locator, avatar: '...png' }), { code: 'ROLEPLAY_INVALID' });
    const real = f.filename + '.real';
    fs.renameSync(f.filename, real);
    fs.symlinkSync(real, f.filename);
    const bytes = fs.readFileSync(real);
    assert.throws(() => readRoleplayChat(f.scope, f.locator), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.deepEqual(fs.readFileSync(real), bytes);
    assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 0);
});

for (const avatar of ['Nova.png extra.png', 'Nova|v2.png']) {
    test(`generation capture and persisted dependencies preserve ${avatar}`, { skip: process.platform === 'win32' && avatar.includes('|') }, t => {
        const f = fixture(t);
        fs.renameSync(f.cardPath, path.join(f.scope.directories.characters, avatar));
        fs.renameSync(path.dirname(f.filename), path.join(f.scope.directories.chats, avatar.replace('.png', '')));
        const locator = { ...f.locator, avatar };
        const source = captureRoleplaySource(f.scope, { locator });
        assert.deepEqual(source.locator, locator);
        assert.deepEqual(source.dependencies[0].locator, { avatar });
        assert.deepEqual(assertRoleplaySource(f.scope, source).records, f.records);
        const ledger = readRoleplayAccount(f.scope);
        assert.equal(Object.keys(ledger.resources).length, 2);
        assert.deepEqual(ledger.resources[source.dependencies[0].instanceId].locator, { avatar });
    });
}

test('an exact base name ending in jsonl does not select a different chat', t => {
    const f = fixture(t);
    const double = f.filename + '.jsonl';
    const other = structuredClone(f.records);
    other[2].mes = 'Different file';
    fs.writeFileSync(double, other.map(value => JSON.stringify(value)).join('\n'));
    const source = readRoleplayChat(f.scope, { ...f.locator, chat: 'Source.jsonl' });
    assert.equal(source.filePath, double);
    assert.equal(source.records[2].mes, 'Different file');
    assert.equal(readRoleplayChat(f.scope, f.locator).records[2].mes, 'same');
});

test('an unjournalled move cannot allocate a second identity to the same legacy file', t => {
    const f = fixture(t);
    readRoleplayChat(f.scope, f.locator);
    fs.renameSync(f.filename, path.join(path.dirname(f.filename), 'Moved.jsonl'));
    assert.throws(() => readRoleplayChat(f.scope, { ...f.locator, chat: 'Moved' }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 1);
});

test('source capture requires existing, valid saved cards without enrolling a rejected source', t => {
    const f = fixture(t);
    fs.unlinkSync(f.cardPath);
    assert.throws(() => captureRoleplaySource(f.scope, { locator: f.locator }), { code: 'ROLEPLAY_SOURCE_MISSING' });
    fs.writeFileSync(f.cardPath, png);
    assert.throws(() => captureRoleplaySource(f.scope, { locator: f.locator }), { code: 'ROLEPLAY_SOURCE_DAMAGED' });
    assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 0);
});

test('card replacement and changed card data invalidate accepted source identity', t => {
    const f = fixture(t);
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const original = fs.readFileSync(f.cardPath);
    fs.writeFileSync(f.cardPath, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Changed' })));
    assert.throws(() => assertRoleplaySource(f.scope, source), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    fs.writeFileSync(f.cardPath + '.new', original);
    fs.renameSync(f.cardPath + '.new', f.cardPath);
    assert.throws(() => assertRoleplaySource(f.scope, source), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('group source requires explicit unambiguous saved chat ownership', t => {
    const f = fixture(t, true);
    assert.throws(() => captureRoleplaySource(f.scope, { locator: f.locator }), { code: 'ROLEPLAY_INVALID' });
    fs.writeFileSync(f.groupPath, JSON.stringify({ ...f.groupData, chats: [] }));
    assert.throws(() => captureRoleplaySource(f.scope, { locator: f.locator, groupId: f.groupId }), { code: 'ROLEPLAY_GROUP_MISMATCH' });
    fs.writeFileSync(f.groupPath, JSON.stringify(f.groupData));
    fs.writeFileSync(path.join(f.scope.directories.groups, 'other.json'), JSON.stringify({ ...f.groupData, id: 'other' }));
    assert.throws(() => captureRoleplaySource(f.scope, { locator: f.locator, groupId: f.groupId }), { code: 'ROLEPLAY_GROUP_AMBIGUOUS' });
    assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 0);
});

test('group configuration and every member card are captured dependencies', t => {
    const f = fixture(t, true);
    const source = captureRoleplaySource(f.scope, { locator: f.locator, groupId: f.groupId });
    assert.deepEqual(source.dependencies.map(item => item.kind), ['group', 'character']);
    for (const patch of [{ members: [] }, { disabled_members: ['Nova.png'] }, { member_models: { 'Nova.png': 'different' } }, { unknown_setting: 'significant' }]) {
        fs.writeFileSync(f.groupPath, JSON.stringify({ ...f.groupData, ...patch }));
        assert.throws(() => assertRoleplaySource(f.scope, source), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    }
    fs.writeFileSync(f.groupPath, JSON.stringify(f.groupData));
    fs.unlinkSync(f.cardPath);
    assert.throws(() => assertRoleplaySource(f.scope, source), { code: 'ROLEPLAY_SOURCE_MISSING' });
});

test('group semantic identity excludes only named navigation and derived display fields', t => {
    const f = fixture(t, true);
    assert.equal(roleplayGroupContentHash(f.groupData), roleplayGroupContentHash({ ...f.groupData,
        chat_id: 'Other', date_last_chat: 123, chat_size: 456, date_added: 789, create_date: 'today' }));
    assert.notEqual(roleplayGroupContentHash(f.groupData), roleplayGroupContentHash({ ...f.groupData, extension: null }));
});

test('PNG chunk bounds are checked before the parser can allocate a declared oversized chunk', t => {
    const f = fixture(t);
    const malformed = Buffer.alloc(16);
    png.copy(malformed, 0, 0, 8);
    malformed.writeUInt32BE(0x40000000, 8);
    malformed.write('IHDR', 12);
    const original = globalThis.Uint8Array;
    let oversizedAllocation = false;
    globalThis.Uint8Array = new Proxy(original, { construct(target, args) {
        if (typeof args[0] === 'number' && args[0] > 1024 * 1024) {
            oversizedAllocation = true;
            throw new Error('Unsafe parser allocation intercepted');
        }
        return Reflect.construct(target, args);
    } });
    try {
        assert.throws(() => readCard(malformed), /Truncated PNG chunk/);
        assert.throws(() => writeCard(malformed, '{}'), /Truncated PNG chunk/);
        fs.writeFileSync(f.cardPath, malformed);
        assert.throws(() => captureRoleplaySource(f.scope, { locator: f.locator }), { code: 'ROLEPLAY_SOURCE_DAMAGED' });
        assert.equal(oversizedAllocation, false);
    } finally { globalThis.Uint8Array = original; }
});

test('declared malformed cards are refused while valid legacy cards retain extension data', t => {
    const f = fixture(t);
    fs.writeFileSync(f.cardPath, writeCard(png, JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: 'not an object' })));
    assert.throws(() => captureRoleplaySource(f.scope, { locator: f.locator }), { code: 'ROLEPLAY_SOURCE_DAMAGED' });
    assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 0);
    fs.writeFileSync(f.cardPath, writeCard(png, JSON.stringify({ name: 'Nova', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', unknown: { keep: true } })));
    assert.equal(captureRoleplaySource(f.scope, { locator: f.locator }).dependencies.length, 1);
    assert.deepEqual(JSON.parse(readCard(fs.readFileSync(f.cardPath))).unknown, { keep: true });
});

test('numeric legacy group chat IDs participate in both ownership and ambiguity checks', t => {
    const f = fixture(t, true);
    fs.renameSync(f.filename, path.join(path.dirname(f.filename), '123.jsonl'));
    f.locator.chat = '123';
    fs.writeFileSync(f.groupPath, JSON.stringify({ ...f.groupData, chats: [123] }));
    const source = captureRoleplaySource(f.scope, { locator: f.locator, groupId: f.groupId });
    assert.equal(assertRoleplaySource(f.scope, source).locator.chat, '123');
    fs.writeFileSync(path.join(f.scope.directories.groups, 'other.json'), JSON.stringify({ ...f.groupData, id: 'other', chats: ['123'] }));
    assert.throws(() => assertRoleplaySource(f.scope, source), { code: 'ROLEPLAY_GROUP_AMBIGUOUS' });
});

test('competing groups cannot hide changed or removed protected ownership evidence', t => {
    const f = fixture(t, true);
    captureRoleplaySource(f.scope, { locator: f.locator, groupId: f.groupId });
    fs.writeFileSync(f.groupPath, JSON.stringify({ ...f.groupData, chats: [] }));
    fs.writeFileSync(path.join(f.scope.directories.groups, 'other.json'), JSON.stringify({ ...f.groupData, id: 'other' }));
    assert.throws(() => captureRoleplaySource(f.scope, { locator: f.locator, groupId: 'other' }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    fs.unlinkSync(f.groupPath);
    assert.throws(() => captureRoleplaySource(f.scope, { locator: f.locator, groupId: 'other' }), { code: 'ROLEPLAY_SOURCE_MISSING' });
});

test('structurally damaged competing groups do not establish absence of another owner', t => {
    const f = fixture(t, true);
    for (const invalid of [null, [], { id: 'other', members: [], chats: {} }, { id: 'wrong', members: [], chats: [] }]) {
        fs.writeFileSync(path.join(f.scope.directories.groups, 'other.json'), JSON.stringify(invalid));
        assert.throws(() => captureRoleplaySource(f.scope, { locator: f.locator, groupId: f.groupId }), { code: 'ROLEPLAY_SOURCE_DAMAGED' });
        assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 0);
    }
});

test('saved group identity must be a string or numeric legacy ID, never a coerced object', t => {
    const f = fixture(t, true);
    for (const id of [null, ['group'], {}, undefined]) {
        fs.writeFileSync(f.groupPath, JSON.stringify({ ...f.groupData, id }));
        assert.throws(() => captureRoleplaySource(f.scope, { locator: f.locator, groupId: 'group' }), { code: 'ROLEPLAY_SOURCE_DAMAGED' });
    }
    fs.renameSync(f.groupPath, path.join(f.scope.directories.groups, 'undefined.json'));
    assert.throws(() => captureRoleplaySource(f.scope, { locator: f.locator, groupId: 'undefined' }), { code: 'ROLEPLAY_SOURCE_DAMAGED' });
    assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 0);
});
