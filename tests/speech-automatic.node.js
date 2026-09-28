import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureChatProfile } = await import('../src/generation/profiles.js');
const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { createConversationNarrator } = await import('../src/generation/conversation-narration.js');
const { buildConversationParticipantSnapshot } = await import('../src/generation/conversation-participants.js');
const { captureConversationTarget, readConversationTarget, appendConversationJobMessage } = await import('../src/generation/conversation-effects.js');
const { acceptJob, getJob, recoverJobs, releaseJob, updateJob } = await import('../src/jobs/store.js');
const { providerStep, readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { pcmWave, readAudioArtifact } = await import('../src/jobs/audio-artifacts.js');
const { SECRET_KEYS, writeSecret } = await import('../src/endpoints/secrets.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');

const WAVE = pcmWave(Buffer.alloc(480, 1));
const audio = () => new Response(WAVE, { headers: { 'Content-Type': 'audio/wav' } });
const controls = { prompts: [
    { identifier: 'main', role: 'system', system_prompt: true, content: '' },
    { identifier: 'chatHistory', marker: true, system_prompt: true },
], prompt_order: [{ character_id: 100001, order: [
    { identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true },
] }] };

function accountFixture(t, { enabled = true, multiVoice = false } = {}) {
    const f = fixture(t);
    t.after(() => cancelAutoSaves());
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const directories = f.scope.directories;
    const branch = { id: 'main', name: 'Main', createdAt: 1,
        messages: [{ id: 'message-1', role: 'user', name: 'User', mes: 'Hello.', timestamp: 1 }] };
    const settings = {
        _version: 0, name1: 'User', power_user: {},
        world_info_settings: { world_info: { globalSelect: [], charLore: [] }, world_info_budget: 200 },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1' },
        extension_settings: {
            connectionManager: { profiles: [{ id: 'main', name: 'Main', api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:18000/v1' }] },
            tts: { enabled, auto_generation: true, currentProvider: 'OpenAI', playback_rate: 0.9,
                multi_voice_enabled: multiVoice, pass_asterisks: true,
                OpenAI: { model: 'gpt-4o-mini-tts', speed: 1.25, characterInstructions: { Nova: 'Speak as {{char}} to {{user}}.' },
                    voiceMap: multiVoice ? { 'Nova (*Text inside asterisks*)': 'alloy', 'Nova ("Quotes")': 'nova', 'Nova (Other text)': 'echo' } : { Nova: 'nova' } } },
            neconyan_conversation: { version: 1, settings: { connection_profile: 'main' }, groups: [], reminders: [],
                characters: { 'Nova.png': { settings: {}, activeBranchId: 'main', branches: { main: branch } } } },
        },
    };
    const settingsFile = path.join(directories.root, 'settings.json');
    const save = value => fs.writeFileSync(settingsFile, JSON.stringify(value));
    save(settings);
    writeSecret(directories, SECRET_KEYS.OPENAI, 'automatic-private-key');
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const binding = { kind: 'profile', ...captureChatProfile(directories, 'main') };
    const request = { user: { directories, profile: { handle: f.scope.owner } } };
    return { ...f, directories, account, settings, settingsFile, save, binding, request };
}

async function conversationFixture(t, options = {}) {
    const f = accountFixture(t, options);
    const target = captureConversationTarget(f.request, { avatar: 'Nova.png', groupId: '', personaId: '', branchId: 'main' });
    const current = readConversationTarget(f.request, target);
    const snapshot = await buildConversationParticipantSnapshot(f.request, current, target, { avatar: 'Nova.png' },
        { binding: f.binding, directive: '', timeZone: 'UTC' });
    const { job } = acceptJob(f.directories, { owner: f.scope.owner, type: 'conversation.reply', submissionKey: 'automatic-speech', intent: { target } });
    writeArtifact(f.directories, job.id, 'request', snapshot);
    const context = () => ({ owner: f.scope.owner, directories: f.directories, job: getJob(f.directories, job.id), signal: new AbortController().signal });
    return { ...f, target, snapshot, jobId: job.id, context };
}

function roleplayFixture(t, { effect = 'append', ...options } = {}) {
    const f = accountFixture(t, options);
    const source = effect === 'continue' ? captureRoleplaySource(f.scope, { locator: f.locator, message: 1 }) : f.source();
    const worldInfo = captureRoleplayWorldInfo(f.scope, f.account, source, { avatar: 'Nova.png', maxContext: 4000,
        serverPrompt: true, trigger: effect === 'continue' ? 'continue' : 'normal' });
    const { jobId } = admitRoleplayJob(f.scope, f.account, { operationKey: 'automatic-speech', effect, source,
        request: { binding: f.binding, maxTokens: 32, characterName: 'Nova', worldInfo, serverPrompt: true, messages: [] } });
    releaseJob(f.directories, jobId);
    const context = () => ({ owner: f.scope.owner, directories: f.directories, job: getJob(f.directories, jobId), signal: new AbortController().signal });
    const run = deps => runRoleplayReplyJob(context(), { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }), ...deps });
    return { ...f, source, worldInfo, jobId, context, run };
}

const readChat = f => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(JSON.parse);
const savedMain = (text, called = () => {}) => async ({ jobContext, beforeDispatch, onProviderStep }) => {
    const step = 'b'.repeat(64);
    onProviderStep(`provider:${step}`);
    return providerStep(jobContext, step, async () => { beforeDispatch(); called(); return { text }; });
};

test('automatic Conversation narration captures its policy and commits ordered saved audio with the bubble', async t => {
    const f = await conversationFixture(t, { multiVoice: true });
    assert.equal(f.snapshot.speechPolicy.provider, 'OpenAI');
    assert.deepEqual(f.snapshot.speechAccount, f.account);
    assert.equal(JSON.stringify(f.snapshot).includes('automatic-private-key'), false);
    const bodies = [];
    const narrator = createConversationNarrator({ fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return audio(); } });
    const text = '*waves* "Hello." Then smiles.';
    const delivery = { effectId: 'bubble:reply:0' };
    const result = await narrator(f.context(), f.snapshot, text, f.snapshot.speaker, delivery);
    assert.deepEqual(bodies.map(body => [body.input, body.voice]), [['waves', 'alloy'], ['Hello.', 'nova'], ['Then smiles.', 'echo']]);
    assert.equal(result.artifacts.length, 3);
    assert.equal(result.playbackRate, 0.9);
    assert.equal(bodies[0].instructions, 'Speak as Nova to User.');
    await appendConversationJobMessage(f.context(), f.target, delivery.effectId, { role: 'character', name: 'Nova', mes: text }, { presentation: { narration: result } });
    const current = readConversationTarget(f.request, f.target);
    assert.equal(current.branch.messages.length, 2);
    assert.deepEqual(current.branch.pendingPresentations[current.branch.messages.at(-1).id].narration, result);
    const changed = JSON.parse(fs.readFileSync(f.settingsFile, 'utf8'));
    changed.extension_settings.tts.OpenAI.voiceMap = { Nova: 'onyx' };
    f.save(changed);
    assert.deepEqual(await narrator(f.context(), f.snapshot, text, f.snapshot.speaker, delivery), result);
    assert.equal(bodies.length, 3);
});

test('automatic Conversation speech stays disabled after admission and refuses a later settings or source substitution', async t => {
    const disabled = await conversationFixture(t, { enabled: false });
    assert.equal(disabled.snapshot.speechPolicy, null);
    disabled.settings.extension_settings.tts.enabled = true;
    disabled.save(disabled.settings);
    const refuseFetch = () => assert.fail('speech contacted a provider after an admission/source change');
    assert.equal(await createConversationNarrator({ fetchImpl: refuseFetch })(disabled.context(), disabled.snapshot, 'Hello.', disabled.snapshot.speaker, { effectId: 'bubble:reply:0' }), null);
    for (const kind of ['settings', 'messages', 'account']) {
        const f = await conversationFixture(t);
        if (kind === 'settings') f.settings.extension_settings.tts.OpenAI.speed = 2;
        if (kind === 'messages') f.settings.extension_settings.neconyan_conversation.characters['Nova.png'].branches.main.messages[0].mes = 'Edited.';
        if (kind === 'account') f.snapshot.speechAccount.dataEpoch = 'another-epoch';
        f.save(f.settings);
        await assert.rejects(createConversationNarrator({ fetchImpl: refuseFetch })(f.context(), f.snapshot, 'Hello.', f.snapshot.speaker, { effectId: 'bubble:reply:0' }));
        assert.equal(readArtifact(f.directories, f.jobId, 'provider:speech:bubble:reply:0:0'), undefined);
        assert.notEqual(getJob(f.directories, f.jobId).recoverability, 'unknown-outcome');
    }
});

test('an interrupted automatic Conversation speech request is not treated as an empty successful narration', async t => {
    const f = await conversationFixture(t);
    updateJob(f.directories, f.jobId, { state: 'running' });
    let paid = 0;
    await assert.rejects(createConversationNarrator({ fetchImpl: async () => { paid++; throw new Error('lost speech response'); } })(
        f.context(), f.snapshot, 'Hello.', f.snapshot.speaker, { effectId: 'bubble:reply:0' }), { code: 'TTS_PROVIDER' });
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, f.jobId).state, 'interrupted');
    await assert.rejects(createConversationNarrator({ fetchImpl: () => assert.fail('unknown speech repeated') })(
        f.context(), f.snapshot, 'Hello.', f.snapshot.speaker, { effectId: 'bubble:reply:0' }), { code: 'TTS_RESULT_RECOVERY' });
    assert.equal(paid, 1);
    assert.equal(readConversationTarget(f.request, f.target).branch.messages.length, 1);
});

