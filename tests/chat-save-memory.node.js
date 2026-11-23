/* eslint playwright/expect-expect: off -- Uses node:assert against real disposable storage. */
/* global globalThis */
// Saving a chat must write the same bytes, hashes and ledger entries, and refuse the same input with the
// same error, as it did before its memory use was cut. GOLDEN holds what the code before that change
// produced for these exact scenarios (random ids are replaced by a counter); the reference functions below
// are the replaced implementations, kept to compare against over many inputs.
import assert from 'node:assert/strict';
import { isUtf8 } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import test from 'node:test';
import { fixture, memoryParent } from './roleplay-transactions-fixture.js';
import { chatJsonlEqualsRecords, isRecognizedChatHeader, parseChatJsonl } from '../src/chat-recovery.js';
import { mutateChat, prepareBrowserChatWrite, prepareNativeChatWrite, publishNativeChatWrite, roleplayBrowserHost } from '../src/endpoints/chats.js';
import { roleplayContentHash, roleplayParsedContentHash } from '../src/generation/roleplay-source.js';
import { commitSingleChatWrite } from '../src/roleplay-lifecycle.js';
import { canonicalMemoryPaths } from '../src/mewmory/prepared-branch.js';
import { readRoleplayAccount, readRoleplayFile, roleplayHash, roleplayPathKey } from '../src/roleplay-store.js';
import { canonical } from '../src/jobs/store.js';

let counter = 0;
const uuid = () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
};
crypto.randomUUID = uuid;
Object.defineProperty(globalThis.crypto, 'randomUUID', { value: uuid, configurable: true, writable: true });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const rows = records => records.map(record => JSON.stringify(record)).join('\n');
const marker = { schema: 1, revision: 2, instanceId: '11111111-1111-4111-8111-111111111111', writeId: '22222222-2222-4222-8222-222222222222' };

// ---------------------------------------------------------------------------------------------
// The replaced implementations.
// ---------------------------------------------------------------------------------------------

function referencePlain(value) {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function referenceParseChatJsonl(data) {
    const corrupt = (reason, details = {}) => ({ status: 'corrupt', reason, data, records: null, ...details });
    let serialized;
    try {
        serialized = new TextDecoder('utf-8', { fatal: true }).decode(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    } catch {
        return corrupt('invalid-utf8');
    }
    const records = [];
    const lines = serialized.split('\n');
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.trim() === '') continue;
        let record;
        try { record = JSON.parse(line); } catch { return corrupt('invalid-json', { line: index + 1 }); }
        if (!referencePlain(record)) return corrupt('non-object', { line: index + 1 });
        records.push(record);
    }
    if (records.length === 0) return corrupt('empty');
    if (!isRecognizedChatHeader(records[0])) return corrupt('missing-chat-metadata');
    if (!referencePlain(records[0].chat_metadata)) records[0] = { ...records[0], chat_metadata: {} };
    return { status: 'ok', data, records };
}

