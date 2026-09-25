import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { nativeAgentDefinition } = await import('../src/generation/agent-definition.js');
const { captureRoleplayAgents, readRoleplayAgentsLocked } = await import('../src/generation/roleplay-agents-source.js');
const { runAgentModelStep } = await import('../src/generation/agent-model-step.js');
const { runChatProfile } = await import('../src/generation/service.js');
const { prepareRoleplayAgentContributions, runRoleplayAgentInterceptors, runRoleplayAgentPostprocessing } = await import('../src/generation/roleplay-agent-processing.js');
const { decideJobApproval } = await import('../src/generation/job-approvals.js');
const { cacheAgentRegexScripts, resolveRegexScriptsForSnapshot } = await import('../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js');
const { writeAgentRecordLocked } = await import('../src/in-chat-agent-storage.js');
const { roleplayAccountStamp, roleplayHash, withRoleplayAccount } = await import('../src/roleplay-store.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { createProviderScope, providerStep, readArtifact } = await import('../src/jobs/artifacts.js');
const { acceptJob, getJob, recoverJobs, updateJob } = await import('../src/jobs/store.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
after(() => cancelAutoSaves());

function prepared(t, agents = [], global = {}) {
    const f = fixture(t);
    const directories = f.scope.directories;
    const account = roleplayAccountStamp(f.scope);
    const locked = operation => withRoleplayAccount(f.scope, account, operation);
    const settings = { oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1' },
        extension_settings: { connectionManager: { profiles: ['main', 'aux'].map(id => ({ id, api: 'custom', model: `${id}-fixture`,
            'api-url': 'http://127.0.0.1:18000/v1' })) }, inChatAgents: { globalSettings: { enabled: true, ...global } } } };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
    for (const agent of agents) locked(lease => writeAgentRecordLocked(lease, 'agent', agent));
    const binding = { kind: 'profile', ...captureChatProfile(directories, 'main') };
    const { job } = acceptJob(directories, { owner: f.scope.owner, type: 'agent-fixture', submissionKey: 'agents', intent: { binding } });
    updateJob(directories, job.id, { state: 'running' });
    const context = { directories, job, owner: f.scope.owner, signal: new AbortController().signal };
    return { ...f, directories, account, locked, settings, binding, job, context };
}

function phases(f) {
    const snapshot = { account: f.account, maxContext: 4000, tokenizer: 'o200k_base', experimentalMacroEngine: true,
        speakerNames: { character: 'Nova', user: 'Ari' }, agents: f.locked(lease => captureRoleplayAgents(lease, f.settings)) };
    return { base: f.scope, snapshot, records: f.records, binding: f.binding, generationType: 'normal', assistantName: 'Nova',
        macros: { names: { char: 'Nova', user: 'Ari' }, variables: { local: { count: '7' }, global: {} } },
        assertCurrent: () => f.locked(lease => readRoleplayAgentsLocked(lease, snapshot.agents)) };
}

function modelResponse(handler) {
    return async args => {
        const name = createHash('sha256').update(JSON.stringify([args.stepNamespace, args.messages])).digest('hex');
        args.onProviderStep(`provider:${name}`);
        return providerStep(args.jobContext, name, async () => { args.beforeDispatch(); return handler(args); });
    };
}

test('Agent activation and scoped pre-prompts freeze probability, keywords and macros before any model call', t => {
    const f = prepared(t, [
        { id: 'scan', enabled: true, prompt: '{{agentName}} for {{char}} {{getvar::count}}', name: 'Scanner', injection: { order: 1, scan: true }, conditions: { triggerProbability: 50, triggerKeywords: ['Answer'] } },
        { id: 'not-last', enabled: true, prompt: 'Wrong source', injection: { order: 2 }, conditions: { triggerKeywords: ['Original'] } },
        { id: 'companion', enabled: true, category: 'companion', prompt: 'A note', conditions: { triggerKeywords: ['/original/i'] } },
    ]);
    const options = phases(f);
    let draws = 0;
    const pre = prepareRoleplayAgentContributions(f.context, { ...options, random: () => { draws++; return 0.25; } });
    assert.deepEqual(pre.activeIds, ['scan', 'companion']);
    assert.equal(pre.extensions[0].content, 'Scanner for Nova 7');
    assert.equal(pre.extensions[0].scan, true);
    assert.equal(pre.extensions[0].role, 'system');
    assert.equal(draws, 1);
    assert.deepEqual(prepareRoleplayAgentContributions(f.context, { ...options, random: () => assert.fail('Activation rerolled') }), pre);
});

test('saved Agent execution order retains large and fractional values rather than merging distinct priorities', t => {
    const f = prepared(t, [
        { id: 'later-name-first', enabled: true, prompt: 'First', injection: { order: 100001.25 } },
        { id: 'earlier-name-second', enabled: true, prompt: 'Second', injection: { order: 100001.75 } },
    ]);
    const options = phases(f);
    assert.deepEqual(options.snapshot.agents.agents.map(agent => agent.id), ['later-name-first', 'earlier-name-second']);
    assert.deepEqual(f.locked(lease => readRoleplayAgentsLocked(lease, options.snapshot.agents))
        .map(agent => agent.injection.order), [100001.25, 100001.75]);
    const pre = prepareRoleplayAgentContributions(f.context, options);
    assert.deepEqual(pre.extensions.map(extension => extension.key),
        ['inchat_agent_later-name-first', 'inchat_agent_earlier-name-second']);
});

test('identical parallel Agent requests retain distinct provider receipts and never expose their step identity to the provider', async t => {
    const f = prepared(t);
    const context = { ...f.context, providerScope: createProviderScope(f.context) };
    let requests = 0;
    const generate = args => runChatProfile({ ...args, fetch: async (_url, init) => {
        requests++;
        assert.equal(Object.hasOwn(JSON.parse(init.body), 'stepNamespace'), false);
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `Answer ${requests}` }, finish_reason: 'stop' }] }),
            { headers: { 'Content-Type': 'application/json' } });
    } });
    const run = name => runAgentModelStep(context, { base: f.scope, account: f.account, binding: f.binding, name,
        identity: roleplayHash(name), maxTokens: 64, macros: {}, assertCurrent() {}, generate,
        buildMessages: () => [{ role: 'user', content: 'Identical instructions' }] });
    const results = await Promise.all(['first', 'second'].map(run));
    assert.equal(requests, 2);
    assert.notEqual(results[0].text, results[1].text);
    assert.notEqual(readArtifact(f.directories, f.job.id, 'agent-model:first:provider').step,
        readArtifact(f.directories, f.job.id, 'agent-model:second:provider').step);
    await Promise.all(['first', 'second'].map(run));
    assert.equal(requests, 2);
});

