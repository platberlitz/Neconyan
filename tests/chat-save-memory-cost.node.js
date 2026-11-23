/* eslint playwright/expect-expect: off -- Uses node:assert against real disposable storage. */
/* global globalThis */
// Pins the memory cost of saving and loading a large chat by counting the whole-chat-sized work done,
// not by timing or by measuring the heap, so a later change that brings back a whole-chat copy fails here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TextDecoder } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { roleplayBrowserHost } from '../src/endpoints/chats.js';
import { clearChatPatchIndexes } from '../src/chat-patch.js';
import { patchFor, savedMessageLines } from './chat-patch-helpers.js';
import { readRoleplayChat } from '../src/generation/roleplay-source.js';
import { commitSingleChatWrite } from '../src/roleplay-lifecycle.js';

const MESSAGES = 300;

function message(index) {
    // Two-byte text and nested values, like a chat with a variables extension.
    const text = `Line ${index} \u2014 ${'caf\u00e9 \u65e5\u672c\u8a9e '.repeat(120)}`;
    const variables = { stat_data: Object.fromEntries(Array.from({ length: 60 }, (_, key) => [`character_${key}`, { level: [key, `note ${index}`], items: [{ name: 'a', count: key }] }])) };
    return { name: index % 2 ? 'Nova' : 'User', is_user: index % 2 === 0, send_date: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`, mes: text, extra: {}, variables: [variables] };
}

const chat = [{ chat_metadata: { note: 'big' }, user_name: 'User', character_name: 'Nova' }, ...Array.from({ length: MESSAGES }, (_, index) => message(index))];
const chatText = chat.map(record => JSON.stringify(record)).join('\n');

/** Runs `operation` while counting the work that touches a whole chat or a large part of it. */
function measure(operation) {
    const whole = chatText.length * 0.6;
    const wholeBytes = Buffer.byteLength(chatText, 'utf8') * 0.6;
    const meters = { parsedChars: 0, stringifiedChars: 0, largeTexts: 0, largeClones: 0, largeBuffers: 0 };
    const originals = {
        parse: JSON.parse,
        stringify: JSON.stringify,
        clone: globalThis.structuredClone,
        decode: TextDecoder.prototype.decode,
        toString: Buffer.prototype.toString,
        readFileSync: fs.readFileSync,
        alloc: Buffer.alloc,
        allocUnsafe: Buffer.allocUnsafe,
        from: Buffer.from,
        concat: Buffer.concat,
    };
    const large = text => {
        if (typeof text === 'string' && text.length >= whole) {
            meters.largeTexts += 1;
            if (process.env.CHAT_COST_REPORT === '2') console.log('  whole-chat text:', new Error().stack.split('\n').slice(2, 6).map(line => line.trim().replace(/\(.*\/src\//, '(')).join(' < '));
        }
        return text;
    };
    const largeBuffer = buffer => {
        if (Buffer.isBuffer(buffer) && buffer.byteLength >= wholeBytes) {
            meters.largeBuffers += 1;
            if (process.env.CHAT_COST_REPORT === '2') console.log('  whole-chat buffer:', buffer.byteLength, new Error().stack.split('\n').slice(2, 6).map(line => line.trim().replace(/\(.*\/src\//, '(')).join(' < '));
        }
        return buffer;
    };
    JSON.parse = function (text, ...rest) {
        if (typeof text === 'string') { meters.parsedChars += text.length; large(text); }
        return originals.parse.call(this, text, ...rest);
    };
    JSON.stringify = function (...args) {
        const text = originals.stringify.apply(this, args);
        if (typeof text === 'string') { meters.stringifiedChars += text.length; large(text); }
        return text;
    };
    globalThis.structuredClone = function (value, ...rest) {
        if (Array.isArray(value) && value.length >= MESSAGES / 2) meters.largeClones += 1;
        return originals.clone.call(this, value, ...rest);
    };
    TextDecoder.prototype.decode = function (...args) { return large(originals.decode.apply(this, args)); };
    Buffer.prototype.toString = function (...args) { return large(originals.toString.apply(this, args)); };
    Buffer.alloc = function (...args) { return largeBuffer(originals.alloc.apply(this, args)); };
    Buffer.allocUnsafe = function (...args) { return largeBuffer(originals.allocUnsafe.apply(this, args)); };
    Buffer.from = function (...args) { return largeBuffer(originals.from.apply(this, args)); };
    Buffer.concat = function (...args) { return largeBuffer(originals.concat.apply(this, args)); };
    fs.readFileSync = function (...args) {
        const result = originals.readFileSync.apply(this, args);
        if (Buffer.isBuffer(result)) return largeBuffer(result);
        return large(result);
    };
    syncBuiltinESMExports();
    try {
        operation();
    } finally {
        Object.assign(JSON, { parse: originals.parse, stringify: originals.stringify });
        globalThis.structuredClone = originals.clone;
        TextDecoder.prototype.decode = originals.decode;
        Buffer.prototype.toString = originals.toString;
        Buffer.alloc = originals.alloc;
        Buffer.allocUnsafe = originals.allocUnsafe;
        Buffer.from = originals.from;
        Buffer.concat = originals.concat;
        fs.readFileSync = originals.readFileSync;
        syncBuiltinESMExports();
    }
    return { ...meters, parsedChats: meters.parsedChars / chatText.length, stringifiedChats: meters.stringifiedChars / chatText.length };
}

function savedChat(t) {
    const f = fixture(t);
    fs.writeFileSync(f.filename, chatText);
    const first = [...structuredClone(chat), message(MESSAGES)];
    commitSingleChatWrite(f.scope, { operationKey: 'first', mode: 'update', source: f.source(), records: first, backup: { deferBackup: false } }, roleplayBrowserHost);
    return { f, first };
}

// Limits are what was measured, so one more whole-chat text, parse or serialisation fails. Counts of texts and
// clones are exact integers. The ratios are rounded up to the third decimal, about 3,000 characters of this
// 2.9 million character chat: the only run-to-run variation is the digits of file ids inside the account
// ledger, which is read a few times (tens of characters).
function measureSave(t, operationKey, makeRecords) {
    const { f, first } = savedChat(t);
    const input = { operationKey, mode: 'update', source: f.source(), records: makeRecords(first), backup: { deferBackup: false } };
    const cost = measure(() => commitSingleChatWrite(f.scope, input, roleplayBrowserHost));
    if (process.env.CHAT_COST_REPORT) console.log(operationKey, JSON.stringify(cost));
    return cost;
}

test('one save of a large chat does a bounded amount of whole-chat work', t => {
    const cost = measureSave(t, 'changed', first => [...first, message(MESSAGES + 1)]);
    // Before #897: 2 whole-chat clones, 19 whole-chat texts, 13.10 chats parsed and 9.40 serialised.
    // Before this change: 5 whole-chat texts and 29 whole-chat buffers.
    assert.equal(cost.largeClones, 0, 'no whole-chat structuredClone');
    assert.ok(cost.largeTexts <= 2, `whole-chat texts built: ${cost.largeTexts}`);
    assert.ok(cost.largeBuffers <= 12, `whole-chat buffers built: ${cost.largeBuffers}`);
    assert.ok(cost.parsedChats <= 7.045, `chats parsed: ${cost.parsedChats}`);
    assert.ok(cost.stringifiedChats <= 3.711, `chats serialised: ${cost.stringifiedChats}`);
});

test('a save that changes nothing does no more whole-chat work than one that appends a message', t => {
    const changed = measureSave(t, 'changed', first => [...first, message(MESSAGES + 1)]);
    const unchanged = measureSave(t, 'unchanged', first => structuredClone(first));
    assert.equal(unchanged.largeClones, 0);
    assert.ok(unchanged.largeTexts <= 2, `whole-chat texts built: ${unchanged.largeTexts}`);
    assert.ok(unchanged.largeBuffers <= changed.largeBuffers, `whole-chat buffers built: ${unchanged.largeBuffers} vs ${changed.largeBuffers}`);
    assert.ok(unchanged.parsedChats <= 7.03, `chats parsed: ${unchanged.parsedChats}`);
    assert.ok(unchanged.stringifiedChats <= 2.695, `chats serialised: ${unchanged.stringifiedChats}`);
    for (const meter of ['largeTexts', 'largeClones', 'largeBuffers', 'parsedChars', 'stringifiedChars']) {
        assert.ok(unchanged[meter] <= changed[meter], `${meter}: ${unchanged[meter]} for a save that changes nothing, ${changed[meter]} for an append`);
    }
});

test('loading a saved chat reads it once and builds no whole-chat text', t => {
    const { f } = savedChat(t);
    readRoleplayChat(f.scope, f.locator);
    let loaded;
    const cost = measure(() => { loaded = readRoleplayChat(f.scope, f.locator); });
    if (process.env.CHAT_COST_REPORT) console.log('load', JSON.stringify(cost));
    assert.equal(loaded.records.length, MESSAGES + 2);
    assert.equal(cost.largeClones, 0);
    assert.equal(cost.largeTexts, 0, 'a load reads rows one at a time');
    assert.ok(cost.largeBuffers <= 2, `whole-chat buffers built: ${cost.largeBuffers}`);
    assert.ok(cost.parsedChats <= 1.006, `chats parsed: ${cost.parsedChats}`);
    assert.ok(cost.stringifiedChars <= 400, `characters serialised: ${cost.stringifiedChars}`);
});

// A patch continues the saved version of the file it names: the source is a storage source, as a browser save has.
function patchSaves(t) {
    clearChatPatchIndexes();
    const { f, first } = savedChat(t);
    const { accountId, dataEpoch, instanceId, revision, rawHash, locator } = f.source();
    let source = { kind: 'storage', accountId, dataEpoch, instanceId, revision, rawHash, locator, dependencies: [] };
    let records = first;
    const save = (operationKey, change) => {
        records = change(records);
        const input = { operationKey, mode: 'update', sourceKind: 'storage', source, patch: patchFor(savedMessageLines(f.filename), records), backup: { deferBackup: false } };
        let result;
        const cost = measure(() => { result = commitSingleChatWrite(f.scope, input, roleplayBrowserHost); });
        source = { ...source, revision: result.revision, rawHash: result.rawHash };
        if (process.env.CHAT_COST_REPORT) console.log(operationKey, JSON.stringify(cost));
        return cost;
    };
    return { save, f };
}

test('a patch of a large chat parses it once, to know its lines, and then does no whole-chat work', t => {
    const { save } = patchSaves(t);
    const cold = save('cold patch', records => [...records, message(MESSAGES + 1)]);
    const warm = save('warm patch', records => [...records, message(MESSAGES + 2)]);
    const edited = save('edit in the middle', records => records.map((record, index) => index === 100 ? { ...record, mes: 'Edited in the middle' } : record));
    const unchanged = save('no change', records => structuredClone(records));
    for (const [label, cost] of Object.entries({ cold, warm, edited, unchanged })) {
        assert.equal(cost.largeClones, 0, `${label}: no whole-chat structuredClone`);
        assert.equal(cost.largeTexts, 0, `${label}: no whole-chat text`);
    }
    // Whole-file buffers are the protected write's own reads and writes of the file, its staged copy and its new bytes (a Buffer.concat
    // counts twice, as the buffer and as its allocation): a full save of the same chat builds 12, a patch no more than 10, and 8 when it changes nothing.
    for (const [label, cost] of Object.entries({ cold, warm, edited })) assert.ok(cost.largeBuffers <= 10, `${label}: whole-chat buffers built: ${cost.largeBuffers}`);
    assert.ok(unchanged.largeBuffers <= 8, `unchanged: whole-chat buffers built: ${unchanged.largeBuffers}`);
    // The first patch of a file version reads each line once, for its index; later ones read only what the patch carries and
    // the account ledger. Limits are what was measured, rounded up to the third decimal, as above.
    assert.ok(cold.parsedChats <= 1.03, `cold: chats parsed ${cold.parsedChats}`);
    assert.ok(cold.stringifiedChats <= 0.85, `cold: chats serialised ${cold.stringifiedChats}`);
    const limits = { warm: [0.025, 0.08], edited: [0.032, 0.098], unchanged: [0.01, 0.097] };
    for (const [label, cost] of Object.entries({ warm, edited, unchanged })) {
        assert.ok(cost.parsedChats <= limits[label][0], `${label}: chats parsed ${cost.parsedChats}`);
        assert.ok(cost.stringifiedChats <= limits[label][1], `${label}: chats serialised ${cost.stringifiedChats}`);
    }
});

test('the measurement sees whole-chat work', () => {
    const cost = measure(() => {
        JSON.parse(JSON.stringify(chat));
        structuredClone(chat);
        Buffer.from(chatText).toString('utf8');
    });
    assert.equal(cost.largeClones, 1);
    assert.equal(cost.largeTexts, 3);
    assert.equal(cost.largeBuffers, 1);
    assert.ok(cost.stringifiedChats > 0.9 && cost.parsedChats > 0.9);
});
