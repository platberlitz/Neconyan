/* eslint playwright/expect-expect: off -- Uses node:assert against real disposable storage. */
// A save reads and hashes the chat fewer times than it used to. Each check it no longer repeats is covered by a
// later one, before anything is written: these change the chat, its staged copy or its journal at every point
// in between, and the save must still refuse, leaving the changed file exactly as it was left.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixture, memoryParent } from './roleplay-transactions-fixture.js';
import { patchFor, savedMessageLines } from './chat-patch-helpers.js';
import { FILE_WRITE_RECOVERY_SUFFIX, sameFileIdentity, tryWriteFileSync } from '../src/util.js';
import { prepareNativeChatWrite, publishNativeChatWrite, roleplayBrowserHost } from '../src/endpoints/chats.js';
import { commitSingleChatWrite, reconcileSingleChatWrite } from '../src/roleplay-lifecycle.js';
import { readRoleplayAccount, roleplayStoreDirectory } from '../src/roleplay-store.js';

const nativeHost = { prepare: prepareNativeChatWrite, publish: publishNativeChatWrite };
const originals = { renameSync: fs.renameSync, copyFileSync: fs.copyFileSync, lstatSync: fs.lstatSync, mkdirSync: fs.mkdirSync, existsSync: fs.existsSync, openSync: fs.openSync };

// The kinds of save that publish through different checks: a whole chat, a patch, and a patch that changes nothing.
const saves = {
    whole: f => ({ host: nativeHost, input: { ...f.input(), backup: { deferBackup: false } } }),
    patch: f => patchSave(f, records => [...records, { name: 'Nova', is_user: false, mes: 'Patched result' }]),
    'unchanged patch': f => patchSave(f, records => structuredClone(records)),
};

function patchSave(f, change) {
    const { accountId, dataEpoch, instanceId, revision, rawHash, locator } = f.source();
    const source = { kind: 'storage', accountId, dataEpoch, instanceId, revision, rawHash, locator, dependencies: [] };
    return { host: roleplayBrowserHost, input: { operationKey: 'first', mode: 'update', sourceKind: 'storage', source,
        patch: patchFor(savedMessageLines(f.filename), change(f.records)), backup: { deferBackup: false } } };
}

const tampers = {
    // Same size, same identity, other bytes, and still a valid chat.
    'rewritten in place': f => fs.writeFileSync(f.filename, fs.readFileSync(f.filename, 'utf8').replace('Original', 'Tampered')),
    // The same bytes at a new identity: the replacement exists before the original is gone.
    'replaced by an identical copy': f => {
        originals.copyFileSync(f.filename, f.filename + '.new');
        originals.renameSync(f.filename + '.new', f.filename);
    },
    'hard-linked': f => fs.linkSync(f.filename, f.filename + '.link'),
    'replaced by a symlink': f => {
        originals.renameSync(f.filename, f.filename + '.real');
        fs.symlinkSync(f.filename + '.real', f.filename);
    },
    'given an undo journal': f => fs.writeFileSync(f.filename + FILE_WRITE_RECOVERY_SUFFIX, 'Unclassified evidence'),
};

const expectedRefusal = {
    // After the locked read, the writer's own hash of the file it opened refuses it, as a changed chat.
    'rewritten in place': /ESTALE|ROLEPLAY_SOURCE_CHANGED|Chat changed after it was checked/,
    'replaced by an identical copy': /ESTALE|ROLEPLAY_SOURCE_CHANGED/,
    'hard-linked': /ROLEPLAY_STORE_DAMAGED|EINVAL|EMLINK/,
    'replaced by a symlink': /ROLEPLAY_STORE_DAMAGED|EINVAL/,
    'given an undo journal': /explicit reconciliation|ROLEPLAY_RECOVERY_REQUIRED/,
};