function referenceRoleplayHash(value) {
    const json = JSON.stringify(value);
    if (json === undefined || !isDeepStrictEqual(JSON.parse(json), value)) {
        throw Object.assign(new Error('Roleplay identity requires JSON-only values.'), { code: 'ROLEPLAY_INVALID' });
    }
    return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Reading and hashing: the same verdicts as the implementations they replaced.
// ---------------------------------------------------------------------------------------------

const header = '{"chat_metadata":{"a":1}}';
const message = '{"name":"A","mes":"caf\u00e9 \u2014 \u65e5\u672c\u8a9e \ud83d\ude00"}';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const parseCorpus = [
    ['header only', header],
    ['header and messages', [header, message, message].join('\n')],
    ['trailing newline', [header, message, ''].join('\n')],
    ['blank and whitespace lines', [header, '', '  ', message, '\t', message].join('\n')],
    ['CRLF', [header, message].join('\r\n')],
    ['legacy user_name header', '{"user_name":"U","character_name":"C"}\n' + message],
    ['legacy name header', '{"name":"Chat"}\n' + message],
    ['header with array metadata', '{"chat_metadata":[]}\n' + message],
    ['header with no metadata or names', '{"x":1}\n' + message],
    ['scalar row', [header, '17'].join('\n')],
    ['array row', [header, '[]'].join('\n')],
    ['null row', [header, 'null'].join('\n')],
    ['broken row', [header, '{', message].join('\n')],
    ['broken row then bad utf8', Buffer.concat([Buffer.from(header + '\n{\n'), Buffer.from([0xff]), Buffer.from('\n' + message)])],
    ['bad row then broken utf8 header', Buffer.concat([Buffer.from([0x7b, 0xff, 0x7d])])],
    ['bad utf8 in the last row', Buffer.concat([Buffer.from(header + '\n'), Buffer.from('{"mes":"'), Buffer.from([0xc3]), Buffer.from('"}')])],
    ['truncated sequence at the end of a row', Buffer.concat([Buffer.from(header + '\n{"mes":"x"}'), Buffer.from([0xe2, 0x82])])],
    ['BOM first', Buffer.concat([BOM, Buffer.from([header, message].join('\n'))])],
    ['BOM on the second row', Buffer.concat([Buffer.from(header + '\n'), BOM, Buffer.from(message)])],
    ['BOM and a blank first row', Buffer.concat([BOM, Buffer.from('\n' + header)])],
    ['only newlines', '\n\n'],
    ['empty', ''],
    ['only a BOM', BOM],
    ['unicode line separators inside strings', [header, '{"mes":"a\u2028b\u2029c"}'].join('\n')],
    ['lone surrogate escapes', [header, '{"mes":"\\ud800 x"}'].join('\n')],
    ['duplicate and numeric keys', ['{"chat_metadata":{},"1":1,"0":0,"a":1,"a":2}', message].join('\n')],
    ['__proto__ key', ['{"chat_metadata":{},"__proto__":{"x":1}}', message].join('\n')],
];

test('parseChatJsonl gives the verdict it gave when it decoded the whole text first', () => {
    for (const [label, input] of parseCorpus) {
        for (const shape of [input, Buffer.isBuffer(input) ? input : Buffer.from(input)]) {
            if (typeof shape === 'string' && /[\ud800-\udfff]/.test(shape) && !/^[\ud800-\udbff][\udc00-\udfff]/.test(shape)) continue;
            assert.deepEqual(parseChatJsonl(shape), referenceParseChatJsonl(shape), label);
        }
    }
});

test('parseChatJsonl gives the same verdict for rows of any size and for every cut of a short chat', () => {
    const big = [header, ...Array.from({ length: 50 }, (_, index) => JSON.stringify({ name: 'A', mes: 'x'.repeat(index * 997), index }))].join('\n');
    assert.deepEqual(parseChatJsonl(big), referenceParseChatJsonl(big));
    const whole = Buffer.from([header, message, '', '  ', message].join('\n'));
    for (let cut = 0; cut <= whole.length; cut++) {
        const piece = whole.subarray(0, cut);
        assert.deepEqual(parseChatJsonl(piece), referenceParseChatJsonl(piece), `cut ${cut}`);
    }
});

test('chatJsonlEqualsRecords is parse-then-compare', () => {
    const text = [header, message, message].join('\n');
    const records = referenceParseChatJsonl(text).records;
    const variants = [
        records, structuredClone(records), records.slice(0, 2), [...records, records[1]], [records[0], records[2], records[1]].reverse(),
        [{ chat_metadata: { a: 2 } }, records[1], records[2]], [records[0], { ...records[1], extra: 1 }, records[2]],
        Object.assign([...records], { extra: true }), (() => { const holes = [...records]; delete holes[1]; return holes; })(),
        null, 'text', [],
    ];
    for (const input of [text, Buffer.from(text), text + '\n\n', 'broken\n' + text, '', header]) {
        for (const candidate of variants) {
            const expected = (() => {
                const parsed = referenceParseChatJsonl(input);
                return parsed.status === 'ok' && isDeepStrictEqual(parsed.records, candidate);
            })();
            assert.equal(chatJsonlEqualsRecords(input, candidate), expected, `${String(input).slice(0, 20)} / ${JSON.stringify(candidate)?.slice(0, 40)}`);
        }
    }
});

function pickFrom(random, list) {
    return list[Math.floor(random() * list.length)];
}

function fuzzChatBytes(random) {
    const goodHeaders = [header, '{"user_name":"U"}', '{"name":"N"}', '{"chat_metadata":{"k":[1,2,{"z":null}]}}'];
    const badHeaders = ['{"chat_metadata":[]}', '{"x":1}', 'null', '17', '{', '', '  '];
    const goodRows = [message, message, '{"mes":"a\\u2028b"}', '{"mes":"\\ud83d\\ude00 caf\\u00e9"}', '  ', '', '\\t', '{"mes":"x","n":-0}', '{"mes":"\\u00e9"}\\r'];
    const rowsText = () => random() < 0.85 ? (random() < 0.1 ? `{"mes":"${'y'.repeat(Math.floor(random() * 5000))}"}` : pickFrom(random, goodRows)) : pickFrom(random, ['[]', '17', '"s"', 'null', '{']);
    const newline = random() < 0.2 ? '\r\n' : '\n';
    const lines = [random() < 0.7 ? pickFrom(random, goodHeaders) : pickFrom(random, badHeaders), ...Array.from({ length: Math.floor(random() * 6) }, rowsText)];
    let bytes = Buffer.from(lines.join(newline) + (random() < 0.4 ? newline : ''));
    if (random() < 0.15) bytes = Buffer.concat([BOM, bytes]);
    if (random() < 0.1) {
        const at = Math.floor(random() * bytes.length);
        bytes = Buffer.concat([bytes.subarray(0, at), BOM, bytes.subarray(at)]);
    }
    if (random() < 0.12 && bytes.length) bytes[Math.floor(random() * bytes.length)] = pickFrom(random, [0xff, 0xc3, 0x80, 0xe2, 0xa9]);
    if (random() < 0.06) bytes = Buffer.concat([bytes, Buffer.from(pickFrom(random, [[0xe2, 0x82], [0xf0, 0x9f], [0xc3]]))]);
    return bytes;
}

test('parseChatJsonl and chatJsonlEqualsRecords match the whole-text parser over thousands of generated chats', () => {
    const random = seeded(2026);
    const seen = { ok: 0, corrupt: 0, reasons: new Set() };
    for (let index = 0; index < 4000; index++) {
        const bytes = fuzzChatBytes(random);
        const expected = referenceParseChatJsonl(bytes);
        assert.deepEqual(parseChatJsonl(bytes), expected, `input ${index}: ${JSON.stringify(bytes.toString('latin1').slice(0, 80))}`);
        seen[expected.status === 'ok' ? 'ok' : 'corrupt'] += 1;
        seen.reasons.add(expected.reason);
        if (isUtf8(bytes)) assert.deepEqual(parseChatJsonl(bytes.toString('utf8')), referenceParseChatJsonl(bytes.toString('utf8')));
        const records = expected.status === 'ok' ? expected.records : [{ chat_metadata: {} }];
        const candidates = [records, structuredClone(records), records.slice(0, -1), [...records, records[0]], records.map((record, at) => at === records.length - 1 ? { ...record, extra: 1 } : record),
            records.map(record => ({ ...record, mes: 'changed' })), []];
        for (const candidate of candidates) {
            assert.equal(chatJsonlEqualsRecords(bytes, candidate), expected.status === 'ok' && isDeepStrictEqual(expected.records, candidate), `input ${index}`);
        }
    }
    assert.ok(seen.ok > 800 && seen.corrupt > 800, `${seen.ok} readable, ${seen.corrupt} corrupt`);
    for (const reason of ['invalid-utf8', 'invalid-json', 'non-object', 'empty', 'missing-chat-metadata']) assert.ok(seen.reasons.has(reason), `no ${reason} input was generated`);
});

function seeded(seed) {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
}

function randomValue(random, depth = 0) {
    const pick = random();
    if (depth > 4 || pick < 0.3) {
        const leaves = ['plain', '', 'caf\u00e9 \u2014 \ud83d\ude00', '\ud800', 'quote " and \\ and \n', 0, -1, 1.5, 1e21, 1e-7, 123456789012345680000, true, false, null,
            -0, NaN, Infinity, undefined, 10n, Symbol('s'), () => 1, new Date(0), /x/, new Map(), new Uint8Array(2)];
        return leaves[Math.floor(random() * leaves.length)];
    }
    if (pick < 0.65) return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth + 1));
    const object = {};
    for (let index = Math.floor(random() * 4); index > 0; index--) {
        object[['b', 'a', '__proto__x', '10', '2', 'caf\u00e9', 'k k'][Math.floor(random() * 7)]] = randomValue(random, depth + 1);
    }
    return object;
}

