import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureChatProfile } = await import('../src/generation/profiles.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { captureRoleplayWorkflowRequest, admitRoleplayWorkflowJob, runRoleplayWorkflowJob,
    recoverWaitingRoleplayWorkflow } = await import('../src/generation/roleplay-workflow.js');
const { acceptJob, dismissJob, getJob, jobKey, JOB_LIMIT, readJobStore, recoverJobs, releaseJob,
    setJobState, updateJob } = await import('../src/jobs/store.js');
const { providerStep, readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { SECRET_KEYS, writeSecret } = await import('../src/endpoints/secrets.js');
const { roleplayHash } = await import('../src/roleplay-store.js');

const REPLY = 'The reply paid for before the upgrade.';
const controls = { prompts: [{ identifier: 'main', role: 'system', content: '', system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true }],
prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
function_calling: true };

/** An accepted 1.3.4.1-style workflow root with one candidate child. */
function prepared(t, { agents = false, translation = false, speech = false } = {}) {
    const f = fixture(t);
    const dirs = f.scope.directories;
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    dirs.openAI_Settings = path.join(dirs.root, 'openai-presets');
    fs.mkdirSync(dirs.openAI_Settings);
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Main.json'), JSON.stringify({ openai_max_context: 4096 }));
    if (agents) {
        dirs.inChatAgents = path.join(dirs.root, 'InChatAgents');
        fs.mkdirSync(dirs.inChatAgents);
        fs.writeFileSync(path.join(dirs.inChatAgents, 'helper.json'), JSON.stringify({ id: 'helper', name: 'Helper',
            enabled: true, phase: 'post', prompt: 'Revise the reply.',
            postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64 } }));
    }
    if (speech) writeSecret(dirs, SECRET_KEYS.OPENAI, 'speech-private-key');
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: [] } },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1', function_calling: true },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture', preset: 'Main',
            'api-url': 'http://127.0.0.1:18000/v1' }] },
        ...(agents ? { inChatAgents: { globalSettings: { enabled: true } } } : {}),
        ...(translation ? { translate: { auto_mode: 'responses', provider: 'google',
            target_language: 'fr', internal_language: 'en' } } : {}),
        ...(speech ? { tts: { enabled: true, auto_generation: true, currentProvider: 'OpenAI', playback_rate: 1,
            OpenAI: { model: 'gpt-4o-mini-tts', voiceMap: { Nova: 'nova' } } } } : {}) },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const request = captureRoleplayWorkflowRequest(f.scope, account, source, { avatar: 'Nova.png',
        binding: { kind: 'profile', ...captureChatProfile(dirs, 'main') }, maxTokens: 32, effect: 'append' });
    const { jobId } = admitRoleplayWorkflowJob(f.scope, account, { operationKey: 'root-append', source, request });
    releaseJob(dirs, jobId);
    const context = job => ({ owner: f.scope.owner, directories: dirs, job, signal: new AbortController().signal });
    const records = () => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const runChild = (job, { generate, generateAgent, translationFetch, speechDependencies } = {}) => {
        setJobState(dirs, job.id, 'running');
        return runRoleplayReplyJob(context(job), { contextLimit: () => 4096,
            promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }),
            generate, generateAgent, translationFetch, speechDependencies });
    };
    return { f, dirs, account, source, request, jobId, filename: f.filename, context, records, runChild };
}

