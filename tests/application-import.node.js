import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { test } from 'node:test';
import archiver from 'archiver';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { retainUploadedArchive, capturedArchiveInput, readUploadedArchive } = await import('../src/operations/input-files.js');
const { captureFolderImport, captureZipImport, openCapturedZipEntry, openImportArchive } = await import('../src/operations/account-import-sources.js');
const { roleplayStoreDirectory, resetRoleplayAccount } = await import('../src/roleplay-store.js');
const { captureAccountImport } = await import('../src/operations/account-import.js');
const { admitOperation, finalizeOperation, readOperation } = await import('../src/operations/store.js');
const { runOperation, acceptApplicationOperation } = await import('../src/operations/jobs.js');
const { write: writeCard, read: readCard } = await import('../src/character-card-parser.js');
const { getJob, updateJob, recoverJobs } = await import('../src/jobs/store.js');
const { stageImportBatch } = await import('../src/operations/import-batches.js');
const { prepareBinaryOutput } = await import('../src/operations/binary-files.js');

function setup(t, owner = 'fixture') {
    const f = fixture(t, false, owner);
    const base = { owner, directories: f.scope.directories };
    const sourceRoot = path.join(path.dirname(base.directories.root), `source-${owner}`);
    fs.mkdirSync(sourceRoot);
    return { f, base, sourceRoot };
}

