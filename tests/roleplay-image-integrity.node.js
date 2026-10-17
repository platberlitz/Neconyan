/* eslint playwright/expect-expect: off -- Real native transactions with disposable account files. */
// Image-review server messages: which failures are integrity diagnostics (tagged for the page), which are actionable
// sentences (wrapped in uiText so the catalogue collects them), and that the route passes the tag on.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import express from 'express';
import { parse } from 'acorn';
import { fixture, png } from './roleplay-transactions-fixture.js';
const store = await import('../src/roleplay-image-repair-store.js');
const recovery = await import('../src/roleplay-image-recovery.js');
const images = await import('../src/managed-image-files.js');
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');
const { roleplayHash, roleplayStoreDirectory, roleplayLease, saveRoleplayAccount, withRoleplayAccountLock } = await import('../src/roleplay-store.js');
const { repairDirectory, repairPath, readRepairJson, writeRepairJson, writeRepairBytes, ensureRepairStore, repairCatalogue,
    validateRepairReservation, assertRepairUnstarted, pinRepair, finishRepair } = store;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = 'ROLEPLAY_IMAGE_RECOVERY';
// The 40 integrity diagnostics (ledger rows SRV-I01 to SRV-I31 and FIL-I01 to FIL-I09). Their English stays as written.
const INTEGRITY = {
    'SRV-I01': 'The original repair candidate is missing or changed.',
    'SRV-I02': 'The original repair candidate is unreadable.',
    'SRV-I03': 'The repair manifest does not match its original plan.',
    'SRV-I04': 'The required repair backup is missing or changed.',
    'SRV-I05': 'The native repair intent changed.',
    'SRV-I06': 'A prepared image copy is missing or changed.',
    'SRV-I07': 'The native repair receipt needs recovery.',
    'SRV-I08': 'This repair stopped before its durable plan was saved. Keep its reserved files for recovery.',
    'SRV-I09': 'The saved repair plan differs from its reservation.',
    'SRV-I10': 'Unexpected repair evidence was retained.',
    'SRV-I11': 'Changed repair evidence was retained.',
    'SRV-I12': 'Repair evidence changed during discard and was retained.',
    'SRV-I13': 'The backup is missing or changed.',
    'SRV-I14': 'A backup file changed and was retained.',
    'SRV-I15': 'An image recovery record is missing. Keep its files for recovery.',
    'SRV-I16': 'An image recovery record is unreadable.',
    'SRV-I17': 'An image recovery record changed.',
    'SRV-I18': 'The image recovery record exceeds its storage limit.',
    'SRV-I19': 'Image recovery evidence changed. Its files were kept.',
    'SRV-I20': 'The image recovery backup could not be verified.',
    'SRV-I21': 'The image recovery initialisation record changed. Keep its files for recovery.',
    'SRV-I22': 'The image recovery catalogue is missing. Keep the directory for recovery.',
    'SRV-I23': 'Unfinished image recovery initialisation has unexpected records. Its files were retained.',
    'SRV-I24': 'The image recovery catalogue is damaged.',
    'SRV-I25': 'The repair reservation needs recovery. Its files were retained.',
    'SRV-I26': 'The repair reservation differs from its saved intent.',
    'SRV-I27': 'This repair may have changed the chat. Keep its records for recovery.',
    'SRV-I28': 'Image recovery receipt pins are damaged.',
    'SRV-I29': 'The repair receipt pin disagrees with its original intent.',
    'SRV-I30': 'The image repair result has not been saved.',
    'SRV-I31': 'The repair result does not match its catalogue.',
    'FIL-I01': 'The saved image namespace needs recovery.',
    'FIL-I02': 'Unexpected files occupy the unfinished image namespace. They were retained.',
    'FIL-I03': 'The unfinished image ownership record changed.',
    'FIL-I04': 'The image folder ownership record changed.',
    'FIL-I05': 'The immutable image record changed.',
    'FIL-I06': 'A different file occupies the saved prompt-copy location.',
    'FIL-I07': 'This prompt copy is not a verified managed image.',
    'FIL-I08': 'The destination immutable image record differs.',
    'FIL-I09': 'Different bytes occupy the destination prompt-copy location.',
};
// Request-validation messages: no person reaches them from the dialog, so they stay as written and unwrapped.
const UNWRAPPED = new Set([
    'Invalid image review page.',
    'Invalid image coordinates.',
    'An image was selected twice.',
    'Choose how to use this image.',
    'A stable image repair ID is required.',
    'This repair ID already has different choices.',
    'Invalid recovery history page.',
    'Invalid chat list page.',
    'Invalid image recovery record.',
    'This repair already has different saved inputs.',
]);
const SOURCES = ['src/roleplay-image-recovery.js', 'src/roleplay-image-repair-store.js', 'src/managed-image-files.js', 'src/operations/import-managed-images.js'];
// Integrity rows that no test can reach through the public functions, with the reason.
const STATIC_ONLY = {
    'SRV-I20': 'the file system would have to return other bytes straight after a successful write',
};