// Each boundary is where one of the removed reads used to be; `arm` installs the tamper there.
const boundaries = {
    // Between staging the write and judging the chat again: the staged observation must not be reused.
    'after staging': ({ t, f, tamper }) => {
        t.mock.method(fs, 'renameSync', (from, to) => {
            const result = originals.renameSync(from, to);
            if (path.basename(String(to)) === 'state.json' && readRoleplayAccount(f.scope).pending) tamper();
            return result;
        });
    },
    // As publication first looks at the chat, before its lock: that look reads no bytes, so the locked read must catch the rest.
    'before the chat lock': ({ t, f, tamper, isPublishing }) => {
        t.mock.method(fs, 'lstatSync', (filename, ...args) => {
            if (isPublishing() && String(filename) === f.filename) tamper();
            return originals.lstatSync(filename, ...args);
        });
    },
    'while the chat lock is taken': ({ t, f, tamper, isPublishing }) => {
        t.mock.method(fs, 'mkdirSync', (filename, ...args) => {
            if (isPublishing() && filename === path.dirname(f.filename)) tamper();
            return originals.mkdirSync(filename, ...args);
        });
    },
    // After the one locked read, before backups and the recovery snapshot are written: the check just before the
    // write reads no bytes, so the writer's own hash of the file it opens must catch a rewrite.
    'after the locked read': ({ t, f, tamper, isPublishing }) => {
        t.mock.method(fs, 'existsSync', filename => {
            const result = originals.existsSync(filename);
            if (isPublishing() && filename === f.filename) tamper();
            return result;
        });
    },
};

/** Runs a save that tampers at the boundary's hook, and checks it refused and left the tampered files alone. */
function assertRefusedAt(t, kind, boundary, tamperName) {
    const f = fixture(t);
    const { host, input } = saves[kind](f);
    const before = fs.readFileSync(f.filename);
    let fired = false;
    const tamper = () => {
        if (fired) return;
        fired = true;
        tampers[tamperName](f);
    };
    let publishing = false;
    const watched = { ...host, publish(options) {
        publishing = true;
        try { return host.publish(options); } finally { publishing = false; }
    } };
    boundaries[boundary]({ t, f, tamper, isPublishing: () => publishing });
    let failure;
    try {
        assert.throws(() => commitSingleChatWrite(f.scope, input, watched), error => { failure = error; return true; });
    } finally { t.mock.restoreAll(); }
    assert.equal(fired, true, 'the tamper hook ran');
    assert.equal(failure.roleplayWritePending, true, `${failure.code}: ${failure.message}`);
    assert.match(`${failure.code} ${failure.message}`, expectedRefusal[tamperName]);
    if (/Chat changed after it was checked/.test(failure.message)) {
        assert.equal(failure.cause?.code, 'ESTALE');
        assert.equal(failure.chatWriteUncertain, true);
    }
    if (tamperName === 'replaced by a symlink') {
        assert.equal(fs.lstatSync(f.filename).isSymbolicLink(), true);
        assert.deepEqual(fs.readFileSync(f.filename + '.real'), before);
    } else if (tamperName === 'rewritten in place') {
        assert.equal(fs.readFileSync(f.filename, 'utf8'), before.toString('utf8').replace('Original', 'Tampered'));
    } else {
        assert.deepEqual(fs.readFileSync(f.filename), before);
    }
    if (tamperName === 'given an undo journal') assert.equal(fs.readFileSync(f.filename + FILE_WRITE_RECOVERY_SUFFIX, 'utf8'), 'Unclassified evidence');
    assert.ok(readRoleplayAccount(f.scope).pending, 'the save stays pending, to be reconciled');
}

for (const kind of Object.keys(saves)) {
    for (const boundary of Object.keys(boundaries)) {
        for (const tamperName of Object.keys(tampers)) {
            // A journal written after staging is the lifecycle's own recovery case, classified before publication.
            if (boundary === 'after staging' && tamperName === 'given an undo journal') continue;
            test(`a ${kind} save refuses a chat ${tamperName} ${boundary}`, t => assertRefusedAt(t, kind, boundary, tamperName));
        }
    }
}

