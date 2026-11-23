/* eslint playwright/expect-expect: off -- Uses node:assert against real disposable storage. */
/* global globalThis */
// A patch save sends only the messages between the unchanged start and end of the chat, and must leave the
// same file, hashes, ledger and backups a whole-chat save of the same final chat leaves. The intent hash is
// the one thing allowed to differ: it names the request, which is not the same request.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, memoryParent } from './roleplay-transactions-fixture.js';
import { buildChatPatchIndex, canonicalText, chatPatchIndex, clearChatPatchIndexes } from '../src/chat-patch.js';
import { parseChatJsonl } from '../src/chat-recovery.js';
import { prepareBrowserChatPatch, roleplayBrowserHost } from '../src/endpoints/chats.js';
import { roleplayParsedContentHash } from '../src/generation/roleplay-source.js';
import { canonical } from '../src/jobs/store.js';
import { canonicalMemoryPaths } from '../src/mewmory/prepared-branch.js';
import { commitSingleChatWrite, reconcileSingleChatWrite } from '../src/roleplay-lifecycle.js';
import { readRoleplayAccount, readRoleplayFile, roleplayPathKey, roleplayStoreDirectory } from '../src/roleplay-store.js';
import { patchFor, savedMessageLines } from './chat-patch-helpers.js';

let counter = 0;
const uuid = () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
};
crypto.randomUUID = uuid;
Object.defineProperty(globalThis.crypto, 'randomUUID', { value: uuid, configurable: true, writable: true });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const rows = records => records.map(record => JSON.stringify(record)).join('\n');

