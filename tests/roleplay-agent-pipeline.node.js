import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { getJob, releaseJob, updateJob, recoverJobs } = await import('../src/jobs/store.js');
const { providerStep, readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { decideJobApproval } = await import('../src/generation/job-approvals.js');
const { writeSecret, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
after(cancelAutoSaves);

const controls = { prompts: [{ identifier: 'main', role: 'system', system_prompt: true, content: '' },
    { identifier: 'worldInfoBefore', marker: true, system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true }], prompt_order: [{ character_id: 100001,
    order: [{ identifier: 'main', enabled: true }, { identifier: 'worldInfoBefore', enabled: true }, { identifier: 'chatHistory', enabled: true }] }] };

function prepared(t, agents, { effect = 'append', range = { start: 1, count: 1 }, review = false, translation = false, configure = () => {}, globalSettings = {} } = {}) {
    const f = fixture(t);
    const directories = f.scope.directories;
    f.records[1].extra = {};
    configure(f.records);
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    directories.worlds = path.join(directories.root, 'worlds');
    directories.inChatAgents = path.join(directories.root, 'InChatAgents');
    fs.mkdirSync(directories.worlds);
    fs.mkdirSync(directories.inChatAgents);
    for (const agent of agents) fs.writeFileSync(path.join(directories.inChatAgents, `${agent.id}.json`), JSON.stringify({
        name: agent.id, enabled: true, category: 'custom', ...agent,
    }));
    fs.writeFileSync(path.join(directories.worlds, 'Town.json'), JSON.stringify({ entries: { 1: { uid: 1,
        key: ['secret-signal'], keysecondary: [], comment: 'Agent lore', content: 'BOUND_LORE_FROM_AGENT', position: 0 } } }));
    const settings = { world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 200 },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1' },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:18000/v1' }] },
            inChatAgents: { globalSettings: { enabled: true, appendAgentsExecutionMode: 'parallel', postMainInterceptShowMessageFirst: review, ...globalSettings } },
            ...(translation ? { translate: { provider: 'libre', auto_mode: 'responses', target_language: 'fr', internal_language: 'en' } } : {}) } };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
    if (translation) {
        writeSecret(directories, SECRET_KEYS.LIBRE, 'fixture-key');
        writeSecret(directories, SECRET_KEYS.LIBRE_URL, 'https://translate.example/translate');
    }
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = effect === 'append' ? f.source() : captureRoleplaySource(f.scope, { locator: f.locator,
        ...(effect === 'replace' ? { range } : { message: 1 }) });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 4000,
        serverPrompt: true, trigger: { append: 'normal', replace: 'regenerate', continue: 'continue', swipe: 'swipe' }[effect] });
    const request = { binding: { kind: 'profile', ...captureChatProfile(directories, 'main') }, maxTokens: 32,
        characterName: 'Nova', serverPrompt: true, worldInfo, messages: [] };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'agent-pipeline', effect, source, request });
    releaseJob(directories, jobId);
    updateJob(directories, jobId, { state: 'running' });
    const context = () => ({ directories, owner: f.scope.owner, job: getJob(directories, jobId), signal: new AbortController().signal });
    const run = options => runRoleplayReplyJob(context(), { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }), ...options });
    return { ...f, directories, account, source, request, jobId, context, run,
        saved: () => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

function paid(label, response) {
    return async args => {
        const step = roleplayHash([label, args.stepNamespace ?? '', args.messages]);
        args.onProviderStep?.(`provider:${step}`);
        return providerStep(args.jobContext, step, async () => {
            await args.beforeDispatch?.();
            const result = await response(args);
            return typeof result === 'string' ? { text: result } : result;
        });
    };
}

test('native Agent prompts, lore, complete-context interception and postprocessing commit one verified reply', async t => {
    const f = prepared(t, [
        { id: 'scan', phase: 'pre', prompt: 'secret-signal {{char}}', injection: { position: 0, depth: 0, role: 0, order: 1, scan: true } },
        { id: 'before', phase: 'pre', prompt: 'PRE_CONTEXT', injection: { order: 2 },
            preProcess: { mode: 'intercept', applyMode: 'wrap', wrapPosition: 'before', wrapPrefix: '<agent>', wrapSuffix: '</agent>', maxTokens: 64 } },
        { id: 'rewrite', phase: 'post', prompt: 'REWRITE', injection: { order: 3 },
            postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64 } },
        { id: 'tracker', phase: 'post', prompt: 'TRACKER', sourceTemplateId: 'tpl-scene-tracker', injection: { order: 4 },
            postProcess: { enabled: true, type: 'extract', extractVariable: 'scene', extractPattern: '\\[SCENE\\][\\s\\S]*?\\[/SCENE\\]',
                promptTransformEnabled: true, promptTransformMode: 'append', promptTransformMaxTokens: 64 } },
        { id: 'literal', phase: 'post', postProcess: { enabled: true, type: 'append', appendText: ' tail' } },
        { id: 'regex', phase: 'post', regexScripts: [{ id: 'raw', findRegex: '/Polished/g', replaceString: 'Finished',
            placement: [2], markdownOnly: false, promptOnly: false }] },
    ]);
    let mains = 0;
    const calls = [];
    await f.run({ generate: paid('main', ({ messages }) => {
        mains++;
        assert.match(JSON.stringify(messages), /BOUND_LORE_FROM_AGENT/);
        assert.match(JSON.stringify(messages), /<agent>Prepared context<\/agent>/);
        assert.equal(f.saved().length, 3);
        return 'Raw answer';
    }), generateAgent: paid('agents', ({ messages }) => {
        const instruction = messages[0].content;
        calls.push(instruction);
        if (instruction.includes('PRE_CONTEXT')) return 'Prepared context';
        if (instruction.includes('REWRITE')) return 'Polished answer';
        if (instruction.includes('TRACKER')) return '[SCENE]Courtyard[/SCENE]';
        assert.fail('unexpected Agent request');
    }) });
    assert.equal(mains, 1);
    assert.equal(calls.length, 3);
    const saved = f.saved();
    assert.equal(saved.length, 4);
    assert.equal(saved[3].mes, '[SCENE]Courtyard[/SCENE]\n\nFinished answer tail');
    assert.deepEqual(saved[2].swipes, f.records[2].swipes);
    assert.equal(saved[0].chat_metadata.agent_scene, '[SCENE]Courtyard[/SCENE]');
    assert.equal(saved[0].chat_metadata.variables.agent_scene, '[SCENE]Courtyard[/SCENE]');
    assert.equal(saved[3].extra.inChatAgentTransformHistory.length, 1);
    assert.ok(saved[3].extra.inChatAgents.nativeRegexScripts.length);
    assert.equal(readArtifact(f.directories, f.jobId, 'roleplay-prompt').agentsHash, readArtifact(f.directories, f.jobId, 'roleplay-agents-pre').hash);
    await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
    assert.equal(f.saved().length, 4);
});