const hash = character => character.repeat(64);
const thrown = operation => {
    try { operation(); } catch (error) { return error; }
    return assert.fail('The operation did not throw.');
};
const rewrite = (filename, change) => {
    const old = readRepairJson(filename);
    change(old.value);
    writeRepairJson(filename, old.value, undefined, old.file);
};
const userImages = f => {
    f.scope.directories.userImages = path.join(f.scope.directories.root, 'user/images');
    fs.mkdirSync(f.scope.directories.userImages, { recursive: true });
};

// A chat with one broken image and a prepared display-only choice, as the repair tests build it.
function setup(t, { embedded = false } = {}) {
    const f = fixture(t);
    userImages(f);
    f.records[1].extra.media = [{ type: 'image', url: embedded ? `data:image/png;base64,${png.toString('base64')}` : 'data:image/png;base64,old-broken-image', title: 'Keep this stored label' }];
    fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
    const scan = recovery.scanRoleplayImages(f.scope, { locator: f.locator });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const input = { account, key: 'repair-first', observation: scan.observation,
        actions: [{ ...scan.issues[0], mode: embedded ? 'include' : 'display-only', ...(embedded ? { saveCopy: true } : {}) }] };
    const id = roleplayHash([f.scope.accountId, f.scope.dataEpoch, 'image-repair', input.key]);
    return { ...f, account, input, id, file: suffix => path.join(repairDirectory(f.scope), `${id}.${suffix}`) };
}
const apply = f => recovery.applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost);
const crashAt = (f, phase) => assert.throws(() => recovery.applyRoleplayImageRepair(f.scope, f.input, roleplayNativeHost, {
    checkpoint(value) { if (value === phase) throw new Error('simulated crash'); },
}), /simulated crash/);
const resume = f => recovery.resumeRoleplayImageRepair(f.scope, { account: f.account, id: f.id }, roleplayNativeHost);
const discard = (f, options) => recovery.discardRoleplayImageRepair(f.scope, { account: f.account, id: f.id }, options);
// Changes the saved plan and keeps every record that vouches for it consistent, so the later check is the one that fires.
function resign(f, changePlan) {
    rewrite(f.file('plan.json'), changePlan);
    const planHash = roleplayHash(readRepairJson(f.file('plan.json')).value);
    rewrite(f.file('manifest.json'), manifest => { manifest.planHash = planHash; });
    rewrite(path.join(repairDirectory(f.scope), 'catalogue.json'), catalogue => { catalogue.entries[f.id].planHash = planHash; });
}
function storeScene(t) {
    const f = fixture(t);
    return { ...f, directory: withRoleplayAccountLock(f.scope, lease => ensureRepairStore(lease)) };
}
function managedScene(t) {
    const f = fixture(t);
    userImages(f);
    const directories = f.scope.directories, image = images.decodeCompatibleImage(`data:image/png;base64,${png.toString('base64')}`);
    const publish = () => {
        images.publishManagedImage(directories, image);
        const filename = images.accountImagePath(directories, images.managedImageUrl(image));
        return { filename, record: filename + '.record.json' };
    };
    return { ...f, directories, image, publish, marker: path.join(images.managedImageDirectory(directories), '.neconyan-managed-images.json') };
}
const initialiseCrash = (f, phase) => assert.throws(() => withRoleplayAccountLock(f.scope, lease => ensureRepairStore(lease, {
    checkpoint(value) { if (value === phase) throw new Error('simulated crash'); },
})), /simulated crash/);
const lockedStore = (f, operation) => withRoleplayAccountLock(f.scope, lease => operation(lease));
const entryOf = (f, extra = {}) => ({ accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch, phase: 'staging', planHash: hash('a'), requestHash: hash('b'),
    operationKeyHash: hash('c'), intentHash: hash('d'), locator: { group: false, chat: 'Source', avatar: 'Nova.png' }, bytes: 1, complete: false, ...extra });
