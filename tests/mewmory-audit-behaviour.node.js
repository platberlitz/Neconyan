/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { continueState, forkState, newState, refKey, syncSources } = await import('../src/mewmory/core.js');
const { defaultConfig, readConfig, saveConfig } = await import('../src/mewmory/models.js');
const { pendingSources, processBatch, processingVersion } = await import('../src/mewmory/processing.js');
const { applyOverflowHiding } = await import('../src/mewmory/hiding.js');
const { buildBranchMemoryState, mutateState, normalizeLocator, readState, writeJson } = await import('../src/mewmory/store.js');
const { loadCurrentState } = await import('../src/mewmory/sources.js');
const { startOperation, registerMewmoryOperations } = await import('../src/mewmory/operations.js');
const { getJob, listJobs } = await import('../src/jobs/store.js');
const { setDirectoriesResolver, testExports: jobRunner } = await import('../src/jobs/runner.js');

const locator = { avatar: 'Mara.png', chat: 'Gift', group: false };

function disk(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-audit-'));
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const directories = Object.fromEntries(['chats', 'groupChats', 'groups', 'worlds', 'characters', 'files']
        .map(name => [name, path.join(root, name)]));
    directories.root = root;
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(path.join(directories.chats, 'Mara'), { recursive: true });
    writeJson(path.join(root, 'settings.json'), {});
    return { root, directories, filename: path.join(directories.chats, 'Mara', 'Gift.jsonl') };
}

function writeChat(fixture, messages) {
    fs.writeFileSync(fixture.filename, [{ chat_metadata: {} }, ...messages].map(value => JSON.stringify(value)).join('\n'));
}

function message(text, { user = false, id = '' } = {}) {
    return { name: user ? 'You' : 'Mara', is_user: user, send_date: id || text, mewmory_id: id || text, mes: text };
}

async function enableChat(directories) {
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
}

function extractorConfig() {
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    return config;
}

test('G1 a disabled Pawspective role does not discard extracted facts', async t => {
    const messages = [
        message('I hand Mara the silver key to the harbour gate.', { user: true, id: 'm1' }),
        message('Mara turns the silver key over and pockets it.', { id: 'm2' }),
    ];
    const fixture = disk(t);
    writeChat(fixture, messages);
    const config = extractorConfig();
    config.roles.pawspective.enabled = false;
    saveConfig(fixture.directories, config);
    await enableChat(fixture.directories);

    const calls = [];
    const call = async (_directories, _config, role, _contract, input) => {
        calls.push(role);
        if (role !== 'extractor') throw new Error('Pawspective was called while it was switched off.');
        const chat = input.sources.filter(source => source.type === 'chat');
        const [first, second] = chat;
        return {
            value: {
                records: [
                    { id: 'entity:mara', kind: 'entity', entityId: 'npc:mara', name: 'Mara', text: 'Mara keeps the harbour gate.',
                        isCharacter: true, refs: [{ id: second.id, revision: second.revision }], subjectIds: ['npc:mara'] },
                    { id: 'knowledge:key', kind: 'knowledge', ownerId: 'npc:mara', method: 'witnessed',
                        text: 'Mara knows she holds the silver key.', evidenceText: 'I hand Mara the silver key',
                        refs: [{ id: first.id, revision: first.revision }], subjectIds: ['player'] },
                ],
                interviews: [{ ownerId: 'npc:mara', subjectIds: ['player'], knowledgeIds: ['knowledge:key'],
                    refs: [{ id: first.id, revision: first.revision }, { id: second.id, revision: second.revision }], reason: 'Trust shifts.' }],
                activeNpcIds: ['npc:mara'],
            },
            usage: { role },
        };
    };

    const state = await processBatch(fixture.directories, locator, {}, call);
    assert.deepEqual(calls, ['extractor'], 'the disabled interview role is never dispatched');
    assert.ok(state.records.some(record => record.id === 'entity:mara'));
    assert.ok(state.records.some(record => record.id === 'knowledge:key'));
    assert.equal(state.records.some(record => record.kind === 'interview'), false);
    assert.equal(state.jobs.at(-1).status, 'complete');
    assert.equal(pendingSources(state, readConfig(fixture.directories)).length, 0, 'the extracted messages count as processed');
});