function withHole(items) {
    delete items[Math.floor(items.length / 2)];
    return items;
}

function outcome(operation) {
    try { return { value: operation() }; } catch (error) { return { error: `${error.constructor.name}: ${error.message}`, code: error.code, reason: error.reason }; }
}

test('roleplayHash gives the same hash or the same refusal as the round-trip implementation', () => {
    const random = seeded(7);
    const samples = [undefined, null, 0, 'x', [], {}, [undefined], withHole([0, 1]), { a: undefined }, { a: withHole([1, 2, 3]) }, Object.create(null), new (class Box { constructor() { this.a = 1; } })(),
        (() => { const cycle = {}; cycle.self = cycle; return cycle; })(), (() => { const shared = { x: 1 }; return [shared, shared]; })(),
        { get a() { return 1; } }, { toJSON() { return 1; } }, Object.assign([1, 2], { extra: 1 }), { [Symbol('k')]: 1 }, { __proto__: { inherited: 1 }, own: 1 }];
    // Values the round-trip implementation refuses although they look like plain JSON.
    class Sub extends Array {}
    const refused = {
        'array subclass': Sub.from([1, 2]), 'array from another realm': vm.runInNewContext('[1,2]'), 'object from another realm': vm.runInNewContext('({a:1})'),
        'hidden toJSON on an object': Object.defineProperty({ a: 1 }, 'toJSON', { value() { return { a: 2 }; } }),
        'hidden toJSON on an array': Object.defineProperty([1, 2], 'toJSON', { value() { return [9]; } }),
        'nested array subclass': { a: Sub.from([1]) }, 'nested array from another realm': { list: [vm.runInNewContext('[1]')] },
        'nested object from another realm': [vm.runInNewContext('({a:1})')],
    };
    // And two it accepts, which must keep their hash: a toJSON that is not a function, and one that returns the same data.
    const accepted = [Object.defineProperty({ a: 1 }, 'toJSON', { value: 5 }), Object.defineProperty({ a: 1 }, 'toJSON', { value() { return { a: 1 }; } })];
    for (const [label, value] of Object.entries(refused)) assert.equal(outcome(() => referenceRoleplayHash(value)).code, 'ROLEPLAY_INVALID', `the old implementation refuses ${label}`);
    for (const value of accepted) assert.equal(typeof outcome(() => referenceRoleplayHash(value)).value, 'string');
    samples.push(...Object.values(refused), ...accepted);
    for (let index = 0; index < 4000; index++) samples.push(randomValue(random));
    let hashed = 0;
    for (const sample of samples) {
        const expected = outcome(() => referenceRoleplayHash(sample));
        const actual = outcome(() => roleplayHash(sample));
        if (expected.error) {
            assert.equal(actual.code, expected.code);
            assert.equal(actual.error.split(': ')[0], expected.error.split(': ')[0]);
        } else {
            assert.deepEqual(actual, expected);
            hashed += 1;
        }
    }
    assert.ok(hashed > 500, `hashed ${hashed} samples`);
});

