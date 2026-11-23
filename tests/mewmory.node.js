/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
/* global globalThis, Atomics, SharedArrayBuffer, WeakRef */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const {
    continueState, currentRecords, eligibleRecords, forkState, hash, newState, putRecord, recordEligible, recordEligibleIn, recordRevision, recordRevisionIn,
    eligibilityLookups, eligibilityStats, POLICY_VERSION, purgeSources, READ_EARLIER, refKey, ROLE_NAMES, sourceAt, sourceEligible, sourceFingerprint, syncSources, undoRecord, validateRecord,
} = await import('../src/mewmory/core.js');
const { activeReferences, assembleContext, generationFingerprint } = await import('../src/mewmory/context.js');
const { callJsonRole, defaultConfig, embed, isLocalEndpoint, validateEndpoint, saveConfig } = await import('../src/mewmory/models.js');
const { applyExtraction, applyInterview, extractionInput, interviewInput, pendingCounts, pendingSources, processBatch, processingVersion, testHooks: processingHooks } = await import('../src/mewmory/processing.js');
const { forcedMatches, validateSelection, recall, recallInBackground } = await import('../src/mewmory/retrieval.js');
const { expandNeighbours, hybridCandidates, lexicalSearch, recallPool, searchDocuments, searchStats, splitPassages, updateIndex } = await import('../src/mewmory/search.js');
const { loadCurrentState, loadCurrentStateSync } = await import('../src/mewmory/sources.js');
const { createMemoryPressureCheck } = await import('../src/memory-pressure.js');
const { prepareMewmoryPrompt } = await import('../src/mewmory/prepare.js');
const { batchState, everyoneState, groupLineHeld, memberHeard, sameAudience, sourceAudience, viewerState } = await import('../src/mewmory/viewers.js');
const { branchParentLocator, buildBranchMemoryState, cacheUsage, chatPath, cloneState, listStories, mutateState, normalizeLocator, readChatShared, readJsonShared, readState, readStateShared, sharedJsonHooks, recoveryPath, renameChatMemory, renameCharacterMemory, renameWorldMemory, removeChatMemory, removeSourceMemory, statePath, synchronize, writeJson } = await import('../src/mewmory/store.js');
const { ensureMewmoryMessageIds } = await import('../public/scripts/mewmory/message-identity.js');
const { getCounter, getTokenizerModel } = await import('../src/mewmory/tokens.js');
const { inspectState, requestBodyExceeds, restoreRecords } = await import('../src/endpoints/mewmory.js');
const { createMewmoryProvider } = await import('./mewmory-provider.js');
const { readConfig, publicConfig, resolvedRoleIdentity, roleVersion } = await import('../src/mewmory/models.js');
const { readSecret, writeSecret, SecretManager, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
const { resolveModelProfile } = await import('../src/mewmory/connection-profiles.js');
const { EXTRACTION_CONTRACT, PAWSPECTIVE_CONTRACT } = await import('../src/mewmory/contracts.js');
const { startProcessing, waitForProcessing, cancelProcessing, scanProcessing, startMewmoryWorker, pauseInterruptedProcessing } = await import('../src/mewmory/worker.js');
const { startOperation, registerMewmoryOperations } = await import('../src/mewmory/operations.js');
const { getJob: getSavedJob, recoverJobs, updateJob } = await import('../src/jobs/store.js');
const { setDirectoriesResolver, testExports: jobRunner } = await import('../src/jobs/runner.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { applyOverflowHiding, planPreservedMessageHiding, planPreservedOverflowHiding, prepareAutomaticHiding, writerTokenizerFromMaterial } = await import('../src/mewmory/hiding.js');
const { markServiceBusy, markServiceWorking, parseRetryAfter, resetServiceCooldowns, serviceBusyUntil } = await import('../src/mewmory/cooldown.js');

// Fixture providers share URLs, so one test's rate limit must not pause the next test's requests.
beforeEach(() => resetServiceCooldowns());

function expectedCompactIndex(index) {
    const expected = structuredClone(index);
    for (const map of [expected.vectors, expected.build?.vectors]) for (const entry of Object.values(map ?? {})) {
        const bytes = new ArrayBuffer(entry.vector.length * 4);
        const view = new DataView(bytes);
        entry.vector.forEach((value, offset) => view.setFloat32(offset * 4, Math.fround(value), true));
        delete entry.vector;
        entry.vectorF32LE = Buffer.from(bytes).toString('base64');
    }
    return expected;
}

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

test('memory prompts ask for short, specific records that update instead of repeating', async t => {
    const { directories } = disk(t);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: provider.url, model: 'extractor' });
    saveConfig(directories, config);
    await callJsonRole(directories, readConfig(directories), 'extractor', EXTRACTION_CONTRACT, { sources: [], existing: [] });
    const system = provider.calls.at(-1).messages[0].content;
    assert.match(system, /Write short, specific records/);
    assert.match(system, /an event, relationship or commitment takes one or two sentences/);
    assert.match(system, /update that record under its existing ID instead of adding a near-duplicate/);
    assert.doesNotMatch(system, /two to four full sentences|Cover everything a later scene could need/);
    assert.match(system, /An entity’s text always says who they are/);
    assert.match(system, /never write that something is not described, and never fill a gap with a likely detail/);
    assert.match(system, /at the length the contract asks for/);
    assert.doesNotMatch(system, /one short sentence where possible|stay brief|Keep every text field short/);
    assert.match(PAWSPECTIVE_CONTRACT, /two to four sentences/);
    assert.doesNotMatch(PAWSPECTIVE_CONTRACT, /1-3 short sentences|one brief third-person/);
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
    resetServiceCooldowns(); // The failure above paused this service; the test moves on as if the wait has passed.
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
    const pieces = [...assembled.memoryText.matchAll(/\[Earlier chat excerpt[^\]]*\]\n([^]*?)(?=\n\n\[Earlier chat excerpt|$)/g)].map(match => match[1]);
    assert.ok(pieces.length >= 3, 'overlapping passages retain their visible content');
    const coveredRanges = [];
    const expectedPieces = [];
    for (const document of expanded) {
        let remaining = [[document.start, document.end]];
        for (const [start, end] of coveredRanges) remaining = remaining.flatMap(([a, b]) => b <= start || a >= end ? [[a, b]]
            : [...(a < start ? [[a, start]] : []), ...(b > end ? [[end, b]] : [])]);
        for (const [start, end] of remaining) {
            expectedPieces.push(original.slice(start, end));
            coveredRanges.push([start, end]);
        }
    }
    assert.deepEqual(pieces, expectedPieces, 'rendered text follows selected source ranges without repeated overlap');
    assert.doesNotMatch(assembled.memoryText, /characters \d+-\d+|Sources:/);
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
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
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

test('a group speaker recalls only memories from lines they heard, and changing who heard re-reads nothing', async t => {
    const heardBy = present => fixture.messages.map((message, index) => index === 2
        ? { ...structuredClone(message), extra: { ...message.extra, group_scene: { present, whisper_to: [] } } }
        : structuredClone(message));
    const { directories, write } = disk(t, heardBy(['Mara.png']));
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    saveConfig(directories, config);
    const dependencies = { call: async () => assert.fail('No selector is enabled'), embedFn: async () => assert.fail('No embeddings are enabled'), scheduleBackground: false };
    const ask = async viewers => {
        const state = await loadCurrentState(directories, locator);
        return recall(directories, locator, { local: true, query: 'gift', state, viewer: viewerState(state, viewers) }, dependencies);
    };
    assert.match((await ask(['Mara.png'])).memoryText, /Mara accepted the gift/);
    assert.equal(viewerState(await loadCurrentState(directories, locator), ['Mara.png']), null);
    const missed = await ask(['Kit.png']);
    assert.doesNotMatch(missed.memoryText, /Mara accepted the gift/);
    assert.ok(missed.inspection.viewerKey);
    assert.doesNotMatch((await ask(['Mara.png', 'Kit.png'])).memoryText, /Mara accepted the gift/, 'a memory must be heard by every speaker it is written for');

    const before = await loadCurrentState(directories, locator);
    write(heardBy(['Mara.png', 'Kit.png']));
    const after = await loadCurrentState(directories, locator);
    const ref = after.timeline[2];
    assert.equal(ref.revision, before.timeline[2].revision, 'who heard a line is not part of its text, so it is not re-read');
    assert.deepEqual(after.coverage, before.coverage);
    assert.deepEqual(after.sources[ref.id].audience, { present: ['Mara.png', 'Kit.png'], whisper_to: [] });
    assert.notEqual(generationFingerprint(after, readConfig(directories)), generationFingerprint(before, readConfig(directories)));
    assert.match((await ask(['Kit.png'])).memoryText, /Mara accepted the gift/);
});

test('preparing a group reply checks its speakers and keeps lines whose memories they cannot use', async t => {
    const messages = fixture.messages.map((message, index) => index === 2
        ? { ...structuredClone(message), extra: { ...message.extra, group_scene: { present: ['Mara.png'], whisper_to: [] } } }
        : structuredClone(message));
    const { directories } = disk(t, messages);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    saveConfig(directories, config);
    const history = messages.map((message, index) => ({ index, text: message.name + ': ' + message.mes }));
    const options = { scheduleBackground: false };
    await assert.rejects(prepareMewmoryPrompt(directories, { locator, history, viewers: [] }, null, options), /valid group speakers/);
    await assert.rejects(prepareMewmoryPrompt(directories, { locator, history, viewers: 'Kit.png' }, null, options), /valid group speakers/);
    const everyone = await prepareMewmoryPrompt(directories, { locator, history }, null, options);
    assert.match(everyone.memoryText, /Mara accepted the gift/);
    const kit = await prepareMewmoryPrompt(directories, { locator, history: history.filter(item => item.index !== 2), viewers: ['Kit.png'] }, null, options);
    assert.equal(kit.enabled, true);
    assert.doesNotMatch(kit.memoryText, /Mara accepted the gift/);
    assert.ok(kit.excludedIndices.every(index => index < 2), 'lines after the one Kit missed stay in his prompt');
});

const groupContext = () => [...fixture.lore,
    { id: 'character:mara', type: 'character', entityId: 'npc:mara', name: 'Mara', text: 'Mara', meta: { avatar: 'Mara.png' } },
    { id: 'character:kit', type: 'character', entityId: 'npc:kit', name: 'Kit', text: 'Kit', meta: { avatar: 'Kit.png' } }];

const groupMessages = (missed, present = ['Mara.png'], everyone = false) => fixture.messages.map((message, index) => missed.includes(index)
    ? { ...structuredClone(message), extra: { ...message.extra, group_scene: { present, whisper_to: [], ...(everyone ? { everyone } : {}) } } }
    : { ...structuredClone(message), extra: { ...message.extra, group_scene: { present: ['Mara.png', 'Kit.png'], whisper_to: [] } } });

/** A group story where Mara heard everything and Kit missed the line where she accepts the gift. */
function groupStory({ present = ['Mara.png'], missed = [2], everyone = false } = {}) {
    const state = newState({ avatar: '', chat: 'Gift', group: true });
    syncSources(state, groupMessages(missed, present, everyone), groupContext());
    state.enabled = true;
    return state;
}

/** Kit catches up on every line but those still missed, as Catch up and Who heard this save it. */
function catchUp(state, missed = []) {
    syncSources(state, groupMessages(missed), groupContext());
}

function groupEvent(state, { id = 'event:gift', refs = [state.timeline[2]], text = 'Mara accepted the gift.', asOf = 2 } = {}, present = null) {
    const record = validateRecord(state, { id, kind: 'event', text, refs, subjectIds: ['gift'], evidenceStatus: 'established' }, { asOf, origin: 'objective_extractor' });
    if (present) record.provenance = { policy: 'test', jobId: 'job', audience: { present, whisper_to: [] } };
    putRecord(state, record, { automatic: true });
}

test('group memories say who heard them, so later lines stay readable to a member who missed an earlier one', () => {
    const state = groupStory();
    groupEvent(state, { id: 'event:arrival', refs: [state.timeline[1]], text: 'The player brought a gift.', asOf: 1 }, ['Mara.png', 'Kit.png']);
    groupEvent(state, {}, ['Mara.png']);
    groupEvent(state, { id: 'event:receipt', refs: [state.timeline[4]], text: 'The player showed a receipt.', asOf: 4 }, ['Mara.png', 'Kit.png']);
    groupEvent(state, { id: 'event:legacy', refs: [state.timeline[5]], text: 'Mara reread the receipt.', asOf: 5 });
    for (const record of state.records) if (record.id !== 'event:legacy') assert.ok(record.provenance.audience);
    assert.equal(viewerState(state, ['Mara.png']), null);
    const kit = viewerState(state, ['Kit.png']);
    const ids = kit.state.records.map(record => record.id);
    assert.ok(ids.includes('event:arrival'));
    assert.ok(ids.includes('event:receipt'), 'a memory from lines Kit heard stays his, even after a line he missed');
    assert.ok(!ids.includes('event:gift'));
    assert.ok(!ids.includes('event:legacy'), 'an older memory without listeners is held back after the first missed line');
    assert.deepEqual([...kit.heldRefs].sort(), [state.timeline[2].id, state.timeline[5].id].sort());
});

test('a line every member hears gives memories everyone may read, members who missed its listed hearers included', () => {
    const state = groupStory({ everyone: true });
    assert.equal(viewerState(state, ['Kit.png']), null, 'Kit hears the line even though only Mara was listed');
    const input = { ...extractionInput(state, [state.timeline[2]], 2), provenance: { policy: 'test', jobId: 'job' } };
    applyExtraction(state, { records: [
        { id: 'event:accepts', kind: 'event', text: 'Mara accepted the gift and placed it carefully.', refs: [state.timeline[2]], subjectIds: ['gift'], evidenceStatus: 'established' },
    ] }, input, []);
    assert.equal(state.records.find(record => record.id === 'event:accepts').provenance.audience, null);
    assert.equal(viewerState(state, ['Kit.png']), null);
});

test('extraction batches keep one audience, build only on what every listener may read, and skip knowledge a character never heard', () => {
    const state = groupStory();
    assert.deepEqual(sameAudience(state, state.timeline.slice(0, 5)), state.timeline.slice(0, 2));
    assert.deepEqual(sameAudience(state, state.timeline.slice(2, 5)), state.timeline.slice(2, 3));
    assert.deepEqual(sameAudience(state, state.timeline.slice(3, 6)), state.timeline.slice(3, 6));
    groupEvent(state, {}, ['Mara.png']);
    const existing = story => extractionInput(story, [story.timeline[4]], 4).existing.map(record => record.id);
    assert.ok(!existing(state).includes('event:gift'), 'Kit heard this batch, so the line he missed is not shown to the model');
    const shared = groupStory({ present: ['Mara.png', 'Kit.png'] });
    groupEvent(shared, {}, ['Mara.png', 'Kit.png']);
    assert.ok(existing(shared).includes('event:gift'));
    assert.equal(batchState(groupStory({ present: ['Mara.png', 'Kit.png'] }), null), null);
    assert.ok(memberHeard(state, { present: ['Mara.png'], whisper_to: [] }, 'npc:mara'));
    assert.ok(!memberHeard(state, { present: ['Mara.png'], whisper_to: [] }, 'npc:kit'));
    assert.ok(memberHeard(state, { present: ['Mara.png'], whisper_to: [] }, 'npc:stranger'));

    const input = { ...extractionInput(state, [state.timeline[2]], 2), provenance: { policy: 'test', jobId: 'job' } };
    const skipped = [];
    applyExtraction(state, { records: [
        { id: 'event:accepts', kind: 'event', text: 'Mara accepted the gift and placed it carefully.', refs: [state.timeline[2]], subjectIds: ['gift'], evidenceStatus: 'established' },
        { id: 'knowledge:kit-gift', kind: 'knowledge', ownerId: 'npc:kit', subjectIds: ['gift'], text: 'Kit knows Mara accepted the gift.', method: 'witnessed', evidenceText: 'Mara accepts the gift.', refs: [state.timeline[2]] },
    ] }, input, skipped);
    const saved = state.records.find(record => record.id === 'event:accepts');
    assert.deepEqual(saved.provenance.audience, { present: ['Mara.png'], whisper_to: [] });
    assert.ok(!state.records.some(record => record.id === 'knowledge:kit-gift'));
    assert.ok(skipped.some(message => /did not hear/.test(message)));
});

test('group lorebooks and shared memories hold back what some members missed, and hiding keeps lines a listener still needs', async () => {
    const { loreEntries } = await import('../src/mewmory/markdown.js');
    const { shareRecords } = await import('../src/mewmory/shared.js');
    const state = groupStory();
    groupEvent(state, { id: 'event:arrival', refs: [state.timeline[1]], text: 'The player brought a gift.', asOf: 1 }, ['Mara.png', 'Kit.png']);
    groupEvent(state, {}, ['Mara.png']);
    groupEvent(state, { id: 'event:secret', refs: [state.timeline[4]], text: 'Mara hid the receipt.', asOf: 4 }, ['Mara.png']);
    groupEvent(state, { id: 'event:legacy', refs: [state.timeline[3]], text: 'The player smiled.', asOf: 3 });

    const everyone = everyoneState(state);
    assert.deepEqual(everyone.records.map(record => record.id), ['event:arrival']);
    const lore = loreEntries(state).map(entry => entry.id);
    assert.ok(lore.includes('event:arrival'));
    assert.ok(!lore.some(id => ['event:gift', 'event:secret', 'event:legacy'].includes(id)));
    assert.throws(() => shareRecords({}, state, ['event:gift', 'event:secret']), /did not hear/);

    const held = groupLineHeld(state);
    assert.equal(held(state.timeline[1]), false, 'everyone can read the memory of the arrival');
    assert.equal(held(state.timeline[2]), false, 'only Mara heard the gift line, and she can read its memory');
    assert.equal(held(state.timeline[3]), true, 'Kit heard this line but its older memory is closed to him');
    assert.equal(held(state.timeline[4]), true, 'Kit heard the receipt line but its memory is only for Mara');
    const plain = base(fixture.messages);
    assert.equal(groupLineHeld(plain)(plain.timeline[4]), false, 'one-to-one chats are unchanged');
    assert.equal(everyoneState(plain), plain);
});

/** A memory Mara owns in the group story, marked with who heard it unless present is null. */
function groupKnowledge(state, { id, sequence, text, quote }, present = ['Mara.png', 'Kit.png']) {
    const record = validateRecord(state, {
        id, kind: 'knowledge', ownerId: 'npc:mara', subjectIds: ['gift'], text,
        method: 'witnessed', evidenceText: quote, refs: [state.timeline[sequence]],
    }, { asOf: sequence, origin: 'objective_extractor' });
    if (present) record.provenance = { policy: 'test', jobId: 'job', audience: { present, whisper_to: [] } };
    putRecord(state, record, { automatic: true });
}

function groupInterviewStory() {
    const state = groupStory();
    const mara = validateRecord(state, {
        id: 'entity:mara', kind: 'entity', entityId: 'npc:mara', name: 'Mara', text: 'Mara', isCharacter: true,
        refs: [state.timeline[0]], subjectIds: ['npc:mara'],
    }, { asOf: 0, origin: 'objective_extractor' });
    mara.provenance = { policy: 'test', jobId: 'job', audience: { present: ['Mara.png', 'Kit.png'], whisper_to: [] }, horizon: 0 };
    putRecord(state, mara, { automatic: true });
    return state;
}

const readableTo = (state, avatar) => {
    const view = viewerState(state, [avatar]);
    return new Set((view?.state ?? state).records.map(record => record.id));
};

test('group interviews and overviews go to whoever may read the memories they were written from', () => {
    const state = groupInterviewStory();
    groupKnowledge(state, { id: 'knowledge:arrival', sequence: 1, text: 'The player brought a gift.', quote: 'I brought you a gift.' });
    const shared = interview(state, 4, 'knowledge:arrival', 'A kind thought.', 'Mara is touched by the gift.', 'shared');
    const sharedOverview = state.records.findLast(record => record.kind === 'overview');
    assert.deepEqual(shared.provenance.audience, { present: ['Mara.png', 'Kit.png'], whisper_to: [] });
    assert.deepEqual(sharedOverview.provenance.audience, shared.provenance.audience);
    assert.ok(readableTo(state, 'Kit.png').has(shared.id), 'Kit heard everything this interview was written from, even after missing a line');
    assert.ok(readableTo(state, 'Kit.png').has(sharedOverview.id));

    groupKnowledge(state, { id: 'knowledge:gift', sequence: 2, text: 'Mara accepted the gift.', quote: 'Mara accepts the gift.' }, ['Mara.png']);
    const secret = interview(state, 4, 'knowledge:gift', 'I kept it.', 'Mara treasures the gift.', 'secret');
    const secretOverview = state.records.findLast(record => record.kind === 'overview');
    assert.ok(Array.isArray(secret.provenance.audience), 'a memory only Mara heard and the shared interview before it both apply');
    assert.ok(!readableTo(state, 'Kit.png').has(secret.id), 'Kit missed the line the interview was written from');
    assert.ok(!readableTo(state, 'Kit.png').has(secretOverview.id));
    assert.ok(readableTo(state, 'Mara.png').has(secret.id));
    assert.ok(readableTo(state, 'Mara.png').has(secretOverview.id));
});

test('a group interview built on an older unmarked memory counts every line up to that memory', () => {
    const early = groupInterviewStory();
    groupKnowledge(early, { id: 'knowledge:arrival', sequence: 1, text: 'The player brought a gift.', quote: 'I brought you a gift.' }, null);
    const before = interview(early, 4, 'knowledge:arrival', 'A kind thought.', 'Mara is touched by the gift.', 'early');
    assert.deepEqual(before.provenance.audience, { present: ['Mara.png', 'Kit.png'], whisper_to: [] });
    assert.ok(readableTo(early, 'Kit.png').has(before.id));

    const late = groupInterviewStory();
    groupKnowledge(late, { id: 'knowledge:receipt', sequence: 4, text: 'The player showed a receipt.', quote: 'shows Mara the dated receipt' }, null);
    const after = interview(late, 4, 'knowledge:receipt', 'It was planned.', 'Mara rethinks the gift.', 'late');
    assert.ok(!readableTo(late, 'Kit.png').has(after.id), 'the older memory came after the line Kit missed, as the old rule reads it');
    assert.ok(readableTo(late, 'Mara.png').has(after.id));
    const { state: plain } = giftHistory();
    assert.ok(plain.records.filter(record => ['interview', 'overview'].includes(record.kind))
        .every(record => !Object.hasOwn(record.provenance ?? {}, 'audience')), 'one-to-one chats mark nothing');
});

/** Reads one batch of the group story with the model's answer, as a processing job does. */
function extractGroup(state, sequence, records) {
    const input = { ...extractionInput(state, [state.timeline[sequence]], sequence), provenance: { policy: 'test', jobId: 'job' } };
    applyExtraction(state, { records }, input, []);
    return input;
}

const accepts = state => [
    { id: 'event:accepts', kind: 'event', text: 'Mara accepted the gift and placed it carefully.', refs: [state.timeline[2]], subjectIds: ['gift'], evidenceStatus: 'established' },
    { id: 'knowledge:accepts', kind: 'knowledge', ownerId: 'npc:mara', subjectIds: ['gift'], text: 'Mara accepted the gift.', method: 'witnessed', evidenceText: 'Mara accepts the gift.', refs: [state.timeline[2]] },
];

test('a group memory reopens to a member caught up on every line behind it', () => {
    const state = groupInterviewStory();
    catchUp(state, [2, 5]);
    extractGroup(state, 2, accepts(state));
    const event = state.records.find(record => record.id === 'event:accepts');
    assert.deepEqual(event.provenance.audience, { present: ['Mara.png'], whisper_to: [] });
    assert.equal(event.provenance.horizon, 2);
    const asked = interview(state, 2, 'knowledge:accepts', 'I kept it.', 'Mara treasures the gift.', 'kept');
    const overview = state.records.findLast(record => record.kind === 'overview');
    assert.equal(asked.provenance.horizon, 2);
    assert.equal(overview.provenance.horizon, 2);
    const ids = ['event:accepts', 'knowledge:accepts', asked.id, overview.id];
    assert.ok(ids.every(id => !readableTo(state, 'Kit.png').has(id)), 'Kit missed the line all of these came from');

    catchUp(state, [5]);
    const kit = readableTo(state, 'Kit.png');
    assert.ok(ids.every(id => kit.has(id)), 'Kit has now heard every line behind them, though he still missed a later one');
});

test('a memory stays closed while anything its model saw comes from a line the member still missed', () => {
    const state = groupStory({ missed: [2, 5] });
    extractGroup(state, 2, accepts(state));
    const input = extractGroup(state, 5, [
        { id: 'event:reread', kind: 'event', text: 'Mara reread the receipt for the gift she accepted.', refs: [state.timeline[5]], subjectIds: ['gift'], evidenceStatus: 'established' },
    ]);
    assert.ok(input.existing.some(record => record.id === 'event:accepts'), 'the model reading line 5 was shown the memory of line 2');
    const reread = state.records.find(record => record.id === 'event:reread');
    assert.equal(reread.provenance.horizon, 5);

    catchUp(state, [2]);
    assert.ok(!readableTo(state, 'Kit.png').has('event:reread'), 'Kit now heard line 5, but its memory may repeat line 2, which he still missed');
    catchUp(state);
    const kit = readableTo(state, 'Kit.png');
    assert.ok(kit.has('event:reread') && kit.has('event:accepts'));
});

test('marked group memories saved before horizons stay with their listeners', () => {
    const state = groupStory({ missed: [2, 4] });
    groupEvent(state, {}, ['Mara.png']);
    const input = extractGroup(state, 4, [
        { id: 'event:receipt', kind: 'event', text: 'The player showed Mara the receipt for the gift.', refs: [state.timeline[4]], subjectIds: ['gift'], evidenceStatus: 'established' },
    ]);
    assert.ok(input.existing.some(record => record.id === 'event:gift'));
    assert.ok(!Object.hasOwn(state.records.find(record => record.id === 'event:receipt').provenance, 'horizon'),
        'a memory built beside one that cannot say what it came from cannot say either');
    catchUp(state);
    const kit = readableTo(state, 'Kit.png');
    assert.ok(!kit.has('event:gift') && !kit.has('event:receipt'));
});

test('group members remember a chat only from its memory starting point', async () => {
    const { sourceFingerprint } = await import('../src/mewmory/core.js');
    const state = groupStory({ missed: [] });
    extractGroup(state, 2, accepts(state));
    const accepted = state.records.find(record => record.id === 'event:accepts');
    assert.equal(accepted.provenance.floor, 2);
    assert.equal(viewerState(state, ['Kit.png']), null);
    const before = sourceFingerprint(state);

    syncSources(state, groupMessages([]), groupContext(), { groupStart: 4 });
    assert.equal(state.groupStart, 4);
    assert.notEqual(sourceFingerprint(state), before, 'recall picks again when the starting point moves');
    syncSources(state, groupMessages([]), groupContext());
    assert.equal(state.groupStart, 4, 'a sync that does not read the scene keeps the saved starting point');
    for (const avatar of ['Kit.png', 'Mara.png']) {
        const view = viewerState(state, [avatar]);
        assert.ok(state.timeline.slice(0, 4).every(ref => view.state.excludedSources.includes(ref.id)),
            'every line before the start is out of memory, even for members who heard it');
        assert.ok(!view.state.excludedSources.includes(state.timeline[4].id));
        assert.ok(!readableTo(state, avatar).has('event:accepts'), 'and so is what was remembered from those lines');
    }
    assert.equal(groupLineHeld(state)(state.timeline[2]), false, 'hiding does not wait for memories nobody may read');
    assert.equal(batchState(state, sourceAudience(state, state.timeline[2]), 2), null, 'a batch from before the start reads the chat as it was');

    const input = extractGroup(state, 5, [
        { id: 'event:reread', kind: 'event', text: 'Mara reread the receipt for the gift.', refs: [state.timeline[5]], subjectIds: ['gift'], evidenceStatus: 'established' },
    ]);
    assert.ok(!input.existing.some(record => record.id === 'event:accepts'), 'the model is not shown memories from before the start');
    assert.equal(state.records.find(record => record.id === 'event:reread').provenance.floor, 5);
    assert.ok(readableTo(state, 'Kit.png').has('event:reread'));

    syncSources(state, groupMessages([]), groupContext(), { groupStart: 0 });
    assert.equal(Object.hasOwn(state, 'groupStart'), false);
    assert.equal(sourceFingerprint(state), before);
    assert.equal(viewerState(state, ['Kit.png']), null, 'clearing the start gives the whole chat back');
});

test('a member who remembers only with the group recalls a memory only while someone else who heard it is in the scene', async () => {
    const { readGroupSceneRules } = await import('../public/scripts/group-chat-visibility.js');
    const state = groupStory({ missed: [] });
    groupEvent(state, { id: 'event:arrival', refs: [state.timeline[1]], text: 'The player brought a gift.', asOf: 1 }, ['Mara.png', 'Kit.png']);
    const rules = away => readGroupSceneRules({ group_scene: { away, with_group: ['Kit.png'] } });
    assert.equal(viewerState(state, ['Kit.png'], rules([])), null, 'with Mara in the scene Kit remembers everything they heard together');
    const alone = viewerState(state, ['Kit.png'], rules(['Mara.png']));
    assert.ok(alone.state.excludedSources.includes(state.timeline[1].id));
    assert.equal(alone.state.records.some(record => record.id === 'event:arrival'), false);
    // Mara remembers on her own as usual, whoever is away.
    assert.equal(viewerState(state, ['Mara.png'], rules(['Kit.png'])), null);
});

test('meaning recall falls back without paying for a query when no matching documents can be embedded', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    config.retrieval.mode = 'semantic';
    // The query is derived from chat, but the only recall candidate is a saved record.
    Object.assign(config.roles.embedding, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'embedding', allowedData: ['chat'] });
    saveConfig(directories, config);
    const calls = [];
    const result = await recall(directories, locator, { query: 'gift' }, { embedFn: async (_dirs, _config, inputs) => {
        calls.push(inputs);
        return { vectors: inputs.map(() => [1, 0]), usage: {} };
    } });
    assert.deepEqual(calls, []);
    assert.equal(result.inspection.retrieval.keywordFallback, true);
    assert.ok(result.selected.includes('event:gift'));
});

