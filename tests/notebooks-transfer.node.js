import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { unzipSync } from 'fflate';
import { fixture } from './roleplay-transactions-fixture.js';

const { withRoleplayAccount } = await import('../src/roleplay-store.js');
const store = await import('../src/notebooks/store.js');
const transfer = await import('../src/notebooks/transfer.js');
const attachments = await import('../src/notebooks/attachments.js');
const { publicPolicy, effectiveAssistantAccess, contextPolicy } = await import('../src/notebooks/permissions.js');

let counter = 0;
const op = label => `transfer:${label}:${++counter}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function prepared(t, owner = 'transfer-owner') {
    const f = fixture(t, false, owner);
    const run = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const notebook = run(lease => store.ensureDefaultNotebookLocked(lease));
    return { f, run, owner: f.scope.owner, notebookId: notebook.id, root: f.scope.directories.root };
}

/** Minimal ZIP writer so tests can build archives no honest tool would make. */
function zip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const data = Buffer.from(entry.data ?? '');
        const compressed = entry.deflate ? zlib.deflateRawSync(data) : data;
        const method = entry.deflate ? 8 : 0;
        const crc = transfer.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(entry.flags ?? 0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(entry.declaredSize ?? data.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, compressed);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(entry.madeBy ?? (3 << 8) | 20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(entry.flags ?? 0, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(entry.declaredSize ?? data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += 30 + name.length + compressed.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

function rejects(owner, archive, code) {
    assert.throws(() => transfer.stageImport(owner, { filename: 'evil.zip', bytes: archive }), error => error.code === code);
}

test('unsafe archives are rejected before anything is written', t => {
    const { owner, root } = prepared(t);
    rejects(owner, zip([{ name: '../escape.md', data: 'x' }]), 'IMPORT_UNSAFE_ENTRY');
    rejects(owner, zip([{ name: '/etc/passwd.md', data: 'x' }]), 'IMPORT_UNSAFE_ENTRY');
    rejects(owner, zip([{ name: 'C:/Windows/a.md', data: 'x' }]), 'IMPORT_UNSAFE_ENTRY');
    rejects(owner, zip([{ name: 'a\\..\\b.md', data: 'x' }]), 'IMPORT_UNSAFE_ENTRY');
    rejects(owner, zip([{ name: 'link.md', data: '/etc/passwd', mode: 0o120777 }]), 'IMPORT_UNSAFE_ENTRY');
    rejects(owner, zip([{ name: 'a.md', data: 'x' }, { name: 'a.md', data: 'y' }]), 'IMPORT_UNSAFE_ENTRY');
    rejects(owner, zip([{ name: 'secret.md', data: 'x', flags: 1 }]), 'IMPORT_ARCHIVE_INVALID');
    rejects(owner, zip([{ name: `${'d/'.repeat(30)}deep.md`, data: 'x' }]), 'IMPORT_UNSAFE_ENTRY');
    const bomb = Buffer.alloc(8 * 1024 * 1024, 0x61);
    rejects(owner, zip([{ name: 'bomb.md', data: bomb, deflate: true }]), 'IMPORT_UNSAFE_ENTRY');
    rejects(owner, zip([{ name: 'big.md', data: 'x', declaredSize: 300 * 1024 * 1024 }]), 'IMPORT_TOO_LARGE');
    rejects(owner, zip([{ name: 'liar.md', data: 'hello', declaredSize: 4 }]), 'IMPORT_ARCHIVE_INVALID');
    rejects(owner, Buffer.from('not a zip at all, honestly'), 'IMPORT_ARCHIVE_INVALID');
    assert.equal(fs.existsSync(path.join(root, 'notebooks')) ? fs.readdirSync(path.join(root, 'notebooks')).length : 0, 1);
});

test('import excludes application folders, hidden files and unknown types and reports collisions', t => {
    const { owner } = prepared(t);
    const summary = transfer.stageImport(owner, {
        filename: 'vault.zip',
        bytes: zip([
            { name: 'Vault/Inbox/Idea.md', data: '# Idea\n' },
            { name: 'Vault/Inbox/idea.md', data: '# other\n' },
            { name: 'Vault/.obsidian/plugins/evil/main.js', data: 'alert(1)' },
            { name: 'Vault/.hidden.md', data: 'x' },
            { name: 'Vault/run.exe', data: 'MZ' },
            { name: 'Vault/nested.zip', data: 'PK' },
            { name: 'Vault/attachments/pic.png', data: PNG },
            { name: 'Vault/attachments/fake.png', data: 'not an image' },
            { name: 'Vault/bad.md', data: Buffer.from([0xff, 0xfe, 0x00]) },
        ]),
    });
    assert.equal(summary.name, 'Vault');
    assert.deepEqual(summary.notes.map(note => note.path).sort(), ['Inbox/Idea.md', 'Inbox/idea 2.md']);
    assert.deepEqual(summary.attachments.map(item => item.path), ['attachments/pic.png']);
    const reasons = Object.fromEntries(summary.excluded.map(item => [item.path, item.reason]));
    assert.equal(reasons['.obsidian/plugins/evil/main.js'] ?? reasons['Vault/.obsidian/plugins/evil/main.js'], 'application-folder');
    assert.equal(reasons['Vault/.hidden.md'], 'hidden');
    assert.equal(reasons['Vault/run.exe'], 'unsupported-type');
    assert.equal(reasons['Vault/nested.zip'], 'nested-archive');
    assert.equal(reasons['attachments/fake.png'], 'type-mismatch');
    assert.equal(reasons['bad.md'], 'not-utf8');
    assert.deepEqual(summary.renamed, [{ from: 'Inbox/idea.md', to: 'Inbox/idea 2.md', reason: 'name-collision' }]);
});

test('export and import round-trip content while imported permissions stay inactive', t => {
    const { owner, run, notebookId } = prepared(t);
    run(lease => store.writePoliciesLocked(lease, notebookId, { ...store.readPoliciesLocked(lease, notebookId), assistant: 'edit', assistantPublish: true }));
    const source = '---\ntitle: Magic system\nneconyan_id: n_0123456789abcdef\ncustom:\n  nested: [1, 2]\n---\n# Magic system\n\n```js\nconst link = "[[Not a link]]";\n```\n\n%% obsidian comment %%\n![Harbour](../attachments/pic.png)\n';
    const note = run(lease => store.createNoteLocked(lease, { operationId: op('note'), notebookId, folder: 'Worldbuilding', title: 'Magic system', text: source }));
    const attachment = run(lease => attachments.saveAttachmentLocked(lease, { operationId: op('att'), notebookId, name: 'pic.png', bytes: PNG }));
    assert.equal(attachment.path, 'attachments/pic.png');

    const collected = run(lease => transfer.collectExportLocked(lease, { notebookId }));
    const archive = transfer.buildExportZip(collected);
    const unpacked = unzipSync(new Uint8Array(archive));
    const names = Object.keys(unpacked);
    assert.ok(names.includes('Notebook/Worldbuilding/Magic system.md'));
    assert.ok(names.includes('Notebook/attachments/pic.png'));
    assert.ok(!names.some(name => /policies|manifest|history|provenance|notebook-control/.test(name)));
    assert.equal(Buffer.from(unpacked['Notebook/Worldbuilding/Magic system.md']).toString('utf8'), source);

    const summary = transfer.stageImport(owner, { filename: 'Notebook.zip', bytes: archive });
    assert.equal(summary.notes[0].identityHint, 'n_0123456789abcdef');
    const committed = run(lease => transfer.commitImportLocked(lease, { operationId: op('import'), stageId: summary.stageId, name: 'Imported copy' }));
    assert.equal(committed.permissions, 'inactive');
    assert.notEqual(committed.notebook.id, notebookId);
    const importedId = committed.notebook.id;
    const policies = run(lease => store.readPoliciesLocked(lease, importedId));
    assert.equal(effectiveAssistantAccess(policies), 'none');
    assert.equal(publicPolicy(policies).admitted, false);
    assert.equal(publicPolicy(policies).assistantPublish, false);
    const state = run(lease => store.loadNotebookLocked(lease, importedId, { force: true }));
    const imported = state.entries.find(entry => entry.path === 'Worldbuilding/Magic system.md');
    assert.equal(imported.text, source);
    assert.equal(contextPolicy(policies, imported.id).mode, 'off');
    assert.ok(state.attachments.some(item => item.path === 'attachments/pic.png'));
    const original = run(lease => store.readNoteLocked(lease, { notebookId, noteId: note.noteId }));
    assert.equal(original.entry.text, source);

    const again = run(lease => transfer.commitImportLocked(lease, { operationId: committed.operationId, stageId: summary.stageId, name: 'Imported copy' }));
    assert.equal(again.replayed, true);
    assert.equal(run(lease => store.listNotebooksLocked(lease)).length, 2);
});

test('duplicate identity hints never claim an existing note', t => {
    const { owner, run } = prepared(t);
    const hint = '---\nneconyan_id: n_aaaaaaaaaaaaaaaa\n---\n';
    const summary = transfer.stageImport(owner, {
        filename: 'copies.zip',
        bytes: zip([{ name: 'A.md', data: `${hint}a` }, { name: 'B.md', data: `${hint}b` }]),
    });
    assert.ok(summary.notes.every(note => note.duplicateHint));
    const committed = run(lease => transfer.commitImportLocked(lease, { operationId: op('dup'), stageId: summary.stageId }));
    assert.equal(committed.reassigned.length, 2);
    const state = run(lease => store.loadNotebookLocked(lease, committed.notebook.id, { force: true }));
    const ids = state.entries.map(entry => entry.id);
    assert.equal(new Set(ids).size, 2);
    assert.ok(!ids.includes('n_aaaaaaaaaaaaaaaa'));
});

test('reimporting a changed export updates only selected notes with revision checks', t => {
    const { owner, run, notebookId } = prepared(t);
    const note = run(lease => store.createNoteLocked(lease, { operationId: op('n'), notebookId, folder: 'Inbox', title: 'Draft', text: 'one\n' }));
    const summary = transfer.stageImport(owner, {
        filename: 'Notebook.zip',
        bytes: zip([{ name: 'Notebook/Inbox/Draft.md', data: 'two\n' }, { name: 'Notebook/Inbox/New.md', data: 'new\n' }]),
    });
    const compared = run(lease => transfer.compareStageLocked(lease, { stageId: summary.stageId, notebookId }));
    assert.deepEqual(compared.notes.map(item => item.match.state).sort(), ['changed', 'new']);
    run(lease => store.updateNoteLocked(lease, {
        operationId: op('edit'), notebookId, noteId: note.noteId, expectedRevision: note.revision, changes: [{ type: 'replace_all', markdown: 'edited meanwhile\n' }],
    }));
    const result = run(lease => transfer.commitStageUpdateLocked(lease, {
        operationId: op('update'), stageId: summary.stageId, notebookId, paths: ['Inbox/Draft.md', 'Inbox/New.md'],
    }));
    const byPath = Object.fromEntries(result.results.map(item => [item.path, item.status]));
    assert.equal(byPath['Inbox/Draft.md'], 'conflict');
    assert.equal(byPath['Inbox/New.md'], 'created');
    const current = run(lease => store.readNoteLocked(lease, { notebookId, noteId: note.noteId }));
    assert.equal(current.entry.text, 'edited meanwhile\n');
});

test('attachments are validated, collision-safe and protected while referenced', t => {
    const { run, notebookId } = prepared(t);
    assert.throws(() => attachments.validateAttachment('evil.html', Buffer.from('<script>')), error => error.code === 'ATTACHMENT_TYPE_UNSUPPORTED');
    assert.throws(() => attachments.validateAttachment('fake.png', Buffer.from('nope')), error => error.code === 'ATTACHMENT_TYPE_MISMATCH');
    assert.equal(attachments.attachmentType('drawing.svg').inline, false);
    const first = run(lease => attachments.saveAttachmentLocked(lease, { operationId: op('a1'), notebookId, name: 'harbour.png', bytes: PNG }));
    const second = run(lease => attachments.saveAttachmentLocked(lease, { operationId: op('a2'), notebookId, name: 'Harbour.png', bytes: PNG }));
    assert.notEqual(first.path, second.path);
    run(lease => store.createNoteLocked(lease, { operationId: op('ref'), notebookId, title: 'Uses it', text: `![x](../${first.path})\n` }));
    assert.throws(() => run(lease => attachments.trashAttachmentLocked(lease, { operationId: op('t1'), notebookId, path: first.path })),
        error => error.code === 'ATTACHMENT_IN_USE');
    const trashed = run(lease => attachments.trashAttachmentLocked(lease, { operationId: op('t2'), notebookId, path: second.path }));
    assert.equal(trashed.status, 'success');
    assert.throws(() => run(lease => attachments.readAttachmentLocked(lease, { notebookId, path: second.path })), error => error.code === 'ATTACHMENT_NOT_FOUND');
    const read = run(lease => attachments.readAttachmentLocked(lease, { notebookId, path: first.path }));
    assert.equal(read.mime, 'image/png');
    assert.ok(read.bytes.equals(PNG));
});

test('one account cannot read another account notebook through ids', t => {
    const a = prepared(t, 'account-a');
    const b = prepared(t, 'account-b');
    const note = a.run(lease => store.createNoteLocked(lease, { operationId: op('priv'), notebookId: a.notebookId, title: 'Secret', text: 'private' }));
    assert.throws(() => b.run(lease => store.readNoteLocked(lease, { notebookId: a.notebookId, noteId: note.noteId })), error => error.status === 404);
});
