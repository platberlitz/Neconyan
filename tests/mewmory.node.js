/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const {
    continueState, eligibleRecords, forkState, hash, newState, putRecord, recordEligible,
    POLICY_VERSION, ROLE_NAMES, sourceAt, syncSources, undoRecord, validateRecord,
} = await import('../src/mewmory/core.js');
const { activeReferences, assembleContext, generationFingerprint } = await import('../src/mewmory/context.js');
const { callJsonRole, defaultConfig, embed, isLocalEndpoint, validateEndpoint, saveConfig } = await import('../src/mewmory/models.js');
const { applyExtraction, applyInterview, extractionInput, interviewInput, pendingSources, processBatch } = await import('../src/mewmory/processing.js');
const { forcedMatches, validateSelection, recall, recallInBackground } = await import('../src/mewmory/retrieval.js');
const { expandNeighbours, hybridCandidates, lexicalSearch, searchDocuments, splitPassages, updateIndex } = await import('../src/mewmory/search.js');
const { loadCurrentState } = await import('../src/mewmory/sources.js');
const { branchParentLocator, buildBranchMemoryState, chatPath, listStories, mutateState, normalizeLocator, readState, renameChatMemory, renameCharacterMemory, renameWorldMemory, removeChatMemory, removeSourceMemory, statePath, writeJson } = await import('../src/mewmory/store.js');
const { ensureMewmoryMessageIds } = await import('../public/scripts/mewmory/message-identity.js');
const { getCounter, getTokenizerModel } = await import('../src/mewmory/tokens.js');
const { inspectState, restoreRecords } = await import('../src/endpoints/mewmory.js');
const { createMewmoryProvider } = await import('./mewmory-provider.js');
const { readConfig, publicConfig, roleVersion } = await import('../src/mewmory/models.js');
const { readSecret, writeSecret, SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
const { resolveModelProfile } = await import('../src/mewmory/connection-profiles.js');
const { startProcessing, waitForProcessing, cancelProcessing, scanProcessing, startMewmoryWorker } = await import('../src/mewmory/worker.js');
const { startOperation, registerMewmoryOperations } = await import('../src/mewmory/operations.js');
const { getJob: getSavedJob, recoverJobs, updateJob } = await import('../src/jobs/store.js');
const { setDirectoriesResolver, testExports: jobRunner } = await import('../src/jobs/runner.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');

test('RAG prefixes preserve whitespace through saving and real custom and native requests', async t => {
    const { directories } = disk(t);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const config = defaultConfig();
    Object.assign(config.roles.embedding, { enabled: true, endpoint: provider.url, model: 'embedding',
        queryPrefix: 'query: \n ', documentPrefix: 'passage: ' });
    saveConfig(directories, config);
    let saved = readConfig(directories);
    await embed(directories, saved, ['gift'], { dataTypes: ['chat'] });
    await embed(directories, saved, ['gift'], { query: true, dataTypes: ['chat'] });
    assert.deepEqual(provider.calls.map(call => call.input), [['passage: gift'], ['query: \n gift']]);
    assert.equal(publicConfig(directories).roles.embedding.queryPrefix, 'query: \n ');
    const settings = { extension_settings: { vectors: { source: 'llamacpp', use_alt_endpoint: true,
        alt_endpoint_url: provider.url, queryPrefix: 'search_query: ', documentPrefix: 'search_document: ' } } };
    writeJson(path.join(directories.root, 'settings.json'), settings);
    saved.roles.embedding.provider = 'native';
    saveConfig(directories, saved);
    saved = readConfig(directories);
    const version = roleVersion(saved, 'embedding');
    await embed(directories, saved, ['gift'], { dataTypes: ['file'] });
    await embed(directories, saved, ['gift'], { query: true, dataTypes: ['chat'] });
    assert.deepEqual(provider.calls.slice(2).map(call => call.input), [['search_document: gift'], ['search_query: gift']]);
    assert.equal(publicConfig(directories).roles.embedding.native.source, 'llamacpp');
    assert.equal(JSON.stringify(publicConfig(directories)).includes('credentialsHash'), false);
    settings.extension_settings.vectors.documentPrefix = 'new: ';
    writeJson(path.join(directories.root, 'settings.json'), settings);
    assert.notEqual(roleVersion(readConfig(directories), 'embedding'), version);
    await assert.rejects(embed(directories, saved, ['gift']), /settings changed/);
    assert.equal(provider.calls.length, 4, 'a stale native connection cannot dispatch');
    saved = readConfig(directories);
    saved.roles.embedding.allowedData = ['chat'];
    saveConfig(directories, saved);
    await assert.rejects(embed(directories, readConfig(directories), ['file text'], { dataTypes: ['file'] }), /cannot read/);
    assert.equal(provider.calls.length, 4);
    settings.extension_settings.vectors.alt_endpoint_url = 'https://vector.example.test/';
    writeJson(path.join(directories.root, 'settings.json'), settings);
    saved = readConfig(directories); saved.localOnly = true;
    assert.throws(() => saveConfig(directories, saved), /provider is remote/);
    settings.extension_settings.vectors.source = 'webllm';
    writeJson(path.join(directories.root, 'settings.json'), settings);
    assert.match(readConfig(directories).roles.embedding.error, /browser embeddings/);
});

test('archive HTTP search combines semantic retrieval, filters, safe fallback and source revalidation', async t => {
    const { directories, write } = disk(t);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const config = defaultConfig();
    Object.assign(config.roles.embedding, { enabled: true, endpoint: provider.url, model: 'embedding' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    const state = mutateState(directories, locator, state => { event(state); });
    await updateIndex(state, directories, readConfig(directories));
    mutateState(directories, locator, () => state, state.revision);
    const express = (await import('express')).default;
    const { router } = await import('../src/endpoints/mewmory.js');
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => { request.user = { directories }; next(); });
    app.use(router);
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const search = async options => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/search', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locator, query: 'gift', ...options }),
        });
        return { status: response.status, body: await response.json() };
    };
    const calls = provider.calls.length;
    const keyword = await search({ mode: 'keyword', dataType: 'memory', subjectId: 'gift' });
    assert.equal(keyword.status, 200);
    assert.equal(provider.calls.length, calls);
    assert.ok(keyword.body.matches.some(match => match.id === 'event:gift'));
    assert.deepEqual((await search({ mode: 'keyword', ownerId: 'other-character' })).body.matches, []);
    const semantic = await search({ mode: 'semantic', dataType: 'chat', asOf: 0, query: 'unrelated words' });
    assert.equal(semantic.status, 200);
    assert.equal(semantic.body.retrieval.usedMode, 'semantic');
    assert.equal(semantic.body.retrieval.documents, 1);
    assert.ok(semantic.body.matches.length > 0);
    assert.ok(semantic.body.matches.every(match => match.dataType === 'chat' && match.asOf <= 0 && match.retrieval.similarity > 0));
    assert.equal(semantic.body.usage.length, 1);
    provider.mode.fail = true;
    const fallback = await search({ mode: 'hybrid', dataType: 'memory' });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.retrieval.keywordFallback, true);
    assert.ok(fallback.body.retrieval.error);
    assert.ok(fallback.body.matches.some(match => match.id === 'event:gift'));
    assert.equal((await search({ dataType: 'invented' })).status, 400);
    provider.mode.fail = false;
    provider.mode.reply = body => {
        write([{ name: 'Mara', mes: 'The old evidence has been deleted.', is_user: false }]);
        return { data: body.input.map((_, index) => ({ index, embedding: [1, 1, 1] })) };
    };
    const stale = await search({ mode: 'semantic' });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /changed during this search/);
    assert.equal(stale.body.matches, undefined);
});

test('RAG settings validate bounds and retain defaults for older saved configurations', t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    delete config.retrieval;
    delete config.roles.embedding.provider;
    writeJson(path.join(directories.root, 'mewmory/config.json'), config);
    assert.equal(readConfig(directories).retrieval.chunkSize, 1800);
    assert.equal(readConfig(directories).roles.embedding.provider, 'custom');
    const saved = readConfig(directories);
    for (const retrieval of [{ chunkSize: 256, chunkOverlap: 200 }, { batchSize: 11 }, { mode: 'invented' }, { semanticWeight: 1.01 }, { resultLimit: 0 }]) {
        assert.throws(() => saveConfig(directories, { ...saved, retrieval: { ...saved.retrieval, ...retrieval } }));
    }
    const blank = structuredClone(saved);
    blank.roles.embedding.queryPrefix = ' '.repeat(501);
    assert.throws(() => saveConfig(directories, blank), /500/);
    assert.equal(readConfig(directories).revision, 0, 'failed validation never writes settings');
});

test('passages retain exact offsets, cover original text, expand neighbours and remove prompt overlap', () => {
    const original = 'First paragraph with a lunar gift.\n\n' + '🦊 A different sentence about the moon. '.repeat(35);
    const options = { chunkSize: 256, chunkOverlap: 40 };
    const passages = splitPassages(original, options);
    assert.ok(passages.length > 3);
    let covered = 0;
    for (const passage of passages) {
        assert.equal(passage.text, original.slice(passage.start, passage.end));
        assert.ok(passage.text.length <= 256 && passage.start <= covered);
        assert.equal(/[\uD800-\uDBFF]$/u.test(passage.text), false);
        assert.equal(/^[\uDC00-\uDFFF]/u.test(passage.text), false);
        covered = passage.end;
    }
    assert.equal(covered, original.length);
    const state = newState(locator);
    syncSources(state, [{ name: 'Mara', mes: original }]);
    const documents = searchDocuments(state, Infinity, { retrieval: options });
    const expanded = expandNeighbours([documents[1]], documents, 1);
    assert.equal(expanded.length, 3);
    const assembled = assembleContext(state, expanded, { counter, memoryTokens: 10000 });
    const pieces = [...assembled.memoryText.matchAll(/characters (\d+)-(\d+)\][^\n]*\n([^]*?)(?=\n\n\[|$)/g)];
    assert.ok(pieces.length >= 3, 'original source offsets accompany each inserted range');
    const ranges = pieces.map(match => [Number(match[1]), Number(match[2])]).sort((a, b) => a[0] - b[0]);
    assert.ok(ranges.every((range, index) => !index || range[0] >= ranges[index - 1][1]), 'no source character is inserted twice');
    state.excludedSources.push(state.timeline[0].id);
    assert.equal(searchDocuments(state).length, 0);
    assert.equal(assembleContext(state, expanded, { counter }).memoryText, '');
});

test('hybrid ranking honours modes, similarity, source diversity, duplicates and stale vectors', () => {
    const document = (id, text, source = id) => ({ id, text, searchText: text, kind: 'source', refs: [{ id: source, revision: 1 }] });
    const documents = [document('keyword', 'moon moon gift'), document('meaning', 'lunar present'),
        document('second', 'moon second passage', 'keyword'), document('duplicate', 'lunar present'), document('stale', 'unrelated')];
    const index = Object.fromEntries(documents.map(item => [item.id, { textHash: hash(item.searchText), vector: item.id === 'keyword' ? [0, 1] : [1, 0] }]));
    index.stale.textHash = 'old content';
    const keyword = hybridCandidates(documents, 'moon', [1, 0], index, 10, { mode: 'keyword', maxPerSource: 1 });
    assert.deepEqual(keyword.map(item => item.id), ['keyword']);
    const semantic = hybridCandidates(documents, 'moon', [1, 0], index, 10, { mode: 'semantic', minSimilarity: 0.9, maxPerSource: 1 });
    assert.equal(semantic.some(item => item.id === 'keyword' || item.id === 'stale'), false);
    assert.equal(semantic.filter(item => item.text === 'lunar present').length, 1);
    assert.ok(semantic.every(item => item.retrieval.similarity === 1));
    assert.deepEqual(hybridCandidates(documents, 'moon', null, index, 10, { mode: 'semantic', maxPerSource: 1 }).map(item => item.id), ['keyword']);
    assert.equal(hybridCandidates(documents, 'moon', [1, 0], index, 1, { semanticWeight: 0 })[0].id, 'keyword');
    assert.notEqual(hybridCandidates(documents, 'moon', [1, 0], index, 1, { semanticWeight: 1 })[0].id, 'keyword');
    const perspectives = ['mara', 'nova'].map(ownerId => ({ ...document(ownerId, 'moon gift'), kind: 'memory', ownerId }));
    assert.equal(hybridCandidates(perspectives, 'moon', null, {}, 10).length, 2, 'Identical wording does not erase another character’s perspective.');
});

test('file retrieval uses native attachment scope, obeys scene boundaries and purges deleted sources', async t => {
    const messages = [{ mewmory_id: 'before', name: 'Mara', mes: 'Earlier scene.' },
        { mewmory_id: 'after', name: 'Mara', mes: 'Reads the file.', extra: { files: [{ url: '/user/files/later.txt', text: 'Future lunar secret' }] } }];
    const { directories, write } = disk(t, messages);
    directories.files = path.join(directories.root, 'user/files');
    fs.mkdirSync(directories.files, { recursive: true });
    for (const name of ['global', 'character', 'other', 'disabled']) fs.writeFileSync(path.join(directories.files, name + '.txt'), name + ' saved text');
    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: {
        attachments: [{ url: '/user/files/global.txt' }, { url: '/user/files/disabled.txt' }],
        disabled_attachments: ['/user/files/disabled.txt'], character_attachments: {
            'Mara.png': [{ url: '/user/files/character.txt' }], 'Other.png': [{ url: '/user/files/other.txt' }],
        },
    } });
    let state = await loadCurrentState(directories, locator);
    const files = state => searchDocuments(state).filter(document => document.dataType === 'file');
    assert.equal(files(state).length, 3);
    assert.doesNotMatch(JSON.stringify(files(state)), /disabled saved|other saved/);
    assert.doesNotMatch(JSON.stringify(searchDocuments(state, 0)), /Future lunar/);
    assert.doesNotMatch(JSON.stringify(extractionInput(state, state.timeline, 0, false)), /Future lunar|global saved/);
    mutateState(directories, locator, current => { current.excludedSources.push(current.timeline[1].id); });
    state = await loadCurrentState(directories, locator);
    assert.doesNotMatch(JSON.stringify(files(state)), /Future lunar/);
    write(messages.slice(0, 1));
    state = await loadCurrentState(directories, locator);
    assert.doesNotMatch(JSON.stringify(state), /Future lunar/);
    fs.rmSync(path.join(directories.files, 'global.txt'));
    state = await loadCurrentState(directories, locator);
    assert.doesNotMatch(JSON.stringify(state), /global saved text/);
    const config = readConfig(directories); config.retrieval.includeFiles = false;
    saveConfig(directories, config);
    state = await loadCurrentState(directories, locator);
    assert.equal(files(state).length, 0);
});

test('ranked recall works without a selector and local replies never dispatch model requests', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base'; config.retrieval.resultLimit = 2;
    saveConfig(directories, config);
    const dependencies = { call: async () => assert.fail('No selector is enabled'), embedFn: async () => assert.fail('No embeddings are enabled'), scheduleBackground: false };
    const result = await recall(directories, locator, { query: 'gift' }, dependencies);
    assert.ok(result.memoryText.length > 0);
    assert.ok(result.selected.length <= 2);
    assert.equal(result.inspection.retrieval.aiSelection, false);
    assert.equal(result.inspection.retrieval.usedMode, 'keyword');
    assert.doesNotMatch(result.memoryText, /Selected by ranked retrieval/);
    const saved = readConfig(directories);
    for (const role of ['embedding', 'selector']) Object.assign(saved.roles[role], { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: role });
    saveConfig(directories, saved);
    const local = await recall(directories, locator, { local: true, query: 'gift' }, dependencies);
    assert.ok(local.memoryText.length > 0);
    assert.equal(local.inspection.status, 'local');
});

test('forks remove future file copies and continuations retain the original attachment parent', () => {
    const messages = structuredClone(fixture.messages);
    const state = newState(locator);
    syncSources(state, messages, [
        { id: 'file:early', type: 'file', name: 'Early', text: 'Early attachment evidence.', meta: { messageIndex: 0 } },
        { id: 'file:future', type: 'file', name: 'Later', text: 'FUTURE FILE SECRET.', meta: { messageIndex: 5 } },
    ]);
    const early = forkState(state, { ...locator, chat: 'Early fork' }, 2, messages.slice(0, 3));
    assert.equal(JSON.stringify(early).includes('FUTURE FILE SECRET'), false);
    assert.ok(searchDocuments(early).some(document => document.text === 'Early attachment evidence.'));
    const continued = continueState(state, { ...locator, chat: 'Continued' }, [{ name: 'User', mes: 'A later conversation.', send_date: 'new' }]);
    const file = sourceAt(continued, continued.contextSources.find(ref => ref.id === 'file:future'));
    assert.deepEqual(file.meta.parentRef, state.timeline[5]);
    assert.equal(searchDocuments(continued, 2).some(document => document.text === 'FUTURE FILE SECRET.'), false);
    assert.ok(searchDocuments(continued).some(document => document.text === 'FUTURE FILE SECRET.'));
});