test('recall offers short saved memory entries, not raw chat passages, unless passages are switched on', async t => {
    const { directories, write } = disk(t);
    write([...fixture.messages, { name: 'Mara', is_user: false, send_date: 'long-reply', mes: 'The gift glints. '.repeat(600) }]);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        event(state, { text: 'Mara accepted the gift. ' + 'She turned it over in her hands. '.repeat(60) });
    });
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    Object.assign(config.roles.selector, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' });
    saveConfig(directories, config);
    const inputs = [];
    const dependencies = {
        embedFn: async () => assert.fail('No embeddings are enabled'),
        scheduleBackground: false,
        call: async (_directories, _config, role, _contract, input) => {
            inputs.push(input);
            return { value: { status: 'complete', selections: [], rejections: [], needsEvidence: [] }, usage: { role } };
        },
    };
    await recall(directories, locator, { query: 'gift' }, dependencies);
    const [input] = inputs;
    const gift = input.candidates.find(candidate => candidate.recordId === 'event:gift');
    assert.ok(gift, 'the saved entry is offered');
    assert.equal(input.candidates.filter(candidate => candidate.kind === 'source').length, 0, 'raw chat passages are not offered');
    assert.ok(gift.excerpt.length <= 801 && gift.excerpt.endsWith('…'), 'a long entry is shortened');
    assert.ok(input.candidates.every(candidate => !('currentOverviews' in candidate)), 'overviews are not repeated per candidate');
    assert.ok(input.scene.every(cue => cue.text.length <= 3001), 'long scene messages are trimmed');
    assert.ok(input.scene.reduce((total, cue) => total + cue.text.length, 0) <= 9100);
    const saved = readConfig(directories);
    saved.retrieval.includePassages = true;
    saveConfig(directories, saved);
    await recall(directories, locator, { query: 'gift' }, dependencies);
    assert.ok(inputs[1].candidates.some(candidate => candidate.kind === 'source'), 'switching passages on offers them again');
});

test('search cues can leave user messages out so every recent cue is a reply', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    config.retrieval.queryMessages = 3;
    Object.assign(config.roles.selector, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' });
    saveConfig(directories, config);
    const scenes = [];
    const dependencies = {
        embedFn: async () => assert.fail('No embeddings are enabled'),
        scheduleBackground: false,
        call: async (_directories, _config, role, _contract, input) => {
            scenes.push(input.scene);
            return { value: { status: 'complete', selections: [], rejections: [], needsEvidence: [] }, usage: { role } };
        },
    };
    await recall(directories, locator, {}, dependencies);
    assert.deepEqual(scenes[0].map(cue => cue.speaker), ['Player', 'Mara', 'Player']);
    const saved = readConfig(directories);
    assert.equal(saved.retrieval.skipUserMessages, false, 'older settings read user messages as before');
    saved.retrieval.skipUserMessages = true;
    saveConfig(directories, saved);
    await recall(directories, locator, {}, dependencies);
    assert.deepEqual(scenes[1].map(cue => cue.speaker), ['Mara', 'Narrator', 'Mara']);
    assert.throws(() => saveConfig(directories, { ...saved, retrieval: { ...saved.retrieval, skipUserMessages: 'yes' } }), /switched on or off/);
});

test('a reply that reuses a current AI pick starts no second background search', async t => {
    const { directories, write } = disk(t);
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    Object.assign(config.roles.selector, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const pick = (role, input) => {
        const candidate = input.candidates.find(item => item.recordId === 'event:gift');
        return { value: { status: 'complete', selections: candidate ? [{ recordId: candidate.recordId, relevanceType: 'direct',
            currentCueRefs: [input.scene.at(-1).id], memoryEvidenceRefs: [candidate.sourceRefs[0]], justification: 'Gift' }] : [],
        rejections: [], needsEvidence: [] }, usage: { role } };
    };
    let release;
    const held = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const counts = { scheduled: 0, fresh: 0 };
    const embedFn = async () => assert.fail('No embeddings are enabled');
    const scheduled = { embedFn, call: async (_directories, _config, role, _contract, input) => { counts.scheduled++; await held; return pick(role, input); } };
    const fresh = { embedFn, call: async (_directories, _config, role, _contract, input) => { counts.fresh++; return pick(role, input); } };
    const kept = () => {
        const state = readState(directories, locator);
        return state.timeline.map(ref => ({ ref, text: sourceAt(state, ref).text }));
    };
    const retained = kept();
    await recall(directories, locator, { query: 'gift', retained }, fresh);
    const afterSearch = await recall(directories, locator, { local: true, retained }, { ...scheduled, scheduleBackground: false });
    assert.deepEqual(afterSearch.inspection.selections, [], 'an author search must not supply the writer with an AI pick');
    await recall(directories, locator, { retained }, fresh);
    await recall(directories, locator, { query: 'unrelated gift', retained }, { ...fresh, call: async () => ({
        value: { status: 'complete', selections: [], rejections: [], needsEvidence: [] }, usage: { role: 'selector' },
    }) });
    counts.fresh = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
        const cached = await recall(directories, locator, { local: true, retained }, scheduled);
        assert.equal(cached.inspection.selections[0]?.recordId, 'event:gift', `regeneration ${attempt + 1} reuses the pick`);
    }
    assert.equal(readState(directories, locator).recalls.length, 10, 'inspection history stays bounded');
    await recallInBackground(directories, locator, { retained }, fresh);
    assert.deepEqual(counts, { scheduled: 0, fresh: 1 }, 'the cached pick still fits, so the reply scheduled nothing');
    write([...fixture.messages, { name: 'Mara', is_user: false, send_date: 'new-reply', mes: 'I kept it.' }]);
    await loadCurrentState(directories, locator);
    counts.fresh = 0;
    const next = await recall(directories, locator, { local: true, retained: kept() }, scheduled);
    assert.equal(next.inspection.selections[0]?.recordId, 'event:gift', 'the unchanged earlier prefix can supply picks for the next turn');
    const job = recallInBackground(directories, locator, { retained: kept() }, fresh);
    release();
    await job;
    assert.deepEqual(counts, { scheduled: 1, fresh: 0 }, 'a new message schedules a fresh background search');
});

test('recall inspection retains the exact selected text and neighbouring passages', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    config.retrieval.resultLimit = 1;
    config.retrieval.neighbourChunks = 1;
    saveConfig(directories, config);
    const documents = searchDocuments(readState(directories, locator), Infinity, config);
    const result = await recall(directories, locator, { query: 'gift' }, { scheduleBackground: false });
    assert.ok(result.inspection.retrieval.selected.length > 0);
    for (const id of result.inspection.retrieval.selected) {
        const candidate = result.inspection.candidates.find(item => item.id === id);
        assert.ok(candidate, 'included passages must be inspectable');
        assert.equal(candidate.text, documents.find(item => item.id === id).text);
        assert.ok(candidate.text.length > 0);
    }
    const remembered = result.inspection.candidates.find(item => item.id === 'event:gift');
    assert.ok(remembered?.text);
    mutateState(directories, locator, state => {
        state.records.find(record => record.id === 'event:gift').text = 'A later correction.';
    });
    const view = inspectState(readState(directories, locator), config);
    assert.equal(view.recalls.at(-1).candidates.find(item => item.id === 'event:gift').text, remembered.text);
    assert.notEqual(remembered.text, 'A later correction.');
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
    const progressDuringRebuild = new Map();
    registerMewmoryOperations({ embedFn: async (_dirs, _config, inputs) => {
        calls++;
        assert.equal(readState(directories, locator).index.version, '', 'the rebuilding vector space is not published partway through');
        const { completed, total } = getSavedJob(directories, first.job.id).progress;
        if (total !== null) progressDuringRebuild.set(completed, total);
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
    assert.deepEqual(getSavedJob(directories, first.job.id).progress, { completed: 81, total: 81 });
    assert.deepEqual([...progressDuringRebuild], [[32, 81], [64, 81]], 'progress counts indexed passages, including new ones in the total');
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

test('retrying a stale rebuild applies its reset only if it did not already happen', async t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.embedding, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    let paid = 0;
    registerMewmoryOperations({ embedFn: async (_dirs, _config, inputs) => {
        paid += inputs.length;
        return { vectors: inputs.map(() => [1, 0]), usage: {} };
    } });
    t.after(() => registerMewmoryOperations());
    setDirectoriesResolver(() => directories);
    const start = (key, options) => startOperation(directories, 'test', 'index', { locator, reset: true, submissionKey: key }, options);
    const initial = (await start('initial-index')).job;
    await jobRunner.runJob(initial);
    const firstCount = paid;
    assert.ok(firstCount > 0);
    const beforeReset = (await start('before-reset')).job;
    const next = (await start('retry-before', { retryOf: beforeReset.id })).job;
    await jobRunner.runJob(next);
    assert.equal(paid, firstCount * 2, 'a previously queued rebuild did not reset the index');
    const resume = (await start('retry-after', { retryOf: next.id })).job;
    assert.equal(resume.intent.reset, true);
    assert.equal((await start('retry-after', { retryOf: next.id })).job.id, resume.id);
    await jobRunner.runJob(resume);
    assert.equal(getSavedJob(directories, resume.id).state, 'completed');
    assert.equal(paid, firstCount * 2, 'an applied reset does not discard valid paid vectors on retry');
});

test('a rebuild cannot publish vectors after its saved connection profile is edited', async t => {
    const { directories } = disk(t);
    const profile = { id: 'embedding', name: 'Embeddings', api: 'custom', 'api-url': 'http://127.0.0.1:1/v1', model: 'first' };
    const writeProfile = model => writeJson(path.join(directories.root, 'settings.json'), {
        extension_settings: { connectionManager: { profiles: [{ ...profile, model }] } },
    });
    writeProfile('first');
    const config = defaultConfig();
    Object.assign(config.roles.embedding, { enabled: true, profileId: profile.id });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    registerMewmoryOperations({ embedFn: async (_dirs, _config, inputs) => {
        writeProfile('second');
        return { vectors: inputs.map(() => [1, 0]), usage: { role: 'embedding' } };
    } });
    t.after(() => registerMewmoryOperations());
    setDirectoriesResolver(() => directories);
    const { job } = await startOperation(directories, 'test', 'index', { locator, reset: true, submissionKey: 'index-profile-changed' });
    await jobRunner.runJob(job);
    assert.equal(getSavedJob(directories, job.id).state, 'failed');
    assert.deepEqual(readState(directories, locator).index.vectors, {});
    assert.equal(readArtifact(directories, job.id, 'result'), undefined);
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

test('periodic scans skip reconciling a story whose files have not changed', async t => {
    const { directories, write } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    let calls = 0;
    const call = async () => {
        calls++;
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } };
    };
    await scanProcessing(directories, call);
    await waitForProcessing(directories, locator);
    await scanProcessing(directories, call);
    const settled = calls;
    // Reconciling checks the memory file before deciding whether to rewrite it.
    const exists = t.mock.method(fs, 'existsSync');
    await scanProcessing(directories, call);
    assert.equal(exists.mock.calls.filter(entry => entry.arguments[0] === statePath(directories, locator)).length, 0);
    exists.mock.restore();
    write([...fixture.messages, { name: 'Mara', mes: 'A new message.', is_user: false }]);
    await scanProcessing(directories, call);
    const completed = await waitForProcessing(directories, locator);
    assert.ok(calls > settled);
    assert.equal(pendingSources(completed, readConfig(directories), { checkpoint: true }).length, 0);
});

test('safe start pauses interrupted processing instead of resuming it', async t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    config.autoUpdate = true;
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        state.processing = { status: 'running', automatic: true };
    });
    assert.equal(await pauseInterruptedProcessing(async () => [directories]), 1);
    const paused = readState(directories, locator).processing;
    assert.equal(paused.status, 'failed');
    assert.equal(paused.errorStatus, 503);
    assert.match(paused.error, /safe mode/);
    assert.equal(await pauseInterruptedProcessing(async () => [directories]), 0);
});

test('worker failure/retry repairs nested jobs and finish preserves concurrent index builds', async t => {
    const { directories } = disk(t, fixture.messages.slice(0, 3));
    const config = defaultConfig();
    config.autoUpdate = false;
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        state.jobs.push({ id: 'interrupted', status: 'processing' });
    });
    await startProcessing(directories, locator, {}, async () => {
        assert.equal(readState(directories, locator).jobs.find(job => job.id === 'interrupted').status, 'failed');
        throw Object.assign(new Error('Busy fixture'), { status: 503, retryAt: Date.now() + 60000 });
    });
    const failed = await waitForProcessing(directories, locator);
    assert.equal(failed.processing.status, 'failed');
    assert.equal(failed.processing.failures, 1);
    assert.equal(failed.processing.busy, true);
    assert.ok(failed.processing.retryAt > Date.now());
    assert.deepEqual(failed.coverage, {});
    assert.deepEqual(failed.checkpoints, {});
    assert.equal(failed.jobs.at(-1).status, 'failed');
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await startProcessing(directories, locator, { checkpoint: true }, async (_directories, _config, role) => {
        entered();
        await held;
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role, input: 50, output: 25 } };
    });
    await ready;
    const newerIndex = { version: 'published', pending: false, vectors: { concurrent: { textHash: 'kept', vector: [0.25, 0.5] } },
        build: { version: 'staged', owner: 'other-job', cursor: 7, vectors: { next: { vector: [0.75] } } } };
    mutateState(directories, locator, state => { state.index = structuredClone(newerIndex); });
    release();
    const complete = await waitForProcessing(directories, locator);
    assert.equal(complete.processing.status, 'complete');
    for (const key of ['failures', 'retryAt', 'busy']) assert.equal(Object.hasOwn(complete.processing, key), false);
    assert.deepEqual(complete.index, expectedCompactIndex(newerIndex));
    assert.equal(complete.jobs.at(-1).status, 'complete');
    assert.equal(complete.usage.extractor.requests, 1);
    assert.equal(complete.usage.extractor.input, 50);
    assert.equal(Object.keys(complete.checkpoints).length, 3);
});

for (const action of ['scan', 'pause']) for (const replacement of ['job', 'branch', 'removed']) {
    test(`${action} rechecks identity under the archive lock after ${replacement} replacement`, async t => {
        const { directories } = disk(t);
        const config = defaultConfig();
        config.autoUpdate = false;
        saveConfig(directories, config);
        await loadCurrentState(directories, locator);
        mutateState(directories, locator, state => {
            state.enabled = false;
            state.processing = { status: 'running', automatic: true };
        });
        const archive = statePath(directories, locator);
        const recovery = path.join(directories.root, 'mewmory', 'recovery', hash(normalizeLocator(locator)) + '.json');
        const mkdir = fs.mkdirSync;
        let replaced = false;
        let newer;
        const mock = t.mock.method(fs, 'mkdirSync', (directory, ...args) => {
            const result = mkdir(directory, ...args);
            if (!replaced && String(directory) === path.dirname(archive)) {
                replaced = true;
                if (replacement === 'removed') {
                    fs.rmSync(archive);
                    fs.rmSync(recovery);
                } else {
                    newer = JSON.parse(fs.readFileSync(archive));
                    newer.revision++;
                    if (replacement === 'branch') newer.branchId = 'replacement-branch';
                    else newer.processing.id = 'replacement-job';
                    writeJson(archive, newer);
                }
            }
            return result;
        });
        if (action === 'pause') assert.equal(await pauseInterruptedProcessing(async () => [directories]), 0);
        else await scanProcessing(directories);
        mock.mock.restore();
        assert.equal(replaced, true);
        if (replacement === 'removed') assert.equal(fs.existsSync(archive), false);
        else assert.deepEqual(readState(directories, locator), newer);
    });
}

test('cancellation rejects a revision changed before the locked write and supports absent job ids', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    const cancelled = await cancelProcessing(directories, locator);
    assert.equal(cancelled.processing.status, 'cancelled');
    assert.equal(cancelled.processing.id, undefined);
    assert.equal(typeof cancelled.processing.fingerprint, 'string');
    const config = readConfig(directories);
    const identities = Object.fromEntries(['extractor', 'pawspective'].map(role => [role, resolvedRoleIdentity(config, role)]));
    assert.equal(cancelled.processing.fingerprint, hash([sourceFingerprint(cancelled), processingVersion(config, identities),
        config.revision, cancelled.overrides, cancelled.excludedSources]));
    assert.equal(inspectState(cancelled, config).health.processing.status, 'cancelled');
    const archive = statePath(directories, locator);
    const mkdir = fs.mkdirSync;
    let changed = false;
    let archiveLocks = 0;
    const mock = t.mock.method(fs, 'mkdirSync', (directory, ...args) => {
        const result = mkdir(directory, ...args);
        if (String(directory) === path.dirname(archive)) archiveLocks++;
        // loadCurrentState reconciles first; race the second (cancellation) lock.
        if (!changed && archiveLocks === 2 && String(directory) === path.dirname(archive)) {
            changed = true;
            const newer = JSON.parse(fs.readFileSync(archive));
            newer.revision++;
            newer.processing = { id: 'new-job', status: 'running' };
            writeJson(archive, newer);
        }
        return result;
    });
    await assert.rejects(cancelProcessing(directories, locator), { status: 409 });
    mock.mock.restore();
    assert.equal(changed, true);
    assert.equal(readState(directories, locator).processing.id, 'new-job');
    assert.equal(readState(directories, locator).processing.status, 'running');
});