test('Roleplay finishes its saved speech before committing the reply and never narrates the same result twice', async t => {
    const f = roleplayFixture(t, { multiVoice: true });
    const bodies = [];
    let main = 0;
    const text = '*waves* "Hello." Then smiles.';
    await f.run({ generate: savedMain(text, () => main++), speechDependencies: { fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        assert.equal(readChat(f).length, 3);
        return audio();
    } } });
    const reply = readChat(f).at(-1);
    assert.equal(reply.mes, text);
    assert.equal(reply.extra.server_narration.artifacts.length, 3);
    for (const part of reply.extra.server_narration.artifacts) assert.deepEqual(Buffer.from(readAudioArtifact(f.directories, f.jobId, part.artifact).base64, 'base64'), WAVE);
    assert.equal(main, 1);
    assert.equal(bodies.length, 3);
    await f.run({ generate: () => assert.fail('saved main response repeated'), speechDependencies: { fetchImpl: () => assert.fail('saved speech repeated') } });
    assert.equal(readChat(f).length, 4);
});

test('Roleplay continuation speech reads the complete protected message instead of just the generated suffix', async t => {
    const f = roleplayFixture(t, { effect: 'continue' });
    const spoken = [];
    await f.run({ generate: savedMain(' again'), speechDependencies: { fetchImpl: async (_url, init) => { spoken.push(JSON.parse(init.body).input); return audio(); } } });
    assert.deepEqual(spoken, ['Answer again']);
    assert.equal(readChat(f)[2].mes, 'Answer again');
    assert.equal(readChat(f)[2].extra.server_narration.status, 'ready');
});

