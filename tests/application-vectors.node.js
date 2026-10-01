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

test('native prefixes apply exactly once and changed prefixes rebuild before query', async t => {
    const p = prepared(t);
    const calls = [];
    const fetchImpl = async (url, request) => { calls.push(JSON.parse(request.body).input); return embeddings(url, request); };
    Object.assign(p.settings.extension_settings.vectors, { documentPrefix: 'passage: ', queryPrefix: 'query: \n ' });
    p.saveSettings();
    let accepted = await acceptApplicationOperation(p.request, p.body('prefix-first'));
    await runOperation(p.context(accepted.job), { fetchImpl });
    assert.ok(calls.flat().every(text => text.startsWith('passage: ') && !text.startsWith('passage: passage:')));
    assert.ok(JSON.parse(fs.readFileSync(p.filename, 'utf8')).items.every(item => !item.metadata.text.startsWith('passage: ')));
    accepted = await acceptApplicationOperation(p.request, { ...p.body('prefix-query'), action: 'query', collectionIds: [p.f.locator.chat], query: 'moon' });
    await runOperation(p.context(accepted.job), { fetchImpl });
    assert.deepEqual(calls.at(-1), ['query: \n moon']);
    p.settings.extension_settings.vectors.documentPrefix = 'document: '; p.saveSettings();
    accepted = await acceptApplicationOperation(p.request, { ...p.body('prefix-stale'), action: 'query', collectionIds: [p.f.locator.chat], query: 'moon' });
    await assert.rejects(runOperation(p.context(accepted.job), { fetchImpl: async () => assert.fail('Stale vectors cannot be queried') }), /prefixes changed/);
    accepted = await acceptApplicationOperation(p.request, p.body('prefix-rebuild'));
    await runOperation(p.context(accepted.job), { fetchImpl });
    assert.ok(calls.at(-1).every(text => text.startsWith('document: ')));
    accepted = await acceptApplicationOperation(p.request, p.body('prefix-reuse'));
    await runOperation(p.context(accepted.job), { fetchImpl: async () => assert.fail('Unchanged content must reuse vectors') });
});

test('a late embedding response after cancellation leaves the original index intact', async t => {
    const p = prepared(t);
    const accepted = await acceptApplicationOperation(p.request, p.body('cancelled-response'));
    const controller = new AbortController();
    await assert.rejects(runOperation({ ...p.context(accepted.job), signal: controller.signal }, { fetchImpl: async (url, request) => {
        controller.abort();
        return embeddings(url, request);
    } }), /cancelled/);
    assert.deepEqual(JSON.parse(fs.readFileSync(p.filename, 'utf8')), p.old);
});

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

test('chat recall counts distinct older messages before limiting, excluding protected and hidden messages', async t => {
    const p = prepared(t);
    const older = ['An earlier promise has several searchable pieces.', 'A second useful detail.'];
    const records = [p.f.records[0], ...older.map(mes => ({ name: 'User', is_user: true, mes })),
        { name: 'Nova', mes: 'Protected recent answer.' }, { name: 'System', is_system: true, mes: 'Hidden system note.' }];
    fs.writeFileSync(p.f.filename, records.map(JSON.stringify).join('\n'));
    Object.assign(p.settings.extension_settings.vectors, { enabled_chats: true, protect: 2, insert: 2,
        message_chunk_size: 12, query: 1, score_threshold: 0.1 });
    p.saveSettings();
    const accepted = await acceptApplicationOperation(p.request, { ...p.body('distinct-recall'), action: 'prompt' });
    const calls = [];
    await runOperation(p.context(accepted.job), { fetchImpl: async (_url, request) => {
        const input = JSON.parse(request.body).input;
        calls.push(input);
        return new Response(JSON.stringify({ data: input.map((text, index) => ({ index,
            embedding: text.includes('Protected') ? [1, 0] : text.includes('second') ? [0.8, 0.6] : [0.99, 0.1] })) }));
    } });
    const result = readOperation(p.base, 'distinct-recall').result;
    assert.deepEqual(result.projection.removed.map(row => row.original).sort(), older.sort());
    assert.deepEqual(calls.at(-1), ['Protected recent answer.']);
    assert.ok(!calls.flat().some(text => text.includes('Hidden')));
    assert.deepEqual(fs.readFileSync(p.f.filename, 'utf8'), records.map(JSON.stringify).join('\n'));
});