test('a cancelled held worker keeps concurrent vectors and publishes no partial records or progress', async t => {
    const { directories } = disk(t, fixture.messages.slice(0, 3));
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await startProcessing(directories, locator, { checkpoint: true }, async (_directories, _config, role, _contract, input) => {
        entered();
        await held;
        const source = input.sources.find(source => source.type === 'chat');
        return { value: { records: [{ id: 'event:cancelled', kind: 'event', text: 'Never publish this.',
            refs: [{ id: source.id, revision: source.revision }], evidenceStatus: 'established' }], interviews: [], activeNpcIds: [] },
        usage: { role, input: 11, output: 7 } };
    });
    await ready;
    mutateState(directories, locator, state => {
        state.index.vectors.concurrent = { textHash: 'new', vector: [0.125] };
        state.index.build = { owner: 'parallel', version: 'future', vectors: { next: { vector: [0.5] } } };
    });
    const cancelled = await cancelProcessing(directories, locator);
    const expected = readState(directories, locator);
    release();
    const final = await waitForProcessing(directories, locator);
    assert.equal(final.processing.status, 'cancelled');
    assert.equal(final.processing.fingerprint, cancelled.processing.fingerprint);
    assert.deepEqual(final.index, expected.index);
    for (const key of ['records', 'audit', 'coverage', 'checkpoints', 'rolePolicies', 'roleIdentities', 'sceneNpcIds', 'castHistory']) {
        assert.deepEqual(final[key], expected[key], key + ' must have no partial publication');
    }
    assert.equal(final.jobs.at(-1).status, 'failed');
    assert.equal(final.jobs.at(-1).usage.length, 1);
    assert.equal(final.usage.extractor.requests, 1);
    assert.equal(final.usage.extractor.input, 11);
    for (const key of ['failures', 'retryAt', 'busy']) assert.equal(Object.hasOwn(final.processing, key), false);
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
    const stories = Array.from({ length: 8 }, (_, index) => ({ ...locator, chat: `Queued ${index}` }));
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
    // Manual updates saved before a restart outnumber the worker's capacity, so draining them needs each finished job to wake the queue.
    for (const [index, story] of stories.slice(3).entries()) {
        mutateState(directories, story, state => {
            state.processing = { id: 'queued-' + index, status: 'running', all: true, checkpoint: false, automatic: false, startedAt: Date.now() };
        });
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

test('automatic updates read only the most recently written chat', async t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    config.roles.pawspective.enabled = false;
    config.autoUpdate = true;
    saveConfig(directories, config);
    const older = { ...locator, chat: 'Older chat' };
    const latest = { ...locator, chat: 'Latest chat' };
    for (const story of [older, latest]) {
        fs.copyFileSync(chatPath(directories, locator), chatPath(directories, story));
        await loadCurrentState(directories, story);
        mutateState(directories, story, state => { state.enabled = true; });
    }
    const now = Date.now() / 1000;
    fs.utimesSync(chatPath(directories, older), now - 600, now - 600);
    fs.utimesSync(chatPath(directories, latest), now, now);
    const chats = [];
    const call = async (_directories, _config, _role, _contract, input) => {
        chats.push(input.sources.find(source => source.type === 'chat')?.id);
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } };
    };
    await scanProcessing(directories, call);
    await Promise.all([older, latest].map(story => waitForProcessing(directories, story)));
    assert.ok(chats.length > 0);
    assert.equal(pendingSources(await loadCurrentState(directories, latest), config, { checkpoint: true }).length, 0);
    const untouched = await loadCurrentState(directories, older);
    assert.ok(pendingSources(untouched, config, { checkpoint: true }).length > 0);
    assert.equal(untouched.processing, undefined);
    await startProcessing(directories, older, { all: true, checkpoint: true }, call);
    assert.equal(pendingSources(await waitForProcessing(directories, older), config, { checkpoint: true }).length, 0);
});

test('a delayed worker leaves startup alone, then catches up', async t => {
    const broken = disk(t);
    const { directories } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    config.autoUpdate = true;
    saveConfig(broken.directories, config);
    fs.writeFileSync(path.join(broken.directories.root, 'mewmory', 'config.json'), '{');
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    let calls = 0;
    const call = async () => {
        calls++;
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } };
    };
    const stop = startMewmoryWorker(async () => [broken.directories, directories], call, { firstScanDelayMs: 300 });
    try {
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(calls, 0, 'no memory work during the startup grace period');
        assert.ok(!readState(directories, locator).processing);
        for (let attempt = 0; attempt < 200 && readState(directories, locator).processing?.status !== 'complete'; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(readState(directories, locator).processing?.status, 'complete', 'a damaged account must not prevent the next from catching up');
        assert.ok(calls > 0);
    } finally {
        stop();
        await waitForProcessing(directories, locator);
    }
});

test('a late previous job cannot wake the next worker during its startup grace period', async t => {
    const previous = disk(t);
    const next = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    config.autoUpdate = true;
    for (const { directories } of [previous, next]) {
        saveConfig(directories, config);
        await loadCurrentState(directories, locator);
        mutateState(directories, locator, state => { state.enabled = true; });
    }
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const previousCall = async () => {
        await hold;
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } };
    };
    await startProcessing(previous.directories, locator, { all: true, automatic: true }, previousCall);

    // Only the startup delay is fake. setImmediate stays real so a leaked wake
    // can schedule its scan during the assertion.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let scans = 0;
    let calls = 0;
    const nextCall = async () => {
        calls++;
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } };
    };
    const stop = startMewmoryWorker(async () => { scans++; return [next.directories]; }, nextCall, { firstScanDelayMs: 300 });
    const flushImmediate = () => new Promise(resolve => setImmediate(resolve));
    try {
        release();
        await waitForProcessing(previous.directories, locator);
        await flushImmediate();
        await flushImmediate();
        assert.equal(scans, 0, 'the startup grace period owns the first scan');
        assert.equal(calls, 0, 'a late job cannot start memory work during the startup grace period');

        t.mock.timers.tick(300);
        for (let attempt = 0; attempt < 20 && !readState(next.directories, locator).processing; attempt++) await flushImmediate();
        await waitForProcessing(next.directories, locator);
        assert.equal(scans, 1, 'the delayed worker scans once its grace period ends');
        assert.ok(calls > 0, 'the delayed worker catches up after startup');
    } finally {
        stop();
        t.mock.timers.reset();
        await waitForProcessing(next.directories, locator);
    }
});

test('story listings and chat reads reuse files that have not changed', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const archive = path.resolve(statePath(directories, locator));
    const chat = path.resolve(chatPath(directories, locator));
    readChatShared(directories, locator);
    listStories(directories);
    const read = t.mock.method(fs, 'readFileSync');
    const reads = filename => read.mock.calls.filter(call => path.resolve(String(call.arguments[0])) === filename).length;
    assert.equal(listStories(directories)[0].enabled, true);
    readChatShared(directories, locator);
    assert.equal(reads(archive), 0, 'an unchanged memory file is not parsed again');
    assert.equal(reads(chat), 0, 'an unchanged chat is not parsed again');
    mutateState(directories, locator, state => { state.enabled = false; });
    read.mock.resetCalls();
    assert.equal(listStories(directories)[0].enabled, false);
    assert.equal(reads(archive), 0, 'a saved change refreshes the listing without reading the file back');
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
    assert.throws(() => saveConfig(directories, invalid), /Facts and events:.*Model context size, tokens/);
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
    await assert.rejects(getCounter('auto', { tokenizerKey: 'api_current' }), /Token counter for replies/);
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

test('fallback connections answer in order after a model failure and respect each role\'s permissions', async t => {
    const { directories } = disk(t);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const remoteKey = writeSecret(directories, SECRET_KEYS.OPENAI, 'test-openai-key');
    const settings = { extension_settings: { connectionManager: { profiles: [
        { id: 'remote', name: 'Remote', api: 'openai', model: 'gpt-4o', 'secret-id': remoteKey },
        { id: 'local', name: 'Local', api: 'custom', 'api-url': provider.url, model: 'extractor' },
        { id: 'own', name: 'Own', api: 'custom', 'api-url': provider.url, model: 'extractor' },
    ] } } };
    writeJson(path.join(directories.root, 'settings.json'), settings);
    const input = { sources: [], existing: [] };
    const config = defaultConfig();
    assert.deepEqual(config.fallbackProfileIds, []);
    config.fallbackProfileIds = Array.from({ length: 11 }, (_, index) => 'profile-' + index);
    assert.throws(() => saveConfig(directories, config), /at most 10 fallback connections/);
    config.fallbackProfileIds = ['deleted', 'remote', 'local', 'local'];
    config.localOnly = true;
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'dead', timeoutMs: 1000 });
    const saved = saveConfig(directories, config);
    assert.deepEqual(saved.fallbackProfileIds, ['deleted', 'remote', 'local'], 'duplicates are dropped and the order is kept');
    const before = provider.calls.length;
    const result = await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract facts.', input);
    assert.deepEqual(result.value.records, []);
    assert.equal(result.usage.fallbackProfileId, 'local');
    assert.equal(result.usage.model, 'extractor');
    assert.equal(provider.calls.length, before + 1, 'the deleted and the remote local-only-blocked profiles are skipped');

    provider.mode.reply = { choices: [{ message: { content: 'not json' } }] };
    await assert.rejects(callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input), error => {
        assert.equal(error.status, 502);
        assert.match(error.message, /could not be reached.*The fallback connection also failed\./);
        return true;
    });
    delete provider.mode.reply;

    const tight = publicConfig(directories);
    Object.assign(tight.roles.extractor, { contextTokens: 1024, maxOutputTokens: 900 });
    saveConfig(directories, tight);
    const calls = provider.calls.length;
    await assert.rejects(callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', { text: 'long passage '.repeat(400) }), /context limit/);
    assert.equal(provider.calls.length, calls, 'a size limit is not a connection failure');

    const own = publicConfig(directories);
    Object.assign(own.roles.extractor, { profileId: 'own', endpoint: '', model: '', contextTokens: 200000, maxOutputTokens: 32000 });
    saveConfig(directories, own);
    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { connectionManager: { profiles: settings.extension_settings.connectionManager.profiles.filter(profile => profile.id !== 'own') } } });
    assert.match(readConfig(directories).roles.extractor.error, /no longer exists/);
    const rescued = await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input);
    assert.equal(rescued.usage.fallbackProfileId, 'local', 'a deleted own profile hands over to the fallbacks');
    const blocked = readConfig(directories);
    blocked.roles.extractor.allowedData = [];
    await assert.rejects(callJsonRole(directories, blocked, 'extractor', 'Extract.', input, { dataTypes: ['chat'] }), error => error.status === 403);

    const none = readConfig(directories);
    none.fallbackProfileIds = [];
    await assert.rejects(callJsonRole(directories, none, 'extractor', 'Extract.', input), error => {
        assert.equal(error.status, 409);
        assert.match(error.message, /^Facts and events: .*no longer exists/);
        return true;
    });
});

test('a busy model service is paused for as long as it asks instead of being sent more requests', async t => {
    const { directories } = disk(t);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: provider.url, model: 'extractor' });
    saveConfig(directories, config);
    const input = { sources: [], existing: [] };
    const call = () => callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input);
    Object.assign(provider.mode, { fail: true, failStatus: 429, retryAfter: 120 });
    await assert.rejects(call(), error => {
        assert.equal(error.status, 502);
        assert.match(error.message, /returned error code 429\. Mewmory will wait 2 minutes before sending it another request\./);
        assert.ok(error.retryAt >= Date.now() + 110_000);
        return true;
    });
    provider.mode.fail = false;
    const sent = provider.calls.length;
    await assert.rejects(call(), error => {
        assert.match(error.message, /is busy or rate limited, so Mewmory is pausing requests to it for 2 minutes/);
        assert.ok(error.retryAt > Date.now());
        return true;
    });
    assert.equal(provider.calls.length, sent, 'a paused service is sent nothing');
    resetServiceCooldowns();
    assert.ok((await call()).value);
    assert.equal(provider.calls.length, sent + 1);
});

test('busy pauses double while a service stays busy and end once it answers', () => {
    resetServiceCooldowns();
    const now = 1_000_000;
    assert.equal(markServiceBusy('service', 0, now), now + 30_000);
    assert.equal(markServiceBusy('service', 0, now + 30_000), now + 90_000, 'a second busy answer waits a minute');
    assert.equal(serviceBusyUntil('service', now + 60_000), now + 90_000);
    markServiceWorking('service');
    assert.equal(serviceBusyUntil('service', now + 60_000), 0);
    assert.equal(parseRetryAfter('7'), 7000);
    assert.equal(parseRetryAfter(new Date(now + 45_000).toUTCString(), now), 45_000);
    assert.equal(parseRetryAfter('soon'), 0);
    assert.equal(markServiceBusy('other', 30 * 60_000, now), now + 30 * 60_000, 'a longer Retry-After is honoured');
});

test('a saved main connection that refuses or stalls hands over to the fallbacks and names the reason', async t => {
    const { directories } = disk(t);
    const broken = await createMewmoryProvider();
    const working = await createMewmoryProvider();
    t.after(async () => {
        for (const provider of [broken, working]) {
            provider.server.closeAllConnections();
            await new Promise(resolve => provider.server.close(resolve));
        }
    });
    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { connectionManager: { profiles: [
        { id: 'main', name: 'Main', api: 'custom', 'api-url': broken.url, model: 'extractor' },
        { id: 'spare', name: 'Spare', api: 'custom', 'api-url': working.url, model: 'extractor' },
    ] } } });
    const config = defaultConfig();
    config.fallbackProfileIds = ['spare'];
    Object.assign(config.roles.extractor, { enabled: true, profileId: 'main', timeoutMs: 1000 });
    saveConfig(directories, config);
    const input = { sources: [], existing: [] };
    broken.mode.fail = true;
    for (const status of [400, 401, 403, 404, 429, 500]) {
        broken.mode.failStatus = status;
        const result = await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract facts.', input);
        assert.equal(result.usage.fallbackProfileId, 'spare', 'error code ' + status + ' from the main connection moves on');
    }
    resetServiceCooldowns(); // The 429 above paused the main connection; start the next check after that wait.

    broken.mode.failStatus = 400;
    working.mode.fail = true;
    working.mode.failStatus = 400;
    await assert.rejects(callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input), error => {
        assert.equal(error.status, 502);
        assert.match(error.message, /^The model for Facts and events returned error code 400 \(Fixture provider unavailable\)\. Check its model connection in Mewmory settings and try again\. The fallback connection also failed\.$/);
        return true;
    });
    working.mode.fail = false;

    broken.mode.fail = false;
    broken.mode.hold = 'extractor';
    const stalled = await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input);
    assert.equal(stalled.usage.fallbackProfileId, 'spare', 'a main connection past its timeout moves on');
    broken.mode.hold = '';

    const controller = new AbortController();
    broken.mode.hold = 'extractor';
    const before = working.calls.length;
    const cancelled = callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(cancelled, error => error.name === 'AbortError' || error.status === 499);
    assert.equal(working.calls.length, before, 'a cancelled request does not try the fallbacks');
    broken.mode.hold = '';

    broken.mode.fail = true;
    const unusable = publicConfig(directories);
    unusable.fallbackProfileIds = ['gone'];
    saveConfig(directories, unusable);
    await assert.rejects(callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input), error => {
        assert.equal(error.status, 502);
        assert.match(error.message, /returned error code 400.*Your fallback connection could not be used: gone \(The chosen connection profile no longer exists/);
        return true;
    });
});

test('model roles start their reply with the saved prefill, and Kimi K3 connections use the partial prefill', async t => {
    const { directories } = disk(t);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { connectionManager: { profiles: [
        { id: 'kimi', name: 'Kimi', api: 'custom', 'api-url': provider.url, model: 'kimi-k3' },
    ] } } });
    const config = defaultConfig();
    assert.equal(config.roles.extractor.prefill, '');
    assert.equal(config.roles.extractor.partialPrefill, '');
    assert.equal('prefill' in config.roles.embedding, false, 'the embedding role does not write replies');
    Object.assign(config.roles.extractor, {
        enabled: true, endpoint: provider.url, model: 'plain-model',
        prefill: '{"records": ', partialPrefill: '<think>Only JSON.</think>{"records": ',
    });
    saveConfig(directories, config);
    const saved = readConfig(directories).roles.extractor;
    assert.equal(saved.prefill, '{"records": ');
    assert.equal(saved.partialPrefill, '<think>Only JSON.</think>{"records": ');
    const fingerprint = roleVersion(readConfig(directories), 'extractor');
    provider.mode.reply = () => ({ choices: [{ message: { content: '[], "interviews": []}' } }] });
    const input = { sources: [], existing: [] };

    const plain = await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input);
    assert.deepEqual(plain.value, { records: [], interviews: [] }, 'the prefill is joined back onto the continuation');
    assert.deepEqual(provider.calls.at(-1).messages.at(-1), { role: 'assistant', content: '{"records": ' });

    const kimi = publicConfig(directories);
    Object.assign(kimi.roles.extractor, { model: 'kimi-k3' });
    saveConfig(directories, kimi);
    const partial = await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input);
    assert.deepEqual(partial.value, { records: [], interviews: [] });
    const sent = provider.calls.at(-1).messages.at(-1);
    assert.equal(sent.role, 'assistant');
    assert.equal(sent.partial, true);
    assert.equal(sent.content, '{"records": ', 'the reasoning block moves out of the visible reply');
    assert.equal(sent.reasoning_content, 'Only JSON.');

    const blankPartial = publicConfig(directories);
    blankPartial.roles.extractor.partialPrefill = '   ';
    saveConfig(directories, blankPartial);
    await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input);
    assert.equal(provider.calls.at(-1).messages.at(-1).partial, true, 'a blank partial prefill falls back to Prefill');
    assert.equal(provider.calls.at(-1).messages.at(-1).content, '{"records": ');

    const echoed = publicConfig(directories);
    Object.assign(echoed.roles.extractor, { model: 'plain-model', partialPrefill: '' });
    saveConfig(directories, echoed);
    provider.mode.reply = () => ({ choices: [{ message: { content: '{"records": [], "interviews": []}' } }] });
    const repeated = await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input);
    assert.deepEqual(repeated.value, { records: [], interviews: [] }, 'a model that repeats the prefill is not doubled');

    const followsFallback = publicConfig(directories);
    Object.assign(followsFallback.roles.extractor, { endpoint: 'http://127.0.0.1:1/v1', timeoutMs: 1000, partialPrefill: '{"records": ' });
    followsFallback.fallbackProfileIds = ['kimi'];
    saveConfig(directories, followsFallback);
    provider.mode.reply = () => ({ choices: [{ message: { content: '[], "interviews": []}' } }] });
    const fallback = await callJsonRole(directories, readConfig(directories), 'extractor', 'Extract.', input);
    assert.equal(fallback.usage.fallbackProfileId, 'kimi');
    assert.deepEqual(fallback.value, { records: [], interviews: [] });
    assert.equal(provider.calls.at(-1).messages.at(-1).partial, true, 'a Kimi K3 fallback uses the partial prefill');

    const untouched = publicConfig(directories);
    delete untouched.roles.extractor.prefill;
    delete untouched.roles.extractor.partialPrefill;
    saveConfig(directories, untouched);
    assert.equal(readConfig(directories).roles.extractor.prefill, '{"records": ', 'a save that predates prefills keeps them');
    const longPrefill = publicConfig(directories);
    longPrefill.roles.extractor.prefill = 'x'.repeat(10001);
    assert.throws(() => saveConfig(directories, longPrefill), /Facts and events: Prefill must be text of at most 10,000 characters\./);

    const edited = publicConfig(directories);
    Object.assign(edited.roles.extractor, { endpoint: provider.url, model: 'plain-model', prefill: 'Different start ', partialPrefill: 'Other' });
    saveConfig(directories, edited);
    assert.equal(roleVersion(readConfig(directories), 'extractor'), fingerprint, 'editing a prefill keeps processed memories current');
});

test('a connection profile for all roles drives every role that follows it without changing processing fingerprints', async t => {
    const { directories } = disk(t);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { connectionManager: { profiles: [
        { id: 'main', name: 'Main', api: 'custom', 'api-url': provider.url, model: 'extractor' },
        { id: 'other', name: 'Other', api: 'custom', 'api-url': provider.url, model: 'pawspective' },
    ] } } });
    const config = defaultConfig();
    assert.equal(config.sharedProfileId, '');
    assert.equal(config.roles.extractor.useShared, false);
    assert.equal('useShared' in config.roles.embedding, false, 'embeddings never follow the shared profile');
    config.roles.extractor.enabled = true;
    config.roles.extractor.useShared = true;
    assert.throws(() => saveConfig(directories, config), /^Error: Facts and events: Choose a connection profile for all roles/);

    const own = defaultConfig();
    Object.assign(own.roles.extractor, { enabled: true, profileId: 'main' });
    saveConfig(directories, own);
    const ownVersion = processingVersion(readConfig(directories));
    const ownRole = roleVersion(readConfig(directories), 'extractor');

    const shared = publicConfig(directories);
    Object.assign(shared, { sharedProfileId: 'main', sharedModelOverride: '' });
    Object.assign(shared.roles.extractor, { useShared: true, profileId: '' });
    Object.assign(shared.roles.pawspective, { enabled: true, useShared: true });
    shared.roles.embedding.useShared = true;
    const saved = saveConfig(directories, shared);
    assert.equal(saved.roles.extractor.useShared, true);
    assert.equal(saved.roles.extractor.profileId, '', 'the role keeps its own choice for switching back');
    assert.equal('useShared' in saved.roles.embedding, false);
    const resolved = readConfig(directories);
    assert.equal(resolved.roles.extractor.profileId, 'main');
    assert.equal(resolved.roles.pawspective.model, 'extractor');
    assert.equal('useShared' in resolved.roles.extractor, false);
    assert.equal(roleVersion(resolved, 'extractor'), ownRole, 'following the shared profile matches choosing it directly');
    assert.equal(publicConfig(directories).roles.pawspective.model, 'extractor');
    const result = await callJsonRole(directories, resolved, 'pawspective', 'Interview.', { sources: [], existing: [] });
    assert.equal(result.usage.model, 'extractor');

    const switched = publicConfig(directories);
    Object.assign(switched, { sharedProfileId: 'other', sharedModelOverride: 'override-model' });
    saveConfig(directories, switched);
    const moved = readConfig(directories);
    assert.equal(moved.roles.extractor.model, 'override-model');
    assert.equal(moved.roles.pawspective.model, 'override-model', 'changing the shared profile moves every following role together');
    assert.notEqual(processingVersion(moved), ownVersion);

    const back = publicConfig(directories);
    Object.assign(back, { sharedProfileId: 'main', sharedModelOverride: '' });
    Object.assign(back.roles.pawspective, { enabled: false, useShared: false });
    saveConfig(directories, back);
    assert.equal(roleVersion(readConfig(directories), 'extractor'), ownRole, 'returning to the same model restores the same coverage');
    const bare = defaultConfig();
    delete bare.roles.extractor.useShared;
    assert.equal(roleVersion(defaultConfig(), 'extractor'), roleVersion(bare, 'extractor'), 'the new setting alone never changes a fingerprint');

    const configPath = path.join(directories.root, 'mewmory', 'config.json');
    const handEdited = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    handEdited.sharedProfileId = '';
    writeJson(configPath, handEdited);
    assert.match(readConfig(directories).roles.extractor.error, /Choose a connection profile for all roles/);

    const legacy = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete legacy.sharedProfileId;
    delete legacy.sharedModelOverride;
    for (const role of Object.values(legacy.roles)) delete role.useShared;
    writeJson(configPath, legacy);
    const upgraded = publicConfig(directories);
    assert.equal(upgraded.sharedProfileId, '');
    assert.equal(upgraded.roles.extractor.useShared, false);
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

test('malformed memory dependencies and interview turns are validation errors', () => {
    const state = base();
    const refs = [state.timeline[0]];
    assert.throws(() => validateRecord(state, { id: 'event:invalid', kind: 'event', refs,
        text: 'Mara accepted the gift.', dependencies: [null] }),
    { status: 400, message: 'Dependency is in the wrong format.' });
    assert.throws(() => validateRecord(state, { id: 'interview:invalid', kind: 'interview', ownerId: 'npc:mara',
        subjectIds: ['gift'], refs, interview: [null] }),
    { status: 400, message: 'Interview turn is in the wrong format.' });
});

/** Marks the given chat records as fully read by Mewmory, as a finished extraction would. */
function rememberMessages(directories, locator, records) {
    mutateState(directories, locator, state => {
        syncSources(state, records.slice(1), []);
        const version = processingVersion(readConfig(directories));
        for (const ref of state.timeline) state.checkpoints[refKey(ref)] = version;
    });
}

test('preservation planning does not clone index vectors', () => {
    const state = base();
    const config = defaultConfig();
    config.roles.extractor.enabled = true;
    const version = processingVersion(config);
    for (const ref of state.timeline) state.checkpoints[refKey(ref)] = version;
    state.index.vectors = Array.from({ length: 4096 }, () => ({ vector: [1, 2, 3] }));
    state.index.vectors[0].sentinel = () => {};
    const records = [{ chat_metadata: {} }, ...structuredClone(fixture.messages)];
    assert.deepEqual(planPreservedOverflowHiding(records, state, config, fixture.lore, {}, [0, 1]), [0, 1]);
});