const planOf = (candidate = hash('1')) => ({ candidateHash: candidate, native: { operationKeyHash: hash('c'), intentHash: hash('d') } });

// One test for each integrity row that the public functions can reach. Each makes the saved state wrong in the way the row
// describes and checks the error that comes out: its English unchanged, its code unchanged and the integrity tag set.
const CASES = new Map();
const integrityCase = (id, run) => {
    assert.ok(INTEGRITY[id], id);
    CASES.set(id, run);
    test(`${id} is tagged as an integrity failure`, t => {
        const error = thrown(() => run(t));
        assert.equal(error.message, INTEGRITY[id]);
        assert.equal(error.code, CODE);
        assert.equal(error.integrity, true);
    });
};

integrityCase('SRV-I01', t => {
    const f = setup(t);
    crashAt(f, 'backup-verified');
    fs.writeFileSync(f.file('candidate.jsonl'), 'changed');
    resume(f);
});
integrityCase('SRV-I02', t => {
    const f = setup(t);
    crashAt(f, 'backup-verified');
    const damaged = Buffer.from('not a chat file');
    fs.writeFileSync(f.file('candidate.jsonl'), damaged);
    resign(f, plan => { plan.candidateHash = crypto.createHash('sha256').update(damaged).digest('hex'); });
    resume(f);
});
integrityCase('SRV-I03', t => {
    const f = setup(t);
    crashAt(f, 'backup-verified');
    rewrite(f.file('manifest.json'), manifest => { manifest.planHash = hash('f'); });
    resume(f);
});
integrityCase('SRV-I04', t => {
    const f = setup(t);
    crashAt(f, 'backup-verified');
    fs.writeFileSync(f.file('before.jsonl'), 'changed');
    resume(f);
});
integrityCase('SRV-I05', t => {
    const f = setup(t);
    crashAt(f, 'backup-verified');
    resign(f, plan => { plan.native = { ...plan.native, tampered: true }; });
    resume(f);
});
integrityCase('SRV-I06', t => {
    const f = setup(t, { embedded: true });
    crashAt(f, 'backup-verified');
    fs.writeFileSync(f.file('image.0.bin'), 'changed');
    resume(f);
});
integrityCase('SRV-I07', t => {
    const f = setup(t);
    crashAt(f, 'native-committed');
    const key = readRepairJson(f.file('plan.json')).value.native.operationKeyHash;
    withRoleplayAccountLock(f.scope, lease => {
        roleplayLease(lease).state.submissions[key].state = 'accepted';
        saveRoleplayAccount(lease);
    });
    resume(f);
});
integrityCase('SRV-I08', t => {
    const f = setup(t);
    crashAt(f, 'reserved');
    apply(f);
});
integrityCase('SRV-I09', t => {
    const f = setup(t);
    crashAt(f, 'backup-verified');
    rewrite(path.join(repairDirectory(f.scope), 'catalogue.json'), catalogue => { catalogue.entries[f.id].planHash = hash('f'); });
    resume(f);
});
integrityCase('SRV-I10', t => {
    const f = setup(t);
    crashAt(f, 'manifest-staged');
    fs.writeFileSync(f.file('unknown'), 'retain');
    discard(f);
});
integrityCase('SRV-I11', t => {
    const f = setup(t);
    crashAt(f, 'manifest-staged');
    fs.writeFileSync(f.file('candidate.jsonl'), 'changed');
    discard(f);
});
integrityCase('SRV-I12', t => {
    const f = setup(t);
    crashAt(f, 'manifest-staged');
    discard(f, { checkpoint(value) { if (value === 'discarding-before.jsonl') fs.writeFileSync(f.file('before.jsonl'), 'changed during discard'); } });
});
integrityCase('SRV-I13', t => {
    const f = setup(t);
    apply(f);
    fs.writeFileSync(f.file('before.jsonl'), 'changed');
    recovery.exportRoleplayImageBackup(f.scope, { account: f.account, id: f.id });
});
integrityCase('SRV-I14', t => {
    const f = setup(t);
    apply(f);
    fs.writeFileSync(f.file('candidate.jsonl'), 'changed');
    recovery.removeRoleplayImageBackup(f.scope, { account: f.account, id: f.id });
});
integrityCase('SRV-I15', t => {
    const f = storeScene(t);
    readRepairJson(path.join(f.directory, 'missing.json'));
});
integrityCase('SRV-I16', t => {
    const f = storeScene(t), filename = path.join(f.directory, 'broken.json');
    fs.writeFileSync(filename, 'broken');
    readRepairJson(filename);
});
integrityCase('SRV-I17', t => {
    const f = storeScene(t), filename = path.join(f.directory, 'altered.json');
    fs.writeFileSync(filename, JSON.stringify({ hash: hash('0'), value: { changed: true } }));
    readRepairJson(filename);
});
integrityCase('SRV-I18', t => {
    const f = storeScene(t);
    writeRepairBytes(path.join(f.directory, 'large.bin'), Buffer.alloc(8), 4);
});
integrityCase('SRV-I19', t => {
    const f = storeScene(t), filename = path.join(f.directory, 'twice.bin');
    writeRepairBytes(filename, Buffer.from('one'), 100);
    writeRepairBytes(filename, Buffer.from('two'), 100);
});
integrityCase('SRV-I21', t => {
    const f = fixture(t);
    initialiseCrash(f, 'repair-init-intent');
    rewrite(path.join(roleplayStoreDirectory(f.scope), 'image-repair-init.json'), intent => { intent.kind = 'another-store'; });
    lockedStore(f, lease => ensureRepairStore(lease));
});
integrityCase('SRV-I22', t => {
    const f = fixture(t);
    initialiseCrash(f, 'repair-init-pins');
    fs.unlinkSync(path.join(roleplayStoreDirectory(f.scope), 'image-repair-init.json'));
    lockedStore(f, lease => ensureRepairStore(lease));
});
integrityCase('SRV-I23', t => {
    const f = fixture(t);
    initialiseCrash(f, 'repair-init-pins');
    fs.writeFileSync(path.join(repairDirectory(f.scope), 'unrelated'), 'retain');
    lockedStore(f, lease => ensureRepairStore(lease));
});
integrityCase('SRV-I24', t => {
    const f = storeScene(t);
    rewrite(path.join(f.directory, 'catalogue.json'), catalogue => { catalogue.version = 2; });
    repairCatalogue(f.scope);
});
integrityCase('SRV-I25', t => {
    validateRepairReservation(fixture(t).scope, undefined);
});
integrityCase('SRV-I26', t => {
    const f = fixture(t);
    validateRepairReservation(f.scope, entryOf(f), { ...planOf(), requestHash: hash('e'),
        input: { source: { locator: entryOf(f).locator, accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch } } });
});
integrityCase('SRV-I27', t => {
    const f = fixture(t);
    assertRepairUnstarted(f.scope, { submissions: {}, pending: null }, hash('9'), entryOf(f, { phase: 'prepared' }), { entries: {} });
});
integrityCase('SRV-I28', t => {
    const f = storeScene(t);
    rewrite(path.join(f.directory, 'pins.json'), pins => { pins.version = 2; });
    lockedStore(f, lease => pinRepair(lease, hash('1'), planOf()));
});
integrityCase('SRV-I29', t => {
    const f = storeScene(t);
    lockedStore(f, lease => {
        pinRepair(lease, hash('1'), planOf(hash('1')));
        pinRepair(lease, hash('1'), planOf(hash('2')));
    });
});
integrityCase('SRV-I30', t => {
    const f = storeScene(t), id = hash('1');
    writeRepairJson(repairPath(f.scope, id, 'manifest.json'), { version: 1, planHash: hash('2'), stage: 'backup-verified', result: null });
    lockedStore(f, lease => finishRepair(lease, id));
});
integrityCase('SRV-I31', t => {
    const f = storeScene(t), id = hash('1');
    writeRepairJson(repairPath(f.scope, id, 'manifest.json'), { version: 1, planHash: hash('2'), stage: 'committed', result: { saved: true } });
    lockedStore(f, lease => finishRepair(lease, id));
});
integrityCase('FIL-I01', t => {
    const f = managedScene(t);
    images.ensureManagedImageNamespace(f.directories);
    rewrite(path.join(f.directories.root, '.neconyan-managed-images.json'), record => { record.version = 2; });
    images.ensureManagedImageNamespace(f.directories);
});
integrityCase('FIL-I02', t => {
    const f = managedScene(t);
    assert.throws(() => images.ensureManagedImageNamespace(f.directories, { checkpoint(value) { if (value === 'namespace-directory') throw new Error('simulated crash'); } }), /simulated crash/);
    fs.writeFileSync(path.join(images.managedImageDirectory(f.directories), 'authored.png'), png);
    images.ensureManagedImageNamespace(f.directories);
});
integrityCase('FIL-I03', t => {
    const f = managedScene(t);
    assert.throws(() => images.ensureManagedImageNamespace(f.directories, { checkpoint(value) { if (value === 'namespace-marker') throw new Error('simulated crash'); } }), /simulated crash/);
    rewrite(f.marker, record => { record.id = crypto.randomUUID(); });
    images.ensureManagedImageNamespace(f.directories);
});
integrityCase('FIL-I04', t => {
    const f = managedScene(t);
    images.ensureManagedImageNamespace(f.directories);
    rewrite(f.marker, record => { record.id = crypto.randomUUID(); });
    images.ensureManagedImageNamespace(f.directories);
});
integrityCase('FIL-I05', t => {
    const f = managedScene(t), { record } = f.publish();
    rewrite(record, value => { value.size += 1; });
    f.publish();
});
integrityCase('FIL-I06', t => {
    const f = managedScene(t), { filename } = f.publish();
    fs.writeFileSync(filename, 'a different file');
    f.publish();
});
integrityCase('FIL-I07', t => {
    const f = managedScene(t);
    images.verifyManagedImage(f.directories, `/user/images/neconyan-repaired/${hash('a')}.png`);
});
integrityCase('FIL-I08', t => {
    const f = managedScene(t), { record } = f.publish();
    rewrite(record, value => { value.size += 1; });
    images.checkManagedImageDestination(f.directories, f.image);
});
integrityCase('FIL-I09', t => {
    const f = managedScene(t), { filename } = f.publish();
    fs.writeFileSync(filename, 'a different file');
    images.checkManagedImageDestination(f.directories, f.image);
});