test('rebuild applies new chat chunks atomically and a failed rebuild preserves the previous index', async t => {
    const p = prepared(t);
    const first = await acceptApplicationOperation(p.request, p.body('initial'));
    await runOperation(p.context(first.job), { fetchImpl: embeddings });
    const initial = fs.readFileSync(p.filename, 'utf8');
    p.settings.extension_settings.vectors.message_chunk_size = 3; p.saveSettings();
    const sync = await acceptApplicationOperation(p.request, p.body('unchanged'));
    await runOperation(p.context(sync.job), { fetchImpl: async () => assert.fail('Catch-up must reuse saved message vectors') });
    assert.deepEqual(JSON.parse(fs.readFileSync(p.filename, 'utf8')), JSON.parse(initial));
    const broken = await acceptApplicationOperation(p.request, { ...p.body('broken-rebuild'), rebuild: true });
    await assert.rejects(runOperation(p.context(broken.job), { fetchImpl: async () => { throw new Error('Provider unavailable'); } }), /Provider unavailable/);
    assert.deepEqual(JSON.parse(fs.readFileSync(p.filename, 'utf8')), JSON.parse(initial));
    const rebuild = await acceptApplicationOperation(p.request, { ...p.body('rebuild'), rebuild: true });
    await runOperation(p.context(rebuild.job), { fetchImpl: async (...args) => {
        assert.deepEqual(JSON.parse(fs.readFileSync(p.filename, 'utf8')), JSON.parse(initial));
        return embeddings(...args);
    } });
    const result = JSON.parse(fs.readFileSync(p.filename, 'utf8'));
    assert.ok(result.items.length > 2);
    assert.ok(result.items.every(item => item.metadata.text.length <= 3));
    const details = await acceptApplicationOperation(p.request, { ...p.body('details'), action: 'list', collectionIds: [p.f.locator.chat], details: true });
    await runOperation(p.context(details.job), { fetchImpl: async () => assert.fail('Index inspection does not embed text') });
    assert.equal(readOperation(p.base, 'details').result[p.f.locator.chat].chunks, result.items.length);
    assert.equal(readOperation(p.base, 'details').result[p.f.locator.chat].hashes.length, 2);
});

test('scoped search reads saved indexes while retrieval is off without requiring summaries or modifying history', async t => {
    const p = prepared(t);
    Object.assign(p.settings.extension_settings.vectors, { enabled_chats: false, summarize: true, summary_threshold: 0 }); p.saveSettings();
    const before = fs.readFileSync(p.f.filename, 'utf8');
    const saved = fs.readFileSync(p.filename, 'utf8');
    const accepted = await acceptApplicationOperation(p.request, { ...p.body('preview'), action: 'query', queryScope: 'chat', query: 'Old indexed text', topK: 5, threshold: 0 });
    let calls = 0;
    await runOperation(p.context(accepted.job), { fetchImpl: async (_url, request) => {
        assert.deepEqual(JSON.parse(request.body).input, ['Old indexed text']); calls++;
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    } });
    assert.equal(calls, 1);
    const match = readOperation(p.base, 'preview').result[p.f.locator.chat];
    assert.equal(match.label, p.f.locator.chat);
    assert.deepEqual(match.scores, [1]);
    assert.equal(match.metadata[0].text, 'Old indexed text');
    assert.equal(fs.readFileSync(p.f.filename, 'utf8'), before);
    assert.equal(fs.readFileSync(p.filename, 'utf8'), saved);
    for (const threshold of [-1.1, 1.1, 'invalid']) {
        await assert.rejects(acceptApplicationOperation(p.request, { ...p.body(`invalid-${threshold}`), action: 'query', queryScope: 'chat', query: 'x', threshold }), /similarity threshold/);
    }
});

