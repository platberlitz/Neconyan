import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { acceptApplicationOperation, runOperation } = await import('../src/operations/jobs.js');
await import('../src/operations/vectors.js');
await import('../src/operations/vector-purge.js');
const { completeBrowserWork, finalizeBrowserWork } = await import('../src/operations/browser-work.js');
const { readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { readOperation } = await import('../src/operations/store.js');
const { getJob } = await import('../src/jobs/store.js');
const { vectorIndexPath, vectorItem } = await import('../src/operations/vector-index.js');
const { getStringHash } = await import('../public/scripts/macro-primitives.js');

function prepared(t, owner = 'fixture') {
    const f = fixture(t, false, owner);
    const directories = f.scope.directories;
    directories.vectors = path.join(directories.root, 'vectors');
    directories.files = path.join(directories.root, 'user/files');
    fs.mkdirSync(directories.files, { recursive: true });
    const base = { owner, directories };
    const settings = { extension_settings: { vectors: { source: 'llamacpp', message_chunk_size: 400 } },
        textgenerationwebui_settings: { server_urls: { llamacpp: 'https://vector.example.test/' } } };
    const saveSettings = () => fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
    saveSettings();
    const request = { user: { profile: { handle: owner }, directories } };
    const context = job => ({ ...base, job: getJob(directories, job.id), signal: new AbortController().signal, progress: async () => {} });
    const filename = vectorIndexPath(directories, { source: 'llamacpp', settings: { model: '' } }, f.locator.chat);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const old = { version: 1, metadata_config: {}, items: [vectorItem(f.locator.chat,
        { text: 'Old indexed text', hash: getStringHash('Old indexed text'), index: 9 }, [1, 0])] };
    fs.writeFileSync(filename, JSON.stringify(old));
    const body = key => ({ key, kind: 'vectors', action: 'sync-chat', locator: f.locator });
    return { f, base, request, context, settings, saveSettings, filename, old, body };
}

function embeddings(_url, request) {
    const inputs = JSON.parse(request.body).input;
    return new Response(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: [1, index + 1] })) }));
}

test('one accepted vector prompt prepares chat and file contributions without changing saved history', async t => {
    const p = prepared(t);
    const url = '/user/files/context.txt';
    Object.assign(p.settings.extension_settings.vectors, { enabled_chats: true, enabled_files: true, protect: 1, insert: 2,
        size_threshold: 0, size_threshold_db: 0, chunk_size: 100, chunk_size_db: 100,
        template: 'Remember: {{text}}', file_template_db: 'Related: {{text}}', score_threshold: 0.5 });
    p.settings.extension_settings.attachments = [{ url, size: 20 }]; p.saveSettings();
    fs.writeFileSync(path.join(p.base.directories.files, 'context.txt'), 'Canonical file content');
    const records = fs.readFileSync(p.f.filename, 'utf8').trim().split('\n').map(JSON.parse);
    records[1].mes = 'Inline file prefix\nOlder question';
    records[1].extra = { fileLength: 'Inline file prefix\n'.length, files: [{ url, text: 'Inline file content', name: 'Context' }] };
    const bytes = records.map(row => JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(p.f.filename, bytes);
    const accepted = await acceptApplicationOperation(p.request, { ...p.body('prompt'), action: 'prompt' });
    let calls = 0;
    await runOperation(p.context(accepted.job), { fetchImpl: async (_url, request) => {
        calls++;
        const input = JSON.parse(request.body).input;
        return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }));
    } });
    const result = readOperation(p.base, 'prompt').result;
    assert.equal(result.collections.length, 2);
    assert.equal(result.projection.removed.length, 1);
    assert.equal(result.projection.removed[0].original, records[1].mes);
    assert.match(result.projection.extensions.find(item => item.key === '3_vectors').value, /Remember:.*Inline file prefix/s);
    assert.match(result.projection.extensions.find(item => item.key === '4_vectors_data_bank').value, /Related: Inline file content/);
    assert.equal(result.projection.files[0].text, 'Inline file content\n\nOlder question');
    assert.equal(fs.readFileSync(p.f.filename, 'utf8'), bytes);
    await runOperation(p.context(accepted.job), { fetchImpl: async () => assert.fail('A retained projection cannot repeat a provider request') });
    assert.equal(calls, 3);
});