test('roleplayParsedContentHash keeps the hash and the refusal of the clone-and-round-trip path', () => {
    const random = seeded(11);
    for (let index = 0; index < 300; index++) {
        const records = [{ chat_metadata: { integrity: 'x', k: randomValue(random, 3) }, user_name: 'u' },
            ...Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({ name: 'A', mes: 'm', extra: randomValue(random, 2), swipes: [randomValue(random, 3)] }))];
        const expected = outcome(() => roleplayContentHash(records));
        const actual = outcome(() => roleplayParsedContentHash(records));
        if (expected.error) assert.equal(actual.code, expected.code);
        else assert.deepEqual(actual, expected);
    }
});

// ---------------------------------------------------------------------------------------------
// Saving: same bytes, same hashes, same ledger, same refusals.
// ---------------------------------------------------------------------------------------------

const initial = [
    { chat_metadata: { chat_id_hash: 7, variables: {}, note: 'caf\u00e9 \u2014 \u65e5\u672c\u8a9e' }, user_name: 'User', character_name: 'Nova' },
    { name: 'User', is_user: true, mes: 'Hello \ud83d\ude00', send_date: '2026-01-01T00:00:00.000Z', extra: {} },
    { name: 'Nova', is_user: false, mes: 'Hi \u2014 there', send_date: '2026-01-01T00:00:01.000Z', extra: {},
        swipes: ['Hi \u2014 there', 'Other'], swipe_id: 0, swipe_info: [{ send_date: '2026-01-01T00:00:01.000Z', extra: { reasoning: 'r' } }, { extra: {} }] },
];
const legacyExtra = [
    initial[0],
    { name: 'User', is_user: true, mes: 'See', send_date: '2026-01-01T00:00:00.000Z',
        extra: { file: { url: 'a.txt' }, image: 'one.png', image_swipes: ['one.png', 'two.png'], video: 'v.mp4', media: [{ type: 'image', url: 'zero.png' }] } },
    { name: 'Nova', is_user: false, mes: 'Seen', send_date: '2026-01-01T00:00:01.000Z', extra: { files: [{ url: 'b.txt' }], file: { url: 'c.txt' } } },
];
const modernExtra = structuredClone(legacyExtra);
modernExtra[1].extra = { files: [{ url: 'a.txt' }], media: [{ type: 'image', url: 'zero.png' }, { type: 'image', url: 'one.png' }, { type: 'image', url: 'two.png' }, { type: 'video', url: 'v.mp4' }], media_display: 'gallery', media_index: 1 };
modernExtra[2].extra = { files: [{ url: 'b.txt' }, { url: 'c.txt' }] };
const tainted = [{ chat_metadata: { tainted: true }, user_name: 'U' }, { name: 'N', is_user: false, mes: 'edited', extra: {}, swipes: ['original'], swipe_id: 0 }, { name: 'N', is_user: false, mes: 'two', extra: {} }];
const longChat = [initial[0], ...Array.from({ length: 12 }, (_, index) => ({ name: index % 2 ? 'Nova' : 'User', is_user: index % 2 === 0, mes: `Line ${index} \u2014 \u00e9`, extra: {} }))];

const append = (records, text = 'Appended \u2014 \u65e5\u672c\u8a9e \ud83d\ude00') => [...structuredClone(records), { name: 'Nova', is_user: false, mes: text, extra: {}, variables: [{ stat_data: { hp: [10, 'note'] } }] }];