const message = (index, extra = {}) => ({ name: index % 2 ? 'Nova' : 'User', is_user: index % 2 === 0, mes: `Line ${index} \u2014 caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00`,
    send_date: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`, extra: {}, variables: [{ stat_data: { hp: [index, 'note'] } }], ...extra });
const swiped = index => message(index, { is_user: false, swipes: [`Line ${index}`, 'Other'], swipe_id: 0, swipe_info: [{ send_date: 'a', extra: {} }, { extra: { reasoning: 'r' } }] });
const header = { chat_metadata: { note: 'caf\u00e9', chat_id_hash: 7, variables: {} }, user_name: 'User', character_name: 'Nova' };
const chatOf = count => [structuredClone(header), ...Array.from({ length: count }, (_, index) => index % 5 === 4 ? swiped(index) : message(index))];
const edit = (records, change) => { const next = structuredClone(records); change(next); return next; };

// What the endpoint hands the lifecycle for a browser save: the saved file's identity and nothing else.
function storageSource(f) {
    const { accountId, dataEpoch, instanceId, revision, rawHash, locator } = f.source();
    return { kind: 'storage', accountId, dataEpoch, instanceId, revision, rawHash, locator, dependencies: [] };
}

function backupsOf(f) {
    const found = [];
    const walk = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const file = path.join(current, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile()) found.push(`${path.relative(f.scope.directories.backups, file).replace(/[0-9a-f]{64}/g, '<id>').replace(/_\d.*?\.jsonl$/, '_*.jsonl')} ${sha(fs.readFileSync(file))}`);
        }
    };
    walk(f.scope.directories.backups);
    return found.sort();
}

// Counts how many saves really went through the patch path, so a patch that quietly became a whole save cannot pass.
function countingHost() {
    const seen = { patches: 0, whole: 0, materialised: 0 };
    return { seen, host: { ...roleplayBrowserHost,
        prepare(...args) { seen.whole++; return roleplayBrowserHost.prepare(...args); },
        preparePatch(...args) {
            seen.patches++;
            const prepared = roleplayBrowserHost.preparePatch(...args);
            const materialize = prepared.patch.materializeMessages;
            prepared.patch.materializeMessages = () => { seen.materialised++; return materialize(); };
            return prepared;
        } } };
}

function run(t, { fix, start = chatOf(30), steps, patch, deferBackup = true, allowShrink = true, group = false, host = roleplayBrowserHost }) {
    const f = fix ?? fixture(t, group);
    if (start) fs.writeFileSync(f.filename, rows(start));
    let result;
    for (const [step, records] of steps.entries()) {
        const input = { operationKey: `update-${step}`, mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup }, allowShrink };
        if (patch) input.patch = patchFor(savedMessageLines(f.filename), records);
        else input.records = records;
        result = commitSingleChatWrite(f.scope, input, host);
    }
    return { f, result };
}

function observe(t, steps, options = {}) {
    counter = 0;
    clearChatPatchIndexes();
    const { f, result } = run(t, { steps, ...options });
    const state = readRoleplayAccount(f.scope);
    const resource = state.resources[state.paths[roleplayPathKey(state, 'chat', f.locator)].instanceId];
    const recovery = path.join(f.scope.directories.backups, '_chat_recovery');
    return { changed: result.changed, revision: result.revision, rawHash: result.rawHash, integrity: result.integrity, writeId: result.writeId,
        file: sha(fs.readFileSync(f.filename)), parsedContent: roleplayParsedContentHash(parseChatJsonl(fs.readFileSync(f.filename)).records),
        headRaw: resource.head.rawHash, headContent: resource.head.contentHash, headWrite: resource.head.writeId, revisionOnRecord: resource.revision,
        receipts: Object.values(state.submissions).map(({ outcome, effects }) => `${outcome?.rawHash} ${Object.values(effects).map(effect => `${effect.appliedRevision} ${JSON.stringify(effect.cleanup)}`)}`),
        backups: backupsOf(f), snapshot: fs.readdirSync(recovery).sort().map(name => sha(fs.readFileSync(path.join(recovery, name)))) };
}

const scenarios = {
    'append one message': [chatOf(30).concat(message(30))],
    'append to a chat that ends with a swiped message': [chatOf(30).concat(message(30, { mes: 'Appended' }))],
    'edit a message in the middle': [edit(chatOf(30), next => { next[14].mes = 'Edited'; })],
    'edit the first message': [edit(chatOf(30), next => { next[1].mes = 'First, edited'; })],
    'edit the last message': [edit(chatOf(30), next => { next[30].mes = 'Last, edited'; })],
    'delete one message from the middle': [edit(chatOf(30), next => { next.splice(12, 1); })],
    'delete the last message': [edit(chatOf(30), next => { next.pop(); })],
    'swipe change on the last message': [edit(chatOf(30).slice(0, 26), next => { const last = next[25]; last.swipe_id = 1; last.mes = 'Other'; last.swipe_info[1].extra = { reasoning: 'second' }; })],
    'header-only change': [edit(chatOf(30), next => { next[0].chat_metadata.note = 'changed'; })],
    'header-only change of derived metadata': [edit(chatOf(30), next => { next[0].chat_metadata.chat_id_hash = 9; delete next[0].chat_metadata.variables; })],
    'header and last message change': [edit(chatOf(30), next => { next[0].chat_metadata.scenario = 'x'; next[30].mes = 'y'; })],
    'no change': [chatOf(30)],
    'no change except stale markers': [edit(chatOf(30), next => { next[0].chat_metadata.integrity = 'stale'; next[0].chat_metadata.neconyan_roleplay = { schema: 1, instanceId: 'x', revision: 9, writeId: 'y' }; })],
    'every message changed': [chatOf(30).map((record, index) => index ? { ...record, mes: `Rewritten ${index}` } : record)],
    'messages swapped': [edit(chatOf(30), next => { [next[5], next[20]] = [next[20], next[5]]; })],
    'a message that is display-equivalent only': [edit(chatOf(30), next => { next[7].extra = { image: 'a.png' }; })],
    'a chat of one message': [[structuredClone(header), message(0, { mes: 'Only, edited' })]],
    'three appends in a row': (() => { const one = chatOf(30).concat(message(30)); const two = one.concat(message(31)); return [one, two, two.concat(message(32))]; })(),
    'an append, then the same chat again': [chatOf(30).concat(message(30)), chatOf(30).concat(message(30))],
    'a change that is undone': [edit(chatOf(30), next => { next[3].mes = 'x'; }), chatOf(30), edit(chatOf(30), next => { next[3].mes = 'x'; })],
    'shrinking with allowShrink': [chatOf(30).slice(0, 4)],
    'with the regular backup written': [chatOf(30).concat(message(30))],
};

for (const [name, steps] of Object.entries(scenarios)) {
    for (const group of [false, true]) {
        test(`a patch leaves what a whole save leaves (${group ? 'group' : 'solo'}): ${name}`, t => {
            const deferBackup = name !== 'with the regular backup written';
            const whole = observe(t, steps, { group, deferBackup });
            const counting = countingHost();
            const patched = observe(t, steps, { patch: true, group, deferBackup, host: counting.host });
            assert.deepEqual(patched, whole);
            assert.equal(patched.parsedContent, patched.headContent, 'the recorded content hash is the hash of the saved records');
            assert.equal(counting.seen.patches, steps.length, 'every step went through the patch path');
            assert.equal(counting.seen.whole, 0);
            assert.equal(counting.seen.materialised, 0, 'the messages are never rebuilt for a chat with no parent memory');
        });
    }
}

test('the patch scenarios cover saves that change the file and saves that do not', t => {
    const outcomes = Object.values(scenarios).map(steps => observe(t, steps).changed);
    assert.ok(outcomes.includes(true) && outcomes.includes(false));
});

// ---------------------------------------------------------------------------------------------
// Generated chats and edits: which saves count as no-ops, and every byte they leave, do not move.
// ---------------------------------------------------------------------------------------------
function seeded(seed) {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
}
const pick = (random, list) => list[Math.floor(random() * list.length)];

function randomRow(random, index) {
    const user = random() < 0.4;
    const row = { name: user ? 'User' : 'Nova', is_user: user, send_date: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        mes: pick(random, ['plain', 'caf\u00e9 \u2014 \u65e5\u672c', 'long '.repeat(40), '']), extra: {} };
    if (!user && random() < 0.6) {
        row.swipes = [row.mes, pick(random, ['other', row.mes])];
        row.swipe_id = pick(random, [0, 1, 7, '0']);
        if (random() < 0.6) row.swipe_info = pick(random, [[{ send_date: row.send_date, extra: {} }, {}], [{ extra: { reasoning: 'r' } }], 'x']);
    }
    if (random() < 0.25) row.extra = pick(random, [{ isSmallSys: true }, { file: { url: 'a' } }, { files: [{ url: 'a' }], file: { url: 'b' } }, { image: 'i.png' }, { image: 'i.png', media: [{ type: 'image', url: 'i.png' }] },
        { image_swipes: ['a.png', 'b.png', '', 3], media_display: 'gallery' }, { video: 'v.mp4' }, { reasoning: 'x', image: '' }, { media: [{ type: 'image', url: 'z' }], image: 'z', media_display: 'gallery' }]);
    if (random() < 0.15) row.variables = [{ stat_data: { hp: [random() < 0.5 ? 1 : 2, 'note'] } }];
    if (random() < 0.1) row.gen_started = '2026-01-01T00:00:00.000Z';
    if (random() < 0.05) row.numbers = [1e21, 1.5, 0, 123456789012345680000, 1e-7];
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
        else if (operation === 4) next[0].chat_metadata = { ...next[0].chat_metadata, variables: pick(random, [{}, { a: 1 }]), chat_id_hash: Math.floor(random() * 3) };
        else if (operation === 5 && next[at]) { delete next[at].swipes; delete next[at].swipe_info; delete next[at].swipe_id; }
        else if (operation === 6 && next[at]) next[at] = Object.fromEntries(Object.entries(next[at]).reverse());
        else if (operation === 7) next[0].chat_metadata = { ...next[0].chat_metadata, tainted: true };
        else if (operation === 8 && next[at]?.swipes) next[at].swipes = [...next[at].swipes].reverse();
        else if (operation === 9) next[0].chat_metadata = { ...next[0].chat_metadata, integrity: 'slug', neconyan_roleplay: { schema: 1, instanceId: 'x', revision: 3, writeId: 'y' } };
    }
    return next;
}

test('a patch matches a whole save over generated chats and edits, including which edits count as no change', t => {
    const random = seeded(2027);
    let changed = 0;
    let unchanged = 0;
    for (let pair = 0; pair < 24; pair++) {
        const chat = [{ chat_metadata: pick(random, [{}, { tainted: true }, { variables: {} }, { note: 'n', chat_id_hash: 3 }]), user_name: 'User', character_name: 'Nova' },
            ...Array.from({ length: 1 + Math.floor(random() * 9) }, (_, index) => randomRow(random, index))];
        const steps = [editChat(random, chat), editChat(random, chat)];
        const whole = observe(t, steps, { start: chat, allowShrink: true });
        const patched = observe(t, steps, { start: chat, patch: true, allowShrink: true });
        assert.deepEqual(patched, whole, `pair ${pair}`);
        if (whole.changed) changed++; else unchanged++;
    }
    assert.ok(changed > 5 && unchanged > 1, `${changed} changed, ${unchanged} unchanged`);
});

const marker = { schema: 1, revision: 2, instanceId: '11111111-1111-4111-8111-111111111111', writeId: '22222222-2222-4222-8222-222222222222' };

function outcome(operation) {
    try { return { value: operation() }; } catch (error) { return { error: `${error.constructor.name}: ${error.message}`, reason: error.reason }; }
}

test('preparing a patch gives the output of preparing the whole chat over many generated chats and edits', () => {
    const random = seeded(99);
    const seen = { changed: 0, unchanged: 0, refused: 0 };
    for (let pair = 0; pair < 800; pair++) {
        const chat = [{ chat_metadata: pick(random, [{}, { tainted: true }, { variables: {} }, { note: 'n', chat_id_hash: 3 }, { integrity: 'old', neconyan_roleplay: marker }]), user_name: 'User', character_name: 'Nova' },
            ...Array.from({ length: Math.floor(random() * 12) }, (_, index) => randomRow(random, index))];
        const edited = editChat(random, chat);
        const beforeBytes = Buffer.from(rows(chat));
        const lines = rows(chat).split('\n').slice(1);
        const rawHash = sha(beforeBytes);
        clearChatPatchIndexes();
        const contentHash = roleplayParsedContentHash(parseChatJsonl(beforeBytes).records);
        const whole = outcome(() => { counter = 0; const prepared = roleplayBrowserHost.prepare(edited, { beforeBytes, marker }); return { changed: prepared.changed, text: sha(prepared.serialized), integrity: prepared.integrity, content: roleplayParsedContentHash(prepared.records) }; });
        const patched = outcome(() => {
            counter = 0;
            const prepared = prepareBrowserChatPatch(patchFor(lines, edited), { beforeBytes, beforeRawHash: rawHash, beforeContentHash: contentHash, marker });
            return { changed: prepared.changed, text: sha(prepared.bytes), integrity: prepared.integrity, content: prepared.contentHash };
        });
        assert.deepEqual(patched, whole, `pair ${pair}`);
        if (whole.error) seen.refused++; else seen[whole.value.changed ? 'changed' : 'unchanged']++;
    }
    assert.ok(seen.changed > 300 && seen.unchanged > 40, JSON.stringify(seen));
});

// ---------------------------------------------------------------------------------------------
// What the server keeps for the next patch describes exactly the file it wrote.
// ---------------------------------------------------------------------------------------------
test('the remembered lines and content hash of a patched file are what a fresh read of it gives', t => {
    counter = 0;
    clearChatPatchIndexes();
    const f = fixture(t);
    fs.writeFileSync(f.filename, rows(chatOf(30)));
    let records = chatOf(30);
    const results = [];
    for (let step = 0; step < 5; step++) {
        records = step === 3 ? edit(records, next => { next[5].mes = 'edited'; next[0].chat_metadata.note = `n${step}`; }) : [...records, message(30 + step)];
        const input = { operationKey: `k${step}`, mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: true },
            patch: patchFor(savedMessageLines(f.filename), records) };
        const result = commitSingleChatWrite(f.scope, input, roleplayBrowserHost);
        results.push(result);
        const file = readRoleplayFile(f.filename);
        const kept = chatPatchIndex(file.bytes, file.rawHash);
        assert.ok(kept, 'the written file is indexed');
        // The index kept after the write is the one a cold read of the same bytes builds.
        clearChatPatchIndexes();
        const rebuilt = chatPatchIndex(file.bytes, file.rawHash);
        assert.deepEqual(Array.from(kept.fingerprints), Array.from(rebuilt.fingerprints));
        assert.deepEqual(Array.from(kept.starts), Array.from(rebuilt.starts));
        assert.deepEqual(Array.from(kept.ends), Array.from(rebuilt.ends));
        assert.deepEqual(kept.canonical.map(String), rebuilt.canonical.map(String));
        assert.equal(readRoleplayAccount(f.scope).resources[result.instanceId].head.contentHash, roleplayParsedContentHash(parseChatJsonl(file.bytes).records));
    }
    assert.deepEqual(results.map(result => result.revision), [2, 3, 4, 5, 6]);
});

test('canonicalText is the canonical text of a parsed record, and refuses what the hash handles on its legacy path', () => {
    const random = seeded(5);
    for (let index = 0; index < 400; index++) {
        const record = JSON.parse(JSON.stringify(randomRow(random, index)));
        assert.equal(canonicalText(record), canonical(record));
    }
    for (const text of ['{"a":-0}', '{"a":[1e999]}', '{"a":{"b":-0}}']) assert.equal(canonicalText(JSON.parse(text)), null, text);
    assert.equal(canonicalText({ b: 1, a: { d: [], c: 'x' }, '10': 1, '2': 2, 'caf\u00e9': 'k' }), canonical({ b: 1, a: { d: [], c: 'x' }, '10': 1, '2': 2, 'caf\u00e9': 'k' }));
});

test('an index holds about as many bytes as its chat, and a phone keeps one of them', () => {
    const bytes = Buffer.from(rows(chatOf(300)));
    const built = buildChatPatchIndex(bytes);
    assert.ok(built.size > bytes.length * 0.8 && built.size < bytes.length * 1.2, `${built.size} bytes held for a chat of ${bytes.length}`);
    const hashes = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(64));
    // An index that is held is returned as it is; one that was dropped is built again, as another object.
    const retained = phone => {
        const original = process.env.NECONYAN_ANDROID_APP;
        if (phone) process.env.NECONYAN_ANDROID_APP = '1'; else delete process.env.NECONYAN_ANDROID_APP;
        try {
            clearChatPatchIndexes();
            const first = hashes.map(hash => chatPatchIndex(bytes, hash));
            return hashes.map((hash, at) => ({ hash, at })).reverse().filter(({ hash, at }) => chatPatchIndex(bytes, hash) === first[at]).length;
        } finally {
            if (original === undefined) delete process.env.NECONYAN_ANDROID_APP; else process.env.NECONYAN_ANDROID_APP = original;
            clearChatPatchIndexes();
        }
    };
    assert.equal(retained(false), 3, 'the newest three file versions');
    assert.equal(retained(true), 1, 'only the open chat on a phone');
});

// ---------------------------------------------------------------------------------------------
// Refusals: nothing is written and the page is told to send the whole chat.
// ---------------------------------------------------------------------------------------------
function treeDigest(root) {
    const entries = [];
    const walk = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name.endsWith('.lock')) continue;
            const file = path.join(current, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile()) entries.push(`${path.relative(root, file)} ${sha(fs.readFileSync(file))}`);
        }
    };
    walk(root);
    return entries.sort();
}

function thrown(operation) {
    try { operation(); } catch (error) { return error; }
    return null;
}

function patchInput(f, records, claim = {}, extra = {}) {
    return { operationKey: 'refused', mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: false }, ...extra,
        patch: patchFor(savedMessageLines(f.filename), records, claim) };
}

// `file` edits the saved file before it is enrolled; `after` runs once it is.
function refusedWith(t, reason, makeInput, { file = () => {}, after = () => {}, thenWhole = true } = {}) {
    clearChatPatchIndexes();
    const f = fixture(t);
    fs.writeFileSync(f.filename, rows(chatOf(30)));
    file(f);
    f.source();
    after(f);
    const input = makeInput(f);
    const before = treeDigest(f.root);
    const error = thrown(() => commitSingleChatWrite(f.scope, input, roleplayBrowserHost));
    assert.equal(error?.code, 'ROLEPLAY_PATCH_BASE', error?.stack);
    assert.equal(error.reason, reason);
    assert.equal(error.status, 409);
    assert.deepEqual(treeDigest(f.root), before, 'a refused patch changes nothing');
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    if (!thenWhole) return;
    // The same page then sends the whole chat, and that save works.
    const whole = commitSingleChatWrite(f.scope, { operationKey: 'whole', mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: true }, records: savedRecords(f).concat(message(30)) }, roleplayBrowserHost);
    assert.equal(whole.changed, true);
}

const savedRecords = f => fs.readFileSync(f.filename, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

const appended = chatOf(30).concat(message(30));
const refusals = {
    'a source that is an older revision': ['source', f => {
        const input = patchInput(f, appended);
        input.source = { ...input.source, revision: input.source.revision - 1 };
        return input;
    }, { after: f => { commitSingleChatWrite(f.scope, { operationKey: 'earlier', mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: true }, records: edit(chatOf(30), next => { next[1].mes = 'earlier'; }) }, roleplayBrowserHost); } }],
    'a source with the wrong raw hash': ['source', f => { const input = patchInput(f, appended); input.source = { ...input.source, rawHash: 'f'.repeat(64) }; return input; }],
    'a source that is not a storage source': ['source', f => { const input = patchInput(f, appended); input.sourceKind = undefined; input.source = f.source(); return input; }],
    'a source of another chat instance': ['source', f => { const input = patchInput(f, appended); input.source = { ...input.source, instanceId: crypto.randomUUID() }; return input; }],
    'a chat that was never enrolled': ['untracked', f => {
        fs.writeFileSync(path.join(path.dirname(f.filename), 'Other.jsonl'), rows(chatOf(30)));
        const input = patchInput(f, appended);
        input.source = { ...input.source, locator: { ...input.source.locator, chat: 'Other' } };
        return input;
    }],
    'kept messages the file does not hold': ['kept', f => patchInput(f, appended, { kept: 'f'.repeat(32) })],
    'a kept digest that is not a digest': ['shape', f => patchInput(f, appended, { kept: 'x' })],
    'a base count that does not match the file': ['count', f => patchInput(f, appended, { baseCount: 31 })],
    'a message count that does not match its messages': ['shape', f => patchInput(f, appended, { count: 40 })],
    'a prefix and suffix that overlap': ['shape', f => patchInput(f, appended, { prefix: 20, suffix: 20 })],
    'a negative prefix': ['shape', f => patchInput(f, appended, { prefix: -1 })],
    'a patch with an extra field': ['shape', f => patchInput(f, appended, { extra: true })],
    'a force flag': ['forced', f => patchInput(f, appended, {}, { force: true })],
    'a file with a blank line in it': ['format', f => patchInput(f, appended), { file: f => {
        const lines = rows(chatOf(30)).split('\n');
        lines.splice(5, 0, '');
        fs.writeFileSync(f.filename, lines.join('\n'));
    } }],
    'a file edited after it was enrolled': ['head', f => {
        const input = patchInput(f, appended);
        fs.writeFileSync(f.filename, rows(edit(chatOf(30), next => { next[2].mes = 'changed outside'; })));
        return input;
    }, { thenWhole: false }],
};
for (const [name, [reason, makeInput, options]] of Object.entries(refusals)) {
    test(`a patch is refused and nothing changes: ${name}`, t => {
        refusedWith(t, reason, makeInput, options);
    });
}

test('a file that does not look like a chat this server wrote is saved the whole way', t => {
    for (const [label, bytes] of [
        ['carriage returns', Buffer.from(rows(chatOf(30)).replace(/\n/g, '\r\n'))],
        ['a trailing newline', Buffer.from(rows(chatOf(30)) + '\n')],
        ['a byte order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(rows(chatOf(30)))])],
        ['spaced JSON', Buffer.from(chatOf(30).map(record => JSON.stringify(record).replace(/","/g, '", "')).join('\n'))],
    ]) {
        clearChatPatchIndexes();
        const f = fixture(t);
        fs.writeFileSync(f.filename, bytes);
        // What the page holds is the messages as the server sent them, which is JSON text without the file's layout.
        const base = bytes.toString('utf8').replace(/^\uFEFF/, '').split('\n').slice(1).filter(line => line.trim()).map(line => JSON.stringify(JSON.parse(line)));
        const before = treeDigest(f.root);
        const input = { operationKey: label, mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: true }, patch: patchFor(base, appended) };
        const enrolled = treeDigest(f.root);
        assert.notDeepEqual(enrolled, before, 'the file was enrolled by capturing its source');
        const error = thrown(() => commitSingleChatWrite(f.scope, input, roleplayBrowserHost));
        assert.equal(error?.code, 'ROLEPLAY_PATCH_BASE', `${label}: ${error?.stack}`);
        assert.deepEqual(treeDigest(f.root), enrolled, label);
        // The whole chat is saved, which writes the chat in its own layout, and patches work from then on.
        commitSingleChatWrite(f.scope, { operationKey: `${label} whole`, mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: true }, records: appended }, roleplayBrowserHost);
        const next = appended.concat(message(31));
        assert.equal(commitSingleChatWrite(f.scope, { operationKey: `${label} patch`, mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: true },
            patch: patchFor(savedMessageLines(f.filename), next) }, roleplayBrowserHost).changed, true, label);
    }
});

test('a destructive patch is refused as a whole save is, and allowed by allowShrink', t => {
    for (const [label, final] of [['emptied', [structuredClone(header)]], ['halved', chatOf(30).slice(0, 10)], ['one message left of thirty', chatOf(30).slice(0, 2)]]) {
        const whole = thrown(() => run(t, { steps: [final], allowShrink: false }));
        const patched = thrown(() => run(t, { steps: [final], patch: true, allowShrink: false }));
        assert.ok(whole, `${label}: a whole save is refused`);
        assert.equal(patched?.constructor.name, whole.constructor.name, label);
        assert.equal(patched.reason, whole.reason, label);
        assert.equal(patched.message, whole.message, label);
        assert.equal(patched.reason, label === 'emptied' ? 'emptied' : 'shrink');
        // Not destructive when most of the chat stays.
        assert.equal(thrown(() => run(t, { steps: [chatOf(30).slice(0, 20)], patch: true, allowShrink: false })), null);
        assert.equal(observe(t, [final], { patch: true, allowShrink: true }).file, observe(t, [final], { allowShrink: true }).file);
    }
});

test('a patch with a destructive save leaves the saved chat and its backups as they were', t => {
    clearChatPatchIndexes();
    const f = fixture(t);
    fs.writeFileSync(f.filename, rows(chatOf(30)));
    f.source();
    const before = treeDigest(f.root);
    const error = thrown(() => commitSingleChatWrite(f.scope, patchInput(f, [structuredClone(header)], {}, { allowShrink: false }), roleplayBrowserHost));
    assert.equal(error?.reason, 'emptied');
    assert.deepEqual(treeDigest(f.root), before);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

const invalidMessages = {
    'undefined member': records => { records[1].extra = { k: undefined }; },
    NaN: records => { records[1].score = NaN; },
    Infinity: records => { records[1].score = Infinity; },
    'negative zero': records => { records[1].score = -0; },
    Date: records => { records[1].when = new Date(0); },
    'array hole': records => { records[1].swipes = (() => { const items = ['a', 'x', 'b']; delete items[1]; return items; })(); },
    'function member': records => { records[1].fn = () => 1; },
    'class instance': records => { records[1].box = new (class Box { constructor() { this.a = 1; } })(); },
    BigInt: records => { records[1].big = 10n; },
    'symbol key': records => { records[1][Symbol('k')] = 1; },
    'non-object message': records => { records[1] = 'text'; },
    'null message': records => { records[1] = null; },
    'array message': records => { records[1] = []; },
    'header without metadata': records => { records[0] = { user_name: 'U' }; },
    'header that is not an object': records => { records[0] = 'x'; },
};
test('records that are not plain JSON are refused as a whole save refuses them', t => {
    const final = edit(chatOf(30), next => { next[30].mes = 'changed so that something is sent'; });
    for (const [label, damage] of Object.entries(invalidMessages)) {
        clearChatPatchIndexes();
        const wholeFixture = fixture(t);
        fs.writeFileSync(wholeFixture.filename, rows(chatOf(30)));
        const damaged = structuredClone(final);
        damage(damaged);
        const whole = thrown(() => commitSingleChatWrite(wholeFixture.scope, { operationKey: 'k', mode: 'update', sourceKind: 'storage', source: storageSource(wholeFixture), backup: { deferBackup: true }, records: damaged }, roleplayBrowserHost));
        const f = fixture(t);
        fs.writeFileSync(f.filename, rows(chatOf(30)));
        f.source();
        // The page would have sent JSON, so the damaged value is placed in the patch's own records.
        const patch = patchFor(savedMessageLines(f.filename), final);
        const records = [patch.header, ...patch.messages];
        damage(records);
        Object.assign(patch, { header: records[0], messages: records.slice(1) });
        const before = treeDigest(f.root);
        const patched = thrown(() => commitSingleChatWrite(f.scope, { operationKey: 'k', mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: true }, patch }, roleplayBrowserHost));
        assert.ok(whole && patched, `${label}: both are refused (${whole?.message} / ${patched?.message})`);
        // A header or message that is not even an object is not the shape of a patch, which is refused to be sent as the whole chat.
        if (patched.code !== 'ROLEPLAY_PATCH_BASE') {
            assert.equal(patched.constructor.name, whole.constructor.name, label);
            assert.equal(patched.message, whole.message, label);
        }
        assert.deepEqual(treeDigest(f.root), before, `${label}: nothing written`);
    }
});

// ---------------------------------------------------------------------------------------------
// Retry, conflict and the ledger.
// ---------------------------------------------------------------------------------------------
test('the same patch sent again returns the finished result and a different one with the same key is a conflict', t => {
    clearChatPatchIndexes();
    const f = fixture(t);
    fs.writeFileSync(f.filename, rows(chatOf(30)));
    const baseLines = savedMessageLines(f.filename);
    const input = { operationKey: 'retry', mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: true }, patch: patchFor(baseLines, appended) };
    const first = commitSingleChatWrite(f.scope, structuredClone(input), roleplayBrowserHost);
    const written = readRoleplayFile(f.filename);
    const state = readRoleplayAccount(f.scope);
    // The source named by the retry is now an older version of the chat; the receipt still answers it.
    const again = commitSingleChatWrite(f.scope, structuredClone(input), roleplayBrowserHost);
    assert.deepEqual(again, first);
    assert.deepEqual(readRoleplayFile(f.filename), written);
    assert.deepEqual(readRoleplayAccount(f.scope), state);
    const different = structuredClone(input);
    different.patch = patchFor(baseLines, chatOf(30).concat(message(30, { mes: 'Another message' })));
    const conflict = thrown(() => commitSingleChatWrite(f.scope, different, roleplayBrowserHost));
    assert.equal(conflict?.code, 'ROLEPLAY_INTENT_CONFLICT');
    const asWholeSave = thrown(() => commitSingleChatWrite(f.scope, { operationKey: 'retry', mode: 'update', sourceKind: 'storage', source: input.source, backup: { deferBackup: true }, records: appended }, roleplayBrowserHost));
    assert.equal(asWholeSave?.code, 'ROLEPLAY_INTENT_CONFLICT');
    assert.deepEqual(readRoleplayFile(f.filename), written);
});

// ---------------------------------------------------------------------------------------------
// A patch is replayed from its staged bytes after a crash, to the same result.
// ---------------------------------------------------------------------------------------------
const worker = fileURLToPath(new URL('./roleplay-transactions-crash-worker.js', import.meta.url));

async function killAt(f, input, boundary) {
    const specPath = path.join(f.root, 'crash-input.json');
    fs.writeFileSync(specPath, JSON.stringify({ scope: f.scope, input, boundary, filename: f.filename, browser: true }));
    const child = spawn(process.execPath, [worker, specPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let stdout = '', stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`No ${boundary} pause: ${stdout}\n${stderr}`)), 15000);
            child.stdout.on('data', chunk => {
                stdout += chunk;
                if (stdout.includes(JSON.stringify({ boundary }))) { clearTimeout(timer); resolve(); }
            });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Worker exited before kill (${code}, ${signal}): ${stdout}\n${stderr}`)); });
        });
        assert.equal(child.kill('SIGKILL'), true);
        await exited;
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
    }
    // Test-only acceleration after verified death, as in the whole-chat crash tests.
    const ageDeadLocks = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const filename = path.join(directory, entry.name);
            if (/^\.neconyan-chat-[a-f0-9]{64}\.lock$/.test(entry.name)) {
                const old = new Date(Date.now() - 600000);
                fs.utimesSync(filename, old, old);
            } else ageDeadLocks(filename);
        }
    };
    ageDeadLocks(f.root);
}

