/* eslint playwright/expect-expect: off -- Uses node:assert against real disposable storage. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fixture, writeJournal } from './roleplay-transactions-fixture.js';
import { captureRoleplaySource, captureRoleplayStorageSource, readRoleplayEntity } from '../src/generation/roleplay-source.js';
import { admitRoleplayJob, applyRoleplayJobEffect } from '../src/roleplay-jobs.js';
import { bootstrapRoleplayAccount, commitSingleChatWrite } from '../src/roleplay-lifecycle.js';
import { inspectTransferredRoleplay, reconnectRelocatedRoleplay, repairTransferredRoleplay } from '../src/roleplay-transfer-recovery.js';
import { readRoleplayAccount, readRoleplayFile, roleplayHash, roleplayLease, roleplayPathKey,
    roleplayStoreDirectory, saveRoleplayAccount, withRoleplayAccount } from '../src/roleplay-store.js';
import { roleplayNativeHost } from '../src/endpoints/chats.js';

function baseOf(scope) {
    return { owner: scope.owner, directories: scope.directories };
}

function statePath(base) {
    return path.join(roleplayStoreDirectory(base), 'state.json');
}

function identityOf(base) {
    return readRoleplayFile(path.join(roleplayStoreDirectory(base), 'identity.json'), 4096).physical;
}

/** A stopped copy of the whole account folder, including the ledger and the jobs folder. */
function copyTree(t, root, directories) {
    const copiedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-roleplay-relocation-'));
    t.after(() => fs.rmSync(copiedRoot, { recursive: true, force: true }));
    fs.cpSync(root, copiedRoot, { recursive: true });
    const copiedDirectories = Object.fromEntries(Object.entries(directories)
        .map(([key, value]) => [key, copiedRoot + value.slice(root.length)]));
    return { root: copiedRoot, directories: copiedDirectories,
        base: { owner: path.basename(directories.root), directories: copiedDirectories } };
}

function copyAccount(t, f) {
    return copyTree(t, f.root, f.scope.directories);
}

function makeLegacy(scope) {
    withRoleplayAccount(scope, null, lease => {
        delete roleplayLease(lease).state.placement;
        saveRoleplayAccount(lease);
    });
}

function replaceFile(filename) {
    fs.copyFileSync(filename, filename + '.copy');
    fs.renameSync(filename + '.copy', filename);
}

function instanceId(state, kind, locator) {
    return state.paths[roleplayPathKey(state, kind, locator)].instanceId;
}

function updateState(base, change) {
    withRoleplayAccount(base, null, lease => {
        const { state } = roleplayLease(lease);
        change(state);
        saveRoleplayAccount(lease);
    });
}

function addStaleResource(state, avatar, physical, { accountId = state.accountId, status = 'deleted' } = {}) {
    const id = randomUUID();
    state.resources[id] = { accountId, dataEpoch: state.dataEpoch, kind: 'character', locator: { avatar }, status,
        revision: 1, head: { rawHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), physical, writeId: null },
        busySubmission: null };
    return id;
}