test('an embedding dimension change cannot partially publish a replacement index', async () => {
    const state = base(); const config = defaultConfig();
    config.roles.embedding.enabled = true;
    config.retrieval.batchSize = 1;
    const before = structuredClone(state.index);
    let calls = 0;
    await assert.rejects(updateIndex(state, {}, config, { embedFn: async () => ({ vectors: [++calls === 1 ? [1, 0] : [1, 0, 0]], usage: {} }) }), /dimensions changed/);
    assert.deepEqual(state.index, before);
});

test('manual index rebuild owns every batch, persists its result and does not replay completed calls', async t => {
    const messages = Array.from({ length: 80 }, (_, index) => ({ name: 'Mara', mes: 'Saved passage ' + index, is_user: false }));
    const { directories, write } = disk(t, messages);
    const config = defaultConfig();
    config.autoUpdate = false;
    Object.assign(config.roles.embedding, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    let calls = 0;
    registerMewmoryOperations({ embedFn: async (_dirs, _config, inputs) => {
        calls++;
        if (calls === 2) write([...messages, { name: 'Mara', mes: 'Arrived while rebuilding', is_user: false }]);
        return { vectors: inputs.map(() => [1, 0]), usage: { role: 'embedding' } };
    } });
    t.after(() => registerMewmoryOperations());
    setDirectoriesResolver(() => directories);
    const request = { locator, reset: true, submissionKey: 'index-all' };
    const first = await startOperation(directories, 'test', 'index', request);
    assert.equal(first.job.state, 'queued');
    assert.equal((await startOperation(directories, 'test', 'index', request)).job.id, first.job.id);
    await jobRunner.runJob(first.job);
    assert.equal(getSavedJob(directories, first.job.id).state, 'completed');
    assert.deepEqual(readArtifact(directories, first.job.id, 'result'), { remaining: 0 });
    assert.ok(calls >= 5, 'all batches run without any browser continuation');
    assert.equal(readState(directories, locator).index.pending, false);
    assert.equal(readState(directories, locator).timeline.length, 81);
    const before = calls;
    updateJob(directories, first.job.id, { state: 'running' });
    recoverJobs(directories);
    await jobRunner.runJob(getSavedJob(directories, first.job.id));
    assert.equal(calls, before, 'saved result prevents re-execution after a completion-status crash');
    const changed = await startOperation(directories, 'test', 'index', { ...request, submissionKey: 'index-stale' });
    mutateState(directories, locator, state => { state.enabled = false; });
    await jobRunner.runJob(changed.job);
    assert.equal(getSavedJob(directories, changed.job.id).state, 'failed');
    assert.equal(calls, before, 'changed source scope is rejected before any provider call');
});

test('server processing owns the whole backfill, deduplicates starts and resumes persisted work', async t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    config.autoUpdate = false;
    config.batchMessages = 1;
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const call = async () => {
        calls++;
        await hold;
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } };
    };
    const started = await startProcessing(directories, locator, { all: true, checkpoint: true }, call);
    assert.equal(started.processing.status, 'running');
    const duplicate = await startProcessing(directories, locator, { all: true }, call);
    assert.equal(duplicate.processing.id, started.processing.id);
    release();
    const completed = await waitForProcessing(directories, locator);
    assert.equal(completed.processing.status, 'complete');
    assert.equal(pendingSources(completed, readConfig(directories), { checkpoint: true }).length, 0);
    assert.equal(calls, completed.timeline.length);
    const savedConfig = readConfig(directories);
    const legacyPolicy = hash([POLICY_VERSION, ...['extractor', 'pawspective'].map(name => hash([savedConfig.localOnly, savedConfig.roles[name]]))]);
    mutateState(directories, locator, state => {
        for (const coverage of [state.coverage, state.checkpoints]) {
            for (const key of Object.keys(coverage)) coverage[key] = legacyPolicy;
        }
        state.coverage.unrelated = 'different-policy';
    });
    const migrated = await loadCurrentState(directories, locator);
    assert.equal(pendingSources(migrated, savedConfig, { checkpoint: true }).length, 0);
    assert.equal(migrated.coverage.unrelated, 'different-policy');
    mutateState(directories, locator, state => {
        state.coverage = {};
        state.checkpoints = {};
        state.processing.status = 'running';
    });
    await scanProcessing(directories, call);
    const resumed = await waitForProcessing(directories, locator);
    assert.equal(resumed.processing.status, 'complete');
    assert.notEqual(resumed.processing.id, started.processing.id);
    assert.equal(pendingSources(resumed, readConfig(directories), { checkpoint: true }).length, 0);
    assert.equal(forkState(started, { ...locator, chat: 'Fork' }, 0, fixture.messages.slice(0, 1)).processing, null);
    assert.equal(continueState(started, { ...locator, chat: 'Continued' }, []).processing, null);
});

test('server automatic processing works without a browser and explicit cancellation stays stopped', async t => {
    const { directories, write } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    let entered;
    const active = new Promise(resolve => { entered = resolve; });
    let calls = 0;
    const held = async (_directories, _config, _role, _contract, _input, { signal }) => {
        calls++;
        entered();
        await new Promise((resolve, reject) => {
            if (signal.aborted) return reject(new Error('cancelled'));
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
    };
    await scanProcessing(directories, held);
    await active;
    await cancelProcessing(directories, locator);
    const cancelled = await waitForProcessing(directories, locator);
    assert.equal(cancelled.processing.status, 'cancelled');
    assert.equal(Object.keys(cancelled.coverage).length, 0);
    await scanProcessing(directories, held);
    assert.equal(calls, 1);
    write([...fixture.messages, { name: 'Mara', mes: 'A new message.', is_user: false }]);
    await scanProcessing(directories, async () => ({ value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } }));
    const completed = await waitForProcessing(directories, locator);
    assert.equal(completed.processing.status, 'complete');
    assert.equal(pendingSources(completed, readConfig(directories), { checkpoint: true }).length, 0);
});

test('an overlapping start cannot silently downgrade requested backfill or preservation', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    await startProcessing(directories, locator, {}, async () => {
        await hold;
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } };
    });
    try {
        await assert.rejects(startProcessing(directories, locator, { all: true }), { status: 409 });
        await assert.rejects(startProcessing(directories, locator, { checkpoint: true }), { status: 409 });
    } finally {
        release();
        await waitForProcessing(directories, locator);
    }
});

test('startup clears interrupted jobs that are now disabled and skips idle source reconciliation', async t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    config.autoUpdate = false;
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        state.processing = { status: 'running', automatic: true };
    });
    await scanProcessing(directories);
    assert.equal(readState(directories, locator).processing.status, 'complete');
    mutateState(directories, locator, state => {
        state.enabled = false;
        state.processing = { status: 'running', automatic: false };
    });
    await scanProcessing(directories);
    assert.equal(readState(directories, locator).processing.status, 'complete');
    mutateState(directories, locator, state => { state.enabled = true; });
    const read = t.mock.method(fs, 'readFileSync');
    await scanProcessing(directories);
    assert.equal(read.mock.calls.filter(call => call.arguments[0] === chatPath(directories, locator)).length, 0);
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    config.autoUpdate = true;
    saveConfig(directories, { ...config, revision: readConfig(directories).revision });
    await scanProcessing(directories, async () => ({ value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } }));
    const completed = await waitForProcessing(directories, locator);
    assert.equal(pendingSources(completed, readConfig(directories), { checkpoint: true }).length, 0);
});

test('changing a timeout preserves extraction coverage but changing the provider invalidates it', () => {
    const config = defaultConfig();
    const original = roleVersion(config, 'extractor');
    config.roles.extractor.timeoutMs++;
    assert.equal(roleVersion(config, 'extractor'), original);
    config.roles.extractor.endpoint = 'http://127.0.0.1:1234/v1';
    assert.notEqual(roleVersion(config, 'extractor'), original);
});

test('finished jobs wake the queue and automatic work leaves capacity for a manual request', async t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    saveConfig(directories, config);
    const stories = Array.from({ length: 6 }, (_, index) => ({ ...locator, chat: `Queued ${index}` }));
    for (const story of stories) {
        fs.copyFileSync(chatPath(directories, locator), chatPath(directories, story));
        await loadCurrentState(directories, story);
        mutateState(directories, story, state => { state.enabled = true; });
    }
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const call = async () => {
        await hold;
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } };
    };
    await startProcessing(directories, stories[0], { all: true, automatic: true }, call);
    await startProcessing(directories, stories[1], { all: true, automatic: true }, call);
    try {
        const manual = await startProcessing(directories, stories[2], { all: true }, call);
        assert.equal(manual.processing.status, 'running');
    } finally {
        release();
        await Promise.all(stories.slice(0, 3).map(story => waitForProcessing(directories, story)));
    }
    const stop = startMewmoryWorker(async () => [directories], call);
    try {
        for (let attempt = 0; attempt < 200 && stories.some(story => readState(directories, story).processing?.status !== 'complete'); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(stories.every(story => readState(directories, story).processing?.status === 'complete'), 'queue should drain without another 15-second tick');
    } finally {
        stop();
        await Promise.all(stories.map(story => waitForProcessing(directories, story)));
    }
});

test('connection profiles resolve server-side and retain local-only permissions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-profiles-'));
    const provider = await createMewmoryProvider();
    const directories = { root };
    try {
        const remoteKey = writeSecret(directories, SECRET_KEYS.OPENAI, 'test-openai-key');
        writeJson(path.join(root, 'settings.json'), { extension_settings: { connectionManager: { profiles: [
            { id: 'local', name: 'Local facts', api: 'custom', 'api-url': provider.url, model: 'extractor' },
            { id: 'remote', name: 'Remote facts', api: 'openai', model: 'gpt-4o', 'secret-id': remoteKey },
        ] } } });
        const config = defaultConfig();
        assert.equal(config.localOnly, false, 'remote model requests are allowed by default');
        assert.ok(ROLE_NAMES.every(name => config.roles[name].allowRemote));
        assert.ok(ROLE_NAMES.every(name => config.roles[name].contextTokens === 200000));
        assert.ok(ROLE_NAMES.every(name => config.roles[name].maxOutputTokens === (name === 'embedding' ? 0 : 32000)));
        assert.ok(ROLE_NAMES.every(name => config.roles[name].timeoutMs === 300000));
        Object.assign(config.roles.extractor, { enabled: true, profileId: 'local' });
        saveConfig(directories, config);
        assert.equal(publicConfig(directories).profiles.length, 2);
        const saved = readConfig(directories);
        assert.equal(saved.roles.extractor.model, 'extractor');
        const result = await callJsonRole(directories, saved, 'extractor', 'Extract facts.', { sources: [], existing: [] });
        assert.deepEqual(result.value.records, []);
        assert.equal(provider.calls.at(-1).model, 'extractor');
        assert.equal(result.usage.tokenizer, 'gpt-3.5-turbo');
        saved.roles.extractor.profileId = 'remote';
        saved.localOnly = true;
        assert.throws(() => saveConfig(directories, saved), /not allowed/);
        saved.localOnly = false;
        saved.roles.extractor.allowRemote = false;
        assert.throws(() => saveConfig(directories, saved), /not allowed/);
        saved.roles.extractor.allowRemote = true;
        saveConfig(directories, saved);
        assert.equal(readConfig(directories).roles.extractor.profileId, 'remote');
        writeJson(path.join(root, 'settings.json'), {});
        assert.match(readConfig(directories).roles.extractor.error, /no longer exists/);
        assert.equal(publicConfig(directories).roles.extractor.profileId, 'remote');
    } finally {
        await new Promise(resolve => provider.server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a missing profile model names the role, preserves saved settings and accepts a role-specific override', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-profile-model-'));
    const provider = await createMewmoryProvider();
    t.after(async () => {
        await new Promise(resolve => provider.server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const directories = { root };
    writeJson(path.join(root, 'settings.json'), { custom_endpoint_presets: [{ name: 'facts', url: provider.url, model: 'extractor' }],
        extension_settings: { connectionManager: { profiles: [
            { id: 'facts', name: 'Facts', api: 'custom', 'custom-endpoint-profile': 'facts' },
            { id: 'embedding', name: 'Embedding', api: 'custom', 'api-url': provider.url },
        ] } } });
    const config = defaultConfig();
    config.writerTokenizer = 'o200k_base';
    Object.assign(config.roles.extractor, { enabled: true, profileId: 'facts' });
    Object.assign(config.roles.embedding, { enabled: true, profileId: 'embedding' });
    config.roles.fallback.profileId = 'deleted-disabled-profile';
    assert.throws(() => saveConfig(directories, config), /Embeddings:.*no saved model.*Enter a Model/);
    assert.equal(publicConfig(directories).revision, 0);
    assert.equal(readConfig(directories).roles.extractor.enabled, false);
    config.roles.embedding.enabled = false;
    const saved = saveConfig(directories, config);
    assert.equal(saved.profiles[0].model, 'extractor');
    assert.equal(readConfig(directories).roles.extractor.enabled, true);
    assert.equal(readConfig(directories).roles.embedding.connection, undefined);
    saved.roles.embedding.enabled = true;
    assert.throws(() => saveConfig(directories, saved), /Embeddings:.*no saved model/);
    assert.equal(publicConfig(directories).revision, saved.revision);
    saved.roles.embedding.modelOverride = 'text-embedding-3-small';
    saveConfig(directories, saved);
    const resolved = readConfig(directories);
    assert.equal(resolved.roles.embedding.model, 'text-embedding-3-small');
    assert.equal(resolved.roles.embedding.connection.endpoint, provider.url);
    assert.equal(publicConfig(directories).roles.embedding.autoTokenizer, 'gpt-3.5-turbo');
    const embeddings = await embed(directories, resolved, ['猫 🐾 memory']);
    assert.equal(embeddings.vectors.length, 1);
    assert.equal(embeddings.usage.tokenizer, 'gpt-3.5-turbo');
    assert.equal(provider.calls.at(-1).model, 'text-embedding-3-small');
    resolved.roles.extractor.tokenizer = 'cl100k_base';
    saveConfig(directories, resolved);
    const facts = await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract facts.', { sources: [], existing: [] });
    assert.equal(facts.usage.tokenizer, 'cl100k_base');
    const invalid = publicConfig(directories);
    invalid.roles.extractor.contextTokens = 0;
    assert.throws(() => saveConfig(directories, invalid), /Facts and events:.*Context limit, tokens/);
});

test('saved context limits stay unchanged and size errors name the role, counts and setting', async t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test', contextTokens: 1024, maxOutputTokens: 900 });
    saveConfig(directories, config);
    const saved = readConfig(directories);
    assert.equal(saved.roles.extractor.contextTokens, 1024);
    await assert.rejects(callJsonRole(directories, saved, 'extractor', 'Extract facts.', { text: 'long passage '.repeat(400) }), error => {
        assert.equal(error.status, 409);
        assert.match(error.message, /Facts and events needs [\d,]+ tokens.*reserves 900.*context limit is 1,024/);
        assert.match(error.message, /Context limit, tokens.*Messages per update/);
        assert.doesNotMatch(error.message, /extractor|configured context/);
        return true;
    });
});

test('Auto matches the role model independently, handles model families and retains explicit tokenizers', async () => {
    assert.equal(getTokenizerModel('OpenAI/GPT-4o-mini'), 'gpt-4o');
    assert.equal(getTokenizerModel('Qwen/Qwen3-Embedding-0.6B'), 'qwen2');
    assert.equal(getTokenizerModel('Gemma-4-31B-it'), 'gemma');
    assert.equal(getTokenizerModel('deepseek/deepseek-v4.1-flash'), 'deepseek');
    assert.equal(getTokenizerModel('unknown-provider-alias'), 'gpt-3.5-turbo');
    const hint = { tokenizerKey: 'openai', tokenizerName: 'OpenAI/GPT-4o-mini' };
    const auto = await getCounter('auto', hint);
    const explicit = await getCounter('cl100k_base', hint);
    const matching = await getCounter('o200k_base');
    assert.equal(auto.name, 'gpt-4o');
    assert.equal(explicit.name, 'cl100k_base');
    assert.equal(auto.count('猫 🐾 café\nFacts and events'), matching.count('猫 🐾 café\nFacts and events'));
    await assert.rejects(getCounter('auto', { tokenizerKey: 'api_current' }), /local writer tokenizer/);
});