function sourceFile(p, relative, content) {
    const filename = path.join(p.sourceRoot, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
    return filename;
}

test('cached plan verification still refuses a changed saved import plan', async t => {
    const p = setup(t);
    sourceFile(p, 'settings.json', JSON.stringify({ name1: 'Imported' }));
    await accept(p, 'cached-plan');
    const record = readOperation(p.base, 'cached-plan');
    assert.deepEqual(readOperation(p.base, 'cached-plan').plan, record.plan);
    const directory = path.join(roleplayStoreDirectory(p.base), 'operations');
    const filename = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json')));
    record.plan.files[0].relative = 'secrets.json';
    fs.writeFileSync(filename, JSON.stringify(record));
    assert.throws(() => readOperation(p.base, 'cached-plan'), /record needs recovery/);
});

async function accept(p, key, input = { mode: 'folder', path: p.sourceRoot }, defaults = { directories: [], files: [] }) {
    const plan = await captureAccountImport(p.base, p.f.scope, input, { defaults });
    const accepted = admitOperation(p.base, p.f.scope, { key, kind: 'account-import', input, plan, label: 'Import fixture', applyTarget: { kind: 'account', id: 'import' } });
    finalizeOperation({ ...p.base, job: accepted.job });
    return { ...accepted, context: { ...p.base, job: accepted.job, signal: new AbortController().signal, progress: async () => {} } };
}

test('extension sync retains manifest diagnostics and native-name shadowing with the accepted files', async t => {
    const p = setup(t);
    sourceFile(p, 'extensions/Good/manifest.json', JSON.stringify({ display_name: 'Good extension', version: '1.2', author: 'Owner', js: 'index.js' }));
    sourceFile(p, 'extensions/Good/index.js', 'export const good = true;');
    sourceFile(p, 'extensions/Good/.git/config', 'Private Git configuration');
    sourceFile(p, 'extensions/Broken/manifest.json', JSON.stringify({ js: '../Good/index.js' }));
    sourceFile(p, 'extensions/Neconyan-Hopper/manifest.json', JSON.stringify({ js: 'index.js' }));
    sourceFile(p, 'extensions/Neconyan-Hopper/index.js', 'export const inactive = true;');
    const accepted = await accept(p, 'extensions-report', { mode: 'extensions', path: p.sourceRoot });
    await runOperation(accepted.context, { afterImportInputs: () => fs.rmSync(p.sourceRoot, { recursive: true }) });
    const result = readOperation(p.base, 'extensions-report').result;
    assert.equal(result.readyCount, 1); assert.equal(result.warningCount, 1); assert.equal(result.shadowedCount, 1);
    assert.equal(result.gitMetadataSkippedCount, 1);
    assert.equal(result.results.find(row => row.name === 'Good').version, '1.2');
    assert.equal(result.results.find(row => row.name === 'Broken').checks.jsEntryExists, false);
    assert.equal(result.results.find(row => row.name === 'Neconyan-Hopper').shadowedByNative, true);
    assert.equal(fs.existsSync(path.join(p.base.directories.root, 'extensions/Good/.git/config')), false);
});

test('lost upload readback recognises only its recorded published file and its owning account', async t => {
    const p = setup(t, 'alice'); const bob = setup(t, 'bob');
    const filename = sourceFile(p, 'uploaded.zip', Buffer.from('Retained upload fixture'));
    assert.equal(readUploadedArchive(p.base, p.f.scope, 'upload'), null);
    const retained = await retainUploadedArchive(p.base, p.f.scope, 'upload', filename);
    const allocation = path.join(roleplayStoreDirectory(p.base), 'application-inputs', retained.id + '.json');
    const value = JSON.parse(fs.readFileSync(allocation)); value.state = 'pending';
    fs.writeFileSync(allocation, JSON.stringify(value));
    fs.unlinkSync(filename);
    assert.equal(readUploadedArchive(p.base, p.f.scope, 'upload').id, retained.id);
    assert.equal(JSON.parse(fs.readFileSync(allocation)).state, 'complete');
    assert.equal(readUploadedArchive(bob.base, bob.f.scope, 'upload'), null);
    fs.writeFileSync(retained.filename, 'Later replacement');
    assert.throws(() => readUploadedArchive(p.base, p.f.scope, 'upload'), /replaced|incomplete/);
    assert.equal(fs.readFileSync(retained.filename, 'utf8'), 'Later replacement');
});

test('whole folder import validates retained inputs before replacing chats, cards, settings and large files', async t => {
    const p = setup(t);
    const settings = path.join(p.base.directories.root, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ _version: 9, _settingsRevision: 5, name1: 'Current' }));
    const originalChat = fs.readFileSync(p.f.filename);
    const originalCard = fs.readFileSync(path.join(p.base.directories.characters, 'Nova.png'));
    const rows = structuredClone(p.f.records);
    rows[0].chat_metadata.neconyan_roleplay = { importedMarker: true };
    rows[2].mes = 'Selected imported alternative'; rows[2].swipes = ['Imported first', rows[2].mes]; rows[2].swipe_id = 1;
    rows[2].swipe_info = [{ extra: { reasoning: 'First imported reason' } }, { extra: { reasoning: 'Selected imported reason' } }];
    sourceFile(p, 'settings.json', JSON.stringify({ _version: 1, _settingsRevision: 1, name1: 'Imported' }));
    sourceFile(p, 'characters/Nova.png', writeCard(png, JSON.stringify({ name: 'Nova', description: 'Imported card', data: { name: 'Nova', description: 'Imported card', extensions: { kept: true } } })));
    sourceFile(p, 'chats/Nova/Source.jsonl', rows.map(row => JSON.stringify(row)).join('\n'));
    const large = Buffer.alloc(2 * 1024 * 1024 + 31, 77);
    sourceFile(p, 'user/files/large.bin', large);
    const accepted = await accept(p, 'whole');
    await runOperation(accepted.context, { afterImportInputs() {
        assert.deepEqual(fs.readFileSync(p.f.filename), originalChat);
        assert.deepEqual(fs.readFileSync(path.join(p.base.directories.characters, 'Nova.png')), originalCard);
        assert.equal(JSON.parse(fs.readFileSync(settings)).name1, 'Current');
        fs.rmSync(p.sourceRoot, { recursive: true });
    } });
    const imported = fs.readFileSync(p.f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(imported.slice(1), rows.slice(1));
    assert.equal(imported[0].unknown, true);
    assert.equal(imported[0].chat_metadata.neconyan_roleplay.importedMarker, undefined);
    assert.equal(JSON.parse(readCard(fs.readFileSync(path.join(p.base.directories.characters, 'Nova.png')))).data.description, 'Imported card');
    assert.deepEqual(fs.readFileSync(path.join(p.base.directories.root, 'user/files/large.bin')), large);
    const saved = JSON.parse(fs.readFileSync(settings));
    assert.equal(saved.name1, 'Imported'); assert.equal(saved._version, 10); assert.equal(saved._settingsRevision, 6);
    fs.unlinkSync(p.f.filename);
    await runOperation(accepted.context);
    assert.equal(fs.existsSync(p.f.filename), false);
    fs.rmSync(path.join(p.base.directories.root, 'jobs'), { recursive: true });
    const duplicate = await acceptApplicationOperation({ user: { profile: { handle: p.base.owner }, directories: p.base.directories }, get: () => undefined },
        { key: 'whole', kind: 'account-import', mode: 'folder', path: p.sourceRoot });
    assert.equal(duplicate.job, null);
    assert.equal(duplicate.record.state, 'completed');
});