test('preservation planners match full archive cloning across reconciliation changes', () => {
    const config = defaultConfig();
    config.roles.extractor.enabled = true;
    config.recentMessages = 1;
    config.historyBatchMessages = 2;
    const state = base();
    const version = processingVersion(config);
    for (const ref of state.timeline) {
        state.checkpoints[refKey(ref)] = version;
        state.coverage[refKey(ref)] = version;
    }
    const anchor = event(state);
    anchor.inputRefs = [state.timeline[0], state.timeline[2]];
    const dependent = event(state, { id: 'event:dependent', refs: [state.timeline[3]], asOf: 3,
        dependencies: [{ id: anchor.id, version: anchor.version }] });
    state.audit.push({ recordId: dependent.id, before: structuredClone(dependent) });
    const original = structuredClone(state);
    const records = [{ chat_metadata: {} }, ...structuredClone(fixture.messages)];
    const edited = structuredClone(records);
    edited[1].mes += ' edited';
    const editedInput = structuredClone(records);
    editedInput[3].mes += ' edited input';
    const deleted = records.filter((_, index) => index !== 3);
    const context = structuredClone(fixture.lore);
    context[0].text += ' changed';
    const nativeClone = globalThis.structuredClone;
    const outcome = fn => {
        try { return { value: fn() }; } catch (error) { return { error: error.constructor.name }; }
    };
    for (const [input, lore] of [[records, fixture.lore], [edited, fixture.lore], [editedInput, fixture.lore],
        [deleted, fixture.lore], [records, context]]) {
        for (const checkpoint of [true, false]) {
            config.excludeHistory = checkpoint;
            for (const planner of [
                () => planPreservedMessageHiding(input, state, config, lore),
                () => planPreservedOverflowHiding(input, state, config, lore, {}, [0, 1, 2]),
            ]) {
                const actual = outcome(planner);
                assert.equal(actual.error, undefined, 'valid archive must reconcile successfully');
                globalThis.structuredClone = () => nativeClone(state);
                let expected;
                try { expected = outcome(planner); } finally { globalThis.structuredClone = nativeClone; }
                assert.deepEqual(actual, expected);
            }
        }
    }
    assert.deepEqual(planPreservedOverflowHiding(editedInput, state, config, fixture.lore, {}, [0, 1, 2]), [],
        'editing a later input invalidates coverage from its earlier batch input');
    assert.deepEqual(state, original);
    config.roles.extractor.enabled = false;
    assert.deepEqual(planPreservedOverflowHiding(records, state, config, fixture.lore, {}, [0, 1]), [0, 1]);
});

test('automatic hiding fails closed when an edited archive has a malformed index', t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    saveConfig(directories, config);
    const records = [{ chat_metadata: {} }, ...structuredClone(fixture.messages)];
    mutateState(directories, locator, state => {
        syncSources(state, records.slice(1), []);
        state.enabled = true;
    });
    const filename = statePath(directories, locator);
    const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    state.index = null;
    writeJson(filename, state);
    records[1].mes += ' edited';
    const warning = t.mock.method(console, 'warn', () => {});
    const result = applyOverflowHiding(records, { limit: 1, count: text => text.length, directories, locator });
    assert.equal(result.hidden, 0);
    assert.equal(result.records, records);
    assert.match(warning.mock.calls[0].arguments.join(' '), /Automatic hiding was skipped:.*pending/);
});

test('malformed preservation indexes retain full clone failure behaviour', () => {
    const config = defaultConfig();
    config.roles.extractor.enabled = true;
    const records = [{ chat_metadata: {} }, ...structuredClone(fixture.messages)];
    const nativeClone = globalThis.structuredClone;
    for (const malformed of [undefined, null, 1, 'invalid']) {
        const state = base();
        if (malformed === undefined) delete state.index;
        else state.index = malformed;
        const edited = structuredClone(records);
        edited[1].mes += ' edited';
        for (const planner of [
            () => planPreservedMessageHiding(edited, state, config, fixture.lore),
            () => planPreservedOverflowHiding(edited, state, config, fixture.lore, {}, [0, 1]),
        ]) {
            const outcome = () => { try { return { value: planner() }; } catch (error) { return { error: error.constructor.name }; } };
            const actual = outcome();
            globalThis.structuredClone = () => nativeClone(state);
            let expected;
            try { expected = outcome(); } finally { globalThis.structuredClone = nativeClone; }
            assert.deepEqual(actual, expected);
            assert.equal(actual.error, 'TypeError');
        }
    }
});

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

test('preparing a reply with Mewmory off does not write an archive or require Mewmory settings', async t => {
    const { directories } = disk(t);
    const configPath = path.join(directories.root, 'mewmory', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{');
    const filename = statePath(directories, locator);
    assert.equal((await prepareMewmoryPrompt(directories, { locator })).enabled, false);
    assert.equal(fs.existsSync(filename), false);
    await assert.rejects(prepareMewmoryPrompt(directories, { locator, mewmoryWaitSnapshot: 'previous' }), /turned off/);
    mutateState(directories, locator, state => { state.enabled = false; });
    fs.writeFileSync(filename, '{');
    assert.equal((await prepareMewmoryPrompt(directories, { locator })).enabled, false, 'the recovery check confirms this chat is off');
    assert.equal(fs.readFileSync(filename, 'utf8'), '{', 'preparing a reply must not overwrite the damaged archive');
});

test('a reply without history is answered or asked to resend it', async t => {
    const { directories } = disk(t);
    saveConfig(directories, { ...defaultConfig(), writerTokenizer: 'o200k_base' });
    mutateState(directories, locator, state => { state.enabled = true; }, 0);
    assert.deepEqual(await prepareMewmoryPrompt(directories, { locator, historyOmitted: true }), {
        enabled: true, needsHistory: true,
    }, 'an enabled chat asks for the history rather than failing on it');
    mutateState(directories, locator, state => { state.enabled = false; });
    assert.equal((await prepareMewmoryPrompt(directories, { locator, historyOmitted: true })).enabled, false,
        'a disabled chat still answers without the history');
});

test('server automatic hiding skips disabled settings and keeps the latest reply visible', async t => {
    const { directories } = disk(t);
    const locator = { chat: 'Gift', avatar: 'Mara.png', group: false };
    saveConfig(directories, { ...defaultConfig(), autoHide: false, writerTokenizer: 'o200k_base' });
    assert.equal(await prepareAutomaticHiding(directories, locator), null);
    saveConfig(directories, { ...readConfig(directories), autoHide: true, writerTokenizer: 'o200k_base' });
    assert.equal(await prepareAutomaticHiding(directories, locator), null, 'Mewmory is still off for this chat');
    mutateState(directories, locator, state => { state.enabled = true; }, 0);
    const policy = await prepareAutomaticHiding(directories, locator);
    assert.equal(policy.limit, defaultConfig().autoHideTokens);
    const records = [{ chat_metadata: {} }, { is_user: true, mes: 'o'.repeat(20) },
        { is_user: false, mes: 'r'.repeat(20) }, { is_user: true, mes: 'later' }];
    rememberMessages(directories, locator, records);
    const lengthPolicy = limit => ({ limit, count: text => text.length, directories, locator });
    const hidden = applyOverflowHiding(records, lengthPolicy(15));
    assert.deepEqual(hidden.records.map(record => record.is_system ?? false), [false, true, false, false]);
    assert.equal(hidden.records[1].extra.mewmoryKeepHidden, true);
    assert.equal(hidden.records[2].mes, 'r'.repeat(20));
    assert.equal(hidden.hidden, 1);
    assert.equal(applyOverflowHiding(records, lengthPolicy(1000)).records, records);
});

test('token hiding keeps messages Mewmory has not finished reading in the prompt', async t => {
    const { directories } = disk(t);
    const locator = { chat: 'Gift', avatar: 'Mara.png', group: false };
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    saveConfig(directories, { ...config, autoUpdate: false, autoHide: true, writerTokenizer: 'o200k_base' });
    mutateState(directories, locator, state => { state.enabled = true; }, 0);
    const records = [{ chat_metadata: {} },
        { is_user: true, send_date: 'one', mes: 'a'.repeat(20) },
        { is_user: false, send_date: 'two', mes: 'b'.repeat(20) },
        { is_user: true, send_date: 'three', mes: 'c'.repeat(20) },
        { is_user: false, send_date: 'four', mes: 'latest reply' }];
    const policy = { limit: 15, count: text => text.length, directories, locator };
    assert.equal(applyOverflowHiding(records, policy).hidden, 0, 'nothing is hidden before Mewmory reads it');

    rememberMessages(directories, locator, records.slice(0, 3));
    const partial = applyOverflowHiding(records, policy);
    assert.equal(partial.hidden, 2, 'only the remembered run is hidden');
    assert.deepEqual(partial.records.map(record => record.is_system ?? false), [false, true, true, false, false]);

    const edited = structuredClone(records);
    edited[1].mes = 'an agent rewrote this after Mewmory read it';
    assert.equal(applyOverflowHiding(edited, policy).hidden, 0, 'a rewritten message must be read again first');

    rememberMessages(directories, locator, records);
    assert.equal(applyOverflowHiding(records, policy).hidden, 3);
});

test('token hiding does not wait for reading when the Facts and events reader is off', async t => {
    const { directories } = disk(t);
    const locator = { chat: 'Gift', avatar: 'Mara.png', group: false };
    const config = defaultConfig();
    config.roles.extractor.enabled = false;
    saveConfig(directories, { ...config, autoHide: true, writerTokenizer: 'o200k_base' });
    mutateState(directories, locator, state => { state.enabled = true; }, 0);
    const records = [{ chat_metadata: {} },
        { is_user: true, send_date: 'one', mes: 'a'.repeat(20) },
        { is_user: false, send_date: 'two', mes: 'latest reply' }];
    const policy = { limit: 15, count: text => text.length, directories, locator };
    assert.equal(applyOverflowHiding(records, policy).hidden, 1, 'nothing would ever be read, so waiting would never end');
});

test('automatic hiding rechecks settings, tokenizer choice, threshold and chat state at the write', async t => {
    const { directories } = disk(t);
    const locator = { chat: 'Gift', avatar: 'Mara.png', group: false };
    saveConfig(directories, { ...defaultConfig(), autoHide: true, autoHideTokens: 1024, writerTokenizer: 'cl100k_base' });
    mutateState(directories, locator, state => { state.enabled = true; }, 0);
    const policy = await prepareAutomaticHiding(directories, locator);
    assert.equal(policy.limit, 1024);
    const records = () => [{ chat_metadata: {} }, { is_user: true, mes: 'old ' + 'word '.repeat(3000) },
        { is_user: false, mes: 'latest reply' }];
    rememberMessages(directories, locator, records());
    assert.equal(applyOverflowHiding(records(), policy).hidden, 1);

    saveConfig(directories, { ...readConfig(directories), autoHide: false });
    assert.equal(applyOverflowHiding(records(), policy).hidden, 0, 'a disabled switch cannot apply a stale policy');

    saveConfig(directories, { ...readConfig(directories), autoHide: true, autoHideTokens: 200000 });
    assert.equal(applyOverflowHiding(records(), policy).hidden, 0, 'a raised threshold cannot apply a stale policy');

    saveConfig(directories, { ...readConfig(directories), autoHideTokens: 1024, writerTokenizer: 'o200k_base' });
    assert.equal(applyOverflowHiding(records(), policy).hidden, 0, 'a changed writer tokenizer cannot apply a stale policy');

    saveConfig(directories, { ...readConfig(directories), writerTokenizer: 'cl100k_base' });
    mutateState(directories, locator, state => { state.enabled = false; });
    assert.equal(applyOverflowHiding(records(), policy).hidden, 0, 'a chat switched off while loading cannot apply');
});

test('server automatic hiding uses the actual OpenRouter metadata and provider-specific text model tokenizers', async () => {
    const openRouter = { backend: 'chat', source: 'openrouter', preset: {},
        profile: { model: 'meta-llama/llama-3.3-70b-instruct' },
        active: { chat_completion_source: 'openrouter', openrouter_model: 'meta-llama/llama-3.3-70b-instruct' } };
    assert.equal(await writerTokenizerFromMaterial(openRouter, { models: [{ id: 'meta-llama/llama-3.3-70b-instruct',
        architecture: { tokenizer: 'Llama3' } }] }), 'llama3');

    const text = { backend: 'text', source: 'openrouter', active: { model: 'generic-llama3-model' },
        profile: { model: 'google/gemma-3-27b-it' }, power: { tokenizer: 99 } };
    assert.equal(await writerTokenizerFromMaterial(text), 'gemma');
});

test('server automatic hiding resolves Text Completion OpenAI and saved Kobold or Horde writer tokenizers', async () => {
    const textOpenAI = { backend: 'text', source: 'llamacpp', profile: { model: 'gpt-4o' }, power: { tokenizer: 2 } };
    const textOpenAITokenizer = await writerTokenizerFromMaterial(textOpenAI);
    assert.equal(textOpenAITokenizer, 'gpt-4o');
    assert.equal((await getCounter(textOpenAITokenizer)).name, 'gpt-4o');

    for (const [backend, source] of [['kobold', 'kobold'], ['horde', 'koboldhorde']]) {
        const legacy = { backend, source, profile: { model: 'saved-model' }, power: { tokenizer: 1 } };
        const tokenizer = await writerTokenizerFromMaterial(legacy);
        assert.equal(tokenizer, 'gpt2', backend + ' must keep the saved GPT2 tokenizer');
        assert.equal((await getCounter(tokenizer)).name, 'gpt2');
    }
});

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
    assert.ok(input.sources[0].text.startsWith(message.mes));
    assert.equal(input.sources[0].storyText, undefined, 'the story text is sent once, inside text');
    assert.equal(input.sources[0].trackerOutputs, undefined, 'tracker notes are sent once, labelled inside text');
    assert.match(input.sources[0].text, /brass key/);
    assert.match(input.sources[0].text, /Location: north gate/);
    assert.doesNotMatch(input.sources[0].text, /Wrong|Unfinished|Failed|tracker-none|Imagined|Rejected/);
    applyExtraction(state, { records: [{ id: 'state:inventory', kind: 'state', entityId: 'npc:mara',
        text: 'Mara has a brass key with her at the north gate.', refs: state.timeline }], activeNpcIds: [] }, input);
    assert.equal(eligibleRecords(state).length, 1);
    const sources = searchDocuments(state).filter(document => document.kind === 'source');
    assert.deepEqual(sources.map(document => document.text), [message.mes], 'source passages carry only the story text');
    const hits = lexicalSearch(searchDocuments(state), 'brass key', 10).map(hit => hit.document);
    assert.deepEqual(hits.map(hit => hit.kind), ['state']);
    const recalled = assembleContext(state, [...hits, ...sources], { counter }).memoryText;
    assert.match(recalled, /Mara has a brass key with her at the north gate\./);
    assert.match(recalled, /She closes the bag\./);
    assert.doesNotMatch(recalled, /Tracker output|carries the brass key|Location: north gate/, 'tracker notes reach the writer only as restated records');
    assert.match(EXTRACTION_CONTRACT, /Restate what a tracker reports in your own plain wording/);

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

// The extractor sees tracker output only as the labelled section at the end of the chat text.
function trackerSection(source) {
    return source.text.split(/\[Tracker output: [^\]]*\]\n/)[1]?.trim();
}

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
        const tracker = trackerSection(refs[0]);
        return { value: { records: tracker ? [{ id: 'state:inventory', kind: 'state', entityId: 'npc:mara',
            text: tracker, refs }] : [], activeNpcIds: [] }, usage: { role: 'extractor' } };
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
        text: trackerSection(input.sources[0]), refs: input.sources }], activeNpcIds: [] }, usage: { role: 'extractor' } });
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
    assert.throws(() => saveConfig(directories, { ...current, autoHideTokens: 100 }), /Hide older messages at this chat size, tokens/);
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

test('a deleted message purges its source copies, dependent memories, vectors and undo history', async () => {
    const state = base();
    const memory = event(state);
    putRecord(state, { ...memory, text: 'This correction mentions the gift.', authorOverride: true });
    const config = defaultConfig();
    config.roles.embedding.enabled = true;
    const embedFn = async (_directories, _config, texts) => ({ vectors: texts.map(() => [1]), usage: {} });
    await updateIndex(state, {}, config, { embedFn, limit: 100 });
    const kept = state.index.vectors['entity:mara'];
    const version = state.index.version;
    const removedPassages = searchDocuments(state).filter(item => item.kind === 'source' && item.refs[0].id === memory.refs[0].id);
    assert.ok(removedPassages.length);
    state.index.build = { version: 'another-model', vectors: { ...state.index.vectors } };
    syncSources(state, fixture.messages.filter((_, index) => index !== 2), fixture.lore);
    assert.deepEqual(state.sources[memory.refs[0].id].revisions, []);
    assert.equal(state.sources[memory.refs[0].id].active, false);
    assert.equal(state.records.some(record => record.id === memory.id), false);
    assert.equal(state.audit.some(entry => entry.recordId === memory.id), false);
    assert.equal(state.index.version, version);
    assert.deepEqual(state.index.vectors['entity:mara'], kept);
    assert.deepEqual(state.index.build.vectors['entity:mara'], kept);
    for (const id of [memory.id, ...removedPassages.map(item => item.id)]) {
        assert.equal(state.index.vectors[id], undefined);
        assert.equal(state.index.build.vectors[id], undefined);
    }
});

test('recall-only indexing does not mark the searchable archive ready without source vectors', async () => {
    const state = base();
    const config = defaultConfig();
    config.roles.embedding.enabled = true;
    const embedFn = async (_directories, _config, texts) => ({ vectors: texts.map(() => [1]), usage: {} });
    await updateIndex(state, {}, config, { embedFn, recallOnly: true, limit: 100 });
    assert.ok(state.index.vectors['entity:mara']);
    assert.equal(inspectState(state, config).health.indexStatus, 'building');
    await updateIndex(state, {}, config, { embedFn, limit: 100 });
    assert.equal(inspectState(state, config).health.indexStatus, 'ready');
});

test('the extractor gets slim existing records, brief entries for absent characters and a shortened card it already read', () => {
    const state = base();
    const card = 'Mara keeps a harbour shop and never forgets a debt. '.repeat(60);
    syncSources(state, structuredClone(fixture.messages), [...fixture.lore,
        { id: 'character:mara', type: 'character', entityId: 'npc:mara', name: 'Mara', text: card, enabled: true }]);
    putRecord(state, validateRecord(state, {
        id: 'entity:oren', kind: 'entity', entityId: 'npc:oren', name: 'Oren', text: 'Oren runs the lighthouse far up the coast and writes long letters to his sister.',
        isCharacter: true, appearance: 'Tall, grey beard.', speech: 'Slow and warm.', refs: [state.timeline[0]], subjectIds: ['npc:oren'],
    }, { asOf: 0, origin: 'objective_extractor' }), { automatic: true });
    event(state);
    const input = extractionInput(state, state.timeline.slice(0, 3), 2, false);
    const mara = input.existing.find(item => item.entityId === 'npc:mara');
    const oren = input.existing.find(item => item.entityId === 'npc:oren');
    assert.equal(mara.appearance, fixture.expectations.appearance);
    assert.equal(mara.brief, undefined);
    assert.equal(oren.brief, true);
    assert.equal(oren.appearance, undefined);
    assert.ok(oren.text.length <= 201);
    for (const item of input.existing) {
        for (const field of ['refs', 'provenance', 'inputRefs', 'createdAt', 'storyId']) assert.equal(item[field], undefined, field);
    }
    const cardSource = input.sources.find(source => source.id === 'character:mara');
    assert.equal(cardSource.shortened, true);
    assert.ok(cardSource.text.length <= 1501);
    for (const source of input.sources) assert.equal(source.hash, undefined);
});

test('a correction flags earlier reads instead of erasing them, so only new messages are read automatically', () => {
    const state = base();
    const config = defaultConfig();
    const policy = processingVersion(config);
    for (const ref of state.timeline) state.coverage[refKey(ref)] = state.checkpoints[refKey(ref)] = policy;
    const memory = event(state);
    putRecord(state, { ...memory, text: 'Author: Mara accepted the gift slowly.', authorOverride: true });
    assert.ok(Object.values(state.checkpoints).every(value => value === READ_EARLIER));
    assert.equal(Object.keys(state.checkpoints).length, state.timeline.length);
    assert.equal(pendingSources(state, config, { checkpoint: true }).length, state.timeline.length);
    assert.equal(pendingSources(state, config, { checkpoint: true, unreadOnly: true }).length, 0);
    const { health } = inspectState(state, config);
    assert.equal(health.pending, 0);
    assert.equal(health.rereadPending, state.timeline.length);
    assert.equal(health.preservedThrough, state.timeline.length - 1);
    syncSources(state, [...structuredClone(fixture.messages), { name: 'Mara', send_date: 'later', mes: 'Mara wraps the receipt in silk.' }], fixture.lore);
    assert.deepEqual(pendingSources(state, config, { checkpoint: true, unreadOnly: true }).map(refKey), [refKey(state.timeline.at(-1))]);
});

test('correcting a memory reads again only the messages behind memories built on it', () => {
    const state = base();
    const config = defaultConfig();
    const policy = processingVersion(config);
    for (const ref of state.timeline) state.coverage[refKey(ref)] = state.checkpoints[refKey(ref)] = policy;
    const memory = event(state);
    const view = event(state, { id: 'event:gift-view', refs: [state.timeline[3]], asOf: 3, text: 'Mara now trusts the gift a little.', dependencies: [{ id: memory.id, version: memory.version }] });
    view.inputRefs = [{ id: state.timeline[3].id, revision: state.timeline[3].revision }];
    putRecord(state, { ...memory, authorOverride: true });
    assert.equal(pendingSources(state, config, { checkpoint: true, unreadOnly: true }).length, 0);
    putRecord(state, { ...memory, text: 'Author: Mara accepted the gift slowly.', authorOverride: true });
    assert.deepEqual(pendingSources(state, config, { checkpoint: true, unreadOnly: true }).map(refKey), [refKey(state.timeline[3])]);
});

