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

test('Agents sharing a connection read it once per capture and still reject later settings changes', t => {
    const f = prepared(t, Array.from({ length: 12 }, (_, index) => ({ id: `companion-${index}`, enabled: true,
        category: 'companion', prompt: 'Write a note' })), { connectionProfile: 'main' });
    const filename = path.join(f.directories.root, 'settings.json');
    const original = fs.readFileSync;
    let reads = 0;
    t.mock.method(fs, 'readFileSync', function (file, ...args) {
        if (file === filename) reads++;
        return original.call(this, file, ...args);
    });
    const policy = f.locked(lease => captureRoleplayAgents(lease, f.settings));
    assert.equal(policy.agents.length, 12);
    assert.equal(reads, 1, 'one shared connection read rather than a settings-file read per Agent');
    assert.ok(policy.agents.every(agent => agent.binding.fingerprint === policy.agents[0].binding.fingerprint));
    f.settings.extension_settings.connectionManager.profiles[0].model = 'changed-model';
    fs.writeFileSync(filename, JSON.stringify(f.settings));
    assert.throws(() => f.locked(lease => readRoleplayAgentsLocked(lease, policy)), { code: 'ROLEPLAY_AGENT_SOURCE_CHANGED' });
});

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

for (const mode of ['parallel', 'sequential']) {
    for (const namespace of ['', 'companion:side']) {
        test(`pre-upgrade ${mode} postprocessing resumes saved ${namespace || 'main'} requests without replay`, async t => {
            const transform = (id, order, promptTransformMode) => ({ id, enabled: true, phase: 'post', prompt: id.toUpperCase(),
                injection: { order }, postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMode, promptTransformMaxTokens: 64 } });
            const f = prepared(t, [transform('rewrite', 1, 'rewrite'), transform('menu', 2, 'append'), transform('later', 3, 'rewrite')],
                { appendAgentsExecutionMode: mode });
            const options = { ...phases(f), namespace, value: 'The lantern flickers at the fork in the road.' };
            prepareRoleplayAgentContributions(f.context, options);
            const definitions = f.locked(lease => readRoleplayAgentsLocked(lease, options.snapshot.agents));
            const rewritten = 'The lantern gutters at the fork in the road.';
            const menu = '[CHOICES]\n1. Go left\n2. Go right\n[/CHOICES]';
            const legacyBody = `${rewritten}\n\n${menu}`;
            // Seed the old durable steps directly: each identity binds the exact
            // combined text that the pre-upgrade runner supplied to this agent.
            const seed = (id, text, generate) => {
                const agent = definitions.find(item => item.id === id);
                return runAgentModelStep(f.context, { base: options.base, account: f.account,
                    name: `${namespace ? namespace + ':' : ''}post:${id}`,
                    identity: roleplayHash({ intent: f.context.job.intent, agent: options.snapshot.agents.agents.find(item => item.id === id),
                        text, intercept: false, format: 'text', generationType: options.generationType }),
                    binding: agent.binding || options.binding, modelOverride: agent.binding ? agent.modelOverride : '',
                    maxTokens: 64, macros: options.macros, tokenizer: options.snapshot.tokenizer, fallbackContext: 4000,
                    assertCurrent: options.assertCurrent, generate,
                    buildMessages: () => [{ role: 'system', content: agent.prompt }, { role: 'user', content: text }] });
            };
            await seed('rewrite', options.value, modelResponse(() => ({ text: rewritten })));
            await seed('menu', rewritten, modelResponse(() => ({ text: menu })));
            await assert.rejects(seed('later', legacyBody, () => { throw new Error('Restart before dispatch'); }), /Restart before dispatch/);
            let calls = 0;
            const generate = modelResponse(({ messages }) => {
                calls++;
                assert.equal(messages[0].content, 'LATER');
                assert.equal(messages[1].content, legacyBody);
                return { text: 'Completed legacy rewrite' };
            });
            const result = await runRoleplayAgentPostprocessing(f.context, { ...options, generate });
            assert.equal(result.text, 'Completed legacy rewrite');
            assert.equal(calls, 1);
            assert.deepEqual(result.runs.map(run => run.agentId), ['rewrite', 'menu', 'later']);
            const phaseName = namespace ? `roleplay-agent-post:${namespace}` : 'roleplay-agent-post';
            assert.equal(readArtifact(f.directories, f.job.id, `${phaseName}:plan`).version, 1);
            await runRoleplayAgentPostprocessing(f.context, { ...options, generate: () => assert.fail('Saved work repeated') });
        });
    }
}