test('custom file boundaries skip empty pieces, keep repeated positions and search without a translation connection', async t => {
    const p = prepared(t);
    const url = '/user/files/repeated.txt';
    p.settings.extension_settings.attachments = [{ url }];
    Object.assign(p.settings.extension_settings.vectors, { only_custom_boundary: true, force_chunk_delimiter: '|||', size_threshold_db: 0 });
    p.saveSettings();
    fs.writeFileSync(path.join(p.base.directories.files, 'repeated.txt'), '|||Repeated fact||||||Repeated fact|||');
    const accepted = await acceptApplicationOperation(p.request, { ...p.body('repeated'), action: 'sync-files' });
    await runOperation(p.context(accepted.job), { fetchImpl: async (url, request) => {
        assert.deepEqual(JSON.parse(request.body).input, ['Repeated fact', 'Repeated fact']); return embeddings(url, request);
    } });
    const second = await acceptApplicationOperation(p.request, { ...p.body('repeated-again'), action: 'sync-files' });
    await runOperation(p.context(second.job), { fetchImpl: async () => assert.fail('Unchanged repeated chunks must retain both positions') });
    assert.equal(readOperation(p.base, 'repeated-again').result.collections[0].count, 2);
    p.settings.extension_settings.vectors.translate_files = true; p.saveSettings();
    const query = await acceptApplicationOperation(p.request, { ...p.body('file-preview'), action: 'query', queryScope: 'files', query: 'Fact', threshold: -1 });
    await runOperation(p.context(query.job), { fetchImpl: embeddings });
    const matches = readOperation(p.base, 'file-preview').result[`file_${getStringHash(url)}`];
    assert.equal(matches.label, url);
    assert.deepEqual(matches.metadata.map(item => item.index).sort(), [0, 1]);
});

test('equal lorebook contents still respect the entry limit and preserve both entries across indexing', async t => {
    const p = prepared(t);
    p.base.directories.worlds = path.join(p.base.directories.root, 'worlds');
    fs.mkdirSync(p.base.directories.worlds);
    const book = 'Repeated lore';
    fs.writeFileSync(path.join(p.base.directories.worlds, `${book}.json`), JSON.stringify({ entries: {
        1: { uid: 1, content: 'Same detail', vectorized: true }, 2: { uid: 2, content: 'Same detail', vectorized: true },
        3: { uid: 3, content: 'Disabled detail', vectorized: true, disable: true },
    } }));
    p.settings.world_info_settings = { world_info: { globalSelect: [book] } };
    Object.assign(p.settings.extension_settings.vectors, { enabled_world_info: true, max_entries: 1, score_threshold: -1 }); p.saveSettings();
    for (const key of ['lore-first', 'lore-again']) {
        const accepted = await acceptApplicationOperation(p.request, { ...p.body(key), action: 'prompt' });
        await runOperation(p.context(accepted.job), { fetchImpl: embeddings });
        const result = readOperation(p.base, key).result;
        assert.equal(result.collections[0].count, 2);
        assert.equal(result.projection.worldInfo.length, 1);
        assert.ok([1, 2].includes(result.projection.worldInfo[0].uid));
    }
});

test('Vertex Gemini indexes one text per paid step and does not repeat completed steps on recovery', async t => {
    const p = prepared(t);
    const { writeSecret, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
    writeSecret(p.base.directories, SECRET_KEYS.VERTEXAI, 'fixture-key');
    Object.assign(p.settings.extension_settings.vectors, { source: 'vertexai', google_model: 'gemini-embedding-001' }); p.saveSettings();
    const accepted = await acceptApplicationOperation(p.request, p.body('vertex'));
    const calls = [];
    const fetchImpl = async (_url, request) => {
        const { instances } = JSON.parse(request.body); calls.push(instances);
        assert.equal(instances.length, 1);
        if (calls.length === 2) throw new Error('Lost second response');
        return new Response(JSON.stringify({ predictions: [{ embeddings: { values: [1, 0] } }] }));
    };
    await assert.rejects(runOperation(p.context(accepted.job), { fetchImpl }), /Lost second/);
    await assert.rejects(runOperation(p.context(accepted.job), { fetchImpl }), /unknown/i);
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(p.filename, 'utf8')), p.old);
});