test('saved profiles keep keyless connections anonymous, enforce bindings, and reject redirects for every request role', async t => {
    const { directories } = disk(t);
    const provider = await createMewmoryProvider();
    const destination = await createMewmoryProvider();
    t.after(async () => {
        await new Promise(resolve => provider.server.close(resolve));
        await new Promise(resolve => destination.server.close(resolve));
    });
    writeSecret(directories, SECRET_KEYS.CUSTOM, 'another-service-key');
    const profile = { id: 'local', api: 'custom', 'api-url': provider.url.replace('127.0.0.1', 'localhost'), model: 'extractor' };
    const settings = { extension_settings: { connectionManager: { profiles: [profile] } } };
    writeJson(path.join(directories.root, 'settings.json'), settings);
    const config = defaultConfig();
    config.localOnly = true;
    for (const name of ['extractor', 'embedding', 'fallback']) Object.assign(config.roles[name], { enabled: true, profileId: 'local' });
    saveConfig(directories, config);
    const input = { sources: [], existing: [] };
    await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract facts.', input);
    await embed(directories, readConfig(directories), ['Anonymous embedding']);
    assert.ok(provider.calls.every(call => !call.headers.authorization));
    assert.ok(provider.calls.every(call => call.headers.host.startsWith('127.0.0.1:')));
    const captured = readConfig(directories);
    profile['secret-id'] = writeSecret(directories, SECRET_KEYS.CUSTOM, 'this-service-key');
    writeJson(path.join(directories.root, 'settings.json'), settings);
    await assert.rejects(callJsonRole(directories, captured, 'extractor', 'Extract.', input), /settings changed/);
    await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input);
    assert.equal(provider.calls.at(-1).headers.authorization, 'Bearer this-service-key');
    for (const status of [307, 308]) {
        provider.mode.redirectStatus = status;
        provider.mode.redirect = destination.url + '/chat/completions';
        for (const name of ['extractor', 'fallback']) await assert.rejects(callJsonRole(directories, readConfig(directories), name, 'Extract.', input));
        await assert.rejects(embed(directories, readConfig(directories), ['Private passage']));
    }
    assert.equal(destination.calls.length, 0);
    const manual = publicConfig(directories);
    Object.assign(manual.roles.fallback, { profileId: '', endpoint: provider.url, model: 'extractor' });
    saveConfig(directories, manual);
    await assert.rejects(callJsonRole(directories, readConfig(directories), 'fallback', 'Extract.', input));
    assert.equal(destination.calls.length, 0);
    new SecretManager(directories).deleteSecret(SECRET_KEYS.CUSTOM, profile['secret-id']);
    await assert.rejects(callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input), /own saved API key/);
    const before = provider.calls.length;
    delete profile['secret-id'];
    profile['api-url'] = destination.url;
    writeJson(path.join(directories.root, 'settings.json'), settings);
    await assert.rejects(callJsonRole(directories, captured, 'extractor', 'Extract.', input), /settings changed/);
    assert.equal(provider.calls.length, before);
    assert.equal(destination.calls.length, 0);
});

test('credential saves roll back on invalid input or failed configuration writes and clearing removes older keys', t => {
    const { directories } = disk(t);
    let config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test', apiKey: 'key-A' });
    config = saveConfig(directories, config);
    const previous = fs.readFileSync(path.join(directories.root, 'secrets.json'));
    config.roles.extractor.apiKey = 'key-B';
    config.roles.pawspective.apiKey = '   ';
    assert.throws(() => saveConfig(directories, config), /API key/);
    assert.deepEqual(fs.readFileSync(path.join(directories.root, 'secrets.json')), previous);
    delete config.roles.pawspective.apiKey;
    const rename = fs.renameSync;
    const fault = t.mock.method(fs, 'renameSync', (from, to) => {
        if (to === path.join(directories.root, 'mewmory', 'config.json')) throw new Error('Simulated configuration write failure');
        return rename(from, to);
    });
    assert.throws(() => saveConfig(directories, config), /Simulated configuration write failure/);
    fault.mock.restore();
    assert.deepEqual(fs.readFileSync(path.join(directories.root, 'secrets.json')), previous);
    assert.equal(readConfig(directories).revision, config.revision);
    config = saveConfig(directories, config);
    assert.equal(readSecret(directories, 'mewmory_extractor'), 'key-B');
    config.roles.extractor.clearKey = true;
    const cleared = saveConfig(directories, config);
    assert.equal(cleared.roles.extractor.hasKey, false);
    assert.equal(readSecret(directories, 'mewmory_extractor'), '');
    assert.equal(new SecretManager(directories).getAllSecrets().mewmory_extractor, undefined);
});

test('broken optional profiles and disabled manual connections do not block inspection or local recall', async t => {
    const { directories } = disk(t);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const settings = { extension_settings: { connectionManager: { profiles: [{ id: 'optional', api: 'custom', 'api-url': provider.url, model: 'embedding' }] } } };
    writeJson(path.join(directories.root, 'settings.json'), settings);
    const config = defaultConfig();
    config.localOnly = true;
    Object.assign(config.roles.selector, { enabled: true, endpoint: provider.url, model: 'selector' });
    Object.assign(config.roles.embedding, { enabled: true, profileId: 'optional' });
    config.writerTokenizer = 'cl100k_base';
    config.roles.extractor.endpoint = 'https://disabled.example/v1';
    config.roles.pawspective.endpoint = 'unfinished address';
    saveConfig(directories, config);
    writeJson(path.join(directories.root, 'settings.json'), {});
    assert.match(readConfig(directories).roles.embedding.error, /no longer exists/);
    assert.equal(readConfig(directories).roles.selector.error, undefined);
    await loadCurrentState(directories, locator);
    const state = mutateState(directories, locator, state => { state.enabled = true; event(state); });
    assert.doesNotThrow(() => inspectState(state, readConfig(directories)));
    const result = await recall(directories, locator, { local: true });
    assert.equal(result.enabled, true);
    assert.equal(result.inspection.status, 'local');
    const completed = await recallInBackground(directories, locator);
    assert.match(completed.inspection.indexError, /no longer exists/);
    assert.match(publicConfig(directories).roles.embedding.error, /no longer exists/);
});

test('profile-bound Azure and Workers settings resolve without active-writer defaults, and native proxies retain usage and truncation', async t => {
    const { directories } = disk(t);
    directories.openAI_Settings = path.join(directories.root, 'OpenAI Settings');
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const azureKey = writeSecret(directories, SECRET_KEYS.AZURE_OPENAI, 'azure-test-key');
    const workersKey = writeSecret(directories, SECRET_KEYS.WORKERS_AI, 'workers-test-key');
    writeJson(path.join(directories.openAI_Settings, 'Azure.json'), { azure_base_url: provider.url, azure_deployment_name: 'saved-deployment', azure_api_version: '2024-10-21' });
    writeJson(path.join(directories.openAI_Settings, 'Workers.json'), { workers_ai_account_id: 'saved-account' });
    const profiles = [
        { id: 'azure', api: 'azure_openai', model: 'extractor', preset: 'Azure', 'secret-id': azureKey },
        { id: 'workers', api: 'workers_ai', model: 'extractor', preset: 'Workers', 'secret-id': workersKey },
        ...['openai', 'claude', 'makersuite'].map(api => ({ id: api, api, model: 'extractor', proxy: 'Local proxy' })),
    ];
    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { connectionManager: { profiles } }, proxies: [{ name: 'Local proxy', url: provider.url, password: 'proxy-test-key' }],
        oai_settings: { workers_ai_account_id: 'wrong-active-account', azure_base_url: 'https://wrong.example' } });
    const azure = resolveModelProfile(directories, 'azure');
    assert.equal(azure.payload.azure_base_url, provider.url);
    assert.equal(azure.payload.azure_deployment_name, 'saved-deployment');
    const workers = resolveModelProfile(directories, 'workers');
    assert.equal(workers.payload.workers_ai_account_id, 'saved-account');
    const { runBackendGeneration } = await import('../src/endpoints/conversation-generation.js');
    const request = Object.assign(new EventEmitter(), { user: { directories }, headers: {}, socket: new EventEmitter() });
    await runBackendGeneration(request, 'chat', { ...workers.payload, messages: [{ role: 'user', content: 'Test' }], max_tokens: 32 }, {
        fetch: async (url, options) => {
            assert.match(url, /accounts\/saved-account\/ai\/v1\/chat\/completions/);
            assert.equal(options.headers.Authorization, 'Bearer workers-test-key');
            return new Response(JSON.stringify({ choices: [{ message: { content: 'Test' } }] }));
        },
    });
    fs.unlinkSync(path.join(directories.openAI_Settings, 'Workers.json'));
    assert.throws(() => resolveModelProfile(directories, 'workers'), /workers ai account id/);
    const content = JSON.stringify({ records: [], interviews: [], activeNpcIds: [] });
    for (const api of ['azure', 'openai', 'claude', 'makersuite']) {
        const config = publicConfig(directories);
        config.localOnly = true;
        Object.assign(config.roles.extractor, { enabled: true, profileId: api, tokenizer: 'cl100k_base' });
        saveConfig(directories, config);
        provider.mode.reply = api === 'claude'
            ? { content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 11, cache_read_input_tokens: 3, output_tokens: 7 } }
            : api === 'makersuite' ? { candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 5, thoughtsTokenCount: 2 } }
                : { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 14, completion_tokens: 7 } };
        const result = await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', { sources: [], existing: [] });
        assert.equal(result.usage.input, 14);
        assert.equal(result.usage.output, 7);
        assert.ok(provider.calls.at(-1).headers.host.startsWith('127.0.0.1:'));
        if (api === 'azure') assert.match(provider.calls.at(-1).url, /deployments\/saved-deployment\/chat\/completions\?api-version=2024-10-21/);
        if (api === 'openai') assert.equal(provider.calls.at(-1).headers.authorization, 'Bearer proxy-test-key');
        if (api === 'claude') provider.mode.reply.stop_reason = 'max_tokens';
        else if (api === 'makersuite') provider.mode.reply.candidates[0].finishReason = 'MAX_TOKENS';
        else provider.mode.reply.choices[0].finish_reason = 'length';
        await assert.rejects(callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', {}), /cut short/);
    }
});

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/mewmory-gift.json', import.meta.url), 'utf8'));
const locator = { avatar: 'Mara.png', chat: 'Gift', group: false };
const counter = { name: 'test', count: value => String(value).split(/\s+/).filter(Boolean).length };

function base(messages = fixture.messages) {
    const state = newState(locator);
    syncSources(state, structuredClone(messages), fixture.lore);
    state.enabled = true;
    state.sceneNpcIds = ['npc:mara'];
    putRecord(state, validateRecord(state, {
        id: 'entity:mara', kind: 'entity', entityId: 'npc:mara', name: 'Mara', text: 'Mara',
        isCharacter: true, appearance: fixture.expectations.appearance, speech: 'Clipped, formal sentences.',
        refs: [state.timeline[0]], subjectIds: ['npc:mara'],
    }, { asOf: 0, origin: 'objective_extractor' }), { automatic: true });
    return state;
}

function event(state, { id = 'event:gift', refs = [state.timeline[2]], text = 'Mara accepted the gift.', asOf = 2, ...other } = {}) {
    const record = validateRecord(state, {
        id, kind: 'event', text, refs, subjectIds: ['gift'], evidenceStatus: 'established', ...other,
    }, { asOf, origin: 'objective_extractor' });
    putRecord(state, record, { automatic: true });
    return record;
}

function knowledge(state, { id = 'knowledge:gift', sequence = 2, text = 'Mara accepted the gift and suspected pity.', quote = 'Mara accepts the gift.' } = {}) {
    const record = validateRecord(state, {
        id, kind: 'knowledge', ownerId: 'npc:mara', subjectIds: ['gift'], text,
        method: 'witnessed', evidenceText: quote, refs: [state.timeline[sequence]],
    }, { asOf: sequence, origin: 'objective_extractor' });
    putRecord(state, record, { automatic: true });
    return record;
}

function interview(state, sequence, knowledgeId, label, view, job) {
    const request = {
        ownerId: 'npc:mara', subjectIds: ['gift'], knowledgeIds: [knowledgeId],
        refs: [state.timeline[sequence]], significance: 'medium', evidenceRefs: [state.timeline[sequence]],
    };
    const input = interviewInput(state, request, sequence);
    applyInterview(state, request, {
        changed: true, interview: [{ question: 'What do you think of the gift?', answer: label }],
        searchDescription: 'SEARCH ONLY ' + label, changeExplanation: sequence > 2 ? 'She learned when it was bought.' : '',
        overviews: [{ subjectId: 'gift', text: view, status: sequence > 2 ? 'resolved' : 'active' }],
    }, input, job);
    return state.records.findLast(record => record.kind === 'interview');
}

function giftHistory() {
    const state = base();
    event(state);
    knowledge(state);
    const original = interview(state, 2, 'knowledge:gift', fixture.expectations.interview_only_gesture,
        fixture.expectations.original_view, 'original');
    knowledge(state, { id: 'knowledge:receipt', sequence: 5, text: 'Mara learned that the gift was bought before the accident.',
        quote: 'Mara reads the date on the receipt.' });
    const current = interview(state, 5, 'knowledge:receipt', '"Perhaps I judged you too quickly."',
        fixture.expectations.current_view, 'changed');
    return { state, original, current };
}

function disk(t, messages = fixture.messages) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-test-'));
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const directories = Object.fromEntries(['chats', 'groupChats', 'groups', 'worlds', 'characters'].map(name => [name, path.join(root, name)]));
    directories.root = root;
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(path.join(directories.chats, 'Mara'), { recursive: true });
    const filename = path.join(directories.chats, 'Mara', 'Gift.jsonl');
    const write = values => fs.writeFileSync(filename, [{ chat_metadata: { integrity: 'fixture' } }, ...values].map(value => JSON.stringify(value)).join('\n'));
    write(structuredClone(messages));
    writeJson(path.join(root, 'settings.json'), {});
    return { directories, filename, write };
}

const trackerExtra = results => ({ inChatAgentCompanionResults: results });
const trackerResult = (content, other = {}) => ({ agentName: 'Inventory', agentCategory: 'tracker', status: 'done', content, ...other });

test('Mewmory extracts and retrieves completed trackers from only the accepted alternative', () => {
    const message = { mewmory_id: 'tracker-host', name: 'Mara', mes: 'She closes the bag.', swipe_id: 0,
        extra: trackerExtra({ inventory: trackerResult('Wrong top-level result.') }),
        swipe_info: [{ extra: trackerExtra({
            inventory: trackerResult('Mara carries the brass key.', { includeInChatHistory: false, displayMode: 'panel' }),
            scene: trackerResult('Location: north gate.', { agentName: 'Scene' }),
            pending: trackerResult('Unfinished state.', { status: 'pending' }),
            failed: trackerResult('Failed state.', { status: 'error' }),
            empty: trackerResult('tracker-none'),
            commentary: trackerResult('Imagined audience reaction.', { agentCategory: 'companion' }),
        }) }, { extra: trackerExtra({ inventory: trackerResult('Rejected key.') }) }],
    };
    const state = newState(locator);
    syncSources(state, [message]);
    const input = extractionInput(state, state.timeline, 0, false);
    assert.equal(input.sources[0].storyText, message.mes);
    assert.deepEqual(input.sources[0].trackerOutputs.map(output => output.agentId), ['inventory', 'scene']);
    assert.match(input.sources[0].text, /brass key/);
    assert.doesNotMatch(input.sources[0].text, /Wrong|Unfinished|Failed|tracker-none|Imagined|Rejected/);
    applyExtraction(state, { records: [{ id: 'state:inventory', kind: 'state', entityId: 'npc:mara',
        text: 'Mara carries the brass key.', refs: state.timeline }], activeNpcIds: [] }, input);
    assert.equal(eligibleRecords(state).length, 1);
    const hits = lexicalSearch(searchDocuments(state), 'brass key', 10).map(hit => hit.document);
    assert.ok(hits.some(hit => hit.kind === 'source'));
    assert.match(assembleContext(state, hits, { counter }).memoryText, /brass key/);

    const initial = structuredClone(state.timeline);
    message.swipe_info[0].extra.inChatAgentCompanionResults.inventory.updatedAt = 'new timestamp';
    message.swipe_info[0].extra.inChatAgentCompanionResults.inventory.collapsed = true;
    syncSources(state, [message]);
    assert.deepEqual(state.timeline, initial, 'display and run bookkeeping do not invalidate evidence');
    message.swipe_id = 1;
    syncSources(state, [message]);
    assert.equal(eligibleRecords(state).length, 0);
    assert.doesNotMatch(JSON.stringify(searchDocuments(state)), /brass key|north gate/);
    assert.match(sourceAt(state, state.timeline[0]).text, /Rejected key/);
});