// Flips one bit of the staged copy's last message, keeping its size and identity.
function changeStagedCopy(payloadPath) {
    const bytes = fs.readFileSync(payloadPath);
    bytes[bytes.length - 2] ^= 0x01;
    fs.writeFileSync(payloadPath, bytes);
}

for (const changed of [false, true]) {
    test(`publication ${changed ? 'reads a staged copy changed after the lifecycle verified it again' : 'uses the staged copy the lifecycle just verified'}`, t => {
        const f = fixture(t);
        const { host, input } = saves.patch(f);
        const before = fs.readFileSync(f.filename);
        let payloadReads = 0;
        const watched = { ...host, publish(options) {
            if (changed) changeStagedCopy(options.payloadPath);
            t.mock.method(fs, 'openSync', (filename, ...args) => {
                if (filename === options.payloadPath) payloadReads++;
                return originals.openSync(filename, ...args);
            });
            try { return host.publish(options); } finally { t.mock.restoreAll(); }
        } };
        if (changed) {
            assert.throws(() => commitSingleChatWrite(f.scope, input, watched), /Prepared chat payload changed/);
            assert.equal(payloadReads, 1);
            assert.deepEqual(fs.readFileSync(f.filename), before, 'nothing was written');
            assert.ok(readRoleplayAccount(f.scope).pending);
        } else {
            assert.equal(commitSingleChatWrite(f.scope, input, watched).changed, true);
            assert.equal(payloadReads, 0);
            assert.equal(readRoleplayAccount(f.scope).pending, null);
        }
    });
}

test('cleanup keeps a staged copy rewritten after publication, judged by its hash', t => {
    const f = fixture(t);
    const { host, input } = saves.patch(f);
    let payloadPath;
    commitSingleChatWrite(f.scope, input, { ...host, publish(options) {
        const result = host.publish(options);
        payloadPath = options.payloadPath;
        changeStagedCopy(payloadPath);
        return result;
    } });
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    assert.ok(payloadPath.startsWith(path.join(roleplayStoreDirectory(f.scope), 'pending') + path.sep));
    assert.equal(fs.existsSync(payloadPath), true, 'the changed staged copy was kept');
});

// The newly created staged file `name` gets other bytes than it was given, though every write reports success.
function landWrongBytes(t, name) {
    const created = new Set();
    let landed = 0;
    const write = fs.writeSync;
    t.mock.method(fs, 'openSync', (filename, flags, ...args) => {
        const fd = originals.openSync(filename, flags, ...args);
        if (flags === 'wx' && path.basename(String(filename)) === name && path.basename(path.dirname(path.dirname(String(filename)))) === 'pending') created.add(fd);
        return fd;
    });
    // A closed descriptor's number is soon given to another file.
    const close = fs.closeSync;
    t.mock.method(fs, 'closeSync', fd => {
        created.delete(fd);
        return close(fd);
    });
    t.mock.method(fs, 'writeSync', (fd, buffer, offset = 0, length = buffer.byteLength - offset, position = null) => {
        if (!created.has(fd) || !Buffer.isBuffer(buffer) || length === 0) return write(fd, buffer, offset, length, position);
        landed++;
        const wrong = Buffer.from(buffer.subarray(offset, offset + length));
        wrong[0] ^= 0x01;
        return write(fd, wrong, 0, wrong.length, position);
    });
    return () => landed;
}

test('repair evidence is proven on disk before the restore replaces the damaged chat', t => {
    const f = fixture(t);
    assert.throws(() => commitSingleChatWrite(f.scope, f.input(), { ...nativeHost, publish() { throw new Error('Paused before publication'); } }), /Paused/);
    fs.writeFileSync(f.filename, '!corrupt during write');
    const damaged = fs.readFileSync(f.filename);
    const landed = landWrongBytes(t, 'chat.corrupt.jsonl');
    assert.throws(() => reconcileSingleChatWrite(f.scope, 'first', nativeHost), { code: 'ROLEPLAY_STORE_DAMAGED' });
    t.mock.restoreAll();
    assert.equal(landed(), 1);
    assert.deepEqual(fs.readFileSync(f.filename), damaged, 'the damaged chat is still there, so its evidence was not lost');
    assert.equal(readRoleplayAccount(f.scope).pending.repair, null, 'no repair was recorded on unproven evidence');
});