test('WebLLM pauses the accepted job and the server publishes only its acknowledged local vectors', async t => {
    const p = prepared(t);
    Object.assign(p.settings.extension_settings.vectors, { source: 'webllm', webllm_model: 'local-embedding' }); p.saveSettings();
    const accepted = await acceptApplicationOperation(p.request, p.body('browser'));
    assert.deepEqual(await runOperation(p.context(accepted.job)), { waiting: true });
    assert.equal(getJob(p.base.directories, accepted.job.id).state, 'waiting');
    const work = readOperation(p.base, 'browser').browserWork;
    assert.equal(work.kind, 'webllm.embedding');
    const result = work.input.texts.map(() => [1, 0]);
    assert.throws(() => completeBrowserWork(p.base, 'browser', { id: work.id, result: [[0, 0]] }), /wrong number|invalid vectors/);
    completeBrowserWork(p.base, 'browser', { id: work.id, result });
    completeBrowserWork(p.base, 'browser', { id: work.id, result });
    assert.throws(() => completeBrowserWork(p.base, 'browser', { id: work.id, result: result.map(() => [0, 1]) }), /different browser result/);
    await runOperation(p.context(accepted.job), { fetchImpl: async () => assert.fail('WebLLM must not use a remote provider') });
    assert.equal(readOperation(p.base, 'browser').state, 'completed');
    assert.equal(readOperation(p.base, 'browser').result.collections[0].count, 2);
});

test('a saved WebLLM acknowledgement resumes after a crash without asking the browser to compute again', async t => {
    const p = prepared(t);
    Object.assign(p.settings.extension_settings.vectors, { source: 'webllm', webllm_model: 'local-embedding' }); p.saveSettings();
    const accepted = await acceptApplicationOperation(p.request, p.body('browser-crash'));
    await runOperation(p.context(accepted.job));
    const work = readOperation(p.base, 'browser-crash').browserWork;
    const result = work.input.texts.map(() => [1, 0]);
    writeArtifact(p.base.directories, accepted.job.id, `browser-result:${work.id}`, { id: work.id, result, hash: roleplayHash(result) });
    assert.equal(finalizeBrowserWork(p.context(accepted.job)), true);
    assert.equal(readOperation(p.base, 'browser-crash').browserWork, null);
    await runOperation(p.context(accepted.job));
    assert.equal(readOperation(p.base, 'browser-crash').state, 'completed');
    assert.ok(readArtifact(p.base.directories, accepted.job.id, `browser-result:${work.id}`));
});

test('explicit vector purge recovers a known deletion but never removes a later replacement', async t => {
    const p = prepared(t);
    const accepted = await acceptApplicationOperation(p.request, { key: 'purge', kind: 'vector-purge', collectionIds: [p.f.locator.chat] });
    await assert.rejects(runOperation(p.context(accepted.job), { afterVectorDeletion() { throw new Error('Lost deletion response'); } }), /Lost deletion/);
    assert.equal(fs.existsSync(p.filename), false);
    fs.writeFileSync(p.filename, JSON.stringify({ ...p.old, later: true }));
    await assert.rejects(runOperation(p.context(accepted.job)), /newer file has been kept/);
    assert.equal(JSON.parse(fs.readFileSync(p.filename, 'utf8')).later, true);
    fs.rmSync(p.filename);
    await runOperation(p.context(accepted.job));
    fs.writeFileSync(p.filename, JSON.stringify({ ...p.old, later: true }));
    await runOperation(p.context(accepted.job));
    assert.equal(JSON.parse(fs.readFileSync(p.filename, 'utf8')).later, true);
});

test('whole-chat vector indexing keeps the old index until every provider batch is saved', async t => {
    const p = prepared(t);
    const records = fs.readFileSync(p.f.filename, 'utf8').trim().split('\n').map(JSON.parse);
    for (let i = 0; i < 10; i++) records.push({ name: 'User', is_user: true, mes: `Additional message ${i}` });
    fs.writeFileSync(p.f.filename, records.map(row => JSON.stringify(row)).join('\n') + '\n');
    const accepted = await acceptApplicationOperation(p.request, p.body('all'));
    const calls = [];
    await runOperation(p.context(accepted.job), { fetchImpl: async (url, request) => {
        assert.deepEqual(JSON.parse(fs.readFileSync(p.filename, 'utf8')), p.old);
        calls.push(JSON.parse(request.body).input);
        return embeddings(url, request);
    } });
    assert.deepEqual(calls.map(items => items.length), [10, 2]);
    const index = JSON.parse(fs.readFileSync(p.filename, 'utf8'));
    assert.equal(index.items.length, 12);
    assert.equal(new Set(index.items.map(item => item.id)).size, 12);
    assert.ok(index.items.every(item => item.metadata.text !== 'Old indexed text'));
    fs.rmSync(p.filename);
    await runOperation(p.context(accepted.job), { fetchImpl: async () => assert.fail('Completed indexing must not repeat') });
    assert.equal(fs.existsSync(p.filename), false);
    fs.rmSync(path.join(p.base.directories.root, 'jobs/index.json'));
    fs.rmSync(path.join(p.base.directories.root, 'jobs/artifacts'), { recursive: true });
    const replay = await acceptApplicationOperation(p.request, p.body('all'));
    assert.equal(replay.created, false);
    assert.equal(replay.job, null);
    assert.equal(replay.record.state, 'completed');
});

