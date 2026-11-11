import { authoringRenameTest } from './authoring-rename-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { write: writeCard } = await import('../src/character-card-parser.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { runAssistantToolJob } = await import('../src/generation/assistant-tool-jobs.js');
const { runPathfinderNotebookJob } = await import('../src/generation/pathfinder-notebook-jobs.js');
const { runPathfinderToolJob } = await import('../src/generation/pathfinder-tool-jobs.js');
const { captureRoleplayWorkflowRequest, admitRoleplayWorkflowJob, runRoleplayWorkflowJob,
    recoverWaitingRoleplayWorkflow } = await import('../src/generation/roleplay-workflow.js');
const { getJob, releaseJob, setJobState, updateJob, requestCancellation } = await import('../src/jobs/store.js');
const { providerStep, readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { readNativeMediaJobResult, readNativeMediaJobResultForOwner, withNativeMediaReceipt } = await import('../src/generation/media-jobs.js');
const { releaseStoppedRoleplayWorkflow } = await import('../src/generation/roleplay-workflow-cancellation.js');
const { requestRoleplayAgentStop } = await import('../src/generation/roleplay-agent-stop.js');
const { publishRoleplayPreview } = await import('../src/generation/roleplay-preview.js');
const { KEPT_REPLY_ARTIFACT, keepRoleplayReply, preserveInterruptedRoleplayReply, preserveRoleplayWorkflowReply, readWorkflowReplyText, recordWorkflowReplyText } = await import('../src/generation/roleplay-kept-reply.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { saveBlockedContinuationProof, verifyBlockedOutputProof } = await import('../src/generation/blocked-output-proof.js');
const { enableMewmoryHiding } = await import('./mewmory-hiding-fixture.js');
const { statePath } = await import('../src/mewmory/store.js');
const { router: jobsRouter } = await import('../src/endpoints/jobs.js');

const controls = { prompts: [{ identifier: 'main', role: 'system', content: '', system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true }],
prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
function_calling: true };

function prepared(t, effect = 'append', { assistant = false, pathfinder = false, pathfinderSettings = {}, agents = false, recovery = false, rewrite = true, autoSwipe = false, autoContinue = false, continueTarget = 30, bundledMacros = null, history = 0 } = {}) {
    const f = fixture(t);
    const dirs = f.scope.directories;
    // Keep small history budgets elsewhere; assistant lifecycle checks include every tool schema.
    const maxContext = assistant ? 8192 : 4096;
    f.records[1].extra = {};
    if (history) {
        f.records.splice(1, 0, ...Array.from({ length: history }, (_, index) => ({
            name: index % 2 === 0 ? 'User' : 'Nova', is_user: index % 2 === 0,
            mes: 'history ' + index + ' ' + 'lorem ipsum dolor sit amet '.repeat(20), extra: {},
        })));
    }
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    if (assistant) fs.writeFileSync(path.join(dirs.characters, 'Nova.png'), writeCard(png, JSON.stringify({
        name: 'Nova', description: 'Assistant', data: { name: 'Nova', description: 'Assistant',
            extensions: { neconyan_assistant: { id: 'miso-male' } } },
    })));
    if (pathfinder || agents) {
        dirs.worlds = path.join(dirs.root, 'worlds');
        dirs.inChatAgents = path.join(dirs.root, 'InChatAgents');
        fs.mkdirSync(dirs.worlds);
        fs.mkdirSync(dirs.inChatAgents);
        fs.writeFileSync(path.join(dirs.worlds, 'Manual.json'), JSON.stringify({ entries: {
            12: { uid: 12, key: ['telescope'], comment: 'Observatory', content: 'A broken telescope.' },
        } }));
        if (pathfinder) fs.writeFileSync(path.join(dirs.inChatAgents, 'pathfinder.json'), JSON.stringify({ id: 'pathfinder',
            name: 'Pathfinder', category: 'tool', enabled: true, sourceTemplateId: 'tpl-pathfinder',
            settings: { sidecarEnabled: true, pipelineEnabled: false, enabledLorebooks: ['Manual'], includeContextualLorebooks: false, ...pathfinderSettings } }));
        if (agents && rewrite) fs.writeFileSync(path.join(dirs.inChatAgents, 'rewrite.json'), JSON.stringify({ id: 'rewrite', name: 'Rewrite',
            enabled: true, phase: 'post', prompt: 'REWRITE', postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64 } }));
        if (recovery) fs.writeFileSync(path.join(dirs.inChatAgents, 'tpl-thinking-reply-recovery.json'), JSON.stringify({ id: 'tpl-thinking-reply-recovery',
            sourceTemplateId: 'tpl-thinking-reply-recovery', name: 'Thinking Reply Recovery', enabled: true, category: 'content', phase: 'post', prompt: 'RECOVER',
            execution: 'inline', settings: {}, injection: { position: 1, depth: 1, role: 0, order: 30, scan: false },
            preProcess: { mode: 'inject', interceptTiming: 'pre-generation', applyMode: 'replace', maxTokens: 8192 },
            postProcess: { enabled: false, type: 'regex', promptTransformEnabled: true, promptTransformMode: 'rewrite', promptTransformMaxTokens: 64, promptTransformContextMessages: 8 },
            conditions: { triggerKeywords: [], triggerProbability: 100, generationTypes: ['normal', 'continue'] } }));
    }
    dirs.openAI_Settings = path.join(dirs.root, 'openai-presets');
    fs.mkdirSync(dirs.openAI_Settings);
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Main.json'), JSON.stringify({ openai_max_context: maxContext }));
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: [] } },
        ...(autoSwipe || autoContinue ? { power_user: { ...(autoSwipe ? { auto_swipe: true,
            auto_swipe_minimum_length: 15, auto_swipe_blacklist: ['forbidden'], auto_swipe_blacklist_threshold: 2 } : {}),
        ...(autoContinue ? { auto_continue: { enabled: true, allow_chat_completions: true, target_length: continueTarget } } : {}) } } : {}),
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1', function_calling: true },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture', preset: 'Main',
            'api-url': 'http://127.0.0.1:18000/v1' }] },
        ...(pathfinder || agents ? { inChatAgents: { globalSettings: { enabled: true, pathfinderEnabled: pathfinder } } } : {}) },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = effect === 'append' ? f.source() : captureRoleplaySource(f.scope, { locator: f.locator, message: 1 });
    const request = captureRoleplayWorkflowRequest(f.scope, account, source, { avatar: 'Nova.png',
        binding: { kind: 'profile', ...captureChatProfile(dirs, 'main') }, maxTokens: 32, effect, bundledMacros });
    const { jobId } = admitRoleplayWorkflowJob(f.scope, account, { operationKey: `root-${effect}`, source, request });
    releaseJob(dirs, jobId);
    const context = () => ({ owner: f.scope.owner, directories: dirs, job: getJob(dirs, jobId), signal: new AbortController().signal });
    const childJob = (turn = 0) => getJob(dirs, readArtifact(dirs, jobId, turn ? `roleplay-workflow-child:${turn}` : 'roleplay-workflow-child').jobId);
    // One direct run of the child reply job, as the job runner would start it.
    const runChild = (child, { generate, generateAgent, promptControls, pathfinderCalls = { count: 0 } } = {}) => {
        setJobState(dirs, child.id, 'running');
        return runRoleplayReplyJob({ owner: f.scope.owner, directories: dirs, job: getJob(dirs, child.id),
            signal: new AbortController().signal }, { contextLimit: () => maxContext,
            promptBackend: () => ({ backend: 'chat', active: promptControls ?? controls, profile: { model: 'fixture' }, source: 'custom' }),
            ...(generateAgent ? { generateAgent } : {}),
            ...(pathfinder ? { generatePathfinder: async options => {
                pathfinderCalls.count++;
                const step = roleplayHash(['workflow-sidecar', child.id]);
                options.onProviderStep(`provider:${step}`);
                return providerStep(options.jobContext, step, async () => { options.beforeDispatch(); return { text: '' }; });
            } } : {}),
            generate });
    };
    return { f, dirs, account, source, request, jobId, context, childJob, runChild,
        async candidate(text, calls, { turn = 0, response = undefined, generateAgent, promptControls, pathfinderCalls } = {}) {
            const child = childJob(turn);
            const result = await runChild(child, { generateAgent, promptControls, pathfinderCalls,
                generate: async options => {
                    calls.count++;
                    calls.check?.(options, turn);
                    const step = roleplayHash(['workflow-candidate', child.id]);
                    options.onProviderStep(`provider:${step}`);
                    return providerStep(options.jobContext, step, async () => {
                        options.beforeDispatch();
                        return response ? { text, response } : { text };
                    });
                } });
            setJobState(dirs, child.id, 'completed');
            recoverWaitingRoleplayWorkflow({ directories: dirs, owner: f.scope.owner, job: getJob(dirs, jobId) });
            assert.equal(getJob(dirs, jobId).state, 'queued');
            setJobState(dirs, jobId, 'running');
            return result;
        },
        records: () => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    };
}