test('correcting a memory reads again the messages an interview built on it came from', () => {
    const state = base();
    const config = defaultConfig();
    const policy = processingVersion(config);
    for (const ref of state.timeline) state.coverage[refKey(ref)] = state.checkpoints[refKey(ref)] = policy;
    const memory = event(state);
    event(state, { id: 'event:gift-view', refs: [state.timeline[3]], asOf: 3, text: 'Mara now trusts the gift a little.', dependencies: [{ id: memory.id, version: memory.version }] });
    putRecord(state, { ...memory, text: 'Author: Mara accepted the gift slowly.', authorOverride: true });
    assert.deepEqual(pendingSources(state, config, { checkpoint: true, unreadOnly: true }).map(refKey), [refKey(state.timeline[3])]);
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
    assert.match(inspection.operationsError, /server owner needs to repair the saved job list/);
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
    assert.ok(result.memoryText.includes('Imaginary interview, outside the story'));
    assert.ok(result.memoryText.includes('Character: Mara'));
    assert.ok(result.memoryText.includes('Subjects: Unidentified subject'));
    assert.equal(result.memoryText.includes('SEARCH ONLY'), false);
    assert.equal(hash(state), before, 'retrieval never increases significance or rewrites a dossier');
    assert.ok(result.npcText.includes(fixture.expectations.appearance));
    assert.ok(result.interviewText.includes(fixture.expectations.current_view));
    assert.ok(result.interviewText.includes(current.interview[0].answer));
    assert.equal(result.interviewText.includes(fixture.expectations.appearance), false);
    assert.ok(result.factsText.startsWith(result.npcText));
    assert.equal(result.factsText.includes(current.interview[0].answer), false);
    assert.equal(result.factsText.includes('Imaginary interview, outside the story'), false);
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
    const config = defaultConfig();
    Object.assign(config.roles.pawspective, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    saveConfig(directories, config);
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
    assert.equal(result.memoryText.match(/\[Current character viewpoint(?:;|\])/g)?.length, 1);
    assert.ok(result.memoryText.includes('[Earlier character viewpoint'));
    assert.ok(result.memoryText.includes(fixture.expectations.original_view));
    assert.ok(result.memoryText.includes(fixture.expectations.current_view));
    assert.ok(result.memoryText.indexOf(fixture.expectations.current_view) < result.memoryText.indexOf(fixture.expectations.original_view));
    const past = assembleContext(state, [old], { counter, asOf: 2 });
    assert.equal(past.memoryText.includes(fixture.expectations.current_view), false);
    assert.ok(past.memoryText.includes('[Current character viewpoint'));
});

test('writer references omit generated record identities while retaining private provenance', () => {
    const { state } = giftHistory();
    const document = searchDocuments(state).find(item => item.kind === 'overview' && item.asOf === 2);
    const sourceId = document.recordId;
    const result = assembleContext(state, [document], { counter });
    assert.ok(sourceId, 'the private selected record retains an identity');
    assert.ok(state.records.some(record => record.id === sourceId && record.refs.length));
    assert.equal(result.memoryText.includes(sourceId), false);
    assert.doesNotMatch(result.memoryText, /Sources:|as of message \d+|characters \d+-\d+/);
    assert.ok(result.memoryText.includes(fixture.expectations.original_view));
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

test('evidence expansion attaches the original passage to the requested record instead of offering it as a candidate', async t => {
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
    const inputs = [];
    await recall(directories, locator, {}, { call: async (_directories, _config, role, _contract, input) => {
        inputs.push(structuredClone(input));
        if (inputs.length === 1) {
            return { value: { status: 'needs_evidence', selections: [], rejections: [], needsEvidence: [input.candidates[0].recordId] }, usage: { role } };
        }
        return { value: { status: 'complete', selections: [], rejections: [], needsEvidence: [] }, usage: { role } };
    } });
    assert.equal(inputs.length, 2);
    for (const input of inputs) assert.equal(input.candidates.some(candidate => candidate.kind === 'source'), false, 'chat passages are never candidates');
    const requested = inputs[1].candidates.find(candidate => candidate.recordId === inputs[0].candidates[0].recordId);
    assert.deepEqual(requested.evidence?.map(item => item.text), ['The sigil']);
    assert.equal(inputs[1].candidates.filter(candidate => candidate.evidence).length, 1, 'only the requested record receives evidence');
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
    assert.equal(state.jobs.at(-1).status, 'superseded', 'a chat edit restarts the update instead of reporting a failure');
    assert.equal(state.jobs.at(-1).error, undefined);
});

test('an agent rewriting the newest reply mid-extraction restarts the update quietly with the new text', async t => {
    const messages = structuredClone(fixture.messages.slice(0, 3));
    const { directories, write } = disk(t, messages);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    config.roles.pawspective.enabled = false;
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const seen = [];
    const call = async (_directories, _config, role, _contract, input) => {
        const chat = input.sources.filter(source => source.type === 'chat');
        seen.push(chat.at(-1).text);
        if (seen.length === 1) {
            messages[2].mes = 'Mara accepts the gift, rewritten by a post-generation agent.';
            write(messages);
        }
        return { value: { records: [{ id: 'event:accepted', kind: 'event', text: 'The gift was accepted.', subjectIds: ['gift'],
            refs: [{ id: chat.at(-1).id, revision: chat.at(-1).revision }], evidenceStatus: 'established' }], interviews: [], activeNpcIds: [] },
        usage: { role } };
    };
    await startProcessing(directories, locator, { all: true }, call);
    const state = await waitForProcessing(directories, locator);
    assert.equal(state.processing.status, 'complete');
    assert.equal(state.processing.error, '');
    assert.equal(seen.length, 2);
    assert.match(seen[1], /rewritten by a post-generation agent/);
    assert.deepEqual(state.jobs.map(job => job.status), ['superseded', 'complete']);
    assert.equal(pendingSources(state, readConfig(directories)).length, 0);
    assert.equal(eligibleRecords(state).filter(record => record.id === 'event:accepted').length, 1);
});

test('a reply rewritten after the batch range does not discard the batch', async t => {
    const messages = structuredClone(fixture.messages.slice(0, 3));
    const { directories, write } = disk(t, messages);
    const config = defaultConfig();
    config.batchMessages = 2;
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const state = await processBatch(directories, locator, {}, async (_directories, _config, role, _contract, input) => {
        const chat = input.sources.filter(source => source.type === 'chat');
        assert.equal(chat.length, 2);
        messages[2].mes = 'A later reply rewritten while the earlier messages were being read.';
        write(messages);
        return { value: { records: [{ id: 'event:gift', kind: 'event', text: 'The player brought a gift.', subjectIds: ['gift'],
            refs: [{ id: chat.at(-1).id, revision: chat.at(-1).revision }], evidenceStatus: 'established' }], interviews: [], activeNpcIds: [] },
        usage: { role } };
    });
    assert.equal(state.jobs.at(-1).status, 'complete');
    assert.equal(eligibleRecords(state).filter(record => record.id === 'event:gift').length, 1);
    assert.equal(pendingSources(state, readConfig(directories)).length, 1);
});

test('editing a lorebook entry the batch never read keeps its finished result, editing one it read discards it', async t => {
    const messages = structuredClone(fixture.messages.slice(0, 3));
    const { directories } = disk(t, messages);
    const book = { entries: {
        1: { comment: 'Gifts', content: 'A gift in the harbour city is always accepted.', key: ['gift'] },
        2: { comment: 'Desert', content: 'Dunes, quasars.', key: ['dune'] },
    } };
    const bookFile = path.join(directories.worlds, 'Atlas.json');
    writeJson(bookFile, book);
    writeJson(path.join(directories.root, 'settings.json'), { world_info: { globalSelect: ['Atlas'] } });
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const extract = edit => async (_directories, _config, role, _contract, input) => {
        const lore = input.sources.filter(source => source.type === 'lore');
        assert.deepEqual(lore.map(source => source.text.includes('harbour city')), [true], 'only the matching entry is read');
        edit();
        writeJson(bookFile, book);
        const chat = input.sources.filter(source => source.type === 'chat');
        return { value: { records: [{ id: 'event:gift', kind: 'event', text: 'The player brought Mara a gift.', subjectIds: ['gift'],
            refs: [{ id: chat.at(-1).id, revision: chat.at(-1).revision }], evidenceStatus: 'established' }], interviews: [], activeNpcIds: [] },
        usage: { role } };
    };
    let state = await processBatch(directories, locator, {}, extract(() => { book.entries[2].content = 'Dunes, quasars, mirage.'; }));
    assert.equal(state.jobs.at(-1).status, 'complete', 'an unread entry changing must not waste the paid-for result');
    assert.equal(eligibleRecords(state).filter(record => record.id === 'event:gift').length, 1);
    assert.equal(pendingSources(state, readConfig(directories)).length, 0);

    mutateState(directories, locator, current => { current.coverage = {}; });
    await assert.rejects(processBatch(directories, locator, {}, extract(() => { book.entries[1].content = 'A gift in the harbour city is never accepted.'; })), /discarded/);
    state = readState(directories, locator);
    assert.equal(state.jobs.at(-1).status, 'superseded');
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
    assert.deepEqual(state.index.vectors.concurrent, { textHash: 'kept', vectorF32LE: 'AACAPw==' });
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
        if (change === 'author correction') assert.equal(state.records.find(record => record.id === 'event:gift').text, 'Author correction survives.');
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
        call.messages[0].content.includes('in two to four sentences. Ground every answer in a specific supplied event') && call.messages[0].content.includes('at most one brief narrated action')));
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
    assert.ok(result.memoryText.includes('Mara reconsidered the gift after reading its receipt.'));
    assert.ok(result.memoryText.includes('Mara accepted the gift.'));
    assert.ok(result.memoryText.indexOf('Mara reconsidered the gift after reading its receipt.') < result.memoryText.indexOf('Mara accepted the gift.'));
    assert.doesNotMatch(result.memoryText, /event:receipt|event:gift/);
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

test('background recall survives an agent rewriting a reply after the messages it read, and the next reply reuses its picks', async t => {
    const messages = structuredClone(fixture.messages);
    const { directories, write } = disk(t, messages);
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    Object.assign(config.roles.selector, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const asOf = messages.length - 2;
    let calls = 0;
    const call = async (_directories, _config, role, _contract, input) => {
        calls++;
        messages.at(-1).mes = 'You kept it? (rewritten by a post-generation agent, pass ' + calls + ')';
        write(messages);
        const candidate = input.candidates.find(candidate => candidate.recordId === 'event:gift');
        return { value: { status: 'complete', selections: [{ recordId: candidate.recordId, relevanceType: 'direct',
            currentCueRefs: [input.scene.at(-1).id], memoryEvidenceRefs: [candidate.sourceRefs[0]], justification: 'The gift comes up.' }],
        rejections: [], needsEvidence: [] }, usage: { role } };
    };
    await recallInBackground(directories, locator, { asOf }, { call });
    assert.equal(calls, 1, 'a rewrite after asOf must not force another pick');
    const state = readState(directories, locator);
    assert.ok(state.recalls.at(-1).background);
    assert.equal(state.recalls.at(-1).sourceCount, asOf + 1);
    const next = await recall(directories, locator, { asOf, local: true }, { call, scheduleBackground: false });
    assert.equal(next.inspection.selections[0]?.recordId, 'event:gift');
    assert.ok(next.memoryText.includes('Mara accepted the gift.'));
});

test('background recall picks again once when a message it read changes mid-pick', async t => {
    const messages = structuredClone(fixture.messages);
    const { directories, write } = disk(t, messages);
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    Object.assign(config.roles.selector, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const scenes = [];
    const call = async (_directories, _config, role, _contract, input) => {
        scenes.push(input.scene.at(-1).text);
        if (scenes.length === 1) {
            messages.at(-1).mes = 'You kept it all this time?';
            write(messages);
        }
        const candidate = input.candidates.find(candidate => candidate.recordId === 'event:gift');
        return { value: { status: 'complete', selections: [{ recordId: candidate.recordId, relevanceType: 'direct',
            currentCueRefs: [input.scene.at(-1).id], memoryEvidenceRefs: [candidate.sourceRefs[0]], justification: 'The gift comes up.' }],
        rejections: [], needsEvidence: [] }, usage: { role } };
    };
    await recallInBackground(directories, locator, {}, { call });
    assert.equal(scenes.length, 2);
    assert.match(scenes[1], /all this time/);
    const state = readState(directories, locator);
    assert.equal(state.recalls.at(-1).status, 'complete');
    assert.equal(state.recalls.at(-1).selections[0].recordId, 'event:gift');
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
    resetServiceCooldowns(); // The 503 above paused this service; continue as if the wait has passed.
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

test('library changes skip unrelated damaged archives and can delete a damaged archive owned by the deleted card', async t => {
    const { directories } = disk(t);
    const unrelated = { ...locator, avatar: 'Other.png' };
    const damaged = { ...locator, chat: 'Damaged' };
    for (const target of [locator, unrelated, damaged]) mutateState(directories, target, state => { state.enabled = true; });
    for (const target of [unrelated, damaged]) fs.writeFileSync(statePath(directories, target), '{damaged');
    const next = { ...locator, avatar: 'Renamed.png' };
    const before = readState(directories, locator).storyId;
    const undo = renameCharacterMemory(directories, locator.avatar, next.avatar);
    assert.equal(readState(directories, next).storyId, before);
    undo();
    removeSourceMemory(directories, { avatar: locator.avatar, deleteChats: true });
    assert.equal(fs.existsSync(statePath(directories, locator)), false);
    assert.equal(fs.existsSync(statePath(directories, damaged)), false);
    assert.equal(fs.readFileSync(statePath(directories, unrelated), 'utf8'), '{damaged');
});

test('an unreadable shared catalogue does not prevent deletion of the selected private archive', t => {
    const { directories } = disk(t);
    const other = { ...locator, chat: 'Other story' };
    for (const target of [locator, other]) mutateState(directories, target, state => { state.enabled = true; });
    const shared = path.join(directories.root, 'mewmory', 'shared.json');
    fs.writeFileSync(shared, '{damaged');
    removeChatMemory(directories, locator);
    assert.equal(fs.existsSync(statePath(directories, locator)), false);
    assert.equal(fs.existsSync(statePath(directories, other)), true);
    assert.equal(fs.readFileSync(shared, 'utf8'), '{damaged');
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

test('archive inspection sorts, filters by flag and message range, and counts memories not yet looked at', () => {
    const state = base();
    event(state);
    event(state, { id: 'event:late', text: 'Mara read the date on the receipt.', refs: [state.timeline[5]], asOf: 5 });
    const config = defaultConfig();
    const ids = filters => inspectState(state, config, { kind: 'objective', ...filters }).records.map(record => record.id);
    assert.deepEqual(ids({}), ['event:late', 'event:gift', 'entity:mara']);
    assert.deepEqual(ids({ sort: 'oldest' }), ['entity:mara', 'event:gift', 'event:late']);
    assert.deepEqual(ids({ sort: 'not-a-sort' }), ids({}), 'an unknown sort falls back to story order');
    assert.deepEqual(ids({ fromMessage: 3, toMessage: 3 }), ['event:gift']);
    assert.deepEqual(ids({ fromMessage: 4 }), ['event:late']);
    assert.deepEqual(ids({ toMessage: 1 }), ['entity:mara']);
    assert.deepEqual(ids({ flag: 'pinned' }), []);
    assert.equal(inspectState(state, config).review.fresh, 3);
    const gift = state.records.find(record => record.id === 'event:gift');
    putRecord(state, { ...gift, pinned: true, origin: 'author', authorOverride: true });
    assert.deepEqual(ids({ flag: 'pinned' }), ['event:gift']);
    assert.deepEqual(ids({ flag: 'edited' }), ['event:gift']);
    assert.deepEqual(ids({ sort: 'pinned' }), ['event:gift', 'event:late', 'entity:mara']);
    assert.deepEqual(ids({ flag: 'new' }), ['event:late', 'entity:mara'], 'a memory the author changed is not new');
    state.reviewedAt = Date.now() + 1;
    assert.deepEqual(ids({ flag: 'new' }), []);
    assert.deepEqual(inspectState(state, config).review, { reviewedAt: state.reviewedAt, fresh: 0, uncertain: 0 });
    const branch = forkState(state, { ...locator, chat: 'Branch' }, 5, fixture.messages);
    assert.equal(branch.reviewedAt, state.reviewedAt, 'a branch does not re-list memories already looked at');
});

test('archive routes change several memories in one write, show earlier versions, and combine near-duplicates', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        event(state);
        event(state, { id: 'event:twin', text: 'Mara accepted the gift!', refs: [state.timeline[3]], asOf: 3 });
        event(state, { id: 'event:late', text: 'Mara read the date on the receipt.', refs: [state.timeline[5]], asOf: 5 });
    });
    const express = (await import('express')).default;
    const { router, duplicateGroups } = await import('../src/endpoints/mewmory.js');
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => { request.user = { directories }; next(); });
    app.use(router);
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const post = async (route, body = {}) => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/' + route, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locator, revision: readState(directories, locator).revision, ...body }),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    const saved = id => readState(directories, locator).records.find(record => record.id === id);

    const pinned = await post('record/action', { ids: ['event:gift', 'event:late', 'event:gift'], action: 'pin_on', filters: { flag: 'pinned' } });
    assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
    assert.deepEqual(pinned.body.records.map(record => record.id), ['event:late', 'event:gift'], 'the reply honours the filters the page is showing');
    assert.equal((await post('record/action', { ids: ['event:gift'], action: 'pin_on' })).status, 200);
    assert.equal(saved('event:gift').pinned, true, 'pinning twice leaves it pinned');

    const before = readState(directories, locator).revision;
    const partial = await post('record/action', { ids: ['event:late', 'event:missing'], action: 'exclude_on' });
    assert.equal(partial.status, 404);
    assert.equal(saved('event:late').excluded, false, 'one missing memory stops the whole change');
    assert.equal(readState(directories, locator).revision, before);
    assert.equal((await post('record/action', { ids: [], action: 'pin_on' })).status, 400);
    assert.equal((await post('record/action', { ids: ['event:late'], action: 'pin_on', revision: before - 1 })).status, 409);

    const history = await post('record/history', { id: 'event:late' });
    assert.equal(history.status, 200);
    assert.equal(history.body.current.pinned, true);
    assert.equal(history.body.versions.length, 1);
    assert.equal(Boolean(history.body.versions[0].record.pinned), false);
    assert.equal((await post('record/history', { id: 'event:missing' })).status, 404);

    assert.ok((await post('inspect')).body.review.fresh > 0);
    const seen = await post('review/seen');
    assert.equal(seen.status, 200);
    assert.equal(seen.body.review.fresh, 0);
    assert.ok(readState(directories, locator).reviewedAt > 0, 'the looked-at time is saved with the chat');

    const groups = (await post('duplicates')).body.groups;
    assert.deepEqual(groups.map(group => group.map(record => record.id)), [['event:twin', 'event:gift']]);
    assert.equal((await post('record/merge', { keep: 'event:gift', ids: ['event:gift'] })).status, 400);
    const merged = await post('record/merge', { keep: 'event:gift', ids: ['event:gift', 'event:twin'] });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    const state = readState(directories, locator);
    assert.deepEqual(saved('event:gift').refs.map(ref => ref.id).sort(), [state.timeline[2].id, state.timeline[3].id].sort());
    assert.equal(saved('event:gift').asOf, 3);
    assert.equal(saved('event:gift').pinned, true);
    assert.equal(saved('event:twin').status, 'invalidated');
    assert.deepEqual(duplicateGroups(state), []);
    assert.equal((await post('record/merge', { keep: 'event:gift', ids: ['event:twin'] })).status, 409, 'a retired memory cannot be combined again');
    assert.equal((await post('record/action', { id: 'event:twin', action: 'undo' })).status, 200);
    assert.equal(saved('event:twin').status, 'active', 'undo brings the retired copy back');
});

test('a chat message lists the memories made from it and the memories given to its reply', async t => {
    const messages = structuredClone(fixture.messages).map((message, index) => ({ ...message, mewmory_id: 'message-' + index }));
    const { directories } = disk(t, messages);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        event(state);
        event(state, { id: 'event:late', text: 'Mara read the date on the receipt.', refs: [state.timeline[5]], asOf: 5 });
    });
    const { messageMemories, router } = await import('../src/endpoints/mewmory.js');
    const state = readState(directories, locator);
    const third = messageMemories(state, { messageId: 'message-2', used: ['event:late', 'event:late', 'event:gone'] });
    assert.equal(third.index, 2);
    assert.equal(third.sourceId, state.timeline[2].id);
    assert.deepEqual(third.made.map(record => record.id), ['event:gift']);
    assert.deepEqual(third.used.map(record => record.id), ['event:late'], 'repeated ids are listed once');
    assert.equal(third.missing, 1, 'memories deleted since the reply are counted, not invented');
    assert.equal(third.excluded, false);
    assert.equal(messageMemories(state, { index: 5 }).made[0].id, 'event:late', 'older chats without ids fall back to the position');
    assert.throws(() => messageMemories(state, { messageId: 'message-99', index: 40 }), error => error.status === 404);
    assert.equal(messageMemories(state, { messageId: 'message-1', index: 5 }).index, 1, 'the id wins over a stale position');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => { request.user = { directories }; next(); });
    app.use(router);
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const post = async (route, body = {}) => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/' + route, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locator, revision: readState(directories, locator).revision, ...body }),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    const before = readState(directories, locator).revision;
    const found = await post('message', { messageId: 'message-2', index: 2, used: ['event:late'] });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.deepEqual(found.body.made.map(record => record.id), ['event:gift']);
    assert.equal(readState(directories, locator).revision, before, 'looking at a message changes nothing');

    const forgotten = await post('source/exclude', { id: found.body.sourceId, exclude: true, filters: { flag: 'pinned' } });
    assert.equal(forgotten.status, 200);
    assert.deepEqual(forgotten.body.records, [], 'the reply honours the filters the page is showing');
    const after = await post('message', { messageId: 'message-2' });
    assert.equal(after.body.excluded, true);
    assert.equal(after.body.made[0].eligible, false, 'memories that rest on a forgotten message are no longer used');
});

test('a daily token limit pauses automatic updates but keeps today\'s total across chats', async t => {
    const { recordSpend, spendStatus, spendToday, dayKey, SPEND_DAYS } = await import('../src/mewmory/spend.js');
    const { directories } = disk(t);
    const config = defaultConfig();
    assert.equal(config.dailyTokenLimit, 0, 'no limit unless someone sets one');
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    saveConfig(directories, { ...config, dailyTokenLimit: 100 });
    assert.equal(readConfig(directories).dailyTokenLimit, 100);
    saveConfig(directories, { ...readConfig(directories), dailyTokenLimit: undefined });
    assert.equal(readConfig(directories).dailyTokenLimit, 100, 'a save that leaves the limit out keeps it');
    assert.throws(() => saveConfig(directories, { ...readConfig(directories), dailyTokenLimit: -1 }));

    const now = new Date(2026, 10, 12, 9).getTime();
    recordSpend(directories, { role: 'extractor', input: 60, output: 10 }, now);
    recordSpend(directories, { role: 'selector', input: 30, output: 5 }, now);
    recordSpend(directories, { role: 'extractor', input: 999, output: 999, cached: true }, now);
    assert.deepEqual(spendToday(directories, now), {
        requests: 2, input: 90, output: 15,
        roles: { extractor: { requests: 1, input: 60, output: 10 }, selector: { requests: 1, input: 30, output: 5 } },
    }, 'cached answers cost nothing, and each job keeps its own share');
    const status = spendStatus(directories, readConfig(directories), now);
    assert.equal(status.day, dayKey(now));
    assert.equal(status.used, 105);
    assert.equal(status.reached, true);
    assert.deepEqual(spendToday(directories, now + 86_400_000), { requests: 0, input: 0, output: 0, roles: {} }, 'a new day starts from zero');
    for (let day = 1; day <= SPEND_DAYS + 3; day++) recordSpend(directories, { input: 1, output: 0 }, now + day * 86_400_000);
    const ledger = JSON.parse(fs.readFileSync(path.join(directories.root, 'mewmory', 'usage.json'), 'utf8'));
    assert.equal(Object.keys(ledger.days).length, SPEND_DAYS, 'old days are dropped');
});

test('automatic updates wait once the daily limit is reached, and pressed buttons still run', async t => {
    const { recordSpend } = await import('../src/mewmory/spend.js');
    const { directories } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    saveConfig(directories, { ...config, dailyTokenLimit: 50 });
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    recordSpend(directories, { role: 'extractor', input: 40, output: 20 });
    let calls = 0;
    const call = async () => { calls++; return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } }; };
    await scanProcessing(directories, call);
    assert.equal(calls, 0, 'the background scan does not start over the limit');
    assert.notEqual(readState(directories, locator).processing?.status, 'running');

    await startProcessing(directories, locator, { all: true, checkpoint: true }, call);
    const manual = await waitForProcessing(directories, locator);
    assert.equal(manual.processing.status, 'complete');
    assert.ok(calls > 0, 'an update the user starts is not blocked');

    saveConfig(directories, { ...readConfig(directories), dailyTokenLimit: 0 });
    const { estimateUpdate } = await import('../src/endpoints/mewmory.js');
    const estimate = await estimateUpdate(directories, readState(directories, locator), readConfig(directories), { checkpoint: true });
    assert.equal(estimate.messages, 0, 'nothing is left once the manual update read everything');
    assert.equal(estimate.overLimit, false);
});

test('the update estimate counts waiting messages, requests and past use', async t => {
    const { estimateUpdate } = await import('../src/endpoints/mewmory.js');
    const { directories } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test', tokenizer: 'o200k_base' });
    saveConfig(directories, { ...config, batchMessages: 3, dailyTokenLimit: 100 });
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const fresh = await estimateUpdate(directories, readState(directories, locator), readConfig(directories), { checkpoint: false });
    assert.equal(fresh.messages, fixture.messages.length);
    assert.equal(fresh.batches, Math.ceil(fixture.messages.length / 3));
    assert.ok(fresh.messageTokens > 0);
    assert.equal(fresh.average, null, 'no guess before the first update');
    assert.equal(fresh.tokens, null);
    assert.equal(fresh.enabled, true);
    mutateState(directories, locator, state => { state.usage = { extractor: { requests: 4, input: 4000, output: 400, milliseconds: 10 } }; });
    const known = await estimateUpdate(directories, readState(directories, locator), readConfig(directories), { checkpoint: false });
    assert.deepEqual(known.average, { input: 1000, output: 100 });
    assert.equal(known.tokens, known.batches * 1100);
    assert.equal(known.overLimit, true, 'the estimate warns when the update would pass the daily limit');
});