test('an interrupted new synthesis retains its plan and reuses completed parallel steps', async t => {
    const transform = (id, order, promptTransformMode) => ({ id, enabled: true, phase: 'post', prompt: id.toUpperCase(),
        injection: { order }, postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMode, promptTransformMaxTokens: 64 } });
    const f = prepared(t, [transform('rewrite', 1, 'rewrite'), transform('menu', 2, 'append'), transform('later', 3, 'rewrite')]);
    const options = { ...phases(f), value: 'The lantern flickers at the fork in the road.' };
    prepareRoleplayAgentContributions(f.context, options);
    const rewritten = 'The lantern gutters at the fork in the road.';
    const menu = '[CHOICES]\n1. Go left\n2. Go right\n[/CHOICES]';
    await assert.rejects(runRoleplayAgentPostprocessing(f.context, { ...options, generate: args => {
        if (args.messages[0].content.startsWith('LATER')) throw new Error('Restart before dispatch');
        return modelResponse(({ messages }) => {
            assert.ok(messages[1].content.includes(options.value));
            return { text: messages[0].content.startsWith('REWRITE') ? rewritten : menu };
        })(args);
    } }), /Restart before dispatch/);
    assert.equal(readArtifact(f.directories, f.job.id, 'roleplay-agent-post:plan').version, 3);
    let calls = 0;
    const result = await runRoleplayAgentPostprocessing(f.context, { ...options, generate: modelResponse(({ messages }) => {
        calls++;
        if (messages[0].content.startsWith('Combine parallel edits')) {
            const input = JSON.parse(messages[1].content);
            assert.deepEqual(input.candidates.map(item => item.text), [rewritten, 'Completed new rewrite']);
            assert.deepEqual(input.after, [menu]);
            return { text: 'Combined new rewrite' };
        }
        assert.ok(messages[0].content.startsWith('LATER'));
        assert.ok(messages[1].content.includes(options.value));
        assert.ok(!messages[1].content.includes(menu));
        return { text: 'Completed new rewrite' };
    }) });
    assert.equal(calls, 2);
    assert.equal(result.text, `Combined new rewrite\n\n${menu}`);
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

test('reply context ignores hidden and empty messages and resolves the default length target in both macro modes', async t => {
    for (const experimentalMacroEngine of [true, false]) {
        const f = prepared(t, [{ id: 'rewrite', enabled: true, phase: 'post', prompt: 'Length: {{lengthTarget}}',
            settings: { lengthTarget: '   ' }, postProcess: { enabled: false, promptTransformEnabled: true, promptTransformContextMessages: 2 } }]);
        const options = phases(f);
        options.snapshot.experimentalMacroEngine = experimentalMacroEngine;
        options.records = [f.records[0], { mes: 'Too old' }, ...f.records.slice(1), { mes: 'Hidden', is_system: true }, { mes: ' ' }];
        prepareRoleplayAgentContributions(f.context, options);
        let calls = 0;
        const result = await runRoleplayAgentPostprocessing(f.context, { ...options, value: 'Current reply', generate: modelResponse(({ messages }) => {
            calls++;
            assert.match(messages[0].content, /Length: About 300 to 450 words/);
            assert.match(messages[1].content, /<recent_chat>\nUser: Original\n\nNova: Answer\n<\/recent_chat>/);
            assert.doesNotMatch(messages[1].content, /Too old|Hidden/);
            return { text: 'Rewritten' };
        }) });
        assert.equal(calls, 1);
        assert.equal(result.text, 'Rewritten');
    }
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
    assert.equal(first.companion.chatHistoryPlacement, 'latest');
    assert.equal(nativeAgentDefinition({ ...raw, companion: { chatHistoryPlacement: 'block' } }).companion.chatHistoryPlacement, 'block');
    assert.equal(nativeAgentDefinition({ ...raw, companion: { chatHistoryPlacement: 'elsewhere' } }).companion.chatHistoryPlacement, 'latest');
    assert.deepEqual(first.companion.dependencies, ['A', 'B']);
    assert.equal(first.regexScripts[0].id, 'stable-agent:regex:0');
    assert.equal(nativeAgentDefinition({ id: 'legacy', postProcess: { enabled: true, type: 'regex', regexFind: 'one', regexReplace: 'two' } }).regexScripts[0].findRegex, '/one/g');
    for (const [value, expected] of [[undefined, 0], [-1, 0], ['bad', 0], [2.9, 2], [200, 20]]) {
        assert.equal(nativeAgentDefinition({ id: 'rewrite', postProcess: { promptTransformContextMessages: value } }).postProcess.promptTransformContextMessages, expected);
    }
});

test('Agent capture binds saved scope, individual profiles and exact record identities without private settings', t => {
    const f = prepared(t, [
        { id: 'pre', enabled: false, prompt: 'Use this scan text', injection: { order: 2, scan: true } },
        { id: 'post', enabled: true, phase: 'post', prompt: 'Rewrite', connectionProfile: 'aux',
            postProcess: { enabled: false, promptTransformEnabled: true }, settings: { private: 'do-not-persist-this' } },
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

test('Agent capture binds up to ten fallback connections per Agent kind and skips missing or repeated ones', t => {
    const f = prepared(t, [
        { id: 'post', enabled: true, phase: 'post', prompt: 'Rewrite', postProcess: { enabled: true, promptTransformEnabled: true } },
        { id: 'companion', enabled: true, category: 'companion', prompt: 'A note' },
    ], { connectionProfile: 'main', connectionFallbacks: ['main', 'missing', 'aux', 'aux'], companionConnectionFallbacks: ['aux'] });
    const policy = f.locked(lease => captureRoleplayAgents(lease, f.settings));
    const byId = Object.fromEntries(policy.agents.map(agent => [agent.id, agent]));
    assert.deepEqual(byId.post.fallbacks.map(binding => binding.profileId), ['aux']);
    assert.deepEqual(byId.companion.fallbacks.map(binding => binding.profileId), ['aux']);
    const definitions = f.locked(lease => readRoleplayAgentsLocked(lease, policy));
    assert.deepEqual(definitions.find(agent => agent.id === 'post').fallbacks.map(item => item.profileLabel), ['aux']);
    const none = prepared(t, [{ id: 'plain', enabled: true, category: 'companion', prompt: 'A note' }], { connectionProfile: 'main' });
    const plain = none.locked(lease => captureRoleplayAgents(lease, none.settings));
    assert.equal(Object.hasOwn(plain.agents[0], 'fallbacks'), false, 'no fallbacks leaves saved policies unchanged');
});

test('a failed Agent connection hands over to the next fallback once and is never sent again', async t => {
    const f = prepared(t);
    const context = { ...f.context, providerScope: createProviderScope(f.context) };
    const aux = { kind: 'profile', ...captureChatProfile(f.directories, 'aux') };
    const calls = [];
    const options = { base: f.scope, account: f.account, name: 'note', identity: roleplayHash('note'), binding: f.binding,
        modelOverride: 'own-model', maxTokens: 64, macros: {}, assertCurrent() {},
        fallbacks: [{ binding: f.binding, profileLabel: 'Same as primary' }, { binding: aux, profileLabel: 'Backup' }],
        buildMessages: () => [{ role: 'user', content: 'Write a note' }],
        generate: async ({ jobContext, binding, modelOverride, stepNamespace, onProviderStep, beforeDispatch }) => {
            const name = createHash('sha256').update(stepNamespace).digest('hex');
            onProviderStep(`provider:${name}`);
            return providerStep(jobContext, name, () => {
                calls.push([binding.profileId, modelOverride]);
                beforeDispatch();
                if (binding.profileId === 'main') throw Object.assign(new Error('Provider overloaded'), { status: 502 });
                return { text: 'Backup note' };
            });
        } };
    const result = await runAgentModelStep(context, options);
    assert.equal(result.text, 'Backup note');
    assert.equal(result.profileId, 'aux');
    assert.equal(result.fallbackLabel, 'Backup');
    assert.deepEqual(calls, [['main', 'own-model'], ['aux', '']], 'fallbacks skip the primary and never reuse its model override');
    const replay = await runAgentModelStep({ ...context, providerScope: createProviderScope(context) },
        { ...options, generate: () => assert.fail('A settled Agent was sent again') });
    assert.equal(replay.text, 'Backup note');
    assert.equal(calls.length, 2);
});

test('an empty Agent reply tries the fallback, and every connection failing keeps the last error', async t => {
    const f = prepared(t);
    const aux = { kind: 'profile', ...captureChatProfile(f.directories, 'aux') };
    const base = { base: f.scope, account: f.account, identity: roleplayHash('empty'), binding: f.binding, maxTokens: 64, macros: {},
        assertCurrent() {}, fallbacks: [{ binding: aux, profileLabel: 'Backup' }], buildMessages: () => [{ role: 'user', content: 'Write' }] };
    const empty = await runAgentModelStep(f.context, { ...base, name: 'empty', generate: modelResponse(({ binding }) => ({ text: binding.profileId === 'main' ? '  ' : 'Filled' })) });
    assert.equal(empty.text, 'Filled');
    await assert.rejects(runAgentModelStep({ ...f.context, providerScope: createProviderScope(f.context) }, { ...base, name: 'broken',
        generate: modelResponse(({ binding }) => { throw Object.assign(new Error(`${binding.profileId} refused`), { status: 400 }); }) }), /aux refused/);
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