test('parallel append passes share one baseline, retain tracker state and freeze rendered regex scripts', async t => {
    const transform = { enabled: true, promptTransformEnabled: true, promptTransformMode: 'append' };
    const f = prepared(t, [
        { id: 'a', enabled: true, name: 'A', phase: 'post', prompt: 'Append A', injection: { order: 1 }, postProcess: transform },
        { id: 'b', enabled: true, name: 'B', phase: 'post', prompt: 'Append B', injection: { order: 2 }, postProcess: transform },
        { id: 'utility', enabled: true, phase: 'post', injection: { order: 3 }, postProcess: { enabled: true, type: 'append', appendText: '!' },
            regexScripts: [{ id: 'raw', findRegex: 'Body', replaceString: 'Revised', placement: [2], markdownOnly: false, promptOnly: false },
                { id: 'display', findRegex: 'Revised', replaceString: 'Shown', placement: [2], markdownOnly: true }] },
        { id: 'tracker', enabled: true, postProcess: { enabled: true, type: 'extract', extractPattern: '\\[STATE\\]([\\s\\S]*?)\\[/STATE\\]', extractVariable: 'state' } },
    ]);
    const options = phases(f);
    prepareRoleplayAgentContributions(f.context, options);
    let calls = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const result = await runRoleplayAgentPostprocessing(f.context, { ...options, value: 'Body\n[STATE]x[/STATE]', generate: modelResponse(async ({ messages }) => {
        assert.match(messages[1].content, /Body\n\[STATE\]x\[\/STATE\]/);
        if (++calls === 2) release();
        await barrier;
        return { text: messages[0].content.startsWith('Append A') ? 'A' : 'B' };
    }) });
    assert.equal(calls, 2);
    assert.equal(result.text, 'Revised\n[STATE]x[/STATE]\n\nA\n\nB!');
    assert.equal(result.metadata.agent_state, '[STATE]x[/STATE]');
    assert.equal(result.metadata.variables.agent_state, '[STATE]x[/STATE]');
    assert.equal(result.extra.inChatAgentTransformHistory.length, 1);
    cacheAgentRegexScripts('utility', [{ id: 'display', findRegex: 'Revised', replaceString: 'Changed later' }]);
    assert.equal(resolveRegexScriptsForSnapshot(result.extra.inChatAgents).find(script => script.id === 'display').replaceString, 'Shown');
    assert.equal((await runRoleplayAgentPostprocessing(f.context, { ...options, value: 'Body\n[STATE]x[/STATE]', generate: () => assert.fail('Paid post-pass repeated') })).hash, result.hash);
});