for (const group of [false, true]) test(`a stopped ${group ? 'group' : 'solo'} account copy reconnects exact sources`, t => {
    const f = fixture(t, group);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const before = captureRoleplayStorageSource(f.scope, f.locator);
    const original = readRoleplayAccount(f.scope);
    const chatId = instanceId(original, 'chat', f.locator);
    const cardId = instanceId(original, 'character', { avatar: 'Nova.png' });
    const chatHead = structuredClone(original.resources[chatId].head);
    const cardHead = structuredClone(original.resources[cardId].head);
    const copy = copyAccount(t, f);
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    assert.equal(scope.accountId, f.scope.accountId);
    assert.equal(scope.dataEpoch, f.scope.dataEpoch);
    const after = captureRoleplayStorageSource(scope, f.locator);
    assert.equal(after.instanceId, before.instanceId);
    assert.equal(after.revision, before.revision);
    assert.equal(after.rawHash, before.rawHash);
    const state = readRoleplayAccount(scope);
    assert.equal(state.revision, original.revision + 1);
    assert.equal(state.resources[chatId].revision, original.resources[chatId].revision);
    assert.equal(state.resources[chatId].head.writeId, chatHead.writeId);
    assert.equal(state.resources[cardId].head.contentHash, cardHead.contentHash);
    assert.deepEqual(state.resources[chatId].head.physical, readRoleplayFile(f.filename.replace(f.root, copy.root)).physical);
    assert.deepEqual(state.resources[cardId].head.physical,
        readRoleplayFile(path.join(copy.directories.characters, 'Nova.png')).physical);
    assert.notDeepEqual(state.resources[chatId].head.physical, chatHead.physical);
    assert.deepEqual(state.placement, identityOf(copy.base));
    readRoleplayEntity(scope, 'character', 'Nova.png');
    const ledger = fs.readFileSync(statePath(copy.base));
    assert.equal(reconnectRelocatedRoleplay(copy.base).status, 'in-place');
    assert.deepEqual(fs.readFileSync(statePath(copy.base)), ledger, 'a matching placement writes nothing');
    assert.deepEqual(readRoleplayAccount(f.scope).resources[chatId].head, chatHead, 'the original keeps its head');
    assert.equal(captureRoleplayStorageSource(f.scope, f.locator).revision, before.revision);
    assert.deepEqual(fs.readFileSync(f.filename), fs.readFileSync(f.filename.replace(f.root, copy.root)));
});

test('a reconnected copy saves and survives a second move', t => {
    const f = fixture(t);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    const copy = copyAccount(t, f);
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    const current = captureRoleplayStorageSource(scope, f.locator);
    commitSingleChatWrite(scope, { operationKey: 'after-move', sourceKind: 'storage', source: current, mode: 'update',
        records: [...f.records, { name: 'Nova', is_user: false, mes: 'Moved save' }] }, roleplayNativeHost);
    assert.equal(captureRoleplayStorageSource(scope, f.locator).revision, current.revision + 1);
    assert.match(fs.readFileSync(f.filename.replace(f.root, copy.root), 'utf8'), /Moved save/);
    const second = copyTree(t, copy.root, copy.directories);
    const again = bootstrapRoleplayAccount(second.base, roleplayNativeHost);
    assert.equal(captureRoleplayStorageSource(again, f.locator).revision, current.revision + 1);
    assert.match(fs.readFileSync(f.filename.replace(f.root, second.root), 'utf8'), /Moved save/);
});