async function markedHidingFixture(t, { excludeHistory, channel }) {
    const messages = [
        message('a'.repeat(20), { user: true, id: 'h1' }),
        message('b'.repeat(20), { id: 'h2' }),
        message('c'.repeat(20), { user: true, id: 'h3' }),
        message('latest reply', { id: 'h4' }),
    ];
    const fixture = disk(t);
    writeChat(fixture, messages);
    const config = extractorConfig();
    config.excludeHistory = excludeHistory;
    saveConfig(fixture.directories, config);
    await enableChat(fixture.directories);
    mutateState(fixture.directories, locator, state => {
        syncSources(state, messages, []);
        const policy = processingVersion(readConfig(fixture.directories));
        const marks = channel === 'checkpoint' ? state.checkpoints : state.coverage;
        for (const ref of state.timeline) marks[refKey(ref)] = policy;
    });
    const records = [{ chat_metadata: {} }, ...structuredClone(messages)];
    return { fixture, records, policy: { limit: 15, count: value => value.length, directories: fixture.directories, locator } };
}

test('G2 token hiding reads processed marks when history exclusion is off', async t => {
    const processed = await markedHidingFixture(t, { excludeHistory: false, channel: 'coverage' });
    const hidden = applyOverflowHiding(processed.records, processed.policy);
    assert.equal(hidden.hidden, 3, 'every processed message before the latest reply may be hidden');
    assert.deepEqual(hidden.records.map(record => record.is_system ?? false), [false, true, true, true, false]);
    assert.equal(hidden.records.at(-1).mes, 'latest reply');
});

test('G2 a processed batch with history exclusion off leaves marks token hiding can use', async t => {
    const messages = [
        message('a'.repeat(20), { user: true, id: 'w1' }),
        message('b'.repeat(20), { id: 'w2' }),
        message('c'.repeat(20), { user: true, id: 'w3' }),
        message('latest reply', { id: 'w4' }),
    ];
    const fixture = disk(t);
    writeChat(fixture, messages);
    const config = extractorConfig();
    config.excludeHistory = false;
    saveConfig(fixture.directories, config);
    await enableChat(fixture.directories);

    await processBatch(fixture.directories, locator, { checkpoint: false }, async (_directories, _config, role) => ({
        value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role },
    }));
    const state = readState(fixture.directories, locator);
    assert.equal(Object.keys(state.checkpoints).length, 0);
    assert.equal(Object.keys(state.coverage).length, 4);

    const records = [{ chat_metadata: {} }, ...structuredClone(messages)];
    const policy = { limit: 15, count: value => value.length, directories: fixture.directories, locator };
    assert.equal(applyOverflowHiding(records, policy).hidden, 3);
});

test('G2 token hiding still requires checkpoint marks when history exclusion is on', async t => {
    const coverageOnly = await markedHidingFixture(t, { excludeHistory: true, channel: 'coverage' });
    assert.equal(applyOverflowHiding(coverageOnly.records, coverageOnly.policy).hidden, 0,
        'ordinary processed marks cannot stand in for preservation checkpoints');

    const checkpointed = await markedHidingFixture(t, { excludeHistory: true, channel: 'checkpoint' });
    assert.equal(applyOverflowHiding(checkpointed.records, checkpointed.policy).hidden, 3);
});

test('G2 a processed source edited after reading is not hidden', async t => {
    const processed = await markedHidingFixture(t, { excludeHistory: false, channel: 'coverage' });
    const edited = processed.records.map((record, index) => index === 1
        ? { ...record, mes: 'an agent rewrote this after Mewmory read it' } : record);
    assert.equal(applyOverflowHiding(edited, processed.policy).hidden, 0,
        'the new source revision has no processed mark yet');
});