test('every integrity row has a test that reaches it, or a stated reason that none can', () => {
    for (const id of Object.keys(INTEGRITY)) assert.ok(CASES.has(id) !== Object.hasOwn(STATIC_ONLY, id), `${id} needs exactly one of a test or a reason`);
    assert.deepEqual(Object.keys(STATIC_ONLY).filter(id => !INTEGRITY[id]), []);
    assert.equal(Object.keys(INTEGRITY).length, 40);
    assert.equal(new Set(Object.values(INTEGRITY)).size, 40);
});

test('integrityFailure and repairFailure tag only what they are asked to tag', () => {
    const plain = store.repairFailure('A sentence.'), tagged = store.integrityFailure('A detail.'), asked = store.repairFailure('A detail.', { integrity: true });
    assert.equal(Object.hasOwn(plain, 'integrity'), false);
    assert.equal(Object.hasOwn(store.repairFailure('A sentence.', {}), 'integrity'), false);
    assert.equal(Object.hasOwn(store.repairFailure('A sentence.', { integrity: false }), 'integrity'), false);
    for (const error of [tagged, asked]) {
        assert.equal(error.integrity, true);
        assert.equal(error.code, CODE);
        assert.equal(error.status, 409);
    }
    assert.equal(plain.code, CODE);
    assert.equal(plain.status, 409);
});