/** Reproduce a paid main result saved before post-reply work stopped. */
async function failAfterProvider(f, { text = REPLY, legacy = true } = {}) {
    updateJob(f.dirs, f.jobId, { state: 'running' });
    const waiting = await runRoleplayWorkflowJob(f.context(getJob(f.dirs, f.jobId)));
    assert.equal(waiting.waiting, true);
    const child = getJob(f.dirs, waiting.childJobId);
    let calls = 0;
    await assert.rejects(f.runChild(child, { generate: async options => {
        calls += 1;
        const step = roleplayHash(['workflow-candidate', child.id]);
        options.onProviderStep(`provider:${step}`);
        await providerStep(options.jobContext, step, async () => {
            options.beforeDispatch();
            return { text };
        });
        throw new Error('Post-reply work stopped after the provider answered.');
    } }), /stopped after the provider answered/);
    assert.equal(calls, 1);
    setJobState(f.dirs, child.id, 'failed', { error: { code: 'AGENT_FAILED',
        message: 'An Agent failed after the reply finished.', status: 502 } });
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    const parent = getJob(f.dirs, f.jobId);
    assert.equal(parent.stage, 'child-needs-recovery');
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    if (legacy) {
        const preview = { stage: 'agents', childId: child.id, text, reasoning: 'Saved reasoning.', updatedAt: Date.now() };
        writeArtifact(f.dirs, f.jobId, 'roleplay-preview', preview);
        writeArtifact(f.dirs, f.jobId, 'roleplay-recovery', preview);
        updateJob(f.dirs, f.jobId, { retainedReply: true, finishedAt: old, updatedAt: old });
    } else {
        updateJob(f.dirs, f.jobId, { finishedAt: old, updatedAt: old });
    }
    updateJob(f.dirs, child.id, { finishedAt: old, updatedAt: old });
    return child;
}