for (const effect of ['append', 'continue', 'swipe', 'replace']) {
    test(`bundled reply rewrites run in order with saved context and length settings for ${effect}`, async t => {
        const names = ['format-fixer', 'user-agency-guard', 'knowledge-guard', 'friction-keeper', 'nsfw-enhancer', 'dialogue-humaniser', 'repetition-breaker', 'length-trimmer', 'proofreader'];
        const agents = names.map(name => {
            const template = JSON.parse(fs.readFileSync(new URL(`../public/scripts/extensions/in-chat-agents/templates/${name}.json`, import.meta.url)));
            return { ...template, enabled: true, sourceTemplateId: template.id,
                settings: { ...template.settings, lengthTarget: 'Two short paragraphs' } };
        });
        const f = prepared(t, agents, { effect, globalSettings: { appendAgentsExecutionMode: 'sequential' } });
        const calls = [];
        await f.run({ generate: paid('main', () => 'Main output'), generateAgent: paid('rewrite', ({ messages }) => {
            const agent = agents[calls.length];
            calls.push(agent.id);
            const context = messages[1].content.match(/<recent_chat>\n([\s\S]*?)\n<\/recent_chat>/)?.[1];
            if (agent.postProcess.promptTransformContextMessages) {
                assert.equal(context, effect === 'append' ? 'User: Original\n\nNova: Answer' : 'User: Original');
            } else assert.equal(context, undefined);
            if (agent.id === 'tpl-length-trimmer') {
                assert.match(messages[0].content, /Two short paragraphs/);
                assert.doesNotMatch(messages[0].content, /\{\{lengthTarget\}\}/i);
            }
            if (calls.length > 1) assert.match(messages[1].content, new RegExp(`<assistant_response>\\nPass ${calls.length - 1}\\n`));
            return `Pass ${calls.length}`;
        }) });
        assert.deepEqual(calls, agents.map(agent => agent.id));
        assert.equal(f.saved().at(-1).mes, 'Pass 9');
        await f.run({ generate: () => assert.fail('Main reply repeated'), generateAgent: () => assert.fail('Rewrite repeated') });
    });
}