// Actionable errors: a person can do something about each, so none carries the tag.
test('actionable failures carry no integrity tag', t => {
    const damaged = fixture(t);
    fs.writeFileSync(damaged.filename, '{ not a chat file');
    const checks = [
        [() => recovery.scanRoleplayImages(damaged.scope, { locator: damaged.locator }), 'This chat file is damaged, so its images cannot be listed. Recover the chat first.'],
        [() => recovery.applyRoleplayImageRepair(damaged.scope, { key: 'no-account' }, roleplayNativeHost), 'Close this window and open it again to confirm your account.'],
        [() => images.decodeCompatibleImage('data:image/gif;base64,AAAA'), 'Only PNG, JPEG or WebP images can be saved as compatible copies. Use Prepare a converted copy.'],
        [() => recovery.discardRoleplayImageRepair(damaged.scope, {}), 'Close this window and open it again to confirm your account.'],
    ];
    for (const [operation, message] of checks) {
        const error = thrown(operation);
        assert.equal(error.message, message);
        assert.equal(error.code, CODE);
        assert.equal(Object.hasOwn(error, 'integrity'), false, message);
    }
    const f = managedScene(t), { filename } = f.publish();
    const kept = thrown(() => images.assertMutableImagePath(f.directories, filename));
    assert.equal(kept.message, 'This compatible copy may be used by other chats, so it is kept. Remove it from the message instead.');
    assert.equal(Object.hasOwn(kept, 'integrity'), false);
});

