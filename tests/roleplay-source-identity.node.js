import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { parseChatJsonl } = await import('../src/chat-recovery.js');
const { getChatFileLockPath } = await import('../src/chat-file-lock.js');
const { readRoleplayFile, roleplayLease, withRoleplayAccount } = await import('../src/roleplay-store.js');
const {
    captureRoleplaySource,
    captureRoleplaySourceFromSavedChatLocked,
    readRoleplayChat,
    readRoleplayChatLocked,
    reusableChatContentHash,
    roleplayContentHash,
    roleplayParsedContentHash,
    roleplayPathKey,
} = await import('../src/generation/roleplay-source.js');

function outcome(operation) {
    try {
        return { value: operation() };
    } catch (error) {
        return { error: { name: error.name, message: error.message, code: error.code } };
    }
}

function accountBase(f) {
    return { owner: f.scope.owner, directories: f.scope.directories };
}

function accountStamp(f) {
    return { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
}

function parsedChat(lines) {
    const parsed = parseChatJsonl(Buffer.from(lines.join('\n')));
    assert.equal(parsed.status, 'ok');
    return parsed.records;
}

test('the parsed-chat hash exactly matches the legacy hash on JSON edge data', () => {
    const header = '{"user_name":"User","character_name":"Nova","chat_metadata":{"integrity":"legacy","nested":{"a":1,"b":[null,true,false,0,1.5,"x"]}},"header_extra":"kept"}';
    const records = parsedChat([
        header,
        '{"name":"User","is_user":true,"mes":"plain","value":null}',
        '{"name":"Nova","is_user":false,"mes":"unicode \\ud83d\\ude00 and \\ud800","numbers":{"large":9007199254740993,"small":1e-7,"max":1e308},"array":[1,2,{"deep":true}]}',
        '{"name":"User","is_user":true,"mes":"proto","__proto__":{"polluted":true}}',
        '{"name":"Nova","is_user":false,"mes":"tail","extra":{"empty":""}}',
    ]);
    assert.equal(Object.hasOwn(records[3], '__proto__'), true);
    assert.equal(roleplayParsedContentHash(records), roleplayContentHash(records));
    assert.match(roleplayParsedContentHash(records), /^[a-f0-9]{64}$/);

    const headerOnly = parsedChat([header]);
    assert.equal(roleplayParsedContentHash(headerOnly), roleplayContentHash(headerOnly));

    const noIntegrity = parsedChat(['{"user_name":"User","character_name":"Nova","chat_metadata":{}}']);
    assert.equal(roleplayParsedContentHash(noIntegrity), roleplayContentHash(noIntegrity));
});

test('negative zero and non-JSON values keep the exact legacy result or refusal', () => {
    const base = parsedChat([
        '{"user_name":"User","character_name":"Nova","chat_metadata":{}}',
        '{"name":"User","is_user":true,"mes":"value","value":null}',
    ]);
    const negative = parsedChat([
        '{"user_name":"User","character_name":"Nova","chat_metadata":{}}',
        '{"name":"User","is_user":true,"mes":"negative","value":-0}',
    ]);
    assert.equal(Object.is(negative[1].value, -0), true);
    assert.deepEqual(outcome(() => roleplayParsedContentHash(negative)), outcome(() => roleplayContentHash(negative)));

    const customPrototype = Object.create({ inherited: true });
    customPrototype.own = 'value';
    const sparse = [1];
    sparse[2] = 3;
    const cases = [
        ['undefined', undefined],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['negative zero', -0],
        ['Date', new Date(0)],
        ['function', () => 1],
        ['symbol', Symbol('value')],
        ['bigint', 10n],
        ['custom prototype', customPrototype],
        ['sparse array', sparse],
    ];
    for (const [label, value] of cases) {
        const records = structuredClone(base);
        records[1].value = value;
        assert.deepEqual(outcome(() => roleplayParsedContentHash(records)), outcome(() => roleplayContentHash(records)), label);
    }

    const cyclic = structuredClone(base);
    const cycle = {};
    cycle.self = cycle;
    cyclic[1].value = cycle;
    assert.deepEqual(outcome(() => roleplayParsedContentHash(cyclic)), outcome(() => roleplayContentHash(cyclic)));

    const malformed = [
        ['empty records', []],
        ['missing header metadata', [{ user_name: 'User' }]],
        ['non-object records', 'not a chat'],
    ];
    for (const [label, records] of malformed) {
        assert.deepEqual(outcome(() => roleplayParsedContentHash(records)), outcome(() => roleplayContentHash(records)), label);
    }
});

test('a stored hash is reused only for a live matching identity with a valid value', t => {
    const f = fixture(t);
    readRoleplayChat(f.scope, f.locator);
    withRoleplayAccount(accountBase(f), accountStamp(f), lease => {
        const { state } = roleplayLease(lease);
        const instanceId = state.paths[roleplayPathKey(state, 'chat', f.locator)].instanceId;
        const resource = state.resources[instanceId];
        const file = readRoleplayFile(f.filename, 64 * 1024 * 1024);
        assert.equal(reusableChatContentHash(state, f.locator, file), resource.head.contentHash);
        assert.notEqual(reusableChatContentHash({ ...state, paths: {} }, f.locator, file), resource.head.contentHash);

        const variants = [
            ['retired status', { ...resource, status: 'retired' }],
            ['other account', { ...resource, accountId: '0'.repeat(8) }],
            ['other epoch', { ...resource, dataEpoch: state.dataEpoch + 1 }],
            ['other kind', { ...resource, kind: 'character' }],
            ['other locator', { ...resource, locator: { ...resource.locator, chat: 'Other' } }],
            ['other raw hash', { ...resource, head: { ...resource.head, rawHash: '0'.repeat(64) } }],
            ['other physical identity', { ...resource, head: { ...resource.head, physical: { ...resource.head.physical, ino: '0' } } }],
            ['missing stored hash', { ...resource, head: { ...resource.head, contentHash: undefined } }],
            ['short stored hash', { ...resource, head: { ...resource.head, contentHash: 'abc' } }],
            ['uppercase stored hash', { ...resource, head: { ...resource.head, contentHash: resource.head.contentHash.toUpperCase() } }],
        ];
        for (const [label, variant] of variants) {
            const changedState = { ...state, resources: { ...state.resources, [instanceId]: variant } };
            assert.equal(reusableChatContentHash(changedState, f.locator, file), null, label);
        }
    });
});

test('missing, linked and oversized chats keep their existing refusals', t => {
    const missing = fixture(t);
    fs.unlinkSync(missing.filename);
    assert.throws(() => readRoleplayChat(missing.scope, missing.locator), { code: 'ROLEPLAY_SOURCE_MISSING' });

    const missingParent = fixture(t);
    fs.rmSync(path.dirname(missingParent.filename), { recursive: true, force: true });
    assert.throws(() => readRoleplayChat(missingParent.scope, missingParent.locator), error => error.code === 'ENOENT');

    const linked = fixture(t);
    const alias = linked.filename + '.hard';
    fs.linkSync(linked.filename, alias);
    assert.throws(() => readRoleplayChat(linked.scope, linked.locator), { code: 'ROLEPLAY_STORE_DAMAGED' });
    fs.unlinkSync(alias);

    const oversized = fixture(t);
    fs.truncateSync(oversized.filename, 64 * 1024 * 1024 + 1);
    assert.throws(() => readRoleplayChat(oversized.scope, oversized.locator), { code: 'ROLEPLAY_STORE_DAMAGED' });
});

test('a symlinked higher ancestor is refused before any chat lock is created', t => {
    const f = fixture(t);
    const chats = f.scope.directories.chats;
    const realChats = `${chats}-real`;
    fs.renameSync(chats, realChats);
    fs.symlinkSync(realChats, chats, 'dir');
    const lockPath = path.resolve(getChatFileLockPath(f.filename));
    const chatDirectory = path.resolve(path.dirname(f.filename));
    const writes = [];
    const originalMkdir = fs.mkdirSync;
    const originalOpen = fs.openSync;
    fs.mkdirSync = function (target, ...args) {
        const value = path.resolve(String(target));
        if (value === chatDirectory || value === lockPath) writes.push(`mkdir:${value}`);
        return originalMkdir.call(this, target, ...args);
    };
    fs.openSync = function (target, ...args) {
        const value = path.resolve(String(target));
        if (value === lockPath || value === `${lockPath}.owner`) writes.push(`open:${value}`);
        return originalOpen.call(this, target, ...args);
    };
    try {
        assert.throws(() => readRoleplayChat(f.scope, f.locator), { code: 'ROLEPLAY_STORE_DAMAGED' });
    } finally {
        fs.mkdirSync = originalMkdir;
        fs.openSync = originalOpen;
    }
    assert.deepEqual(writes, []);
    assert.equal(fs.existsSync(lockPath), false);
});

test('changed bytes and a missing stored hash still refuse the identity', t => {
    const changed = fixture(t);
    readRoleplayChat(changed.scope, changed.locator);
    const next = structuredClone(changed.records);
    next[2].mes = 'Changed later';
    fs.writeFileSync(changed.filename, next.map(record => JSON.stringify(record)).join('\n'));
    assert.throws(() => readRoleplayChat(changed.scope, changed.locator), { code: 'ROLEPLAY_SOURCE_CHANGED' });

    const missingHash = fixture(t);
    readRoleplayChat(missingHash.scope, missingHash.locator);
    withRoleplayAccount(accountBase(missingHash), accountStamp(missingHash), lease => {
        const { state } = roleplayLease(lease);
        const instanceId = state.paths[roleplayPathKey(state, 'chat', missingHash.locator)].instanceId;
        state.resources[instanceId].head.contentHash = undefined;
        assert.throws(() => readRoleplayChatLocked(lease, missingHash.locator), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    });
});

test('a source capture reuses only the read from the same lock', t => {
    const f = fixture(t);
    readRoleplayChat(f.scope, f.locator);
    captureRoleplaySource(f.scope, { locator: f.locator });
    let saved;
    withRoleplayAccount(accountBase(f), accountStamp(f), lease => {
        saved = readRoleplayChatLocked(lease, f.locator);
        const originalOpen = fs.openSync;
        let opens = 0;
        fs.openSync = function (file, ...args) {
            if (path.resolve(String(file)) === path.resolve(f.filename)) opens += 1;
            return originalOpen.call(this, file, ...args);
        };
        try {
            const captured = captureRoleplaySourceFromSavedChatLocked(lease, saved, { locator: f.locator });
            assert.equal(captured.source.instanceId, saved.instanceId);
            assert.equal(captured.changed, false);
        } finally {
            fs.openSync = originalOpen;
        }
        assert.equal(opens, 0);
    });

    assert.throws(() => withRoleplayAccount(accountBase(f), accountStamp(f), lease =>
        captureRoleplaySourceFromSavedChatLocked(lease, saved, { locator: f.locator }),
    ), { code: 'ROLEPLAY_SOURCE_CHANGED' });

    const copied = { ...saved };
    assert.throws(() => withRoleplayAccount(accountBase(f), accountStamp(f), lease =>
        captureRoleplaySourceFromSavedChatLocked(lease, copied, { locator: f.locator }),
    ), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('a capture refuses another account, epoch or locator on the snapshot', t => {
    const f = fixture(t);
    readRoleplayChat(f.scope, f.locator);
    withRoleplayAccount(accountBase(f), accountStamp(f), lease => {
        const otherAccount = readRoleplayChatLocked(lease, f.locator);
        otherAccount.accountId = '0'.repeat(8);
        assert.throws(() => captureRoleplaySourceFromSavedChatLocked(lease, otherAccount, { locator: f.locator }),
            { code: 'ROLEPLAY_SOURCE_CHANGED' });

        const otherEpoch = readRoleplayChatLocked(lease, f.locator);
        otherEpoch.dataEpoch += 1;
        assert.throws(() => captureRoleplaySourceFromSavedChatLocked(lease, otherEpoch, { locator: f.locator }),
            { code: 'ROLEPLAY_SOURCE_CHANGED' });

        const current = readRoleplayChatLocked(lease, f.locator);
        assert.throws(() => captureRoleplaySourceFromSavedChatLocked(lease, current, { locator: { ...f.locator, chat: 'Other' } }),
            { code: 'ROLEPLAY_SOURCE_CHANGED' });
    });
});

test('a capture refuses a state change after the same-lock read', t => {
    const f = fixture(t);
    readRoleplayChat(f.scope, f.locator);
    withRoleplayAccount(accountBase(f), accountStamp(f), lease => {
        const saved = readRoleplayChatLocked(lease, f.locator);
        const { state } = roleplayLease(lease);
        const instanceId = state.paths[roleplayPathKey(state, 'chat', f.locator)].instanceId;
        state.resources[instanceId].revision += 1;
        assert.throws(() => captureRoleplaySourceFromSavedChatLocked(lease, saved, { locator: f.locator }),
            { code: 'ROLEPLAY_SOURCE_CHANGED' });
    });
});