for (const guard of [true, false]) {
    test(`a refused reply rewrite ${guard ? 'keeps the original reply' : 'replaces the reply when the refusal guard is off'}`, async t => {
        const refusal = 'I\u2019m sorry, but I can\u2019t help with rewriting this scene.';
        const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'REWRITE', injection: { order: 3 },
            postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64 } }],
        { globalSettings: guard ? {} : { promptTransformRefusalGuard: false } });
        await f.run({ generate: paid('main', () => 'Main output'), generateAgent: paid('rewrite', () => refusal) });
        assert.equal(f.saved().at(-1).mes, guard ? 'Main output' : refusal);
    });
}

for (const effect of ['append', 'continue', 'swipe']) {
    test(`a native ${effect} reply saves automatic Companion cleanup with its successful note`, async t => {
        const f = prepared(t, [{ id: 'side', category: 'companion', prompt: 'SIDE',
            conditions: { generationTypes: ['normal', 'continue', 'swipe'] } }], { effect,
            globalSettings: { companionAutoCleanupEnabled: true, companionAutoCleanupOlderNotes: 0 },
            configure: records => {
                records[1].extra.inChatAgentCompanionResults = { side: { status: 'done', content: 'Old note' }, other: { status: 'done', content: 'Keep' } };
            } });
        await f.run({ generate: paid('main', () => 'New answer'), generateAgent: paid('side', () => 'New note') });
        const saved = f.saved();
        assert.equal(saved[1].extra.inChatAgentCompanionResults.side, undefined);
        assert.equal(saved[1].extra.inChatAgentCompanionResults.other.content, 'Keep');
        assert.equal(saved.at(-1).extra.inChatAgentCompanionResults.side.content, 'New note');
        await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Companion repeated') });
        assert.deepEqual(f.saved(), saved);
    });
}

test('a native range replacement counts only delivered notes towards automatic retention', async t => {
    const f = prepared(t, [{ id: 'side', category: 'companion', prompt: 'SIDE',
        conditions: { generationTypes: ['regenerate'] } }], { effect: 'replace',
        range: { start: 2, count: 2 },
        globalSettings: { companionAutoCleanupEnabled: true, companionAutoCleanupOlderNotes: 1 },
        configure: records => {
            records[2].extra = { inChatAgentCompanionResults: { side: { status: 'done', content: 'Keep older note' } } };
            records.push(...['Replaced one', 'Replaced two'].map(content => ({ is_user: false, mes: content,
                extra: { inChatAgentCompanionResults: { side: { status: 'done', content } } } })));
        } });
    await f.run({ generate: paid('main', () => 'New answer'), generateAgent: paid('side', () => 'New note') });
    const saved = f.saved();
    assert.equal(saved.length, 4);
    assert.equal(saved[2].extra.inChatAgentCompanionResults.side.content, 'Keep older note');
    assert.equal(saved[3].extra.inChatAgentCompanionResults.side.content, 'New note');
});

test('a post-main review resumes its saved main result and records only the reviewed Agent edit', async t => {
    const f = prepared(t, [{ id: 'review', prompt: 'REVIEW_EDIT', phase: 'pre', preProcess: {
        mode: 'intercept', interceptTiming: 'post-main-generation', applyMode: 'replace', maxTokens: 64,
    } }], { review: true });
    let calls = 0;
    const pending = await f.run({ generate: paid('main', () => 'Unreviewed answer'), generateAgent: () => assert.fail('review is required') });
    assert.equal(pending.waiting, true);
    assert.equal(f.saved().length, 3);
    const approval = getJob(f.directories, f.jobId).result.approval;
    decideJobApproval(f.context(), { id: approval.id, proposalHash: approval.proposalHash, decision: 'continue' });
    await f.run({ generate: () => assert.fail('saved main result repeated'), generateAgent: paid('review', () => { calls++; return 'Reviewed answer'; }) });
    assert.equal(calls, 1);
    assert.equal(f.saved()[3].mes, 'Reviewed answer');
    assert.equal(f.saved()[3].extra.inChatAgentPreGenerationInterceptHistory.at(-1).timing, 'post-main-generation');
});

