import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { write: writeCard } = await import('../src/character-card-parser.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { runAssistantToolJob } = await import('../src/generation/assistant-tool-jobs.js');
const { runPathfinderNotebookJob } = await import('../src/generation/pathfinder-notebook-jobs.js');
const { runPathfinderToolJob } = await import('../src/generation/pathfinder-tool-jobs.js');
const { captureRoleplayWorkflowRequest, admitRoleplayWorkflowJob, runRoleplayWorkflowJob,
    recoverWaitingRoleplayWorkflow } = await import('../src/generation/roleplay-workflow.js');
const { getJob, releaseJob, setJobState, updateJob, requestCancellation } = await import('../src/jobs/store.js');
const { providerStep, readArtifact } = await import('../src/jobs/artifacts.js');
const { readNativeMediaJobResult } = await import('../src/generation/media-jobs.js');
const { roleplayHash } = await import('../src/roleplay-store.js');

const controls = { prompts: [{ identifier: 'main', role: 'system', content: '', system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true }],
prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
function_calling: true };

function prepared(t, effect = 'append', { assistant = false, pathfinder = false, autoSwipe = false, autoContinue = false, continueTarget = 30 } = {}) {
    const f = fixture(t);
    const dirs = f.scope.directories;
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    if (assistant) fs.writeFileSync(path.join(dirs.characters, 'Nova.png'), writeCard(png, JSON.stringify({
        name: 'Nova', description: 'Assistant', data: { name: 'Nova', description: 'Assistant',
            extensions: { neconyan_assistant: { id: 'miso-male' } } },
    })));
    if (pathfinder) {
        dirs.worlds = path.join(dirs.root, 'worlds');
        dirs.inChatAgents = path.join(dirs.root, 'InChatAgents');
        fs.mkdirSync(dirs.worlds);
        fs.mkdirSync(dirs.inChatAgents);
        fs.writeFileSync(path.join(dirs.worlds, 'Manual.json'), JSON.stringify({ entries: {
            12: { uid: 12, key: ['telescope'], comment: 'Observatory', content: 'A broken telescope.' },
        } }));
        fs.writeFileSync(path.join(dirs.inChatAgents, 'pathfinder.json'), JSON.stringify({ id: 'pathfinder',
            name: 'Pathfinder', category: 'tool', enabled: true, sourceTemplateId: 'tpl-pathfinder',
            settings: { sidecarEnabled: true, pipelineEnabled: false, enabledLorebooks: ['Manual'], includeContextualLorebooks: false } }));
    }
    dirs.openAI_Settings = path.join(dirs.root, 'openai-presets');
    fs.mkdirSync(dirs.openAI_Settings);
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Main.json'), JSON.stringify({ openai_max_context: 4096 }));
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: [] } },
        ...(autoSwipe || autoContinue ? { power_user: { ...(autoSwipe ? { auto_swipe: true,
            auto_swipe_minimum_length: 15, auto_swipe_blacklist: ['forbidden'], auto_swipe_blacklist_threshold: 2 } : {}),
        ...(autoContinue ? { auto_continue: { enabled: true, allow_chat_completions: true, target_length: continueTarget } } : {}) } } : {}),
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1', function_calling: true },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture', preset: 'Main',
            'api-url': 'http://127.0.0.1:18000/v1' }] },
        ...(pathfinder ? { inChatAgents: { globalSettings: { enabled: true, pathfinderEnabled: true } } } : {}) },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = effect === 'append' ? f.source() : captureRoleplaySource(f.scope, { locator: f.locator, message: 1 });
    const request = captureRoleplayWorkflowRequest(f.scope, account, source, { avatar: 'Nova.png',
        binding: { kind: 'profile', ...captureChatProfile(dirs, 'main') }, maxTokens: 32, effect });
    const { jobId } = admitRoleplayWorkflowJob(f.scope, account, { operationKey: `root-${effect}`, source, request });
    releaseJob(dirs, jobId);
    const context = () => ({ owner: f.scope.owner, directories: dirs, job: getJob(dirs, jobId), signal: new AbortController().signal });
    return { f, dirs, account, source, request, jobId, context,
        async candidate(text, calls, { turn = 0, response = undefined } = {}) {
            const pointer = readArtifact(dirs, jobId, turn ? `roleplay-workflow-child:${turn}` : 'roleplay-workflow-child');
            const child = getJob(dirs, pointer.jobId);
            setJobState(dirs, child.id, 'running');
            const result = await runRoleplayReplyJob({ owner: f.scope.owner, directories: dirs, job: getJob(dirs, child.id),
                signal: new AbortController().signal }, { contextLimit: () => 4096,
                promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }),
                ...(pathfinder ? { generatePathfinder: async options => {
                    const step = roleplayHash(['workflow-sidecar', child.id]);
                    options.onProviderStep(`provider:${step}`);
                    return providerStep(options.jobContext, step, async () => { options.beforeDispatch(); return { text: '' }; });
                } } : {}),
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

for (const uncertain of [false, true]) {
    test(`a stopped workflow reports its child failure without repeating it (uncertain: ${uncertain})`, async t => {
        const f = prepared(t);
        updateJob(f.dirs, f.jobId, { state: 'running' });
        const { childJobId } = await runRoleplayWorkflowJob(f.context());
        const reason = uncertain ? 'The connection to your model provider closed before a complete reply was received.'
            : 'The Roleplay source changed after this work was prepared.';
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

test('an owned lorebook tool changes only its bound book before the next model turn', async t => {
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

test('multiple tool calls in one model reply advance only their owned book changes in order', async t => {
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

test('cancellation after the final candidate and before its protected publication keeps the old reply', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { count: 0 };
    await f.candidate('A complete but unpublished reply.', calls);
    await assert.rejects(runRoleplayWorkflowJob(f.context(), { beforeCommit: () => {
        requestCancellation(f.dirs, f.jobId);
    } }), { code: 'ROLEPLAY_WORKFLOW_RECOVERY' });
    assert.equal(f.records().length, 3);
    assert.equal(f.records()[2].mes, 'Answer');
    assert.equal(getJob(f.dirs, f.jobId).cancellation.requested, true);
    assert.equal(calls.count, 1);
    await assert.rejects(runRoleplayWorkflowJob(f.context(), { beforeCommit: () => {
        throw new Error('A cancelled workflow was replayed');
    } }), { code: 'ROLEPLAY_WORKFLOW_RECOVERY' });
    assert.equal(f.records().length, 3);
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