test('a thinking-only workflow candidate is recovered, rewritten once and committed with its reasoning', async t => {
    const f = prepared(t, 'append', { agents: true, recovery: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = [];
    await f.candidate('', { count: 0 }, { response: { choices: [{ message: { reasoning_content: 'Plan the reply' }, finish_reason: 'stop' }] },
        generateAgent: async ({ messages }) => {
            const body = JSON.stringify(messages);
            calls.push(body.includes('RECOVER') ? 'recovery' : 'rewrite');
            return { text: body.includes('RECOVER') ? 'Recovered reply.' : 'Rewritten reply.' };
        } });
    const output = await runRoleplayWorkflowJob(f.context());
    assert.equal(output.result.status, 'completed');
    assert.deepEqual(calls, ['recovery', 'rewrite']);
    assert.equal(f.records().at(-1).mes, 'Rewritten reply.');
    assert.equal(f.records().at(-1).extra.reasoning, 'Plan the reply');
    assert.equal(f.records().at(-1).extra.inChatAgentThinkingRecovery.status, 'done');
});

for (const policy of ['autoSwipe', 'autoContinue']) {
    test(`stopping Agents publishes the completed workflow reply without starting ${policy}`, async t => {
        const f = prepared(t, 'append', { agents: true, [policy]: true });
        updateJob(f.dirs, f.jobId, { state: 'running' });
        await runRoleplayWorkflowJob(f.context());
        const calls = { count: 0 };
        await f.candidate('Short', calls, { generateAgent: async ({ signal }) => {
            assert.equal(requestRoleplayAgentStop(f.context()), true);
            signal.throwIfAborted();
        } });
        const output = await runRoleplayWorkflowJob(f.context());
        assert.equal(output.result.status, 'completed');
        assert.equal(output.result.agentsFailed, undefined, 'the owner Stop is not an Agent failure');
        assert.equal(f.records().at(-1).mes, 'Short');
        assert.equal(getJob(f.dirs, f.jobId).children.length, 1);
        assert.equal(calls.count, 1);
        assert.deepEqual(await runRoleplayWorkflowJob(f.context()), output);
    });
}

for (const uncertain of [false, true]) {
    test(`a stopped workflow reports its child failure without repeating it (uncertain: ${uncertain})`, async t => {
        const f = prepared(t);
        updateJob(f.dirs, f.jobId, { state: 'running' });
        const { childJobId } = await runRoleplayWorkflowJob(f.context());
        const reason = uncertain ? 'The connection to your model provider closed before a complete reply was received.'
            : 'The chat was saved by another change (an edit, a new message, or an extension rewriting messages) after this was requested, so it was stopped instead of saving over that change. Try again.';
        updateJob(f.dirs, childJobId, { state: uncertain ? 'interrupted' : 'failed',
            error: { code: uncertain ? 'JOB_FAILED' : 'ROLEPLAY_SOURCE_CHANGED', message: reason, status: uncertain ? 502 : 409 },
            recoverability: uncertain ? 'unknown-outcome' : 'resumable' });
        const before = f.records();
        recoverWaitingRoleplayWorkflow(f.context());
        const root = getJob(f.dirs, f.jobId);
        assert.equal(root.state, 'interrupted');
        assert.equal(root.stage, 'child-needs-recovery');
        assert.equal(root.error.code, 'ROLEPLAY_WORKFLOW_CHILD');
        assert.equal(root.error.message, reason + (uncertain
            ? ' The provider may still have processed this request, so it was not retried automatically.' : ''));
        recoverWaitingRoleplayWorkflow(f.context());
        assert.deepEqual(getJob(f.dirs, f.jobId).children, [childJobId]);
        assert.deepEqual(f.records(), before);
    });
}

test('a stopped workflow with no child explanation uses plain language', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    const { childJobId } = await runRoleplayWorkflowJob(f.context());
    updateJob(f.dirs, childJobId, { state: 'failed' });
    recoverWaitingRoleplayWorkflow(f.context());
    assert.equal(getJob(f.dirs, f.jobId).error.message, 'A reply step stopped before it finished.');
});

test('a reply that stopped after reaching the provider frees the chat for the next send', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    const { childJobId } = await runRoleplayWorkflowJob(f.context());
    const admitNext = operationKey => {
        const source = f.f.source();
        const request = captureRoleplayWorkflowRequest(f.f.scope, f.account, source, { avatar: 'Nova.png',
            binding: { kind: 'profile', ...captureChatProfile(f.dirs, 'main') }, maxTokens: 32 });
        return admitRoleplayWorkflowJob(f.f.scope, f.account, { operationKey, source, request });
    };
    assert.throws(() => admitNext('while-running'), { code: 'MEDIA_TARGET_BUSY',
        message: 'Another reply for this chat is still being written. Wait for it to finish, then send again.' });
    updateJob(f.dirs, childJobId, { state: 'interrupted', recoverability: 'unknown-outcome',
        error: { code: 'JOB_FAILED', message: 'The connection closed.', status: 502 } });
    recoverWaitingRoleplayWorkflow(f.context());
    const before = f.records();
    const next = admitNext('after-stop');
    assert.equal(next.created, true);
    assert.notEqual(next.jobId, f.jobId);
    assert.deepEqual(readNativeMediaJobResultForOwner(f.f.scope, { operationKey: 'root-append' }),
        { state: 'closed', jobId: f.jobId, result: { stopped: true, chatChanged: false } });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), { result: { stopped: true, chatChanged: false } });
    assert.deepEqual(getJob(f.dirs, f.jobId).children, [childJobId]);
    assert.deepEqual(f.records(), before);
});

test('a stopped reply keeps the chat while a write or child step is unfinished', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    const { childJobId } = await runRoleplayWorkflowJob(f.context());
    const release = releaseStoppedRoleplayWorkflow({ owner: f.f.scope.owner, directories: f.dirs });
    const receipt = effects => ({ state: 'accepted', jobId: f.jobId, effects });
    updateJob(f.dirs, f.jobId, { state: 'interrupted' });
    assert.equal(release(receipt({})), null, 'a running child still owns the chat');
    updateJob(f.dirs, childJobId, { state: 'interrupted' });
    assert.deepEqual(release(receipt({})), { stopped: true, chatChanged: false });
    writeArtifact(f.dirs, childJobId, KEPT_REPLY_ARTIFACT, { version: 1, state: 'done' });
    assert.deepEqual(release(receipt({})), { stopped: true, chatChanged: true });
    writeArtifact(f.dirs, childJobId, KEPT_REPLY_ARTIFACT, { version: 1, state: 'failed' });
    assert.deepEqual(release(receipt({})), { stopped: true, chatChanged: false });
    assert.deepEqual(release(receipt({ 'speaker:0': { state: 'done' } })), { stopped: true, chatChanged: true });
    assert.equal(release(receipt({ final: { state: 'writing' } })), null, 'a half-written reply is never released');
    assert.equal(release({ state: 'preparing', jobId: null, effects: {} }), null);
    assert.equal(release({ ...receipt({}), jobId: null }), null);
    assert.deepEqual(release({ ...receipt({}), jobId: 'pruned-job' }), { stopped: true, chatChanged: false });
    updateJob(f.dirs, f.jobId, { state: 'completed' });
    assert.equal(release(receipt({})), null);
});

test('a saved root parks for one child, keeps the old chat until durable completion and replays without paying', async t => {
    const f = prepared(t);
    assert.equal(f.request.capacity.maxTurns, 16);
    assert.equal(f.request.capacity.companionTurns, 1);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    const waiting = await runRoleplayWorkflowJob(f.context());
    assert.equal(waiting.waiting, true);
    assert.equal(f.records().length, 3);
    assert.equal(f.records()[2].mes, 'Answer');
    const calls = { count: 0 };
    await f.candidate('A reviewed native reply.', calls);
    assert.equal(f.records().length, 3);
    const output = await runRoleplayWorkflowJob(f.context());
    assert.equal(output.result.status, 'completed');
    assert.equal(f.records().at(-1).mes, 'A reviewed native reply.');
    assert.deepEqual(f.records()[2].swipes, ['Answer', 'Other']);
    const cached = await runRoleplayWorkflowJob(f.context());
    assert.deepEqual(cached, output);
    assert.equal(calls.count, 1);
    assert.ok(readArtifact(f.dirs, f.jobId, 'roleplay-workflow-final').recordsHash);
    assert.deepEqual(readNativeMediaJobResult(f.f.scope, f.account, { operationKey: 'root-append', jobId: f.jobId,
        intentHash: roleplayHash(getJob(f.dirs, f.jobId).intent) }), output.result);
});

test('an automatic alternative freezes its rejection before paying another model turn and retains old swipes', async t => {
    const f = prepared(t, 'swipe', { autoSwipe: true });
    assert.equal(f.request.capacity.companionTurns, 16);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0, check(options, turn) {
        if (turn === 1) assert.ok(options.messages.some(message => message.role === 'assistant' && message.content === 'Short'));
    } };
    await f.candidate('Short', calls);
    assert.equal(f.records()[2].mes, 'Answer');
    const waiting = await runRoleplayWorkflowJob(f.context());
    assert.equal(waiting.waiting, true);
    const decision = readArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:0');
    assert.equal(decision.decision.kind, 'swipe');
    assert.equal(f.records()[2].swipes.length, 2);
    const replay = await runRoleplayWorkflowJob(f.context(), { decideCandidate: () => {
        throw new Error('A saved automatic decision was recalculated');
    } });
    assert.equal(replay.childJobId, waiting.childJobId);
    await f.candidate('The complete selected alternative.', calls, { turn: 1 });
    const result = await runRoleplayWorkflowJob(f.context());
    assert.equal(result.result.status, 'completed');
    assert.deepEqual(f.records()[2].swipes, ['Answer', 'Other', 'Short', 'The complete selected alternative.']);
    assert.equal(f.records()[2].swipe_id, 3);
    assert.equal(f.records()[2].swipe_info.length, 4);
    assert.equal(f.records()[2].mes, 'The complete selected alternative.');
    assert.equal(calls.count, 2);
});

test('a zero-target automatic continuation cannot multiply Companion text turns', t => {
    const f = prepared(t, 'append', { autoContinue: true, continueTarget: 0 });
    assert.equal(f.request.automatic.continuation.enabled, false);
    assert.equal(f.request.capacity.companionTurns, 1);
    assert.equal(f.request.capacity.maxTurns, 16);
});

