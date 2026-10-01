import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { test } from 'node:test';
import archiver from 'archiver';
import extractChunks from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import encodeChunks from '../src/png/encode.js';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { retainUploadedArchive, capturedArchiveInput, readUploadedArchive } = await import('../src/operations/input-files.js');
const { captureFolderImport, captureZipImport, openCapturedZipEntry, openImportArchive, resolveAccountImportRoot } = await import('../src/operations/account-import-sources.js');
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

test('application folder detection prefers the user data over application extensions', t => {
    const p = setup(t);
    sourceFile(p, 'extensions/app-extension/index.js', 'application code');
    sourceFile(p, 'data/default-user/settings.json', '{}');
    assert.equal(resolveAccountImportRoot(p.sourceRoot), path.join(p.sourceRoot, 'data/default-user'));
});

test('ZIP source detection keeps recognised names inside chat folders at their original paths', async t => {
    const p = setup(t);
    const filename = path.join(p.sourceRoot, 'upload.zip');
    await zipFile(filename, [['archive-account/chats/characters/Only.jsonl', '{}']]);
    const source = await retainUploadedArchive(p.base, p.f.scope, 'nested-root', filename);
    const captured = await captureZipImport(source, { coreOnly: true });
    assert.equal(captured.sourceRoot, 'archive-account');
    assert.deepEqual(captured.files.map(file => file.relative), ['chats/characters/Only.jsonl']);
});

test('ZIP source detection selects default-user even when another account has more files', async t => {
    const p = setup(t);
    const filename = path.join(p.sourceRoot, 'upload.zip');
    await zipFile(filename, [
        ['SillyTavern/data/default-user/settings.json', '{}'],
        ['SillyTavern/data/other/settings.json', '{}'],
        ['SillyTavern/data/other/User Avatars/one.png', png],
        ['SillyTavern/data/other/User Avatars/two.png', png],
    ]);
    const source = await retainUploadedArchive(p.base, p.f.scope, 'default-root', filename);
    const captured = await captureZipImport(source, { coreOnly: true });
    assert.equal(captured.sourceRoot, 'SillyTavern/data/default-user');
    assert.deepEqual(captured.files.map(file => file.relative), ['settings.json']);
});

test('ZIP source detection refuses ambiguous accounts rather than guessing by file count', async t => {
    const p = setup(t);
    const filename = path.join(p.sourceRoot, 'upload.zip');
    await zipFile(filename, [['data/alice/settings.json', '{}'], ['data/bob/settings.json', '{}']]);
    const source = await retainUploadedArchive(p.base, p.f.scope, 'ambiguous-root', filename);
    await assert.rejects(captureZipImport(source, { coreOnly: true }), /Multiple user folders/);
});

test('full application ZIP selects modern user data even when the username is a library name', async t => {
    const p = setup(t);
    const filename = path.join(p.sourceRoot, 'upload.zip');
    await zipFile(filename, [
        ['SillyTavern/extensions/application/index.js', 'application code'],
        ['SillyTavern/data/characters/settings.json', '{}'],
        ['SillyTavern/data/characters/chats/characters/Keep.jsonl', '{}'],
    ]);
    const source = await retainUploadedArchive(p.base, p.f.scope, 'application-root', filename);
    const captured = await captureZipImport(source);
    assert.equal(captured.sourceRoot, 'SillyTavern/data/characters');
    assert.deepEqual(captured.files.map(file => file.relative).sort(), ['chats/characters/Keep.jsonl', 'settings.json']);
});

test('skipped bundled defaults are not counted as successfully restored files', async t => {
    const p = setup(t);
    sourceFile(p, 'settings.json', '{}');
    const defaults = { directories: ['characters'], files: [{ relative: 'characters/Damaged.png', data: Buffer.from('broken').toString('base64') }] };
    const accepted = await accept(p, 'damaged-default', { mode: 'folder', path: p.sourceRoot }, defaults);
    await runOperation(accepted.context);
    const result = readOperation(p.base, 'damaged-default').result;
    assert.equal(result.defaults, 0);
    assert.equal(result.imported, 1);
    assert.equal(result.skippedCount, 1);
});

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

test('the completed report retains every skipped file beyond the old 200-file limit', async t => {
    const p = setup(t);
    for (let index = 0; index < 205; index++) sourceFile(p, `chats/Nova/Broken-${index}.jsonl`, 'broken');
    const accepted = await accept(p, 'full-report', { mode: 'folder', path: p.sourceRoot, content: 'core', parts: ['chats'] });
    await runOperation(accepted.context);
    const result = readOperation(p.base, 'full-report').result;
    assert.equal(result.imported, 0);
    assert.equal(result.skippedCount, 205);
    assert.equal(result.skipped.length, 205);
    assert.equal(new Set(result.skipped.map(item => item.file)).size, 205);
});