for (const boundary of ['payload-durable', 'pending-durable', 'partial-update', 'chat-durable', 'receipt-durable']) {
    test(`a patch interrupted at ${boundary} finishes as the one write it was`, { timeout: 30000 }, async t => {
        clearChatPatchIndexes();
        const f = fixture(t);
        fs.writeFileSync(f.filename, rows(chatOf(30)));
        const final = edit(chatOf(30), next => { next[10].mes = 'Edited by the page'; next.push(message(30, { mes: 'New result' })); });
        const input = { operationKey: 'crashing', mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: false },
            patch: patchFor(savedMessageLines(f.filename), final) };
        assert.ok(input.patch.prefix > 0 && input.patch.messages.length >= 1);
        await killAt(f, input, boundary);
        const interrupted = readRoleplayAccount(f.scope);
        const pending = interrupted.pending;
        if (boundary === 'payload-durable') assert.equal(pending, null);
        else if (boundary !== 'receipt-durable') assert.ok(pending);
        const result = boundary === 'payload-durable' || boundary === 'receipt-durable'
            ? commitSingleChatWrite(f.scope, input, roleplayBrowserHost)
            : reconcileSingleChatWrite(f.scope, input.operationKey, roleplayBrowserHost);
        const saved = readRoleplayFile(f.filename);
        assert.equal(saved.rawHash, result.rawHash);
        if (pending) {
            assert.equal(result.rawHash, pending.after.rawHash);
            assert.equal(result.integrity, pending.after.integrity);
        }
        const savedRecords = parseChatJsonl(saved.bytes).records;
        assert.deepEqual(savedRecords.slice(1), final.slice(1), 'the saved messages are the ones the page meant');
        assert.equal(readRoleplayAccount(f.scope).resources[result.instanceId].head.contentHash, roleplayParsedContentHash(savedRecords));
        assert.equal(readRoleplayAccount(f.scope).pending, null);
        assert.deepEqual(commitSingleChatWrite(f.scope, input, roleplayBrowserHost), result, 'sending it again returns the same result');
        assert.deepEqual(readRoleplayFile(f.filename), saved);
        // And the next patch builds on what the replay left.
        const next = final.concat(message(31));
        const after = commitSingleChatWrite(f.scope, { operationKey: 'after', mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: true },
            patch: patchFor(savedMessageLines(f.filename), next) }, roleplayBrowserHost);
        assert.equal(after.changed, true);
        assert.deepEqual(parseChatJsonl(readRoleplayFile(f.filename).bytes).records.slice(1), next.slice(1));
    });
}