test('Markdown export and lorebook entries list usable memories only', async () => {
    const { exportMarkdown, loreEntries } = await import('../src/mewmory/markdown.js');
    const state = base(fixture.messages);
    event(state);
    event(state, { id: 'event:retired', text: 'Mara refused the gift.', status: 'invalidated' });
    knowledge(state, { id: 'knowledge:receipt' });
    const markdown = exportMarkdown(state, { title: 'Mewmory: Gift', exportedAt: new Date(2026, 10, 12).getTime() });
    assert.match(markdown, /^# Mewmory: Gift\n/);
    assert.match(markdown, /Exported 2026-11-12 from Mewmory\./);
    assert.match(markdown, /## Characters, places and things/);
    assert.match(markdown, /### Mara/);
    assert.match(markdown, /## What happened\n\n- Mara accepted the gift\. _\(message 3/);
    assert.doesNotMatch(markdown, /refused/, 'retired memories stay out');
    assert.ok(markdown.endsWith('\n') && !markdown.endsWith('\n\n'));
    assert.match(exportMarkdown({ ...state, records: [] }, { title: 'Empty' }), /No memories yet\./);

    const entries = loreEntries(state);
    const mara = entries.find(entry => entry.id === 'entity:mara');
    assert.equal(mara.title, 'Mara');
    assert.ok(mara.keys.includes('Mara'));
    assert.match(mara.content, /Speech: Clipped, formal sentences\./);
    assert.ok(entries.some(entry => entry.id === 'event:gift' && entry.title.startsWith('Event: ')));
    assert.ok(!entries.some(entry => entry.id === 'event:retired'));
    assert.match(entries.find(entry => entry.id === 'knowledge:receipt').content, /^Mara knows: /);
});

test('memories sent to a lorebook are never read back in as lore', async t => {
    const { directories } = disk(t);
    writeJson(path.join(directories.worlds, 'Old.json'), { entries: {
        1: { comment: 'Harbour', content: 'The harbour freezes in winter.', key: ['harbour'] },
        2: { comment: 'Event: Mara accepted', content: 'Mara accepted the gift.', key: ['gift'], mewmoryRecordId: 'event:gift' },
    } });
    writeJson(path.join(directories.root, 'settings.json'), { world_info: { globalSelect: ['Old'] } });
    const state = await loadCurrentState(directories, locator);
    const lore = Object.values(state.sources).filter(source => source.type === 'lore');
    assert.equal(lore.length, 1);
    assert.match(lore[0].revisions.at(-1).text, /harbour freezes/);
});

test('the story view recaps events, lists open promises, maps connections and gathers one character', async () => {
    const { storyRecap, openPromises, relationshipMap, characterPage } = await import('../src/mewmory/story.js');
    const state = base();
    const put = input => {
        const record = validateRecord(state, input, { asOf: input.asOf ?? 2, origin: 'objective_extractor' });
        putRecord(state, record, { automatic: true });
        return record;
    };
    put({ id: 'entity:player', kind: 'entity', entityId: 'player', name: 'Kit', isCharacter: false, text: 'The visitor.', refs: [state.timeline[1]], asOf: 1 });
    event(state);
    event(state, { id: 'event:old', text: 'Mara opened the door.', refs: [state.timeline[1]], asOf: 1 });
    event(state, { id: 'event:quiet', text: 'Mara tidied the shelf.', refs: [state.timeline[3]], asOf: 3, status: 'background' });
    put({ id: 'commitment:return', kind: 'commitment', text: 'Mara promised to return the favour.', subjectIds: ['npc:mara'], triggerTerms: ['favour'], refs: [state.timeline[3]], asOf: 3 });
    put({ id: 'commitment:done', kind: 'commitment', text: 'Mara promised tea.', subjectIds: ['npc:mara'], refs: [state.timeline[2]], status: 'resolved' });
    put({ id: 'relationship:wary', kind: 'relationship', text: 'Mara is wary of Kit.', subjectIds: ['npc:mara', 'player'], evidenceStatus: 'established', refs: [state.timeline[2]] });
    knowledge(state);

    const recap = storyRecap(state);
    assert.deepEqual(recap.events.map(item => item.id), ['event:old', 'event:gift']);
    assert.equal(recap.total, 2);
    assert.equal(recap.events[1].message, 3);
    assert.equal(storyRecap(state, { limit: 1 }).events.length, 1);

    const promises = openPromises(state);
    assert.deepEqual(promises.promises.map(item => item.id), ['commitment:return']);
    assert.deepEqual(promises.promises[0].triggerTerms, ['favour']);

    const map = relationshipMap(state);
    assert.deepEqual(map.nodes.map(node => node.id).sort(), ['npc:mara', 'player']);
    assert.equal(map.links.length, 1);
    assert.deepEqual([map.links[0].a, map.links[0].b], ['npc:mara', 'player']);
    assert.equal(map.links[0].records[0].id, 'relationship:wary');

    const page = characterPage(state, 'npc:mara');
    assert.equal(page.name, 'Mara');
    assert.equal(page.sheet.speech, 'Clipped, formal sentences.');
    assert.deepEqual(page.knows.map(item => item.id), ['knowledge:gift']);
    assert.deepEqual(page.relationships.map(item => item.id), ['relationship:wary']);
    assert.ok(page.promises.some(item => item.id === 'commitment:return'));
    assert.equal(characterPage(state, 'npc:nobody').sheet, null);
});

test('story and character routes are read-only', async t => {
    const { directories } = disk(t, fixture.messages);
    await loadCurrentState(directories, locator);
    await mutateState(directories, locator, state => {
        state.enabled = true;
        putRecord(state, validateRecord(state, {
            id: 'entity:mara', kind: 'entity', entityId: 'npc:mara', name: 'Mara', isCharacter: true, text: 'A careful host.', refs: [state.timeline[0]],
        }, { asOf: 0, origin: 'objective_extractor' }), { automatic: true });
        event(state);
    });
    const express = (await import('express')).default;
    const { router } = await import('../src/endpoints/mewmory.js');
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.user = { directories }; next(); });
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    t.after(() => server.close());
    await new Promise(resolve => server.once('listening', resolve));
    const post = (route, body) => fetch('http://127.0.0.1:' + server.address().port + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locator, ...body }),
    });
    const before = readState(directories, locator).revision;
    const story = await (await post('/story', {})).json();
    assert.deepEqual(story.recap.events.map(item => item.id), ['event:gift']);
    assert.ok(Array.isArray(story.promises.promises));
    assert.ok(Array.isArray(story.map.nodes));
    const page = await (await post('/character', { entityId: 'npc:mara' })).json();
    assert.equal(page.name, 'Mara');
    assert.equal(page.sheet.id, 'entity:mara');
    assert.equal((await post('/character', {})).status, 400);
    assert.equal(readState(directories, locator).revision, before);
});

test('Ask Mewmory answers from cited memories and the contradiction check pairs known records', async () => {
    const { askMemories, findConflicts } = await import('../src/mewmory/ask.js');
    const state = base(fixture.messages);
    event(state);
    event(state, { id: 'event:refused', refs: [state.timeline[3]], text: 'Mara refused the gift.', asOf: 3 });
    const config = defaultConfig();
    const calls = [];
    const answer = await askMemories({}, state, config, 'What did Mara do with the gift?', {
        call: async (_directories, _config, role, _contract, input, options) => {
            calls.push({ role, input, options });
            return { value: { answer: 'She accepted it.', citations: ['event:gift', 'event:gift', 'made-up'], unsure: false }, usage: {} };
        },
    });
    assert.equal(calls[0].role, 'extractor');
    assert.deepEqual(calls[0].options.dataTypes, ['memory']);
    assert.ok(calls[0].input.memories.some(item => item.id === 'event:gift'));
    assert.equal(answer.answer, 'She accepted it.');
    assert.deepEqual(answer.citations.map(item => item.id), ['event:gift']);
    assert.equal(answer.unsure, false);
    await assert.rejects(askMemories({}, state, config, '  ', { call: async () => assert.fail('no call') }), /Type a question/);
    await assert.rejects(askMemories({}, state, config, 'Why?', { call: async () => ({ value: { answer: '' } }) }), /empty answer/);
    const empty = await askMemories({}, newState(locator), config, 'Anything?', { call: async () => assert.fail('no call') });
    assert.equal(empty.unsure, true);
    assert.equal(empty.checked, 0);

    const conflicts = await findConflicts({}, state, config, {
        call: async () => ({ value: { conflicts: [
            { a: 'event:gift', b: 'event:refused', explanation: 'Accepted and refused.' },
            { a: 'event:refused', b: 'event:gift', explanation: 'Same pair again.' },
            { a: 'event:gift', b: 'event:gift', explanation: 'Itself.' },
            { a: 'event:gift', b: 'ghost', explanation: 'Unknown.' },
        ] }, usage: {} }),
    });
    assert.equal(conflicts.conflicts.length, 1);
    assert.deepEqual([conflicts.conflicts[0].a.id, conflicts.conflicts[0].b.id], ['event:gift', 'event:refused']);
    assert.equal(conflicts.conflicts[0].explanation, 'Accepted and refused.');
});

test('memories shared from one chat can be brought into another chat with the same character', async t => {
    const { shareRecords, listShared, bringShared, removeShared, characterSources } = await import('../src/mewmory/shared.js');
    const { directories } = disk(t, fixture.messages);
    const { write: writeCard } = await import('../src/character-card-parser.js');
    const png = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));
    fs.writeFileSync(path.join(directories.characters, 'Mara.png'), writeCard(png, JSON.stringify({ name: 'Mara', description: 'A careful host.' })));
    let first = await loadCurrentState(directories, locator);
    assert.ok(characterSources(first).length, 'the fixture chat has a character card');
    await mutateState(directories, locator, state => { state.enabled = true; event(state); });
    first = readState(directories, locator);
    const shared = shareRecords(directories, first, ['event:gift'], { chat: 'Gift' });
    assert.equal(shared.shared, 1);
    assert.throws(() => shareRecords(directories, first, []), /Tick at least one/);
    assert.equal(listShared(directories, first).mine.length, 1);
    assert.equal(listShared(directories, first).available.length, 0);

    const other = { ...locator, chat: 'Second' };
    fs.copyFileSync(path.join(directories.chats, 'Mara', 'Gift.jsonl'), path.join(directories.chats, 'Mara', 'Second.jsonl'));
    const second = await loadCurrentState(directories, other);
    assert.notEqual(second.storyId, first.storyId);
    const list = listShared(directories, second);
    assert.equal(list.available.length, 1);
    assert.equal(list.available[0].brought, false);
    let brought;
    await mutateState(directories, other, state => { brought = bringShared(directories, state, [list.available[0].id]); });
    assert.equal(brought.added, 1);
    const after = readState(directories, other);
    const record = after.records.find(item => item.sharedFrom?.entryId === list.available[0].id);
    assert.ok(record);
    assert.equal(record.origin, 'author');
    assert.ok(recordEligible(after, record), 'the brought memory is usable in the new chat');
    assert.equal(listShared(directories, after).available[0].brought, true);
    await mutateState(directories, other, state => { brought = bringShared(directories, state, [list.available[0].id]); });
    assert.equal(brought.added, 0);
    assert.equal(removeShared(directories, list.available[0].id).removed, 1);
    assert.throws(() => removeShared(directories, list.available[0].id), /no longer there/);
    assert.equal(listShared(directories, readState(directories, other)).available.length, 0);
    shareRecords(directories, first, ['event:gift']);
    fs.writeFileSync(statePath(directories, locator), '{damaged');
    removeChatMemory(directories, locator);
    assert.equal(listShared(directories, readState(directories, other)).available.length, 0);
    assert.ok(recordEligible(readState(directories, other), record), 'a copy explicitly brought into another chat stays there');
    assert.throws(() => shareRecords(directories, first, ['event:gift']), /changed|no longer/);
});

test('ask, contradiction and sharing routes report plain errors and keep the archive unchanged', async t => {
    const { directories } = disk(t, fixture.messages);
    await loadCurrentState(directories, locator);
    await mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const express = (await import('express')).default;
    const { router } = await import('../src/endpoints/mewmory.js');
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.user = { directories }; next(); });
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    t.after(() => server.close());
    await new Promise(resolve => server.once('listening', resolve));
    const post = (route, body) => fetch('http://127.0.0.1:' + server.address().port + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locator, ...body }),
    });
    const before = readState(directories, locator).revision;
    assert.equal((await post('/ask', { question: '' })).status, 400);
    const ask = await post('/ask', { question: 'What happened to the gift?' });
    assert.equal(ask.status, 409);
    assert.match((await ask.json()).error ?? '', /Enable/);
    assert.deepEqual((await (await post('/conflicts', {})).json()).conflicts, [], 'one memory needs no model call');
    const shared = await (await post('/shared', {})).json();
    assert.deepEqual(shared.available, []);
    assert.equal((await post('/share', { ids: [] })).status, 400);
    assert.equal((await post('/shared/remove', { id: 'missing' })).status, 404);
    assert.equal(readState(directories, locator).revision, before);
});

function workingExtraction(input, count = 2) {
    const source = input.sources.filter(row => row.type === 'chat').at(-1);
    const refs = [{ id: source.id, revision: source.revision }];
    const knowledge = Array.from({ length: count }, (_, index) => 'working-' + index);
    return {
        records: [
            { id: 'entity:working-mara', kind: 'entity', entityId: 'npc:mara', name: 'Mara', text: 'Mara', isCharacter: true, subjectIds: ['npc:mara'], refs },
            { id: 'event:working', kind: 'event', text: 'Mara remembers the harbour.', subjectIds: ['pier'], refs, evidenceStatus: 'established' },
            ...knowledge.map(name => ({ id: 'knowledge:' + name, kind: 'knowledge', ownerId: 'npc:mara', subjectIds: ['pier'],
                text: 'Known harbour detail ' + name, method: 'witnessed', evidenceText: source.text.slice(0, 55), refs })),
        ],
        interviews: knowledge.map(name => ({ ownerId: 'npc:mara', subjectIds: ['pier'], knowledgeIds: ['knowledge:' + name], refs })),
        activeNpcIds: ['npc:mara'],
    };
}

const workingInterview = (number, valid = true) => ({ changed: true,
    interview: [{ question: 'What was there?', answer: 'Mara remembers the pier ' + number }],
    searchDescription: 'Mara remembers the pier ' + number, changeExplanation: '',
    overviews: valid ? [{ subjectId: 'pier', text: 'The pier mattered to Mara ' + number, status: 'active' }] : [] });

for (const change of ['source edit', 'author correction', 'cancellation']) {
    test(`held Pawspective rejects ${change} without partial records or progress and keeps concurrent indexes`, { timeout: 10000 }, async t => {
        const messages = structuredClone(fixture.messages.slice(0, 3));
        const { directories, write } = disk(t, messages);
        const config = defaultConfig();
        Object.assign(config.roles.pawspective, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'working-fixture' });
        saveConfig(directories, config);
        await loadCurrentState(directories, locator);
        mutateState(directories, locator, state => { state.enabled = true; event(state); });
        const controller = new AbortController();
        let entered, release;
        const ready = new Promise(resolve => { entered = resolve; });
        const held = new Promise(resolve => { release = resolve; });
        const processing = processBatch(directories, locator, { checkpoint: true, signal: controller.signal }, async (_directories, _config, role, _contract, input) => {
            if (role === 'extractor') return { value: workingExtraction(input, 1), usage: { role, input: 11, output: 5 } };
            entered();
            await held;
            return { value: workingInterview(1), usage: { role, input: 13, output: 7 } };
        });
        await ready;
        let before;
        try {
            if (change === 'source edit') {
                messages[2].mes = 'The source actually read by extraction was edited.';
                write(messages);
                await loadCurrentState(directories, locator);
            } else if (change === 'author correction') {
                mutateState(directories, locator, state => {
                    const record = state.records.find(row => row.id === 'event:gift');
                    putRecord(state, { ...record, text: 'This correction must survive.', authorOverride: true, origin: 'author' });
                });
            } else controller.abort();
            mutateState(directories, locator, state => {
                state.index.vectors.concurrent = { textHash: 'newer', vector: [0.125, 0.625] };
                state.index.build = { owner: 'parallel-owner', version: 'parallel-space', cursor: 19,
                    vectors: { staged: { textHash: 'staged', vector: [0.375, 0.875] } } };
            });
            before = readState(directories, locator);
        } finally { release(); }
        await assert.rejects(processing, change === 'cancellation' ? /cancelled/ : /discarded/);
        const result = readState(directories, locator);
        for (const key of ['records', 'audit', 'coverage', 'checkpoints', 'rolePolicies', 'roleIdentities', 'sceneNpcIds', 'castHistory', 'index']) {
            assert.deepEqual(result[key], before[key], key + ' must not publish rejected draft changes');
        }
        assert.equal(result.records.some(row => ['entity:working-mara', 'event:working', 'knowledge:working-0'].includes(row.id)
            || ['interview', 'overview'].includes(row.kind)), false);
        assert.equal(result.jobs.at(-1).status, change === 'source edit' ? 'superseded' : 'failed');
        assert.deepEqual(result.jobs.at(-1).usage, [{ role: 'extractor', input: 11, output: 5 }, { role: 'pawspective', input: 13, output: 7 }]);
        assert.equal(result.usage.extractor.requests, 1);
        assert.equal(result.usage.pawspective.requests, 1);
        assert.equal(result.usage.extractor.input, 11);
        assert.equal(result.usage.pawspective.input, 13);
    });
}

test('admitted extraction and interviews keep original inputs, roll back a partial interview, and retain unread appends and newer index metadata', async t => {
    t.mock.method(Date, 'now', () => 1780009999000);
    const messages = structuredClone(fixture.messages.slice(0, 3));
    const { directories, write } = disk(t, messages);
    const config = defaultConfig();
    Object.assign(config.roles.pawspective, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'working-fixture' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    const initial = mutateState(directories, locator, state => {
        state.enabled = true;
        state.index = { version: 'original', pending: false, vectors: { original: { textHash: 'before', vector: [0.1, 0.2] } },
            build: { version: 'old-build', owner: 'old-owner', vectors: { original: { vector: [0.3, 0.4] } } } };
    });
    const originalIndex = structuredClone(initial.index);
    let expected, requests, interviews = 0, heldShared, admittedIndex;
    const inputs = [];
    const newerIndex = { version: 'published-later', pending: false, futureMetadata: { preserved: true },
        vectors: { original: { textHash: 'before', vector: [0.1, 0.2] }, concurrent: { textHash: 'new', vector: [0.5] } },
        build: { version: 'staged-later', owner: 'new-owner', cursor: 9, futureMetadata: { preserved: 'build' }, vectors: { next: { textHash: 'next', vector: [0.6] } } } };
    const result = await processBatch(directories, locator, { checkpoint: true }, async (_directories, saved, role, _contract, input) => {
        inputs.push([role, structuredClone(input)]);
        if (role === 'extractor') {
            expected = readState(directories, locator);
            heldShared = readStateShared(directories, locator);
            admittedIndex = structuredClone(heldShared.index);
            assert.deepEqual(admittedIndex, { ...originalIndex, pending: true }, 'Admission retains both full vector maps');
            const refs = expected.timeline;
            const originalInput = extractionInput(expected, refs, refs.length - 1, true);
            originalInput.provenance = { policy: POLICY_VERSION, jobId: expected.jobs.at(-1).id, role,
                model: saved.roles.extractor.model, modelRevision: saved.roles.extractor.modelRevision };
            assert.deepEqual(input, originalInput);
            const value = workingExtraction(input);
            requests = applyExtraction(expected, value, originalInput);
            await new Promise(resolve => setImmediate(resolve));
            write([...messages, { name: 'Mara', is_user: false, send_date: 'unread-working', mes: 'An unread turn arrived during the held request.' }]);
            mutateState(directories, locator, state => {
                state.index = structuredClone(newerIndex);
                state.usage = { selector: { requests: 7, input: 17, output: 3, milliseconds: 5 } };
            });
            return { value, usage: { role, input: 11, output: 5 } };
        }
        const request = requests[interviews];
        const originalInput = interviewInput(expected, request, messages.length - 1);
        originalInput.provenance = { policy: POLICY_VERSION, jobId: expected.jobs.at(-1).id, role,
            model: saved.roles.pawspective.model, modelRevision: saved.roles.pawspective.modelRevision };
        assert.deepEqual(input, originalInput, 'Interview inputs use the admitted evidence and previous successful interview');
        const value = workingInterview(++interviews, interviews === 1);
        if (interviews === 1) applyInterview(expected, request, value, originalInput, expected.jobs.at(-1).id);
        else {
            const records = expected.records;
            const auditLength = expected.audit.length;
            assert.throws(() => applyInterview(expected, request, value, originalInput, expected.jobs.at(-1).id), /one short summary/);
            assert.ok(expected.records.length > records.length, 'The invalid reply attempted a partial interview write');
            expected.records = records;
            expected.audit.length = auditLength;
        }
        return { value, usage: { role, input: 13, output: 7 } };
    });
    assert.equal(interviews, 2);
    assert.equal(inputs.length, 3);
    assert.equal(JSON.stringify(inputs).includes('An unread turn arrived'), false);
    for (const key of ['records', 'audit', 'sceneNpcIds', 'castHistory']) assert.deepEqual(result[key], expected[key], key);
    assert.equal(result.records.filter(row => row.kind === 'interview').length, 1);
    assert.equal(result.records.filter(row => row.kind === 'overview').length, 1);
    assert.equal(JSON.stringify(result.records).includes('Mara remembers the pier 2'), false);
    assert.deepEqual(result.index, { ...expectedCompactIndex(newerIndex), pending: true });
    assert.deepEqual(heldShared.index, admittedIndex);
    assert.deepEqual(initial.index, originalIndex);
    assert.equal(result.timeline.length, 4);
    assert.equal(sourceAt(result, result.timeline.at(-1)).text, 'An unread turn arrived during the held request.');
    const policy = processingVersion(readConfig(directories));
    const marks = Object.fromEntries(result.timeline.slice(0, 3).map(ref => [refKey(ref), policy]));
    assert.deepEqual(result.coverage, marks);
    assert.deepEqual(result.checkpoints, marks);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, 'complete');
    assert.equal(result.jobs[0].skipped, 1);
    assert.equal(result.jobs[0].skippedReasons.length, 1);
    assert.match(result.jobs[0].skippedReasons[0], /one short summary/);
    assert.deepEqual(result.jobs[0].usage, [{ role: 'extractor', input: 11, output: 5 },
        { role: 'pawspective', input: 13, output: 7 }, { role: 'pawspective', input: 13, output: 7 }]);
    assert.equal(result.usage.extractor.requests, 1);
    assert.equal(result.usage.pawspective.requests, 2);
    assert.equal(result.usage.selector.requests, 7);
    assert.equal(result.usage.selector.input, 17);
    assert.deepEqual(readStateShared(directories, locator), JSON.parse(fs.readFileSync(statePath(directories, locator))));
});

test('failed completion restores warm disk/cache/guard state and a real worker retry publishes progress and usage once', async t => {
    const { directories } = disk(t, fixture.messages.slice(0, 3));
    const config = defaultConfig();
    config.autoUpdate = false;
    Object.assign(config.roles.pawspective, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'working-fixture' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        state.index = { version: 'published', pending: false, vectors: { keep: { textHash: 'kept', vector: [0.1, 0.2] } },
            build: { version: 'next-space', owner: 'parallel', cursor: 4, vectors: { staged: { vector: [0.3, 0.4] } } } };
    });
    const archive = statePath(directories, locator);
    const recovery = path.join(directories.root, 'mewmory', 'recovery', hash(normalizeLocator(locator)) + '.json');
    let beforeArchive, beforeRecovery, beforeState, shared;
    const calls = { extractor: 0, pawspective: 0 };
    const call = async (_directories, _config, role, _contract, input) => {
        calls[role]++;
        if (role === 'extractor') {
            // Admission has persisted. Warm all three store caches before completion.
            mutateState(directories, locator, () => {});
            shared = readStateShared(directories, locator);
            beforeState = structuredClone(shared);
            listStories(directories);
            beforeArchive = fs.readFileSync(archive);
            beforeRecovery = fs.readFileSync(recovery);
            return { value: workingExtraction(input, 1), usage: { role, input: 11, output: 5 } };
        }
        return { value: workingInterview(1), usage: { role, input: 13, output: 7 } };
    };
    let injected = false, rollbackSeen = false;
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, 'renameSync', (from, to) => {
        if (!injected && String(to) === archive) {
            const candidate = JSON.parse(fs.readFileSync(from));
            if (candidate.jobs.at(-1)?.status === 'complete' && candidate.records.some(row => row.id === 'event:working')) {
                injected = true;
                throw new Error('Injected completion archive write failure');
            }
        }
        const result = rename(from, to);
        if (injected && !rollbackSeen && String(to) === recovery) {
            rollbackSeen = true;
            assert.deepEqual(fs.readFileSync(archive), beforeArchive);
            assert.deepEqual(fs.readFileSync(recovery), beforeRecovery);
            assert.equal(readStateShared(directories, locator), shared);
            assert.deepEqual(shared, beforeState);
            assert.equal(listStories(directories)[0].processing.status, 'running');
        }
        return result;
    });
    await startProcessing(directories, locator, { checkpoint: true }, call);
    const failed = await waitForProcessing(directories, locator);
    mock.mock.restore();
    assert.equal(injected && rollbackSeen, true);
    assert.deepEqual(shared, beforeState, 'A held cache reader was never changed by the failed completion or status save');
    assert.equal(failed.processing.status, 'failed');
    assert.equal(failed.jobs.at(-1).status, 'failed');
    assert.equal(failed.jobs.at(-1).usage.length, 2);
    for (const key of ['records', 'audit', 'coverage', 'checkpoints', 'index', 'sceneNpcIds', 'castHistory']) assert.deepEqual(failed[key], beforeState[key], key);
    assert.equal(failed.usage.extractor.requests, 1);
    assert.equal(failed.usage.pawspective.requests, 1);
    const retainedFailure = structuredClone(failed);
    await startProcessing(directories, locator, { checkpoint: true }, call);
    const complete = await waitForProcessing(directories, locator);
    assert.deepEqual(failed, retainedFailure, 'The retry cannot mutate an earlier isolated read');
    assert.equal(complete.processing.status, 'complete');
    assert.equal(complete.processing.failures, undefined);
    assert.equal(complete.jobs.length, 1);
    assert.equal(complete.jobs[0].status, 'complete');
    assert.equal(complete.jobs[0].usage.length, 2);
    assert.deepEqual(calls, { extractor: 2, pawspective: 2 });
    assert.equal(complete.usage.extractor.requests, 2);
    assert.equal(complete.usage.extractor.input, 22);
    assert.equal(complete.usage.pawspective.requests, 2);
    assert.equal(complete.usage.pawspective.input, 26);
    for (const kind of ['event', 'knowledge', 'interview', 'overview']) assert.equal(complete.records.filter(row => row.kind === kind).length, 1, kind);
    assert.equal(Object.keys(complete.coverage).length, 3);
    assert.equal(Object.keys(complete.checkpoints).length, 3);
    assert.deepEqual(complete.index.vectors, beforeState.index.vectors);
    assert.deepEqual(complete.index.build, beforeState.index.build);
    const reopened = JSON.parse(fs.readFileSync(archive));
    assert.deepEqual(readStateShared(directories, locator), reopened);
    assert.deepEqual(readState(directories, locator), reopened);
    assert.equal(listStories(directories)[0].processing.status, 'complete');
    assert.equal(JSON.parse(fs.readFileSync(recovery)).revision, reopened.revision);
});