const scenarios = {
    'append to an ASCII-and-accents chat': { start: initial, next: append(initial) },
    'edit a message in place': { start: initial, next: (() => { const next = structuredClone(initial); next[1].mes = 'Edited'; return next; })() },
    'swipe change with swipe_info': { start: initial, next: (() => { const next = structuredClone(initial); next[2].swipe_id = 1; next[2].mes = 'Other'; next[2].swipe_info[1].extra = { reasoning: 'second' }; return next; })() },
    'identical save is a no-op': { start: initial, next: structuredClone(initial) },
    'legacy extra forms saved in their modern form is a no-op': { start: legacyExtra, next: modernExtra },
    'legacy extra forms with a real change': { start: legacyExtra, next: append(modernExtra) },
    'derived metadata and stale markers only': { start: initial, next: (() => {
        const next = structuredClone(initial);
        next[0].chat_metadata = { variables: {}, note: next[0].chat_metadata.note, integrity: 'stale', neconyan_roleplay: { schema: 1, instanceId: 'x', revision: 9, writeId: 'y' } };
        return next;
    })() },
    'markers sent with a real change': { start: initial, next: (() => {
        const next = append(initial);
        next[0].chat_metadata.integrity = 'stale';
        next[0].chat_metadata.neconyan_roleplay = { schema: 1, instanceId: 'x', revision: 9, writeId: 'y' };
        return next;
    })() },
    'one-message chat': { start: initial.slice(0, 2), next: [initial[0], { ...initial[1], mes: 'Only one, edited' }] },
    'tainted chat': { start: tainted, next: append(tainted) },
    'header only': { start: [initial[0]], next: [initial[0], initial[1]] },
    'an appended save, then the same chat again': { start: initial, next: append(initial), then: [append(initial)] },
    'three appends in a row': { start: initial, next: append(initial, 'one'), then: [append(append(initial, 'one'), 'two'), append(append(append(initial, 'one'), 'two'), 'three')] },
    'a change that is undone': { start: initial, next: append(initial, 'one'), then: [initial, append(initial, 'one')] },
};

// RECORD_CHAT_SAVE_GOLDEN=<file> runs these scenarios and writes what they produce, which is how the
// golden file was made from the code before the change.
const RECORD = process.env.RECORD_CHAT_SAVE_GOLDEN;
const recorded = {};

function matchesGolden(name, observed) {
    if (RECORD) {
        recorded[name] = observed;
        fs.writeFileSync(RECORD, JSON.stringify(recorded, null, 2) + '\n');
        return;
    }
    const golden = JSON.parse(fs.readFileSync(new URL('./chat-save-memory.golden.json', import.meta.url), 'utf8'));
    assert.deepEqual(observed, golden[name]);
}

function backupFingerprints(directory) {
    const found = [];
    const walk = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const file = path.join(current, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile()) found.push(`${path.relative(directory, file).replace(/[0-9a-f]{64}/g, '<id>').replace(/_\d.*?\.jsonl$/, '_*.jsonl')} ${sha(fs.readFileSync(file))}`);
        }
    };
    walk(directory);
    return found.sort();
}

function observe(t, { start, next, then = [], create = false, deferBackup = false, host = roleplayBrowserHost, tamper = null }) {
    counter = 0;
    const f = fixture(t);
    const locator = create ? { ...f.locator, chat: 'Fresh' } : f.locator;
    if (!create) fs.writeFileSync(f.filename, rows(start));
    let result;
    for (const [step, records] of [next, ...then].entries()) {
        const input = create && step === 0
            ? { operationKey: 'create-1', mode: 'create', sourceKind: 'storage', destination: locator, expectedVacancy: 0, records, backup: { deferBackup } }
            : { operationKey: `update-${step}`, mode: 'update', source: f.source(), records, backup: { deferBackup } };
        result = commitSingleChatWrite(f.scope, input, host);
        if (step === 0) tamper?.(f.scope.directories.backups);
    }
    const state = readRoleplayAccount(f.scope);
    const head = state.resources[state.paths[roleplayPathKey(state, 'chat', locator)].instanceId].head;
    const file = path.join(path.dirname(f.filename), locator.chat + '.jsonl');
    return {
        changed: result.changed, revision: result.revision, rawHash: result.rawHash, integrity: result.integrity,
        file: sha(fs.readFileSync(file)), headRaw: head.rawHash, headContent: head.contentHash,
        receipts: Object.values(state.submissions).map(({ intentHash, outcome: saved }) => `${intentHash} ${saved?.rawHash}`),
        backups: backupFingerprints(f.scope.directories.backups),
    };
}

const shaOf = value => sha(JSON.stringify(value));

const failures = {
    'undefined member': records => { records[1].extra = { k: undefined }; },
    'NaN': records => { records[1].score = NaN; },
    'Infinity': records => { records[1].score = Infinity; },
    'negative zero': records => { records[1].score = -0; },
    'Date': records => { records[1].when = new Date(0); },
    'array hole': records => { records[1].swipes = withHole(['a', 'x', 'b']); },
    'undefined in an array': records => { records[1].swipes = ['a', undefined]; },
    'function member': records => { records[1].fn = () => 1; },
    'class instance': records => { records[1].box = new (class Box { constructor() { this.a = 1; } })(); },
    'null prototype': records => { records[1].bare = Object.assign(Object.create(null), { a: 1 }); },
    'toJSON that returns nothing': records => { records[1] = { name: 'x', toJSON() { return undefined; } }; },
    'toJSON that returns text': records => { records[1] = { name: 'x', toJSON() { return 'text'; } }; },
    'BigInt': records => { records[1].big = 10n; },
    'BigInt after a bad value': records => { records[1].score = NaN; records[2].big = 10n; },
    'hole in the records': records => { delete records[1]; },
    'extra property on the records': records => { records.extra = true; },
    'symbol key': records => { records[1][Symbol('k')] = 1; },
    'not a chat': records => { records.length = 0; },
    'header without metadata': records => { records[0] = { user_name: 'U' }; },
    'non-object record': records => { records[1] = 'text'; },
};