test('Agent continuation rewrites the full selected answer while preserving every other swipe', async t => {
    const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'CONTINUE_REWRITE', postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
    } }], { effect: 'continue' });
    await f.run({ generate: paid('main', () => ' again'), generateAgent: paid('rewrite', ({ messages }) => {
        assert.match(JSON.stringify(messages), /Answer again/);
        return 'Completely revised answer';
    }) });
    const saved = f.saved();
    assert.equal(saved.length, 3);
    assert.equal(saved[2].mes, 'Completely revised answer');
    assert.deepEqual(saved[2].swipes, ['Completely revised answer', 'Other']);
    assert.equal(saved[1].mes, 'Original');
});

test('an acknowledged parallel Agent survives a lost sibling without committing or repeating either request', async t => {
    const f = prepared(t, ['one', 'two'].map(id => ({ id, phase: 'post', prompt: id.toUpperCase(), postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMode: 'append', promptTransformMaxTokens: 64,
    } })));
    let lose;
    const held = new Promise((_resolve, reject) => { lose = reject; });
    let agentCalls = 0;
    await assert.rejects(f.run({ generate: paid('main', () => 'Base'), generateAgent: paid('parallel', async ({ messages }) => {
        agentCalls++;
        if (messages[0].content.startsWith('ONE')) return held;
        lose(new Error('Unknown first Agent result'));
        return 'Acknowledged second result';
    }) }), /Unknown first Agent result/);
    assert.equal(agentCalls, 2);
    assert.equal(f.saved().length, 3);
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, f.jobId).state, 'interrupted');
    await assert.rejects(f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') }), /unknown|uncertain|recovery/i);
    assert.equal(f.saved().length, 3);
});

test('run together starts append Agents beside rewrites and joins their cleaned blocks after the rewritten reply', async t => {
    const post = (id, order, mode, prompt) => ({ id, phase: 'post', prompt, injection: { order }, postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMode: mode, promptTransformMaxTokens: 64 } });
    const f = prepared(t, [post('menu', 1, 'append', 'MENU'), post('polish', 2, 'rewrite', 'POLISH'), post('again', 3, 'append', 'AGAIN')]);
    const original = 'The lantern flickers at the fork in the road.';
    const menu = '1. Go left\n2. Go right';
    const started = [];
    let releasePolish;
    const polishHeld = new Promise(resolve => { releasePolish = resolve; });
    await f.run({ generate: paid('main', () => original), generateAgent: paid('agents', async ({ messages }) => {
        const instruction = messages[0].content;
        started.push(instruction.slice(0, 5));
        if (started.length === 3) releasePolish();
        if (instruction.startsWith('POLISH')) {
            assert.doesNotMatch(JSON.stringify(messages), /Go left/);
            await polishHeld;
            return 'The lantern gutters at the fork in the road.';
        }
        return `${original}\n\n${menu}`;
    }) });
    assert.deepEqual([...started].sort(), ['AGAIN', 'MENU\n', 'POLIS']);
    const saved = f.saved();
    assert.equal(saved.at(-1).mes, `The lantern gutters at the fork in the road.\n\n${menu}`);
    assert.deepEqual(saved.at(-1).extra.inChatAgentPromptRuns.map(run => run.agentId), ['menu', 'polish', 'again']);
});