// Work counters: these tests check how much serialising, cloning and parsing a call does, never how long it takes.
function countWork(work) {
    const original = { stringify: JSON.stringify, parse: JSON.parse, clone: globalThis.structuredClone };
    const counts = { stringifyCalls: 0, stringifiedChars: 0, largestStringify: 0, parseCalls: 0, largestParse: 0, clones: 0 };
    JSON.stringify = function stringify(...args) {
        const text = original.stringify.apply(this, args);
        counts.stringifyCalls++;
        if (typeof text === 'string') {
            counts.stringifiedChars += text.length;
            counts.largestStringify = Math.max(counts.largestStringify, text.length);
        }
        return text;
    };
    JSON.parse = function parse(text, ...rest) {
        counts.parseCalls++;
        counts.largestParse = Math.max(counts.largestParse, String(text).length);
        return original.parse.call(this, text, ...rest);
    };
    globalThis.structuredClone = (...args) => { counts.clones++; return original.clone(...args); };
    const restore = () => {
        Object.assign(JSON, { stringify: original.stringify, parse: original.parse });
        globalThis.structuredClone = original.clone;
    };
    let value;
    try {
        value = work();
    } catch (error) {
        restore();
        throw error;
    }
    if (!(value instanceof Promise)) {
        restore();
        return { counts, value };
    }
    return value.then(result => { restore(); return { counts, value: result }; }, error => { restore(); throw error; });
}

const plain = value => JSON.parse(JSON.stringify(value));
const identityOf = file => { const stat = fs.statSync(file); return [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'); };
// Runs every registered reclaimer, as the server does when memory runs short.
const reclaimMemory = () => assert.equal(createMemoryPressureCheck({ sample: () => ({ available: 0, total: 1e9, heapUsed: 0, heapLimit: 0 }) })(), true);
const bulkMessages = (count = 160) => Array.from({ length: count }, (_, index) => ({
    name: index % 2 ? 'Mara' : 'You', is_user: index % 2 === 0, send_date: new Date(Date.UTC(2026, 0, 1) + index * 60000).toISOString(),
    mes: `Message ${index}: ` + 'The lantern sat beside the ledger, and Mara said nothing. '.repeat(12),
}));
const MESSAGE_COUNT = 160;
// A file read and stamped in one pass is trusted only once it was quiet before that pass began.
const letFilesSettle = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);

test('loading an unchanged story again does no whole-archive work, writes nothing and equals the full path', t => {
    const { directories } = disk(t, bulkMessages());
    const archive = statePath(directories, locator);
    const first = loadCurrentStateSync(directories, locator);
    assert.ok(fs.statSync(archive).size > 100_000, 'a realistic archive, not a toy');
    const files = [archive, recoveryPath(directories, locator)];
    const written = files.map(identityOf);
    // The first read after a write parses what was written; the one measured below is the second.
    loadCurrentStateSync(directories, locator);
    const { counts, value: second } = countWork(() => loadCurrentStateSync(directories, locator));
    assert.deepEqual(files.map(identityOf), written, 'neither the archive nor its recovery guard was written');
    assert.equal(counts.clones, 0, 'no clone');
    assert.ok(counts.largestStringify < 2000, 'no archive or message was serialised');
    assert.ok(counts.stringifyCalls < MESSAGE_COUNT / 4, 'messages were not hashed one by one: ' + counts.stringifyCalls);
    assert.ok(counts.largestParse < 50_000, 'the archive was not parsed again');
    assert.deepEqual(plain(second), plain(first));
    const full = countWork(() => loadCurrentStateSync(directories, locator, { fresh: true }));
    assert.ok(full.counts.stringifyCalls >= MESSAGE_COUNT && full.counts.clones > 0, 'the full path hashes every message and clones the archive');
    assert.deepEqual(plain(full.value), plain(second));
    assert.deepEqual(files.map(identityOf), written, 'the full path found nothing to change either');
});

test('every input of a synchronise invalidates the unchanged-story shortcut', async t => {
    const messages = bulkMessages();
    const { directories, write } = disk(t, messages);
    const { write: writeCard } = await import('../src/character-card-parser.js');
    const png = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));
    const card = description => fs.writeFileSync(path.join(directories.characters, 'Mara.png'), writeCard(png, JSON.stringify({ name: 'Mara', description })));
    directories.files = path.join(directories.root, 'user/files');
    fs.mkdirSync(directories.files, { recursive: true });
    const settingsFile = path.join(directories.root, 'settings.json');
    const bookFile = path.join(directories.worlds, 'Book.json');
    const book = text => writeJson(bookFile, { entries: { 1: { uid: 1, comment: 'Harbour', content: text, key: ['harbour'] } } });
    const noteFile = path.join(directories.files, 'note.txt');
    card('Original card text');
    book('Lighthouse first');
    fs.writeFileSync(noteFile, 'Note first');
    letFilesSettle();
    const settings = extra => writeJson(settingsFile, { world_info: { globalSelect: ['Book'] }, extension_settings: { attachments: [{ url: '/user/files/note.txt' }, { url: '/user/files/later.txt' }] }, ...extra });
    settings();
    const archive = statePath(directories, locator);
    let state = loadCurrentStateSync(directories, locator);
    const reload = () => {
        const { counts, value } = countWork(() => loadCurrentStateSync(directories, locator));
        assert.ok(counts.stringifyCalls >= MESSAGE_COUNT, 'the change was reconciled, not skipped');
        return value;
    };
    const text = value => JSON.stringify(value.sources);
    assert.match(text(state), /Original card text/);
    assert.match(text(state), /Lighthouse first/);
    assert.match(text(state), /Note first/);
    const hit = () => assert.ok(countWork(() => loadCurrentStateSync(directories, locator)).counts.stringifyCalls < MESSAGE_COUNT / 4, 'unchanged input is skipped');
    hit();

    // The same size every time, so only the file's identity can tell.
    card('Changed card text!!');
    state = reload();
    assert.match(text(state), /Changed card text/);
    hit();
    book('Lighthouse other');
    state = reload();
    assert.match(text(state), /Lighthouse other/);
    hit();
    fs.writeFileSync(noteFile, 'Note other');
    letFilesSettle();
    state = reload();
    assert.match(text(state), /Note other/);
    hit();
    // A file that did not exist when the story was last reconciled.
    fs.writeFileSync(path.join(directories.files, 'later.txt'), 'Arrived later');
    letFilesSettle();
    state = reload();
    assert.match(text(state), /Arrived later/);
    hit();
    write([...messages, { name: 'Mara', is_user: false, send_date: '2027-01-01T00:00:00.000Z', mes: 'A brand new line.' }]);
    state = reload();
    assert.equal(state.timeline.length, MESSAGE_COUNT + 1);
    hit();
    // Another writer replaces the archive with an older picture of the story.
    const stale = readState(directories, locator);
    stale.timeline = stale.timeline.slice(0, 10);
    writeJson(archive, stale);
    state = reload();
    assert.equal(state.timeline.length, MESSAGE_COUNT + 1);
    hit();
    mutateState(directories, locator, current => { current.reviewedAt = 7; });
    state = reload();
    assert.equal(state.reviewedAt, 7);
    hit();
    fs.rmSync(recoveryPath(directories, locator));
    reload();
    assert.ok(fs.existsSync(recoveryPath(directories, locator)), 'a missing recovery guard is written again');
    hit();
    const config = readConfig(directories);
    config.roles.extractor = { ...config.roles.extractor, enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'one' };
    saveConfig(directories, config);
    state = reload();
    assert.ok(Object.keys(state.rolePolicies).includes(processingVersion(readConfig(directories))));
    hit();
    // Settings that change nothing Mewmory folds in leave the story alone.
    saveConfig(directories, { ...readConfig(directories), memoryTokens: 4000 });
    hit();
    const fileIds = value => value.contextSources.filter(ref => ref.id.startsWith('file:'));
    assert.equal(fileIds(state).length, 2);
    settings({ extension_settings: {} });
    state = reload();
    assert.equal(fileIds(state).length, 0, 'attachments removed from settings.json');
    assert.ok(state.contextSources.some(ref => ref.id.startsWith('lore:')));
    hit();
    settings();
    state = reload();
    assert.equal(fileIds(state).length, 2);
    hit();
    saveConfig(directories, { ...readConfig(directories), retrieval: { ...readConfig(directories).retrieval, includeFiles: false } });
    state = reload();
    assert.equal(fileIds(state).length, 0, 'attached files switched off in Mewmory settings');
    hit();
    // Memory pressure empties the caches but keeps the stamps, so the first load afterwards is not a full reconcile.
    reclaimMemory();
    hit();
    assert.ok(countWork(() => loadCurrentStateSync(directories, locator, { fresh: true })).counts.stringifyCalls >= MESSAGE_COUNT, 'a fresh load always reconciles');
    hit();
    // A synchronise that is handed its own extra change always runs it.
    let ran = 0;
    synchronize(directories, locator, [], readChatShared(directories, locator), current => { ran++; current.reviewedAt = 9; });
    assert.equal(ran, 1);
    assert.equal(readStateShared(directories, locator).reviewedAt, 9);
    assert.equal(reload().reviewedAt, 9);
});

test('a persona avatar that disappears is noticed even when everything else is unchanged', t => {
    const { directories } = disk(t, bulkMessages(100));
    const avatars = path.join(directories.root, 'User Avatars');
    fs.mkdirSync(avatars, { recursive: true });
    fs.writeFileSync(path.join(avatars, 'me.png'), 'avatar bytes');
    letFilesSettle();
    writeJson(path.join(directories.root, 'settings.json'), { power_user: { default_persona: 'me.png', personas: { 'me.png': 'Persona' },
        persona_descriptions: { 'me.png': { description: 'A traveller' } } } });
    const loaded = loadCurrentStateSync(directories, locator);
    assert.equal(sourceAt(loaded, loaded.contextSources[0]).meta.persona, 'me.png');
    assert.ok(countWork(() => loadCurrentStateSync(directories, locator)).counts.stringifyCalls < 50, 'the second load is the shortcut');
    fs.rmSync(path.join(avatars, 'me.png'));
    assert.throws(() => loadCurrentStateSync(directories, locator), /persona avatar is missing/);
});

test('callers that reassign fields of a loaded state never change the shared archive', async t => {
    const { directories } = disk(t, bulkMessages(24));
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const config = defaultConfig();
    Object.assign(config.roles.embedding, { enabled: true, endpoint: provider.url, model: 'embedding' });
    saveConfig(directories, config);
    loadCurrentStateSync(directories, locator);
    const shared = readStateShared(directories, locator);
    const snapshot = JSON.stringify(shared);
    for (const attempt of ['shortcut', 'full']) {
        if (attempt === 'full') reclaimMemory();
        const view = loadCurrentStateSync(directories, locator);
        assert.notEqual(view, readStateShared(directories, locator), attempt);
        await updateIndex(view, directories, readConfig(directories));
        assert.ok(Object.keys(view.index.vectors).length > 0, 'the loaded copy took the new index');
        view.index = { version: 'replaced', vectors: {}, pending: false };
        view.records = [];
        view.enabled = true;
        view.index.pending = true;
        assert.equal(JSON.stringify(readStateShared(directories, locator)), snapshot, attempt);
        assert.equal(loadCurrentStateSync(directories, locator).index.version, '', attempt);
    }
    // The shortcut state is read-only all the way down, as the shared state always has been.
    const frozen = structuredClone(readStateShared(directories, locator));
    const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); } };
    freeze(frozen);
    const config2 = readConfig(directories);
    assert.doesNotThrow(() => { inspectState(frozen, config2); pendingSources(frozen, config2); assembleContext(frozen, [], { counter }); });
});

test('a changed archive is serialised once, written byte for byte as before, and unchanged ones are not written', t => {
    const { directories } = disk(t, bulkMessages());
    const archive = statePath(directories, locator);
    loadCurrentStateSync(directories, locator);
    const vector = index => Buffer.from(new Float32Array([index, 1, 2, 3]).buffer).toString('base64');
    mutateState(directories, locator, state => {
        state.enabled = true;
        state.index = { version: 'space', pending: false, vectors: Object.fromEntries(Array.from({ length: 150 }, (_, index) =>
            ['doc:' + index, { textHash: 'hash' + index, vectorF32LE: vector(index) }])) };
    });
    const mutator = state => { state.reviewedAt = 5; state.records.push({ id: 'x', note: 'ünïcode - “quoted”' }); delete state.preview; };
    const clock = 1_900_000_000_000;
    t.mock.method(Date, 'now', () => clock);
    // What the earlier implementation wrote: clone, mutate, bump revision and time, normalise the locator, serialise.
    const previous = readStateShared(directories, locator);
    const expected = structuredClone(previous);
    mutator(expected);
    Object.assign(expected, { revision: previous.revision + 1, updatedAt: clock, locator: normalizeLocator(expected.locator) });
    const reference = JSON.stringify(expected);
    const size = fs.readFileSync(archive, 'utf8').length;
    const changed = countWork(() => mutateState(directories, locator, mutator));
    assert.equal(fs.readFileSync(archive, 'utf8'), reference);
    assert.ok(changed.counts.stringifiedChars < size * 1.5, `serialised ${changed.counts.stringifiedChars} characters for a ${size} character archive`);
    assert.equal(JSON.parse(fs.readFileSync(recoveryPath(directories, locator), 'utf8')).revision, previous.revision + 1);
    // An archive written by an older version: no updatedAt, and a locator whose keys are in another order.
    const old = readState(directories, locator);
    delete old.updatedAt;
    old.locator = { group: false, chat: locator.chat, avatar: locator.avatar };
    fs.writeFileSync(archive, JSON.stringify(old));
    const reread = readStateShared(directories, locator);
    const expectedOld = structuredClone(reread);
    mutator(expectedOld);
    Object.assign(expectedOld, { revision: reread.revision + 1, updatedAt: clock, locator: normalizeLocator(expectedOld.locator) });
    mutateState(directories, locator, mutator);
    assert.equal(fs.readFileSync(archive, 'utf8'), JSON.stringify(expectedOld));

    const before = identityOf(archive);
    const after = fs.readFileSync(archive, 'utf8').length;
    const unchanged = countWork(() => mutateState(directories, locator, () => {}));
    assert.equal(identityOf(archive), before, 'an unchanged mutation writes nothing');
    assert.ok(unchanged.counts.stringifiedChars < after * 1.2, 'and compares with the text it kept, serialising the result once');
    assert.equal(unchanged.value.revision, readStateShared(directories, locator).revision);
});

test('the clone shares embedding vectors and nothing a mutator does reaches a state read earlier', t => {
    const { directories } = disk(t, bulkMessages(40));
    loadCurrentStateSync(directories, locator);
    const vectors = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`doc:${index}`, { textHash: 'h' + index,
        vectorF32LE: Buffer.from(new Float32Array([index, 2]).buffer).toString('base64') }]));
    mutateState(directories, locator, state => {
        state.index = { version: 'space', pending: false, vectors, build: { version: 'next', vectors: { ...vectors }, cursor: 3 } };
    });
    const shared = readStateShared(directories, locator);
    const snapshot = JSON.stringify(shared);
    const copy = cloneState(shared);
    assert.deepEqual(copy, shared);
    for (const [owner, other] of [[copy.index.vectors, shared.index.vectors], [copy.index.build.vectors, shared.index.build.vectors]]) {
        assert.notEqual(owner, other, 'the map is the clone\'s own');
        assert.equal(Object.keys(owner).length, 30);
        for (const [id, entry] of Object.entries(owner)) assert.equal(entry, other[id], 'the entries are shared, not copied');
    }
    assert.notEqual(copy.index, shared.index);
    assert.notEqual(copy.index.build, shared.index.build);
    assert.notEqual(copy.sources, shared.sources);
    assert.deepEqual(Object.keys(copy), Object.keys(shared), 'key order decides the bytes written');
    const mutators = [
        state => { state.index.vectors.added = { textHash: 'added', vectorF32LE: 'AAAA' }; delete state.index.vectors['doc:1']; delete state.index.build.vectors['doc:2']; },
        state => { state.index.pending = true; state.index.version = 'other'; },
        state => { state.index.build.cursor = 9; state.index.build.version = 'newer'; },
        state => { state.index = { ...state.index, vectors: {}, build: undefined }; },
        state => { purgeSources(state, state.timeline.slice(0, 5).map(ref => ref.id)); },
        state => { state.index.vectors = Object.fromEntries(Object.entries(state.index.vectors).slice(0, 3)); },
    ];
    for (const mutator of mutators) {
        mutateState(directories, locator, mutator);
        assert.equal(JSON.stringify(shared), snapshot, 'the earlier state is untouched');
    }
});

test('pending counts agree with the three pending queries they replace', () => {
    const state = base();
    const config = defaultConfig();
    const policy = processingVersion(config);
    state.coverage = { [refKey(state.timeline[0])]: policy, [refKey(state.timeline[1])]: READ_EARLIER, [refKey(state.timeline[2])]: 'old policy' };
    state.checkpoints = { [refKey(state.timeline[1])]: policy, [refKey(state.timeline[3])]: READ_EARLIER };
    state.excludedSources = [state.timeline[4].id];
    for (const followCheckpoints of [false, true]) {
        const unread = pendingSources(state, config, { unreadOnly: true }).length;
        const checkpointUnread = pendingSources(state, config, { checkpoint: true, unreadOnly: true }).length;
        const rereadPending = pendingSources(state, config, { checkpoint: followCheckpoints }).length - (followCheckpoints ? checkpointUnread : unread);
        assert.deepEqual(pendingCounts(state, config, { followCheckpoints }), { unread, checkpointUnread, rereadPending }, String(followCheckpoints));
        assert.ok(unread > 0 && rereadPending !== 0 || followCheckpoints, 'the fixture exercises each count');
    }
});