function refusal(operation) {
    const result = outcome(operation);
    return result.error ? `${result.error}${result.code ? ` [${result.code}]` : ''}${result.reason ? ` (${result.reason})` : ''}` : `accepted ${shaOf(result.value)}`;
}

function preparation(prepare, records, beforeBytes) {
    counter = 0;
    return refusal(() => {
        const prepared = prepare(records, { beforeBytes, marker, force: false, allowShrink: false });
        return { changed: prepared.changed, serialized: sha(prepared.serialized), integrity: prepared.integrity,
            records: shaOf(prepared.records), inputRecords: shaOf(prepared.inputRecords) };
    });
}

test('same as before: saving writes the bytes, hashes and ledger it always has', t => {
    const observed = {};
    for (const [name, scenario] of Object.entries(scenarios)) observed[name] = observe(t, scenario);
    observed['create with non-ASCII text'] = observe(t, { create: true, next: append(initial) });
    observed['edit with the regular backup written'] = observe(t, { ...scenarios['edit a message in place'], deferBackup: false });
    matchesGolden('saves', observed);
});

test('same as before: preparing refuses what it always refused, with the same error, and prepares the same output', () => {
    const bytes = Buffer.from(rows(longChat));
    const observed = {};
    for (const [name, damage] of Object.entries(failures)) {
        const records = structuredClone(initial);
        damage(records);
        for (const [hostName, prepare] of [['browser', prepareBrowserChatWrite], ['native', prepareNativeChatWrite]]) {
            observed[`${name} / ${hostName} / new chat`] = preparation(prepare, records, null);
            observed[`${name} / ${hostName} / existing chat`] = preparation(prepare, records, Buffer.from(rows(initial)));
        }
    }
    for (const [hostName, prepare] of [['browser', prepareBrowserChatWrite], ['native', prepareNativeChatWrite]]) {
        observed[`${hostName} / shrinking`] = preparation(prepare, longChat.slice(0, 3), bytes);
        observed[`${hostName} / emptied`] = preparation(prepare, [longChat[0]], bytes);
        observed[`${hostName} / appending to ${longChat.length - 1} messages`] = preparation(prepare, append(longChat), bytes);
        observed[`${hostName} / corrupt source`] = preparation(prepare, append(initial), Buffer.from('{broken'));
        observed[`${hostName} / source with a bad row`] = preparation(prepare, append(initial), Buffer.from(rows(initial) + '\n17'));
        observed[`${hostName} / source given as text`] = preparation(prepare, append(initial), rows(initial));
        observed[`${hostName} / source that is invalid UTF-8`] = preparation(prepare, append(initial), Buffer.from([0x7b, 0xff]));
        observed[`${hostName} / unchanged`] = preparation(prepare, structuredClone(initial), Buffer.from(rows(initial)));
        observed[`${hostName} / metadata only`] = preparation(prepare, structuredClone(initial).map((record, index) => index ? record : { ...record, chat_metadata: { ...record.chat_metadata, extra: 1 } }), Buffer.from(rows(initial)));
        observed[`${hostName} / no marker`] = refusal(() => prepare(append(initial), { beforeBytes: Buffer.from(rows(initial)) }));
    }
    matchesGolden('preparations', observed);
});

// The newest regular backup, by name (names start with a timestamp).
function latestRegularBackup(directory) {
    const names = fs.readdirSync(directory).filter(name => name.startsWith('chat_nova_')).sort();
    return path.join(directory, names.at(-1));
}

const withReplacementCharacter = [initial[0], { ...initial[1], mes: 'broken \ufffd here' }];

test('same as before: duplicate backups are told apart by bytes, including a BOM and invalid UTF-8 in the latest backup', t => {
    const observed = {
        'steady state': observe(t, { start: initial, next: append(initial), then: [append(initial)] }),
        'latest backup gained a BOM': observe(t, { start: initial, next: append(initial), then: [append(initial)],
            tamper: directory => { const file = latestRegularBackup(directory); fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(file)])); } }),
        'latest backup holds a byte that is not UTF-8 where the chat has a replacement character': observe(t, { start: withReplacementCharacter, next: append(withReplacementCharacter), then: [append(withReplacementCharacter)],
            tamper: directory => { const file = latestRegularBackup(directory); const bytes = fs.readFileSync(file); const at = bytes.indexOf(Buffer.from('\ufffd')); assert.ok(at > 0); fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + 3)])); } }),
        'latest backup has no newline': observe(t, { start: initial, next: append(initial), then: [append(initial)],
            tamper: directory => { fs.writeFileSync(latestRegularBackup(directory), '{"chat_metadata":{}}'); } }),
        'latest backup is empty': observe(t, { start: initial, next: append(initial), then: [append(initial)],
            tamper: directory => { fs.writeFileSync(latestRegularBackup(directory), ''); } }),
        'latest backup differs only in its integrity slug': observe(t, { start: initial, next: append(initial), then: [append(initial)],
            tamper: directory => {
                const file = latestRegularBackup(directory);
                const [first, ...rest] = fs.readFileSync(file, 'utf8').split('\n');
                const head = JSON.parse(first);
                head.chat_metadata.integrity = 'another slug';
                fs.writeFileSync(file, [JSON.stringify(head), ...rest].join('\n'));
            } }),
    };
    matchesGolden('duplicateBackups', observed);
});