// ---------------------------------------------------------------------------------------------
// Mewmory branches and recovery.
// ---------------------------------------------------------------------------------------------
test('a patched save forks parent memory exactly as a whole save does, and builds the messages only then', t => {
    const result = {};
    for (const patch of [false, true]) {
        clearChatPatchIndexes();
        counter = 0;
        const f = fixture(t);
        memoryParent(f);
        const records = edit(f.records, next => { next[0].chat_metadata.main_chat = 'Parent'; next.push({ name: 'Nova', is_user: false, mes: 'New result' }); });
        const counting = countingHost();
        const input = { operationKey: 'branch', mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: true } };
        if (patch) input.patch = patchFor(savedMessageLines(f.filename), records); else input.records = records;
        commitSingleChatWrite(f.scope, input, patch ? counting.host : roleplayBrowserHost);
        const paths = canonicalMemoryPaths(f.scope.directories, f.locator);
        assert.ok(fs.existsSync(paths.archive), 'the branch memory was captured');
        const state = JSON.parse(fs.readFileSync(paths.archive, 'utf8'));
        result[patch] = { records: state.records.length, guard: Object.keys(JSON.parse(fs.readFileSync(paths.guard, 'utf8'))).sort(), materialised: counting.seen.materialised };
    }
    assert.equal(result.true.records, result.false.records);
    assert.deepEqual(result.true.guard, result.false.guard);
    assert.equal(result.true.materialised, 1, 'the messages were built once, for the fork');
});