test('invalid imported history and later destination edits refuse before any replacement', async t => {
    const p = setup(t);
    const original = fs.readFileSync(p.f.filename);
    sourceFile(p, 'chats/Nova/Source.jsonl', 'not valid JSON');
    sourceFile(p, 'user/files/new.txt', 'Must not be published');
    const bad = await accept(p, 'invalid');
    await assert.rejects(runOperation(bad.context), /needs recovery/);
    assert.deepEqual(fs.readFileSync(p.f.filename), original);
    assert.equal(fs.existsSync(path.join(p.base.directories.root, 'user/files/new.txt')), false);
    assert.equal(readOperation(p.base, 'invalid').state, 'refused');
    sourceFile(p, 'chats/Nova/Source.jsonl', original);
    const late = await accept(p, 'late-edit');
    fs.writeFileSync(p.f.filename, Buffer.concat([original, Buffer.from('\n{"name":"User","is_user":true,"mes":"Newer message"}') ]));
    await assert.rejects(runOperation(late.context), /destination changed/);
    assert.match(fs.readFileSync(p.f.filename, 'utf8'), /Newer message/);
    assert.equal(fs.existsSync(path.join(p.base.directories.root, 'user/files/new.txt')), false);
});

test('published chat and card receipts recover without resurrecting later deletions', async t => {
    for (const kind of ['chat', 'character']) {
        const p = setup(t, kind);
        const relative = kind === 'chat' ? 'chats/Nova/Source.jsonl' : 'characters/Nova.png';
        const destination = path.join(p.base.directories.root, relative);
        sourceFile(p, relative, kind === 'chat' ? p.f.records.map(row => JSON.stringify(row)).join('\n') : writeCard(png, JSON.stringify({ name: 'Nova', description: 'New' })));
        const accepted = await accept(p, 'interrupted');
        await assert.rejects(runOperation(accepted.context, { afterImportPublication() { throw new Error('lost publication acknowledgement'); } }), /lost publication/);
        fs.unlinkSync(destination);
        fs.rmSync(p.sourceRoot, { recursive: true });
        await runOperation(accepted.context);
        assert.equal(fs.existsSync(destination), false);
        assert.equal(readOperation(p.base, 'interrupted').state, 'completed');
    }
});

test('ordinary publication recovery refuses a later replacement and preserves all other pending files', async t => {
    const p = setup(t);
    fs.mkdirSync(path.join(p.sourceRoot, 'characters'));
    sourceFile(p, 'user/files/a.txt', 'Imported A'); sourceFile(p, 'user/files/b.txt', 'Imported B');
    const accepted = await accept(p, 'ordinary');
    await assert.rejects(runOperation(accepted.context, { afterImportPublication() { throw new Error('lost rename acknowledgement'); } }), /lost rename/);
    const a = path.join(p.base.directories.root, 'user/files/a.txt');
    fs.unlinkSync(a); fs.writeFileSync(a, 'Newer A');
    await assert.rejects(runOperation(accepted.context), /destination changed/);
    assert.equal(fs.readFileSync(a, 'utf8'), 'Newer A');
    assert.equal(fs.existsSync(path.join(p.base.directories.root, 'user/files/b.txt')), false);
});