test('same as before: a prepared write whose records are class instances is saved as it was', t => {
    class Row { constructor(row) { Object.assign(this, row); } }
    const host = { ...roleplayBrowserHost, prepare(records, options) {
        const prepared = roleplayBrowserHost.prepare(records, options);
        return { ...prepared, records: [prepared.records[0], ...prepared.records.slice(1).map(row => new Row(row))] };
    } };
    matchesGolden('classInstances', observe(t, { start: initial, next: append(initial), host }));
});

function observeMutation(t, start, mutate) {
    counter = 0;
    const f = fixture(t);
    fs.writeFileSync(f.filename, rows(start));
    return refusal(() => {
        const result = mutateChat({ filePath: f.filename, expectedHash: sha(fs.readFileSync(f.filename)), handle: 'fixture', cardName: 'Nova',
            backupDirectory: f.scope.directories.backups }, mutate);
        return { integrity: result.integrity, records: shaOf(result.records), file: sha(fs.readFileSync(f.filename)), backups: backupFingerprints(f.scope.directories.backups) };
    });
}

test('same as before: mutateChat saves and refuses the same changes', t => {
    const observed = {
        append: observeMutation(t, initial, records => [...records, { name: 'Nova', mes: 'added \u2014 \u65e5\u672c', is_user: false, extra: {} }]),
        'same records': observeMutation(t, initial, records => records),
        'edit in place': observeMutation(t, initial, records => { records[1].mes = 'edited'; return records; }),
        'new copy of the records': observeMutation(t, initial, records => structuredClone(records)),
        'swipes made explicit': observeMutation(t, initial, records => { delete records[2].swipe_info; return records; }),
        shrinking: observeMutation(t, longChat, records => records.slice(0, 3)),
        emptied: observeMutation(t, longChat, records => [records[0]]),
        'not a chat': observeMutation(t, initial, () => []),
        'not records': observeMutation(t, initial, () => ({})),
        NaN: observeMutation(t, initial, records => { records[1].score = NaN; return records; }),
        undefined: observeMutation(t, initial, records => { records[1].extra = { gone: undefined }; return records; }),
        'negative zero': observeMutation(t, initial, records => { records[1].score = -0; return records; }),
        Date: observeMutation(t, initial, records => { records[1].when = new Date(0); return records; }),
        BigInt: observeMutation(t, initial, records => { records[1].big = 10n; return records; }),
        'a hole': observeMutation(t, initial, records => { delete records[1]; return records; }),
        'extra property': observeMutation(t, initial, records => Object.assign(records, { extra: true })),
    };
    matchesGolden('mutations', observed);
});

function observePublish(t, existingBytes) {
    counter = 0;
    const f = fixture(t);
    fs.writeFileSync(f.filename, existingBytes);
    const current = readRoleplayFile(f.filename);
    const prepared = prepareNativeChatWrite(append(initial), { marker });
    const payloadPath = path.join(f.root, 'payload.jsonl');
    fs.writeFileSync(payloadPath, prepared.serialized);
    const outcomeText = refusal(() => {
        publishNativeChatWrite({ filePath: f.filename, before: { rawHash: current.rawHash, physical: current.physical }, payloadPath, payloadHash: sha(prepared.serialized),
            prepared, handle: 'fixture', cardName: 'Nova', backupDirectory: f.scope.directories.backups });
        return 'published';
    });
    return `${outcomeText}; file ${sha(fs.readFileSync(f.filename))}; backups ${backupFingerprints(f.scope.directories.backups).length}`;
}

test('same as before: publishing reads the existing file as strictly as it did, in slices of any size', t => {
    const validChat = Buffer.from(rows(initial));
    const longRow = Buffer.from('{"chat_metadata":{}}\n{"name":"A","is_user":true,"mes":"' + '\u2014'.repeat(500000) + '"}');
    const observed = {
        valid: observePublish(t, validChat),
        'valid with a BOM': observePublish(t, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), validChat])),
        'not UTF-8 in the middle': observePublish(t, Buffer.concat([validChat.subarray(0, 40), Buffer.from([0xff]), validChat.subarray(40)])),
        'cut inside a character at the end': observePublish(t, Buffer.concat([validChat, Buffer.from([0xe2, 0x82])])),
        'over 1 MiB with a character across the slice boundary': observePublish(t, longRow),
        'over 1 MiB, invalid after the slice boundary': observePublish(t, Buffer.concat([longRow, Buffer.from([0xff])])),
        'over 1 MiB, cut inside a character at the end': observePublish(t, Buffer.concat([longRow, Buffer.from([0xe2])])),
    };
    matchesGolden('publishes', observed);
});