test('tracker revisions obey hiding, exclusion, branch boundaries and deletion', () => {
    const messages = [0, 1].map(index => ({ mewmory_id: 'tracker-' + index, name: 'Mara', mes: 'Saved reply ' + index,
        extra: trackerExtra({ inventory: trackerResult(index ? 'Future sapphire.' : 'Earlier brass key.') }) }));
    const state = newState(locator);
    syncSources(state, messages);
    const saved = event(state, { refs: [state.timeline[0]], asOf: 0, text: 'Earlier brass key.' });
    const child = buildBranchMemoryState(state, { ...locator, chat: 'Tracker branch' }, messages.slice(0, 1));
    assert.equal(eligibleRecords(child).length, 1, 'a copied prefix with tracker text retains its memories');
    assert.doesNotMatch(JSON.stringify(searchDocuments(child)), /Future sapphire/);
    assert.doesNotMatch(JSON.stringify(searchDocuments(state, 0)), /Future sapphire/);
    messages[0].is_system = true;
    messages[0].extra.mewmoryKeepHidden = true;
    syncSources(state, messages);
    assert.match(sourceAt(state, state.timeline[0]).text, /Earlier brass key/);
    assert.ok(searchDocuments(state).some(document => document.text.includes('Earlier brass key')));
    delete messages[0].extra.mewmoryKeepHidden;
    syncSources(state, messages);
    assert.equal(recordEligible(state, saved), false);
    assert.doesNotMatch(JSON.stringify(searchDocuments(state)), /Earlier brass key/);
    messages[0].is_system = false;
    messages[0].extra.mewmoryExclude = true;
    syncSources(state, messages);
    assert.doesNotMatch(JSON.stringify(searchDocuments(state)), /Earlier brass key/);
    syncSources(state, messages.slice(1));
    assert.doesNotMatch(JSON.stringify(state), /Earlier brass key/);
});

test('saved legacy tracker outputs are classified from the Agent library and retained after its removal', async t => {
    const message = { name: 'Mara', mes: 'Saved story.', extra: trackerExtra({ old: {
        agentName: 'Custom inventory', status: 'done', content: 'A quartz compass in her pocket.',
    }, audience: { agentName: 'Audience', status: 'done', content: 'Unrelated commentary.' } }) };
    const { directories, write } = disk(t, [message]);
    const library = path.join(directories.root, 'InChatAgents');
    writeJson(path.join(library, 'old.json'), { id: 'old', category: 'tracker', enabled: false });
    writeJson(path.join(library, 'audience.json'), { id: 'audience', category: 'companion' });
    const state = await loadCurrentState(directories, locator);
    assert.match(sourceAt(state, state.timeline[0]).text, /quartz compass/);
    assert.doesNotMatch(sourceAt(state, state.timeline[0]).text, /Unrelated/);
    fs.rmSync(path.join(library, 'old.json'));
    const again = await loadCurrentState(directories, locator);
    assert.deepEqual(again.timeline, state.timeline);
    write([{ ...message, swipe_id: 1, swipe_info: [{ extra: message.extra }, { extra: trackerExtra({}) }] }]);
    const empty = await loadCurrentState(directories, locator);
    assert.doesNotMatch(sourceAt(empty, empty.timeline[0]).text, /quartz compass/);
    write([message]);
    const restored = await loadCurrentState(directories, locator);
    assert.match(sourceAt(restored, restored.timeline[0]).text, /quartz compass/);
});

test('a tracker finishing after extraction schedules fresh memory processing without a new chat message', async t => {
    const message = { name: 'Mara', mes: 'She waits.', extra: trackerExtra({ inventory: trackerResult('Pending note.', { status: 'pending' }) }) };
    const { directories, write } = disk(t, [message]);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    config.roles.pawspective.enabled = false;
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const seen = [];
    const call = async (_directories, _config, _role, _contract, input) => {
        seen.push(input);
        const refs = input.sources.filter(source => source.type === 'chat');
        return { value: { records: refs[0].trackerOutputs ? [{ id: 'state:inventory', kind: 'state', entityId: 'npc:mara',
            text: refs[0].trackerOutputs[0].text, refs }] : [], activeNpcIds: [] }, usage: { role: 'extractor' } };
    };
    await scanProcessing(directories, call);
    let state = await waitForProcessing(directories, locator);
    assert.equal(pendingSources(state, config).length, 0);
    message.extra = trackerExtra({ inventory: trackerResult('A silver compass in her pocket.') });
    write([message]);
    await scanProcessing(directories, call);
    state = await waitForProcessing(directories, locator);
    assert.equal(seen.length, 2);
    assert.equal(state.timeline.length, 1);
    assert.match(eligibleRecords(state)[0].text, /silver compass/);
    assert.equal(pendingSources(state, config, { checkpoint: true }).length, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(chatPath(directories, locator), 'utf8').split('\n')[1]), message);
});

test('a tracker edit during extraction discards stale results and invalidates completed memory', async t => {
    const message = { name: 'Mara', mes: 'She waits.', extra: trackerExtra({ inventory: trackerResult('Old compass.') }) };
    const { directories, write } = disk(t, [message]);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const output = input => ({ value: { records: [{ id: 'state:inventory', kind: 'state', entityId: 'npc:mara',
        text: input.sources[0].trackerOutputs[0].text, refs: input.sources }], activeNpcIds: [] }, usage: { role: 'extractor' } });
    await assert.rejects(processBatch(directories, locator, {}, async (_dirs, _config, _role, _contract, input) => {
        message.extra = trackerExtra({ inventory: trackerResult('New compass.') });
        write([message]);
        return output(input);
    }), { status: 409 });
    let state = await loadCurrentState(directories, locator);
    assert.equal(eligibleRecords(state).length, 0);
    state = await processBatch(directories, locator, {}, async (_dirs, _config, _role, _contract, input) => output(input));
    assert.equal(eligibleRecords(state)[0].text, 'New compass.');
    message.extra = trackerExtra({});
    write([message]);
    state = await loadCurrentState(directories, locator);
    assert.equal(eligibleRecords(state).length, 0);
    assert.doesNotMatch(JSON.stringify(searchDocuments(state)), /compass/);
    assert.equal(pendingSources(state, readConfig(directories)).length, 1);
});

test('legacy 60-second timeouts upgrade while custom and subsequently saved values survive', t => {
    const { directories } = disk(t);
    const legacy = defaultConfig();
    delete legacy.defaultsVersion;
    for (const role of Object.values(legacy.roles)) role.timeoutMs = 60000;
    legacy.roles.embedding.timeoutMs = 90000;
    writeJson(path.join(directories.root, 'mewmory', 'config.json'), legacy);
    for (const read of [readConfig, publicConfig]) {
        const config = read(directories);
        assert.ok(ROLE_NAMES.filter(name => name !== 'embedding').every(name => config.roles[name].timeoutMs === 300000));
        assert.equal(config.roles.embedding.timeoutMs, 90000);
    }
    const saved = saveConfig(directories, publicConfig(directories));
    saved.roles.pawspective.timeoutMs = 60000;
    saveConfig(directories, saved);
    assert.equal(readConfig(directories).roles.pawspective.timeoutMs, 60000);
    assert.equal(publicConfig(directories).roles.extractor.timeoutMs, 300000);
});

test('automatic hiding and new-chat switching start off, fill in for older settings and save', t => {
    const { directories } = disk(t);
    const defaults = defaultConfig();
    assert.equal(defaults.autoHide, false);
    assert.equal(defaults.autoHideTokens, 30000);
    assert.equal(defaults.enableNewChats, false);
    const legacy = defaultConfig();
    delete legacy.autoHide;
    delete legacy.autoHideTokens;
    delete legacy.enableNewChats;
    writeJson(path.join(directories.root, 'mewmory', 'config.json'), legacy);
    for (const read of [readConfig, publicConfig]) {
        const config = read(directories);
        assert.equal(config.autoHide, false);
        assert.equal(config.autoHideTokens, 30000);
        assert.equal(config.enableNewChats, false);
    }
    const saved = saveConfig(directories, { ...publicConfig(directories), autoHide: true, autoHideTokens: 12000, enableNewChats: true });
    assert.equal(saved.autoHide, true);
    assert.equal(readConfig(directories).autoHideTokens, 12000);
    assert.equal(readConfig(directories).enableNewChats, true);
    const current = publicConfig(directories);
    assert.throws(() => saveConfig(directories, { ...current, autoHideTokens: 100 }), /Hide messages beyond, tokens/);
    assert.throws(() => saveConfig(directories, { ...current, enableNewChats: 'yes' }), /enableNewChats must be switched on or off/);
});

test('the old 16,000-token output default upgrades once to 32,000 while chosen limits survive', t => {
    const { directories } = disk(t);
    const legacy = defaultConfig();
    legacy.defaultsVersion = 1;
    for (const name of ROLE_NAMES) if (name !== 'embedding') legacy.roles[name].maxOutputTokens = 16000;
    legacy.roles.selector.maxOutputTokens = 4000;
    legacy.roles.fallback.contextTokens = 24000;
    writeJson(path.join(directories.root, 'mewmory', 'config.json'), legacy);
    for (const read of [readConfig, publicConfig]) {
        const config = read(directories);
        assert.equal(config.roles.extractor.maxOutputTokens, 32000);
        assert.equal(config.roles.pawspective.maxOutputTokens, 32000);
        assert.equal(config.roles.selector.maxOutputTokens, 4000);
        assert.equal(config.roles.fallback.maxOutputTokens, 16000, 'a context too small for 32,000 keeps its limit');
        assert.equal(config.roles.embedding.maxOutputTokens, 0);
    }
    const saved = saveConfig(directories, publicConfig(directories));
    saved.roles.extractor.maxOutputTokens = 16000;
    saveConfig(directories, saved);
    assert.equal(readConfig(directories).roles.extractor.maxOutputTokens, 16000, 'a deliberate 16,000 after the upgrade stays');
});

test('automatic importance without a cited chat message quietly becomes low', () => {
    const state = base();
    const input = { asOf: 2, sources: [{ ...state.timeline[2], type: 'chat' }] };
    applyExtraction(state, { records: [
        { id: 'event:uncited', kind: 'event', text: 'An uncited turning point.', subjectIds: ['gift'], refs: [state.timeline[2]], significance: 'high' },
        { id: 'event:cited', kind: 'event', text: 'A cited turning point.', subjectIds: ['gift'], refs: [state.timeline[2]], significance: 'medium', evidenceRefs: [state.timeline[2]] },
    ], interviews: [], activeNpcIds: [] }, input);
    const uncited = state.records.find(record => record.id === 'event:uncited');
    const cited = state.records.find(record => record.id === 'event:cited');
    assert.equal(uncited.significance, 'low');
    assert.deepEqual(uncited.evidenceRefs, []);
    assert.equal(cited.significance, 'medium');
    assert.throws(() => validateRecord(state, { id: 'event:author', kind: 'event', text: 'Author claim.', subjectIds: ['gift'],
        refs: [state.timeline[2]], significance: 'high' }), /Medium or high importance needs at least one chat message/);
});

test('accepted revisions stay stable; editing and replacing even an identical swipe invalidate dependants', () => {
    const state = base();
    const memory = event(state);
    const original = structuredClone(state.timeline);
    syncSources(state, fixture.messages, fixture.lore);
    assert.deepEqual(state.timeline, original);
    assert.equal(JSON.stringify(state.sources).includes('REJECTED:'), false);
    const edited = structuredClone(fixture.messages);
    edited[2].mes = 'Mara refuses the gift.';
    syncSources(state, edited, fixture.lore);
    assert.equal(state.timeline[2].id, original[2].id);
    assert.equal(state.timeline[2].revision, 2);
    assert.equal(recordEligible(state, memory), false);
    assert.equal(sourceAt(state, original[2]).text, fixture.messages[2].mes);
    const duplicate = event(state, { id: 'event:edited', refs: [state.timeline[2]] });
    edited[2].swipe_id = 1;
    syncSources(state, edited, fixture.lore);
    assert.equal(recordEligible(state, duplicate), false);
    syncSources(state, fixture.messages, fixture.lore);
    assert.equal(recordEligible(state, memory), false, 'a reverted source is a new accepted revision');
});

test('hiding a message only to fit the context size keeps its memories, while a plain hide switches it off', () => {
    const state = base();
    const memory = event(state);
    const original = structuredClone(state.timeline);
    const hidden = structuredClone(fixture.messages).map(message => ({ ...message, is_system: true, extra: { mewmoryKeepHidden: true } }));
    syncSources(state, hidden, fixture.lore);
    assert.deepEqual(state.timeline, original);
    assert.equal(recordEligible(state, memory), true);
    syncSources(state, hidden.map(message => ({ ...message, extra: {} })), fixture.lore);
    assert.equal(recordEligible(state, memory), false);
});

test('deleted chat purges source copies, dependent memories, search and undo history', () => {
    const state = base();
    const memory = event(state);
    putRecord(state, { ...memory, text: 'This correction mentions the gift.', authorOverride: true });
    state.index.vectors.private = { textHash: 'old', vector: [1] };
    syncSources(state, fixture.messages.filter((_, index) => index !== 2), fixture.lore);
    assert.deepEqual(state.sources[memory.refs[0].id].revisions, []);
    assert.equal(state.sources[memory.refs[0].id].active, false);
    assert.equal(state.records.some(record => record.id === memory.id), false);
    assert.equal(state.audit.some(entry => entry.recordId === memory.id), false);
    assert.deepEqual(state.index.vectors, {});
});

test('story scope, copied branch prefix, and explicit continuations isolate later parent history', () => {
    const { state, original, current } = giftHistory();
    const other = base();
    other.storyId = 'unrelated';
    assert.equal(recordEligible(other, original), false);
    const child = forkState(state, { ...locator, chat: 'Branch' }, 2, fixture.messages.slice(0, 3));
    assert.ok(child.records.some(record => record.id === original.id && recordEligible(child, record)));
    assert.equal(child.records.some(record => record.id === current.id), false);
    assert.equal(child.sources[state.timeline[5].id], undefined);
    const childSnapshot = JSON.stringify(child);
    state.records.find(record => record.id === current.id).text = 'Future parent-only information.';
    assert.equal(JSON.stringify(child), childSnapshot);
    const continuation = continueState(state, { ...locator, chat: 'Next chapter' }, [{ name: 'Player', is_user: true, send_date: 'next-day', mes: 'At the harbour.' }]);
    assert.equal(continuation.inheritedTimeline.length, fixture.messages.length);
    assert.equal(continuation.timeline.length, fixture.messages.length + 1);
    assert.ok(continuation.records.some(record => record.id === current.id && recordEligible(continuation, record)));
    syncSources(continuation, [{ name: 'Player', is_user: true, send_date: 'next-day', mes: 'Still at the harbour.' }], fixture.lore);
    assert.equal(continuation.timeline.length, fixture.messages.length + 1);
});

test('deleting an ambiguous timestamp occurrence purges old text and never reuses its revision', () => {
    for (const date of ['duplicate-date', undefined]) {
        const messages = [
            { name: 'Mara', mes: 'PRIVATE REMOVED REVISION', send_date: date },
            { name: 'Mara', mes: 'Same accepted words.', send_date: date },
        ];
        const state = newState(locator);
        syncSources(state, messages);
        const old = { ...state.timeline[0] };
        messages[0].mes = 'Same accepted words.';
        syncSources(state, messages);
        const beforeDelete = { ...state.timeline[0] };
        syncSources(state, messages.slice(1));
        assert.equal(JSON.stringify(state).includes('PRIVATE REMOVED REVISION'), false);
        assert.equal(sourceAt(state, old), undefined);
        assert.ok(state.timeline[0].revision > beforeDelete.revision);
        assert.equal(sourceAt(state, state.timeline[0]).text, 'Same accepted words.');
    }
});