test('an old retained reply is saved once through its paid child, never by a new main request', async t => {
    const f = prepared(t);
    const child = await failAfterProvider(f);

    const recovered = recoverJobs(f.dirs, { startedAt: Date.now() });
    assert.equal(recovered.changed, true);
    const parent = getJob(f.dirs, f.jobId);
    assert.equal(parent.dismissed, false, 'the old failure is not auto-dismissed');
    assert.equal(parent.retainedReplyUpgrade, 'queued');
    assert.equal(parent.state, 'waiting');
    assert.equal(parent.stage, 'children');
    assert.equal(getJob(f.dirs, child.id).state, 'queued');
    assert.equal(getJob(f.dirs, child.id).dismissed, false);

    let mainCalls = 0;
    await f.runChild(getJob(f.dirs, child.id), { generate: async () => {
        mainCalls += 1;
        throw new Error('The main model must not run again.');
    } });
    assert.equal(mainCalls, 0, 'the saved provider result is replayed without another main request');
    setJobState(f.dirs, child.id, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    assert.equal(getJob(f.dirs, f.jobId).state, 'queued');

    setJobState(f.dirs, f.jobId, 'running');
    const output = await runRoleplayWorkflowJob(f.context(getJob(f.dirs, f.jobId)));
    assert.equal(output.result.status, 'completed');
    assert.equal(f.records().at(-1).mes, REPLY);
    assert.equal(f.records().length, 4);
    const again = await runRoleplayWorkflowJob(f.context(getJob(f.dirs, f.jobId)));
    assert.deepEqual(again, output);
    assert.equal(f.records().length, 4, 'replaying the finished workflow never appends a second reply');
});

test('a restart with only an unknown Agent step saves the paid main reply without a new request', async t => {
    const f = prepared(t, { agents: true });
    const child = await failAfterProvider(f, { legacy: false });
    // The verified restart case edits the held Agent before the process dies.
    const agentFile = path.join(f.dirs.inChatAgents, 'helper.json');
    const agent = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    fs.writeFileSync(agentFile, JSON.stringify({ ...agent, prompt: 'An edited instruction.' }));
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const helperStep = 'provider:' + roleplayHash(['restart-helper', child.id]);
    updateJob(f.dirs, child.id, { state: 'interrupted', stage: null, finishedAt: old, updatedAt: old,
        recoverability: 'unknown-outcome', recoveryStep: helperStep, recoverySteps: [helperStep], dismissed: false,
        error: { code: 'INTERRUPTED', message: 'The result from the AI service is unknown after a restart.' } });
    updateJob(f.dirs, f.jobId, { state: 'waiting', stage: 'children', finishedAt: null, error: null, dismissed: false, updatedAt: old });
    const stopFile = path.join(f.dirs.root, 'jobs', 'artifacts', jobKey(child.id), jobKey('roleplay-agent-stop') + '.json');
    assert.equal(fs.existsSync(stopFile), false);

    recoverJobs(f.dirs, { startedAt: Date.now() });
    const queued = getJob(f.dirs, child.id);
    assert.equal(queued.state, 'queued');
    assert.equal(queued.helperReplyRecovery, 'queued');
    assert.deepEqual(queued.recoverySteps, [helperStep], 'the unknown helper step stays blocked');
    assert.deepEqual(readArtifact(f.dirs, child.id, 'roleplay-agent-stop'),
        { intentHash: roleplayHash(queued.intent), reason: 'failed' });
    assert.equal(getJob(f.dirs, f.jobId).state, 'waiting');

    let mainCalls = 0;
    let helperCalls = 0;
    await f.runChild(queued, {
        generate: async () => { mainCalls += 1; throw new Error('The main model must not run again.'); },
        generateAgent: async () => { helperCalls += 1; throw new Error('The failed helper must not run again.'); },
    });
    assert.equal(mainCalls, 0, 'the saved main result is reused');
    assert.equal(helperCalls, 0, 'the saved failure stop prevents another paid helper request');
    assert.equal(readArtifact(f.dirs, child.id, 'roleplay-candidate').output.agentProof, undefined,
        'the raw main fallback is accepted through the saved failure stop');
    setJobState(f.dirs, child.id, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    assert.equal(getJob(f.dirs, f.jobId).state, 'queued');
    setJobState(f.dirs, f.jobId, 'running');
    assert.equal((await runRoleplayWorkflowJob(f.context(getJob(f.dirs, f.jobId)))).result.status, 'completed');
    assert.equal(f.records().at(-1).mes, REPLY);
    assert.equal(f.records().length, 4);
});

test('a restart during outgoing translation saves the main reply without another request', async t => {
    const f = prepared(t, { translation: true });
    const child = await failAfterProvider(f, { legacy: false });
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const step = 'provider:translation:display_text:0:0';
    updateJob(f.dirs, child.id, { state: 'interrupted', stage: null, finishedAt: old, updatedAt: old,
        recoverability: 'unknown-outcome', recoveryStep: step, recoverySteps: [step], dismissed: false,
        error: { code: 'INTERRUPTED', message: 'The result from the AI service is unknown after a restart.' } });
    updateJob(f.dirs, f.jobId, { state: 'waiting', stage: 'children', finishedAt: null, error: null, dismissed: false });
    recoverJobs(f.dirs, { startedAt: Date.now() });
    assert.equal(getJob(f.dirs, child.id).state, 'queued');
    assert.deepEqual(getJob(f.dirs, child.id).recoverySteps, [step]);

    // A second restart can land while the optional work is in flight.
    updateJob(f.dirs, child.id, { state: 'interrupted', stage: null, finishedAt: old, updatedAt: old,
        error: { code: 'INTERRUPTED', message: 'The result from the AI service is unknown after a restart.' } });
    recoverJobs(f.dirs, { startedAt: Date.now() + 1 });
    assert.equal(getJob(f.dirs, child.id).state, 'queued');
    assert.deepEqual(getJob(f.dirs, child.id).recoverySteps, [step], 'optional uncertainty stays blocked');

    let mainCalls = 0;
    let translateCalls = 0;
    await f.runChild(getJob(f.dirs, child.id), {
        generate: async () => { mainCalls += 1; throw new Error('The main model must not run again.'); },
        translationFetch: async () => { translateCalls += 1; throw new Error('Translation must not be requested.'); },
    });
    assert.equal(mainCalls, 0);
    assert.equal(translateCalls, 0, 'the unknown translation step blocks a new optional request');
    const candidate = readArtifact(f.dirs, child.id, 'roleplay-candidate');
    assert.equal(candidate.output.message?.extra?.display_text, undefined);
    setJobState(f.dirs, child.id, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    setJobState(f.dirs, f.jobId, 'running');
    assert.equal((await runRoleplayWorkflowJob(f.context(getJob(f.dirs, f.jobId)))).result.status, 'completed');
    assert.equal(f.records().at(-1).mes, REPLY);
    assert.equal(f.records().length, 4);
});

test('a restart during outgoing speech saves the main reply without another request', async t => {
    const f = prepared(t, { speech: true });
    const child = await failAfterProvider(f, { legacy: false });
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const step = 'provider:speech:roleplay:0';
    updateJob(f.dirs, child.id, { state: 'interrupted', stage: null, finishedAt: old, updatedAt: old,
        recoverability: 'unknown-outcome', recoveryStep: step, recoverySteps: [step], dismissed: false,
        error: { code: 'INTERRUPTED', message: 'The result from the AI service is unknown after a restart.' } });
    updateJob(f.dirs, f.jobId, { state: 'waiting', stage: 'children', finishedAt: null, error: null, dismissed: false });
    recoverJobs(f.dirs, { startedAt: Date.now() });
    assert.equal(getJob(f.dirs, child.id).state, 'queued');
    assert.deepEqual(getJob(f.dirs, child.id).recoverySteps, [step]);

    let mainCalls = 0;
    let speechCalls = 0;
    await f.runChild(getJob(f.dirs, child.id), {
        generate: async () => { mainCalls += 1; throw new Error('The main model must not run again.'); },
        speechDependencies: { fetchImpl: async () => { speechCalls += 1; throw new Error('Speech must not be requested.'); } },
    });
    assert.equal(mainCalls, 0);
    assert.equal(speechCalls, 0, 'the unknown speech step blocks a new optional request');
    assert.equal(readArtifact(f.dirs, child.id, 'roleplay-candidate').output.message?.extra?.server_narration, undefined);
    setJobState(f.dirs, child.id, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    setJobState(f.dirs, f.jobId, 'running');
    assert.equal((await runRoleplayWorkflowJob(f.context(getJob(f.dirs, f.jobId)))).result.status, 'completed');
    assert.equal(f.records().at(-1).mes, REPLY);
    assert.equal(f.records().length, 4);
});

test('automatic legacy migration never clears saved uncertainty', async t => {
    const f = prepared(t);
    const child = await failAfterProvider(f);
    const step = 'provider:roleplay-caption:1:0';
    updateJob(f.dirs, child.id, { recoverability: 'unknown-outcome', recoveryStep: step,
        recoverySteps: [step], state: 'failed' });
    recoverJobs(f.dirs, { startedAt: Date.now() });
    const queued = getJob(f.dirs, child.id);
    assert.equal(queued.state, 'queued');
    assert.deepEqual(queued.recoverySteps, [step]);
    assert.equal(queued.recoveryStep, step);
    assert.equal(queued.recoverability, 'unknown-outcome');
});

test('a genuinely unknown main result is never treated as a helper recovery', async t => {
    const f = prepared(t, { agents: true });
    const child = await failAfterProvider(f, { legacy: false });
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const helperStep = 'provider:' + roleplayHash(['restart-helper', child.id]);
    updateJob(f.dirs, child.id, { state: 'interrupted', stage: null, finishedAt: old, updatedAt: old,
        recoverability: 'unknown-outcome', recoveryStep: helperStep, recoverySteps: [helperStep], dismissed: false,
        error: { code: 'INTERRUPTED', message: 'The result from the AI service is unknown after a restart.' } });
    updateJob(f.dirs, f.jobId, { state: 'waiting', stage: 'children', finishedAt: null, error: null, dismissed: false });
    const provider = readArtifact(f.dirs, child.id, 'roleplay-main-provider');
    fs.rmSync(path.join(f.dirs.root, 'jobs', 'artifacts', jobKey(child.id), jobKey(provider.step) + '.json'));

    recoverJobs(f.dirs, { startedAt: Date.now() });
    assert.notEqual(getJob(f.dirs, child.id).state, 'queued');
    assert.equal(getJob(f.dirs, child.id).helperReplyRecovery, undefined);
    assert.equal(fs.existsSync(path.join(f.dirs.root, 'jobs', 'artifacts', jobKey(child.id),
        jobKey('roleplay-agent-stop') + '.json')), false, 'no stop authorises a missing main result');
});

test('an edited source keeps the saved reply and reports the conflict without overwriting the chat', async t => {
    const f = prepared(t);
    const child = await failAfterProvider(f);
    const edited = f.records();
    edited.at(-1).mes = 'Independent edit that must survive.';
    fs.writeFileSync(f.filename, edited.map(record => JSON.stringify(record)).join('\n'));

    recoverJobs(f.dirs, { startedAt: Date.now() });
    assert.equal(getJob(f.dirs, child.id).state, 'queued');
    let mainCalls = 0;
    await assert.rejects(f.runChild(getJob(f.dirs, child.id), { generate: async () => {
        mainCalls += 1;
        throw new Error('The main model must not run again.');
    } }), /source (?:changed|differs)|protected identity/i);
    assert.equal(mainCalls, 0);
    const failure = Object.assign(new Error('The chat was saved by another change (an edit, a new message, or an extension rewriting messages) after this was requested, so it was stopped instead of saving over that change. Try again.'),
        { code: 'ROLEPLAY_SOURCE_CHANGED', status: 409 });
    setJobState(f.dirs, child.id, 'failed', { error: { code: failure.code, message: failure.message, status: failure.status } });
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });

    const parent = getJob(f.dirs, f.jobId);
    assert.equal(parent.state, 'interrupted');
    assert.match(parent.error.message, /after this was requested/i);
    assert.equal(parent.dismissed, false);
    assert.equal(getJob(f.dirs, child.id).dismissed, false);
    assert.equal(f.records().at(-1).mes, 'Independent edit that must survive.');
    assert.equal(f.records().length, edited.length);
    assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-recovery').text, REPLY);

    const revision = getJob(f.dirs, f.jobId);
    recoverJobs(f.dirs, { startedAt: Date.now() + 1 });
    assert.equal(getJob(f.dirs, f.jobId).retainedReplyUpgrade, parent.retainedReplyUpgrade);
    assert.equal(getJob(f.dirs, child.id).state, 'failed', 'a failed migrated attempt is not requeued on every restart');
    assert.deepEqual(getJob(f.dirs, f.jobId), revision);
});

test('an unknown main result is preserved and never released for execution', async t => {
    for (const damage of ['missing', 'null']) {
        await t.test(damage, async t => {
            const f = prepared(t);
            const child = await failAfterProvider(f);
            const provider = readArtifact(f.dirs, child.id, 'roleplay-main-provider');
            const artifact = path.join(f.dirs.root, 'jobs', 'artifacts', jobKey(child.id), jobKey(provider.step) + '.json');
            if (damage === 'missing') fs.rmSync(artifact);
            else fs.writeFileSync(artifact, 'null');

            recoverJobs(f.dirs, { startedAt: Date.now() });
            const parent = getJob(f.dirs, f.jobId);
            assert.equal(parent.state, 'interrupted');
            assert.equal(parent.retainedReplyUpgrade, 'preserved');
            assert.equal(parent.error.code, 'ROLEPLAY_REPLY_PRESERVED');
            assert.match(parent.error.message, /saved model result is missing/);
            assert.equal(getJob(f.dirs, child.id).state, 'failed');
            assert.ok(getJob(f.dirs, child.id), 'the conflict keeps its child record for later inspection');
            assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-recovery').text, REPLY);

            const before = getJob(f.dirs, f.jobId);
            const revision = before.updatedAt;
            recoverJobs(f.dirs, { startedAt: Date.now() + 1 });
            assert.equal(getJob(f.dirs, f.jobId).retainedReplyUpgrade, 'preserved');
            assert.equal(getJob(f.dirs, f.jobId).updatedAt, revision, 'a preserved record is left exactly as it was');
            assert.equal(getJob(f.dirs, child.id).state, 'failed');
        });
    }
});

test('cancelled and user-dismissed replies stay stopped while automatic dismissals recover', async t => {
    await t.test('cancelled', async t => {
        const f = prepared(t);
        const child = await failAfterProvider(f);
        updateJob(f.dirs, f.jobId, { state: 'cancelled',
            cancellation: { requested: true, requestedAt: Date.now(), reason: null } });
        recoverJobs(f.dirs, { startedAt: Date.now() });
        assert.equal(getJob(f.dirs, f.jobId).state, 'cancelled');
        assert.equal(getJob(f.dirs, f.jobId).retainedReplyUpgrade, 'preserved');
        assert.equal(getJob(f.dirs, child.id).state, 'failed');
    });
    await t.test('dismissed by the owner', async t => {
        const f = prepared(t);
        const child = await failAfterProvider(f);
        updateJob(f.dirs, f.jobId, { dismissed: true, dismissedReason: 'user' });
        recoverJobs(f.dirs, { startedAt: Date.now() });
        assert.equal(getJob(f.dirs, f.jobId).dismissed, true);
        assert.equal(getJob(f.dirs, f.jobId).retainedReplyUpgrade, 'preserved');
        assert.equal(getJob(f.dirs, child.id).state, 'failed');
    });
    await t.test('dismissed by an earlier restart', async t => {
        const f = prepared(t);
        const child = await failAfterProvider(f);
        updateJob(f.dirs, f.jobId, { dismissed: true, dismissedReason: 'restart' });
        recoverJobs(f.dirs, { startedAt: Date.now() });
        assert.equal(getJob(f.dirs, f.jobId).dismissed, false);
        assert.equal(getJob(f.dirs, f.jobId).retainedReplyUpgrade, 'queued');
        assert.equal(getJob(f.dirs, child.id).state, 'queued');
    });
});

test('safe start pauses the upgrade without losing the reply, then a normal start queues it', async t => {
    const f = prepared(t);
    const child = await failAfterProvider(f);
    recoverJobs(f.dirs, { startedAt: Date.now(), hold: true });
    const paused = getJob(f.dirs, f.jobId);
    assert.equal(paused.retainedReplyUpgrade, 'paused');
    assert.equal(getJob(f.dirs, child.id).state, 'failed');
    assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-recovery').text, REPLY);

    recoverJobs(f.dirs, { startedAt: Date.now() + 1 });
    assert.equal(getJob(f.dirs, f.jobId).retainedReplyUpgrade, 'queued');
    assert.equal(getJob(f.dirs, child.id).state, 'queued');
});

test('a preview-only old family survives a full ledger before its first write', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retained-limit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root };
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    for (let index = 0; index < JOB_LIMIT; index += 1) {
        const job = acceptJob(directories, { owner: 'alice', type: 'test.completed', submissionKey: `done-${index}`,
            intent: { index } }).job;
        setJobState(directories, job.id, 'completed');
    }
    const parent = acceptJob(directories, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: 'old-preview',
        intent: { media: { accountId: 'account', dataEpoch: 1, operationKey: 'old' }, source: { instanceId: 'chat' } } }).job;
    const child = acceptJob(directories, { owner: 'alice', type: 'roleplay.candidate', submissionKey: 'old-preview-child',
        intent: {} }).job;
    const ledgerFile = path.join(root, 'jobs', 'index.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const savedParent = ledger.jobs[jobKey(parent.id)];
    const savedChild = ledger.jobs[jobKey(child.id)];
    Object.assign(savedParent, { children: [child.id], state: 'failed', finishedAt: old, updatedAt: old });
    Object.assign(savedChild, { parentId: parent.id, state: 'completed', finishedAt: old, updatedAt: old });
    delete ledger.retainedReplyMigration;
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    writeArtifact(directories, parent.id, 'roleplay-preview', { stage: 'agents', text: REPLY, childId: child.id });
    assert.equal(getJob(directories, parent.id).retainedReply, undefined);

    recoverJobs(directories, { startedAt: Date.now() });
    const retained = getJob(directories, parent.id);
    assert.ok(retained, 'the old preview-only root survives a full ledger');
    assert.equal(retained.retainedReply, true);
    assert.equal(retained.retainedReplyUpgrade, 'queued');
    assert.equal(retained.state, 'queued');
    assert.equal(getJob(directories, child.id).state, 'completed');
    assert.ok(fs.existsSync(path.join(root, 'jobs', 'artifacts', jobKey(parent.id), jobKey('roleplay-preview') + '.json')),
        'the preview copy survives pruning');
    assert.equal(readJobStore(directories).retainedReplyMigration, 1);
    assert.ok(Object.keys(readJobStore(directories).jobs).length <= JOB_LIMIT);
});

