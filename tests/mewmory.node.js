/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const {
    continueState, eligibleRecords, forkState, hash, newState, putRecord, recordEligible,
    sourceAt, syncSources, undoRecord, validateRecord,
} = await import('../src/mewmory/core.js');
const { activeReferences, assembleContext } = await import('../src/mewmory/context.js');
const { callJsonRole, defaultConfig, embed, isLocalEndpoint, validateEndpoint, saveConfig } = await import('../src/mewmory/models.js');
const { applyExtraction, applyInterview, interviewInput, pendingSources, processBatch } = await import('../src/mewmory/processing.js');
const { validateSelection, recall } = await import('../src/mewmory/retrieval.js');
const { hybridCandidates, lexicalSearch, searchDocuments, updateIndex } = await import('../src/mewmory/search.js');
const { loadCurrentState } = await import('../src/mewmory/sources.js');
const { mutateState, normalizeLocator, readState, renameChatMemory, renameCharacterMemory, removeChatMemory, removeSourceMemory, statePath, writeJson } = await import('../src/mewmory/store.js');
const { getCounter, getTokenizerModel } = await import('../src/mewmory/tokens.js');
const { inspectState, restoreRecords } = await import('../src/endpoints/mewmory.js');
const { createMewmoryProvider } = await import('./mewmory-provider.js');
const { readConfig, publicConfig } = await import('../src/mewmory/models.js');

test('connection profiles resolve server-side and retain local-only permissions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-profiles-'));
    const provider = await createMewmoryProvider();
    const directories = { root };
    try {
        writeJson(path.join(root, 'settings.json'), { extension_settings: { connectionManager: { profiles: [
            { id: 'local', name: 'Local facts', api: 'custom', 'api-url': provider.url, model: 'extractor' },
            { id: 'remote', name: 'Remote facts', api: 'openai', model: 'gpt-4o' },
        ] } } });
        const config = defaultConfig();
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
        assert.throws(() => saveConfig(directories, saved), /not allowed/);
        writeJson(path.join(root, 'settings.json'), {});
        assert.throws(() => readConfig(directories), /no longer exists/);
        assert.equal(publicConfig(directories).roles.extractor.profileId, 'local');
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
    assert.throws(() => saveConfig(directories, invalid), /Facts and events:.*Role context/);
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

test('claims stay reported; a temporary disguise never replaces stable appearance; extractor cannot write an interview', () => {
    const state = base();
    const refs = [state.timeline[2]];
    applyExtraction(state, { records: [
        { id: 'event:claim', kind: 'event', text: 'Mara said she did not need pity.', refs, evidenceStatus: 'reported', subjectIds: ['gift'] },
        { id: 'state:disguise', kind: 'state', entityId: 'npc:mara', text: 'Wearing a red cloak as a disguise.', refs, subjectIds: ['npc:mara'] },
    ], interviews: [], activeNpcIds: ['npc:mara'] }, { asOf: 2, sources: refs.map(ref => ({ ...ref, type: 'chat' })) });
    assert.equal(state.records.find(record => record.id === 'event:claim').evidenceStatus, 'reported');
    assert.equal(state.records.find(record => record.id === 'entity:mara').appearance, fixture.expectations.appearance);
    assert.throws(() => applyExtraction(state, { records: [{ id: 'bad', kind: 'interview' }], interviews: [], activeNpcIds: [] },
        { asOf: 2, sources: [] }), /invalid or duplicate/);
});

test('character interviews receive acquired knowledge, not source-wide or future secrets; player owners are rejected', () => {
    const { state } = giftHistory();
    const input = interviewInput(state, { ownerId: 'npc:mara', subjectIds: ['gift'], knowledgeIds: ['knowledge:gift'] }, 2);
    const serialized = JSON.stringify(input);
    assert.equal(serialized.includes('SECRET:'), false);
    assert.equal(serialized.includes('purchase date'), false);
    assert.equal(serialized.includes('knowledge:receipt'), false);
    assert.throws(() => interviewInput(state, { ownerId: 'player', subjectIds: ['gift'], knowledgeIds: ['knowledge:gift'] }, 2), /owner/);
    assert.throws(() => interviewInput(state, { ownerId: 'npc:mara', subjectIds: ['gift'], knowledgeIds: ['knowledge:receipt'] }, 2), /actually learned/);
});

test('synthetic gestures remain subjective, and old matches bring the present overview and change', () => {
    const { state, original, current } = giftHistory();
    assert.equal(state.records.filter(record => record.kind === 'event').some(record => record.text.includes('armchair')), false);
    assert.throws(() => validateRecord(state, {
        id: 'event:synthetic', kind: 'event', text: 'Mara gripped an armchair in the scene.', refs: original.refs,
        dependencies: [{ id: original.id, version: original.version }], subjectIds: ['gift'],
    }, { asOf: 2, origin: 'objective_extractor' }), /characterization/);
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
    }), /no longer eligible/);
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
    putRecord(state, { ...original, id: 'event:duplicate', text: 'Bad duplicate rewrite.' }, { automatic: true });
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

test('deletion removes source text from older audit copies and prepared previews', () => {
    const state = base();
    const old = event(state, { text: 'UNIQUE DELETED MEMORY' });
    putRecord(state, { ...old, text: 'Independent replacement.', refs: [state.timeline[4]], authorOverride: true, asOf: 4 });
    state.preview = { memoryText: 'UNIQUE DELETED MEMORY' };
    syncSources(state, fixture.messages.filter((_, index) => index !== 2), fixture.lore);
    assert.equal(JSON.stringify(state).includes('UNIQUE DELETED MEMORY'), false);
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

test('HTTP preparation excludes only preserved old chat and retains it on checkpoint failure', async t => {
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
            body: JSON.stringify({ locator, integrity: 'fixture', history: messages.map((message, index) => ({ index, text: message.mes })) }),
        });
        const value = await response.json();
        assert.equal(response.status, 200, JSON.stringify(value));
        return value;
    };
    const original = fs.readFileSync(filename, 'utf8');
    provider.mode.fail = true;
    const failed = await prepare();
    assert.deepEqual(failed.excludedIndices, []);
    assert.ok(failed.history.waitingForPreservation);
    assert.deepEqual(readState(directories, locator).checkpoints, {});
    provider.mode.fail = false;
    const preserved = await prepare();
    assert.ok(preserved.excludedIndices.length > 0);
    assert.ok(preserved.history.retainedTokens <= 1024);
    assert.equal(fs.readFileSync(filename, 'utf8'), original);
    assert.ok(searchDocuments(readState(directories, locator)).some(document => document.text.includes('Harbour continuity detail 0')));
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