for (const legacy of [false, true]) {
    test(`${legacy ? 'saved v2 plans keep ordered rewrites' : 'parallel rewrites overlap and durably synthesise with append context'}`, { timeout: 10000 }, async t => {
        const f = prepared(t, ['one', 'two', 'menu'].map((id, order) => ({ id, phase: 'post', prompt: id.toUpperCase(), injection: { order },
            postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMode: id === 'menu' ? 'append' : 'rewrite', promptTransformMaxTokens: 128 } })), { globalSettings: { appendAgentsExecutionMode: legacy ? 'sequential' : 'parallel' } });
        const calls = [];
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const generate = paid('main', () => 'Original reply');
        const generateAgent = paid('agents', async ({ messages, stepNamespace }) => {
            calls.push(stepNamespace);
            if (stepNamespace === 'agent-model:post-synthesis') {
                const input = JSON.parse(messages[1].content);
                assert.equal(input.original, 'Original reply');
                assert.deepEqual(input.candidates.map(item => item.text), ['First improvement', 'Second improvement']);
                assert.deepEqual(input.after, ['Choices']);
                return 'Both improvements';
            }
            if (stepNamespace === 'agent-model:post:one' && !legacy) await held;
            if (stepNamespace === 'agent-model:post:two') {
                assert.match(messages[1].content, legacy ? /First improvement/ : /Original reply/);
                release();
            }
            return stepNamespace.endsWith(':one') ? 'First improvement' : stepNamespace.endsWith(':two') ? 'Second improvement' : 'Choices';
        });
        if (legacy) {
            // Interrupt after the plan is saved but before any provider request, then simulate a v2 plan.
            await assert.rejects(f.run({ generate, generateAgent: () => { throw new Error('before dispatch'); } }), /before dispatch/);
            const plan = readArtifact(f.directories, f.jobId, 'roleplay-agent-post:plan');
            delete plan.hash;
            plan.version = 2;
            writeArtifact(f.directories, f.jobId, 'roleplay-agent-post:plan', { ...plan, hash: roleplayHash(plan) });
        }
        await f.run({ generate, generateAgent });
        assert.equal(f.saved().at(-1).mes, `${legacy ? 'Second improvement' : 'Both improvements'}\n\nChoices`);
        assert.equal(calls.includes('agent-model:post-synthesis'), !legacy);
        await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
    });
}

test('an uncertain synthesis retains all rewrite receipts and never repeats a paid request', async t => {
    const f = prepared(t, ['one', 'two'].map(id => ({ id, phase: 'post', prompt: id,
        postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 128 } })));
    await assert.rejects(f.run({ generate: paid('main', () => 'Original reply'), generateAgent: paid('agents', ({ stepNamespace }) => {
        if (stepNamespace === 'agent-model:post-synthesis') throw new Error('lost synthesis');
        return stepNamespace;
    }) }), /lost synthesis/);
    assert.equal(f.saved().length, 3);
    for (const id of ['one', 'two']) assert.ok(readArtifact(f.directories, f.jobId, `agent-model:post:${id}:result`));
    recoverJobs(f.directories);
    await assert.rejects(f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') }), /unknown|uncertain|recovery/i);
    assert.equal(f.saved().length, 3);
});

for (const output of [{ text: '' }, { text: 'Partial combination', finishReason: 'length' }]) {
    test(`an ${output.text ? 'incomplete' : 'empty'} synthesis cannot replace the original`, async t => {
        const f = prepared(t, ['one', 'two'].map(id => ({ id, phase: 'post', prompt: id,
            postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 128 } })));
        await assert.rejects(f.run({ generate: paid('main', () => 'Original reply'), generateAgent: paid('agents', ({ stepNamespace }) =>
            stepNamespace === 'agent-model:post-synthesis' ? output : stepNamespace) }), /empty or cut short/);
        assert.equal(f.saved().length, 3);
        await assert.rejects(f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') }), /empty or cut short/);
    });
}

test('a damaged postprocessing proof cannot publish a reply or tracker state', async t => {
    const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'REWRITE', postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
    } }], { translation: true });
    await assert.rejects(f.run({ generate: paid('main', () => 'Raw answer'), generateAgent: paid('rewrite', () => 'Polished answer'),
        translationFetch: async () => {
            const result = readArtifact(f.directories, f.jobId, 'roleplay-agent-post');
            writeArtifact(f.directories, f.jobId, 'roleplay-agent-post', { ...result, text: 'Unowned replacement' });
            return new Response(JSON.stringify({ translatedText: 'Réponse' }));
        } }), /Agent|processing|proof|recovery/i);
    assert.equal(f.saved().length, 3);
    assert.deepEqual(f.saved()[2].swipes, f.records[2].swipes);
});