test('automatic alternatives to a continuation preserve the original selected swipe and unrelated alternatives', async t => {
    const f = prepared(t, 'continue', { autoSwipe: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate('Short', calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    assert.deepEqual(f.records()[2].swipes, ['Answer', 'Other']);
    await f.candidate(' The complete selected continuation contains enough new detail.', calls, { turn: 1 });
    assert.equal((await runRoleplayWorkflowJob(f.context())).result.status, 'completed');
    assert.deepEqual(f.records()[2].swipes, ['Answer', 'Other', 'AnswerShort',
        'Answer The complete selected continuation contains enough new detail.']);
    assert.equal(f.records()[2].swipe_id, 3);
    assert.equal(f.records()[2].swipe_info.length, 4);
    assert.equal(calls.count, 2);
});

test('automatic continuation saves chunks and publishes only the complete selected reply', async t => {
    const f = prepared(t, 'append', { autoContinue: true });
    assert.equal(f.request.capacity.companionTurns, 16);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0, check(options, turn) {
        if (turn === 1) assert.ok(options.messages.some(message => message.role === 'assistant'
            && message.content === 'The first saved sentence is short.'));
    } };
    await f.candidate('The first saved sentence is short.', calls);
    const waiting = await runRoleplayWorkflowJob(f.context());
    assert.equal(waiting.waiting, true);
    assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:0').decision.kind, 'continue');
    assert.equal(f.records().length, 3);
    await f.candidate(' The second sentence completes the selected reply with enough words to reach its token target. '.repeat(4),
        calls, { turn: 1 });
    const done = await runRoleplayWorkflowJob(f.context());
    assert.equal(done.result.status, 'completed');
    assert.equal(f.records().length, 4);
    assert.ok(f.records().at(-1).mes.startsWith('The first saved sentence is short. The second sentence completes'));
    assert.equal(calls.count, 2);
});

test('a thinking-only workflow fails before Agents or automatic continuation and keeps one message', async t => {
    const f = prepared(t, 'append', { agents: true, autoContinue: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    let agentCalls = 0;
    const response = { choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'Thinking without a story.' } }] };
    await assert.rejects(f.candidate('', calls, { response, generateAgent: async () => { agentCalls++; return { text: 'Incorrect rewrite' }; } }),
        { code: 'GENERATION_NO_ANSWER' });
    const child = f.childJob();
    assert.equal(readArtifact(f.dirs, child.id, 'roleplay-candidate'), undefined);
    assert.equal(readArtifact(f.dirs, child.id, 'roleplay-main-complete'), undefined);
    assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:0'), undefined);
    assert.equal(f.records().at(-1).mes, '');
    assert.equal(f.records().at(-1).extra.reasoning, 'Thinking without a story.');
    // The keeper has changed the chat. Replaying this old candidate must fail
    // its source check before it can dispatch another request.
    await assert.rejects(f.candidate('', calls, { response, generateAgent: async () => { agentCalls++; return { text: 'Incorrect rewrite' }; } }),
        { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(calls.count, 1);
    assert.equal(agentCalls, 0);
    assert.equal(f.records().length, 4);
    assert.equal(getJob(f.dirs, f.jobId).children.length, 1);
});

test('an automatically continued thinking-only turn recovers only the suffix after the assembled prefix, once', async t => {
    // The rewrite Agent is off here, so turn 0 makes no unscripted model call before its continue decision.
    const f = prepared(t, 'append', { agents: true, recovery: true, rewrite: false, autoContinue: true, continueTarget: 6 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate('Visible prose.', calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const agentPrompts = [];
    await f.candidate('', calls, { turn: 1, response: { choices: [{ finish_reason: 'stop',
        message: { content: '', reasoning_content: 'She closes the door behind her.' } }] },
    generateAgent: async ({ messages }) => {
        const body = JSON.stringify(messages);
        agentPrompts.push(body);
        return { text: body.includes('RECOVER') ? ' and the door closed.' : 'Rewritten reply.' };
    } });
    const output = await runRoleplayWorkflowJob(f.context());
    assert.equal(output.result.status, 'completed');
    assert.equal(agentPrompts.length, 1, 'recovery makes exactly one agent request for the thinking-only turn');
    // The prompt is JSON-encoded, so the saved prefix appears with escaped newlines.
    assert.ok(agentPrompts[0].includes('<reply_so_far>\\nVisible prose.\\n</reply_so_far>'));
    assert.match(agentPrompts[0], /continues it from exactly where it stops/);
    const accepted = f.records().at(-1);
    assert.equal(accepted.mes, 'Visible prose. and the door closed.', 'the accepted reply joins the earlier chunk and the suffix once');
    assert.equal(accepted.extra.reasoning, 'She closes the door behind her.');
    assert.equal(accepted.extra.inChatAgentThinkingRecovery.status, 'done');
    assert.equal(f.records().filter(record => record.mes?.includes('Visible prose.')).length, 1, 'the earlier chunk is never written twice');
});

for (const [seam, recovered, rewritten, expected] of [
    ['space', ' and the door closed.', 'and the door closed.', 'Visible prose. and the door closed.'],
    ['paragraph', '\n\nShe closes the door.', 'She closes the door.', 'Visible prose.\n\nShe closes the door.'],
]) {
    test(`an automatically continued thinking-only turn with a rewrite keeps its ${seam} seam and is accepted`, async t => {
        const f = prepared(t, 'append', { agents: true, recovery: true, autoContinue: true, continueTarget: 6 });
        updateJob(f.dirs, f.jobId, { state: 'running' });
        await runRoleplayWorkflowJob(f.context());
        const calls = { count: 0 };
        const rewrites = [];
        const agentFor = async ({ messages }) => {
            const body = JSON.stringify(messages);
            if (body.includes('RECOVER')) return { text: recovered };
            rewrites.push(body);
            // The rewrite returns the chunk without its leading whitespace, as a trimming model reply would.
            return { text: rewrites.length === 1 ? 'Visible prose.' : rewritten };
        };
        await f.candidate('Visible prose.', calls, { generateAgent: agentFor });
        assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
        await f.candidate('', calls, { turn: 1, response: { choices: [{ finish_reason: 'stop',
            message: { content: '', reasoning_content: 'She closes the door behind her.' } }] }, generateAgent: agentFor });
        const output = await runRoleplayWorkflowJob(f.context());
        assert.equal(output.result.status, 'completed');
        const accepted = f.records().at(-1);
        assert.equal(accepted.mes, expected, 'the seam keeps exactly one space or paragraph break');
        assert.equal(accepted.extra.reasoning, 'She closes the door behind her.');
        assert.equal(accepted.extra.inChatAgentThinkingRecovery.status, 'done');
        assert.equal(rewrites.length, 2, 'the rewrite runs once on each turn, after the recovery on the second');
        assert.equal(f.records().filter(record => record.mes?.includes('Visible prose.')).length, 1);
    });
}

for (const effect of ['append', 'continue']) for (const complete of [true, false]) {
    test(`a thinking-only automatic continuation keeps its accepted ${effect} prefix (complete: ${complete})`, async t => {
        const f = prepared(t, effect, { autoContinue: true, continueTarget: 100 });
        updateJob(f.dirs, f.jobId, { state: 'running' });
        await runRoleplayWorkflowJob(f.context());
        const calls = { count: 0 };
        await f.candidate(' smiled.', calls);
        assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
        const child = f.childJob(1);
        if (complete) {
            await assert.rejects(f.candidate('', calls, { turn: 1, response: { choices: [{ finish_reason: 'length',
                message: { content: '', reasoning_content: 'Thinking after the accepted prefix.' } }] } }), { code: 'GENERATION_NO_ANSWER' });
        } else {
            updateJob(f.dirs, child.id, { state: 'running' });
            const context = { owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, child.id) };
            publishRoleplayPreview(context, { text: '', reasoning: 'Thinking after the accepted prefix.', stage: 'generating' });
            assert.equal(preserveInterruptedRoleplayReply(context, new Error('Incomplete stream')).state, 'done');
        }
        const saved = f.records().at(-1);
        assert.equal(saved.mes, effect === 'continue' ? 'Answer smiled.' : ' smiled.');
        assert.equal(saved.extra.reasoning, 'Thinking after the accepted prefix.');
        assert.equal(saved.extra.generation_outcome.reason, complete ? 'reasoning_only_length' : 'incomplete_stream');
        assert.equal(f.records().length, effect === 'continue' ? 3 : 4);
        assert.equal(calls.count, complete ? 2 : 1);
    });
}

test('a stopped second automatic turn keeps the completed first turn and the latest partial', async t => {
    const f = prepared(t, 'append', { autoContinue: true, continueTarget: 100 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate('The first completed sentence. ', calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    assert.equal(readWorkflowReplyText({ directories: f.dirs, rootJobId: f.jobId, turn: 0 }).text,
        'The first completed sentence. ');
    const child = f.childJob(1);
    updateJob(f.dirs, child.id, { state: 'running' });
    publishRoleplayPreview({ owner: f.f.scope.owner, directories: f.dirs, job: child },
        { stage: 'generating', text: ' A second part.', gen_started: '2026-10-29T10:00:00.000Z' });
    requestCancellation(f.dirs, f.jobId, { reason: 'user_cancelled' });
    const stopped = preserveInterruptedRoleplayReply({ owner: f.f.scope.owner, directories: f.dirs,
        job: getJob(f.dirs, child.id), signal: AbortSignal.abort() },
    Object.assign(new Error('The reply was stopped.'), { name: 'AbortError' }));
    assert.equal(stopped.state, 'done');
    assert.equal(f.records().at(-1).mes, 'The first completed sentence.  A second part.');
    assert.equal(f.records().filter(record => record.mes === 'The first completed sentence. ').length, 0);
});

test('a Stop after a tool turn in the middle of a continuation keeps the earlier finished chunk', async t => {
    const f = prepared(t, 'append', { assistant: true, autoContinue: true, continueTarget: 200 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate('The first completed sentence. ', calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:0').decision.kind, 'continue');
    await f.candidate('', calls, { turn: 1, response: { choices: [{ message: { tool_calls: [{ id: 'call-roster', type: 'function',
        function: { name: 'Neconyan_Assistant_ListCharacters', arguments: '{}' } }] } }] } });
    const toolJobId = (await runRoleplayWorkflowJob(f.context())).childJobId;
    setJobState(f.dirs, toolJobId, 'running');
    await runAssistantToolJob({ owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, toolJobId),
        signal: new AbortController().signal });
    setJobState(f.dirs, toolJobId, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    setJobState(f.dirs, f.jobId, 'running');
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const child = f.childJob(2);
    updateJob(f.dirs, child.id, { state: 'running' });
    publishRoleplayPreview({ owner: f.f.scope.owner, directories: f.dirs, job: child },
        { stage: 'generating', text: ' A third part.', gen_started: '2026-10-29T10:00:00.000Z' });
    requestCancellation(f.dirs, f.jobId, { reason: 'user_cancelled' });
    const stopped = preserveInterruptedRoleplayReply({ owner: f.f.scope.owner, directories: f.dirs,
        job: getJob(f.dirs, child.id), signal: AbortSignal.abort() },
    Object.assign(new Error('The reply was stopped.'), { name: 'AbortError' }));
    assert.equal(stopped.state, 'done');
    assert.equal(f.records().length, 4);
    assert.equal(f.records().at(-1).mes, 'The first completed sentence.  A third part.');
});

/** Press Stop through the real cancel route, as the page does. */
async function pressStop(t, f) {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: f.f.scope.owner }, directories: f.dirs };
        next();
    });
    app.use('/api/jobs', jobsRouter);
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
    await new Promise(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/jobs/${f.jobId}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'user_cancelled' }) });
    assert.equal(response.status, 200);
    return response.json();
}

test('pressing Stop while the next automatic chunk is still queued saves the finished first chunk once', async t => {
    const f = prepared(t, 'append', { autoContinue: true, continueTarget: 200 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    await f.candidate('The first completed and paid sentence. ', { count: 0 });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    assert.equal(f.childJob(1).state, 'queued');
    assert.equal((await pressStop(t, f)).job.state, 'cancelled');
    assert.equal(f.childJob(1).state, 'cancelled');
    assert.equal(f.records().length, 4);
    assert.equal(f.records().at(-1).mes, 'The first completed and paid sentence. ');
    assert.equal(readArtifact(f.dirs, f.childJob(0).id, KEPT_REPLY_ARTIFACT).state, 'done');
    assert.deepEqual(releaseStoppedRoleplayWorkflow({ owner: f.f.scope.owner, directories: f.dirs })(
        { state: 'accepted', jobId: f.jobId, effects: {} }), { stopped: true, chatChanged: true });
    // A second press finds the saved keeper record and adds nothing.
    await pressStop(t, f);
    assert.equal(f.records().length, 4);
});

test('pressing Stop before the first reply starts leaves the chat unchanged', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const before = f.records();
    assert.equal((await pressStop(t, f)).job.state, 'cancelled');
    assert.deepEqual(f.records(), before);
    assert.equal(readArtifact(f.dirs, f.childJob(0).id, KEPT_REPLY_ARTIFACT), undefined);
});

test('an automatic continuation chunk joins literally and keeps its target swipes', async t => {
    const f = prepared(t, 'continue', { autoContinue: true, continueTarget: 100 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate(' smiled.', calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const child = f.childJob(1);
    updateJob(f.dirs, child.id, { state: 'running' });
    publishRoleplayPreview({ owner: f.f.scope.owner, directories: f.dirs, job: child },
        { stage: 'generating', text: ' and waved.', gen_started: '2026-10-29T10:00:00.000Z' });
    requestCancellation(f.dirs, f.jobId, { reason: 'user_cancelled' });
    const kept = preserveInterruptedRoleplayReply({ owner: f.f.scope.owner, directories: f.dirs,
        job: getJob(f.dirs, child.id), signal: AbortSignal.abort() },
    Object.assign(new Error('The reply was stopped.'), { name: 'AbortError' }));
    assert.equal(kept.state, 'done');
    assert.equal(f.records()[2].mes, 'Answer smiled. and waved.');
    assert.deepEqual(f.records()[2].swipes, ['Answer smiled. and waved.', 'Other']);
    assert.equal(f.records()[2].swipe_id, 0);
});

for (const [continuedText, expected] of [
    ['Answer ... and waved.', 'Answer smiled. ... and waved.'],
    ['Answer smiled. and waved.', 'Answer smiled. and waved.'],
]) test(`a mixed continuation joins through the saved prefix before a turn decision: ${continuedText}`, async t => {
    const f = prepared(t, 'continue', { autoContinue: true, continueTarget: 1000 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate(' smiled.', calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const child = f.childJob(1);
    // The later turn has a full continuedText while the saved prior turn keeps
    // its authoritative continuation prefix and suffix.
    const output = { text: ' and waved.', continuedText, extra: { token_count: 4 } };
    const value = { intentHash: roleplayHash(child.intent), kind: 'text',
        providerHash: roleplayHash({ text: ' and waved.' }), output };
    writeArtifact(f.dirs, child.id, 'roleplay-candidate', { ...value, hash: roleplayHash(value) });
    setJobState(f.dirs, child.id, 'completed');
    const kept = keepRoleplayReply({ owner: f.f.scope.owner, directories: f.dirs,
        job: getJob(f.dirs, child.id), signal: new AbortController().signal }, { reason: 'stopped', rootJobId: f.jobId });
    assert.equal(kept.state, 'done');
    assert.equal(f.records()[2].mes, expected);
    assert.equal(f.records().length, 3);
    assert.deepEqual(f.records()[2].swipes, [expected, 'Other']);
    assert.equal(f.records()[2].mes.includes('AnswerAnswer'), false);
});

test('a mixed Agent full prefix and later continuation chunk joins without overlap guessing', async t => {
    const f = prepared(t, 'continue', { autoContinue: true, continueTarget: 1000, agents: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate(' smiled.', calls, { generateAgent: async () => ({ text: 'Answer smiled.' }) });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const child = f.childJob(1);
    updateJob(f.dirs, child.id, { state: 'running' });
    publishRoleplayPreview({ owner: f.f.scope.owner, directories: f.dirs, job: child },
        { stage: 'generating', text: ' ... and waved.', gen_started: '2026-10-29T10:00:00.000Z' });
    requestCancellation(f.dirs, f.jobId, { reason: 'user_cancelled' });
    const kept = preserveInterruptedRoleplayReply({ owner: f.f.scope.owner, directories: f.dirs,
        job: getJob(f.dirs, child.id), signal: AbortSignal.abort() },
    Object.assign(new Error('The reply was stopped.'), { name: 'AbortError' }));
    assert.equal(kept.state, 'done');
    assert.equal(f.records()[2].mes, 'Answer smiled. ... and waved.');
    assert.equal(f.records().length, 3);
    assert.deepEqual(f.records()[2].swipes, ['Answer smiled. ... and waved.', 'Other']);
});

test('a later Agent full continuation replaces the saved suffix instead of repeating it', async t => {
    const f = prepared(t, 'continue', { autoContinue: true, continueTarget: 1000, agents: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    const decide = kind => (policy, output) => ({ kind,
        textHash: roleplayHash(output?.continuedText ?? output?.text ?? '') });
    await f.candidate(' smiled.', calls, { generateAgent: async () => ({ text: 'Answer smiled.' }) });
    assert.equal((await runRoleplayWorkflowJob(f.context(), { decideCandidate: decide('continue') })).waiting, true);
    await f.candidate(' and waved.', calls, { turn: 1,
        generateAgent: async () => ({ text: 'Answer smiled. and waved.' }) });
    await assert.rejects(runRoleplayWorkflowJob(f.context(), { decideCandidate: decide('final'),
        beforeCommit: () => { throw new Error('The saved final write was refused.'); } }), /saved final write was refused/);
    assert.equal(readWorkflowReplyText({ directories: f.dirs, rootJobId: f.jobId, turn: 1 }).text,
        'Answer smiled. and waved.');
    const records = f.records();
    assert.equal(records.length, 3);
    assert.equal(records[2].mes, 'Answer smiled. and waved.');
    assert.deepEqual(records[2].swipes, ['Answer smiled. and waved.', 'Other']);
});

test('a saved raw continuation chunk and a later Agent full output join once', async t => {
    const f = prepared(t, 'continue', { autoContinue: true, continueTarget: 1000 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate(' smiled.', calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const child = f.childJob(1);
    // An older saved step kept only this turn's raw chunk, before the
    // authoritative source prefix was recorded.
    const prior = { version: 1, parentIntentHash: roleplayHash(getJob(f.dirs, f.jobId).intent), turn: 0,
        selected: true, output: { text: ' smiled.' }, text: ' smiled.', chunk: true, textHash: roleplayHash(' smiled.') };
    writeArtifact(f.dirs, f.jobId, 'roleplay-workflow-assembled:0', { ...prior, hash: roleplayHash(prior) });
    const output = { text: ' and waved.', continuedText: 'Answer smiled. and waved.', extra: { token_count: 4 } };
    const value = { intentHash: roleplayHash(child.intent), kind: 'text',
        providerHash: roleplayHash({ text: ' and waved.' }), output };
    writeArtifact(f.dirs, child.id, 'roleplay-candidate', { ...value, hash: roleplayHash(value) });
    setJobState(f.dirs, child.id, 'completed');
    const kept = keepRoleplayReply({ owner: f.f.scope.owner, directories: f.dirs,
        job: getJob(f.dirs, child.id), signal: new AbortController().signal }, { reason: 'stopped', rootJobId: f.jobId });
    assert.equal(kept.state, 'done');
    const records = f.records();
    assert.equal(records.length, 3);
    assert.equal(records[2].mes, 'Answer smiled. and waved.');
    assert.deepEqual(records[2].swipes, ['Answer smiled. and waved.', 'Other']);
    assert.equal(records[2].swipe_id, 0);
});

test('a rejected later automatic turn keeps the earlier accepted continuation', async t => {
    const f = prepared(t, 'continue', { autoContinue: true, continueTarget: 1000 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate(' smiled.', calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const root = getJob(f.dirs, f.jobId);
    const child = f.childJob(1);
    const output = { text: ' and waved.', continuedText: 'Answer smiled. and waved.' };
    const value = { intentHash: roleplayHash(child.intent), kind: 'text',
        providerHash: roleplayHash({ text: ' and waved.' }), output };
    const candidate = { ...value, hash: roleplayHash(value) };
    writeArtifact(f.dirs, child.id, 'roleplay-candidate', candidate);
    setJobState(f.dirs, child.id, 'completed');
    // This turn's alternative was rejected; the earlier accepted text stays.
    const decision = { parentIntentHash: roleplayHash(root.intent), childJobId: child.id, candidateHash: candidate.hash,
        turn: 1, outputHash: roleplayHash(output), decision: { kind: 'swipe', textHash: roleplayHash(' and waved.') } };
    writeArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:1', { ...decision, hash: roleplayHash(decision) });
    recordWorkflowReplyText(f.context(), root, 1, null, { selected: false });
    const kept = preserveRoleplayWorkflowReply(f.context(), new Error('The reply failed after the rejection.'));
    assert.equal(kept.state, 'done');
    const records = f.records();
    assert.equal(records.length, 3);
    assert.equal(records[2].mes, 'Answer smiled.');
    assert.deepEqual(records[2].swipes, ['Answer smiled.', 'Other']);
    assert.equal(records.some(record => record.mes?.includes(' and waved.')), false);
});

test('a rejection of the accumulated reply never restores its earlier turns', async t => {
    const f = prepared(t, 'continue', { autoContinue: true, continueTarget: 1000 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate(' smiled.', calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const root = getJob(f.dirs, f.jobId);
    const child = f.childJob(1);
    const output = { text: ' and waved.', continuedText: 'Answer smiled. and waved.' };
    const value = { intentHash: roleplayHash(child.intent), kind: 'text',
        providerHash: roleplayHash({ text: ' and waved.' }), output };
    const candidate = { ...value, hash: roleplayHash(value) };
    writeArtifact(f.dirs, child.id, 'roleplay-candidate', candidate);
    setJobState(f.dirs, child.id, 'completed');
    const decision = { parentIntentHash: roleplayHash(root.intent), childJobId: child.id, candidateHash: candidate.hash,
        turn: 1, outputHash: roleplayHash(output),
        decision: { kind: 'swipe', textHash: roleplayHash('Answer smiled. and waved.') } };
    writeArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:1', { ...decision, hash: roleplayHash(decision) });
    recordWorkflowReplyText(f.context(), root, 1, null, { selected: false });
    const before = f.records();
    assert.equal(preserveRoleplayWorkflowReply(f.context(), new Error('The whole reply was rejected.')), null);
    assert.deepEqual(f.records(), before);
    assert.equal(readArtifact(f.dirs, child.id, KEPT_REPLY_ARTIFACT), undefined);
});

test('a rejected automatic swipe candidate is never kept as a reply', async t => {
    const f = prepared(t, 'append', { autoSwipe: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate('Short', calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:0').decision.kind, 'swipe');
    const before = f.records();
    assert.equal(preserveRoleplayWorkflowReply(f.context(), new Error('The saved swipe was refused.')), null);
    assert.deepEqual(f.records(), before);
});

test('a refused second automatic turn keeps the completed first turn, not the refusal', async t => {
    const f = prepared(t, 'append', { autoContinue: true, continueTarget: 100 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate('The accepted first sentence. ', calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const child = f.childJob(1);
    const output = { message: { name: 'Nova', is_user: false, mes: 'Refused suffix',
        extra: { generation_outcome: { status: 'blocked' } } } };
    const value = { intentHash: roleplayHash(child.intent), kind: 'text', providerHash: roleplayHash({ text: 'Refused suffix' }), output };
    writeArtifact(f.dirs, child.id, 'roleplay-candidate', { ...value, hash: roleplayHash(value) });
    setJobState(f.dirs, child.id, 'completed');
    preserveRoleplayWorkflowReply(f.context(), Object.assign(new Error('The reply was refused.'),
        { code: 'ROLEPLAY_BLOCKED_RECOVERY' }));
    assert.equal(f.records().at(-1).mes, 'The accepted first sentence. ');
    assert.equal(f.records().some(record => record.mes === 'Refused suffix'), false);
});

test('a shutdown-aborted workflow root never writes a candidate before its retry', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate('A candidate that must wait for Retry.', calls);
    const before = f.records();
    const context = { ...f.context(), signal: AbortSignal.abort() };
    assert.equal(preserveRoleplayWorkflowReply(context, Object.assign(new Error('The server stopped.'),
        { code: 'INTERRUPTED' })), null);
    assert.deepEqual(f.records(), before);
});

test('an uncertain workflow failure never becomes a second chat write', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    await f.candidate('A candidate with an uncertain write.', { count: 0 });
    const before = f.records();
    assert.equal(preserveRoleplayWorkflowReply(f.context(), Object.assign(new Error('The write is uncertain.'),
        { code: 'ROLEPLAY_WRITE_UNCERTAIN' })), null);
    assert.deepEqual(f.records(), before);
});

test('a candidate with a writing normal publication is never keeper-written', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    await f.candidate('A candidate with an owned write.', { count: 0 });
    const child = f.childJob();
    const candidate = readArtifact(f.dirs, child.id, 'roleplay-candidate');
    withNativeMediaReceipt({ owner: f.f.scope.owner, directories: f.dirs, job: f.context().job }, ({ value, save }) => {
        value.effects.final = { state: 'writing', candidateHash: candidate.hash };
        save();
    }, { checkSource: false });
    const before = f.records();
    assert.equal(preserveRoleplayWorkflowReply(f.context(), new Error('The parent acknowledgement was lost.')), null);
    assert.deepEqual(f.records(), before);
});

test('a completed tool-turn candidate is never kept as reply preamble', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const child = f.childJob();
    const value = { intentHash: roleplayHash(child.intent), kind: 'tool-turn', callsHash: roleplayHash({ calls: [] }) };
    writeArtifact(f.dirs, child.id, 'roleplay-candidate', { ...value, hash: roleplayHash(value) });
    setJobState(f.dirs, child.id, 'completed');
    const before = f.records();
    assert.equal(preserveRoleplayWorkflowReply(f.context(), new Error('The tool turn failed.')), null);
    assert.deepEqual(f.records(), before);
});

test('a model tool turn completes an owned child and resumes a second bound model turn without provisional chat', async t => {
    const f = prepared(t, 'append', { assistant: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0, check(options, turn) {
        if (turn !== 1) return;
        assert.ok(options.messages.some(message => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call-roster'));
        assert.ok(options.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-roster'
            && message.content.includes('Nova.png')));
    } };
    await f.candidate('', calls, { response: { choices: [{ message: { tool_calls: [{ id: 'call-roster', type: 'function',
        function: { name: 'Neconyan_Assistant_ListCharacters', arguments: '{}' } }] } }] } });
    const waiting = await runRoleplayWorkflowJob(f.context());
    assert.equal(waiting.waiting, true);
    assert.equal(f.records().length, 3);
    const toolJobId = waiting.childJobId;
    assert.equal(getJob(f.dirs, toolJobId).parentId, f.jobId);
    setJobState(f.dirs, toolJobId, 'running');
    await runAssistantToolJob({ owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, toolJobId),
        signal: new AbortController().signal });
    setJobState(f.dirs, toolJobId, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    setJobState(f.dirs, f.jobId, 'running');
    const second = await runRoleplayWorkflowJob(f.context());
    assert.equal(second.waiting, true);
    assert.equal(f.records().length, 3);
    const history = readArtifact(f.dirs, f.jobId, 'roleplay-workflow-history:0');
    assert.deepEqual(history.history.map(message => message.role), ['assistant', 'tool']);
    await f.candidate('The character list is ready.', calls, { turn: 1 });
    const done = await runRoleplayWorkflowJob(f.context());
    assert.equal(done.result.status, 'completed');
    assert.equal(f.records().at(-1).mes, 'The character list is ready.');
    assert.equal(calls.count, 2);
    assert.equal(f.records()[2].mes, 'Answer');
});

test('a tool turn advances its lineage with the same captured page instruction', async t => {
    const promptControls = {
        ...controls,
        prompts: [{ identifier: 'main', role: 'system', content: 'MARK {{dialoguecolors}} MARK', system_prompt: true },
            { identifier: 'chatHistory', marker: true, system_prompt: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
    };
    const f = prepared(t, 'append', { pathfinder: true, bundledMacros: { dialoguecolors: 'COLOUR-INSTRUCTION' } });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate('', calls, { response: { choices: [{ message: { tool_calls: [{ id: 'call-notebook', type: 'function',
        function: { name: 'Pathfinder_Notebook', arguments: JSON.stringify({ action: 'write', key: 'door', content: 'The door is locked.' }) } }] } }] } });
    const waiting = await runRoleplayWorkflowJob(f.context());
    const toolJobId = waiting.childJobId;
    setJobState(f.dirs, toolJobId, 'running');
    await runPathfinderNotebookJob({ owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, toolJobId),
        signal: new AbortController().signal });
    setJobState(f.dirs, toolJobId, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    setJobState(f.dirs, f.jobId, 'running');
    await runRoleplayWorkflowJob(f.context());
    const lineage = readArtifact(f.dirs, f.jobId, 'roleplay-workflow-lineage:0');
    assert.deepEqual(lineage.worldInfo.bundledMacros, { dialoguecolors: 'COLOUR-INSTRUCTION' });
    await f.candidate('The saved door is locked.', { count: 0, check(options) {
        const main = options.messages.find(message => String(message.content).includes('MARK'));
        assert.ok(main, JSON.stringify(options.messages));
        assert.equal(main.content, 'MARK COLOUR-INSTRUCTION MARK');
    } }, { turn: 1, promptControls });
    const done = await runRoleplayWorkflowJob(f.context());
    assert.equal(done.result.status, 'completed');
});

test('a completed notebook tool advances only its owned chat source before the next model turn', async t => {
    const f = prepared(t, 'append', { pathfinder: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0, check(options, turn) {
        if (turn !== 1) return;
        assert.ok(options.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-notebook'
            && message.content.includes('Wrote') && message.content.includes('door')));
    } };
    await f.candidate('', calls, { response: { choices: [{ message: { tool_calls: [{ id: 'call-notebook', type: 'function',
        function: { name: 'Pathfinder_Notebook', arguments: JSON.stringify({ action: 'write', key: 'door', content: 'The door is locked.' }) } }] } }] } });
    const waiting = await runRoleplayWorkflowJob(f.context());
    const toolId = waiting.childJobId;
    setJobState(f.dirs, toolId, 'running');
    await runPathfinderNotebookJob({ owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, toolId),
        signal: new AbortController().signal });
    setJobState(f.dirs, toolId, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    setJobState(f.dirs, f.jobId, 'running');
    const next = await runRoleplayWorkflowJob(f.context());
    assert.equal(next.waiting, true);
    assert.equal(f.records()[0].chat_metadata.pathfinder_notebook.entries[0].content, 'The door is locked.');
    assert.equal(f.records().at(-1).mes, 'Answer');
    await f.candidate('The saved door is locked.', calls, { turn: 1 });
    const done = await runRoleplayWorkflowJob(f.context());
    assert.equal(done.result.status, 'completed');
    assert.equal(f.records().at(-1).mes, 'The saved door is locked.');
    assert.equal(calls.count, 2);
});

authoringRenameTest('an owned lorebook tool changes only its bound book before the next model turn', async t => {
    const f = prepared(t, 'append', { pathfinder: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate('', calls, { response: { choices: [{ message: { tool_calls: [{ id: 'call-summary', type: 'function',
        function: { name: 'Pathfinder_Summarize', arguments: JSON.stringify({ title: 'Safe route',
            content: 'The stairway is clear.', book: 'Manual' }) } }] } }] } });
    const waiting = await runRoleplayWorkflowJob(f.context());
    const toolId = waiting.childJobId;
    setJobState(f.dirs, toolId, 'running');
    await runPathfinderToolJob({ owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, toolId),
        signal: new AbortController().signal });
    setJobState(f.dirs, toolId, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    setJobState(f.dirs, f.jobId, 'running');
    const next = await runRoleplayWorkflowJob(f.context());
    assert.equal(next.waiting, true);
    assert.equal(f.records().length, 3);
    assert.ok(Object.values(JSON.parse(fs.readFileSync(path.join(f.dirs.worlds, 'Manual.json'), 'utf8')).entries)
        .some(entry => entry.comment === '[Summary] Safe route'));
    await f.candidate('The route is safe.', calls, { turn: 1 });
    const done = await runRoleplayWorkflowJob(f.context());
    assert.equal(done.result.status, 'completed');
    assert.equal(f.records().at(-1).mes, 'The route is safe.');
    assert.equal(calls.count, 2);
});

authoringRenameTest('multiple tool calls in one model reply advance only their owned book changes in order', async t => {
    const f = prepared(t, 'append', { pathfinder: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0, check(options, turn) {
        if (turn !== 1) return;
        const tools = options.messages.filter(message => message.role === 'tool');
        assert.deepEqual(tools.map(message => message.tool_call_id), ['summary-1', 'search-2']);
    } };
    const toolCalls = [{ id: 'summary-1', type: 'function', function: { name: 'Pathfinder_Summarize',
        arguments: JSON.stringify({ title: 'First safe route', content: 'The bridge is safe.', book: 'Manual' }) } },
    { id: 'search-2', type: 'function', function: { name: 'Pathfinder_Search', arguments: JSON.stringify({ book: 'Manual' }) } }];
    await f.candidate('', calls, { response: { choices: [{ message: { tool_calls: toolCalls } }] } });
    let waiting = await runRoleplayWorkflowJob(f.context());
    let childId = waiting.childJobId;
    const firstChildId = childId;
    setJobState(f.dirs, childId, 'running');
    await runPathfinderToolJob({ owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, childId),
        signal: new AbortController().signal });
    setJobState(f.dirs, childId, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    setJobState(f.dirs, f.jobId, 'running');
    waiting = await runRoleplayWorkflowJob(f.context());
    childId = waiting.childJobId;
    assert.notEqual(childId, firstChildId);
    setJobState(f.dirs, childId, 'running');
    await runPathfinderToolJob({ owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, childId),
        signal: new AbortController().signal });
    setJobState(f.dirs, childId, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    setJobState(f.dirs, f.jobId, 'running');
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    await f.candidate('The ordered tools completed.', calls, { turn: 1 });
    assert.equal((await runRoleplayWorkflowJob(f.context())).result.status, 'completed');
    assert.equal(f.records().at(-1).mes, 'The ordered tools completed.');
    assert.equal(calls.count, 2);
});

test('a native workflow reply clears older history at the Mewmory trigger in its single protected publication and survives a restart', async t => {
    const f = prepared(t, 'append', { history: 20 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const reply = 'Workflow reply ' + 'detail '.repeat(120);
    await f.candidate(reply, { count: 0 });
    const destination = { ...f.f.locator, chat: 'Workflow renamed' };
    const { commitRoleplayLifecycleLocked } = await import('../src/roleplay-lifecycle.js');
    const { withRoleplayAccount } = await import('../src/roleplay-store.js');
    withRoleplayAccount(f.f.scope, f.account, lease => commitRoleplayLifecycleLocked(lease, {
        operationKey: 'workflow-hiding-rename', action: 'chat-rename', intent: { destination },
        steps: [{ op: 'move', kind: 'chat', locator: f.f.locator, destination }],
    }));
    enableMewmoryHiding(f.dirs, destination, { autoHideTokens: 1024 });
    const archiveFile = statePath(f.dirs, destination);
    const archiveBefore = fs.readFileSync(archiveFile);
    await assert.rejects(runRoleplayWorkflowJob(f.context(), { beforePublication: () => {
        throw new Error('Lost parent acknowledgement after the hidden write');
    } }), /Lost parent acknowledgement/);
    const saved = readRoleplayChat(f.f.scope, destination).records;
    assert.equal(saved.at(-1).mes, reply);
    assert.ok(!saved.at(-1).is_system);
    const rows = saved.slice(1);
    const firstVisible = rows.findIndex(row => !row.is_system);
    assert.equal(firstVisible, rows.length - 1, 'every older visible message is cleared in one pass');
    assert.ok(rows.slice(0, firstVisible).every(row => row.is_system && row.extra?.mewmoryKeepHidden === true));
    assert.ok(rows.slice(firstVisible).every(row => !row.is_system));
    const completed = await runRoleplayWorkflowJob(f.context());
    assert.equal(completed.result.status, 'completed');
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), completed);
    assert.deepEqual(readRoleplayChat(f.f.scope, destination).records, saved);
    assert.deepEqual(fs.readFileSync(archiveFile), archiveBefore);
});

test('a final chat write can resume from its owned proof after losing only the parent acknowledgement', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    await f.candidate('Only one published reply.', { count: 0 });
    await assert.rejects(runRoleplayWorkflowJob(f.context(), { beforePublication: () => { throw new Error('Lost parent acknowledgement'); } }),
        /Lost parent acknowledgement/);
    const original = f.records();
    assert.equal(original.at(-1).mes, 'Only one published reply.');
    const result = await runRoleplayWorkflowJob(f.context());
    assert.equal(result.result.status, 'completed');
    assert.deepEqual(f.records(), original);
});

test('an unrelated chat edit after the owned final write cannot be reported as a completed workflow', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    await f.candidate('Only the saved result may finish.', { count: 0 });
    await assert.rejects(runRoleplayWorkflowJob(f.context(), { beforePublication: () => {
        const changed = f.records();
        changed[1].mes = 'Externally edited before the parent closed.';
        fs.writeFileSync(f.f.filename, changed.map(record => JSON.stringify(record)).join('\n'));
    } }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(f.records()[1].mes, 'Externally edited before the parent closed.');
    await assert.rejects(runRoleplayWorkflowJob(f.context()), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(getJob(f.dirs, f.jobId).state, 'running');
});

test('cancellation after the final candidate and before its protected publication keeps the completed reply', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate('A complete but unpublished reply.', calls);
    await assert.rejects(runRoleplayWorkflowJob(f.context(), { beforeCommit: () => {
        requestCancellation(f.dirs, f.jobId);
    } }), { code: 'ROLEPLAY_WORKFLOW_RECOVERY' });
    // The paid reply is kept once, as a new message, before the terminal job.
    assert.equal(f.records().length, 4);
    assert.equal(f.records()[3].mes, 'A complete but unpublished reply.');
    assert.equal(f.records()[3].extra.roleplay_kept_reply.reason, 'stopped');
    assert.equal(f.records()[3].extra.roleplay_kept_reply.rootJobId, f.jobId);
    assert.equal(getJob(f.dirs, f.jobId).cancellation.requested, true);
    assert.equal(calls.count, 1);
    await assert.rejects(runRoleplayWorkflowJob(f.context(), { beforeCommit: () => {
        throw new Error('A cancelled workflow was replayed');
    } }), { code: 'ROLEPLAY_WORKFLOW_RECOVERY' });
    assert.equal(f.records().length, 4);
});

test('a changed accepted source or cancelled parent refuses before candidate work or a chat write', async t => {
    const changed = prepared(t);
    changed.f.records[1].mes = 'Altered user.';
    fs.writeFileSync(changed.f.filename, changed.f.records.map(record => JSON.stringify(record)).join('\n'));
    updateJob(changed.dirs, changed.jobId, { state: 'running' });
    await assert.rejects(runRoleplayWorkflowJob(changed.context()), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(getJob(changed.dirs, changed.jobId).children.length, 0);
    assert.equal(changed.records().length, 3);
    const cancelled = prepared(t, 'continue');
    requestCancellation(cancelled.dirs, cancelled.jobId);
    await assert.rejects(runRoleplayWorkflowJob(cancelled.context()), { code: 'ROLEPLAY_WORKFLOW_RECOVERY' });
    assert.equal(cancelled.records()[2].mes, 'Answer');
});

test('a pathological saved swipe expression is refused before a model request is admitted', t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    const dirs = f.scope.directories;
    dirs.openAI_Settings = path.join(dirs.root, 'openai-presets');
    fs.mkdirSync(dirs.openAI_Settings);
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Main.json'), JSON.stringify({ openai_max_context: 4096 }));
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: [] } },
        power_user: { auto_swipe: true, auto_swipe_blacklist: ['(a+)+$'], auto_swipe_blacklist_threshold: 2 },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1' },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture', preset: 'Main',
            'api-url': 'http://127.0.0.1:18000/v1' }] } },
    }));
    const source = f.source();
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    assert.throws(() => captureRoleplayWorkflowRequest(f.scope, account, source, { avatar: 'Nova.png',
        binding: { kind: 'profile', ...captureChatProfile(dirs, 'main') }, maxTokens: 32 }), {
        code: 'ROLEPLAY_WORKFLOW_INVALID',
    });
    assert.deepEqual(f.records, fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)));
});

test('a captured page instruction resolves inside the accepted preset and a recovered run reuses it', async t => {
    const promptControls = {
        prompts: [{ identifier: 'main', role: 'system', content: 'MARK {{dialoguecolors}} MARK', system_prompt: true },
            { identifier: 'chatHistory', marker: true, system_prompt: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
    };
    const f = prepared(t, 'append', { bundledMacros: { dialoguecolors: 'COLOUR-INSTRUCTION' } });
    assert.deepEqual(f.request.worldInfo.bundledMacros, { dialoguecolors: 'COLOUR-INSTRUCTION' });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0, check(options) {
        const main = options.messages.find(message => String(message.content).includes('MARK'));
        assert.ok(main, JSON.stringify(options.messages));
        assert.equal(main.content, 'MARK COLOUR-INSTRUCTION MARK');
    } };
    await f.candidate('Resolved from the capture.', calls, { promptControls });
    const done = await runRoleplayWorkflowJob(f.context());
    assert.equal(done.result.status, 'completed');
    assert.equal(f.records().at(-1).mes, 'Resolved from the capture.');
    // The stored prepared prompt and receipt are reused, so no second paid request is made.
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), done);
    assert.equal(calls.count, 1);
});

test('an accepted request without the capture refuses the dialogue colours placeholder before provider work', async t => {
    const promptControls = {
        prompts: [{ identifier: 'main', role: 'system', content: 'MARK {{dialoguecolors}} MARK', system_prompt: true },
            { identifier: 'chatHistory', marker: true, system_prompt: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
    };
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await assert.rejects(f.candidate('Never sent.', calls, { promptControls }), { code: 'MACRO_BUNDLED_MISSING' });
    assert.equal(calls.count, 0);
    assert.equal(f.records().length, 3);
});

test('Jev retrieval works in server pipeline and waypoint jobs, and recovery reuses paid scores', async t => {
    for (const pipelineEnabled of [false, true]) await t.test(`pipeline: ${pipelineEnabled}`, async t => {
        const requests = [];
        const server = http.createServer(async (req, res) => {
            let body = '';
            for await (const chunk of req) body += chunk;
            const input = JSON.parse(body);
            requests.push(input);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ decisions: Object.fromEntries(Object.keys(input.questions).map(key => [key, 0.9])) }));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => { server.closeAllConnections(); server.close(); });
        const f = prepared(t, 'append', { pathfinder: true, pathfinderSettings: { pipelineEnabled,
            modelConnection: 'manual', modelEndpoint: `http://127.0.0.1:${server.address().port}/v1/systemone`,
            modelOverride: 'open-jev-9b', decisionThreshold: 0.1 } });
        updateJob(f.dirs, f.jobId, { state: 'running' });
        await runRoleplayWorkflowJob(f.context());
        const child = f.childJob();
        await assert.rejects(f.runChild(child, { generate: async () => { throw new Error('Stopped before main reply'); } }), /Stopped before main reply/);
        const count = requests.length;
        assert.equal(count, pipelineEnabled ? 2 : 1);
        const result = readArtifact(f.dirs, child.id, 'roleplay-pathfinder');
        assert.match(result.prompt.content, /broken telescope/);
        assert.equal(result.stageResults[0].scores[0].score, 0.9);
        await f.candidate('The telescope is broken.', { count: 0, check(options) {
            assert.match(JSON.stringify(options.messages), /broken telescope/);
        } });
        assert.equal(requests.length, count, 'recovery must reuse the saved retrieval');
    });
});

test('an unknown Jev outcome in server retrieval cannot be charged again on recovery', async t => {
    let requests = 0;
    const server = http.createServer(req => { requests++; req.socket.destroy(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const f = prepared(t, 'append', { pathfinder: true, pathfinderSettings: { modelConnection: 'manual',
        modelEndpoint: `http://127.0.0.1:${server.address().port}/v1/systemone`, modelOverride: 'open-jev-9b' } });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const child = f.childJob();
    const generate = async () => { assert.fail('The main model must wait for retrieval.'); };
    await assert.rejects(f.runChild(child, { generate }), /socket|hang up/i);
    await assert.rejects(f.runChild(child, { generate }), /unknown|recovery/i);
    assert.equal(requests, 1);
});

const markedControls = (extra = []) => ({
    prompts: [{ identifier: 'main', role: 'system', content: 'MARK {{dialoguecolors}} MARK', system_prompt: true },
        { identifier: 'chatHistory', marker: true, system_prompt: true }, ...extra],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true },
        ...extra.map(prompt => ({ identifier: prompt.identifier, enabled: false }))] }],
    function_calling: true,
});
const settledWorkflow = async (f, child) => {
    setJobState(f.dirs, child.id, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    setJobState(f.dirs, f.jobId, 'running');
    return runRoleplayWorkflowJob(f.context());
};
const savedReply = (child, text, { lose = false } = {}) => async options => {
    const step = roleplayHash(['workflow-candidate', child.id]);
    options.onProviderStep(`provider:${step}`);
    const result = await providerStep(options.jobContext, step, async () => { options.beforeDispatch(); return { text }; });
    if (lose) throw new Error('The worker stopped after the provider answered.');
    return result;
};

test('a missing capture refuses before paid Pathfinder retrieval, while a captured request pays for it', async t => {
    for (const captured of [false, true]) {
        await t.test(`captured: ${captured}`, async t => {
            const f = prepared(t, 'append', { pathfinder: true, ...(captured ? { bundledMacros: { dialoguecolors: 'COLOUR' } } : {}) });
            updateJob(f.dirs, f.jobId, { state: 'running' });
            await runRoleplayWorkflowJob(f.context());
            const calls = { count: 0 };
            const pathfinderCalls = { count: 0 };
            const run = f.candidate('Retrieved reply.', calls, { promptControls: markedControls(), pathfinderCalls });
            if (captured) {
                await run;
                assert.ok(pathfinderCalls.count > 0, 'the control request reaches its paid Pathfinder stage');
                assert.equal(calls.count, 1);
                return;
            }
            await assert.rejects(run, { code: 'MACRO_BUNDLED_MISSING', status: 409 });
            assert.equal(pathfinderCalls.count, 0);
            assert.equal(calls.count, 0);
            const child = f.childJob();
            for (const artifact of ['roleplay-history-input', 'roleplay-world-info', 'roleplay-pathfinder', 'roleplay-prompt']) {
                assert.equal(readArtifact(f.dirs, child.id, artifact), undefined, artifact);
            }
            assert.equal(f.records().length, 3);
        });
    }
});

test('a disabled preset prompt holding the placeholder does not refuse a request without the capture', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const controls = markedControls([{ identifier: 'unused', role: 'system', content: 'OFF {{dialoguecolors}}', system_prompt: false }]);
    controls.prompts[0].content = 'PLAIN MAIN';
    const calls = { count: 0, check(options) { assert.doesNotMatch(JSON.stringify(options.messages), /dialoguecolors|OFF/); } };
    await f.candidate('Plain reply.', calls, { promptControls: controls });
    assert.equal((await runRoleplayWorkflowJob(f.context())).result.status, 'completed');
    assert.equal(calls.count, 1);
});

test('older jobs without a capture recover their saved prompt and saved provider result without evaluating the placeholder', async t => {
    // Prepared evidence saved before captures existed is reused as frozen: the
    // placeholder now in the bound preset is neither scanned nor evaluated again.
    await t.test('saved prompt, provider not yet asked', async t => {
        const f = prepared(t);
        updateJob(f.dirs, f.jobId, { state: 'running' });
        await runRoleplayWorkflowJob(f.context());
        const child = f.childJob();
        await assert.rejects(f.runChild(child, { generate: async () => { throw new Error('The worker stopped before dispatch.'); } }),
            /stopped before dispatch/);
        const prompt = readArtifact(f.dirs, child.id, 'roleplay-prompt');
        assert.ok(prompt, 'the first run saved its prepared prompt');
        let sent;
        const answer = savedReply(child, 'Recovered from the saved prompt.');
        await f.runChild(child, { promptControls: markedControls(), generate: options => { sent = options.messages; return answer(options); } });
        assert.deepEqual(sent, prompt.messages);
        assert.deepEqual(readArtifact(f.dirs, child.id, 'roleplay-prompt'), prompt);
        assert.equal((await settledWorkflow(f, child)).result.status, 'completed');
        assert.equal(f.records().at(-1).mes, 'Recovered from the saved prompt.');
    });
    await t.test('saved provider result, reply not yet written', async t => {
        const f = prepared(t);
        updateJob(f.dirs, f.jobId, { state: 'running' });
        await runRoleplayWorkflowJob(f.context());
        const child = f.childJob();
        await assert.rejects(f.runChild(child, { generate: savedReply(child, 'Paid before the update.', { lose: true }) }),
            /stopped after the provider answered/);
        let calls = 0;
        await f.runChild(child, { promptControls: markedControls(), generate: async () => { calls++; throw new Error('not again'); } });
        assert.equal(calls, 0);
        assert.equal((await settledWorkflow(f, child)).result.status, 'completed');
        assert.equal(f.records().at(-1).mes, 'Paid before the update.');
    });
});

for (const policy of ['autoSwipe', 'autoContinue']) test(`filtered candidate saves once before ${policy}, Agents and tools`, async t => {
    const f = prepared(t, 'append', { agents: true, [policy]: true, assistant: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    let agentCalls = 0, decisions = 0;
    const text = 'A partial sentence with';
    await f.candidate(text, calls, { generateAgent: async () => { agentCalls++; throw new Error('Blocked Agent must not run'); },
        response: { choices: [{ finish_reason: 'content_filter', message: { content: text,
            tool_calls: [{ id: 'blocked-tool', type: 'function', function: { name: 'Neconyan_Assistant_ReadLorebookEntry', arguments: '{}' } }] } }] } });
    const first = await runRoleplayWorkflowJob(f.context(), { decideCandidate: async () => { decisions++; throw new Error('Blocked candidate must not be judged'); } });
    assert.equal(f.records().at(-1).mes, text);
    assert.equal(f.records().at(-1).extra.generation_outcome.status, 'blocked');
    assert.equal(calls.count, 1);
    assert.equal(agentCalls, 0);
    assert.equal(decisions, 0);
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), first);
});

test('an error candidate skips the decision, Agents, alternatives and hiding, saves once and replays identically', async t => {
    const f = prepared(t, 'append', { agents: true, autoSwipe: true, assistant: true, history: 20 });
    // A 1024-token hiding budget would hide the older context if hiding were prepared.
    enableMewmoryHiding(f.dirs, f.f.locator, { autoHideTokens: 1024 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    let agentCalls = 0, decisions = 0;
    const text = 'A partial sentence that ends with an error';
    await f.candidate(text, calls, { generateAgent: async () => { agentCalls++; throw new Error('Error Agent must not run'); },
        response: { choices: [{ finish_reason: 'error', message: { content: text,
            tool_calls: [{ id: 'error-tool', type: 'function', function: { name: 'Neconyan_Assistant_ReadLorebookEntry', arguments: '{}' } }] } }] } });
    const first = await runRoleplayWorkflowJob(f.context(), { decideCandidate: async () => { decisions++; throw new Error('Error candidate must not be judged'); } });
    assert.equal(first.result.status, 'completed');
    assert.equal(first.result.generationOutcome.status, 'error');
    assert.equal(f.records().at(-1).mes, text);
    assert.equal(f.records().at(-1).extra.generation_outcome.status, 'error');
    assert.equal(calls.count, 1);
    assert.equal(agentCalls, 0);
    assert.equal(decisions, 0);
    assert.ok(f.records().slice(1).every(record => !record.is_system && record.extra?.mewmoryKeepHidden !== true),
        'a terminated candidate hides no earlier message');
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), first);
});

test('a filtered automatic continuation retains its accepted prefix and exact blocked suffix', async t => {
    const f = prepared(t, 'append', { autoContinue: true, continueTarget: 100 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate('Accepted prefix. ', calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    await f.candidate('Unfinished suffix', calls, { turn: 1, response: { choices: [{ message: { content: 'Unfinished suffix' }, finish_reason: 'content_filter' }] } });
    const first = await runRoleplayWorkflowJob(f.context());
    assert.equal(f.records().at(-1).mes, 'Accepted prefix. Unfinished suffix');
    assert.equal(f.records().at(-1).extra.generation_outcome.status, 'blocked');
    assert.equal(calls.count, 2);
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), first);
    const child = f.childJob(1);
    const proof = readArtifact(f.dirs, child.id, 'roleplay-blocked-continuation');
    const combined = structuredClone(readArtifact(f.dirs, child.id, 'roleplay-candidate').output);
    combined.message.mes = 'Accepted prefix. Unfinished suffix';
    combined.blockedContinuationProof = proof.hash;
    combined.continuedText = 'Invented full reply';
    assert.throws(() => verifyBlockedOutputProof(f.dirs, child, combined, f.f.records), { code: 'ROLEPLAY_BLOCKED_RECOVERY' });
});

for (const changesPrefix of [false, true]) test(`a filtered automatic continuation retains the accepted Agent continuedText for a continue effect (rewritten: ${changesPrefix})`, async t => {
    const f = prepared(t, 'continue', { agents: true, autoContinue: true, continueTarget: 100 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    let agentCalls = 0;
    const acceptedText = 'Agent revised baseline and prefix.';
    const generateAgent = async () => { agentCalls++; return { text: acceptedText }; };
    await f.candidate(changesPrefix ? 'First prefix.' : acceptedText, calls, { generateAgent });
    assert.equal(readArtifact(f.dirs, f.childJob().id, 'roleplay-candidate').output.continuedText, acceptedText);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    await f.candidate('Unfinished suffix', calls, { turn: 1, generateAgent,
        response: { choices: [{ message: { content: 'Unfinished suffix' }, finish_reason: 'content_filter' }] } });
    const first = await runRoleplayWorkflowJob(f.context());
    assert.equal(f.records().at(-1).mes, acceptedText + 'Unfinished suffix');
    assert.equal(f.records().at(-1).extra.generation_outcome.status, 'blocked');
    assert.equal(calls.count, 2);
    assert.equal(agentCalls, 1);
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), first);
    const child = f.childJob(1);
    const proof = readArtifact(f.dirs, child.id, 'roleplay-blocked-continuation');
    const original = readArtifact(f.dirs, child.id, 'roleplay-candidate').output;
    const combined = { ...original, text: proof.previousOutput.text + original.text,
        continuedText: acceptedText + original.text, blockedContinuationProof: proof.hash };
    assert.doesNotThrow(() => verifyBlockedOutputProof(f.dirs, child, combined, f.f.records));
    assert.throws(() => verifyBlockedOutputProof(f.dirs, child, { ...combined, continuedText: 'Fabricated replacement' }, f.f.records),
        { code: 'ROLEPLAY_BLOCKED_RECOVERY' });
    const missing = { ...combined };
    delete missing.continuedText;
    assert.throws(() => verifyBlockedOutputProof(f.dirs, child, missing, f.f.records), { code: 'ROLEPLAY_BLOCKED_RECOVERY' });
    assert.throws(() => verifyBlockedOutputProof(f.dirs, child, { ...combined, continuedText: 'x'.repeat(256 * 1024 + 1) }, f.f.records),
        { code: 'ROLEPLAY_BLOCKED_RECOVERY' });
    assert.throws(() => verifyBlockedOutputProof(f.dirs, child, { ...combined, text: combined.text + 'changed' }, f.f.records),
        { code: 'ROLEPLAY_BLOCKED_RECOVERY' });
    const changedBaseline = structuredClone(f.f.records);
    changedBaseline[child.intent.source.message.index + 1].mes = 'Changed baseline';
    assert.throws(() => verifyBlockedOutputProof(f.dirs, child, combined, changedBaseline), { code: 'ROLEPLAY_BLOCKED_RECOVERY' });
    assert.throws(() => saveBlockedContinuationProof(f.dirs, child, combined, { ...proof.previousOutput, continuedText: 'Fabricated prefix' }),
        { code: 'ROLEPLAY_BLOCKED_RECOVERY' });
});

test('a continued message needing two automatic chunks gives the Agent the whole text and saves its rewrite', async t => {
    const f = prepared(t, 'continue', { agents: true, autoContinue: true, continueTarget: 20 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    const inputs = [];
    const firstRewrite = 'ANSWER SMILED.';
    const secondChunk = ' Then she waved at the whole crowd for a long while, grinning widely at everyone there.';
    const secondRewrite = 'She smiled warmly, then waved to everyone in the crowd for a long while, delighted to see so many familiar faces.';
    const generateAgent = async ({ messages }) => {
        inputs.push(messages.at(-1).content.match(/<assistant_response>\n([\s\S]*)\n<\/assistant_response>/)[1]);
        return { text: inputs.length === 1 ? firstRewrite : secondRewrite };
    };
    await f.candidate(' smiled.', calls, { generateAgent });
    const waiting = await runRoleplayWorkflowJob(f.context());
    assert.equal(waiting.waiting, true);
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), waiting);
    await f.candidate(secondChunk, calls, { turn: 1, generateAgent });
    assert.deepEqual(inputs, ['Answer smiled.', firstRewrite + secondChunk]);
    const done = await runRoleplayWorkflowJob(f.context());
    assert.equal(done.result.status, 'completed');
    const records = f.records();
    assert.equal(records.length, 3);
    const saved = records.at(-1);
    assert.equal(saved.mes, secondRewrite);
    assert.deepEqual(saved.swipes, [saved.mes, 'Other']);
    assert.equal(saved.swipe_id, 0);
    assert.deepEqual(saved.extra.inChatAgentTransformHistory.map(({ beforeText, afterText }) => ({ beforeText, afterText })), [
        { beforeText: 'Answer smiled.', afterText: firstRewrite },
        { beforeText: firstRewrite, afterText: firstRewrite + secondChunk },
        { beforeText: firstRewrite + secondChunk, afterText: secondRewrite },
    ]);
    assert.deepEqual(saved.extra.inChatAgentTransformRedo, []);
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), done);
    assert.deepEqual(f.records(), records);
    assert.equal(calls.count, 2);
    assert.equal(inputs.length, 2);
});

test('a continued message keeps the earlier Agent rewrite when the Agent is stopped on a later chunk', async t => {
    const f = prepared(t, 'continue', { agents: true, autoContinue: true, continueTarget: 20 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    const firstRewrite = 'ANSWER SMILED.';
    await f.candidate(' smiled.', calls, { generateAgent: async () => ({ text: firstRewrite }) });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const secondChunk = ' Then she waved.';
    await f.candidate(secondChunk, calls, { turn: 1, generateAgent: async ({ messages, signal }) => {
        const input = messages.at(-1).content.match(/<assistant_response>\n([\s\S]*)\n<\/assistant_response>/)[1];
        assert.equal(input, firstRewrite + secondChunk);
        assert.equal(requestRoleplayAgentStop(f.context()), true);
        signal.throwIfAborted();
    } });
    const done = await runRoleplayWorkflowJob(f.context());
    assert.equal(done.result.status, 'completed');
    assert.equal(done.result.agentsFailed, undefined);
    const records = f.records();
    assert.equal(records.length, 3);
    assert.equal(records.at(-1).mes, firstRewrite + secondChunk);
    assert.deepEqual(records.at(-1).swipes, [firstRewrite + secondChunk, 'Other']);
    assert.equal(records.at(-1).extra.inChatAgentTransformHistory.at(-1).afterText, records.at(-1).mes);
    assert.equal(getJob(f.dirs, f.jobId).children.length, 2);
    assert.equal(calls.count, 2);
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), done);
    assert.deepEqual(f.records(), records);
});

test('replaying two whole-message Agent rewrites keeps the saved decision before a third continued chunk', async t => {
    const f = prepared(t, 'continue', { agents: true, autoContinue: true, continueTarget: 20 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    const inputs = [];
    const rewrites = ['ANSWER SMILED.', 'She greeted everyone.',
        'She greeted everyone warmly and stayed to talk for a long while, delighted to see so many familiar faces gathered together.'];
    const generateAgent = async ({ messages }) => {
        inputs.push(messages.at(-1).content.match(/<assistant_response>\n([\s\S]*)\n<\/assistant_response>/)[1]);
        return { text: rewrites[inputs.length - 1] };
    };
    await f.candidate(' smiled.', calls, { generateAgent });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    await f.candidate(' Then she waved.', calls, { turn: 1, generateAgent });
    const waiting = await runRoleplayWorkflowJob(f.context());
    assert.equal(waiting.waiting, true);
    const decision = readArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:1');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), waiting);
    assert.deepEqual(readArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:1'), decision);
    const thirdChunk = ' Then she stayed to talk for a long while, delighted to see so many familiar faces gathered together.';
    await f.candidate(thirdChunk, calls, { turn: 2, generateAgent });
    assert.deepEqual(inputs, ['Answer smiled.', rewrites[0] + ' Then she waved.', rewrites[1] + thirdChunk]);
    const done = await runRoleplayWorkflowJob(f.context());
    assert.equal(done.result.status, 'completed');
    assert.equal(f.records().length, 3);
    assert.equal(f.records().at(-1).mes, rewrites[2]);
    assert.equal(f.records().at(-1).extra.inChatAgentTransformHistory.at(-1).afterText, rewrites[2]);
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), done);
    assert.equal(calls.count, 3);
});

test('an automatic continuation preserves and aligns Agent transform history with the combined reply text', async t => {
    const f = prepared(t, 'append', { agents: true, autoContinue: true, continueTarget: 20 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    let agentTurn = 0;
    const secondRewritten = 'Polished ending that completes the reply with enough detail to reach the continuation target length easily.';
    const generateAgent = async () => {
        agentTurn++;
        return { text: agentTurn === 1 ? 'Polished start.' : secondRewritten };
    };
    await f.candidate('Raw start.', calls, { generateAgent });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    await f.candidate(' Raw ending.', calls, { turn: 1, generateAgent });
    const done = await runRoleplayWorkflowJob(f.context());
    assert.equal(done.result.status, 'completed');
    const saved = f.records().at(-1);
    assert.equal(saved.mes, `Polished start. ${secondRewritten}`);
    const history = saved.extra.inChatAgentTransformHistory;
    assert.ok(Array.isArray(history) && history.length >= 2);
    assert.equal(history[0].beforeText, 'Raw start.');
    assert.equal(history[0].afterText, 'Polished start.');
    assert.equal(history.at(-1).afterText, saved.mes);
});

test('a reply needing three automatic chunks is saved when an Agent rewrites each chunk', async t => {
    const f = prepared(t, 'append', { agents: true, autoContinue: true, continueTarget: 20 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    let agentTurn = 0;
    const outs = ['Polished start.', ' Polished middle.', ' Polished ending that completes the reply with enough detail to reach the continuation target length easily, surely.'];
    const generateAgent = async () => ({ text: outs[agentTurn++] });
    await f.candidate('Raw start.', calls, { generateAgent });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    await f.candidate(' Raw middle.', calls, { turn: 1, generateAgent });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    await f.candidate(' Raw ending.', calls, { turn: 2, generateAgent });
    assert.equal((await runRoleplayWorkflowJob(f.context())).result.status, 'completed');
    assert.equal(f.records().at(-1).mes, outs.join(''));
});

test('replaying a continued reply whose Agent changed only the first chunk reaches the same decision', async t => {
    const f = prepared(t, 'append', { agents: true, autoContinue: true, continueTarget: 20 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    let agentCalls = 0;
    const generateAgent = async ({ messages }) => {
        const unchanged = messages.at(-1).content.match(/<assistant_response>\n([\s\S]*)\n<\/assistant_response>/);
        return { text: agentCalls++ === 0 ? 'Polished start.' : unchanged[1] };
    };
    await f.candidate('Raw start.', calls, { generateAgent });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    await f.candidate(' Middle.', calls, { turn: 1, generateAgent });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
});

for (const effect of ['append', 'continue']) {
    test(`a continued reply that then trips the automatic filter asks for an alternative (${effect})`, async t => {
        const f = prepared(t, effect, { autoSwipe: true, autoContinue: true, continueTarget: 200 });
        updateJob(f.dirs, f.jobId, { state: 'running' });
        await runRoleplayWorkflowJob(f.context());
        const calls = { count: 0 };
        await f.candidate(' A perfectly fine opening sentence here.', calls);
        assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
        assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:0').decision.kind, 'continue');
        await f.candidate(' Then the forbidden thing and another forbidden thing happened.', calls, { turn: 1 });
        assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
        assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:1').decision.kind, 'swipe');
        assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    });
}

for (const [name, policy, first] of [
    ['continue', { autoContinue: true, continueTarget: 200 }, 'The first completed sentence. '],
    ['swipe', { autoSwipe: true }, 'Short'],
]) {
    test(`a Stop accepted while the automatic ${name} decision is made keeps the reply and asks for nothing more`, async t => {
        const f = prepared(t, 'append', policy);
        updateJob(f.dirs, f.jobId, { state: 'running' });
        await runRoleplayWorkflowJob(f.context());
        const calls = { count: 0 };
        await f.candidate(first, calls);
        const { decideRoleplayWorkflowCandidate } = await import('../src/generation/roleplay-workflow-policy.js');
        let stopAccepted;
        const done = await runRoleplayWorkflowJob(f.context(), { decideCandidate: async (...args) => {
            stopAccepted = requestRoleplayAgentStop(f.context());
            return decideRoleplayWorkflowCandidate(...args);
        } });
        assert.equal(stopAccepted, true);
        assert.notEqual(done.waiting, true);
        assert.equal(getJob(f.dirs, f.jobId).children.length, 1);
        assert.equal(calls.count, 1);
        assert.equal(f.records().at(-1).mes, first);
    });
}