test('a preview written after the migration marker is not treated as legacy', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retained-modern-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root };
    const parent = acceptJob(directories, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: 'modern-preview',
        intent: {} }).job;
    assert.equal(readJobStore(directories).retainedReplyMigration, 1);
    setJobState(directories, parent.id, 'failed');
    updateJob(directories, parent.id, { finishedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });
    writeArtifact(directories, parent.id, 'roleplay-preview', { stage: 'agents', text: REPLY });

    recoverJobs(directories, { startedAt: Date.now() });
    const job = getJob(directories, parent.id);
    assert.equal(job.retainedReply, undefined);
    assert.equal(job.retainedReplyUpgrade, undefined);
    assert.notEqual(job.state, 'queued');
});

test('the one-time protection scan does not repeat on later progress writes', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retained-scan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root };
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const ids = [];
    for (let index = 0; index < 20; index += 1) {
        const job = acceptJob(directories, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: `preview-${index}`,
            intent: {} }).job;
        setJobState(directories, job.id, 'failed');
        updateJob(directories, job.id, { finishedAt: old, updatedAt: old });
        writeArtifact(directories, job.id, 'roleplay-preview', { stage: 'agents', text: `${REPLY} ${index}` });
        ids.push(job.id);
    }
    const ledgerFile = path.join(root, 'jobs', 'index.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    delete ledger.retainedReplyMigration;
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));

    const originalStat = fs.statSync;
    let artifactReads = 0;
    fs.statSync = function (filename, ...args) {
        if (String(filename).includes(`${path.sep}artifacts${path.sep}`)) artifactReads += 1;
        return originalStat.call(this, filename, ...args);
    };
    try {
        updateJob(directories, ids[0], { updatedAt: Date.now() });
        const firstScan = artifactReads;
        assert.ok(firstScan >= ids.length, 'the initial scan reads each old preview once');
        for (let index = 0; index < 10; index += 1) {
            updateJob(directories, ids[0], { updatedAt: Date.now() + index + 1 });
        }
        assert.equal(artifactReads, firstScan, 'later writes do not rescan artifacts');
        assert.equal(readJobStore(directories).retainedReplyMigration, 1);
    } finally {
        fs.statSync = originalStat;
    }
});

