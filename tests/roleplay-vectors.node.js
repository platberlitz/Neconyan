/* eslint playwright/expect-expect: off -- Native job and source proofs use node:assert. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { captureGenerationBinding } = await import('../src/generation/profiles.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { recoverWaitingRoleplayVectors } = await import('../src/generation/roleplay-vectors.js');
const { getJob, releaseJob, updateJob, acceptJob, attachOwnedChild, requestCancellation } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { admitOperation, finalizeOperation } = await import('../src/operations/store.js');
const { runOperation } = await import('../src/operations/jobs.js');
await import('../src/operations/vectors.js');

function prepared(t) {
    const f = fixture(t);
    const directories = f.scope.directories;
    directories.vectors = path.join(directories.root, 'vectors');
    directories.worlds = path.join(directories.root, 'worlds');
    fs.mkdirSync(directories.worlds);
    const records = structuredClone(f.records);
    records[1].mes = 'A forgotten garden'; records[1].extra = {};
    records[2].mes = 'Tell me more'; records[2].swipes[0] = records[2].mes;
    fs.writeFileSync(f.filename, records.map(row => JSON.stringify(row)).join('\n') + '\n');
    fs.writeFileSync(path.join(directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        7: { key: ['never matches the chat'], content: 'Vector-selected lore', vectorized: true, position: 0, order: 1 },
    } }));
    const preset = JSON.parse(fs.readFileSync(new URL('../default/content/presets/openai/Default.json', import.meta.url)));
    const settings = { main_api: 'openai', _settingsRevision: 1,
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { ...preset, openai_max_context: 8192, chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'fixture' },
        power_user: { custom_stopping_strings: '[]' },
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
        textgenerationwebui_settings: { server_urls: { llamacpp: 'https://vectors.example.test' } },
        extension_settings: { vectors: { source: 'llamacpp', enabled_chats: true, enabled_world_info: true,
            protect: 1, insert: 2, score_threshold: 0.5, max_entries: 1, template: 'Remembered: {{text}}' } } };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const binding = captureGenerationBinding(directories, { kind: 'active' }, { settingsRevision: 1 });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 4096, serverPrompt: true });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'vector-reply', effect: 'append', source,
        request: { serverPrompt: true, messages: [], binding, maxTokens: 100, characterName: 'Nova', worldInfo } });
    releaseJob(directories, jobId);
    const context = id => ({ owner: f.scope.owner, directories, job: getJob(directories, id), signal: new AbortController().signal, progress: async () => {} });
    return { f, directories, source, account, binding, worldInfo, jobId, context, records };
}

test('a native reply parks for its vector child, then uses retained retrieval and lore without deleting history', async t => {
    const p = prepared(t);
    let generationCalls = 0;
    const generate = async ({ messages, beforeDispatch }) => {
        beforeDispatch(); generationCalls++;
        assert.ok(messages.some(row => typeof row.content === 'string' && /Remembered:.*A forgotten garden/s.test(row.content)));
        assert.ok(messages.some(row => typeof row.content === 'string' && row.content.includes('Vector-selected lore')));
        assert.equal(messages.some(row => row.role === 'user' && row.content === 'A forgotten garden'), false);
        return { text: 'A durable reply' };
    };
    const waiting = await runRoleplayReplyJob(p.context(p.jobId), { generate });
    assert.equal(waiting.waiting, true);
    assert.equal(generationCalls, 0);
    assert.equal(getJob(p.directories, p.jobId).state, 'waiting');
    const child = getJob(p.directories, waiting.childJobId);
    assert.equal(child.parentId, p.jobId);
    let vectorCalls = 0;
    await runOperation(p.context(child.id), { fetchImpl: async (_url, init) => {
        vectorCalls++;
        assert.deepEqual(readRoleplayChat(p.f.scope, p.f.locator).records, p.records);
        return new Response(JSON.stringify({ data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 0] })) }));
    } });
    updateJob(p.directories, child.id, { state: 'completed' });
    recoverWaitingRoleplayVectors(p.context(p.jobId));
    await runRoleplayReplyJob(p.context(p.jobId), { generate });
    const saved = readRoleplayChat(p.f.scope, p.f.locator).records;
    assert.deepEqual(saved.slice(1, -1), p.records.slice(1));
    assert.equal(saved[0].unknown, true);
    assert.equal(saved.at(-1).mes, 'A durable reply');
    assert.equal(generationCalls, 1);
    assert.equal(vectorCalls, 3);
    assert.ok(readArtifact(p.directories, p.jobId, 'roleplay-prompt').vectorsHash);
    await runRoleplayReplyJob(p.context(p.jobId), { generate: async () => assert.fail('A completed reply cannot repeat') });
});

test('an uncertain vector child cannot silently retry embeddings or dispatch the parent model', async t => {
    const p = prepared(t);
    let generationCalls = 0;
    const generate = async () => { generationCalls++; return { text: 'Must not run' }; };
    const waiting = await runRoleplayReplyJob(p.context(p.jobId), { generate });
    let vectorCalls = 0;
    const deps = { fetchImpl: async () => { vectorCalls++; throw new Error('Connection lost'); } };
    await assert.rejects(runOperation(p.context(waiting.childJobId), deps), /Connection lost/);
    updateJob(p.directories, waiting.childJobId, { state: 'interrupted' });
    recoverWaitingRoleplayVectors(p.context(p.jobId));
    assert.equal(getJob(p.directories, p.jobId).state, 'interrupted');
    updateJob(p.directories, p.jobId, { state: 'queued', error: null });
    await assert.rejects(runRoleplayReplyJob(p.context(p.jobId), { generate }), /explicit recovery/);
    await assert.rejects(runOperation(p.context(waiting.childJobId), deps), /unknown|interrupted/i);
    assert.equal(vectorCalls, 1);
    assert.equal(generationCalls, 0);
    assert.deepEqual(readRoleplayChat(p.f.scope, p.f.locator).records, p.records);
});

test('unattached vector admissions remain paused and cancellation reaches owned grandchildren', t => {
    const p = prepared(t);
    const parent = getJob(p.directories, p.jobId);
    const owned = admitOperation(p.f.scope, p.account, { key: 'orphan', kind: 'vectors', input: {},
        plan: { ownerJob: { id: parent.id, intentHash: roleplayHash(parent.intent) } } });
    finalizeOperation(p.context(owned.job.id));
    assert.equal(getJob(p.directories, owned.job.id).stage, 'preparing');
    attachOwnedChild(p.directories, parent.id, owned.job.id,
        { parentIntentHash: roleplayHash(parent.intent), childIntentHash: roleplayHash(owned.job.intent) });
    finalizeOperation(p.context(owned.job.id));
    assert.equal(getJob(p.directories, owned.job.id).state, 'queued');
    const root = acceptJob(p.directories, { owner: p.f.scope.owner, type: 'media.roleplay-workflow', submissionKey: 'family', intent: {} }).job;
    attachOwnedChild(p.directories, root.id, parent.id,
        { parentIntentHash: roleplayHash(root.intent), childIntentHash: roleplayHash(parent.intent) });
    requestCancellation(p.directories, root.id);
    assert.equal(getJob(p.directories, parent.id).cancellation.requested, true);
    assert.equal(getJob(p.directories, owned.job.id).cancellation.requested, true);
    assert.equal(getJob(p.directories, owned.job.id).state, 'cancelled');
});