// SRV-01 and SRV-01b (W-2). A chat file that exists but cannot be read is damaged and needs ordinary recovery. A chat file that does not
// exist, or whose folder is gone (a deleted character), has nothing to recover, and the person is not shown an operating system error,
// which would name a server path. All three places that read the chat give the same answer.
const SRV_01 = 'This chat file is damaged, so its images cannot be listed. Recover the chat first.';
const SRV_01B = 'This chat file no longer exists, so its images cannot be listed.';
const CHAT_STATES = {
    'a damaged chat file keeps SRV-01': [f => fs.writeFileSync(f.filename, '{ not a chat file'), SRV_01],
    'a missing chat file shows SRV-01b': [f => fs.rmSync(f.filename), SRV_01B],
    'a missing chat folder shows SRV-01b, with no operating system error and no server path': [f => fs.rmSync(path.dirname(f.filename), { recursive: true }), SRV_01B],
};
for (const [name, [change, message]] of Object.entries(CHAT_STATES)) {
    test(name, t => {
        const f = fixture(t);
        change(f);
        const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
        const observed = { locator: f.locator };
        const operations = {
            scan: () => recovery.scanRoleplayImages(f.scope, { locator: f.locator }),
            apply: () => recovery.applyRoleplayImageRepair(f.scope, { account, key: 'no-chat', observation: observed, actions: [] }, roleplayNativeHost),
            source: () => recovery.readRoleplayImageReviewSource(f.scope, { account, observation: observed, identity: 'any' }),
        };
        for (const [place, operation] of Object.entries(operations)) {
            const error = thrown(operation);
            assert.equal(error.message, message, place);
            assert.equal(error.code, CODE, place);
            assert.equal(error.status, 409, place);
            assert.equal(Object.hasOwn(error, 'integrity'), false, place);
            for (const leak of ['ENOENT', f.root, path.dirname(f.filename), os.tmpdir()]) assert.ok(!error.message.includes(leak), `${place}: the message names ${leak}`);
        }
    });
}