test('a patched save writes the recovery snapshot on every save, and checks only the lines that are new', t => {
    clearChatPatchIndexes();
    const f = fixture(t);
    fs.writeFileSync(f.filename, rows(chatOf(30)));
    let records = chatOf(30);
    for (let step = 0; step < 3; step++) {
        records = [...records, message(30 + step)];
        commitSingleChatWrite(f.scope, { operationKey: `k${step}`, mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: true },
            patch: patchFor(savedMessageLines(f.filename), records) }, roleplayBrowserHost);
        const recovery = path.join(f.scope.directories.backups, '_chat_recovery');
        const [snapshot] = fs.readdirSync(recovery).filter(name => name.endsWith('.latest.jsonl'));
        assert.deepEqual(fs.readFileSync(path.join(recovery, snapshot)), fs.readFileSync(f.filename), `step ${step}: the snapshot is the saved chat`);
    }
});

test('the kept lines of the saved file keep their bytes and the file keeps its identity', t => {
    clearChatPatchIndexes();
    const f = fixture(t);
    fs.writeFileSync(f.filename, rows(chatOf(30)));
    const before = fs.statSync(f.filename, { bigint: true });
    const lines = savedMessageLines(f.filename);
    const records = edit(chatOf(30), next => { next[14].mes = 'Edited'; next.push(message(30)); });
    commitSingleChatWrite(f.scope, { operationKey: 'k', mode: 'update', sourceKind: 'storage', source: storageSource(f), backup: { deferBackup: true },
        patch: patchFor(lines, records) }, roleplayBrowserHost);
    const after = fs.statSync(f.filename, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.nlink, 1n);
    const written = savedMessageLines(f.filename);
    assert.deepEqual(written.slice(0, 13), lines.slice(0, 13));
    assert.deepEqual(written.slice(14, 30), lines.slice(14, 30));
    assert.equal(JSON.parse(written[13]).mes, 'Edited');
    assert.equal(written.length, 31);
});

test('prepareBrowserChatPatch is refused without the saved bytes it must be built on', () => {
    const patch = patchFor(chatOf(30).slice(1).map(record => JSON.stringify(record)), appended);
    for (const options of [{}, { beforeBytes: Buffer.from(rows(chatOf(30))) }, { beforeBytes: Buffer.from(rows(chatOf(30))), beforeRawHash: 'a'.repeat(64) }]) {
        assert.equal(thrown(() => prepareBrowserChatPatch(patch, { ...options, marker: { schema: 1, revision: 2, instanceId: crypto.randomUUID(), writeId: crypto.randomUUID() } }))?.code, 'ROLEPLAY_PATCH_BASE');
    }
    assert.ok(roleplayStoreDirectory);
});