test('post-main interception waits for an exact saved review and does not repeat an accepted decision', async t => {
    const f = prepared(t, [{ id: 'review', enabled: true, prompt: 'Rework', preProcess: { mode: 'intercept', interceptTiming: 'post-main-generation', applyMode: 'replace' } }]);
    const options = phases(f);
    prepareRoleplayAgentContributions(f.context, options);
    const call = { ...options, timing: 'post-main-generation', value: 'Original output', format: 'text' };
    const waiting = await runRoleplayAgentInterceptors(f.context, { ...call, generate: () => assert.fail('Review must happen first') });
    assert.equal(waiting.waiting, true);
    assert.equal(getJob(f.directories, f.job.id).state, 'waiting');
    decideJobApproval(f.context, { id: waiting.approval.id, proposalHash: waiting.approval.proposalHash, decision: 'continue' });
    let calls = 0;
    const result = await runRoleplayAgentInterceptors(f.context, { ...call, generate: modelResponse(() => { calls++; return { text: '<assistant_response>Reworked</assistant_response>' }; }) });
    assert.equal(result.value, 'Reworked');
    assert.equal((await runRoleplayAgentInterceptors(f.context, { ...call, generate: () => assert.fail('Reviewed step repeated') })).hash, result.hash);
    assert.equal(calls, 1);
});

test('a chat interceptor cannot inject unbound media or an incomplete tool exchange', async t => {
    for (const content of [[{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://unbound.example/picture.png' } }] }],
        [{ role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'tool', arguments: '{}' } }] }]]) {
        const f = prepared(t, [{ id: 'replace', enabled: true, prompt: 'Replace context', preProcess: { mode: 'intercept', applyMode: 'replace' } }]);
        const options = phases(f);
        prepareRoleplayAgentContributions(f.context, options);
        await assert.rejects(runRoleplayAgentInterceptors(f.context, { ...options, value: [{ role: 'user', content: 'Original' }], format: 'chat',
            generate: modelResponse(() => ({ text: JSON.stringify(content) })) }));
    }
});

test('native Agent defaults retain explicit regex identities and unbounded saved history choices', () => {
    const raw = { id: 'stable-agent', name: 'Stable', category: 'companion', companion: { contextMessages: 5000, chatHistoryDepth: 4000,
        dependencies: 'A, B\nA', feedback: { enabled: true, depth: 4 } }, regexScripts: [{ findRegex: '/one/g', replaceString: 'two' }] };
    const first = nativeAgentDefinition(raw);
    assert.deepEqual(first, nativeAgentDefinition(raw));
    assert.equal(first.execution, 'companion');
    assert.equal(first.companion.contextMessages, 5000);
    assert.equal(first.companion.chatHistoryDepth, 4000);
    assert.deepEqual(first.companion.dependencies, ['A', 'B']);
    assert.equal(first.regexScripts[0].id, 'stable-agent:regex:0');
    assert.equal(nativeAgentDefinition({ id: 'legacy', postProcess: { enabled: true, type: 'regex', regexFind: 'one', regexReplace: 'two' } }).regexScripts[0].findRegex, '/one/g');
});