test('the route answers a missing chat folder with SRV-01b alone, as an actionable error', async t => {
    const f = fixture(t);
    const post = await serve(t, f);
    fs.rmSync(path.dirname(f.filename), { recursive: true });
    const { status, body } = await post('/images/scan', { locator: f.locator });
    assert.equal(status, 409);
    assert.deepEqual(body, { error: SRV_01B, code: CODE });
});

// SRV-39 (W-2): the limit is eight open changes in the whole account, so the sentence says the account and sends the person to Change
// history, where they are reviewed. It is an actionable sentence, not an integrity diagnostic.
const SRV_39 = 'Too many image changes in this account need attention. Review them in Change history before trying again.';
test('SRV-39: the ninth open change in an account is refused with the account-wide sentence', t => {
    const f = storeScene(t);
    lockedStore(f, lease => { for (const digit of '01234567') pinRepair(lease, hash(digit), planOf(hash(digit))); });
    const error = thrown(() => lockedStore(f, lease => pinRepair(lease, hash('8'), planOf(hash('8')))));
    assert.equal(error.message, SRV_39);
    assert.equal(error.code, CODE);
    assert.equal(error.status, 409);
    assert.equal(Object.hasOwn(error, 'integrity'), false);
    // An entry that is already pinned is still accepted at the limit.
    lockedStore(f, lease => pinRepair(lease, hash('0'), planOf(hash('0'))));
});

// Static checks, read from the source, so a message added later cannot be left untagged or unwrapped.
function callsIn(file) {
    const found = [];
    const walk = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression') found.push(node);
        for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(walk) : walk(value);
    };
    walk(parse(fs.readFileSync(path.join(root, file), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }));
    return found;
}
const calleeName = call => call.callee.name ?? call.callee.property?.name;
const taggedByOption = call => call.arguments[1]?.type === 'ObjectExpression'
    && call.arguments[1].properties.some(property => property.key?.name === 'integrity' && property.value?.value === true);
// The text a failure call gives, as { wrapped, text } leaves (a conditional gives two). null for a computed message.
function leaves(node) {
    if (node.type === 'Literal' && typeof node.value === 'string') return [{ wrapped: false, text: node.value }];
    if (node.type === 'CallExpression' && node.callee.name === 'uiText') return [{ wrapped: true, text: node.arguments[0]?.value }];
    if (node.type === 'ConditionalExpression') return [...leaves(node.consequent), ...leaves(node.alternate)];
    return null;
}
const failureCalls = file => callsIn(file).filter(call => ['repairFailure', 'integrityFailure', 'operationError'].includes(calleeName(call)));

test('exactly the integrity rows are thrown as integrity failures, and nothing else is', () => {
    const tagged = [];
    for (const file of SOURCES) for (const call of failureCalls(file)) {
        const name = calleeName(call), message = call.arguments[0];
        if (message.type === 'Identifier') { assert.equal(file, 'src/roleplay-image-repair-store.js', 'only the helper definitions pass a variable'); continue; }
        const found = leaves(message);
        assert.ok(found && found.length, `${file} gives a message that is not a plain sentence`);
        const isTagged = name === 'integrityFailure' || name === 'repairFailure' && taggedByOption(call);
        for (const { wrapped, text } of found) {
            if (isTagged) { assert.equal(wrapped, false, `${text} is an integrity detail, kept as plain English`); tagged.push(text); }
            else assert.ok(!Object.values(INTEGRITY).includes(text), `${text} is an integrity diagnostic thrown without the tag`);
        }
    }
    assert.deepEqual(tagged.sort(), Object.values(INTEGRITY).sort());
});