// Chats and their edits, drawn from one seed: which pairs count as the same chat must not have moved.
function randomRow(random, index) {
    const user = random() < 0.4;
    const row = { name: user ? 'User' : 'Nova', is_user: user, send_date: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        mes: pickFrom(random, ['plain', 'caf\u00e9 \u2014 \u65e5\u672c', 'long '.repeat(40), '']), extra: {} };
    if (!user && random() < 0.6) {
        row.swipes = [row.mes, pickFrom(random, ['other', row.mes])];
        row.swipe_id = pickFrom(random, [0, 1, 7, '0']);
        if (random() < 0.6) row.swipe_info = pickFrom(random, [[{ send_date: row.send_date, extra: {} }, {}], [{ extra: { reasoning: 'r' } }], 'x']);
    }
    if (random() < 0.25) row.extra = pickFrom(random, [{ isSmallSys: true }, { file: { url: 'a' } }, { files: [{ url: 'a' }], file: { url: 'b' } }, { image: 'i.png' }, { image: 'i.png', media: [{ type: 'image', url: 'i.png' }] },
        { image_swipes: ['a.png', 'b.png', '', 3], media_display: 'gallery' }, { video: 'v.mp4' }, { reasoning: 'x', image: '' }, { media: [{ type: 'image', url: 'z' }], image: 'z', media_display: 'gallery' }]);
    if (random() < 0.15) row.variables = [{ stat_data: { hp: [random() < 0.5 ? 1 : 2, 'note'] } }];
    if (random() < 0.1) row.gen_started = '2026-01-01T00:00:00.000Z';
    return row;
}

function editChat(random, chat) {
    const next = structuredClone(chat);
    const edits = Math.floor(random() * 3);
    for (let edit = 0; edit < edits; edit++) {
        const at = 1 + Math.floor(random() * Math.max(1, next.length - 1));
        const operation = Math.floor(random() * 10);
        if (operation === 0 && next[at]) next[at].mes = 'edited';
        else if (operation === 1 && next[at]) next[at].extra = { ...next[at].extra, note: 1 };
        else if (operation === 2) next.push(randomRow(random, next.length));
        else if (operation === 3 && next.length > 2) next.pop();
        else if (operation === 4) next[0].chat_metadata = { ...next[0].chat_metadata, variables: pickFrom(random, [{}, { a: 1 }]), chat_id_hash: Math.floor(random() * 3) };
        else if (operation === 5 && next[at]) { delete next[at].swipes; delete next[at].swipe_info; delete next[at].swipe_id; }
        else if (operation === 6 && next[at]) next[at] = Object.fromEntries(Object.entries(next[at]).reverse());
        else if (operation === 7) next[0].chat_metadata = { ...next[0].chat_metadata, tainted: true };
        else if (operation === 8 && next[at]?.swipes) next[at].swipes = [...next[at].swipes].reverse();
        else if (operation === 9) next[0].chat_metadata = { ...next[0].chat_metadata, integrity: 'slug', neconyan_roleplay: { schema: 1, instanceId: 'x', revision: 3, writeId: 'y' } };
    }
    return next;
}

test('same as before: which edited chats count as unchanged does not move, over generated chats and edits', () => {
    const random = seeded(99);
    const results = [];
    for (let pair = 0; pair < 600; pair++) {
        const chat = [{ chat_metadata: pickFrom(random, [{}, { tainted: true }, { variables: {} }, { note: 'n', chat_id_hash: 3 }]), user_name: 'User', character_name: 'Nova' },
            ...Array.from({ length: Math.floor(random() * 5) }, (_, index) => randomRow(random, index))];
        const edited = editChat(random, chat);
        counter = 0;
        results.push(refusal(() => {
            const prepared = prepareBrowserChatWrite(edited, { beforeBytes: Buffer.from(rows(chat)), marker });
            return { changed: prepared.changed, integrity: prepared.integrity, serialized: sha(prepared.serialized), records: shaOf(prepared.records) };
        }).replace(/accepted /, '').slice(0, 12));
    }
    matchesGolden('pairs', results);
});

function deepFreeze(value) {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

test('a save, with a Mewmory parent to fork from, never changes the records it was given', t => {
    counter = 0;
    const f = fixture(t);
    memoryParent(f);
    const input = f.input();
    input.records[0].chat_metadata.main_chat = 'Parent';
    deepFreeze(input.records);
    const copy = structuredClone(input.records);
    const result = commitSingleChatWrite(f.scope, input, roleplayBrowserHost);
    assert.equal(result.changed, true);
    assert.deepEqual(input.records, copy);
    assert.ok(fs.existsSync(canonicalMemoryPaths(f.scope.directories, f.locator).archive), 'the branch memory was captured from the prepared messages');
});

test('preparing never changes the caller\'s records', () => {
    const records = append(initial);
    const copy = structuredClone(records);
    records[0].chat_metadata.integrity = 'caller';
    copy[0].chat_metadata.integrity = 'caller';
    for (const prepare of [prepareBrowserChatWrite, prepareNativeChatWrite]) {
        prepare(records, { beforeBytes: Buffer.from(rows(initial)), marker });
        prepare(records, { marker });
        assert.deepEqual(records, copy);
    }
});