test('inspecting an unchanged archive twice leaves the archive file and its revision alone', async t => {
    const { directories } = disk(t, bulkMessages());
    const express = (await import('express')).default;
    const { router } = await import('../src/endpoints/mewmory.js');
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => { request.user = { directories }; next(); });
    app.use(router);
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const inspect = async () => (await fetch('http://127.0.0.1:' + server.address().port + '/inspect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locator }) })).json();
    const first = await inspect();
    const archive = statePath(directories, locator);
    const before = identityOf(archive);
    await inspect();
    const warm = await countWork(inspect);
    const second = warm.value;
    const third = await inspect();
    assert.equal(warm.counts.clones, 0, 'no copy of the archive');
    assert.ok(warm.counts.stringifyCalls < MESSAGE_COUNT / 2, 'no message was hashed: ' + warm.counts.stringifyCalls);
    assert.equal(identityOf(archive), before, 'inspection is read-only once the story is reconciled');
    assert.equal(second.revision, first.revision);
    assert.deepEqual(third, second);
    assert.equal(second.health.pending, MESSAGE_COUNT);
});

test('a request body is accepted from Content-Length only when printing it again cannot exceed the limit', () => {
    const request = (headers, body = { text: 'x'.repeat(50) }) => ({ body, get: name => headers[name] });
    const printed = body => Buffer.byteLength(JSON.stringify(body));
    // Within a sixth of the limit, whatever it prints as: no serialising.
    const fast = countWork(() => requestBodyExceeds(request({ 'Content-Length': '100' }), 1000));
    assert.equal(fast.value, false);
    assert.equal(fast.counts.stringifyCalls, 0);
    // 1e20 is four characters long and prints as twenty-one, so a declared 250 bytes can print as 1,100 and must be measured.
    const grown = { values: Array.from({ length: 50 }, () => 1e20) };
    assert.ok(printed(grown) > 1000 && 250 < 1000);
    assert.equal(requestBodyExceeds(request({ 'Content-Length': '250' }, grown), 1000), true, 'the old limit cannot be slipped past');
    assert.equal(requestBodyExceeds(request({ 'Content-Length': '250' }, { values: [1, 2, 3] }), 1000), false);
    // No usable length: measured, as before.
    for (const headers of [{}, { 'Content-Length': 'many' }, { 'Content-Length': '-5' }, { 'Content-Length': '12', 'Content-Encoding': 'gzip' }]) {
        assert.equal(requestBodyExceeds(request(headers, grown), 1000), true, JSON.stringify(headers));
        assert.equal(requestBodyExceeds(request(headers), 1000), false, JSON.stringify(headers));
    }
    assert.equal(requestBodyExceeds(request({}, null), 1), true);
    assert.equal(requestBodyExceeds(request({}, null), 2), false);
});

test('preparing a reply reads the chat through the shared reader instead of parsing it again', async t => {
    const { directories } = disk(t, bulkMessages(40));
    saveConfig(directories, { ...defaultConfig(), writerTokenizer: 'o200k_base' });
    mutateState(directories, locator, state => { state.enabled = true; }, 0);
    await loadCurrentState(directories, locator);
    let chatLinesParsed = 0;
    const parse = JSON.parse;
    JSON.parse = function counted(text, ...rest) { if (typeof text === 'string' && text.includes('"send_date"') && text.includes('"mes"')) chatLinesParsed++; return parse.call(this, text, ...rest); };
    try {
        const result = await prepareMewmoryPrompt(directories, { locator, history: [{ index: 0, text: 'hello' }], tokenizer: {} }, undefined, { scheduleBackground: false });
        assert.equal(result.enabled, true);
    } finally {
        JSON.parse = parse;
    }
    assert.equal(chatLinesParsed, 0, 'the chat was not parsed a second time');
});

test('recall documents are built only for the pool recall can rank, and the passages the selector may ask for come on demand', () => {
    const state = base();
    syncSources(state, fixture.messages, [...fixture.lore, { id: 'file:note', type: 'file', name: 'note.txt', text: 'A saved file about the moon.', meta: { url: '/user/files/note.txt' } }]);
    event(state);
    for (const includePassages of [false, true]) for (const includeFiles of [false, true]) {
        const config = { ...defaultConfig(), retrieval: { ...defaultConfig().retrieval, includePassages, includeFiles } };
        const pool = recallPool(searchDocuments(state, Infinity, config, { poolOnly: true }), config);
        assert.deepEqual(pool, recallPool(searchDocuments(state, Infinity, config), config), JSON.stringify({ includePassages, includeFiles }));
        assert.ok(pool.length > 0);
        if (!includePassages) assert.ok(searchDocuments(state, Infinity, config, { poolOnly: true }).length < searchDocuments(state, Infinity, config).length,
            'chat, card and lore passages are not built');
    }
});

test('cache budgets count estimated heap, never evict the entry just inserted, and empty under memory pressure', t => {
    const { directories } = disk(t, bulkMessages());
    reclaimMemory();
    assert.deepEqual(Object.values(cacheUsage()).map(entry => entry.bytes), [0, 0, 0]);
    loadCurrentStateSync(directories, locator);
    loadCurrentStateSync(directories, locator);
    const usage = cacheUsage();
    const archive = statePath(directories, locator);
    assert.equal(usage.chatRead.bytes, 5 * fs.statSync(chatPath(directories, locator)).size, 'parsed chat is estimated at five times its file');
    assert.ok(usage.sharedJson.bytes >= 5 * fs.statSync(archive).size && usage.sharedJson.bytes % 5 === 0);
    assert.equal(usage.writtenStates.bytes, 2 * fs.readFileSync(archive, 'utf8').length, 'saved text is counted at two bytes a character');
    assert.ok(usage.writtenStates.max <= 48 * 1024 * 1024 && usage.sharedJson.max === usage.chatRead.max);
    const big = path.join(directories.root, 'big.json');
    fs.writeFileSync(big, JSON.stringify({ blob: 'x'.repeat(Math.ceil(usage.sharedJson.max / 5) + 1024) }));
    const parsed = readJsonShared(big, null);
    assert.ok(cacheUsage().sharedJson.bytes > usage.sharedJson.max, 'one entry may exceed the budget');
    assert.equal(readJsonShared(big, null), parsed, 'and it is still cached for the next reader');
    reclaimMemory();
    assert.deepEqual(Object.values(cacheUsage()).map(entry => entry.bytes), [0, 0, 0]);
});

// The earlier eligibility rules, which scan every record and audit entry for each question, kept as the reference.
function scanningEligibility() {
    const content = record => {
        const copy = { ...record };
        for (const key of ['version', 'createdAt', 'provenance', 'inputRefs', 'origin', 'authorOverride', 'pinned', 'excluded',
            'status', 'significance', 'evidenceRefs', 'restoredOrigin']) delete copy[key];
        return hash(copy);
    };
    const revision = (state, id, version) => {
        const current = state.records.find(record => record.id === id);
        if (!current || current.version === version) return current;
        if (current.excluded || ['invalidated', 'deleted'].includes(current.status)) return null;
        const changes = state.audit.filter(entry => entry.recordId === id && entry.afterVersion > version);
        const previous = changes.find(entry => entry.before?.version === version)?.before;
        if (!previous) return null;
        return content(previous) === content(current) || changes.every(entry => entry.historical) ? previous : null;
    };
    const eligible = (state, record, { asOf = Infinity, includeExcluded = false } = {}, seen = new Set()) => {
        if (!record || record.storyId !== state.storyId || record.branchId !== state.branchId
            || record.asOf > asOf || ['invalidated', 'deleted'].includes(record.status)
            || (!includeExcluded && record.excluded) || seen.has(record.id + '@' + record.version)) return false;
        if (!record.refs.length || ![...record.refs, ...(record.evidenceRefs || [])].every(ref => sourceEligible(state, ref, asOf))) return false;
        if (!(record.inputRefs || []).every(ref => sourceEligible(state, ref))) return false;
        const next = new Set(seen).add(record.id + '@' + record.version);
        if (['knowledge', 'interview', 'overview'].includes(record.kind)) {
            const owners = state.records.filter(owner => owner.kind === 'entity' && owner.entityId === record.ownerId)
                .flatMap(owner => owner.asOf <= asOf ? [owner] : state.audit
                    .filter(entry => entry.recordId === owner.id && entry.before?.asOf <= asOf)
                    .map(entry => revision(state, owner.id, entry.before.version)));
            const owner = currentRecords(owners.filter(item => eligible(state, item, { asOf }, next)), item => item.entityId)[0];
            if (record.ownerId === 'player' || !owner?.isCharacter) return false;
        }
        return (record.dependencies || []).every(dependency => eligible(state, revision(state, dependency.id, dependency.version), { asOf, includeExcluded }, next));
    };
    const all = (state, options) => state.records.flatMap(record => {
        if (eligible(state, record, options)) return [record];
        if (!Number.isFinite(options?.asOf) || record.asOf <= options.asOf) return [];
        return state.audit.filter(entry => entry.recordId === record.id && entry.before?.asOf <= options.asOf)
            .map(entry => revision(state, record.id, entry.before.version)).filter(candidate => eligible(state, candidate, options))
            .sort((a, b) => b.asOf - a.asOf || b.version - a.version).slice(0, 1);
    });
    return { revision, eligible, all };
}

test('eligibility through lookups answers exactly as scanning every record and audit entry does', () => {
    const { state } = giftHistory();
    putRecord(state, { ...state.records.find(record => record.id === 'knowledge:gift'), text: 'Mara suspected the gift was pity.',
        origin: 'author', authorOverride: true, createdAt: Date.now() });
    putRecord(state, { ...state.records.find(record => record.id === 'event:gift'), excluded: true, origin: 'author', authorOverride: true, createdAt: Date.now() });
    state.records.find(record => record.kind === 'overview').status = 'invalidated';
    const reference = scanningEligibility();
    const everyVersion = [...state.records, ...state.audit.map(entry => entry.before).filter(Boolean)];
    assert.ok(state.audit.length >= 4 && everyVersion.length > state.records.length, 'a history with older versions');
    const key = record => record && record.id + '@' + record.version;
    for (const asOf of [Infinity, -1, 0, 1, 2, 3, 4, 5, 6, 9]) for (const includeExcluded of [false, true]) {
        const options = { asOf, includeExcluded };
        assert.deepEqual(eligibleRecords(state, options).map(key), reference.all(state, options).map(key), JSON.stringify(options));
        for (const record of everyVersion) assert.equal(recordEligible(state, record, options), reference.eligible(state, record, options), key(record) + JSON.stringify(options));
    }
    assert.deepEqual(eligibleRecords(state).map(key), reference.all(state).map(key));
    for (const record of state.records) for (const version of [0, 1, 2, 3, 4, 9]) {
        assert.equal(key(recordRevision(state, record.id, version)), key(reference.revision(state, record.id, version)), record.id + '@' + version);
    }
    assert.equal(recordRevision(state, 'missing', 1), reference.revision(state, 'missing', 1));
    // The same answers from the tables that eligibleRecords, inspection and a reply's context share.
    const lookups = eligibilityLookups(state);
    for (const options of [{}, { asOf: 2 }, { asOf: 5, includeExcluded: true }]) {
        for (const record of everyVersion) assert.equal(recordEligibleIn(state, lookups, record, options), reference.eligible(state, record, options), key(record));
    }
    for (const record of state.records) for (const version of [0, 1, 2, 3, 4, 9]) {
        assert.equal(key(recordRevisionIn(state, lookups, record.id, version)), key(reference.revision(state, record.id, version)), record.id + '@' + version);
    }
});

test('eligibility lookups are built once for a pass over many records and never for asking about one', () => {
    const { state } = giftHistory();
    const documents = searchDocuments(state, Infinity, { ...defaultConfig() }).filter(document => document.recordId);
    assert.ok(documents.length >= 4);
    // A caller that asks about one record at a time scans, as it always did: no table is built however often it asks.
    const builds = () => eligibilityStats.builds;
    const start = builds();
    for (let round = 0; round < 20; round++) for (const record of state.records) { recordEligible(state, record); recordRevision(state, record.id, 1); }
    assert.equal(builds() - start, 0);
    // One pass over every record builds one table set.
    const before = builds();
    eligibleRecords(state);
    assert.equal(builds() - before, 1);
    // One reply's context builds a few table sets (character references, overviews, names, the documents) and the
    // documents themselves share one: it does not grow with the number of memories offered.
    const crowded = Array.from({ length: 40 }, () => documents).flat();
    const small = builds();
    assembleContext(state, documents, { counter, memoryTokens: 100000 });
    const forSmall = builds() - small;
    const large = builds();
    assembleContext(state, crowded, { counter, memoryTokens: 100000 });
    const perExtraDocument = (builds() - large - forSmall) / (crowded.length - documents.length);
    assert.ok(forSmall <= 4 + 2 * documents.filter(document => ['interview', 'overview'].includes(document.kind)).length, 'builds for a reply: ' + forSmall);
    // Only an interview or overview asks for the overviews again (two passes each); plain memories add none.
    assert.ok(perExtraDocument <= 2, 'builds per extra document: ' + perExtraDocument);
    const plain = documents.filter(document => !['interview', 'overview'].includes(document.kind));
    const base = builds();
    assembleContext(state, Array.from({ length: 80 }, () => plain).flat(), { counter, memoryTokens: 100000 });
    assert.ok(builds() - base <= 4, 'eighty plain memories build ' + (builds() - base));
});

function batchConfig(directories, { batchMessages = 4, pawspective = false } = {}) {
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    config.roles.pawspective.enabled = pawspective;
    config.batchMessages = batchMessages;
    config.autoUpdate = false;
    saveConfig(directories, config);
    return config;
}

const emptyExtraction = { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } };

test('while a model request is out, a batch holds the text only of the sources it sent', async t => {
    const { directories } = disk(t, bulkMessages(30));
    batchConfig(directories);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    let held;
    let seen;
    processingHooks.beforeModelRequest = state => { held = state; };
    t.after(() => { processingHooks.beforeModelRequest = null; });
    await processBatch(directories, locator, {}, async (_directories, _config, _role, _contract, input) => {
        const sent = new Set(input.sources.map(source => source.id));
        const revisions = ([id]) => held.sources[id].revisions;
        const unsent = Object.entries(held.sources).filter(([id]) => !sent.has(id));
        seen = {
            sent: sent.size, unsent: unsent.length,
            textInUnsent: unsent.flatMap(revisions).filter(revision => ['text', 'storyText', 'trackerOutputs'].some(key => key in revision)).length,
            revisionsKept: unsent.flatMap(revisions).every(revision => typeof revision.hash === 'string' && Number.isInteger(revision.sequence) && typeof revision.enabled === 'boolean'),
            textInSent: [...sent].every(id => held.sources[id].revisions.every(revision => typeof revision.text === 'string')),
            vectors: Object.hasOwn(held.index, 'vectors'),
            memory: Array.isArray(held.records) && Array.isArray(held.audit) && held.castHistory !== undefined,
        };
        return emptyExtraction;
    });
    assert.deepEqual(seen, { sent: 5, unsent: 26, textInUnsent: 0, revisionsKept: true, textInSent: true, vectors: false, memory: true });
    assert.equal(pendingSources(await loadCurrentState(directories, locator), readConfig(directories)).length, 26, 'and the batch still completes');
});

test('a worker running several batches holds nothing of the previous batch while the next model request is out', async t => {
    const v8 = await import('node:v8');
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose_gc');
    const collect = vm.runInNewContext('gc');
    const { directories } = disk(t, bulkMessages(30));
    batchConfig(directories);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const results = [];
    processingHooks.afterBatch = result => { results.push(new WeakRef(result)); };
    t.after(() => { processingHooks.afterBatch = null; });
    let requests = 0;
    let released = null;
    await startProcessing(directories, locator, { all: true, checkpoint: true }, async () => {
        requests++;
        if (requests === 3) {
            await new Promise(resolve => setImmediate(resolve));
            collect(); collect();
            released = results.slice(0, 2).map(reference => reference.deref() === undefined);
        }
        return emptyExtraction;
    });
    await waitForProcessing(directories, locator);
    assert.ok(requests >= 3);
    assert.deepEqual(released, [true, true], 'earlier batches are not kept alive by the worker');
});

test('recall builds passage documents only for what it can rank, and builds the rest when the selector asks for evidence', async t => {
    const { directories } = disk(t);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; event(state); });
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    Object.assign(config.roles.selector, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'selector' });
    saveConfig(directories, config);
    const complete = { status: 'complete', selections: [], rejections: [], needsEvidence: [] };
    const built = [];
    let requests = 0;
    const call = async (_directories, _config, role, _contract, input) => {
        built.push(searchStats.passageDocuments);
        requests++;
        const value = requests === 1 && input.candidates.length ? { ...complete, status: 'needs_evidence', needsEvidence: [input.candidates[0].recordId] } : complete;
        return { value, usage: { role } };
    };
    const start = searchStats.passageDocuments;
    await recall(directories, locator, { query: 'gift' }, { call, scheduleBackground: false });
    assert.equal(requests, 2, 'the selector asked for evidence');
    assert.equal(built[0] - start, 0, 'no passage document was built to put the first question to the selector');
    assert.ok(built[1] - start > 0, 'the passages were built when the evidence was wanted');
    // Switching passages on offers them, so they are built up front.
    saveConfig(directories, { ...readConfig(directories), retrieval: { ...readConfig(directories).retrieval, includePassages: true } });
    built.length = 0;
    requests = 5;
    const before = searchStats.passageDocuments;
    await recall(directories, locator, { query: 'gift' }, { call, scheduleBackground: false });
    assert.ok(built[0] - before > 0);
});

test('stamps cover a group chat: its folder of groups, each group file and its members\' cards', async t => {
    const group = normalizeLocator({ group: true, chat: 'Group' });
    const { directories } = disk(t);
    const { write: writeCard } = await import('../src/character-card-parser.js');
    const png = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));
    for (const name of ['Mara', 'Kit']) fs.writeFileSync(path.join(directories.characters, name + '.png'), writeCard(png, JSON.stringify({ name, description: name + ' card' })));
    fs.writeFileSync(chatPath(directories, group), [{ chat_metadata: {} }, ...bulkMessages(80)].map(row => JSON.stringify(row)).join('\n'));
    const groupFile = path.join(directories.groups, 'group.json');
    writeJson(groupFile, { id: 'group', chat_id: group.chat, members: ['Mara.png'] });
    const members = () => loadCurrentStateSync(directories, group).contextSources.filter(ref => ref.id.startsWith('character:') && ref.id !== 'character:player').length;
    const full = () => countWork(() => loadCurrentStateSync(directories, group)).counts.stringifyCalls >= 80;
    assert.equal(members(), 1);
    assert.equal(full(), false, 'unchanged: the shortcut');
    // Edited in place, so the folder itself does not change: only the file's own stamp can tell.
    fs.writeFileSync(groupFile, JSON.stringify({ id: 'group', chat_id: group.chat, members: ['Mara.png', 'Kit.png'] }));
    assert.equal(full(), true, 'a changed group file reconciles');
    assert.equal(members(), 2);
    assert.equal(full(), false);
    writeJson(path.join(directories.groups, 'another.json'), { id: 'another', chat_id: 'Elsewhere', chats: [group.chat], members: ['Kit.png'] });
    assert.equal(full(), true, 'a new group file in the folder reconciles');
    assert.equal(full(), false);
    fs.rmSync(groupFile);
    assert.equal(full(), true, 'a removed group file reconciles');
    assert.equal(members(), 1);
    assert.equal(full(), false);
});

test('a chat with saved tracker results from before the category snapshot still takes the shortcut, and notices a change to the Agent library', async t => {
    const { COMPANION_RESULTS_EXTRA_KEY } = await import('../public/scripts/extensions/in-chat-agents/companion/companion-shared.js');
    const messages = bulkMessages(80);
    messages[3].extra = { [COMPANION_RESULTS_EXTRA_KEY]: { 'tpl-achievements-tracker': { status: 'done', content: 'Achievement unlocked: patience', agentName: 'Achievements' } } };
    const { directories } = disk(t, messages);
    const agents = path.join(directories.root, 'InChatAgents');
    fs.mkdirSync(agents, { recursive: true });
    const template = JSON.parse(fs.readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/achievements-tracker.json', import.meta.url), 'utf8'));
    const agentFile = path.join(agents, 'tpl-achievements-tracker.json');
    const trackerText = state => JSON.stringify(state.sources[state.timeline[3].id].revisions.at(-1));
    const full = () => countWork(() => loadCurrentStateSync(directories, locator)).counts.stringifyCalls >= 80;
    assert.doesNotMatch(trackerText(loadCurrentStateSync(directories, locator)), /Achievement unlocked/, 'without the agent the note is not a tracker note');
    loadCurrentStateSync(directories, locator);
    assert.equal(full(), false, 'unchanged: the shortcut, although the chat has legacy tracker results');
    fs.writeFileSync(agentFile, JSON.stringify(template));
    assert.equal(full(), true, 'adding the agent to the library reconciles');
    assert.match(trackerText(loadCurrentStateSync(directories, locator)), /Achievement unlocked/);
    assert.equal(full(), false);
    fs.writeFileSync(agentFile, JSON.stringify({ ...template, category: 'companion' }));
    assert.equal(full(), true, 'editing it reconciles');
    assert.equal(full(), false);
    fs.rmSync(agentFile);
    assert.equal(full(), true, 'removing it reconciles');
});

test('a file stamped after it was read is trusted only once it was quiet before the read began, and a mismatch is never trusted', t => {
    const { directories } = disk(t, bulkMessages(80));
    directories.files = path.join(directories.root, 'user/files');
    fs.mkdirSync(directories.files, { recursive: true });
    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { attachments: [{ url: '/user/files/note.txt' }] } });
    const noteFile = path.join(directories.files, 'note.txt');
    const full = () => countWork(() => loadCurrentStateSync(directories, locator)).counts.stringifyCalls >= 80;
    fs.writeFileSync(noteFile, 'Fresh note');
    loadCurrentStateSync(directories, locator);
    assert.equal(full(), true, 'a file written just before the read could have been replaced during it: no shortcut yet');
    letFilesSettle();
    loadCurrentStateSync(directories, locator);
    assert.equal(full(), false, 'once the file has been quiet, the shortcut');
    // A stamp that does not describe the file that was read is dropped.
    fs.writeFileSync(noteFile, 'Another note');
    letFilesSettle();
    const identity = fs.statSync;
    t.mock.method(fs, 'statSync', (filename, options) => {
        const stat = identity.call(fs, filename, options);
        return options?.bigint && String(filename).endsWith('note.txt') ? { ...stat, ino: stat.ino + 1n, isFile: () => true } : stat;
    });
    loadCurrentStateSync(directories, locator);
    t.mock.restoreAll();
    assert.equal(full(), true, 'the mismatch left nothing to trust');
});

test('the periodic safety pass of the worker reconciles from scratch instead of taking the shortcut', async t => {
    const { directories } = disk(t, bulkMessages(80));
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    config.autoUpdate = true;
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        syncSources(state, bulkMessages(80), []);
        for (const ref of state.timeline) state.checkpoints[refKey(ref)] = processingVersion(config);
    });
    await loadCurrentState(directories, locator);
    await loadCurrentState(directories, locator);
    const call = async () => assert.fail('nothing is waiting to be read');
    const loadsDuring = async () => (await countWork(() => scanProcessing(directories, call))).counts.stringifyCalls;
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    await scanProcessing(directories, call);
    assert.ok(await loadsDuring() < 40, 'a second pass right away skips the story');
    now += 5 * 60_000;
    assert.ok(await loadsDuring() < 40, 'five minutes later it still does');
    now += 11 * 60_000;
    assert.ok(await loadsDuring() >= 80, 'after ten minutes the safety pass hashes every message even though no input changed');
});

test('every Mewmory route, a batch, recall and indexing only read the shared state, which stays deeply frozen', async t => {
    const messages = structuredClone(fixture.messages);
    let next = 0;
    ensureMewmoryMessageIds(messages, () => 'frozen-' + next++);
    const { directories } = disk(t, messages);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    config.batchMessages = 3;
    for (const [name, role] of Object.entries(config.roles)) Object.assign(role, { enabled: true, endpoint: provider.url, model: name });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    const gift = giftHistory().state;
    mutateState(directories, locator, state => {
        for (const key of ['records', 'audit', 'overrides', 'castHistory', 'sceneNpcIds']) state[key] = structuredClone(gift[key]);
        state.enabled = true;
    });
    const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); } };
    sharedJsonHooks.onParse = freeze;
    t.after(() => { sharedJsonHooks.onParse = null; });
    const errors = [];
    t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
    const express = (await import('express')).default;
    const { router } = await import('../src/endpoints/mewmory.js');
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use((request, response, next) => { request.user = { directories, profile: { handle: 'default-user' } }; next(); });
    app.use(router);
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const post = async (route, body = {}) => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locator, ...body }) });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    const inspect = async () => (await post('/inspect')).body;
    const statuses = {};
    const run = async (route, body) => { statuses[route] = (await post(route, typeof body === 'function' ? body(await inspect()) : body)).status; };
    for (const [route, body] of [
        ['/config/get'], ['/inspect'], ['/duplicates'], ['/story'], ['/lore'], ['/export'], ['/export/markdown'], ['/estimate'], ['/validate', { fingerprint: 'x' }],
        ['/character', { entityId: 'npc:mara' }], ['/record/history', { id: 'event:gift' }], ['/message', { index: 2 }], ['/shared'],
        ['/source/get', current => ({ ref: current.sources[0] })],
        ['/search', { query: 'gift', mode: 'keyword' }], ['/search', { query: 'gift', mode: 'hybrid' }],
        ['/recall', { query: 'gift' }], ['/tokens', { texts: ['one two'] }], ['/ask', { question: 'What did Mara do with the gift?' }], ['/conflicts'],
        ['/prepare', { history: [{ index: 0, text: 'hello' }], tokenizer: {} }],
        ['/share', { ids: ['event:gift'] }],
        ['/scene', current => ({ revision: current.revision, activeNpcIds: null })],
        ['/review/seen', current => ({ revision: current.revision })],
        ['/record/action', current => ({ revision: current.revision, id: 'event:gift', action: 'pin' })],
        ['/record/action', current => ({ revision: current.revision, id: 'event:gift', action: 'pin' })],
        ['/source/exclude', current => ({ revision: current.revision, id: current.sources[0].id, exclude: true })],
        ['/source/exclude', current => ({ revision: current.revision, id: current.sources[0].id, exclude: false })],
        ['/record/merge', current => ({ revision: current.revision, keep: 'event:gift', ids: ['event:gift', 'knowledge:gift'] })],
        ['/index', {}], ['/process', { all: true, background: true }], ['/process/cancel'], ['/restore', current => ({ revision: current.revision, backup: { format: 'mewmory-export-1', state: current }, apply: false })],
    ]) await run(route, body);
    await recall(directories, locator, { query: 'gift' }, { call: async (_d, _c, role) => ({ value: { status: 'complete', selections: [], rejections: [], needsEvidence: [] }, usage: { role } }), scheduleBackground: false });
    await waitForProcessing(directories, locator);
    // Not one request hit a TypeError for editing a frozen object, and the routes that need no model answered.
    assert.deepEqual(errors.filter(line => /TypeError|read only|not extensible|Cannot (add|assign|delete)/.test(line)), []);
    for (const route of ['/inspect', '/duplicates', '/story', '/lore', '/export', '/export/markdown', '/estimate', '/character', '/record/history', '/message', '/shared', '/source/get', '/search', '/scene', '/review/seen', '/record/action', '/source/exclude']) {
        assert.equal(statuses[route], 200, route);
    }
    assert.ok(Object.keys(statuses).length >= 30);
});

test('a background recall keeps the index it found when nothing touched it and respects a reset made while it picked', async t => {
    const { directories } = disk(t);
    const provider = await createMewmoryProvider();
    t.after(() => new Promise(resolve => provider.server.close(resolve)));
    const config = defaultConfig();
    config.writerTokenizer = 'cl100k_base';
    Object.assign(config.roles.embedding, { enabled: true, endpoint: provider.url, model: 'embedding' });
    Object.assign(config.roles.selector, { enabled: true, endpoint: provider.url, model: 'selector' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    const indexed = mutateState(directories, locator, state => { state.enabled = true; event(state); });
    await updateIndex(indexed, directories, readConfig(directories));
    mutateState(directories, locator, () => indexed, indexed.revision);
    const stored = () => Object.keys(readStateShared(directories, locator).index.vectors).length;
    const before = stored();
    assert.ok(before > 0);
    const pick = changeIndex => async (_directories, _config, role) => {
        changeIndex?.();
        return { value: { status: 'complete', selections: [], rejections: [], needsEvidence: [] }, usage: { role } };
    };
    const recallWith = changeIndex => recall(directories, locator, { background: true, query: 'gift' }, { call: pick(changeIndex), scheduleBackground: false });
    await recallWith();
    assert.equal(stored(), before, 'an index nobody touched is kept');
    await recallWith(() => mutateState(directories, locator, state => { state.index = { version: '', vectors: {}, pending: true }; }));
    assert.equal(stored(), 0, 'a reset made during the pick is not undone by the older snapshot');
});