test('Roleplay keeps the old reply when paid speech is unknown and resumes a saved main response without paying it again', async t => {
    const f = roleplayFixture(t);
    updateJob(f.directories, f.jobId, { state: 'running' });
    let main = 0, speech = 0;
    await assert.rejects(f.run({ generate: savedMain('Hello.', () => main++), speechDependencies: { fetchImpl: async () => {
        speech++; throw new Error('connection lost');
    } } }), { code: 'TTS_PROVIDER' });
    assert.equal(readChat(f).length, 3);
    assert.equal(readArtifact(f.directories, f.jobId, 'roleplay-output'), undefined);
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, f.jobId).state, 'interrupted');
    await assert.rejects(f.run({ generate: () => assert.fail('main repeated after speech interruption'),
        speechDependencies: { fetchImpl: () => assert.fail('speech repeated after interruption') } }), { code: 'TTS_RESULT_RECOVERY' });
    assert.equal(main, 1);
    assert.equal(speech, 1);
});

test('Roleplay resumes completed voice parts after a known settings refusal without replaying the model or completed audio', async t => {
    const f = roleplayFixture(t, { multiVoice: true });
    let main = 0;
    const bodies = [];
    const synthesize = async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        if (bodies.length === 1) {
            const edited = structuredClone(f.settings);
            edited.extension_settings.tts.OpenAI.speed = 2;
            f.save(edited);
        }
        return audio();
    };
    await assert.rejects(f.run({ generate: savedMain('*waves* "Hello." Then smiles.', () => main++),
        speechDependencies: { fetchImpl: synthesize } }), { code: 'TTS_SOURCE_CHANGED' });
    assert.equal(bodies.length, 1);
    assert.equal(readChat(f).length, 3);
    f.save(f.settings);
    await f.run({ generate: () => assert.fail('saved main result was not reused'), speechDependencies: { fetchImpl: synthesize } });
    assert.equal(main, 1);
    assert.deepEqual(bodies.map(body => body.voice), ['alloy', 'nova', 'echo']);
    assert.equal(readChat(f).at(-1).extra.server_narration.artifacts.length, 3);
});