test('native message identities preserve legacy references through differently dated swipes and deletion plus append', () => {
    const messages = structuredClone(fixture.messages);
    const state = base();
    const original = { ...state.timeline[2] };
    let sequence = 0;
    ensureMewmoryMessageIds(messages, () => 'message-' + sequence++);
    messages[2].swipe_info = [{ send_date: messages[2].send_date }, { send_date: 'different-date' }];
    messages[2].send_date = 'different-date';
    messages[2].swipe_id = 1;
    messages[2].mes = 'A different accepted reply.';
    syncSources(state, messages, fixture.lore);
    assert.equal(state.timeline[2].id, original.id);
    assert.equal(sourceAt(state, original).text, fixture.messages[2].mes);
    messages[2].send_date = fixture.messages[2].send_date;
    messages[2].swipe_id = 0;
    messages[2].mes = fixture.messages[2].mes;
    syncSources(state, messages, fixture.lore);
    assert.equal(state.timeline[2].id, original.id);
    assert.equal(state.timeline[2].revision, original.revision + 2);
    const stable = messages[2].mewmory_id;
    ensureMewmoryMessageIds(messages, () => 'message-' + sequence++);
    assert.equal(messages[2].mewmory_id, stable);

    const duplicates = [{ name: 'Mara', send_date: 'same', mes: 'DELETED PRIVATE TEXT' }, { name: 'Mara', send_date: 'same', mes: 'Surviving reply' }];
    const ambiguous = newState(locator);
    syncSources(ambiguous, duplicates);
    syncSources(ambiguous, [duplicates[1], { name: 'Mara', send_date: 'new', mes: 'Appended reply' }]);
    assert.equal(JSON.stringify(ambiguous).includes('DELETED PRIVATE TEXT'), false);
});

test('native branch saves capture memory immediately, including a continuation with a different first local reply', async t => {
    const { directories } = disk(t);
    const { trySaveChat } = await import('../src/endpoints/chats.js');
    const parent = mutateState(directories, locator, () => {
        const state = base();
        state.enabled = true;
        event(state, { text: 'Memory at branch creation' });
        return state;
    });
    const branch = normalizeLocator({ ...locator, chat: 'Native branch' });
    const save = (target, mainChat, messages) => trySaveChat([{ chat_metadata: { main_chat: mainChat } }, ...messages],
        chatPath(directories, target), false, 'mewmory-audit', target.chat, directories.root,
        { deferBackup: true, mewmory: { directories, locator: target } });
    await save(branch, locator.chat, fixture.messages.slice(0, 3));
    const copied = readState(directories, branch);
    assert.equal(copied.enabled, true);
    assert.ok(copied.records.some(record => record.text === 'Memory at branch creation'));
    mutateState(directories, locator, state => { state.records[0].text = 'A later parent correction'; });
    removeChatMemory(directories, locator);
    assert.equal((await loadCurrentState(directories, branch)).branchId, copied.branchId);
    assert.equal(JSON.stringify(readState(directories, branch)).includes('A later parent correction'), false);

    const continuation = normalizeLocator({ ...locator, chat: 'Continuation' });
    const local = [{ name: 'Mara', send_date: 'next', mes: 'First local reply' }];
    mutateState(directories, continuation, () => continueState(parent, continuation, local));
    const child = normalizeLocator({ ...locator, chat: 'Continuation branch' });
    await save(child, continuation.chat, [{ ...local[0], mes: 'Another first reply', swipe_id: 1 }]);
    const state = await loadCurrentState(directories, child);
    assert.equal(state.inheritedTimeline.length, parent.timeline.length);
    assert.ok(state.timeline.every(ref => sourceAt(state, ref)));
    assert.doesNotThrow(() => inspectState(state, defaultConfig()));
});

test('branch parents named by an old numeric group id resolve and unusable names are ignored', () => {
    assert.deepEqual(branchParentLocator(locator, { main_chat: 1687345678901 }), { ...locator, chat: '1687345678901' });
    assert.deepEqual(branchParentLocator(locator, { main_chat: 'Gift parent' }), { ...locator, chat: 'Gift parent' });
    for (const main_chat of [undefined, '', 0, locator.chat, 'Mara: Branch', 'Trailing dot.', 'x'.repeat(300), '..', ['list'], { nested: true }, true]) {
        assert.equal(branchParentLocator(locator, { main_chat }), null, JSON.stringify(main_chat));
    }
    assert.equal(branchParentLocator(locator, undefined), null);
});

test('character and book renames preserve distinct identities, deletion reaches renamed sources, and unbound books survive', async t => {
    const { directories } = disk(t);
    const { write: writeCard } = await import('../src/character-card-parser.js');
    const png = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));
    const card = (avatar, description) => fs.writeFileSync(path.join(directories.characters, avatar), writeCard(png, JSON.stringify({ name: avatar, description })));
    card('Mara.png', 'Original character');
    const group = normalizeLocator({ group: true, chat: 'Group' });
    fs.writeFileSync(chatPath(directories, group), JSON.stringify({ chat_metadata: {} }) + '\n' + JSON.stringify(fixture.messages[0]));
    const groupFile = path.join(directories.groups, 'group.json');
    writeJson(groupFile, { chat_id: group.chat, members: ['Mara.png'] });
    const original = await loadCurrentState(directories, group);
    renameCharacterMemory(directories, 'Mara.png', 'Renamed.png');
    fs.renameSync(path.join(directories.characters, 'Mara.png'), path.join(directories.characters, 'Renamed.png'));
    card('Mara.png', 'Different character');
    writeJson(groupFile, { chat_id: group.chat, members: ['Mara.png', 'Renamed.png'] });
    const both = await loadCurrentState(directories, group);
    assert.equal(new Set(both.contextSources.map(ref => ref.id)).size, 2);
    assert.equal((await loadCurrentState(directories, group)).revision, both.revision);
    assert.ok(both.contextSources.some(ref => ref.id === original.contextSources[0].id));
    renameCharacterMemory(directories, 'Renamed.png', 'Final.png');
    fs.renameSync(path.join(directories.characters, 'Renamed.png'), path.join(directories.characters, 'Final.png'));
    fs.unlinkSync(path.join(directories.characters, 'Final.png'));
    removeSourceMemory(directories, { avatar: 'Final.png' });
    assert.equal(JSON.stringify(readState(directories, group)).includes('Original character'), false);

    const book = { entries: { 1: { comment: 'Harbour', content: 'Lighthouse detail', key: ['harbour'] } } };
    writeJson(path.join(directories.worlds, 'Old.json'), book);
    writeJson(path.join(directories.root, 'settings.json'), { world_info: { globalSelect: ['Old'] } });
    const before = await loadCurrentState(directories, locator);
    renameWorldMemory(directories, 'Old', 'New');
    fs.renameSync(path.join(directories.worlds, 'Old.json'), path.join(directories.worlds, 'New.json'));
    writeJson(path.join(directories.root, 'settings.json'), { world_info: { globalSelect: ['New'] } });
    const after = await loadCurrentState(directories, locator);
    const lore = before.contextSources.find(ref => ref.id.startsWith('lore:'));
    assert.ok(after.contextSources.some(ref => ref.id === lore.id && ref.revision === lore.revision));
    writeJson(path.join(directories.root, 'settings.json'), {});
    assert.ok(JSON.stringify(await loadCurrentState(directories, locator)).includes('Lighthouse detail'));
    fs.unlinkSync(path.join(directories.worlds, 'New.json'));
    assert.equal(JSON.stringify(await loadCurrentState(directories, locator)).includes('Lighthouse detail'), false);
});

test('HTTP recovery handles missing and corrupt archives without restoring deleted evidence or accepting unrelated exports', async t => {
    const messages = structuredClone(fixture.messages);
    let next = 0;
    ensureMewmoryMessageIds(messages, () => 'saved-' + next++);
    const { directories, write } = disk(t, messages);
    await loadCurrentState(directories, locator);
    const guardFile = path.join(directories.root, 'mewmory', 'recovery', path.basename(statePath(directories, locator)));
    fs.writeFileSync(guardFile, '{broken');
    const initial = mutateState(directories, locator, state => {
        event(state, { id: 'event:removed', text: 'Must never return', refs: [state.timeline[2]] });
        event(state, { id: 'event:kept', text: 'Still supported', refs: [state.timeline[0]] });
    });
    assert.equal(JSON.parse(fs.readFileSync(guardFile, 'utf8')).storyId, initial.storyId, 'a healthy archive repairs a damaged recovery ledger');
    const backup = { format: 'mewmory-export-1', state: structuredClone(initial) };
    write(messages.filter((_, index) => index !== 2));
    await loadCurrentState(directories, locator);
    const express = (await import('express')).default;
    const { router } = await import('../src/endpoints/mewmory.js');
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => { request.user = { directories }; next(); });
    app.use(router);
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const restore = body => fetch('http://127.0.0.1:' + server.address().port + '/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locator, backup, ...body }),
    });
    for (const missing of [true, false]) {
        if (missing) fs.unlinkSync(statePath(directories, locator));
        else fs.writeFileSync(statePath(directories, locator), '{broken');
        assert.doesNotThrow(() => listStories(directories));
        assert.throws(() => renameChatMemory(directories, locator, { ...locator, chat: 'Moved' }), /archive is missing|could not read/);
        assert.equal(fs.existsSync(statePath(directories, { ...locator, chat: 'Moved' })), false);
        const previewResponse = await restore({ recover: true });
        const preview = await previewResponse.json();
        assert.equal(previewResponse.status, 200, JSON.stringify(preview));
        assert.deepEqual(preview.restored, ['event:kept']);
        assert.ok(preview.skipped.some(record => record.id === 'event:removed'));
        const response = await restore({ recover: true, apply: true, recoveryToken: preview.recoveryToken });
        const applied = await response.json();
        assert.equal(response.status, 200, JSON.stringify(applied));
        assert.equal(applied.revision, readState(directories, locator).revision);
        assert.equal(JSON.stringify(readState(directories, locator)).includes('Must never return'), false);
    }
    const unrelated = structuredClone(backup);
    unrelated.state.branchId = 'unrelated';
    assert.equal((await restore({ recover: true, backup: unrelated })).status, 409);
    removeChatMemory(directories, locator);
    assert.equal((await restore({ recover: true })).status, 409, 'deleting a chat also deletes its recovery identity');
    assert.equal(chatPath(directories, { ...locator, avatar: 'part.png.extra.png' }), path.join(directories.chats, 'part.extra.png', 'Gift.jsonl'));
});

test('inspection retains readable memory when its job ledger needs recovery', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    fs.mkdirSync(path.join(directories.root, 'jobs'));
    const ledger = path.join(directories.root, 'jobs', 'index.json');
    fs.writeFileSync(ledger, '{broken');
    const express = (await import('express')).default;
    const { router } = await import('../src/endpoints/mewmory.js');
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => { request.user = { directories }; next(); });
    app.use(router);
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/inspect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locator }),
    });
    assert.equal(response.status, 200);
    const inspection = await response.json();
    assert.ok(inspection.health.totalMessages > 0);
    assert.deepEqual(inspection.operations, []);
    assert.match(inspection.operationsError, /recovery/);
    assert.equal(fs.readFileSync(ledger, 'utf8'), '{broken');
});

for (const operation of ['rename', 'delete']) test('finishing work cannot recreate an archive after chat ' + operation, async t => {
    const { directories, filename } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const renamed = normalizeLocator({ ...locator, chat: 'Moved' });
    await assert.rejects(processBatch(directories, locator, {}, async () => {
        if (operation === 'rename') {
            renameChatMemory(directories, locator, renamed);
            fs.renameSync(filename, chatPath(directories, renamed));
        } else {
            fs.unlinkSync(filename);
            removeChatMemory(directories, locator);
        }
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor', input: 1, output: 1 } };
    }), /cannot find the saved file for this chat/);
    assert.equal(fs.existsSync(statePath(directories, locator)), false);
    if (operation === 'rename') assert.doesNotThrow(() => renameChatMemory(directories, renamed, locator));
});

test('claims stay reported; a temporary disguise never replaces stable appearance; extractor cannot write an interview', () => {
    const state = base();
    const refs = [state.timeline[2]];
    applyExtraction(state, { records: [
        { id: 'event:claim', kind: 'event', text: 'Mara said she did not need pity.', refs, evidenceStatus: 'reported', subjectIds: ['gift'] },
        { id: 'state:disguise', kind: 'state', entityId: 'npc:mara', text: 'Wearing a red cloak as a disguise.', refs, subjectIds: ['npc:mara'] },
    ], interviews: [], activeNpcIds: ['npc:mara'] }, { asOf: 2, sources: refs.map(ref => ({ ...ref, type: 'chat' })) });
    assert.equal(state.records.find(record => record.id === 'event:claim').evidenceStatus, 'reported');
    assert.equal(state.records.find(record => record.id === 'entity:mara').appearance, fixture.expectations.appearance);
    const skipped = [];
    applyExtraction(state, { records: [{ id: 'bad', kind: 'interview' }], interviews: [], activeNpcIds: [] }, { asOf: 2, sources: [] }, skipped);
    assert.equal(state.records.some(record => record.id === 'bad'), false);
    assert.match(skipped[0], /unknown type, or the same memory twice/);
});

test('cheap-model slips are repaired, and one wrong memory is left out without sinking the rest', () => {
    const state = base();
    const sources = [2, 4, 5].map(sequence => ({ ...state.timeline[sequence], type: 'chat' }));
    const [gift, receipt] = [state.timeline[2], state.timeline[5]];
    const skipped = [];
    applyExtraction(state, { reasoning: 'Ignored extra section.', records: [
        { id: 'knowledge:loose quote', kind: 'knowledge', ownerId: 'npc:mara', subjectIds: ['gift'], text: 'Mara took the gift.',
            method: 'witnessed', evidenceText: '*mara accepts the gift*', refs: [{ id: gift.id, revision: '7' }] },
        { id: 'knowledge:elsewhere', kind: 'knowledge', ownerId: 'npc:mara', subjectIds: ['receipt'], text: 'Mara saw the receipt date.',
            method: 'read', evidenceText: '“Then perhaps I judged you … quickly”', refs: [gift.id] },
        { id: 'knowledge:invented', kind: 'knowledge', ownerId: 'npc:mara', subjectIds: ['gift'], text: 'Mara loves the player.',
            method: 'witnessed', evidenceText: 'Mara confesses her love.', refs: [gift] },
        { id: 'event:receipt', kind: 'event', text: 'The player showed the receipt.', subjectIds: ['receipt'], refs: [receipt.id + '@99'] },
    ], activeNpcIds: ['npc:mara', 'npc:nobody'] }, { asOf: 5, sources }, skipped);
    const saved = id => state.records.find(record => record.id === id);
    assert.equal(saved('knowledge:loose-quote').evidenceText, 'Mara accepts the gift');
    assert.deepEqual(saved('knowledge:loose-quote').refs, [gift]);
    assert.equal(saved('knowledge:elsewhere').evidenceText, 'Then perhaps I judged you too quickly');
    assert.ok(saved('knowledge:elsewhere').refs.some(ref => ref.id === receipt.id));
    assert.deepEqual(saved('event:receipt').refs, [receipt]);
    assert.equal(saved('knowledge:invented'), undefined);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /copied word for word/);
    assert.deepEqual(state.sceneNpcIds, ['npc:mara']);
});

test('character interviews receive acquired knowledge, not source-wide or future secrets; player owners are rejected', () => {
    const { state } = giftHistory();
    const input = interviewInput(state, { ownerId: 'npc:mara', subjectIds: ['gift'], knowledgeIds: ['knowledge:gift'] }, 2);
    const serialized = JSON.stringify(input);
    assert.equal(serialized.includes('SECRET:'), false);
    assert.equal(serialized.includes('purchase date'), false);
    assert.equal(serialized.includes('knowledge:receipt'), false);
    assert.throws(() => interviewInput(state, { ownerId: 'player', subjectIds: ['gift'], knowledgeIds: ['knowledge:gift'] }, 2), /not a known AI character/);
    assert.throws(() => interviewInput(state, { ownerId: 'npc:mara', subjectIds: ['gift'], knowledgeIds: ['knowledge:receipt'] }, 2), /actually learned/);
});