test('an interrupted later embedding batch never repeats the first payment or deletes old vectors', async t => {
    const p = prepared(t);
    const rows = fs.readFileSync(p.f.filename, 'utf8').trim().split('\n').map(JSON.parse);
    for (let i = 0; i < 10; i++) rows.push({ name: 'User', is_user: true, mes: `Message ${i}` });
    fs.writeFileSync(p.f.filename, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const accepted = await acceptApplicationOperation(p.request, p.body('unknown'));
    let calls = 0;
    const dependencies = { fetchImpl: async (url, request) => {
        if (++calls === 2) throw new Error('Connection lost after request');
        return embeddings(url, request);
    } };
    await assert.rejects(runOperation(p.context(accepted.job), dependencies), /Connection lost/);
    await assert.rejects(runOperation(p.context(accepted.job), dependencies), /unknown/i);
    assert.equal(calls, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(p.filename, 'utf8')), p.old);
});

test('a changed indexed source prevents publication and preserves the user correction', async t => {
    const p = prepared(t);
    const accepted = await acceptApplicationOperation(p.request, p.body('changed'));
    await assert.rejects(runOperation(p.context(accepted.job), { fetchImpl: async (url, request) => {
        fs.appendFileSync(p.f.filename, JSON.stringify({ is_user: true, name: 'User', mes: 'Later user correction' }) + '\n');
        return embeddings(url, request);
    } }), /indexed source changed/);
    assert.match(fs.readFileSync(p.f.filename, 'utf8'), /Later user correction/);
    assert.deepEqual(JSON.parse(fs.readFileSync(p.filename, 'utf8')), p.old);
});

test('known vector publication resumes its own physical write without another provider call', async t => {
    const p = prepared(t);
    const accepted = await acceptApplicationOperation(p.request, p.body('publish'));
    let calls = 0;
    await assert.rejects(runOperation(p.context(accepted.job), { fetchImpl: async (...args) => { calls++; return embeddings(...args); },
        afterVectorPublication() { throw new Error('Lost publication response'); } }), /Lost publication response/);
    const saved = fs.readFileSync(p.filename, 'utf8');
    await runOperation(p.context(accepted.job), { fetchImpl: async () => assert.fail('No repeated provider request') });
    assert.equal(fs.readFileSync(p.filename, 'utf8'), saved);
    assert.equal(readOperation(p.base, 'publish').state, 'completed');
    assert.equal(calls, 1);
});

test('a damaged index is retained and no provider is called to repair it automatically', async t => {
    const p = prepared(t);
    fs.writeFileSync(p.filename, '{ damaged index');
    await assert.rejects(acceptApplicationOperation(p.request, p.body('damaged')), /needs recovery/);
    assert.equal(fs.readFileSync(p.filename, 'utf8'), '{ damaged index');
});

test('file indexing reads attached server files and vector queries filter hashes and metadata together', async t => {
    const p = prepared(t);
    const url = '/user/files/notes.txt';
    p.settings.extension_settings.attachments = [{ url, size: 18 }];
    p.saveSettings();
    fs.writeFileSync(path.join(p.base.directories.files, 'notes.txt'), 'A saved lunar note');
    const accepted = await acceptApplicationOperation(p.request, { key: 'file', kind: 'vectors', action: 'sync-files', urls: [url] });
    await runOperation(p.context(accepted.job), { fetchImpl: async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })) });
    const collectionId = `file_${getStringHash(url)}`;
    const query = await acceptApplicationOperation(p.request, { key: 'query', kind: 'vectors', action: 'query', collectionIds: [collectionId], query: 'Moon', threshold: 0.5 });
    await runOperation(p.context(query.job), { fetchImpl: async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [-1, 0] }] })) });
    assert.deepEqual(readOperation(p.base, 'query').result, {});
    await assert.rejects(acceptApplicationOperation(p.request, { key: 'unattached', kind: 'vectors', action: 'sync-files', urls: ['/user/files/other.txt'] }), /no longer attached/);
});