for (const content of ['all', 'core']) test(`${content} settings import accepts a BOM and refuses damaged UTF-8`, async t => {
    const p = setup(t);
    const settings = { name1: 'Imported', power_user: { personas: { 'one.png': '猫' }, persona_descriptions: {} } };
    sourceFile(p, 'settings.json', '\uFEFF' + JSON.stringify(settings));
    const accepted = await accept(p, 'bom-settings', { mode: 'folder', path: p.sourceRoot, content });
    await runOperation(accepted.context);
    const filename = path.join(p.base.directories.root, 'settings.json');
    const before = fs.readFileSync(filename);
    assert.equal(JSON.parse(before).power_user.personas['one.png'], '猫');
    sourceFile(p, 'settings.json', Buffer.concat([Buffer.from('{"power_user":{"personas":{"one.png":"'), Buffer.from([0xff]), Buffer.from('"}}}') ]));
    const damaged = await accept(p, 'damaged-settings', { mode: 'folder', path: p.sourceRoot, content });
    await runOperation(damaged.context);
    assert.equal(readOperation(p.base, 'damaged-settings').result.skippedCount, 1);
    assert.deepEqual(fs.readFileSync(filename), before);
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

test('invalid imported history is skipped while later destination edits still refuse before any replacement', async t => {
    const p = setup(t);
    const original = fs.readFileSync(p.f.filename);
    sourceFile(p, 'chats/Nova/Source.jsonl', 'not valid JSON');
    sourceFile(p, 'user/files/new.txt', 'Healthy file');
    const bad = await accept(p, 'invalid');
    await runOperation(bad.context);
    assert.deepEqual(fs.readFileSync(p.f.filename), original);
    assert.equal(fs.readFileSync(path.join(p.base.directories.root, 'user/files/new.txt'), 'utf8'), 'Healthy file');
    const record = readOperation(p.base, 'invalid');
    assert.equal(record.state, 'completed');
    assert.equal(record.result.skippedCount, 1);
    assert.deepEqual(record.result.skipped, [{ file: 'chats/Nova/Source.jsonl', reason: 'Cannot read \'chats/Nova/Source.jsonl\': Line 1 of the chat file is not valid JSON.' }]);
    fs.rmSync(p.sourceRoot, { recursive: true }); fs.mkdirSync(p.sourceRoot);
    sourceFile(p, 'chats/Nova/Source.jsonl', original);
    sourceFile(p, 'user/files/late.txt', 'Must not be published');
    const late = await accept(p, 'late-edit');
    fs.writeFileSync(p.f.filename, Buffer.concat([original, Buffer.from('\n{"name":"User","is_user":true,"mes":"Newer message"}') ]));
    await assert.rejects(runOperation(late.context), /destination changed: 'chats\/Nova\/Source.jsonl'.*Reload the page and retry/);
    assert.match(fs.readFileSync(p.f.filename, 'utf8'), /Newer message/);
    assert.equal(fs.existsSync(path.join(p.base.directories.root, 'user/files/late.txt')), false);
});

test('core ZIP import leaves bookkeeping out when the account updates it during import', async t => {
    const p = setup(t);
    const upload = path.join(p.sourceRoot, 'default-user.zip');
    await zipFile(upload, [
        ['default-user/characters/New.png', writeCard(png, JSON.stringify({ name: 'New', description: 'Imported card' }))],
        ['default-user/entity-date-added.json', '{"version":1}'],
        ['default-user/chats/New/Imported.jsonl', p.f.records.map(row => JSON.stringify(row)).join('\n')],
    ]);
    const retained = await retainUploadedArchive(p.base, p.f.scope, 'core-zip', upload);
    const accepted = await accept(p, 'core-zip', { mode: 'zip', content: 'core', inputId: retained.id });
    const bookkeeping = path.join(p.base.directories.root, 'entity-date-added.json');
    const newerBookkeeping = '{"version":1,"characters":{"entries":{"New.png":12345}}}';
    await runOperation(accepted.context, { afterImportStaged: () => fs.writeFileSync(bookkeeping, newerBookkeeping) });
    const record = readOperation(p.base, 'core-zip');
    assert.equal(record.state, 'completed');
    assert.equal(record.result.imported, 2);
    assert.equal(record.result.skippedCount, 0);
    assert.deepEqual(record.result.excluded.map(item => item.file), ['entity-date-added.json']);
    assert.match(record.result.excluded[0].reason, /bookkeeping/i);
    assert.equal(fs.readFileSync(bookkeeping, 'utf8'), newerBookkeeping);
    assert.equal(JSON.parse(readCard(fs.readFileSync(path.join(p.base.directories.characters, 'New.png')))).name, 'New');
    assert.equal(fs.existsSync(path.join(p.base.directories.chats, 'New/Imported.jsonl')), true);
});

for (const mode of ['folder', 'zip']) test(`core ${mode} import keeps the four libraries and merges personas without importing unrelated data`, async t => {
    const p = setup(t, `core-${mode}`);
    const settingsFile = path.join(p.base.directories.root, 'settings.json');
    const current = { _version: 7, _settingsRevision: 4, username: 'Current user', theme: 'Current theme', power_user: {
        default_persona: 'Existing.png', persona_description: 'Current active description', custom_css: 'Keep this',
        personas: { 'Existing.png': 'Existing name' }, persona_descriptions: { 'Existing.png': { description: 'Existing description' } },
    }, extension_settings: { unrelated: { keep: true }, neconyan_conversation: { characters: {}, serverOperations: { job: { at: 1 } }, automation: { mode: 'server' } } } };
    fs.writeFileSync(settingsFile, JSON.stringify(current));
    const description = { description: 'Imported persona description', title: 'Imported title', position: 0, depth: 2, role: 0, lorebook: 'Imported lore', appendices: [] };
    const lorebook = JSON.stringify({ entries: { 0: { uid: 0, key: ['Lore'], content: 'Imported lore', extensions: { foreign: true } } }, extensions: { foreign: 'kept' } });
    const entries = [
        ['settings.json', JSON.stringify({ username: 'Must not replace user', power_user: { personas: { 'Imported.png': 'Imported persona' },
            persona_descriptions: { 'Imported.png': description }, default_persona: 'Imported.png', custom_css: 'Must not replace CSS' },
        extension_settings: { neconyan_conversation: { characters: { malicious: {} } } } })],
        ['characters/Imported.png', writeCard(png, JSON.stringify({ name: 'Imported', description: 'Imported card' }))],
        ['chats/Imported/History.jsonl', p.f.records.map(row => JSON.stringify(row)).join('\n')],
        ['User Avatars/Imported.png', png],
        ['groups/Imported.json', JSON.stringify({ id: 'Imported', members: ['Imported.png'], chats: ['Imported group'] })],
        ['group chats/Imported group.jsonl', p.f.records.map(row => JSON.stringify(row)).join('\n')],
        ['user/files/attachment.txt', 'Imported attachment'], ['user/images/attachment.png', png],
        ['worlds/Imported lore.json', lorebook],
    ];
    const omitted = ['entity-date-added.json', 'entity-last-chat.json', 'secrets.json', 'themes/Old.json', 'OpenAI Settings/Old.json',
        'extensions/Old/index.js', 'backups/old.jsonl', 'user/workflows/unused.json', 'readme.txt'];
    entries.push(...omitted.map(relative => [relative, 'PRIVATE UNRELATED CONTENT']));
    let input;
    if (mode === 'zip') {
        const upload = path.join(p.sourceRoot, 'default-user.zip');
        await zipFile(upload, entries.map(([relative, bytes]) => [`data/default-user/${relative}`, bytes]));
        const retained = await retainUploadedArchive(p.base, p.f.scope, 'core', upload);
        input = { mode, content: 'core', inputId: retained.id };
    } else {
        for (const [relative, bytes] of entries) sourceFile(p, relative, bytes);
        input = { mode, content: 'core', path: p.sourceRoot };
    }
    const defaults = { directories: ['themes'], files: [{ relative: 'themes/Default.json', data: Buffer.from('{}').toString('base64') }] };
    const accepted = await accept(p, 'core', input, defaults);
    await runOperation(accepted.context, { afterImportInputs() {
        current.username = 'Changed while importing'; current._version++; current._settingsRevision++;
        fs.writeFileSync(settingsFile, JSON.stringify(current));
    } });
    const record = readOperation(p.base, 'core');
    assert.equal(record.state, 'completed'); assert.equal(record.result.content, 'core');
    assert.equal(record.result.imported, 9); assert.equal(record.result.defaults, 0); assert.equal(record.result.skippedCount, 0);
    assert.deepEqual(record.result.parts, ['chats', 'personas', 'characters', 'lorebooks']);
    assert.equal(fs.readFileSync(path.join(p.base.directories.root, 'worlds/Imported lore.json'), 'utf8'), lorebook);
    assert.equal(record.result.excludedCount, omitted.length);
    assert.deepEqual(record.result.excluded.map(item => item.file).sort(), omitted.sort());
    assert.ok(record.result.excluded.every(item => typeof item.reason === 'string' && item.reason.length));
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE UNRELATED CONTENT/);
    for (const relative of omitted) assert.equal(fs.existsSync(path.join(p.base.directories.root, relative)), false, relative);
    assert.equal(fs.existsSync(path.join(p.base.directories.root, 'themes/Default.json')), false);
    assert.deepEqual(fs.readFileSync(path.join(p.base.directories.root, 'User Avatars/Imported.png')), png);
    assert.equal(fs.readFileSync(path.join(p.base.directories.root, 'user/files/attachment.txt'), 'utf8'), 'Imported attachment');
    assert.equal(fs.existsSync(path.join(p.base.directories.root, 'group chats/Imported group.jsonl')), true);
    const saved = JSON.parse(fs.readFileSync(settingsFile));
    assert.equal(saved.username, 'Changed while importing'); assert.equal(saved.theme, current.theme);
    assert.equal(saved.power_user.default_persona, 'Existing.png'); assert.equal(saved.power_user.persona_description, 'Current active description');
    assert.equal(saved.power_user.custom_css, 'Keep this');
    assert.deepEqual(saved.power_user.personas, { ...current.power_user.personas, 'Imported.png': 'Imported persona' });
    assert.deepEqual(saved.power_user.persona_descriptions, { ...current.power_user.persona_descriptions, 'Imported.png': description });
    assert.deepEqual(saved.extension_settings, current.extension_settings);
    assert.equal(saved._version, 9); assert.equal(saved._settingsRevision, 6);
});

for (const mode of ['folder', 'zip']) for (const part of ['chats', 'personas', 'characters', 'lorebooks']) test(`core ${mode} import selects only ${part} and names every unselected file`, async t => {
    const p = setup(t, `selected-${mode}-${part}`);
    const settings = path.join(p.base.directories.root, 'settings.json');
    const current = '{"_version":4,"username":"Current user","power_user":{"personas":{},"persona_descriptions":{}}}';
    fs.writeFileSync(settings, current);
    const libraries = {
        characters: [['characters/Selected.png', writeCard(png, JSON.stringify({ name: 'Selected', description: 'Selected card' }))]],
        lorebooks: [['worlds/Selected.json', '{"entries":{"0":{"uid":0,"content":"Selected lore"}}}']],
        personas: [['settings.json', '{"username":"Unwanted user","power_user":{"personas":{"Selected.png":"Selected persona"},"persona_descriptions":{"Selected.png":{"description":"Selected description"}}}}'], ['User Avatars/Selected.png', png]],
        chats: [['chats/Nova/Selected.jsonl', p.f.records.map(row => JSON.stringify(row)).join('\n')],
            ['groups/Selected.json', '{"id":"Selected","members":["Nova.png"],"chats":["Selected group"]}'],
            ['group chats/Selected group.jsonl', p.f.records.map(row => JSON.stringify(row)).join('\n')],
            ['user/files/Selected.txt', 'Chat attachment'], ['user/images/Selected.png', png]],
    };
    const entries = Object.values(libraries).flat();
    let input;
    if (mode === 'zip') {
        const upload = path.join(p.sourceRoot, 'default-user.zip');
        await zipFile(upload, entries.map(([relative, bytes]) => [`default-user/${relative}`, bytes]));
        const retained = await retainUploadedArchive(p.base, p.f.scope, 'selected', upload);
        input = { mode, content: 'core', parts: [part], inputId: retained.id };
    } else {
        for (const [relative, bytes] of entries) sourceFile(p, relative, bytes);
        input = { mode, content: 'core', parts: [part], path: p.sourceRoot };
    }
    const accepted = await accept(p, 'selected', input);
    await runOperation(accepted.context);
    const record = readOperation(p.base, 'selected');
    assert.equal(record.state, 'completed'); assert.deepEqual(record.result.parts, [part]);
    assert.equal(record.result.imported, libraries[part].length); assert.equal(record.result.skippedCount, 0);
    const omitted = Object.entries(libraries).filter(([key]) => key !== part).flatMap(([, files]) => files.map(([relative]) => relative));
    assert.deepEqual(record.result.excluded.map(item => item.file).sort(), omitted.sort());
    assert.ok(record.result.excluded.every(item => /were not selected for this import/.test(item.reason)));
    for (const relative of omitted.filter(relative => relative !== 'settings.json')) assert.equal(fs.existsSync(path.join(p.base.directories.root, relative)), false, relative);
    for (const [relative] of libraries[part]) assert.equal(fs.existsSync(path.join(p.base.directories.root, relative)), true, relative);
    assert.equal(JSON.parse(fs.readFileSync(settings)).username, 'Current user');
    if (part === 'personas') {
        assert.equal(JSON.parse(fs.readFileSync(settings)).power_user.personas['Selected.png'], 'Selected persona');
    } else assert.equal(fs.readFileSync(settings, 'utf8'), current);
});

for (const mode of ['folder', 'zip']) test(`lorebook-only ${mode} backups import native books and history, skip damaged books and retain existing copies`, async t => {
    const p = setup(t, `lore-only-${mode}`);
    const book = '{"entries":{"0":{"uid":0,"key":["Harbour"],"content":"The harbour is safe.","extensions":{"foreign":true}}},"extensions":{"foreign":"kept"}}';
    const history = '{"version":1,"id":"test","createdAt":1,"updatedAt":1,"headCommitId":null,"commits":[]}';
    const worlds = path.join(p.base.directories.root, 'worlds');
    fs.mkdirSync(worlds, { recursive: true });
    fs.writeFileSync(path.join(worlds, 'Broken.json'), book);
    const entries = [['worlds/Harbour.json', book], ['worlds/.history/test.json', history],
        ['worlds/Broken.json', 'not JSON'], ['worlds/Not a book.json', '{"entries":[]}'],
        ['worlds/.history/broken.json', '{"version":1,"commits":[null]}']];
    let input;
    if (mode === 'zip') {
        const upload = path.join(p.sourceRoot, 'lorebooks.zip');
        await zipFile(upload, entries.map(([relative, bytes]) => [`SillyTavern/data/default-user/${relative}`, bytes]));
        const retained = await retainUploadedArchive(p.base, p.f.scope, 'lore-only', upload);
        input = { mode, content: 'core', parts: ['lorebooks'], inputId: retained.id };
    } else {
        for (const [relative, bytes] of entries) sourceFile(p, `data/default-user/${relative}`, bytes);
        input = { mode, content: 'core', parts: ['lorebooks'], path: p.sourceRoot };
    }
    const accepted = await accept(p, 'lore-only', input);
    await runOperation(accepted.context);
    const result = readOperation(p.base, 'lore-only').result;
    assert.equal(result.imported, 2); assert.equal(result.skippedCount, 3); assert.equal(result.excludedCount, 0);
    assert.deepEqual(result.parts, ['lorebooks']);
    assert.equal(fs.readFileSync(path.join(worlds, 'Harbour.json'), 'utf8'), book);
    assert.equal(fs.readFileSync(path.join(worlds, '.history/test.json'), 'utf8'), history);
    assert.equal(fs.readFileSync(path.join(worlds, 'Broken.json'), 'utf8'), book);
    assert.equal(fs.existsSync(path.join(worlds, 'Not a book.json')), false);
    assert.ok(result.skipped.some(item => item.file === 'worlds/Broken.json' && /not valid JSON/.test(item.reason)));
    assert.ok(result.skipped.some(item => /not a valid lorebook/.test(item.reason)));
    assert.ok(result.skipped.some(item => /history is not valid/.test(item.reason)));
});

test('unselected damaged libraries are left out without reading them and an absent selected ZIP library produces a report', async t => {
    const p = setup(t);
    const upload = path.join(p.sourceRoot, 'default-user.zip');
    await zipFile(upload, [['default-user/characters/Damaged.png', 'Not a card'], ['default-user/settings.json', 'Not JSON']]);
    const retained = await retainUploadedArchive(p.base, p.f.scope, 'absent', upload);
    const accepted = await accept(p, 'absent', { mode: 'zip', content: 'core', parts: ['chats'], inputId: retained.id });
    await runOperation(accepted.context);
    const record = readOperation(p.base, 'absent');
    assert.equal(record.state, 'completed'); assert.equal(record.result.imported, 0); assert.equal(record.result.skippedCount, 0);
    assert.equal(record.result.excludedCount, 2);
    assert.deepEqual(record.result.excluded.map(item => item.file), ['characters/Damaged.png', 'settings.json']);
    assert.equal(fs.existsSync(path.join(p.base.directories.characters, 'Damaged.png')), false);
    assert.equal(fs.existsSync(path.join(p.base.directories.root, 'settings.json')), false);
});

test('library choices reject empty, unknown and invalid selections before source capture', async t => {
    const p = setup(t);
    for (const parts of [[], ['themes'], 'personas', null, ['chats', 'personas', 'characters', 'chats']]) {
        await assert.rejects(captureAccountImport(p.base, p.f.scope, { mode: 'folder', content: 'core', parts, path: '/not-a-source' }), /Select at least one library/);
    }
    await assert.rejects(captureAccountImport(p.base, p.f.scope, { mode: 'folder', parts: ['personas'], path: p.sourceRoot }), /Library choices apply only/);
});

test('core folder import accepts an avatar-only library and inventories ignored links without following them', async t => {
    const p = setup(t);
    sourceFile(p, 'User Avatars/Persona.png', png);
    fs.symlinkSync('/does-not-exist', path.join(p.sourceRoot, 'secrets.json'));
    const accepted = await accept(p, 'avatars', { mode: 'folder', content: 'core', path: p.sourceRoot });
    await runOperation(accepted.context);
    assert.deepEqual(readOperation(p.base, 'avatars').result.excluded, [{ file: 'secrets.json', reason: 'API keys and passwords are not imported.' }]);
    assert.deepEqual(fs.readFileSync(path.join(p.base.directories.root, 'User Avatars/Persona.png')), png);
});

test('malformed persona settings are skipped without stopping healthy core libraries', async t => {
    for (const [index, data] of ['not JSON', '{"power_user":{"personas":[]}}', '{"power_user":{"personas":{"__proto__":"bad"}}}',
        '{"power_user":{"persona_descriptions":{"Persona.png":{"description":false}}}}'].entries()) {
        const p = setup(t, `bad-persona-${index}`);
        const settings = path.join(p.base.directories.root, 'settings.json');
        fs.writeFileSync(settings, '{"username":"Keep me"}');
        sourceFile(p, 'settings.json', data); sourceFile(p, 'chats/Nova/Healthy.jsonl', p.f.records.map(row => JSON.stringify(row)).join('\n'));
        const accepted = await accept(p, 'bad-persona', { mode: 'folder', content: 'core', path: p.sourceRoot });
        await runOperation(accepted.context);
        const result = readOperation(p.base, 'bad-persona').result;
        assert.equal(result.imported, 1); assert.equal(result.skippedCount, 1); assert.equal(result.skipped[0].file, 'settings.json');
        assert.equal(fs.readFileSync(settings, 'utf8'), '{"username":"Keep me"}');
        assert.equal(fs.existsSync(path.join(p.base.directories.chats, 'Nova/Healthy.jsonl')), true);
    }
});

test('interrupted persona publication resumes once and never overwrites later settings or persona deletions', async t => {
    for (const point of ['afterPersonaSettingsPrepared', 'afterPersonaSettingsPublication', 'afterImportPublication']) {
        const p = setup(t, point);
        const settings = path.join(p.base.directories.root, 'settings.json');
        fs.writeFileSync(settings, JSON.stringify({ username: 'Current', power_user: { personas: {}, persona_descriptions: {} } }));
        sourceFile(p, 'settings.json', JSON.stringify({ power_user: { personas: { 'Persona.png': 'Imported' }, persona_descriptions: {} } }));
        const accepted = await accept(p, 'interrupted-persona', { mode: 'folder', content: 'core', path: p.sourceRoot });
        await assert.rejects(runOperation(accepted.context, { [point]: () => { throw new Error('lost persona acknowledgement'); } }), /lost persona/);
        const newer = { username: 'Later settings', power_user: { personas: {}, persona_descriptions: {} }, _version: 40 };
        fs.writeFileSync(settings, JSON.stringify(newer));
        await runOperation(accepted.context);
        assert.deepEqual(JSON.parse(fs.readFileSync(settings)), newer);
        const record = readOperation(p.base, 'interrupted-persona');
        assert.equal(record.state, 'completed');
        if (point !== 'afterImportPublication') {
            assert.equal(record.result.skippedCount, 1); assert.match(record.result.skipped[0].reason, /newer settings were kept/);
        }
    }
});

test('persona publication recovers both sides of its durable rename when there are no later edits', async t => {
    for (const point of ['afterPersonaSettingsPrepared', 'afterPersonaSettingsPublication']) {
        const p = setup(t, `recover-${point}`);
        const settings = path.join(p.base.directories.root, 'settings.json');
        fs.writeFileSync(settings, '{"_version":2,"username":"Current"}');
        sourceFile(p, 'settings.json', '{"power_user":{"personas":{"Persona.png":"Imported"}}}');
        const accepted = await accept(p, 'recover-persona', { mode: 'folder', content: 'core', path: p.sourceRoot });
        await assert.rejects(runOperation(accepted.context, { [point]: () => { throw new Error('lost persona acknowledgement'); } }), /lost persona/);
        await runOperation(accepted.context);
        const saved = JSON.parse(fs.readFileSync(settings));
        assert.equal(saved.power_user.personas['Persona.png'], 'Imported'); assert.equal(saved._version, 3);
        assert.equal(readOperation(p.base, 'recover-persona').result.skippedCount, 0);
    }
});

test('branch chats that name their parent the older SillyTavern ways import from a ZIP', async t => {
    const p = setup(t);
    const parents = [1687345678901, 'Nova: Branch', 'Trailing dot.', 'Trailing space ', 'x'.repeat(300), 'CON', '..', ['list'], { nested: true }, true, 'Source'];
    const entries = parents.map((main_chat, index) => {
        const rows = structuredClone(p.f.records);
        rows[0].chat_metadata.main_chat = main_chat;
        return [`data/default-user/chats/Nova/Branch #${index}.jsonl`, rows.map(row => JSON.stringify(row)).join('\n')];
    });
    const upload = path.join(p.sourceRoot, 'branches.zip');
    await zipFile(upload, entries);
    const retained = await retainUploadedArchive(p.base, p.f.scope, 'branches', upload);
    const accepted = await accept(p, 'branches', { mode: 'zip', inputId: retained.id });
    await runOperation(accepted.context);
    const record = readOperation(p.base, 'branches');
    assert.equal(record.state, 'completed');
    assert.equal(record.result.skippedCount, 0);
    for (const index of parents.keys()) {
        const [header] = fs.readFileSync(path.join(p.base.directories.chats, 'Nova', `Branch #${index}.jsonl`), 'utf8').split('\n');
        assert.deepEqual(JSON.parse(header).chat_metadata.main_chat, parents[index]);
    }
});

test('a chat refused while publishing is skipped by name while healthy files import', async t => {
    const p = setup(t);
    const lines = p.f.records.map(row => JSON.stringify(row));
    sourceFile(p, 'chats/Nova/Healthy.jsonl', lines.join('\n'));
    sourceFile(p, 'chats/Nova/Negative zero.jsonl', [lines[0], lines[1].replace('"is_user":true', '"is_user":true,"n":-0.0')].join('\n'));
    sourceFile(p, 'user/files/new.txt', 'Healthy file');
    const accepted = await accept(p, 'refused');
    await runOperation(accepted.context);
    const record = readOperation(p.base, 'refused');
    assert.equal(record.state, 'completed');
    assert.equal(record.result.skippedCount, 1);
    assert.deepEqual(record.result.skipped, [{ file: 'chats/Nova/Negative zero.jsonl', reason: 'Cannot import \'chats/Nova/Negative zero.jsonl\': Roleplay identity requires JSON-only values.' }]);
    assert.equal(fs.existsSync(path.join(p.base.directories.chats, 'Nova', 'Negative zero.jsonl')), false);
    assert.deepEqual(fs.readFileSync(path.join(p.base.directories.chats, 'Nova', 'Healthy.jsonl'), 'utf8').split('\n').slice(1), lines.slice(1));
    assert.equal(fs.readFileSync(path.join(p.base.directories.root, 'user/files/new.txt'), 'utf8'), 'Healthy file');
});

function rawCard(data) {
    const chunks = extractChunks(png);
    chunks.splice(-1, 0, PNGtext.encode('chara', Buffer.from(data).toString('base64')));
    return Buffer.from(encodeChunks(chunks));
}

function damageStoredEntry(zip, marker) {
    const offset = zip.indexOf(marker);
    assert.ok(offset > 0, 'Stored ZIP entries keep their bytes readable');
    zip[offset] ^= 1;
    return zip;
}

test('damaged backup files are skipped by name and reason while healthy files import', async t => {
    const v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: {
        name: 'Nova', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
    } };
    const missing = structuredClone(v2); delete missing.data.first_mes;
    const wrongType = structuredClone(v2); wrongType.data.tags = 'not a list';
    const corruptPng = Buffer.from(png); corruptPng[29] ^= 1;
    const cases = [
        ['characters/Plain portrait.png', png, /no embedded character data/],
        ['characters/Cut off.png', png.subarray(0, 40), /incomplete or cut off/],
        ['characters/Corrupt.png', corruptPng, /failed its corruption check/],
        ['characters/Not PNG.png', Buffer.from('bad'), /not a valid PNG image/],
        ['characters/Broken JSON.png', rawCard('PRIVATE CARD CONTENT'), /character data is not valid JSON/],
        ['characters/Missing greeting.png', rawCard(JSON.stringify(missing)), /field 'data.first_mes' is missing or invalid/],
        ['characters/Wrong tags.png', rawCard(JSON.stringify(wrongType)), /field 'data.tags' is missing or invalid/],
        ['groups/group.json', Buffer.from(JSON.stringify({ id: 'group', members: 'PRIVATE GROUP CONTENT' })), /field 'members' must be a list/],
        ['groups/renamed.json', Buffer.from(JSON.stringify({ id: 'different', members: [] })), /field 'id' does not match its filename/],
        ['groups/invalid.json', Buffer.from('PRIVATE GROUP CONTENT'), /group data is not valid JSON/],
        ['groups/encoding.json', Buffer.from([0xff]), /not valid UTF-8 text/],
        ['chats/Nova/Damaged.jsonl', Buffer.from('PRIVATE CHAT CONTENT'), /Line 1 of the chat file is not valid JSON/],
        ['chats/Nova/Empty.jsonl', Buffer.alloc(0), /The chat file is empty/],
        ['settings.json', Buffer.from('PRIVATE SETTINGS'), /The file is not valid JSON/],
        ['user/files/zip-damaged.txt', Buffer.from('ORDINARY-DAMAGE-MARKER'), /damaged/, 'ORDINARY-DAMAGE-MARKER'],
        ['chats/Nova/Zip damaged.jsonl', null, /damaged/, 'CHECKED-DAMAGE-MARKER'],
    ];
    for (const mode of ['zip', 'folder']) for (const [index, [relative, content, reason, zipDamage]] of cases.entries()) {
        if (zipDamage && mode !== 'zip') continue;
        await t.test(`${mode}: ${relative}`, async t => {
            const p = setup(t, `${mode}-${index}`);
            const originalChat = fs.readFileSync(p.f.filename);
            const originalCard = fs.readFileSync(path.join(p.base.directories.characters, 'Nova.png'));
            const originalGroup = fs.readFileSync(path.join(p.base.directories.groups, 'group.json'));
            const originalSettings = JSON.stringify({ name1: 'Current' });
            fs.writeFileSync(path.join(p.base.directories.root, 'settings.json'), originalSettings);
            const bytes = zipDamage === 'CHECKED-DAMAGE-MARKER'
                ? Buffer.from(p.f.records.map((row, i) => JSON.stringify(i === 1 ? { ...row, mes: zipDamage } : row)).join('\n'))
                : content;
            const entries = new Map([['settings.json', '{"name1":"Imported"}'], ['user/files/new.txt', 'Healthy file'], [relative, bytes]]);
            let input;
            if (mode === 'zip') {
                const upload = path.join(p.sourceRoot, 'broken.zip');
                await zipFile(upload, [...entries].map(([name, value]) => [`data/default-user/${name}`, value]), { store: true });
                if (zipDamage) fs.writeFileSync(upload, damageStoredEntry(fs.readFileSync(upload), Buffer.from(zipDamage)));
                const retained = await retainUploadedArchive(p.base, p.f.scope, 'diagnostic', upload);
                input = { mode, inputId: retained.id };
            } else {
                for (const [name, value] of entries) sourceFile(p, name, value);
                input = { mode, path: p.sourceRoot };
            }
            const accepted = await accept(p, 'diagnostic', input);
            await runOperation(accepted.context);
            const record = readOperation(p.base, 'diagnostic');
            assert.equal(record.state, 'completed');
            assert.equal(record.result.skippedCount, 1);
            assert.equal(record.result.skipped.length, 1);
            const [skip] = record.result.skipped;
            assert.equal(skip.file, relative);
            assert.ok(skip.reason.startsWith(`Cannot read '${relative}': `), skip.reason);
            assert.match(skip.reason, reason);
            assert.doesNotMatch(skip.reason, /PRIVATE|neconyan-roleplay-transaction/);
            assert.doesNotMatch(JSON.stringify(record), /PRIVATE/);
            const destination = path.join(p.base.directories.root, relative);
            if (relative === 'groups/group.json') assert.deepEqual(fs.readFileSync(destination), originalGroup);
            else if (relative !== 'settings.json') assert.equal(fs.existsSync(destination), false, 'Damaged files must not be published');
            assert.deepEqual(fs.readFileSync(p.f.filename), originalChat);
            assert.deepEqual(fs.readFileSync(path.join(p.base.directories.characters, 'Nova.png')), originalCard);
            const settings = JSON.parse(fs.readFileSync(path.join(p.base.directories.root, 'settings.json'), 'utf8'));
            assert.equal(settings.name1, relative === 'settings.json' ? 'Current' : 'Imported');
            assert.equal(fs.readFileSync(path.join(p.base.directories.root, 'user/files/new.txt'), 'utf8'), 'Healthy file');
        });
    }
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
    for (const stage of ['Checking chats, characters, lorebooks and settings', 'Preparing imported files', 'Saving imported files']) {
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