test('Agent capture binds saved scope, individual profiles and exact record identities without private settings', t => {
    const f = prepared(t, [
        { id: 'pre', enabled: false, prompt: 'Use this scan text', injection: { order: 2, scan: true } },
        { id: 'post', enabled: true, phase: 'post', prompt: 'Rewrite', connectionProfile: 'aux',
            postProcess: { enabled: true, promptTransformEnabled: true }, settings: { private: 'do-not-persist-this' } },
    ], { separateRecentChats: true, scopedEnabledAgentIdsInitialized: true, enabledAgentIdsByChatType: { individual: ['pre', 'post'], group: ['pre'] } });
    const policy = f.locked(lease => captureRoleplayAgents(lease, f.settings));
    assert.deepEqual(policy.agents.map(agent => agent.id), ['pre', 'post']);
    assert.equal(policy.agents[1].binding.profileId, 'aux');
    assert.equal(JSON.stringify(policy).includes('do-not-persist-this'), false);
    const group = f.locked(lease => captureRoleplayAgents(lease, f.settings, { group: true }));
    assert.deepEqual(group.agents.map(agent => agent.id), ['pre']);
    assert.equal(f.locked(lease => readRoleplayAgentsLocked(lease, policy))[0].injection.scan, true);
    const filename = path.join(f.directories.root, 'InChatAgents/pre.json');
    const bytes = fs.readFileSync(filename);
    fs.renameSync(filename, filename + '.old');
    fs.writeFileSync(filename, bytes);
    assert.throws(() => f.locked(lease => readRoleplayAgentsLocked(lease, policy)), { code: 'ROLEPLAY_AGENT_SOURCE_CHANGED' });
});

test('Agent model inputs, macros and limited results are saved once and never invoke a fallback', async t => {
    const f = prepared(t);
    let builds = 0, calls = 0;
    const options = { base: f.scope, account: f.account, name: 'rewrite', identity: roleplayHash({ task: 'rewrite' }), binding: f.binding,
        modelOverride: 'deliberate-model', maxTokens: 64, macros: { names: { char: 'Nova', user: 'Ari' }, variables: { local: { counter: '7' }, global: {} } },
        assertCurrent: () => {}, buildMessages: environment => { builds++; return [{ role: 'user', content: environment.evaluate('Rewrite {{char}} with {{getvar::counter}}') }]; },
        generate: async ({ jobContext, binding, modelOverride, messages, onProviderStep, beforeDispatch }) => {
            assert.equal(binding.profileId, 'main');
            assert.equal(modelOverride, 'deliberate-model');
            assert.match(messages[0].content, /Nova with 7/);
            const name = createHash('sha256').update('rewrite').digest('hex');
            onProviderStep(`provider:${name}`);
            return providerStep(jobContext, name, () => { calls++; beforeDispatch(); return { text: 'Only part of the rewrite', response: { choices: [{ finish_reason: 'length' }] } }; });
        } };
    const result = await runAgentModelStep(f.context, options);
    assert.equal(result.lengthLimited, true);
    assert.equal(readArtifact(f.directories, f.job.id, 'agent-model:rewrite:input').messages[0].content, 'Rewrite Nova with 7');
    const replay = await runAgentModelStep(f.context, { ...options, assertCurrent: () => assert.fail('A saved result needs no new model binding'),
        buildMessages: () => assert.fail('Saved inputs were expanded again'), generate: () => assert.fail('A completed Agent was called again') });
    assert.deepEqual(replay, result);
    assert.equal(builds, 1);
    assert.equal(calls, 1);
});

test('a lost Agent result remains unknown after recovery and before entering any replacement generator', async t => {
    const f = prepared(t);
    const context = { ...f.context, providerScope: createProviderScope(f.context) };
    let calls = 0;
    const options = { base: f.scope, account: f.account, name: 'lost', identity: 'accepted-lost-agent', binding: f.binding, maxTokens: 32,
        macros: { names: { char: 'Nova' } }, assertCurrent: () => {}, buildMessages: () => [{ role: 'user', content: 'An Agent task' }],
        generate: async ({ jobContext, onProviderStep }) => {
            const name = createHash('sha256').update('lost').digest('hex');
            onProviderStep(`provider:${name}`);
            return providerStep(jobContext, name, () => { calls++; throw new Error('Lost paid result'); });
        } };
    await assert.rejects(runAgentModelStep(context, options), /Lost paid result/);
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, f.job.id).state, 'interrupted');
    await assert.rejects(runAgentModelStep({ ...context, providerScope: createProviderScope(context) }, {
        ...options, generate: () => assert.fail('Unknown results cannot enter a generator'),
    }), { code: 'ROLEPLAY_AGENT_RECOVERY' });
    assert.equal(calls, 1);
});