test('ZIP import and missing bundled defaults are retained before source removal', async t => {
    const p = setup(t); const upload = path.join(p.sourceRoot, 'source.zip');
    await zipFile(upload, [['data/default-user/chats/Nova/New.jsonl', p.f.records.map(row => JSON.stringify(row)).join('\n')], ['data/default-user/user/files/new.txt', 'From ZIP']]);
    const input = await retainUploadedArchive(p.base, p.f.scope, 'zip-operation', upload);
    const defaults = { directories: ['themes'], files: [{ relative: 'themes/Default.json', data: Buffer.from('{"name":"Default"}').toString('base64') }] };
    const accepted = await accept(p, 'zip-operation', { mode: 'zip', inputId: input.id }, defaults);
    fs.unlinkSync(upload);
    await runOperation(accepted.context);
    assert.equal(fs.readFileSync(path.join(p.base.directories.root, 'user/files/new.txt'), 'utf8'), 'From ZIP');
    assert.equal(JSON.parse(fs.readFileSync(path.join(p.base.directories.root, 'themes/Default.json'))).name, 'Default');
    assert.deepEqual(fs.readFileSync(path.join(p.base.directories.chats, 'Nova/New.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).slice(1), p.f.records.slice(1));
});

test('extension replacement keeps old files until new files are durable and never repeats completed deletions', async t => {
    const p = setup(t);
    sourceFile(p, 'extensions/Example/index.js', 'New extension');
    const target = path.join(p.base.directories.root, 'extensions/Example');
    fs.mkdirSync(path.join(target, '.git'), { recursive: true });
    fs.writeFileSync(path.join(target, 'index.js'), 'Old extension'); fs.writeFileSync(path.join(target, 'obsolete.js'), 'Old helper');
    fs.writeFileSync(path.join(target, '.git/config'), 'Keep local metadata');
    const accepted = await accept(p, 'extensions', { mode: 'extensions', path: p.sourceRoot });
    await runOperation(accepted.context, { afterImportPublication() {
        assert.equal(fs.readFileSync(path.join(target, 'obsolete.js'), 'utf8'), 'Old helper');
    } });
    assert.equal(fs.readFileSync(path.join(target, 'index.js'), 'utf8'), 'New extension');
    assert.equal(fs.existsSync(path.join(target, 'obsolete.js')), false);
    assert.equal(fs.readFileSync(path.join(target, '.git/config'), 'utf8'), 'Keep local metadata');
    fs.writeFileSync(path.join(target, 'obsolete.js'), 'Later helper');
    await runOperation(accepted.context);
    assert.equal(fs.readFileSync(path.join(target, 'obsolete.js'), 'utf8'), 'Later helper');
});

async function zipFile(filename, entries, options = {}) {
    const output = fs.createWriteStream(filename);
    const done = finished(output);
    const zip = archiver('zip', options);
    zip.on('error', error => output.destroy(error));
    zip.pipe(output);
    for (const [name, bytes] of entries) zip.append(bytes, { name });
    await zip.finalize(); await done;
}

test('uploaded ZIP inputs are immutable, account-bound and shared by identical lost-ack submissions', async t => {
    const p = setup(t);
    const upload = path.join(p.sourceRoot, 'upload.zip');
    await zipFile(upload, [['data/default-user/settings.json', '{"name1":"Imported"}'], ['data/default-user/chats/Nova/Imported.jsonl', 'saved chat bytes']]);
    const original = fs.readFileSync(upload);
    const [first, second] = await Promise.all([retainUploadedArchive(p.base, p.f.scope, 'zip', upload), retainUploadedArchive(p.base, p.f.scope, 'zip', upload)]);
    assert.deepEqual(second, first);
    assert.equal(first.filename.startsWith(roleplayStoreDirectory(p.base) + path.sep), true);
    fs.unlinkSync(upload);
    assert.deepEqual(fs.readFileSync(capturedArchiveInput(p.base, p.f.scope, first.id).filename), original);
    const plan = await captureZipImport(first);
    assert.deepEqual(plan.files.map(file => file.relative), ['settings.json', 'chats/Nova/Imported.jsonl']);
    const stream = await openCapturedZipEntry(first, plan.files[1].zip);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'saved chat bytes');
    fs.writeFileSync(upload, 'different upload');
    await assert.rejects(retainUploadedArchive(p.base, p.f.scope, 'zip', upload), /different upload/);
    assert.deepEqual(fs.readFileSync(first.filename), original);
    resetRoleplayAccount(p.base, p.f.scope, 'reset');
    assert.throws(() => capturedArchiveInput(p.base, p.f.scope, first.id), /account/i);
    assert.equal(fs.existsSync(first.filename), true);
});

test('retained upload corruption refuses new work without deleting earlier evidence', async t => {
    const p = setup(t); const upload = path.join(p.sourceRoot, 'one.zip');
    await zipFile(upload, [['settings.json', '{}']]);
    const first = await retainUploadedArchive(p.base, p.f.scope, 'first', upload);
    const allocation = first.filename.replace(/\.zip$/, '.json');
    fs.writeFileSync(allocation, 'damaged record');
    await assert.rejects(retainUploadedArchive(p.base, p.f.scope, 'second', upload), /needs recovery/);
    assert.equal(fs.readFileSync(allocation, 'utf8'), 'damaged record');
    assert.equal(fs.existsSync(first.filename), true);
});

test('ZIP capture rejects duplicate destinations before account files are changed', async t => {
    const p = setup(t); const upload = path.join(p.sourceRoot, 'duplicates.zip');
    await zipFile(upload, [['settings.json', '{}'], ['settings.json', '{"later":true}']]);
    const source = await retainUploadedArchive(p.base, p.f.scope, 'duplicate', upload);
    const original = fs.readFileSync(p.f.filename);
    await assert.rejects(captureZipImport(source), /duplicate file destinations/);
    assert.deepEqual(fs.readFileSync(p.f.filename), original);
});

test('folder capture uses the data allowlist, excludes protected records and refuses links', t => {
    const p = setup(t);
    fs.mkdirSync(path.join(p.sourceRoot, 'characters'));
    fs.writeFileSync(path.join(p.sourceRoot, 'settings.json'), '{}');
    fs.mkdirSync(path.join(p.sourceRoot, 'hopper'));
    fs.writeFileSync(path.join(p.sourceRoot, 'hopper/store.json'), '{"private":"proof"}');
    fs.mkdirSync(path.join(p.sourceRoot, 'extensions/Example/.git'), { recursive: true });
    fs.writeFileSync(path.join(p.sourceRoot, 'extensions/Example/index.js'), 'extension bytes');
    fs.writeFileSync(path.join(p.sourceRoot, 'extensions/Example/.git/config'), 'git metadata');
    const staleLock = path.join(p.sourceRoot, 'characters', `.neconyan-chat-${'a'.repeat(64)}.lock`);
    fs.mkdirSync(staleLock);
    fs.writeFileSync(staleLock + '.owner', '{"pid":123}');
    const captured = captureFolderImport(p.base, p.sourceRoot);
    assert.deepEqual(captured.files.map(file => file.relative), ['settings.json', 'extensions/Example/index.js']);
    assert.throws(() => captureFolderImport(p.base, p.base.directories.root), /belongs to this account/);
    fs.symlinkSync(p.f.filename, path.join(p.sourceRoot, 'characters/linked.png'));
    assert.throws(() => captureFolderImport(p.base, p.sourceRoot), /Linked or special/);
    assert.equal(fs.readFileSync(path.join(p.sourceRoot, 'hopper/store.json'), 'utf8'), '{"private":"proof"}');
});

test('ZIP entries are checked for payload corruption and changes while the archive is open', async t => {
    const p = setup(t); const upload = path.join(p.sourceRoot, 'stored.zip');
    await zipFile(upload, [['settings.json', '{"name1":"Original"}']], { store: true });
    const raw = fs.readFileSync(upload);
    raw[raw.indexOf(Buffer.from('Original'))] = 'X'.charCodeAt(0);
    fs.writeFileSync(upload, raw);
    const source = await retainUploadedArchive(p.base, p.f.scope, 'corrupt-payload', upload);
    const captured = await captureZipImport(source);
    const archive = await openImportArchive(source);
    t.after(() => archive.close());
    await assert.rejects(archive.read(captured.files[0].zip, 1024), /damaged file/);
    fs.appendFileSync(source.filename, 'changed');
    await assert.rejects(archive.read(captured.files[0].zip, 1024), /retained ZIP changed/);
});

test('an import interrupted before publication is automatically queued and finishes from its saved ZIP', async t => {
    for (const stage of ['Checking chats, characters and settings', 'Preparing imported files', 'Saving imported files']) {
        const p = setup(t, stage.split(' ')[0]); const upload = path.join(p.sourceRoot, 'resume.zip');
        await zipFile(upload, [['settings.json', '{"name1":"Resumed"}'], ['user/files/one.txt', 'Retained bytes']]);
        const input = await retainUploadedArchive(p.base, p.f.scope, 'resume', upload);
        const accepted = await accept(p, 'resume', { mode: 'zip', inputId: input.id });
        fs.rmSync(p.sourceRoot, { recursive: true });
        updateJob(p.base.directories, accepted.job.id, { state: 'running' });
        await assert.rejects(runOperation({ ...accepted.context, progress: async progress => {
            if (progress.stage === stage && (stage !== 'Preparing imported files' || progress.completed === progress.total)) throw new Error('simulated process stop');
        } }), /simulated process stop/);
        assert.equal(getJob(p.base.directories, accepted.job.id).resume, 'account-import');
        await recoverJobs(p.base.directories);
        assert.equal(getJob(p.base.directories, accepted.job.id).state, 'queued');
        await runOperation(accepted.context);
        assert.equal(readOperation(p.base, 'resume').state, 'completed');
        assert.equal(JSON.parse(fs.readFileSync(path.join(p.base.directories.root, 'settings.json'))).name1, 'Resumed');
        assert.equal(fs.readFileSync(path.join(p.base.directories.root, 'user/files/one.txt'), 'utf8'), 'Retained bytes');
    }
});

test('ZIP import recovers a rename made before the batch acknowledgement without making extra input copies', async t => {
    const p = setup(t); const upload = path.join(p.sourceRoot, 'rename.zip');
    await zipFile(upload, Array.from({ length: 40 }, (_, index) => [`user/files/${index}.txt`, `File ${index}`]), { store: true });
    const input = await retainUploadedArchive(p.base, p.f.scope, 'rename', upload);
    const accepted = await accept(p, 'rename', { mode: 'zip', inputId: input.id });
    await assert.rejects(runOperation(accepted.context, { afterImportPublication({ index }) {
        if (index === 5) throw new Error('lost batch acknowledgement');
    } }), /lost batch acknowledgement/);
    const first = path.join(p.base.directories.root, 'user/files/0.txt');
    const inode = fs.statSync(first).ino;
    await runOperation(accepted.context);
    assert.equal(fs.statSync(first).ino, inode);
    for (let index = 0; index < 40; index++) assert.equal(fs.readFileSync(path.join(p.base.directories.root, `user/files/${index}.txt`), 'utf8'), `File ${index}`);
    const record = readOperation(p.base, 'rename');
    assert.equal(Object.keys(record.effects).some(key => key.startsWith('binary:')), false);
    assert.equal(record.effects['import-publish'].state, 'done');
});

test('chat content larger than the old combined record limit imports with a small saved operation', async t => {
    const p = setup(t); const upload = path.join(p.sourceRoot, 'large-chats.zip');
    const message = 'Large imported message. '.repeat(Math.ceil(5 * 1024 * 1024 / 24));
    const entries = Array.from({ length: 8 }, (_, index) => [`chats/Nova/Large${index}.jsonl`, [
        { user_name: 'User', character_name: 'Nova', chat_metadata: {} },
        { name: 'Nova', is_user: false, mes: message },
    ].map(JSON.stringify).join('\n')]);
    await zipFile(upload, entries);
    entries.length = 0;
    const input = await retainUploadedArchive(p.base, p.f.scope, 'large', upload);
    const accepted = await accept(p, 'large', { mode: 'zip', inputId: input.id });
    await runOperation(accepted.context);
    for (let index = 0; index < 8; index++) {
        const rows = fs.readFileSync(path.join(p.base.directories.chats, `Nova/Large${index}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(rows[1].mes, message);
    }
    const record = readOperation(p.base, 'large');
    assert.equal(record.state, 'completed');
    assert.ok(Buffer.byteLength(JSON.stringify(record)) < 64 * 1024, 'Chat contents must not accumulate inside the operation record');
});

test('a prepared temporary file lost before its contents were durable is recreated from the saved ZIP', async t => {
    const p = setup(t); const upload = path.join(p.sourceRoot, 'temporary.zip');
    await zipFile(upload, [['user/files/one.txt', 'Retained bytes']]);
    const input = await retainUploadedArchive(p.base, p.f.scope, 'temporary', upload);
    const accepted = await accept(p, 'temporary', { mode: 'zip', inputId: input.id });
    const file = accepted.record.plan.files[0];
    await assert.rejects(stageImportBatch(accepted.context, [{ file, index: 0 }], { prepared: {}, archive: {
        open: async () => { throw new Error('stopped before copying'); },
    } }), /stopped before copying/);
    const effect = readOperation(p.base, 'temporary').effects['stage:0'];
    assert.equal(effect.state, 'prepared');
    fs.unlinkSync(path.join(p.base.directories.root, effect.temporary));
    await runOperation(accepted.context);
    assert.equal(fs.readFileSync(path.join(p.base.directories.root, file.relative), 'utf8'), 'Retained bytes');
});

test('an older import stopped while retaining inputs upgrades without changing its accepted plan', async t => {
    const p = setup(t); const upload = path.join(p.sourceRoot, 'older.zip');
    await zipFile(upload, [['settings.json', '{"name1":"Recovered older import"}'], ['user/files/one.txt', 'Retained bytes']]);
    const archive = await retainUploadedArchive(p.base, p.f.scope, 'older', upload);
    const input = { mode: 'zip', inputId: archive.id };
    const plan = await captureAccountImport(p.base, p.f.scope, input, { defaults: { directories: [], files: [] } });
    delete plan.pipeline;
    const accepted = admitOperation(p.base, p.f.scope, { key: 'older', kind: 'account-import', input, plan, label: 'Older import' });
    const context = { ...p.base, job: accepted.job, signal: new AbortController().signal, progress: async () => {} };
    finalizeOperation(context);
    prepareBinaryOutput(context, 'import:0', plan.files[0].size);
    await assert.rejects(runOperation(context, { afterImportStaged: () => { throw new Error('stop again after preparing'); } }), /stop again/);
    await runOperation(context);
    const record = readOperation(p.base, 'older');
    assert.deepEqual(record.plan, plan);
    assert.equal(record.state, 'completed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(p.base.directories.root, 'settings.json'))).name1, 'Recovered older import');
});