test('synthetic gestures remain subjective, and old matches bring the present overview and change', () => {
    const { state, original, current } = giftHistory();
    assert.equal(state.records.filter(record => record.kind === 'event').some(record => record.text.includes('armchair')), false);
    assert.throws(() => validateRecord(state, {
        id: 'event:synthetic', kind: 'event', text: 'Mara gripped an armchair in the scene.', refs: original.refs,
        dependencies: [{ id: original.id, version: original.version }], subjectIds: ['gift'],
    }, { asOf: 2, origin: 'objective_extractor' }), /own opinion from a Pawspective interview/);
    const document = searchDocuments(state).find(document => document.id === original.id);
    const before = hash(state);
    const result = assembleContext(state, [document], { counter, memoryTokens: 6000 });
    assert.ok(result.memoryText.includes(fixture.expectations.original_view) === false);
    assert.ok(result.memoryText.includes(fixture.expectations.current_view));
    assert.ok(result.memoryText.includes(current.interview[0].answer));
    assert.ok(result.memoryText.includes('Historical Pawspective'));
    assert.ok(result.memoryText.includes('Owner: Mara'));
    assert.ok(result.memoryText.includes('Subjects: gift'));
    assert.equal(result.memoryText.includes('SEARCH ONLY'), false);
    assert.equal(hash(state), before, 'retrieval never increases significance or rewrites a dossier');
    assert.ok(result.npcText.includes(fixture.expectations.appearance));
});

test('enabled but untriggered lore and rare source details are searchable; disabled lore cannot support recall', () => {
    const state = base();
    const documents = searchDocuments(state);
    assert.ok(lexicalSearch(documents, 'true name').some(item => item.document.text.includes('expression of trust')));
    assert.ok(lexicalSearch(documents, 'ink-stained').some(item => item.document.text.includes('silver eyes')));
    assert.equal(documents.some(document => document.text.includes('DISABLED:')), false);
    assert.throws(() => validateRecord(state, {
        id: 'event:disabled', kind: 'event', text: 'Not eligible.', subjectIds: ['magic'],
        refs: [state.contextSources.find(ref => ref.id === 'lore:disabled')],
    }), /can no longer be used/);
    const changed = fixture.lore.map(item => ({ ...item, enabled: false }));
    const chatMemory = event(state);
    syncSources(state, fixture.messages, changed);
    assert.ok(recordEligible(state, chatMemory), 'an independently witnessed event survives disabling a lore rule');
});

test('selector contracts allow empty results and reject replacements, unknown IDs and unsupported associations', () => {
    const candidates = [{ recordId: 'one', sourceRefs: ['chat:one@1'], linkedRecordIds: [] }];
    const scene = [{ id: 'chat:now@1', text: 'You kept it?' }];
    const empty = { status: 'complete', selections: [], rejections: [], needsEvidence: [] };
    assert.deepEqual(validateSelection(empty, candidates, scene), empty);
    assert.throws(() => validateSelection({ ...empty, memoryText: 'Invented replacement.' }, candidates, scene), /Unexpected fields/);
    const selected = { recordId: 'other', relevanceType: 'direct', currentCueRefs: ['chat:now@1'], memoryEvidenceRefs: ['chat:one@1'], justification: 'Same gift.' };
    assert.throws(() => validateSelection({ ...empty, selections: [selected] }, candidates, scene), /invalid or duplicate ID/);
    selected.recordId = 'one';
    selected.currentCueRefs = ['not-in-scene'];
    assert.throws(() => validateSelection({ ...empty, selections: [selected] }, candidates, scene), /unsupported evidence/);
});

test('local-only destination checks cannot be bypassed by fallback, credentials, host suffixes or redirects', () => {
    for (const endpoint of ['http://127.0.0.1:9000/v1', 'http://[::1]:9000/v1', 'http://192.168.1.5:9000/v1']) {
        assert.ok(isLocalEndpoint(endpoint));
        assert.ok(validateEndpoint(endpoint, { localOnly: true, allowRemote: false }));
    }
    for (const endpoint of ['https://remote.example/v1', 'https://localhost.example/v1', 'http://127.0.0.1@remote.example/v1']) {
        assert.throws(() => validateEndpoint(endpoint, { localOnly: true, allowRemote: true }));
    }
    assert.throws(() => validateEndpoint('https://remote.example/v1', { localOnly: false, allowRemote: false }), /not allowed/);
    assert.throws(() => validateEndpoint('http://127.0.0.1/v1?key=secret', { localOnly: true, allowRemote: false }), /credentials/);
});

test('author corrections survive automatic retries under the same or a different model-supplied ID; undo checks source eligibility', () => {
    const state = base();
    const original = event(state);
    putRecord(state, { ...original, text: 'Author: the gift was accepted without a confession.', authorOverride: true, origin: 'author' });
    const corrected = state.records.find(record => record.id === original.id);
    putRecord(state, { ...original, text: 'Bad automatic rewrite.' }, { automatic: true });
    putRecord(state, { ...original, id: 'event:duplicate' }, { automatic: true });
    assert.equal(state.records.find(record => record.id === original.id).text, corrected.text);
    assert.equal(state.records.some(record => record.id === 'event:duplicate'), false);
    undoRecord(state, original.id);
    assert.equal(state.records.find(record => record.id === original.id).text, original.text);
    putRecord(state, { ...state.records.find(record => record.id === original.id), text: 'Another correction.', authorOverride: true });
    const changed = structuredClone(fixture.messages);
    changed[2].mes = 'A rejected scene.';
    syncSources(state, changed, fixture.lore);
    assert.throws(() => undoRecord(state, original.id), /edited, rejected/);
});

test('later knowledge revisions preserve earlier interviews and branch-time knowledge, while corrections invalidate mistakes', () => {
    const state = base();
    knowledge(state);
    const original = interview(state, 2, 'knowledge:gift', 'She remains evasive.', 'She suspects pity.', 'old-view');
    knowledge(state, { sequence: 5, text: 'The receipt corrects her assumption about the purchase date.', quote: 'Mara reads the date on the receipt.' });
    assert.equal(recordEligible(state, original), true, 'an in-story development does not invalidate historical experience');
    const past = interviewInput(state, { ownerId: 'npc:mara', subjectIds: ['gift'], knowledgeIds: ['knowledge:gift'] }, 2);
    assert.equal(past.knownFacts[0].text.includes('purchase date'), false);
    const branch = forkState(state, { ...locator, chat: 'Before the receipt' }, 2, fixture.messages.slice(0, 3));
    assert.ok(branch.records.some(record => record.id === original.id && recordEligible(branch, record)));
    const laterBranch = continueState(state, { ...locator, chat: 'Continuation' }, [{ name: 'Player', mes: 'Hello', send_date: 'new-chapter' }]);
    assert.ok(laterBranch.records.some(record => record.id === original.id && recordEligible(laterBranch, record)));
    const known = state.records.find(record => record.id === 'knowledge:gift');
    putRecord(state, { ...known, text: 'Author correction: she did not read this.', status: 'invalidated', authorOverride: true });
    assert.equal(recordEligible(state, original), false, 'an author correction must not revive a superseded faulty version');
});

test('multiple corrections can be undone, and significance loses eligibility with its distinct evidence', () => {
    const state = base();
    const original = event(state);
    putRecord(state, { ...original, text: 'First correction.', authorOverride: true });
    putRecord(state, { ...state.records.find(record => record.id === original.id), text: 'Second correction.', authorOverride: true });
    undoRecord(state, original.id);
    assert.equal(state.records.find(record => record.id === original.id).text, 'First correction.');
    undoRecord(state, original.id);
    assert.equal(state.records.find(record => record.id === original.id).text, original.text);
    const significant = event(state, { id: 'event:significant', asOf: 5, significance: 'high', evidenceRefs: [state.timeline[5]] });
    const changed = structuredClone(fixture.messages);
    changed[5].mes = 'The callback is removed.';
    syncSources(state, changed, fixture.lore);
    assert.equal(recordEligible(state, significant), false);
});

test('objective extraction excludes corrected interview prose and text from ineligible author corrections', () => {
    const { state, original } = giftHistory();
    putRecord(state, { ...original, pinned: true, authorOverride: true, origin: 'author' });
    const correction = event(state, { id: 'event:private-correction', text: 'EXCLUDED AUTHOR TEXT' });
    putRecord(state, { ...correction, authorOverride: true, origin: 'author' });
    state.excludedSources.push(correction.refs[0].id);
    const input = extractionInput(state, [state.timeline[5]], 5, true);
    const serialized = JSON.stringify(input);
    assert.equal(serialized.includes(fixture.expectations.interview_only_gesture), false);
    assert.equal(serialized.includes('EXCLUDED AUTHOR TEXT'), false);
    assert.ok(input.authorOverrides.some(record => record.id === original.id));
    assert.ok(input.authorOverrides.some(record => record.id === correction.id));
    assert.equal(input.authorOverrides.find(record => record.id === original.id).interview, undefined);
});

test('corrections retain the rejected claim identity without suppressing different facts from the same source', () => {
    for (const legacy of [false, true]) {
        const state = base();
        const original = event(state);
        putRecord(state, { ...original, text: 'Corrected account.', ownerId: 'npc:mara', subjectIds: ['gift-box'], refs: [state.timeline[0]], authorOverride: true, origin: 'author' });
        if (legacy) state.overrides = [{ id: original.id, signature: 'old-coarse-signature' }];
        putRecord(state, { ...original, id: 'event:recreated-error' }, { automatic: true });
        const separate = { ...original, id: 'event:separate-fact', text: 'Mara put the gift in her bag.' };
        putRecord(state, separate, { automatic: true });
        assert.equal(state.records.some(record => record.id === 'event:recreated-error'), false);
        assert.ok(state.records.some(record => record.id === separate.id));
        assert.equal(state.records.find(record => record.id === original.id).text, 'Corrected account.');
    }
});

test('undoing an unchanged author save leaves another record’s correction and undo history intact', () => {
    const state = base();
    const first = event(state);
    const second = event(state, { id: 'event:second', text: 'A separate fact.' });
    putRecord(state, { ...first, origin: 'author', authorOverride: true });
    putRecord(state, { ...second, text: 'A separate correction.', authorOverride: true, origin: 'author' });
    const otherAudit = structuredClone(state.audit.filter(entry => entry.recordId === second.id));
    undoRecord(state, first.id);
    assert.deepEqual(state.audit.filter(entry => entry.recordId === second.id), otherAudit);
    assert.equal(state.audit.at(-1).recordId, first.id);
    assert.equal(state.audit.at(-1).action, 'undo');
    undoRecord(state, second.id);
    assert.equal(state.records.find(record => record.id === second.id).text, second.text);
});

test('same-time interviews with different knowledge stay eligible and preservation never accepts an invalid replacement', async t => {
    const { directories } = disk(t, fixture.messages.slice(0, 3));
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        putRecord(state, validateRecord(state, { id: 'entity:mara', kind: 'entity', entityId: 'npc:mara', name: 'Mara', text: 'Mara',
            isCharacter: true, subjectIds: ['npc:mara'], refs: [state.timeline[0]] }, { asOf: 0, origin: 'objective_extractor' }), { automatic: true });
    });
    let interviews = 0;
    const output = answer => ({ changed: true, interview: [{ question: 'What do you think?', answer }], searchDescription: answer,
        changeExplanation: '', overviews: [{ subjectId: 'gift', text: answer, status: 'active' }] });
    const state = await processBatch(directories, locator, { checkpoint: true }, async (_directories, _config, role, _contract, input) => {
        if (role === 'pawspective') return { value: output('View ' + ++interviews), usage: { role } };
        const source = input.sources.filter(source => source.type === 'chat').at(-1);
        const refs = [{ id: source.id, revision: source.revision }];
        return { value: {
            records: ['first', 'second'].map(name => ({ id: 'knowledge:' + name, kind: 'knowledge', ownerId: 'npc:mara', subjectIds: ['gift'],
                text: 'Known detail ' + name, method: 'witnessed', evidenceText: 'Mara accepts the gift.', refs })),
            interviews: ['first', 'second'].map(name => ({ ownerId: 'npc:mara', subjectIds: ['gift'], knowledgeIds: ['knowledge:' + name], refs })), activeNpcIds: ['npc:mara'],
        }, usage: { role } };
    });
    const saved = state.records.filter(record => record.kind === 'interview');
    assert.equal(saved.length, 2);
    assert.ok(saved.every(record => recordEligible(state, record)));
    assert.equal(Object.keys(state.checkpoints).length, 3);
    const request = { ownerId: 'npc:mara', subjectIds: ['gift'], knowledgeIds: ['knowledge:second'], refs: [state.timeline[2]] };
    const input = interviewInput(state, request, 2);
    assert.throws(() => applyInterview(state, request, output('Invalid self-dependent replacement'), input, state.jobs.at(-1).id), /relies on changed/);
    assert.ok(readState(directories, locator).records.filter(record => record.kind === 'interview').every(record => recordEligible(readState(directories, locator), record)));
});

test('an old overview is labelled historical while the latest interpretation is the only current view', () => {
    const { state } = giftHistory();
    const old = searchDocuments(state).find(document => document.kind === 'overview' && document.asOf === 2);
    const result = assembleContext(state, [old], { counter });
    assert.equal(result.memoryText.match(/\[Current subjective view;/g)?.length, 1);
    assert.ok(result.memoryText.includes('[Historical subjective view;'));
    assert.ok(result.memoryText.includes(fixture.expectations.original_view));
    assert.ok(result.memoryText.includes(fixture.expectations.current_view));
    assert.ok(result.memoryText.indexOf(fixture.expectations.current_view) < result.memoryText.indexOf(fixture.expectations.original_view));
    const past = assembleContext(state, [old], { counter, asOf: 2 });
    assert.equal(past.memoryText.includes(fixture.expectations.current_view), false);
    assert.ok(past.memoryText.includes('[Current subjective view;'));
});

test('historical recall preserves the selected version and never substitutes later evidence or text', async t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        event(state, { id: 'event:history', text: 'EARLIER gift account.' });
        const anchor = event(state, { id: 'event:later-anchor', text: 'Later receipt evidence.', refs: [state.timeline[5]], asOf: 5 });
        event(state, { id: 'event:history', text: 'LATER gift account.', refs: [state.timeline[5]], asOf: 5,
            dependencies: [{ id: anchor.id, version: anchor.version }] });
    });
    const result = await recall(directories, locator, { asOf: 2 }, { call: async (_directories, _config, role, _contract, input) => {
        const candidate = input.candidates.find(candidate => candidate.recordId === 'event:history');
        assert.ok(candidate.excerpt.includes('EARLIER'));
        assert.deepEqual(candidate.linkedRecordIds, []);
        return { value: { status: 'complete', selections: [{ recordId: candidate.recordId, relevanceType: 'direct', currentCueRefs: [input.scene.at(-1).id],
            memoryEvidenceRefs: [candidate.sourceRefs[0]], justification: 'Earlier accepted gift account.' }], rejections: [], needsEvidence: [] }, usage: { role } };
    } });
    assert.ok(result.memoryText.includes('EARLIER gift account.'));
    assert.equal(result.memoryText.includes('LATER gift account.'), false);
    assert.equal(result.memoryText.includes('event:later-anchor'), false);
});

test('automatic cast selection is bounded by story position and older backfill cannot overwrite a later cast', () => {
    const state = base();
    applyExtraction(state, { records: [], interviews: [], activeNpcIds: [] }, extractionInput(state, [state.timeline[5]], 5, false));
    applyExtraction(state, { records: [], interviews: [], activeNpcIds: ['npc:mara'] }, extractionInput(state, [state.timeline[2]], 2, true));
    assert.deepEqual(state.sceneNpcIds, []);
    assert.deepEqual(activeReferences(state, 2).ids, ['npc:mara']);
    assert.ok(activeReferences(state, 1).text.includes('Mara'), 'an unknown earlier cast keeps eligible references conservatively');
    assert.equal(activeReferences(state, 5).text, '');
    const branch = forkState(state, { ...locator, chat: 'Earlier cast' }, 2, fixture.messages.slice(0, 3));
    assert.ok(activeReferences(branch).text.includes('Mara'));
});

test('evidence expansion adds an original passage even when more than twelve records share it', async t => {
    const { directories } = disk(t, [{ name: 'Mara', mes: 'The sigil', send_date: 'one' }]);
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    config.candidateLimit = 4;
    Object.assign(config.roles.selector, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        for (let index = 0; index < 16; index++) event(state, { id: 'event:evidence-' + index, text: 'Mara the sigil detail ' + index,
            searchDescription: 'Mara the sigil', refs: [state.timeline[0]], asOf: 0 });
    });
    let round = 0;
    await recall(directories, locator, {}, { call: async (_directories, _config, role, _contract, input) => {
        round++;
        if (round === 1) {
            assert.equal(input.candidates.some(candidate => candidate.kind === 'source'), false);
            return { value: { status: 'needs_evidence', selections: [], rejections: [], needsEvidence: [input.candidates[0].recordId] }, usage: { role } };
        }
        assert.ok(input.candidates.some(candidate => candidate.kind === 'source' && candidate.excerpt === 'The sigil'));
        return { value: { status: 'complete', selections: [], rejections: [], needsEvidence: [] }, usage: { role } };
    } });
    assert.equal(round, 2);
});