test('branch memory is proven on disk before the chat is published', t => {
    const f = fixture(t);
    memoryParent(f);
    const input = f.input();
    input.records[0].chat_metadata.main_chat = 'Parent';
    const before = fs.readFileSync(f.filename);
    const landed = landWrongBytes(t, 'memory.archive.json');
    let published = false;
    assert.throws(() => commitSingleChatWrite(f.scope, input, { ...nativeHost, publish(options) { published = true; return nativeHost.publish(options); } }),
        { code: 'ROLEPLAY_STORE_DAMAGED' });
    t.mock.restoreAll();
    assert.equal(landed(), 1);
    assert.equal(published, false);
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.equal(readRoleplayAccount(f.scope).pending, null, 'the save was refused before it became pending');
});

for (const kind of ['whole', 'patch']) {
    test(`a ${kind} save's staged chat, not read back as it is staged, is proven on disk before publication`, t => {
        const f = fixture(t);
        const { host, input } = saves[kind](f);
        const before = fs.readFileSync(f.filename);
        const landed = landWrongBytes(t, 'chat.after.jsonl');
        let published = false;
        assert.throws(() => commitSingleChatWrite(f.scope, input, { ...host, publish(options) { published = true; return host.publish(options); } }),
            error => error.code === 'ROLEPLAY_STORE_DAMAGED' && error.roleplayWritePending === true);
        t.mock.restoreAll();
        assert.equal(landed(), 1);
        assert.equal(published, false);
        assert.deepEqual(fs.readFileSync(f.filename), before);
        assert.ok(readRoleplayAccount(f.scope).pending, 'the save stays pending, to be reconciled');
    });
}

test('sameFileIdentity requires the recorded creation time when one was supplied', () => {
    const stat = { dev: 1n, ino: 2n, birthtimeNs: 3n };
    assert.equal(sameFileIdentity(stat, { dev: 1n, ino: 2n }), true);
    assert.equal(sameFileIdentity(stat, { dev: 1n, ino: 2n, birthtimeNs: 3n }), true);
    assert.equal(sameFileIdentity(stat, { dev: 1n, ino: 2n, birthtimeNs: 4n }), false);
    assert.equal(sameFileIdentity({ dev: 1n, ino: 2n }, { dev: 1n, ino: 2n, birthtimeNs: 3n }), false);
    assert.equal(sameFileIdentity(stat, { dev: 9n, ino: 2n, birthtimeNs: 3n }), false);
    assert.equal(sameFileIdentity(stat, { dev: 1n, ino: 9n, birthtimeNs: 3n }), false);
});

test('identity-checked writes refuse a file at the same inode with another creation time', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-file-identity-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'chat.jsonl');
    fs.writeFileSync(filename, 'original');
    const stat = fs.lstatSync(filename, { bigint: true });
    const identity = { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
    const other = { ...identity, birthtimeNs: stat.birthtimeNs + 1n };
    assert.throws(() => tryWriteFileSync(filename, 'in place', 'utf8', { preserveFileIdentity: true, expectedFileIdentity: other }), { code: 'ESTALE' });
    assert.throws(() => tryWriteFileSync(filename, 'replaced', 'utf8', { replaceFileOnly: true, expectedFileIdentity: other }), { code: 'ESTALE' });
    assert.equal(fs.readFileSync(filename, 'utf8'), 'original');
    tryWriteFileSync(filename, 'in place', 'utf8', { preserveFileIdentity: true, expectedFileIdentity: identity });
    assert.equal(fs.readFileSync(filename, 'utf8'), 'in place');
});
