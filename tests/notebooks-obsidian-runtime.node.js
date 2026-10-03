import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { getConfig, setConfigFilePath } from '../src/util.js';
setConfigFilePath(new URL('../default/config.yaml', import.meta.url).pathname);
const { withRoleplayAccount } = await import('../src/roleplay-store.js');
const { ensureDefaultNotebookLocked, createNoteLocked, readPoliciesLocked, writePoliciesLocked, readManifestLocked, loadNotebookLocked, readHistoryLocked, readNoteLocked } = await import('../src/notebooks/store.js');
const { configureObsidianLocked, obsidianStatusLocked, startObsidian, stopObsidian, reconcileObsidian } = await import('../src/notebooks/obsidian.js');
const { obsidianHistoryLocked, obsidianHistoryFileLocked, readObsidianHistoryIndexLocked, recordObsidianFileLocked } = await import('../src/notebooks/obsidian-history.js');
const { prepareInWorker } = await import('../src/notebooks/preparation.js');
const { sha256 } = await import('../src/notebooks/paths.js');
const lore = await import('../src/notebooks/lore.js');
const { subscribeNotebookChanges } = await import('../src/notebooks/events.js');
let counter = 0;
const op = label => `obsidian-runtime:${label}:${++counter}`;

function prepared(t) {
    const config = getConfig();
    const original = config.notebooks?.obsidianHeadless;
    let base;
    let notebookId;
    t.after(async () => {
        if (base && notebookId) {
            try { await stopObsidian(base, notebookId); } catch { /* A deliberately replaced fixture folder can no longer be reconciled. */ }
        }
        config.notebooks.obsidianHeadless = original;
    });
    const f = fixture(t, false, 'obsidian-runtime-owner');
    base = f.scope;
    const run = operation => withRoleplayAccount(f.scope, f.scope, operation);
    notebookId = run(lease => ensureDefaultNotebookLocked(lease)).id;
    const ownNote = run(lease => createNoteLocked(lease, { operationId: op('note'), notebookId, folder: '', title: 'Own note', text: '# Original\nOwned content.', actor: 'owner' }));
    const executable = path.join(f.root, 'headless-fixture');
    const clientSource = fs.readFileSync(new URL('./notebooks-obsidian-cli-fixture.cjs', import.meta.url), 'utf8').replace(/^#![^\n]*\n/, '');
    fs.writeFileSync(executable, `#!${process.execPath}\n` + clientSource);
    fs.chmodSync(executable, 0o700);
    config.notebooks ??= {};
    config.notebooks.obsidianHeadless = { enabled: true, executable, allowedRoots: ['$ACCOUNT_ROOT/notebooks'], pollIntervalMs: 60000 };
    const folder = path.join(f.scope.directories.root, 'notebooks', notebookId);
    const bind = args => run(lease => configureObsidianLocked(lease, { operationId: op('configure'), notebookId, folder, expectedRevision: null, singleMechanism: true, actor: 'owner', ...args })).adapter;
    return { ...f, root: f.scope.directories.root, outerRoot: f.root, base, run, notebookId, folder, executable, config, bind, ownNote };
}

async function waitFor(predicate, message, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await delay(25);
    }
    assert.fail(message);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const clientPid = f => Number(fs.readFileSync(path.join(f.folder, '.fixture-client-pid'), 'utf8'));

test('an external change is kept in normal history without publishing a live lore binding', async t => {
    const f = prepared(t);
    f.bind();
    const changes = [];
    const unsubscribe = subscribeNotebookChanges(change => changes.push(change));
    t.after(unsubscribe);
    const worlds = path.join(f.root, 'worlds');
    fs.mkdirSync(worlds, { recursive: true });
    const world = path.join(worlds, 'Sync lore.json');
    fs.writeFileSync(world, JSON.stringify({ entries: { 3: { uid: 3, comment: 'Original rule', content: 'Older live text.', key: ['original'] } } }));
    const selector = { kind: 'note' };
    const preview = f.run(lease => lore.previewPublicationLocked(lease, { notebookId: f.notebookId, noteId: f.ownNote.noteId, selector, book: 'Sync lore', uid: 3 }));
    const published = f.run(lease => lore.publishToLoreLocked(lease, { operationId: op('publish'), notebookId: f.notebookId, noteId: f.ownNote.noteId,
        selector, book: 'Sync lore', uid: 3, expectedSourceHash: preview.sourceHash, expectedTargetHash: preview.targetHash }));
    f.run(lease => lore.setBindingPolicyLocked(lease, { operationId: op('live'), notebookId: f.notebookId, bindingId: published.bindingId, policy: 'live', liveOrigins: ['user'] }));
    const before = fs.readFileSync(world);
    const incoming = '# Original\r\nAn external change is a draft, not a published rule.\r\n';
    fs.writeFileSync(path.join(f.folder, 'Own note.md'), incoming);
    await reconcileObsidian(f.base, f.notebookId);
    const current = f.run(lease => readNoteLocked(lease, { notebookId: f.notebookId, noteId: f.ownNote.noteId })).entry;
    assert.equal(current.text, incoming);
    assert.deepEqual(fs.readFileSync(world), before);
    assert.equal(f.run(lease => readHistoryLocked(lease, f.notebookId, f.ownNote.noteId)).entries.at(-1).origin, 'external');
    assert.ok(changes.some(change => change.noteId === f.ownNote.noteId && change.revision === current.hash && change.kind === 'external'));
    assert.ok(!JSON.stringify(changes).includes(incoming));
});

test('only an explicitly approved existing owned folder can be registered, without starting or granting access', t => {
    const f = prepared(t);
    const initial = f.run(lease => obsidianStatusLocked(lease, f.notebookId)).adapter;
    assert.equal(initial.configured, false);
    assert.equal(initial.running, false);
    f.config.notebooks.obsidianHeadless.enabled = false;
    assert.throws(() => f.bind(), error => error.code === 'OBSIDIAN_DISABLED');
    f.config.notebooks.obsidianHeadless.enabled = true;
    assert.throws(() => f.bind({ folder: f.outerRoot }), error => error.code === 'OBSIDIAN_FOLDER_NOT_ALLOWED');
    assert.throws(() => f.bind({ singleMechanism: false }), error => error.code === 'OBSIDIAN_SINGLE_MECHANISM');
    f.config.notebooks.obsidianHeadless.allowedRoots = [];
    assert.throws(() => f.bind(), error => error.code === 'OBSIDIAN_FOLDER_NOT_ALLOWED');
    f.config.notebooks.obsidianHeadless.allowedRoots = ['$ACCOUNT_ROOT/notebooks'];
    const policy = f.run(lease => readPoliciesLocked(lease, f.notebookId));
    const bound = f.bind();
    assert.equal(bound.configured, true);
    assert.equal(bound.running, false);
    assert.equal(bound.folder, f.folder);
    assert.deepEqual(f.run(lease => readPoliciesLocked(lease, f.notebookId)), policy);
    assert.equal(f.run(lease => readManifestLocked(lease, f.notebookId)).externalImportsDeny, true);
    assert.throws(() => f.bind({ expectedRevision: null }), error => error.status === 409);
    assert.equal(fs.existsSync(path.join(f.folder, '.fixture-client-pid')), false);
});

test('approval also denies implicit access to already discovered external notes while preserving explicit owner choices', t => {
    const f = prepared(t);
    f.run(lease => {
        const policy = readPoliciesLocked(lease, f.notebookId);
        policy.assistant = 'edit';
        policy.assistantPublish = true;
        writePoliciesLocked(lease, f.notebookId, policy);
    });
    fs.writeFileSync(path.join(f.folder, 'Already incoming.md'), '# Imported before approval\nNo explicit permission.');
    fs.writeFileSync(path.join(f.folder, 'Owner approved.md'), '# Imported before approval\nExplicit owner choice.');
    const adopted = f.run(lease => loadNotebookLocked(lease, f.notebookId, { force: true }));
    const incoming = adopted.entries.find(entry => entry.path === 'Already incoming.md');
    const approved = adopted.entries.find(entry => entry.path === 'Owner approved.md');
    f.run(lease => {
        const policy = readPoliciesLocked(lease, f.notebookId);
        policy.notes[approved.id] = { assistant: 'read', context: { mode: 'pinned', scopes: [{ kind: 'global' }] } };
        writePoliciesLocked(lease, f.notebookId, policy);
    });
    f.bind();
    const policy = f.run(lease => readPoliciesLocked(lease, f.notebookId));
    assert.equal(policy.notes[incoming.id]?.assistant, 'none');
    assert.equal(policy.notes[incoming.id]?.context?.mode ?? 'off', 'off');
    assert.equal(policy.notes[approved.id].assistant, 'read');
    assert.equal(policy.notes[approved.id].context.mode, 'pinned');
    assert.equal(policy.assistant, 'edit');
    assert.equal(f.run(lease => readManifestLocked(lease, f.notebookId)).notes[f.ownNote.noteId].adopted, undefined);
    assert.equal(fs.existsSync(path.join(f.folder, '.fixture-client-pid')), false);
});

test('reconciliation records exact Markdown, binary attachment and Canvas changes and deletions without publishing or granting access', async t => {
    const f = prepared(t);
    f.bind();
    await reconcileObsidian(f.base, f.notebookId);
    const initialPolicy = f.run(lease => readPoliciesLocked(lease, f.notebookId));
    const originalPath = path.join(f.folder, 'Own note.md');
    const first = '# Changed\nExact external data.';
    fs.writeFileSync(originalPath, first);
    fs.writeFileSync(path.join(f.folder, 'Incoming.md'), '# Incoming\nassistant: edit is only text.');
    fs.writeFileSync(path.join(f.folder, 'Attachment.txt'), Buffer.from([0, 1, 2, 255]));
    fs.writeFileSync(path.join(f.folder, 'Plan.canvas'), '{"nodes":[],"future":{"keep":true}}\r\n');
    await reconcileObsidian(f.base, f.notebookId);
    const events = f.run(lease => obsidianHistoryLocked(lease, { notebookId: f.notebookId })).history;
    assert.ok(events.some(event => event.path === 'Own note.md' && event.kind === 'changed'));
    assert.ok(events.some(event => event.path === 'Attachment.txt' && event.kind === 'created'));
    const binaryEvent = events.find(event => event.path === 'Attachment.txt');
    assert.deepEqual(f.run(lease => obsidianHistoryFileLocked(lease, { notebookId: f.notebookId, historyId: binaryEvent.id })).bytes, Buffer.from([0, 1, 2, 255]));
    const state = f.run(lease => loadNotebookLocked(lease, f.notebookId));
    const incoming = state.entries.find(entry => entry.path === 'Incoming.md');
    assert.equal(f.run(lease => readPoliciesLocked(lease, f.notebookId)).notes[incoming.id].assistant, 'none');
    assert.equal(f.run(lease => readNoteLocked(lease, { notebookId: f.notebookId, noteId: f.ownNote.noteId })).entry.text, first);
    assert.ok(f.run(lease => readHistoryLocked(lease, f.notebookId, f.ownNote.noteId)).entries.some(entry => entry.origin === 'external'));
    const previous = fs.statSync(originalPath);
    const sameSize = first.replace('external', 'imported');
    assert.equal(Buffer.byteLength(sameSize), Buffer.byteLength(first));
    fs.writeFileSync(originalPath, sameSize);
    fs.utimesSync(originalPath, previous.atime, previous.mtime);
    await reconcileObsidian(f.base, f.notebookId);
    assert.equal(f.run(lease => readNoteLocked(lease, { notebookId: f.notebookId, noteId: f.ownNote.noteId })).entry.text, sameSize);
    fs.unlinkSync(path.join(f.folder, 'Attachment.txt'));
    await reconcileObsidian(f.base, f.notebookId);
    const deleted = f.run(lease => obsidianHistoryLocked(lease, { notebookId: f.notebookId })).history.find(event => event.path === 'Attachment.txt' && event.kind === 'deleted');
    assert.ok(deleted);
    assert.deepEqual(f.run(lease => obsidianHistoryFileLocked(lease, { notebookId: f.notebookId, historyId: deleted.id })).bytes, Buffer.from([0, 1, 2, 255]));
    assert.equal(f.run(lease => readPoliciesLocked(lease, f.notebookId)).assistant, initialPolicy.assistant);
});

test('hidden Headless metadata and plugin files are excluded, not treated as unsafe content', async t => {
    const f = prepared(t);
    const plugins = path.join(f.folder, '.obsidian', 'plugins');
    fs.mkdirSync(plugins, { recursive: true });
    fs.writeFileSync(path.join(plugins, 'untrusted.js'), 'throw new Error("never execute imported plugins");');
    fs.writeFileSync(path.join(f.folder, '.obsidian', 'settings.json'), '{"assistant":"edit"}');
    const snapshot = await prepareInWorker('sync-snapshot', { contentRoot: f.folder });
    assert.deepEqual(snapshot.paths, ['Own note.md']);
    assert.ok(!JSON.stringify(snapshot).includes('untrusted'));
});

test('status does not silently approve a replacement of the bound physical folder', t => {
    const f = prepared(t);
    f.bind();
    fs.renameSync(f.folder, f.folder + '-moved');
    fs.mkdirSync(f.folder);
    assert.throws(() => f.run(lease => obsidianStatusLocked(lease, f.notebookId)), error => error.code === 'OBSIDIAN_FOLDER_CHANGED');
});

test('the snapshot cache cannot hide hard links, symlinks or changes with a restored timestamp', async t => {
    const f = prepared(t);
    f.bind();
    const snapshot = await prepareInWorker('sync-snapshot', { contentRoot: f.folder });
    const file = snapshot.files.find(file => file.path === 'Own note.md');
    const known = { [file.path]: { hash: file.hash, stat: file.stat } };
    fs.linkSync(path.join(f.folder, file.path), path.join(f.outerRoot, 'Unowned alias.md'));
    await assert.rejects(prepareInWorker('sync-snapshot', { contentRoot: f.folder, known }), error => error.code === 'OBSIDIAN_UNSAFE_FILES');
    fs.unlinkSync(path.join(f.outerRoot, 'Unowned alias.md'));
    fs.symlinkSync(path.join(f.outerRoot, 'none'), path.join(f.folder, 'Link.md'));
    await assert.rejects(prepareInWorker('sync-snapshot', { contentRoot: f.folder, known }), error => error.code === 'OBSIDIAN_UNSAFE_FILES');
});

test('the adapter starts one network-free prepared stand-in with only official status and sync commands, then stops exactly that client', async t => {
    const f = prepared(t);
    const bound = f.bind();
    const started = await startObsidian(f.base, { notebookId: f.notebookId, operationId: op('start'), expectedRevision: bound.revision });
    assert.equal(started.adapter.running, true);
    const pid = clientPid(f);
    assert.ok(alive(pid));
    const commands = fs.readFileSync(path.join(path.dirname(f.folder), `.obsidian-test-${path.basename(f.folder)}.ndjson`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(commands.map(line => line.args), [['sync-status', '--path', f.folder, '--json'], ['sync', '--path', f.folder, '--continuous']]);
    assert.ok(!JSON.stringify(started).includes('PRIVATE-CLIENT'));
    await assert.rejects(startObsidian(f.base, { notebookId: f.notebookId, operationId: op('second-start'), expectedRevision: bound.revision }), error => error.code === 'OBSIDIAN_FOLDER_BUSY');
    assert.equal(clientPid(f), pid);
    await stopObsidian(f.base, f.notebookId);
    await waitFor(() => !alive(pid), 'The owned stand-in process should have stopped.');
    assert.equal(f.run(lease => obsidianStatusLocked(lease, f.notebookId)).adapter.running, false);
});

test('another wrapper cannot start a second transport for the same physical folder', async t => {
    const f = prepared(t);
    const bound = f.bind();
    await startObsidian(f.base, { notebookId: f.notebookId, operationId: op('lock-start'), expectedRevision: bound.revision });
    const original = clientPid(f);
    const stat = fs.statSync(f.folder);
    const input = Buffer.from(JSON.stringify({ folder: f.folder, physical: { dev: stat.dev, ino: stat.ino }, executable: f.executable, parentPid: process.pid })).toString('base64');
    const child = fork(new URL('../src/notebooks/obsidian-client-runner.js', import.meta.url), [input], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const messages = [];
    child.on('message', message => messages.push(message));
    await new Promise(resolve => child.once('close', resolve));
    assert.ok(messages.some(message => message.code === 'OBSIDIAN_FOLDER_BUSY'));
    assert.equal(clientPid(f), original);
    assert.ok(alive(original));
});

test('stopping during preparation cancels startup before any client command can run', async t => {
    const f = prepared(t);
    const bound = f.bind();
    const starting = startObsidian(f.base, { notebookId: f.notebookId, operationId: op('cancelled-start'), expectedRevision: bound.revision })
        .then(result => ({ result }), error => ({ error }));
    await stopObsidian(f.base, f.notebookId);
    const outcome = await starting;
    assert.equal(outcome.error?.code, 'OBSIDIAN_START_CANCELLED');
    assert.equal(fs.existsSync(path.join(f.folder, '.fixture-client-pid')), false);
    assert.equal(fs.existsSync(path.join(path.dirname(f.folder), `.obsidian-test-${path.basename(f.folder)}.ndjson`)), false);
});

test('a completed start operation cannot restart against a changed approval revision', async t => {
    const f = prepared(t);
    const bound = f.bind();
    const operationId = op('start-replay');
    await startObsidian(f.base, { notebookId: f.notebookId, operationId, expectedRevision: bound.revision });
    await stopObsidian(f.base, f.notebookId);
    const changed = f.bind({ expectedRevision: bound.revision });
    assert.notEqual(changed.revision, bound.revision);
    await assert.rejects(startObsidian(f.base, { notebookId: f.notebookId, operationId, expectedRevision: bound.revision }), error => error.code === 'OBSIDIAN_CONFLICT');
    const commands = fs.readFileSync(path.join(path.dirname(f.folder), `.obsidian-test-${path.basename(f.folder)}.ndjson`), 'utf8').trim().split('\n');
    assert.equal(commands.length, 2);
});

test('the running folder watcher reconciles newly received notes without granting access', async t => {
    const f = prepared(t);
    const bound = f.bind();
    await startObsidian(f.base, { notebookId: f.notebookId, operationId: op('watch-start'), expectedRevision: bound.revision });
    fs.writeFileSync(path.join(f.folder, 'Watched.md'), '# Watched\r\nReceived without a manual refresh.\r\n');
    await waitFor(() => f.run(lease => obsidianHistoryLocked(lease, { notebookId: f.notebookId })).history.some(event => event.path === 'Watched.md'), 'The active watcher must record received files.');
    await waitFor(() => f.run(lease => loadNotebookLocked(lease, f.notebookId)).entries.some(entry => entry.path === 'Watched.md'), 'The active watcher must reconcile received notes.');
    const state = f.run(lease => loadNotebookLocked(lease, f.notebookId));
    const received = state.entries.find(entry => entry.path === 'Watched.md');
    assert.equal(received.text, '# Watched\r\nReceived without a manual refresh.\r\n');
    assert.equal(f.run(lease => readPoliciesLocked(lease, f.notebookId)).notes[received.id].assistant, 'none');
});

test('a same-byte file rewrite refreshes its physical snapshot cache without another history event', async t => {
    const f = prepared(t);
    f.bind();
    await reconcileObsidian(f.base, f.notebookId);
    const filename = path.join(f.folder, 'Own note.md');
    const bytes = fs.readFileSync(filename);
    await delay(5);
    fs.writeFileSync(filename, bytes);
    await reconcileObsidian(f.base, f.notebookId);
    const known = f.run(lease => readObsidianHistoryIndexLocked(lease, f.notebookId)).files;
    const snapshot = await prepareInWorker('sync-snapshot', { contentRoot: f.folder, known });
    assert.equal(snapshot.files.find(file => file.path === 'Own note.md').unchanged, true);
    assert.equal(f.run(lease => obsidianHistoryLocked(lease, { notebookId: f.notebookId })).history.length, 1);
});

test('an unsafe incoming file pauses the client and retains an actionable stopped status', async t => {
    const f = prepared(t);
    const bound = f.bind();
    await startObsidian(f.base, { notebookId: f.notebookId, operationId: op('pause-start'), expectedRevision: bound.revision });
    const pid = clientPid(f);
    fs.symlinkSync(path.join(f.outerRoot, 'unowned'), path.join(f.folder, 'Unsafe.md'));
    await waitFor(() => !alive(pid), 'An unsafe incoming file must stop the managed client.');
    await waitFor(() => !f.run(lease => obsidianStatusLocked(lease, f.notebookId)).adapter.running, 'Paused status must not claim the stopped client is running.');
    const status = f.run(lease => obsidianStatusLocked(lease, f.notebookId)).adapter;
    assert.match(status.message, /paused/i);
    assert.equal(status.running, false);
    fs.unlinkSync(path.join(f.folder, 'Unsafe.md'));
});

test('the owned client stops when its controlling parent is killed', async t => {
    const f = prepared(t);
    const stat = fs.statSync(f.folder);
    const input = { folder: f.folder, physical: { dev: stat.dev, ino: stat.ino }, executable: f.executable };
    const parent = fork(new URL('./notebooks-obsidian-parent-fixture.js', import.meta.url), [JSON.stringify(input)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const ready = await new Promise((resolve, reject) => {
        parent.on('message', message => { if (message.type === 'ready') resolve(message); else if (message.type === 'failed') reject(new Error(message.code)); });
        parent.once('error', reject);
        parent.once('close', () => reject(new Error('The owned parent stopped before the client was ready.')));
    });
    const pid = ready.clientPid;
    assert.ok(alive(pid));
    const closed = new Promise(resolve => parent.once('close', resolve));
    parent.kill('SIGKILL');
    await closed;
    await waitFor(() => !alive(pid), 'A killed controlling parent must not leave its client running.');
});

test('an unprepared client never logs in, installs or starts a continuous transport', async t => {
    const f = prepared(t);
    const bound = f.bind();
    fs.writeFileSync(path.join(f.folder, '.fixture-not-prepared'), 'not configured');
    await assert.rejects(startObsidian(f.base, { notebookId: f.notebookId, operationId: op('unprepared'), expectedRevision: bound.revision }), error => error.status === 409 && !error.message.includes('PRIVATE-CLIENT'));
    const commands = fs.readFileSync(path.join(path.dirname(f.folder), `.obsidian-test-${path.basename(f.folder)}.ndjson`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(commands.length, 1);
    assert.equal(commands[0].args[0], 'sync-status');
    assert.equal(fs.existsSync(path.join(f.folder, '.fixture-client-pid')), false);
    assert.equal(f.run(lease => obsidianStatusLocked(lease, f.notebookId)).adapter.running, false);
});

test('the owner can stop an existing client after the administrator disables the adapter', async t => {
    const f = prepared(t);
    const bound = f.bind();
    await startObsidian(f.base, { notebookId: f.notebookId, operationId: op('disable-stop'), expectedRevision: bound.revision });
    const pid = clientPid(f);
    f.config.notebooks.obsidianHeadless.enabled = false;
    const stopped = await stopObsidian(f.base, f.notebookId);
    assert.equal(stopped.adapter.running, false);
    assert.ok(!alive(pid));
});

test('a prepared-status process that ignores termination is bounded and never starts continuous sync', async t => {
    const f = prepared(t);
    const bound = f.bind();
    fs.writeFileSync(path.join(f.folder, '.fixture-status-hangs'), 'fault injection');
    const starting = startObsidian(f.base, { notebookId: f.notebookId, operationId: op('hang-status'), expectedRevision: bound.revision });
    let timeout;
    try {
        await assert.rejects(Promise.race([starting, new Promise((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('The status check must finish within its bounded shutdown period.')), 20500);
        })]), error => error.code === 'OBSIDIAN_NOT_PREPARED');
    } finally { clearTimeout(timeout); }
    const commands = fs.readFileSync(path.join(path.dirname(f.folder), `.obsidian-test-${path.basename(f.folder)}.ndjson`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(commands.length, 1);
    assert.equal(commands[0].args[0], 'sync-status');
    assert.ok(!alive(commands[0].pid));
});

test('replacing the approved directory stops the owned client instead of following a new folder', async t => {
    const f = prepared(t);
    const bound = f.bind();
    await startObsidian(f.base, { notebookId: f.notebookId, operationId: op('replace-root'), expectedRevision: bound.revision });
    const pid = clientPid(f);
    fs.renameSync(f.folder, f.folder + '-moved');
    fs.mkdirSync(f.folder);
    await waitFor(() => !alive(pid), 'A replaced root must stop its original prepared client.');
    assert.throws(() => f.run(lease => obsidianStatusLocked(lease, f.notebookId)), error => error.code === 'OBSIDIAN_FOLDER_CHANGED');
});

for (const phase of ['planned', 'recorded']) {
    test(`an interrupted exact file-history record recovers after SIGKILL at ${phase}`, t => {
        const f = prepared(t);
        const bytes = Buffer.from([0, 1, 2, 255]);
        const file = { path: 'Binary.txt', hash: sha256(bytes), bytes: bytes.toString('base64'), size: bytes.length, stat: null };
        const crashed = spawnSync(process.execPath, [new URL('./notebooks-obsidian-history-crash-fixture.js', import.meta.url).pathname,
            JSON.stringify({ directories: f.scope.directories, notebookId: f.notebookId, file, phase })], { encoding: 'utf8', timeout: 30000 });
        assert.equal(crashed.signal, 'SIGKILL', crashed.stderr || crashed.stdout);
        const events = f.run(lease => obsidianHistoryLocked(lease, { notebookId: f.notebookId })).history;
        assert.equal(events.length, 1);
        assert.deepEqual(f.run(lease => obsidianHistoryFileLocked(lease, { notebookId: f.notebookId, historyId: events[0].id })).bytes, bytes);
        f.run(lease => recordObsidianFileLocked(lease, f.notebookId, { ...file, bytes }));
        assert.equal(f.run(lease => obsidianHistoryLocked(lease, { notebookId: f.notebookId })).history.length, 1);
        assert.equal(f.run(lease => readObsidianHistoryIndexLocked(lease, f.notebookId)).files['Binary.txt'].hash, file.hash);
    });
}