test('punctuation-only commitment cues do not force recall while non-Latin words still match', () => {
    const state = base();
    for (const [name, cue] of [['punctuation', '...'], ['rain', '雨']]) {
        putRecord(state, validateRecord(state, { id: 'commitment:' + name, kind: 'commitment', text: name, refs: [state.timeline[2]],
            subjectIds: ['gift'], triggerTerms: [cue] }, { asOf: 2, origin: 'objective_extractor' }), { automatic: true });
    }
    const documents = searchDocuments(state);
    assert.deepEqual(forcedMatches(state, documents, 'An unrelated scene.', Infinity), []);
    assert.deepEqual(forcedMatches(state, documents, '雨', Infinity).map(document => document.id), ['commitment:rain']);
});

test('archive filters apply before pagination and retain a separate unfiltered record count', () => {
    const state = base();
    for (let index = 0; index < 81; index++) event(state, { id: 'event:page-' + index, status: index === 0 ? 'background' : 'active' });
    const view = inspectState(state, defaultConfig(), { kind: 'event', status: 'background' });
    assert.equal(view.total, 1);
    assert.equal(view.records[0].id, 'event:page-0');
    assert.equal(view.recordCount, state.records.length);
    assert.equal(inspectState(state, defaultConfig(), { kind: 'interview' }).recordCount, state.records.length);
});

test('deletion removes source text from older audit copies and prepared previews', () => {
    const state = base();
    const old = event(state, { text: 'UNIQUE DELETED MEMORY' });
    putRecord(state, { ...old, text: 'Independent replacement.', refs: [state.timeline[4]], authorOverride: true, asOf: 4 });
    state.preview = { memoryText: 'UNIQUE DELETED MEMORY' };
    syncSources(state, fixture.messages.filter((_, index) => index !== 2), fixture.lore);
    assert.equal(JSON.stringify(state).includes('UNIQUE DELETED MEMORY'), false);
});

test('a batch finishes with its good memories and counts the one the model got wrong', async t => {
    const { directories } = disk(t, fixture.messages.slice(0, 3));
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const state = await processBatch(directories, locator, {}, async (_directories, _config, role, _contract, input) => {
        const last = input.sources.filter(source => source.type === 'chat').at(-1);
        return { value: { records: [
            { id: 'event:accepted', kind: 'event', text: 'The gift was accepted.', subjectIds: ['gift'], refs: [last.id] },
            { id: 'knowledge:made-up', kind: 'knowledge', ownerId: 'npc:mara', subjectIds: ['gift'], text: 'Invented.',
                method: 'witnessed', evidenceText: 'Nothing like this was said.', refs: [last.id] },
        ], interviews: [], activeNpcIds: [] }, usage: { role, input: 1, output: 1, milliseconds: 1 } };
    });
    assert.ok(eligibleRecords(state).some(record => record.id === 'event:accepted'));
    assert.equal(state.jobs.at(-1).status, 'complete');
    assert.equal(state.jobs.at(-1).skipped, 1);
    assert.equal(pendingSources(state, defaultConfig()).length, 0);
});

test('processing is idempotent and never changes saved chat; a source edit during an LLM request discards the whole job', async t => {
    const { directories, filename, write } = disk(t, fixture.messages.slice(0, 3));
    let state = await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const originalBytes = fs.readFileSync(filename, 'utf8');
    let calls = 0;
    const run = async (_directories, _config, role, _contract, input) => {
        calls++;
        return {
            value: { records: [{
                id: 'event:accepted', kind: 'event', text: 'The gift was accepted.', subjectIds: ['gift'],
                refs: [{ id: input.sources.filter(source => source.type === 'chat').at(-1).id,
                    revision: input.sources.filter(source => source.type === 'chat').at(-1).revision }], evidenceStatus: 'established',
            }], interviews: [], activeNpcIds: [] },
            usage: { role, input: 50, output: 25, milliseconds: 1 },
        };
    };
    state = await processBatch(directories, locator, {}, run);
    assert.equal(state.records.filter(record => record.id === 'event:accepted').length, 1);
    assert.equal(pendingSources(state, defaultConfig()).length, 0);
    await processBatch(directories, locator, {}, run);
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(filename, 'utf8'), originalBytes);
    const changed = structuredClone(fixture.messages.slice(0, 3));
    changed[2].mes = 'The accepted alternative is now different.';
    write(changed);
    await assert.rejects(processBatch(directories, locator, {}, async (...args) => {
        changed[2].mes = 'Edited during extraction.';
        write(changed);
        return run(...args);
    }), /discarded/);
    state = readState(directories, locator);
    assert.equal(eligibleRecords(state).some(record => record.id === 'event:accepted'), false);
    assert.ok(pendingSources(state, defaultConfig()).length > 0);
    assert.equal(state.jobs.at(-1).status, 'failed');
});

test('a failed checkpoint leaves coverage and existing valid memory intact', async t => {
    const { directories } = disk(t, fixture.messages.slice(0, 3));
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    await assert.rejects(processBatch(directories, locator, { checkpoint: true }, async () => {
        throw new Error('Fixture endpoint unavailable.');
    }), /unavailable/);
    const state = readState(directories, locator);
    assert.deepEqual(state.checkpoints, {});
    assert.equal(inspectState(state, defaultConfig()).health.preservedThrough, -1);
    assert.ok(eligibleRecords(state).some(record => record.id === 'event:gift'));
});

test('a background batch saves alongside recall, indexing and appended chat without losing either result', async t => {
    const messages = fixture.messages.slice(0, 3);
    const { directories, write } = disk(t, messages);
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    Object.assign(config.roles.selector, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    let release, started;
    const held = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    const processing = processBatch(directories, locator, { checkpoint: true }, async (_directories, _config, role, _contract, input) => {
        started();
        await held;
        const source = input.sources.filter(source => source.type === 'chat').at(-1);
        return { value: { records: [{
            id: 'event:background', kind: 'event', text: 'The gift is in Mara’s bag.', subjectIds: ['gift'],
            refs: [{ id: source.id, revision: source.revision }], evidenceStatus: 'established',
        }], interviews: [], activeNpcIds: [] }, usage: { role, input: 50, output: 25 } };
    });
    await ready;
    let result;
    try {
        result = await recall(directories, locator, {}, { call: async (_directories, _config, role) => ({
            value: { status: 'complete', selections: [], rejections: [], needsEvidence: [] }, usage: { role, input: 10 },
        }) });
        write([...messages, { name: 'Mara', mes: 'A new reply while memory is busy.', send_date: 'new-reply', is_user: false }]);
        await loadCurrentState(directories, locator);
        mutateState(directories, locator, state => { state.index.vectors.concurrent = { textHash: 'kept', vector: [1] }; });
        assert.equal(readState(directories, locator).jobs.at(-1).status, 'processing');
    } finally {
        release();
    }
    const state = await processing;
    assert.equal(state.timeline.length, 4);
    assert.ok(eligibleRecords(state).some(record => record.id === 'event:background'));
    assert.equal(state.recalls.at(-1).id, result.inspection.id);
    assert.equal(state.preview.fingerprint, result.fingerprint);
    assert.deepEqual(state.index.vectors.concurrent.vector, [1]);
    assert.equal(state.usage.selector.requests, 1);
    assert.equal(state.usage.extractor.requests, 1);
    assert.equal(Object.keys(state.checkpoints).length, 3);
    assert.equal(pendingSources(state, config).length, 1);
    assert.equal(state.jobs.at(-1).status, 'complete');
});

for (const change of ['author correction', 'model settings']) {
    test('background processing still rejects a concurrent ' + change, async t => {
        const { directories } = disk(t, fixture.messages.slice(0, 3));
        await loadCurrentState(directories, locator);
        mutateState(directories, locator, state => { state.enabled = true; event(state); });
        await assert.rejects(processBatch(directories, locator, {}, async (_directories, _config, role) => {
            if (change === 'author correction') {
                mutateState(directories, locator, state => {
                    const record = state.records.find(record => record.id === 'event:gift');
                    putRecord(state, { ...record, text: 'Author correction survives.', authorOverride: true, origin: 'author' });
                });
            } else {
                const config = publicConfig(directories);
                config.roles.extractor.modelRevision = 'updated-model';
                saveConfig(directories, config);
            }
            return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role } };
        }), /discarded/);
        const state = readState(directories, locator);
        assert.equal(state.jobs.at(-1).status, 'failed');
        assert.equal(Object.keys(state.coverage).length, 0);
        if (change === 'author correction') assert.equal(state.records[0].text, 'Author correction survives.');
    });
}

test('independent users, safe locators, rename and chat deletion keep storage ownership', async t => {
    const first = disk(t);
    const second = disk(t);
    await loadCurrentState(first.directories, locator);
    mutateState(first.directories, locator, state => { state.enabled = true; event(state); });
    assert.equal(readState(second.directories, locator).records.length, 0);
    assert.throws(() => normalizeLocator({ ...locator, chat: '../private' }), /Invalid chat path/);
    assert.throws(() => normalizeLocator({ ...locator, avatar: '../Mara.png' }), /Invalid chat path/);
    const renamed = { ...locator, chat: 'Renamed gift' };
    const previous = readState(first.directories, locator);
    assert.ok(renameChatMemory(first.directories, locator, renamed));
    assert.equal(fs.existsSync(statePath(first.directories, locator)), false);
    assert.equal(readState(first.directories, renamed).branchId, previous.branchId);
    assert.equal(readState(first.directories, renamed).records.length, 1);
    removeChatMemory(first.directories, renamed);
    assert.equal(fs.existsSync(statePath(first.directories, renamed)), false);
});

test('real token counting handles Unicode; source and protected NPC blocks remain outside memory selection budgets', async () => {
    const realCounter = await getCounter('cl100k_base');
    assert.ok(realCounter.count('银色眼睛。これは贈り物です。') > 0);
    await assert.rejects(getCounter('auto', { tokenizerKey: 'none' }), /estimate/);
    const { state, original } = giftHistory();
    const result = assembleContext(state, [searchDocuments(state).find(document => document.id === original.id)], { counter, memoryTokens: 1 });
    assert.equal(result.memoryText, '');
    assert.ok(result.npcText.includes(fixture.expectations.appearance));
    assert.throws(() => assembleContext(state, [searchDocuments(state).find(document => document.id === original.id)], {
        counter, memoryTokens: 1, forcedIds: [original.id],
    }), /Pinned memories/);
    assert.equal(activeReferences(state).records.length, 1);
});

test('embedding changes build a new space without querying mixed vectors; lexical search remains independent', async () => {
    const state = base();
    const config = defaultConfig();
    config.roles.embedding.enabled = true;
    config.roles.embedding.model = 'first';
    const embedFn = async (_directories, _config, texts) => ({
        vectors: texts.map(text => [Number(text.toLowerCase().includes('gift')), 1]), usage: { role: 'embedding', input: texts.length },
    });
    await updateIndex(state, {}, config, { embedFn, limit: 100 });
    const version = state.index.version;
    config.roles.embedding.timeoutMs += 1000;
    const unchanged = await updateIndex(state, {}, config, { embedFn, limit: 100 });
    assert.equal(unchanged.usage.length, 0, 'transport settings do not change the vector space');
    assert.equal(state.index.version, version);
    config.roles.embedding.model = 'second';
    const partial = await updateIndex(state, {}, config, { embedFn, limit: 1 });
    assert.ok(partial.remaining > 0);
    assert.equal(state.index.version, version);
    assert.ok(state.index.build.version !== version);
    const documents = searchDocuments(state);
    assert.ok(hybridCandidates(documents, 'ink-stained', null, {}, 8).length > 0);
    await updateIndex(state, {}, config, { embedFn, limit: 100 });
    assert.notEqual(state.index.version, version);
    assert.equal(state.index.pending, false);
});

test('selector abstention does not call fallback and never injects diagnostics', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    config.roles.selector = { ...config.roles.selector, enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' };
    config.roles.fallback = { ...config.roles.fallback, enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'fallback' };
    saveConfig(directories, config);
    const calls = [];
    const result = await recall(directories, locator, {}, { call: async (_directories, _config, role) => {
        calls.push(role);
        return { value: { status: 'complete', selections: [], rejections: [], needsEvidence: [] }, usage: { role } };
    } });
    assert.deepEqual(calls, ['selector']);
    assert.equal(result.inspection.fallbackUsed, false);
    assert.equal(result.memoryText, '');
});

test('invalid primary output uses only the configured read-only fallback; invented fallback text is rejected', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    for (const role of ['selector', 'fallback']) Object.assign(config.roles[role], { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: role });
    saveConfig(directories, config);
    const calls = [];
    const result = await recall(directories, locator, {}, { call: async (_directories, _config, role, _contract, input) => {
        calls.push(role);
        if (role === 'selector') return { value: { replaceMemory: 'bad' }, usage: { role } };
        const candidate = input.candidates.find(item => item.recordId === 'event:gift');
        return { value: { status: 'complete', selections: [{
            recordId: candidate.recordId, relevanceType: 'direct', currentCueRefs: [input.scene.at(-1).id],
            memoryEvidenceRefs: [candidate.sourceRefs[0]], justification: 'INSPECT ONLY: same gift.',
        }], rejections: [], needsEvidence: [] }, usage: { role } };
    } });
    assert.deepEqual(calls, ['selector', 'selector', 'fallback']);
    assert.ok(result.memoryText.includes('Mara accepted the gift.'));
    assert.equal(result.memoryText.includes('INSPECT ONLY'), false);
    assert.equal(result.inspection.fallbackUsed, true);
    const rejected = await recall(directories, locator, {}, { call: async (_directories, _config, role) => ({
        value: { status: 'complete', selections: [], rejections: [], needsEvidence: [], newMemory: 'invented' }, usage: { role },
    }) });
    assert.equal(rejected.memoryText, '');
    assert.equal(rejected.inspection.status, 'degraded');
});

test('restore keeps source authority, preserves an author correction, and cannot resurrect rejected evidence', () => {
    const { state } = giftHistory();
    const exported = { format: 'mewmory-export-1', state: structuredClone(state) };
    const corrected = state.records.find(record => record.kind === 'event');
    putRecord(state, { ...corrected, text: 'Temporary wrong edit.', authorOverride: true, origin: 'author' });
    const restored = restoreRecords(state, exported);
    assert.ok(restored.restored.includes(corrected.id));
    assert.equal(state.records.find(record => record.id === corrected.id).text, corrected.text);
    assert.ok(state.records.find(record => record.id === corrected.id).authorOverride);
    const changed = structuredClone(fixture.messages);
    changed[2].mes = 'The gift scene is rejected.';
    syncSources(state, changed, fixture.lore);
    const rejected = restoreRecords(state, exported);
    assert.ok(rejected.skipped.some(item => item.id === corrected.id));
    assert.equal(eligibleRecords(state).some(record => record.id === corrected.id), false);
    assert.throws(() => restoreRecords(state, { ...exported, state: { ...exported.state, storyId: 'unrelated' } }), /another story/);
});

test('real model HTTP calls complete chronological extraction, bounded interviews and read-only recall', async t => {
    const { directories, filename } = disk(t);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    config.batchMessages = 3;
    for (const role of Object.keys(config.roles)) Object.assign(config.roles[role], { enabled: true, endpoint: provider.url, model: role });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const bytes = fs.readFileSync(filename, 'utf8');
    let state;
    do {
        state = await processBatch(directories, locator);
    } while (pendingSources(state, config).length);
    assert.equal(state.records.filter(record => record.kind === 'interview').length, 2);
    const callsBefore = provider.calls.length;
    await processBatch(directories, locator);
    assert.equal(provider.calls.length, callsBefore);
    const result = await recall(directories, locator);
    assert.ok(result.npcText.includes('Silver eyes'));
    assert.ok(result.memoryText.includes('Her objection has softened'));
    assert.ok(result.memoryText.includes('imaginary armchair'));
    assert.equal(result.memoryText.includes('INSPECT ONLY'), false);
    assert.equal(result.memoryText.includes('SEARCH ONLY'), false);
    assert.ok(provider.calls.filter(call => call.model === 'pawspective').every(call => !JSON.stringify(call.messages).includes('SECRET:')));
    assert.ok(provider.calls.filter(call => call.model === 'pawspective').every(call =>
        call.messages[0].content.includes('1-3 short sentences per answer') && call.messages[0].content.includes('at most one brief narrated action')));
    assert.ok(provider.calls.every(call => call.tools === undefined));
    assert.equal(fs.readFileSync(filename, 'utf8'), bytes);
    provider.mode.invalidSelector = true;
    const fallback = await recall(directories, locator);
    assert.equal(fallback.inspection.fallbackUsed, true);
    assert.ok(fallback.memoryText.includes('Her objection has softened'));
});