test('a byte-identical same-path replacement stays refused when the placement did not move', t => {
    const f = fixture(t);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const before = readRoleplayAccount(f.scope);
    const chatId = instanceId(before, 'chat', f.locator);
    const head = structuredClone(before.resources[chatId].head);
    const placement = structuredClone(before.placement);
    replaceFile(f.filename);
    const ledger = fs.readFileSync(statePath(baseOf(f.scope)));
    assert.equal(reconnectRelocatedRoleplay(baseOf(f.scope)).status, 'in-place');
    assert.deepEqual(fs.readFileSync(statePath(baseOf(f.scope))), ledger);
    assert.throws(() => captureRoleplayStorageSource(f.scope, f.locator), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    const after = readRoleplayAccount(f.scope);
    assert.deepEqual(after.resources[chatId].head, head);
    assert.deepEqual(after.placement, placement);
});

test('a changed chat stays refused while an unchanged card reconnects', t => {
    const f = fixture(t);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const original = readRoleplayAccount(f.scope);
    const chatId = instanceId(original, 'chat', f.locator);
    const cardId = instanceId(original, 'character', { avatar: 'Nova.png' });
    const chatHead = structuredClone(original.resources[chatId].head);
    const copy = copyAccount(t, f);
    fs.appendFileSync(f.filename.replace(f.root, copy.root), '\n' + JSON.stringify({ name: 'User', is_user: true, mes: 'Changed copy' }));
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    assert.throws(() => captureRoleplayStorageSource(scope, f.locator), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    const state = readRoleplayAccount(scope);
    assert.deepEqual(state.resources[chatId].head, chatHead);
    assert.deepEqual(state.resources[cardId].head.physical,
        readRoleplayFile(path.join(copy.directories.characters, 'Nova.png')).physical);
    assert.deepEqual(state.placement, identityOf(copy.base));
    readRoleplayEntity(scope, 'character', 'Nova.png');
});

test('an unfinished transaction blocks relocation without changing the ledger', t => {
    const f = fixture(t);
    const host = { ...roleplayNativeHost, publish() { throw Object.assign(new Error('interrupted publication'), { code: 'EIO' }); } };
    assert.throws(() => commitSingleChatWrite(f.scope, f.input(), host), error => error.roleplayWritePending === true);
    assert.equal(readRoleplayAccount(f.scope).pending.kind, 'chat-write');
    const copy = copyAccount(t, f);
    const ledger = fs.readFileSync(statePath(copy.base));
    const result = reconnectRelocatedRoleplay(copy.base);
    assert.equal(result.status, 'pending');
    assert.deepEqual(fs.readFileSync(statePath(copy.base)), ledger);
    const state = readRoleplayAccount({ ...f.scope, directories: copy.directories });
    assert.equal(state.pending.kind, 'chat-write');
    assert.equal(state.placement, undefined, 'an unfinished transaction also leaves legacy placement unseeded');
});

test('a reconciled pending create is followed by relocation in the same startup', t => {
    const f = fixture(t);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const destination = { group: false, chat: 'Fresh', avatar: 'Nova.png' };
    const failingHost = { ...roleplayNativeHost, publish() { throw Object.assign(new Error('interrupted publication'), { code: 'EIO' }); } };
    assert.throws(() => commitSingleChatWrite(f.scope, { operationKey: 'pending-create', mode: 'create', sourceKind: 'storage',
        destination, expectedVacancy: 0, records: f.records, backup: { deferBackup: true } }, failingHost),
    error => error.roleplayWritePending === true);
    assert.equal(readRoleplayAccount(f.scope).pending.mode, 'create');
    const copy = copyAccount(t, f);
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    const state = readRoleplayAccount(scope);
    assert.equal(state.pending, null);
    assert.deepEqual(state.placement, identityOf(copy.base));
    readRoleplayEntity(scope, 'character', 'Nova.png');
    const fresh = captureRoleplayStorageSource(scope, destination);
    assert.equal(fresh.revision, 1);
    assert.match(fs.readFileSync(path.join(copy.directories.chats, 'Nova', 'Fresh.jsonl'), 'utf8'), /Answer/);
    assert.equal(readRoleplayAccount(f.scope).pending.mode, 'create', 'the original copy keeps its unfinished record');
});

test('a reply accepted before the copy can publish on the copied account', t => {
    const f = fixture(t);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const job = admitRoleplayJob(f.scope, account, { operationKey: 'late-reply', effect: 'append',
        source: captureRoleplaySource(f.scope, { locator: f.locator }), request: { prompt: 'Hello' } });
    const copy = copyAccount(t, f);
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    const effect = { operationKey: 'late-reply', jobId: job.jobId, output: { message: { name: 'Nova', is_user: false, mes: 'Late result' } } };
    const result = applyRoleplayJobEffect(scope, account, effect, roleplayNativeHost);
    assert.ok(result);
    const copiedChat = f.filename.replace(f.root, copy.root);
    assert.match(fs.readFileSync(copiedChat, 'utf8'), /Late result/);
    assert.deepEqual(applyRoleplayJobEffect(scope, account, effect, roleplayNativeHost), result);
    assert.doesNotMatch(fs.readFileSync(f.filename, 'utf8'), /Late result/);
});

test('a journal-backed chat stays refused while the rest of the copy reconnects', t => {
    const f = fixture(t);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const original = readRoleplayAccount(f.scope);
    const chatId = instanceId(original, 'chat', f.locator);
    const journal = writeJournal(f);
    const copy = copyAccount(t, f);
    const result = reconnectRelocatedRoleplay(copy.base);
    assert.equal(result.rebound, 1);
    assert.equal(result.retained, 1);
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    assert.throws(() => captureRoleplayStorageSource(scope, f.locator), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    readRoleplayEntity(scope, 'character', 'Nova.png');
    assert.deepEqual(readRoleplayAccount(scope).resources[chatId].head, original.resources[chatId].head);
    assert.equal(fs.existsSync(journal.filename.replace(f.root, copy.root)), true);
});

test('a hard-linked copy resource is refused and keeps its recorded identity', t => {
    const f = fixture(t);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const original = readRoleplayAccount(f.scope);
    const chatId = instanceId(original, 'chat', f.locator);
    const copy = copyAccount(t, f);
    const copiedChat = f.filename.replace(f.root, copy.root);
    fs.linkSync(copiedChat, copiedChat + '.alias');
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    const state = readRoleplayAccount(scope);
    assert.deepEqual(state.resources[chatId].head, original.resources[chatId].head);
    assert.deepEqual(state.placement, identityOf(copy.base));
    assert.throws(() => captureRoleplayStorageSource(scope, f.locator), { code: 'ROLEPLAY_STORE_DAMAGED' });
    readRoleplayEntity(scope, 'character', 'Nova.png');
});

test('a stale head on another moving candidate does not count as a collision', t => {
    const f = fixture(t);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const copy = copyAccount(t, f);
    const copiedChat = f.filename.replace(f.root, copy.root);
    const chatPhysical = readRoleplayFile(copiedChat).physical;
    updateState(copy.base, state => {
        state.resources[instanceId(state, 'character', { avatar: 'Nova.png' })].head.physical = chatPhysical;
    });
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    const state = readRoleplayAccount(scope);
    const cardId = instanceId(state, 'character', { avatar: 'Nova.png' });
    assert.deepEqual(state.resources[cardId].head.physical,
        readRoleplayFile(path.join(copy.directories.characters, 'Nova.png')).physical);
    assert.deepEqual(state.placement, identityOf(copy.base));
    captureRoleplayStorageSource(scope, f.locator);
    readRoleplayEntity(scope, 'character', 'Nova.png');
});

test('deleted and retired records with stale identities do not block relocation or later enrolment', t => {
    const f = fixture(t);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const copy = copyAccount(t, f);
    const copiedChat = f.filename.replace(f.root, copy.root);
    const chatPhysical = readRoleplayFile(copiedChat).physical;
    let deletedId, retiredId, deletedRecord, retiredRecord;
    updateState(copy.base, state => {
        deletedId = addStaleResource(state, 'Deleted.png', chatPhysical);
        retiredId = addStaleResource(state, 'Retired.png', chatPhysical, { accountId: randomUUID() });
        deletedRecord = structuredClone(state.resources[deletedId]);
        retiredRecord = structuredClone(state.resources[retiredId]);
    });
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    const state = readRoleplayAccount(scope);
    assert.deepEqual(state.resources[deletedId], deletedRecord);
    assert.deepEqual(state.resources[retiredId], retiredRecord);
    captureRoleplayStorageSource(scope, f.locator);
    readRoleplayEntity(scope, 'character', 'Nova.png');
    // A new file that reuses the deleted record's physical identity must still enrol.
    const freshPath = path.join(copy.directories.chats, 'Nova', 'Fresh.jsonl');
    fs.writeFileSync(freshPath, f.records.map(record => JSON.stringify(record)).join('\n'));
    const freshPhysical = readRoleplayFile(freshPath).physical;
    updateState(copy.base, current => { current.resources[deletedId].head.physical = freshPhysical; });
    const fresh = captureRoleplayStorageSource(scope, { group: false, chat: 'Fresh', avatar: 'Nova.png' });
    assert.equal(fresh.revision, 1);
});

test('a live refused identity still aborts relocation without writing', t => {
    const f = fixture(t);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const copy = copyAccount(t, f);
    const copiedChat = f.filename.replace(f.root, copy.root);
    const chatPhysical = readRoleplayFile(copiedChat).physical;
    fs.unlinkSync(path.join(copy.directories.characters, 'Nova.png'));
    updateState(copy.base, state => {
        state.resources[instanceId(state, 'character', { avatar: 'Nova.png' })].head.physical = chatPhysical;
    });
    const ledger = fs.readFileSync(statePath(copy.base));
    assert.throws(() => reconnectRelocatedRoleplay(copy.base), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.deepEqual(fs.readFileSync(statePath(copy.base)), ledger);
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    assert.deepEqual(fs.readFileSync(statePath(copy.base)), ledger, 'startup keeps the refused ledger and keeps serving');
    assert.throws(() => captureRoleplayStorageSource(scope, f.locator), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('a moved folder with no readable identity stays unsealed until exact files return', t => {
    const f = fixture(t);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const copy = copyAccount(t, f);
    const copiedChat = f.filename.replace(f.root, copy.root);
    const copiedCard = path.join(copy.directories.characters, 'Nova.png');
    fs.renameSync(copiedChat, copiedChat + '.later');
    fs.renameSync(copiedCard, copiedCard + '.later');
    const ledger = fs.readFileSync(statePath(copy.base));
    const result = reconnectRelocatedRoleplay(copy.base);
    assert.equal(result.status, 'unverified');
    assert.deepEqual(fs.readFileSync(statePath(copy.base)), ledger, 'no placement is recorded without proof');
    fs.copyFileSync(copiedChat + '.later', copiedChat); fs.rmSync(copiedChat + '.later');
    fs.copyFileSync(copiedCard + '.later', copiedCard); fs.rmSync(copiedCard + '.later');
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    assert.equal(captureRoleplayStorageSource(scope, f.locator).revision, 2);
    readRoleplayEntity(scope, 'character', 'Nova.png');
    assert.deepEqual(readRoleplayAccount(scope).placement, identityOf(copy.base));
});

test('a partial copy waits only while no file proves the new placement', t => {
    const f = fixture(t);
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const copy = copyAccount(t, f);
    const copiedChat = f.filename.replace(f.root, copy.root);
    const copiedCard = path.join(copy.directories.characters, 'Nova.png');
    // The chat keeps its recorded physical identity; the card has not arrived yet. With no
    // candidate proving the move, the placement must not be sealed.
    fs.renameSync(f.filename, copiedChat);
    fs.renameSync(copiedCard, copiedCard + '.later');
    const copiedScope = { ...f.scope, directories: copy.directories };
    const placement = structuredClone(readRoleplayAccount(copiedScope).placement);
    const ledger = fs.readFileSync(statePath(copy.base));
    const result = reconnectRelocatedRoleplay(copy.base);
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(fs.readFileSync(statePath(copy.base)), ledger, 'a missing file leaves the ledger untouched');
    assert.deepEqual(readRoleplayAccount(copiedScope).placement, placement);
    assert.equal(captureRoleplayStorageSource(copiedScope, f.locator).revision, 2);
    assert.throws(() => readRoleplayEntity(copiedScope, 'character', 'Nova.png'), { code: 'ROLEPLAY_SOURCE_MISSING' });
    fs.copyFileSync(copiedCard + '.later', copiedCard); fs.rmSync(copiedCard + '.later');
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    assert.equal(captureRoleplayStorageSource(scope, f.locator).revision, 2);
    readRoleplayEntity(scope, 'character', 'Nova.png');
    assert.deepEqual(readRoleplayAccount(scope).placement, identityOf(copy.base));
});

test('a legacy ledger seeds placement only when a live identity still matches', t => {
    const f = fixture(t);
    commitSingleChatWrite(f.scope, f.input(), roleplayNativeHost);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    makeLegacy(f.scope);
    const before = readRoleplayAccount(f.scope);
    const chatId = instanceId(before, 'chat', f.locator);
    const head = structuredClone(before.resources[chatId].head);
    assert.equal(reconnectRelocatedRoleplay(baseOf(f.scope)).status, 'seeded');
    const after = readRoleplayAccount(f.scope);
    assert.deepEqual(after.placement, identityOf(baseOf(f.scope)));
    assert.deepEqual(after.resources[chatId].head, head);
    captureRoleplayStorageSource(f.scope, f.locator);
    const empty = fixture(t);
    makeLegacy(empty.scope);
    assert.equal(reconnectRelocatedRoleplay(baseOf(empty.scope)).status, 'seeded');
    assert.deepEqual(readRoleplayAccount(empty.scope).placement, identityOf(baseOf(empty.scope)));
});

test('a legacy ledger with no readable identity does not record an unproven placement', t => {
    const f = fixture(t);
    captureRoleplayStorageSource(f.scope, f.locator);
    makeLegacy(f.scope);
    fs.unlinkSync(f.filename);
    const ledger = fs.readFileSync(statePath(baseOf(f.scope)));
    assert.equal(reconnectRelocatedRoleplay(baseOf(f.scope)).status, 'unverified');
    assert.deepEqual(fs.readFileSync(statePath(baseOf(f.scope))), ledger);
    assert.equal(readRoleplayAccount(f.scope).placement, undefined);
});

test('a legacy single-resource byte-identical replacement is accepted once before seeding', t => {
    const f = fixture(t);
    captureRoleplayStorageSource(f.scope, f.locator);
    makeLegacy(f.scope);
    replaceFile(f.filename);
    assert.equal(reconnectRelocatedRoleplay(baseOf(f.scope)).status, 'moved');
    const state = readRoleplayAccount(f.scope);
    assert.deepEqual(state.placement, identityOf(baseOf(f.scope)));
    assert.deepEqual(state.resources[instanceId(state, 'chat', f.locator)].head.physical,
        readRoleplayFile(f.filename).physical);
    captureRoleplayStorageSource(f.scope, f.locator);
});

test('a copied legacy ledger reconnects all identities; a mixed legacy ledger stays refused', t => {
    const copied = fixture(t);
    commitSingleChatWrite(copied.scope, copied.input(), roleplayNativeHost);
    readRoleplayEntity(copied.scope, 'character', 'Nova.png');
    makeLegacy(copied.scope);
    const before = captureRoleplayStorageSource(copied.scope, copied.locator);
    const copy = copyAccount(t, copied);
    const scope = bootstrapRoleplayAccount(copy.base, roleplayNativeHost);
    const after = captureRoleplayStorageSource(scope, copied.locator);
    assert.equal(after.instanceId, before.instanceId);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(readRoleplayAccount(scope).placement, identityOf(copy.base));
    readRoleplayEntity(scope, 'character', 'Nova.png');

    const mixed = fixture(t);
    commitSingleChatWrite(mixed.scope, mixed.input(), roleplayNativeHost);
    readRoleplayEntity(mixed.scope, 'character', 'Nova.png');
    makeLegacy(mixed.scope);
    const mixedBefore = readRoleplayAccount(mixed.scope);
    const cardId = instanceId(mixedBefore, 'character', { avatar: 'Nova.png' });
    const cardHead = structuredClone(mixedBefore.resources[cardId].head);
    replaceFile(path.join(mixed.scope.directories.characters, 'Nova.png'));
    assert.equal(reconnectRelocatedRoleplay(baseOf(mixed.scope)).status, 'seeded');
    const mixedAfter = readRoleplayAccount(mixed.scope);
    assert.deepEqual(mixedAfter.resources[cardId].head, cardHead);
    assert.deepEqual(mixedAfter.placement, identityOf(baseOf(mixed.scope)));
    captureRoleplayStorageSource(mixed.scope, mixed.locator);
    assert.throws(() => readRoleplayEntity(mixed.scope, 'character', 'Nova.png'), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('a malformed placement damages the ledger instead of being trusted', t => {
    const f = fixture(t);
    const filename = statePath(baseOf(f.scope));
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    for (const placement of [{ dev: '1', ino: '2' }, { ...identityOf(baseOf(f.scope)), extra: '1' }]) {
        saved.state.placement = placement;
        saved.hash = roleplayHash(saved.state);
        fs.writeFileSync(filename, JSON.stringify(saved));
        assert.throws(() => readRoleplayAccount(f.scope), { code: 'ROLEPLAY_STORE_DAMAGED' });
        assert.throws(() => bootstrapRoleplayAccount(baseOf(f.scope), roleplayNativeHost), { code: 'ROLEPLAY_STORE_DAMAGED' });
    }
});

test('repair records the current placement', t => {
    const f = fixture(t);
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    captureRoleplayStorageSource(f.scope, f.locator);
    makeLegacy(f.scope);
    replaceFile(f.filename);
    assert.throws(() => captureRoleplayStorageSource(f.scope, f.locator), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    const check = inspectTransferredRoleplay(f.scope);
    const result = repairTransferredRoleplay(f.scope, check.token);
    const scope = { ...f.scope, dataEpoch: result.dataEpoch };
    assert.deepEqual(readRoleplayAccount(scope).placement, identityOf(baseOf(f.scope)));
    captureRoleplayStorageSource(scope, f.locator);
    readRoleplayEntity(scope, 'character', 'Nova.png');
});