test('a real owner dismissal keeps its user reason through recovery', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-retained-dismiss-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root };
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const parent = acceptJob(directories, { owner: 'alice', type: 'media.roleplay-workflow', submissionKey: 'dismiss-parent',
        intent: { media: { accountId: 'account', dataEpoch: 1, operationKey: 'old' }, source: { instanceId: 'chat' } } }).job;
    const child = acceptJob(directories, { owner: 'alice', type: 'roleplay.candidate', submissionKey: 'dismiss-child',
        intent: {} }).job;
    updateJob(directories, parent.id, { children: [child.id], state: 'interrupted', dismissed: true,
        dismissedReason: 'restart', finishedAt: old, updatedAt: old });
    updateJob(directories, child.id, { parentId: parent.id, state: 'interrupted', dismissed: true,
        dismissedReason: 'restart', finishedAt: old, updatedAt: old });
    writeArtifact(directories, parent.id, 'roleplay-preview', { stage: 'agents', text: REPLY, childId: child.id });
    const ledgerFile = path.join(root, 'jobs', 'index.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    delete ledger.retainedReplyMigration;
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));

    dismissJob(directories, parent.id);
    assert.equal(getJob(directories, parent.id).dismissed, true);
    assert.equal(getJob(directories, parent.id).dismissedReason, 'user');
    assert.equal(getJob(directories, child.id).dismissed, true);
    assert.equal(getJob(directories, child.id).dismissedReason, 'user');

    recoverJobs(directories, { startedAt: Date.now() });
    assert.equal(getJob(directories, parent.id).dismissed, true);
    assert.equal(getJob(directories, parent.id).dismissedReason, 'user');
    assert.equal(getJob(directories, child.id).dismissed, true);
    assert.equal(getJob(directories, child.id).dismissedReason, 'user');
});