test('a full backfill batch preserves earlier knowledge across branches and revalidates unchanged records after an edit', async t => {
    const { directories, write } = disk(t);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const config = defaultConfig();
    assert.equal(config.batchMessages, 12);
    for (const role of ['extractor', 'pawspective']) Object.assign(config.roles[role], { enabled: true, endpoint: provider.url, model: role });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const reversedRequests = async (...args) => {
        const result = await callJsonRole(...args);
        result.value.interviews?.reverse();
        return result;
    };
    let state = await processBatch(directories, locator, {}, reversedRequests);
    const snapshots = eligibleRecords(state).filter(record => record.kind === 'interview');
    assert.deepEqual(snapshots.map(record => record.asOf), [2, 5]);
    const inputs = provider.calls.filter(call => call.model === 'pawspective').map(call => JSON.parse(call.messages.at(-1).content));
    assert.deepEqual(inputs.map(input => input.asOf), [2, 5]);
    assert.equal(JSON.stringify(inputs[0]).includes('purchase date'), false);
    assert.equal(JSON.stringify(inputs).includes('SECRET:'), false);
    assert.equal(inputs[1].priorInterviews[0].id, snapshots[0].id);
    assert.ok(snapshots[1].dependencies.some(dependency => dependency.id === snapshots[0].id));
    const branch = forkState(state, { ...locator, chat: 'Earlier branch' }, 2, fixture.messages.slice(0, 3));
    assert.deepEqual(eligibleRecords(branch).filter(record => record.kind === 'interview').map(record => record.id), [snapshots[0].id]);
    assert.equal(JSON.stringify(branch).includes('purchase date'), false);
    const restored = structuredClone(state);
    restored.records = [];
    restored.audit = [];
    restored.overrides = [];
    assert.deepEqual(restoreRecords(restored, { format: 'mewmory-export-1', state }).skipped, []);
    assert.deepEqual(eligibleRecords(restored).filter(record => record.kind === 'interview').map(record => record.asOf), [2, 5]);

    const edited = structuredClone(fixture.messages);
    edited[6].mes = 'You kept it? The player looks at the bag.';
    write(edited);
    state = await loadCurrentState(directories, locator);
    assert.equal(recordEligible(state, state.records.find(record => record.id === snapshots[0].id)), false);
    assert.equal(pendingSources(state, config).length, fixture.messages.length);
    state = await processBatch(directories, locator, {}, reversedRequests);
    assert.deepEqual(eligibleRecords(state).filter(record => record.kind === 'interview').map(record => record.asOf), [2, 5]);
    assert.equal(pendingSources(state, config).length, 0);
});

test('recall gives the selector significance evidence and preserves its usefulness order', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    const state = mutateState(directories, locator, state => {
        state.enabled = true;
        event(state);
        event(state, { id: 'event:receipt', text: 'Mara reconsidered the gift after reading its receipt.', asOf: 5,
            refs: [state.timeline[5]], significance: 'high', evidenceRefs: [state.timeline[5]] });
    });
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    Object.assign(config.roles.selector, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' });
    saveConfig(directories, config);
    const order = ['event:receipt', 'event:gift'];
    const result = await recall(directories, locator, {}, { call: async (_directories, _config, role, _contract, input) => {
        const receipt = input.candidates.find(candidate => candidate.recordId === order[0]);
        assert.equal(receipt.significance, 'high');
        assert.deepEqual(receipt.significanceEvidence, [state.timeline[5].id + '@' + state.timeline[5].revision]);
        return { value: { status: 'complete', selections: order.map(recordId => ({
            recordId, relevanceType: 'direct', currentCueRefs: [input.scene.at(-1).id],
            memoryEvidenceRefs: [input.candidates.find(candidate => candidate.recordId === recordId).sourceRefs[0]],
            justification: 'INSPECT ONLY: useful gift history.',
        })), rejections: [], needsEvidence: [] }, usage: { role } };
    } });
    assert.deepEqual(result.selected, order);
    assert.ok(result.memoryText.indexOf('event:receipt') < result.memoryText.indexOf('event:gift'));
    assert.equal(result.memoryText.includes('INSPECT ONLY'), false);
});

test('recall uses its completed snapshot when automatic memory finishes, but rejects a subsequent author correction', async t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    Object.assign(config.roles.selector, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const result = await recall(directories, locator, {}, { call: async (_directories, _config, role, _contract, input) => {
        const candidate = input.candidates.find(candidate => candidate.recordId === 'event:gift');
        mutateState(directories, locator, state => { event(state, { text: 'A newer automatic interpretation.' }); });
        return { value: { status: 'complete', selections: [{
            recordId: candidate.recordId, relevanceType: 'direct', currentCueRefs: [input.scene.at(-1).id],
            memoryEvidenceRefs: [candidate.sourceRefs[0]], justification: 'The gift is discussed again.',
        }], rejections: [], needsEvidence: [] }, usage: { role } };
    } });
    assert.ok(result.memoryText.includes('Mara accepted the gift.'));
    assert.equal(result.memoryText.includes('A newer automatic interpretation.'), false);
    const state = readState(directories, locator);
    assert.equal(generationFingerprint(state, readConfig(directories)), result.validationFingerprint);
    assert.equal(inspectState(state, config).previewCurrent, false);
    assert.equal(state.index.pending, true);
    await assert.rejects(recall(directories, locator, {}, { call: async (_directories, _config, role) => {
        mutateState(directories, locator, state => {
            putRecord(state, { ...state.records[0], excluded: true, authorOverride: true, origin: 'author' });
        });
        return { value: { status: 'complete', selections: [], rejections: [], needsEvidence: [] }, usage: { role } };
    } }), /changed while memories were being picked/);
});

test('local recall overlaps embeddings and selection, reuses completed IDs and rejects stale background work', async t => {
    const { directories, write } = disk(t);
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    Object.assign(config.roles.selector, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' });
    Object.assign(config.roles.embedding, { enabled: true, endpoint: 'http://127.0.0.1:4491/v1', model: 'embedding' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    let releaseEmbedding, releaseSelector, startEmbedding, startSelector;
    const embeddingHeld = new Promise(resolve => { releaseEmbedding = resolve; });
    const selectorHeld = new Promise(resolve => { releaseSelector = resolve; });
    const embeddingStarted = new Promise(resolve => { startEmbedding = resolve; });
    const selectorStarted = new Promise(resolve => { startSelector = resolve; });
    t.after(() => { releaseEmbedding(); releaseSelector(); });
    let selections = 0;
    const dependencies = {
        embedFn: async (_directories, _config, inputs) => {
            startEmbedding();
            await embeddingHeld;
            return { vectors: inputs.map(() => [1, 0, 1]), usage: { role: 'embedding' } };
        },
        call: async (_directories, _config, role, _contract, input) => {
            selections++;
            startSelector();
            await selectorHeld;
            const candidate = input.candidates.find(candidate => candidate.recordId === 'event:gift');
            return { value: { status: 'complete', selections: candidate ? [{ recordId: candidate.recordId,
                relevanceType: 'direct', currentCueRefs: [input.scene.at(-1).id],
                memoryEvidenceRefs: [candidate.sourceRefs[0]], justification: 'INSPECT ONLY' }] : [],
            rejections: [], needsEvidence: [] }, usage: { role } };
        },
    };
    const quick = await recall(directories, locator, { local: true }, dependencies);
    assert.ok(quick.memoryText.includes('Mara accepted the gift.'));
    assert.equal(quick.inspection.status, 'local');
    await embeddingStarted;
    const job = recallInBackground(directories, locator, {}, dependencies);
    await recall(directories, locator, { local: true }, dependencies);
    assert.equal(recallInBackground(directories, locator, {}, dependencies), job, 'one pending job per story');
    releaseEmbedding();
    await selectorStarted;
    assert.equal(selections, 1);
    const preview = readState(directories, locator).preview;
    write([...fixture.messages, { name: 'Mara', is_user: false, send_date: 'parallel-reply', mes: 'I kept it.' }]);
    await loadCurrentState(directories, locator);
    releaseSelector();
    await job;
    const completed = readState(directories, locator);
    assert.ok(completed.recalls.at(-1).background);
    assert.deepEqual(completed.preview, preview, 'late selection must not replace the actual writer preview');
    const cached = await recall(directories, locator, { local: true }, dependencies);
    assert.equal(cached.inspection.selections[0].recordId, 'event:gift');
    assert.ok(!cached.memoryText.includes('INSPECT ONLY'));
    await recallInBackground(directories, locator, {}, dependencies);
    const earlier = await recall(directories, locator, { local: true, asOf: 0 }, dependencies);
    assert.deepEqual(earlier.inspection.selections, [], 'future selections must not leak into an earlier swipe');
    await recallInBackground(directories, locator, {}, dependencies);
    await assert.rejects(recall(directories, locator, { background: true }, { ...dependencies,
        call: async () => {
            mutateState(directories, locator, state => { putRecord(state, { ...state.records[0], excluded: true, authorOverride: true, origin: 'author' }); });
            return { value: { status: 'complete', selections: [], rejections: [], needsEvidence: [] }, usage: {} };
        },
    }), /changed while memories were being picked/);
});

test('HTTP preparation uses only completed preservation and accepts automatic progress before final validation', async t => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
        name: index % 2 ? 'Player' : 'Mara', is_user: Boolean(index % 2),
        send_date: 'long-' + index, mes: 'Harbour continuity detail ' + index + '. '.repeat(2) + 'walking '.repeat(400),
    }));
    const { directories, filename } = disk(t, messages);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    config.historyWindow = 1024;
    for (const role of ['extractor', 'pawspective', 'selector']) Object.assign(config.roles[role], { enabled: true, endpoint: provider.url, model: role });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const express = (await import('express')).default;
    const { router } = await import('../src/endpoints/mewmory.js');
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => { request.user = { directories }; next(); });
    app.use(router);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = 'http://127.0.0.1:' + server.address().port;
    const prepare = async () => {
        const response = await fetch(url + '/prepare', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(3000),
            body: JSON.stringify({ locator, integrity: 'fixture', history: messages.map((message, index) => ({ index, text: message.mes })) }),
        });
        const value = await response.json();
        assert.equal(response.status, 200, JSON.stringify(value));
        return value;
    };
    const original = fs.readFileSync(filename, 'utf8');
    provider.mode.fail = true;
    await assert.rejects(processBatch(directories, locator, { checkpoint: true }), /The model for Facts and events returned error code 503/);
    const failed = await prepare();
    await recallInBackground(directories, locator);
    assert.deepEqual(failed.excludedIndices, []);
    assert.ok(failed.history.waitingForPreservation);
    assert.deepEqual(readState(directories, locator).checkpoints, {});
    provider.mode.fail = false;
    const callsBefore = provider.calls.length;
    provider.mode.hold = 'selector';
    try {
        assert.deepEqual((await prepare()).excludedIndices, [], 'reply preparation must finish while AI recall is held');
    } finally {
        await fetch(provider.url.replace('/v1', '/fixture/release'), { method: 'POST', body: '{}' });
        await recallInBackground(directories, locator);
    }
    assert.ok(provider.calls.slice(callsBefore).every(call => call.model === 'selector'), 'preparation must not start extraction or preservation');
    await processBatch(directories, locator, { checkpoint: true });
    const preserved = await prepare();
    await recallInBackground(directories, locator);
    assert.ok(preserved.excludedIndices.length > 0);
    assert.ok(preserved.history.retainedTokens <= 1024);
    assert.equal(fs.readFileSync(filename, 'utf8'), original);
    assert.ok(searchDocuments(readState(directories, locator)).some(document => document.text.includes('Harbour continuity detail 0')));
    const validate = () => fetch(url + '/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locator, fingerprint: preserved.validationFingerprint }),
    });
    mutateState(directories, locator, state => { event(state); });
    assert.equal((await validate()).status, 200, 'background completion must not invalidate a prepared prompt');
    mutateState(directories, locator, state => {
        putRecord(state, { ...state.records[0], pinned: true, origin: 'author', authorOverride: true });
    });
    assert.equal((await validate()).status, 409, 'author corrections still invalidate a prepared prompt');
});

test('restoring a complete export preserves earlier knowledge revisions and subsequent chronological processing', () => {
    const state = base();
    knowledge(state);
    const original = interview(state, 2, 'knowledge:gift', 'She is evasive.', 'She suspects pity.', 'before');
    knowledge(state, { sequence: 5, text: 'Mara learned the purchase date.', quote: 'Mara reads the date on the receipt.' });
    interview(state, 5, 'knowledge:gift', 'Her view softened.', 'She no longer assumes pity.', 'after');
    const backup = { format: 'mewmory-export-1', state: structuredClone(state) };
    const empty = structuredClone(state);
    empty.records = [];
    empty.audit = [];
    empty.overrides = [];
    const result = restoreRecords(empty, backup);
    assert.deepEqual(result.skipped, []);
    assert.ok(empty.records.some(record => record.id === original.id && recordEligible(empty, record)));
    const past = interviewInput(empty, { ownerId: 'npc:mara', subjectIds: ['gift'], knowledgeIds: ['knowledge:gift'] }, 2);
    assert.equal(past.knownFacts[0].text.includes('purchase date'), false);
    assert.equal(searchDocuments(empty).some(document => document.id.startsWith('restored:')), false);
});

test('reclassifying an entity as player-controlled makes subjective memories ineligible', () => {
    const { state, original } = giftHistory();
    const owner = state.records.find(record => record.entityId === 'npc:mara');
    putRecord(state, { ...owner, isCharacter: false, authorOverride: true, origin: 'author' });
    assert.equal(recordEligible(state, original), false);
});

test('character rename keeps story identity and supports rollback; deleting its chats removes the memory store', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    const before = mutateState(directories, locator, state => { event(state); });
    const next = { ...locator, avatar: 'Renamed Mara.png' };
    const undo = renameCharacterMemory(directories, locator.avatar, next.avatar);
    const renamed = readState(directories, next);
    assert.equal(renamed.storyId, before.storyId);
    assert.equal(renamed.characterAliases[next.avatar], locator.avatar);
    undo();
    assert.equal(readState(directories, locator).storyId, before.storyId);
    assert.equal(fs.existsSync(statePath(directories, next)), false);
    removeSourceMemory(directories, { avatar: locator.avatar, deleteChats: true });
    assert.equal(fs.existsSync(statePath(directories, locator)), false);
});

test('revoked model permissions are checked again before any outbound request', async t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.selector, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' });
    const captured = saveConfig(directories, config);
    saveConfig(directories, { ...captured, roles: { ...captured.roles, selector: { ...captured.roles.selector, enabled: false } } });
    await assert.rejects(callJsonRole(directories, captured, 'selector', 'Select IDs.', {}, { dataTypes: [] }), /permissions or settings changed/);
});

test('comparison artifacts keep a common memory allowance and exclude selector explanations', t => {
    const { state, original } = giftHistory();
    state.recalls = [{ selections: [{ recordId: original.id, justification: 'INSPECT ONLY' }] }];
    const { directories } = disk(t);
    const exported = path.join(directories.root, 'export.json');
    const summary = path.join(directories.root, 'baseline.txt');
    const output = path.join(directories.root, 'comparison');
    writeJson(exported, { format: 'mewmory-export-1', state });
    fs.writeFileSync(summary, 'Mara accepted a gift, initially objected, and later softened after reading the receipt.');
    const result = spawnSync(process.execPath, ['scripts/compare-mewmory-contexts.js', exported, summary, output], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
    assert.deepEqual(Object.keys(report.variants), ['baseline', 'objective', 'pawspective']);
    assert.ok(Object.values(report.variants).every(variant => variant.memoryTokens <= report.memoryBudget));
    assert.equal(report.qualityScores, null);
    assert.equal(fs.readFileSync(path.join(output, 'pawspective.txt'), 'utf8').includes('INSPECT ONLY'), false);
});
