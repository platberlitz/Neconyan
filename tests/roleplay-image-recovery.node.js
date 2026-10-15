/* eslint playwright/expect-expect: off -- Real native transactions with disposable account files. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';
const { scanRoleplayImages, applyRoleplayImageRepair, discardRoleplayImageRepair, resumeRoleplayImageRepair } = await import('../src/roleplay-image-recovery.js');
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');
const { readRoleplayAccount, roleplayHash, readRoleplayFile, withRoleplayAccountLock, roleplayStoreDirectory } = await import('../src/roleplay-store.js');
const { commitSingleChatWrite } = await import('../src/roleplay-lifecycle.js');
const { repairDirectory, pinnedImageRepairReceipts, readRepairJson, writeRepairJson, assertRepairUnstarted, ensureRepairStore } = await import('../src/roleplay-image-repair-store.js');
function setup(t, group = false) {
    const f = fixture(t, group);
    f.records[1].extra.media = [{ type: 'image', url: 'data:image/png;base64,old-broken-image', title: 'Keep this stored label' }];
    fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
    const scan = scanRoleplayImages(f.scope, { locator: f.locator });
    const input = { account: { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch }, key: 'repair-first', observation: scan.observation,
        actions: [{ ...scan.issues[0], mode: 'display-only' }] };
    return { ...f, scan, input };
}
test('repair keeps a legacy image title attached to the image and its active alternative', async t => {
    const f = fixture(t);
    f.records[1].extra = { image: 'data:image/png;base64,broken', title: 'PRIVATE_IMAGE_TITLE', append_title: true };
    f.records[1].swipe_id = 0;
    f.records[1].swipes = [f.records[1].mes];
    f.records[1].swipe_info = [{ extra: structuredClone(f.records[1].extra) }];
    fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
    const scan = scanRoleplayImages(f.scope, { locator: f.locator });
    applyRoleplayImageRepair(f.scope, { account: { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch },
        key: 'legacy-title', observation: scan.observation, actions: [{ ...scan.issues[0], mode: 'display-only' }] }, roleplayNativeHost);
    const records = fs.readFileSync(f.filename, 'utf8').split('\n').map(JSON.parse);
    const { createPromptMediaContext, selectPromptMedia } = await import('../public/scripts/prompt-media-policy.js');
    for (const extra of [records[1].extra, records[1].swipe_info[0].extra]) {
        assert.equal(extra.title, 'PRIVATE_IMAGE_TITLE');
        assert.equal(extra.media[0].title, 'PRIVATE_IMAGE_TITLE');
        const projection = selectPromptMedia([{}, { ...records[1], extra }], createPromptMediaContext({}), { hash: roleplayHash });
        assert.equal(Boolean(projection.records[1].extra.append_title), false);
        assert.deepEqual(projection.captionTexts, []);
    }
});
for (const group of [false, true]) test(`${group ? 'group' : 'solo'} scan is read-only and repair preserves authored data, retries and undo`, t => {
    const f = setup(t, group);
    assert.equal(Object.keys(readRoleplayAccount(f.scope).resources).length, 0);
    const before = fs.readFileSync(f.filename);
    const result = applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost);
    const records = fs.readFileSync(f.filename, 'utf8').split('\n').map(JSON.parse);
    assert.equal(records[1].mes, f.records[1].mes);
    assert.equal(records[1].extra.file, 'attachment.txt');
    assert.equal(records[1].extra.media[0].url, f.records[1].extra.media[0].url);
    assert.equal(records[1].extra.media[0].neconyan_prompt.mode, 'display-only');
    const retry = applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost);
    assert.equal(retry.writeId, result.writeId);
    assert.equal(retry.replayed, true);
    const scan = scanRoleplayImages(f.scope, { locator: f.locator });
    const undo = applyRoleplayImageRepair(f.scope, { account: f.input.account, key: 'undo-first', observation: scan.observation, undoOf: result.id }, roleplayNativeHost);
    assert.equal(undo.revision, result.revision + 1);
    const restored = fs.readFileSync(f.filename, 'utf8').split('\n').map(JSON.parse);
    assert.deepEqual(restored.slice(1), f.records.slice(1));
    assert.deepEqual(fs.readFileSync(path.join(repairDirectory(f.scope), result.id + '.before.jsonl')), before);
});
for (const phase of ['backup-verified', 'pinned', 'native-committed', 'manifest-committed', 'unpinned']) test(`repair resumes after ${phase} without a second native revision`, t => {
    const f = setup(t);
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost, { checkpoint(value) { if (value === phase) throw new Error('simulated crash'); } }), /simulated crash/);
    const result = applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost);
    assert.equal(result.revision, 2);
    assert.equal(readRoleplayAccount(f.scope).resources[result.instanceId].revision, 2);
});
test('lost acknowledgement survives twenty later native saves with its pinned receipt', t => {
    const f = setup(t);
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost, { checkpoint(value) { if (value === 'native-committed') throw new Error('lost acknowledgement'); } }), /lost acknowledgement/);
    const state = readRoleplayAccount(f.scope);
    const first = Object.entries(state.submissions).find(([, receipt]) => receipt.state === 'closed');
    for (let index = 0; index < 20; index++) {
        const records = fs.readFileSync(f.filename, 'utf8').split('\n').map(JSON.parse);
        records[1].mes = `Later edit ${index}`;
        commitSingleChatWrite(f.scope, { operationKey: `later-${index}`, mode: 'update', source: f.source(), records }, roleplayNativeHost);
    }
    assert.ok(readRoleplayAccount(f.scope).submissions[first[0]]);
    const current = fs.readFileSync(f.filename);
    const result = applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost);
    assert.equal(result.revision, 2);
    assert.deepEqual(fs.readFileSync(f.filename), current);
});
test('damaged pin evidence retains receipts and refuses repair replay', t => {
    const f = setup(t);
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost, { checkpoint(value) { if (value === 'native-committed') throw new Error('crash'); } }), /crash/);
    fs.writeFileSync(path.join(repairDirectory(f.scope), 'pins.json'), 'corrupt');
    for (let index = 0; index < 17; index++) {
        const records = fs.readFileSync(f.filename, 'utf8').split('\n').map(JSON.parse);
        records[1].mes = `Later edit ${index}`;
        commitSingleChatWrite(f.scope, { operationKey: `edit-${index}`, mode: 'update', source: f.source(), records }, roleplayNativeHost);
    }
    assert.equal(Object.keys(readRoleplayAccount(f.scope).submissions).length, 18);
    const current = fs.readFileSync(f.filename);
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost), { code: 'ROLEPLAY_IMAGE_RECOVERY' });
    assert.deepEqual(fs.readFileSync(f.filename), current);
});
test('changed source and changed retry intent refuse without overwriting current data', t => {
    const f = setup(t);
    const result = applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost);
    const after = readRoleplayFile(f.filename).rawHash;
    assert.throws(() => applyRoleplayImageRepair(f.scope, { ...f.input, key: 'different' }, roleplayNativeHost), /chat changed/i);
    assert.throws(() => applyRoleplayImageRepair(f.scope, { ...f.input, actions: [] }, roleplayNativeHost), /different choices/i);
    assert.equal(readRoleplayFile(f.filename).rawHash, after);
    assert.equal(result.revision, 2);
    assert.equal(roleplayHash(f.input.account).length, 64);
});

test('exact embedded save creates an immutable prompt copy and leaves original display bytes intact', async t => {
    const f = fixture(t);
    f.scope.directories.userImages = path.join(f.scope.directories.root, 'user/images');
    fs.mkdirSync(f.scope.directories.userImages, { recursive: true });
    f.records[1].extra.media = [{ type: 'image', url: `data:image/png;base64,${png.toString('base64')}` }];
    fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
    const scan = scanRoleplayImages(f.scope, { locator: f.locator });
    const input = { account: { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch }, key: 'save-inline', observation: scan.observation,
        actions: [{ ...scan.issues[0], mode: 'include', saveCopy: true }] };
    const result = applyRoleplayImageRepair(f.scope, input, roleplayNativeHost);
    const records = fs.readFileSync(f.filename, 'utf8').split('\n').map(JSON.parse);
    const media = records[1].extra.media[0];
    assert.equal(media.url, f.records[1].extra.media[0].url);
    assert.ok(media.neconyan_prompt.image_url.startsWith('/user/images/neconyan-repaired/'));
    const { captureSavedRoleplayImages } = await import('../src/generation/world-info.js');
    const { createPromptMediaContext } = await import('../public/scripts/prompt-media-policy.js');
    assert.equal(captureSavedRoleplayImages(f.scope.directories, records, 'list', {}, createPromptMediaContext({}))[0].url, media.url);
    const { assertMutableImagePath, accountImagePath } = await import('../src/managed-image-files.js');
    assert.throws(() => assertMutableImagePath(f.scope.directories, accountImagePath(f.scope.directories, media.neconyan_prompt.image_url)), /shared and retained/);
    assert.equal(applyRoleplayImageRepair(f.scope, input, roleplayNativeHost).writeId, result.writeId);
});
test('a pre-existing unrelated repair-named folder is not adopted or made immutable', async t => {
    const f = fixture(t);
    f.scope.directories.userImages = path.join(f.scope.directories.root, 'user/images');
    const folder = path.join(f.scope.directories.userImages, 'neconyan-repaired');
    fs.mkdirSync(folder, { recursive: true });
    const existing = path.join(folder, 'authored.png');
    fs.writeFileSync(existing, png);
    const { publishManagedImage, decodeCompatibleImage, assertMutableImagePath } = await import('../src/managed-image-files.js');
    assert.throws(() => publishManagedImage(f.scope.directories, decodeCompatibleImage(`data:image/png;base64,${png.toString('base64')}`)), /already belongs/);
    assert.doesNotThrow(() => assertMutableImagePath(f.scope.directories, existing));
    assert.deepEqual(fs.readFileSync(existing), png);
    assert.deepEqual(fs.readdirSync(folder), ['authored.png']);
});

for (const phase of ['reserved', 'plan-staged', 'before-staged', 'candidate-staged', 'manifest-staged']) test(`unstarted ${phase} repair can be discarded without reviving on retry`, t => {
    const f = setup(t), before = fs.readFileSync(f.filename);
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost, { checkpoint(value) { if (value === phase) throw new Error('crash'); } }), /crash/);
    const id = roleplayHash([f.scope.accountId, f.scope.dataEpoch, 'image-repair', f.input.key]);
    assert.deepEqual(pinnedImageRepairReceipts(f.scope, readRoleplayAccount(f.scope)), new Set());
    assert.equal(discardRoleplayImageRepair(f.scope, { account: f.input.account, id }).discarded, true);
    assert.equal(discardRoleplayImageRepair(f.scope, { account: f.input.account, id }).replayed, true);
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost), /discarded/);
    assert.throws(() => resumeRoleplayImageRepair(f.scope, { account: f.input.account, id }, roleplayNativeHost), /discarded/);
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.equal(fs.readdirSync(repairDirectory(f.scope)).some(name => name.startsWith(id + '.')), false);
    const tombstone = readRepairJson(path.join(repairDirectory(f.scope), 'catalogue.json')).value.entries[id];
    assert.equal(tombstone.bytes, 0);
    assert.equal(tombstone.phase, 'aborted');
});
for (const phase of ['aborting', 'discarded-before.jsonl', 'discarded-candidate.jsonl', 'discarded-manifest.json', 'discarded-plan.json', 'aborted']) test(`discard resumes after ${phase}`, t => {
    const f = setup(t), before = fs.readFileSync(f.filename);
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost, { checkpoint(value) { if (value === 'manifest-staged') throw new Error('crash'); } }), /crash/);
    const id = roleplayHash([f.scope.accountId, f.scope.dataEpoch, 'image-repair', f.input.key]);
    assert.throws(() => discardRoleplayImageRepair(f.scope, { account: f.input.account, id }, { checkpoint(value) { if (value === phase) throw new Error('crash'); } }), /crash/);
    assert.equal(discardRoleplayImageRepair(f.scope, { account: f.input.account, id }).discarded, true);
    assert.deepEqual(fs.readFileSync(f.filename), before);
});
test('discard validates the whole file set and refuses unknown, corrupt or native evidence', t => {
    const f = setup(t);
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost, { checkpoint(value) { if (value === 'manifest-staged') throw new Error('crash'); } }), /crash/);
    const id = roleplayHash([f.scope.accountId, f.scope.dataEpoch, 'image-repair', f.input.key]);
    const folder = repairDirectory(f.scope), unknown = path.join(folder, id + '.unknown');
    fs.writeFileSync(unknown, 'retain');
    const names = fs.readdirSync(folder).sort();
    assert.throws(() => discardRoleplayImageRepair(f.scope, { account: f.input.account, id }), /Unexpected/);
    assert.deepEqual(fs.readdirSync(folder).sort(), names);
    fs.unlinkSync(unknown);
    const candidate = path.join(folder, id + '.candidate.jsonl');
    fs.writeFileSync(candidate, 'changed');
    assert.throws(() => discardRoleplayImageRepair(f.scope, { account: f.input.account, id }), /Changed/);
    assert.ok(fs.existsSync(path.join(folder, id + '.before.jsonl')));
});
test('prepared repair cannot be discarded even before its first publication', t => {
    const f = setup(t);
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost, { checkpoint(value) { if (value === 'backup-verified') throw new Error('crash'); } }), /crash/);
    const id = roleplayHash([f.scope.accountId, f.scope.dataEpoch, 'image-repair', f.input.key]);
    assert.throws(() => discardRoleplayImageRepair(f.scope, { account: f.input.account, id }), /may have changed/);
    assert.equal(resumeRoleplayImageRepair(f.scope, { account: f.input.account, id }, roleplayNativeHost).revision, 2);
});
test('missing or unknown staging phase remains unresolved', t => {
    const f = setup(t);
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost, { checkpoint(value) { if (value === 'reserved') throw new Error('crash'); } }), /crash/);
    const id = roleplayHash([f.scope.accountId, f.scope.dataEpoch, 'image-repair', f.input.key]);
    const filename = path.join(repairDirectory(f.scope), 'catalogue.json'), catalogue = readRepairJson(filename);
    delete catalogue.value.entries[id].phase;
    writeRepairJson(filename, catalogue.value, undefined, catalogue.file);
    assert.equal(pinnedImageRepairReceipts(f.scope, readRoleplayAccount(f.scope)), null);
    assert.throws(() => discardRoleplayImageRepair(f.scope, { account: f.input.account, id }), /needs recovery/);
});

test('a saved derivative survives choice changes and can explicitly become the new source', async t => {
    const f = fixture(t);
    f.scope.directories.userImages = path.join(f.scope.directories.root, 'user/images');
    fs.mkdirSync(f.scope.directories.userImages, { recursive: true });
    f.records[1].extra.media = [{ type: 'image', url: '/user/images/missing-original.png' }];
    fs.writeFileSync(f.filename, f.records.map(JSON.stringify).join('\n'));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    let scan = scanRoleplayImages(f.scope, { locator: f.locator });
    const data = `data:image/png;base64,${png.toString('base64')}`;
    assert.throws(() => applyRoleplayImageRepair(f.scope, { account, key: 'missing-without-adoption', observation: scan.observation,
        actions: [{ ...scan.issues[0], mode: 'include' }], materialisedImage: { identity: scan.issues[0].identity, data } }, roleplayNativeHost), /original image is missing/);
    applyRoleplayImageRepair(f.scope, { account, key: 'explicit-adoption', observation: scan.observation,
        actions: [{ ...scan.issues[0], mode: 'include', adoptCopy: true }], materialisedImage: { identity: scan.issues[0].identity, data } }, roleplayNativeHost);
    let media = JSON.parse(fs.readFileSync(f.filename, 'utf8').split('\n')[1]).extra.media[0];
    assert.match(media.url, /^\/user\/images\/neconyan-repaired\//);
    assert.equal(media.neconyan_prompt.image_url, undefined);
    scan = scanRoleplayImages(f.scope, { locator: f.locator });
    applyRoleplayImageRepair(f.scope, { account, key: 'copy-again', observation: scan.observation,
        actions: [{ ...scan.issues[0], mode: 'include' }], materialisedImage: { identity: scan.issues[0].identity, data } }, roleplayNativeHost);
    media = JSON.parse(fs.readFileSync(f.filename, 'utf8').split('\n')[1]).extra.media[0];
    const copy = media.neconyan_prompt.image_url, originalEvidence = media.neconyan_prompt.original_evidence;
    scan = scanRoleplayImages(f.scope, { locator: f.locator });
    applyRoleplayImageRepair(f.scope, { account, key: 'change-choice', observation: scan.observation,
        actions: [{ ...scan.issues[0], mode: 'display-only' }] }, roleplayNativeHost);
    media = JSON.parse(fs.readFileSync(f.filename, 'utf8').split('\n')[1]).extra.media[0];
    assert.equal(media.neconyan_prompt.image_url, copy);
    assert.deepEqual(media.neconyan_prompt.original_evidence, originalEvidence);
});
test('local replacement and explicit gallery selection bind the chosen source without fetching', t => {
    const f = setup(t);
    f.scope.directories.userImages = path.join(f.scope.directories.root, 'user/images');
    fs.mkdirSync(f.scope.directories.userImages, { recursive: true });
    fs.writeFileSync(path.join(f.scope.directories.userImages, 'replacement.png'), png);
    f.records[1].extra.media_index = 99; f.records[1].extra.media_display = 'gallery';
    fs.writeFileSync(f.filename, f.records.map(JSON.stringify).join('\n'));
    const scan = scanRoleplayImages(f.scope, { locator: f.locator });
    applyRoleplayImageRepair(f.scope, { ...f.input, observation: scan.observation,
        actions: [{ ...scan.issues[0], mode: 'include', localUrl: '/user/images/replacement.png', selectGallery: true }] }, roleplayNativeHost);
    const extra = JSON.parse(fs.readFileSync(f.filename, 'utf8').split('\n')[1]).extra;
    assert.equal(extra.media_index, 0);
    assert.equal(extra.media[0].url, '/user/images/replacement.png');
});
test('aggregate description limit refuses before staging or changing the chat', t => {
    const f = setup(t);
    f.records[1].extra.media.push({ type: 'image', url: '/user/images/second.png' });
    fs.writeFileSync(f.filename, f.records.map(JSON.stringify).join('\n'));
    const before = fs.readFileSync(f.filename), scan = scanRoleplayImages(f.scope, { locator: f.locator });
    assert.throws(() => applyRoleplayImageRepair(f.scope, { ...f.input, observation: scan.observation,
        actions: scan.issues.map(issue => ({ ...issue, mode: 'caption', caption: { source: 'custom', text: 'A'.repeat(9000) } })) }, roleplayNativeHost), /Selected descriptions exceed/);
    assert.deepEqual(fs.readFileSync(f.filename), before);
});

for (const phase of ['namespace-intent', 'namespace-directory', 'namespace-marker', 'namespace-ready']) test(`managed namespace recovers after ${phase} without adopting unrelated files`, async t => {
    const f = fixture(t), directories = f.scope.directories;
    directories.userImages = path.join(directories.root, 'user/images'); fs.mkdirSync(directories.userImages, { recursive: true });
    const { ensureManagedImageNamespace, publishManagedImage, decodeCompatibleImage, assertMutableImagePath, checkManagedImageDestination } = await import('../src/managed-image-files.js');
    assert.throws(() => ensureManagedImageNamespace(directories, { checkpoint(value) { if (value === phase) throw new Error('crash'); } }), /crash/);
    assert.throws(() => assertMutableImagePath(directories, path.join(directories.userImages, 'neconyan-repaired/a.png')), /namespace|shared/i);
    assert.doesNotThrow(() => checkManagedImageDestination(directories));
    ensureManagedImageNamespace(directories);
    assert.match(publishManagedImage(directories, decodeCompatibleImage(`data:image/png;base64,${png.toString('base64')}`)), /neconyan-repaired/);
});
test('unfinished namespace refuses unknown files and preserves its ownership intent', async t => {
    const f = fixture(t), directories = f.scope.directories;
    directories.userImages = path.join(directories.root, 'user/images'); fs.mkdirSync(directories.userImages, { recursive: true });
    const { ensureManagedImageNamespace } = await import('../src/managed-image-files.js');
    assert.throws(() => ensureManagedImageNamespace(directories, { checkpoint(value) { if (value === 'namespace-directory') throw new Error('crash'); } }), /crash/);
    const filename = path.join(directories.userImages, 'neconyan-repaired/authored.png'); fs.writeFileSync(filename, png);
    assert.throws(() => ensureManagedImageNamespace(directories), /Unexpected files/);
    assert.deepEqual(fs.readFileSync(filename), png);
    assert.equal(readRepairJson(path.join(directories.root, '.neconyan-managed-images.json')).value.creating, true);
});

for (const phase of ['image-0-staged', 'discarding-image.0.bin', 'discarded-image.0.bin']) test(`embedded image staging can be discarded after ${phase}`, t => {
    const f = setup(t);
    f.scope.directories.userImages = path.join(f.scope.directories.root, 'user/images');
    fs.mkdirSync(f.scope.directories.userImages, { recursive: true });
    f.records[1].extra.media[0].url = `data:image/png;base64,${png.toString('base64')}`;
    fs.writeFileSync(f.filename, f.records.map(JSON.stringify).join('\n'));
    const before = fs.readFileSync(f.filename), scan = scanRoleplayImages(f.scope, { locator: f.locator });
    const input = { ...f.input, observation: scan.observation, actions: [{ ...scan.issues[0], mode: 'include', saveCopy: true }] };
    assert.throws(() => applyRoleplayImageRepair(f.scope, input, roleplayNativeHost, { checkpoint(value) {
        if (value === 'image-0-staged') throw new Error('crash');
    } }), /crash/);
    const id = roleplayHash([f.scope.accountId, f.scope.dataEpoch, 'image-repair', input.key]);
    if (phase !== 'image-0-staged') assert.throws(() => discardRoleplayImageRepair(f.scope, { account: input.account, id }, {
        checkpoint(value) { if (value === phase) throw new Error('discard crash'); },
    }), /discard crash/);
    assert.equal(discardRoleplayImageRepair(f.scope, { account: input.account, id }).discarded, true);
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.deepEqual(fs.readdirSync(f.scope.directories.userImages), []);
    assert.equal(fs.readdirSync(repairDirectory(f.scope)).some(name => name.startsWith(id + '.')), false);
    assert.throws(() => applyRoleplayImageRepair(f.scope, input, roleplayNativeHost), /discarded/);
});
for (const kind of ['pin', 'other-pin', 'pending', 'submission']) test(`staging discard refuses contradictory ${kind} authority`, t => {
    const f = setup(t);
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost, { checkpoint(value) {
        if (value === 'reserved') throw new Error('crash');
    } }), /crash/);
    const id = roleplayHash([f.scope.accountId, f.scope.dataEpoch, 'image-repair', f.input.key]);
    const entry = readRepairJson(path.join(repairDirectory(f.scope), 'catalogue.json')).value.entries[id];
    const state = structuredClone(readRoleplayAccount(f.scope)), index = { entries: {} };
    const proof = { operationKeyHash: entry.operationKeyHash };
    if (kind === 'pin') index.entries[id] = proof;
    if (kind === 'other-pin') index.entries['a'.repeat(64)] = proof;
    if (kind === 'pending') state.pending = proof;
    if (kind === 'submission') state.submissions[entry.operationKeyHash] = proof;
    assert.throws(() => assertRepairUnstarted(f.scope, state, id, entry, index), /may have changed/);
});

for (const phase of ['intent', 'directory', 'pins', 'catalogue', 'ready']) test(`first repair store resumes after initialisation ${phase}`, t => {
    const f = setup(t), before = fs.readFileSync(f.filename);
    assert.throws(() => withRoleplayAccountLock(f.scope, lease => ensureRepairStore(lease, { checkpoint(value) {
        if (value === `repair-init-${phase}`) throw new Error('crash');
    } })), /crash/);
    const result = applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost);
    assert.equal(result.revision, 2);
    assert.deepEqual(fs.readFileSync(path.join(repairDirectory(f.scope), result.id + '.before.jsonl')), before);
    assert.equal(readRepairJson(path.join(roleplayStoreDirectory(f.scope), 'image-repair-init.json')).value.phase, 'ready');
});
for (const kind of ['unknown-file', 'nonempty-pins', 'nonempty-catalogue', 'corrupt-intent', 'missing-intent']) test(`repair store retains ${kind} during interrupted initialisation`, t => {
    const f = setup(t), before = fs.readFileSync(f.filename);
    assert.throws(() => withRoleplayAccountLock(f.scope, lease => ensureRepairStore(lease, { checkpoint(value) {
        if (value === 'repair-init-pins') throw new Error('crash');
    } })), /crash/);
    const folder = repairDirectory(f.scope), intent = path.join(roleplayStoreDirectory(f.scope), 'image-repair-init.json');
    if (kind === 'unknown-file') fs.writeFileSync(path.join(folder, 'unrelated'), 'retain');
    if (kind === 'nonempty-pins') {
        const filename = path.join(folder, 'pins.json'), old = readRepairJson(filename);
        writeRepairJson(filename, { version: 1, entries: { unknown: {} } }, 16 * 1024, old.file);
    }
    if (kind === 'nonempty-catalogue') writeRepairJson(path.join(folder, 'catalogue.json'), { version: 1, entries: {}, unknown: true });
    if (kind === 'corrupt-intent') fs.writeFileSync(intent, 'broken');
    if (kind === 'missing-intent') fs.unlinkSync(intent);
    const names = fs.readdirSync(folder).sort();
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost), { code: 'ROLEPLAY_IMAGE_RECOVERY' });
    assert.deepEqual(fs.readdirSync(folder).sort(), names);
    assert.deepEqual(fs.readFileSync(f.filename), before);
});

for (const quota of ['pending', 'records', 'bytes']) test(`repair ${quota} quota refuses before staging or changing chat data`, t => {
    const f = setup(t), before = fs.readFileSync(f.filename);
    withRoleplayAccountLock(f.scope, lease => ensureRepairStore(lease));
    const filename = path.join(repairDirectory(f.scope), 'catalogue.json'), old = readRepairJson(filename);
    const count = quota === 'records' ? 1024 : quota === 'pending' ? 8 : 1;
    const entries = Object.fromEntries(Array.from({ length: count }, (_, index) => [roleplayHash(['quota', index]), {
        bytes: quota === 'bytes' ? 1024 * 1024 * 1024 : 0, complete: quota !== 'pending',
    }]));
    writeRepairJson(filename, { version: 1, entries }, undefined, old.file);
    const names = fs.readdirSync(repairDirectory(f.scope)).sort();
    assert.throws(() => applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost), /storage is full/);
    assert.deepEqual(fs.readdirSync(repairDirectory(f.scope)).sort(), names);
    assert.deepEqual(fs.readFileSync(f.filename), before);
});