test('G6 a branch or continuation does not inherit a failed message restoration', () => {
    const messages = [message('A shared first scene.', { user: true, id: 'b1' })];
    const parent = newState(locator);
    syncSources(parent, messages, []);
    parent.visibilityRestore = { status: 'failed', operationKey: 'restore-1', branchId: parent.branchId,
        account: { accountId: 'account', dataEpoch: 1 }, instanceId: 'instance-1' };

    const branchLocator = normalizeLocator({ ...locator, chat: 'Branch' });
    const child = forkState(parent, branchLocator, 0, messages);
    assert.equal(child.visibilityRestore, null);
    assert.equal(buildBranchMemoryState(parent, branchLocator, messages).visibilityRestore, null);

    const continuation = continueState(parent, normalizeLocator({ ...locator, chat: 'Continuation' }), messages);
    assert.equal(continuation.visibilityRestore, null);
    assert.equal(parent.visibilityRestore.status, 'failed', 'the parent keeps its own retry state');
});

test('G5 background recall and index refuse a disabled chat before accepting a job', async t => {
    const fixture = disk(t);
    writeChat(fixture, [message('A first scene.', { user: true, id: 'o1' })]);
    await loadCurrentState(fixture.directories, locator);
    assert.equal(readState(fixture.directories, locator).enabled, false);

    for (const [operation, body] of [
        ['index', { locator, reset: true, submissionKey: 'disabled-index' }],
        ['recall', { locator, query: 'first scene', submissionKey: 'disabled-recall' }],
    ]) {
        await assert.rejects(startOperation(fixture.directories, 'test', operation, body),
            error => error.status === 409 && error.message === 'Turn on Mewmory for this chat first.');
    }
    assert.equal(listJobs(fixture.directories, { owner: 'test', includeDismissed: true }).length, 0);
});

test('G5 a repeated submission still returns its accepted job after the chat is switched off', async t => {
    const fixture = disk(t);
    writeChat(fixture, [message('A first scene.', { user: true, id: 'o2' })]);
    await enableChat(fixture.directories);
    const body = { locator, reset: true, submissionKey: 'accepted-index' };
    const first = await startOperation(fixture.directories, 'test', 'index', body);
    assert.equal(first.created, true);
    mutateState(fixture.directories, locator, state => { state.enabled = false; });

    const repeated = await startOperation(fixture.directories, 'test', 'index', body);
    assert.equal(repeated.created, false);
    assert.equal(repeated.job.id, first.job.id);
});

test('G5 disabling after acceptance still fails the saved job at runtime', async t => {
    const fixture = disk(t);
    writeChat(fixture, [message('A first scene.', { user: true, id: 'o3' })]);
    await enableChat(fixture.directories);
    const accepted = await startOperation(fixture.directories, 'test', 'index',
        { locator, reset: true, submissionKey: 'runtime-disabled-index' });
    mutateState(fixture.directories, locator, state => { state.enabled = false; });

    let embeddings = 0;
    registerMewmoryOperations({ embedFn: async () => { embeddings++; return { vectors: [], usage: { role: 'embedding' } }; } });
    t.after(() => registerMewmoryOperations());
    setDirectoriesResolver(() => fixture.directories);
    await jobRunner.runJob(accepted.job);

    const failed = getJob(fixture.directories, accepted.job.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error.message, /changed before this could start/);
    assert.equal(embeddings, 0, 'no provider work starts for a chat switched off after acceptance');
});

test('G5 the direct index endpoint refuses a disabled chat before any work', async t => {
    const fixture = disk(t);
    writeChat(fixture, [message('A first scene.', { user: true, id: 'o4' })]);
    await loadCurrentState(fixture.directories, locator);
    mutateState(fixture.directories, locator, state => {
        state.index = { version: 'saved-version', vectors: { kept: { textHash: 'kept', vector: [1] } }, pending: false };
    });

    const express = (await import('express')).default;
    const { router } = await import('../src/endpoints/mewmory.js');
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => { request.user = { directories: fixture.directories }; next(); });
    app.use(router);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));

    const response = await fetch('http://127.0.0.1:' + server.address().port + '/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locator, reset: true, background: false }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'Turn on Mewmory for this chat first.');
    assert.equal(readState(fixture.directories, locator).index.version, 'saved-version', 'a refused request changes nothing');
});