test('every actionable message is wrapped in uiText, and only request validation stays plain', () => {
    const plain = new Set();
    for (const file of SOURCES) for (const call of failureCalls(file)) {
        const name = calleeName(call), message = call.arguments[0];
        if (message.type === 'Identifier' || name === 'integrityFailure' || taggedByOption(call)) continue;
        for (const { wrapped, text } of leaves(message)) {
            if (wrapped) { assert.ok(text && !UNWRAPPED.has(text), `${text} is wrapped but listed as request validation`); continue; }
            assert.ok(UNWRAPPED.has(text), `${file}: ${text} is shown to people but not wrapped in uiText`);
            plain.add(text);
        }
    }
    assert.deepEqual([...plain].sort(), [...UNWRAPPED].sort(), 'a listed request-validation message is gone from the source');
});

test('the catalogue builder collects every uiText message of the server files', () => {
    const run = spawnSync(process.execPath, ['scripts/build-interface-locales.js', '--list'], {
        cwd: root, env: { ...process.env, NECONYAN_TRANSLATION_COMMAND: '' }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
    assert.equal(run.status, 0, run.stderr);
    const collected = new Set(JSON.parse(run.stdout));
    let count = 0;
    for (const file of [...SOURCES, 'src/endpoints/roleplay.js']) for (const call of callsIn(file).filter(item => calleeName(item) === 'uiText')) {
        const text = call.arguments[0].value;
        assert.equal(typeof text, 'string', file);
        assert.ok(collected.has(text.trim()), `${file}: the builder does not collect "${text}"`);
        count++;
    }
    assert.ok(count >= 60, 'the server files wrap their messages');
});

// The route: the tag travels in the JSON error, and an actionable error leaves it out.
async function serve(t, f) {
    const { router } = await import('../src/endpoints/roleplay.js');
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.user = { profile: { handle: 'fixture' }, directories: f.scope.directories }; next(); });
    app.use('/api/roleplay', router);
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    return async (route, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/roleplay${route}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
}

test('the route adds integrity: true to the JSON error of an integrity failure', async t => {
    const f = setup(t);
    const post = await serve(t, f);
    withRoleplayAccountLock(f.scope, lease => ensureRepairStore(lease));
    fs.writeFileSync(path.join(repairDirectory(f.scope), 'catalogue.json'), 'broken');
    const { status, body } = await post('/images/history', { account: f.account });
    assert.equal(status, 409);
    assert.deepEqual(body, { error: INTEGRITY['SRV-I16'], code: CODE, integrity: true });
});

test('the route leaves integrity out of an actionable error', async t => {
    const f = setup(t);
    const post = await serve(t, f);
    const stale = { ...f.input.observation, rawHash: hash('0') };
    const { status, body } = await post('/images/scan', { locator: f.locator, observation: stale });
    assert.equal(status, 409);
    assert.deepEqual(body, { error: 'The chat changed while you were reviewing it. List its images again, then choose.', code: CODE });
    assert.equal(Object.hasOwn(body, 'integrity'), false);
});

test('the route reports a failure from a managed-image check with the same tag', async t => {
    const f = managedScene(t);
    const post = await serve(t, f);
    const { body } = await post('/images/check-copies', { account: { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch },
        copies: [{ imageUrl: `/user/images/neconyan-repaired/${hash('a')}.png`, originalUrl: null }] });
    assert.deepEqual(body, { error: INTEGRITY['FIL-I07'], code: CODE, integrity: true });
});
