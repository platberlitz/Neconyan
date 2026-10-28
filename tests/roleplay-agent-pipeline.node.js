import assert from 'node:assert/strict';
import { getDiagnosticServerActivity } from '../src/diagnostic-activity.js';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { roleplayHash, withRoleplayAccount } = await import('../src/roleplay-store.js');
const { loadCurrentStateSync } = await import('../src/mewmory/sources.js');
const { mutateState } = await import('../src/mewmory/store.js');
const { putRecord, validateRecord } = await import('../src/mewmory/core.js');
const { getJob, releaseJob, updateJob } = await import('../src/jobs/store.js');
const { providerStep, readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { decideJobApproval } = await import('../src/generation/job-approvals.js');
const { requestRoleplayAgentStop } = await import('../src/generation/roleplay-agent-stop.js');
const { createFreshnessGate } = await import('../src/generation/roleplay-freshness-gate.js');
const { subscribeRoleplayPreview } = await import('../src/generation/roleplay-preview.js');
const { writeSecret, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
after(cancelAutoSaves);

const controls = { prompts: [{ identifier: 'main', role: 'system', system_prompt: true, content: '' },
    { identifier: 'worldInfoBefore', marker: true, system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true }], prompt_order: [{ character_id: 100001,
    order: [{ identifier: 'main', enabled: true }, { identifier: 'worldInfoBefore', enabled: true }, { identifier: 'chatHistory', enabled: true }] }] };

function prepared(t, agents, { effect = 'append', range = { start: 1, count: 1 }, review = false, translation = false, configure = () => {}, globalSettings = {}, imagePolicy = false, previewParent = null } = {}) {
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
        serverPrompt: true, ...(imagePolicy ? { mediaPolicyVersion: 1 } : {}), trigger: { append: 'normal', replace: 'regenerate', continue: 'continue', swipe: 'swipe' }[effect] });
    const request = { binding: { kind: 'profile', ...captureChatProfile(directories, 'main') }, maxTokens: 32,
        characterName: 'Nova', serverPrompt: true, worldInfo, messages: [],
        ...(previewParent ? { workflowCandidate: { version: 1, parentJobId: previewParent } } : {}) };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'agent-pipeline', effect, source, request });
    releaseJob(directories, jobId);
    updateJob(directories, jobId, { state: 'running' });
    const context = () => ({ directories, owner: f.scope.owner, job: getJob(directories, jobId), signal: new AbortController().signal });
    const run = ({ signal, ...options } = {}) => runRoleplayReplyJob({ ...context(), ...(signal ? { signal } : {}) }, { contextLimit: () => 4096,
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

for (const effect of ['append', 'continue', 'swipe', 'replace']) {
    test(`stopping a reply rewrite preserves the completed ${effect} reply without repeating a provider request`, async t => {
        const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'REWRITE', postProcess: {
            enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
        } }], { effect, translation: true });
        assert.equal(requestRoleplayAgentStop(f.context()), false, 'an unfinished main reply still uses normal cancellation');
        let calls = 0;
        await f.run({
            generate: paid('main', () => ({ text: 'Main output',
                response: { choices: [{ message: { reasoning_content: 'Saved reasoning' } }] } })),
            generateAgent: paid('rewrite', ({ jobContext }) => {
                calls++;
                assert.equal(requestRoleplayAgentStop(f.context()), true);
                assert.equal(requestRoleplayAgentStop(f.context()), true, 'repeated Stop is harmless');
                jobContext.signal.throwIfAborted();
                assert.fail('the Agent request must be aborted');
            }), translationFetch: () => assert.fail('Stop must not start translation'),
        });
        assert.equal(calls, 1);
        const saved = f.saved();
        const reply = saved.at(-1);
        assert.equal(reply.mes, effect === 'continue' ? 'AnswerMain output' : 'Main output');
        assert.equal(reply.extra.reasoning, 'Saved reasoning');
        if (effect === 'continue') assert.deepEqual(reply.swipes, ['AnswerMain output', 'Other']);
        if (effect === 'swipe') assert.deepEqual(reply.swipes, ['Answer', 'Other', 'Main output']);
        await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
        assert.deepEqual(f.saved(), saved);
    });
}

test('stopping at the post-main review saves the already paid reply without approval or another request', async t => {
    const f = prepared(t, [{ id: 'review', prompt: 'REVIEW_EDIT', phase: 'pre', preProcess: {
        mode: 'intercept', interceptTiming: 'post-main-generation', applyMode: 'replace', maxTokens: 64,
    } }], { review: true });
    const pending = await f.run({ generate: paid('main', () => 'Keep this reply'), generateAgent: () => assert.fail('review is required') });
    assert.equal(pending.waiting, true);
    assert.equal(requestRoleplayAgentStop(f.context()), true);
    assert.equal(getJob(f.directories, f.jobId).state, 'queued');
    await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('stopped Agent started') });
    assert.equal(f.saved().at(-1).mes, 'Keep this reply');
});

test('stopping Agents cannot overwrite an independently edited chat', async t => {
    const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'REWRITE', postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
    } }]);
    await assert.rejects(f.run({ generate: paid('main', () => 'Main output'), generateAgent: paid('rewrite', ({ jobContext }) => {
        assert.equal(requestRoleplayAgentStop(f.context()), true);
        const changed = f.saved();
        changed[2].mes = 'Independent edit';
        fs.writeFileSync(f.filename, changed.map(record => JSON.stringify(record)).join('\n'));
        jobContext.signal.throwIfAborted();
    }) }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(f.saved().length, 3);
    assert.equal(f.saved()[2].mes, 'Independent edit');
});

test('stopping synthesis keeps the original reply rather than an unfinished combination', async t => {
    const f = prepared(t, ['one', 'two'].map(id => ({ id, phase: 'post', prompt: id,
        postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 128 } })));
    const calls = [];
    await f.run({ generate: paid('main', () => 'Original reply'), generateAgent: paid('agents', ({ stepNamespace, jobContext }) => {
        calls.push(stepNamespace);
        if (stepNamespace === 'agent-model:post-synthesis') {
            assert.equal(requestRoleplayAgentStop(f.context()), true);
            jobContext.signal.throwIfAborted();
        }
        return stepNamespace;
    }) });
    assert.equal(calls.length, 3);
    assert.equal(f.saved().at(-1).mes, 'Original reply');
    await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
});

for (const companionMode of ['sequential', 'parallel']) test(`stopping a ${companionMode} Companion keeps the completed reply and the earlier saved note`, async t => {
    const f = prepared(t, ['first', 'second'].map((id, order) => ({ id, category: 'companion', prompt: id.toUpperCase(), injection: { order } })),
        { globalSettings: { companionExecutionMode: companionMode } });
    const calls = [];
    await f.run({ generate: paid('main', () => 'Original reply'), generateAgent: paid('companions', async ({ stepNamespace, jobContext }) => {
        calls.push(stepNamespace);
        if (stepNamespace.endsWith(':second')) {
            for (let attempt = 0; attempt < 100 && !readArtifact(f.directories, f.jobId, 'roleplay-companion:first'); attempt++) await nextTurn();
            assert.ok(readArtifact(f.directories, f.jobId, 'roleplay-companion:first'), 'the other Companion finished before Stop');
            assert.equal(requestRoleplayAgentStop(f.context()), true);
            jobContext.signal.throwIfAborted();
        }
        return 'Completed first note';
    }) });
    assert.equal(calls.length, 2);
    const saved = f.saved();
    assert.equal(saved.at(-1).mes, 'Original reply');
    assert.equal(saved.at(-1).extra.inChatAgentCompanionResults.first.content, 'Completed first note');
    assert.equal(saved.at(-1).extra.inChatAgentCompanionResults.second, undefined);
    await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Companion repeated') });
    assert.deepEqual(f.saved(), saved);
});

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

test('Mewmory Agent working prompt stays marked while the final writer prompt resumes cleanly', async t => {
    const f = prepared(t, [{ id: 'before', phase: 'pre', prompt: 'READ {{full-mewmory}}',
        preProcess: { mode: 'intercept', applyMode: 'wrap', wrapPosition: 'before', wrapPrefix: '<agent>', wrapSuffix: '</agent>', maxTokens: 64 } }]);
    withRoleplayAccount(f.scope, f.account, () => {
        loadCurrentStateSync(f.directories, f.locator);
        mutateState(f.directories, f.locator, state => {
            state.enabled = true;
            putRecord(state, validateRecord(state, { id: 'event:private-sentinel', kind: 'event',
                text: 'The parcel is blue. [Sources: genuine text]', refs: [state.timeline[0]], subjectIds: [], pinned: true },
            { asOf: 0, origin: 'author' }));
        });
    });
    let agentCalls = 0, first;
    const generateAgent = paid('memory-agent', ({ messages }) => {
        agentCalls++;
        const macroPrompt = messages[0].content;
        assert.match(macroPrompt, /The parcel is blue/);
        assert.doesNotMatch(macroPrompt, /event:private-sentinel|Mewmory context [^\]]+ (?:begin|end)/);
        return 'Prepared context';
    });
    await assert.rejects(f.run({ generateAgent, generate: async ({ messages }) => {
        first = structuredClone(messages);
        assert.match(JSON.stringify(messages), /The parcel is blue/);
        assert.match(JSON.stringify(messages), /\[Sources: genuine text\]/);
        assert.doesNotMatch(JSON.stringify(messages), /event:private-sentinel|Mewmory context [^\]]+ (?:begin|end)/);
        throw new Error('Stopped before dispatch');
    } }), /Stopped before dispatch/);
    const base = readArtifact(f.directories, f.jobId, 'roleplay-base-prompt');
    const final = readArtifact(f.directories, f.jobId, 'roleplay-prompt');
    assert.match(JSON.stringify(base.messages), /Mewmory context [^\]]+ begin/);
    assert.deepEqual(final.messages, first);
    await f.run({ generateAgent: () => assert.fail('Agent must not repeat'), generate: ({ messages }) => {
        assert.deepEqual(messages, first);
        return { text: 'Saved result' };
    } });
    assert.equal(agentCalls, 1);
});

test('prompt contributions and interceptors can use saved tracker macros before generation', async t => {
    const f = prepared(t, [
        { id: 'prompt', phase: 'pre', prompt: 'SAVED_SECRETS {{secrets-tracker}}', injection: { position: 1, depth: 1, role: 0 } },
        { id: 'before', phase: 'pre', prompt: 'CHECK_SECRETS {{secrets-tracker}}',
            preProcess: { mode: 'intercept', applyMode: 'wrap', wrapPosition: 'before', maxTokens: 64 } },
        { id: 'state', phase: 'pre', prompt: 'CHECK_STATE {{tracker-state}}',
            preProcess: { mode: 'intercept', applyMode: 'wrap', wrapPosition: 'before', maxTokens: 64 } },
        { id: 'secrets', phase: 'post', sourceTemplateId: 'tpl-secrets-tracker',
            postProcess: { enabled: true, type: 'extract', extractVariable: 'secret_data', extractPattern: '\\[SECRET\\|[^\\]]*\\]' } },
    ], { configure: records => { records[0].chat_metadata = { variables: { agent_secret_data: '[SECRET|Nova|Hidden name|Nobody]' } }; } });
    let calls = 0;
    await f.run({ generate: paid('main', ({ messages }) => {
        const prompt = messages.map(message => message.content).join('\n');
        assert.match(prompt, /SAVED_SECRETS <tracker name="secrets">\n\[SECRET\|Nova\|Hidden name\|Nobody\]/);
        assert.doesNotMatch(prompt, /\{\{secrets-tracker\}\}/);
        return 'Main output';
    }), generateAgent: paid('before', ({ messages }) => {
        calls++;
        const label = messages[0].content.startsWith('CHECK_STATE') ? 'CHECK_STATE' : 'CHECK_SECRETS';
        assert.match(messages[0].content, new RegExp(`^${label} <tracker name="secrets">\\n\\[SECRET\\|Nova\\|Hidden name\\|Nobody\\]`));
        return 'Keep knowledge private';
    }) });
    assert.equal(calls, 2);
});

test('before-reply interceptors fill tracker state without the secrets macro', async t => {
    const f = prepared(t, [
        { id: 'state', phase: 'pre', prompt: 'CHECK_STATE {{tracker-state}}',
            preProcess: { mode: 'intercept', applyMode: 'wrap', wrapPosition: 'before', maxTokens: 64 } },
        { id: 'scene', name: 'Scene Tracker', phase: 'post',
            postProcess: { enabled: true, type: 'extract', extractVariable: 'scene', extractPattern: '\\[SCENE\\][\\s\\S]*?\\[/SCENE\\]' } },
    ], { configure: records => { records[0].chat_metadata = { variables: { agent_scene: '[SCENE]Hangar[/SCENE]' } }; } });
    let calls = 0;
    await f.run({ generate: paid('main', () => 'Main output'), generateAgent: paid('before', ({ messages }) => {
        calls++;
        assert.match(messages[0].content, /^CHECK_STATE <tracker name="Scene Tracker">\n\[SCENE\]Hangar\[\/SCENE\]/);
        return 'Keep the scene';
    }) });
    assert.equal(calls, 1);
});

test('server reply rewrites see the saved trackers, the lore activated for the reply and the Author\'s Note', async t => {
    const f = prepared(t, [
        { id: 'continuity', phase: 'post', prompt: 'REWRITE<t>{{tracker-state}}</t><l>{{active-lore}}</l><n>{{active-authors-note}}</n>', injection: { order: 3 },
            postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64 } },
        { id: 'tracker', name: 'Scene Tracker', phase: 'post', prompt: 'TRACKER', injection: { order: 4 },
            postProcess: { enabled: true, type: 'extract', extractVariable: 'scene', extractPattern: '\\[SCENE\\][\\s\\S]*?\\[/SCENE\\]',
                promptTransformEnabled: true, promptTransformMode: 'append', promptTransformMaxTokens: 64 } },
    ], { configure: records => {
        records[0].chat_metadata = { note_prompt: '{{char}} limps on her left leg.', note_interval: 1, note_position: 1, note_depth: 4,
            variables: { agent_scene: '[SCENE]Hangar[/SCENE]' } };
        records[1].mes = 'Original secret-signal';
    } });
    const prompts = [];
    await f.run({ generate: paid('main', () => 'Raw answer'), generateAgent: paid('agents', ({ messages }) => {
        const instruction = messages[0].content;
        prompts.push(instruction);
        if (instruction.includes('REWRITE')) return 'Polished answer';
        if (instruction.includes('TRACKER')) return '[SCENE]Courtyard[/SCENE]';
        assert.fail('unexpected Agent request');
    }) });
    const rewrite = prompts.find(prompt => prompt.includes('REWRITE'));
    assert.match(rewrite, /<t><tracker name="Scene Tracker">\n\[SCENE\]Hangar\[\/SCENE\]\n<\/tracker><\/t>/);
    assert.match(rewrite, /<l>[^<]*BOUND_LORE_FROM_AGENT[^<]*<\/l>/);
    assert.match(rewrite, /<n>Nova limps on her left leg\.<\/n>/);
    assert.equal(f.saved().at(-1).mes, 'Polished answer\n\n[SCENE]Courtyard[/SCENE]');
});

for (const effect of ['append', 'continue', 'swipe', 'replace']) {
    test(`bundled reply rewrites run in order with saved context and length settings for ${effect}`, async t => {
        const names = ['continuity-corrector', 'character-authenticity', 'prompt-adherence-checker', 'format-fixer', 'user-agency-guard', 'knowledge-guard', 'friction-keeper', 'nsfw-enhancer', 'dialogue-humaniser', 'repetition-breaker', 'length-trimmer', 'proofreader'];
        const agents = names.map(name => {
            const template = JSON.parse(fs.readFileSync(new URL(`../public/scripts/extensions/in-chat-agents/templates/${name}.json`, import.meta.url)));
            return { ...template, enabled: true, sourceTemplateId: template.id,
                settings: { ...template.settings, lengthTarget: 'Two short paragraphs' } };
        });
        const f = prepared(t, agents, { effect, globalSettings: { appendAgentsExecutionMode: 'sequential' } });
        const calls = [];
        await f.run({ generate: paid('main', () => 'Main output'), generateAgent: paid('rewrite', ({ messages }) => {
            const agent = agents[calls.length];
            if (['tpl-format-fixer', 'tpl-proofreader'].includes(agent.id)) {
                const label = agent.id === 'tpl-format-fixer' ? 'Format Fixer' : 'Proofreader';
                assert.ok(getDiagnosticServerActivity().agents.running.some(item => item.label === label && item.phase === 'post' && item.location === 'server'));
            }
            calls.push(agent.id);
            const context = messages[1].content.match(/<recent_chat>\n([\s\S]*?)\n<\/recent_chat>/)?.[1];
            if (agent.postProcess.promptTransformContextMessages) {
                assert.equal(context, effect === 'append' ? 'User: Original\n\nNova: Answer' : 'User: Original');
            } else assert.equal(context, undefined);
            if (agent.id === 'tpl-length-trimmer') {
                assert.match(messages[0].content, /Two short paragraphs/);
                assert.doesNotMatch(messages[0].content, /\{\{lengthTarget\}\}/i);
            }
            if (agent.id === 'tpl-continuity-corrector') {
                assert.doesNotMatch(messages[0].content, /\{\{(tracker-state|active-lore|active-authors-note|persona|mewmory-facts|group-cards)\}\}/i);
            }
            if (agent.id === 'tpl-character-authenticity') {
                assert.doesNotMatch(messages[0].content, /\{\{(group-cards|mewmory-facts|mewmory-interview|mesExamplesRaw|description)\}\}/i);
            }
            if (agent.id === 'tpl-knowledge-guard') {
                assert.doesNotMatch(messages[0].content, /\{\{(secrets-tracker|active-lore|active-authors-note|persona)\}\}/i);
            }
            if (calls.length > 1) assert.match(messages[1].content, new RegExp(`<assistant_response>\\nPass ${calls.length - 1}\\n`));
            return `Pass ${calls.length}`;
        }) });
        assert.deepEqual(calls, agents.map(agent => agent.id));
        assert.equal(f.saved().at(-1).mes, 'Pass 12');
        await f.run({ generate: () => assert.fail('Main reply repeated'), generateAgent: () => assert.fail('Rewrite repeated') });
    });
}

for (const effect of ['append', 'swipe']) {
    test(`Prompt Adherence Checker sees only the enabled preset prompts for ${effect}`, async t => {
        const template = JSON.parse(fs.readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/prompt-adherence-checker.json', import.meta.url)));
        const agents = [{ ...template, enabled: true, sourceTemplateId: template.id }];
        const preset = { prompts: [...controls.prompts,
            { identifier: 'main', name: 'Main Prompt', content: 'Write in third person past tense for {{char}}.' },
            { identifier: 'rule-off', name: 'Switched Off', content: 'DISABLED_RULE_TEXT' },
            { identifier: 'rule-swipe', name: 'Swipe Only', content: 'SWIPE_RULE_TEXT', injection_trigger: ['swipe'] },
            { identifier: 'charDescription', marker: true }].filter((prompt, index, list) => list.findLastIndex(item => item.identifier === prompt.identifier) === index),
        prompt_order: [{ character_id: 100001, order: [...controls.prompt_order[0].order,
            { identifier: 'rule-off', enabled: false }, { identifier: 'rule-swipe', enabled: true }, { identifier: 'charDescription', enabled: true }] }] };
        const f = prepared(t, agents, { effect });
        let system = '';
        await f.run({ promptBackend: () => ({ backend: 'chat', active: preset, profile: { model: 'fixture' }, source: 'custom' }),
            generate: paid('main', () => 'Main output'), generateAgent: paid('rewrite', ({ messages }) => {
                system = messages[0].content;
                return 'Checked output';
            }) });
        assert.match(system, /<prompt name="Main Prompt">\nWrite in third person past tense for Nova\.\n<\/prompt>/);
        assert.doesNotMatch(system, /DISABLED_RULE_TEXT|\{\{preset-prompts\}\}|charDescription/);
        if (effect === 'swipe') assert.match(system, /SWIPE_RULE_TEXT/);
        else assert.doesNotMatch(system, /SWIPE_RULE_TEXT/);
        assert.equal(f.saved().at(-1).mes, 'Checked output');
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

const MAIN_REPLY_REFUSAL = 'I cannot fulfill this request. The prompt contains instructions to generate highly explicit sexual content. '
    + 'My safety policies strictly prohibit the generation of sexually explicit content, regardless of framing or context.';

for (const [effect, guard] of [['append', true], ['continue', true], ['append', false]]) {
    test(`a refused ${effect} main reply ${guard ? 'is kept without running Agents or Companions' : 'still runs Agents when the refusal guard is off'}`, async t => {
        const f = prepared(t, [
            { id: 'rewrite', phase: 'post', prompt: 'REWRITE', postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64 } },
            { id: 'side', category: 'companion', prompt: 'SIDE', conditions: { generationTypes: ['normal', 'continue'] } },
        ], { effect, translation: true, globalSettings: guard ? {} : { promptTransformRefusalGuard: false } });
        const agentCalls = [];
        let translations = 0;
        await f.run({ generate: paid('main', () => MAIN_REPLY_REFUSAL),
            generateAgent: paid('agent', ({ stepNamespace }) => {
                agentCalls.push(stepNamespace);
                return 'Agent output';
            }),
            translationFetch: async () => { translations++; return new Response(JSON.stringify({ translatedText: 'Refus' })); } });
        const saved = f.saved();
        const reply = saved.at(-1);
        if (guard) {
            assert.deepEqual(agentCalls, []);
            assert.equal(reply.mes, effect === 'continue' ? `Answer${MAIN_REPLY_REFUSAL}` : MAIN_REPLY_REFUSAL);
            assert.equal(reply.extra.inChatAgentCompanionResults?.side, undefined);
            assert.deepEqual(readArtifact(f.directories, f.jobId, 'roleplay-agent-stop'),
                { intentHash: roleplayHash(f.context().job.intent), reason: 'refused' });
            assert.equal(translations, 1, 'a refusal stop is not the owner\'s Stop');
        } else {
            assert.ok(agentCalls.length >= 2, 'the rewrite and the Companion both run');
            assert.equal(readArtifact(f.directories, f.jobId, 'roleplay-agent-stop'), undefined);
        }
        await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
        assert.deepEqual(f.saved(), saved);
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
    const calls = [];
    let mainCalls = 0;
    await f.run({ generate: paid('main', () => { mainCalls++; return 'Base'; }), generateAgent: paid('parallel', async ({ messages }) => {
        const name = messages[0].content.startsWith('ONE') ? 'one' : 'two';
        calls.push(name);
        if (name === 'one') return held;
        lose(new Error('Unknown first Agent result'));
        return 'Acknowledged second result';
    }) });
    assert.equal(mainCalls, 1);
    assert.deepEqual(calls.filter(name => name === 'two'), ['two'], 'the acknowledged Agent is never requested again');
    assert.deepEqual(calls.filter(name => name === 'one'), ['one', 'one'], 'the lost Agent is retried once');
    const saved = f.saved();
    assert.equal(saved.length, 4, 'the paid reply is still added');
    assert.match(saved.at(-1).mes, /^Base/);
    await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
    assert.deepEqual(f.saved(), saved);
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
            const interrupted = new AbortController();
            await assert.rejects(f.run({ signal: interrupted.signal, generate, generateAgent: () => {
                interrupted.abort(new Error('before dispatch'));
                throw new Error('before dispatch');
            } }), /before dispatch/);
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

test('a synthesis that fails twice keeps the original reply and never repeats a paid rewrite', async t => {
    const f = prepared(t, ['one', 'two'].map(id => ({ id, phase: 'post', prompt: id,
        postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 128 } })));
    const calls = [];
    await f.run({ generate: paid('main', () => 'Original reply'), generateAgent: paid('agents', ({ stepNamespace }) => {
        calls.push(stepNamespace);
        if (stepNamespace === 'agent-model:post-synthesis') throw new Error('lost synthesis');
        return stepNamespace;
    }) });
    assert.equal(calls.filter(name => name === 'agent-model:post-synthesis').length, 2, 'the failed synthesis is retried once');
    assert.equal(calls.length, 4, 'completed rewrites are not requested again');
    const saved = f.saved();
    assert.equal(saved.length, 4);
    assert.equal(saved.at(-1).mes, 'Original reply');
    await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
    assert.deepEqual(f.saved(), saved);
});

test('an Agent that fails once is retried and its rewrite is saved without repeating the main reply', async t => {
    const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'REWRITE', postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
    } }]);
    let mainCalls = 0, agentCalls = 0;
    await f.run({ generate: paid('main', () => { mainCalls++; return 'Raw answer'; }), generateAgent: paid('rewrite', () => {
        agentCalls++;
        if (agentCalls === 1) throw new Error('Agent connection reset');
        return 'Polished answer';
    }) });
    assert.equal(mainCalls, 1);
    assert.equal(agentCalls, 2);
    assert.equal(f.saved().length, 4);
    assert.equal(f.saved().at(-1).mes, 'Polished answer');
});

test('an Agent that fails twice still saves the reply and keeps translation', async t => {
    const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'REWRITE', postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
    } }], { translation: true });
    let agentCalls = 0, translations = 0;
    await f.run({ generate: paid('main', () => 'Raw answer'), generateAgent: paid('rewrite', () => {
        agentCalls++;
        throw new Error('Agent provider is down');
    }), translationFetch: async () => { translations++; return new Response(JSON.stringify({ translatedText: 'Réponse brute' })); } });
    assert.equal(agentCalls, 2);
    assert.equal(translations, 1, 'a failure stop is not the owner\'s Stop');
    const reply = f.saved().at(-1);
    assert.equal(f.saved().length, 4);
    assert.equal(reply.mes, 'Raw answer');
    assert.match(JSON.stringify(reply.extra), /Réponse brute/);
    await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
});

test('an Agent edited while it runs then fails still saves the reply with its accepted definitions', async t => {
    const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'REWRITE', postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
    } }]);
    const file = path.join(f.directories.inChatAgents, 'rewrite.json');
    let mainCalls = 0, agentCalls = 0;
    await f.run({ generate: paid('main', () => { mainCalls++; return 'Raw answer'; }), generateAgent: paid('rewrite', () => {
        agentCalls++;
        if (agentCalls === 1) {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            raw.prompt = 'EDITED WHILE RUNNING';
            fs.writeFileSync(file + '.tmp', JSON.stringify(raw));
            fs.renameSync(file + '.tmp', file);
        }
        throw new Error('Agent provider is down');
    }) });
    assert.equal(mainCalls, 1);
    assert.equal(agentCalls, 1, 'the changed setup blocks the retry before another paid Agent request');
    const saved = f.saved();
    assert.equal(saved.length, 4);
    assert.equal(saved.at(-1).mes, 'Raw answer');
    await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
    assert.deepEqual(f.saved(), saved);
});

test('settings saved while Agents run do not discard the reply when translation cannot run', async t => {
    const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'REWRITE', postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
    } }], { translation: true });
    const file = path.join(f.directories.root, 'settings.json');
    let agentCalls = 0, translationCalls = 0;
    await f.run({ generate: paid('main', () => 'Raw answer'), generateAgent: paid('rewrite', () => {
        agentCalls++;
        if (agentCalls === 1) {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            raw.active_character = 'Other.png';
            fs.writeFileSync(file + '.tmp', JSON.stringify(raw));
            fs.renameSync(file + '.tmp', file);
        }
        throw new Error('Agent provider is down');
    }), translationFetch: async () => {
        translationCalls++;
        return new Response(JSON.stringify({ translatedText: 'Réponse brute' }));
    } });
    assert.equal(agentCalls, 1);
    assert.equal(translationCalls, 0, 'changed settings are refused before any translation request');
    const saved = f.saved();
    assert.equal(saved.length, 4);
    assert.equal(saved.at(-1).mes, 'Raw answer');
    assert.equal(saved.at(-1).extra.display_text, undefined);
    await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
    assert.deepEqual(f.saved(), saved);
});

test('a translation failure after Agents keeps the finished rewrite', async t => {
    const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'REWRITE', postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
    } }], { translation: true });
    let agentCalls = 0, translationCalls = 0;
    await f.run({ generate: paid('main', () => 'Raw answer'), generateAgent: paid('rewrite', () => {
        agentCalls++;
        return 'Polished answer';
    }), translationFetch: async () => {
        translationCalls++;
        throw new Error('Translation provider is down');
    } });
    assert.equal(agentCalls, 1);
    assert.equal(translationCalls, 1);
    const saved = f.saved();
    assert.equal(saved.length, 4);
    assert.equal(saved.at(-1).mes, 'Polished answer');
    assert.equal(saved.at(-1).extra.display_text, undefined);
    await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
    assert.deepEqual(f.saved(), saved);
});

test('a restarted reply survives an Agent edit made before finalisation', async t => {
    const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'REWRITE', postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
    } }]);
    const file = path.join(f.directories.inChatAgents, 'rewrite.json');
    const crash = new AbortController();
    await assert.rejects(f.run({ signal: crash.signal, generate: paid('main', () => 'Raw answer'), generateAgent: () => {
        crash.abort(new Error('process stopped'));
        throw new Error('process stopped');
    } }), /process stopped/);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.prompt = 'EDITED AFTER RESTART';
    fs.writeFileSync(file + '.tmp', JSON.stringify(raw));
    fs.renameSync(file + '.tmp', file);

    let mainCalls = 0, agentCalls = 0;
    await f.run({ generate: () => { mainCalls++; assert.fail('main repeated'); },
        generateAgent: paid('rewrite', () => { agentCalls++; return 'x'; }) });
    assert.equal(mainCalls, 0);
    assert.equal(agentCalls, 0, 'the changed Agent is never dispatched again');
    const saved = f.saved();
    assert.equal(saved.length, 4);
    assert.equal(saved.at(-1).mes, 'Raw answer');
    assert.equal(readArtifact(f.directories, f.jobId, 'roleplay-output').agentProof, undefined);
    assert.deepEqual(readArtifact(f.directories, f.jobId, 'roleplay-agent-stop'),
        { intentHash: roleplayHash(f.context().job.intent), reason: 'failed' });
    await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
    assert.deepEqual(f.saved(), saved);
});

test('an owner Agent stop does not authorise a reply without Agent proof', async t => {
    const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'REWRITE', postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
    } }]);
    const file = path.join(f.directories.inChatAgents, 'rewrite.json');
    const crash = new AbortController();
    await assert.rejects(f.run({ signal: crash.signal, generate: paid('main', () => 'Raw answer'), generateAgent: () => {
        crash.abort(new Error('process stopped'));
        throw new Error('process stopped');
    } }), /process stopped/);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.prompt = 'EDITED AFTER RESTART';
    fs.writeFileSync(file, JSON.stringify(raw));
    writeArtifact(f.directories, f.jobId, 'roleplay-agent-stop', { intentHash: roleplayHash(f.context().job.intent) });

    let mainCalls = 0, agentCalls = 0;
    await assert.rejects(f.run({ generate: () => { mainCalls++; assert.fail('main repeated'); },
        generateAgent: paid('rewrite', () => { agentCalls++; return 'x'; }) }), { code: 'ROLEPLAY_AGENT_RECOVERY' });
    assert.equal(mainCalls, 0);
    assert.equal(agentCalls, 0);
    assert.equal(f.saved().length, 3, 'the owner Stop path still requires its completed Agent proof');
});

test('cancelling while Agents run still cancels the job instead of saving the reply', async t => {
    const f = prepared(t, [{ id: 'rewrite', phase: 'post', prompt: 'REWRITE', postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
    } }]);
    const cancel = new AbortController();
    let agentCalls = 0;
    await assert.rejects(f.run({ signal: cancel.signal, generate: paid('main', () => 'Raw answer'), generateAgent: () => {
        agentCalls++;
        cancel.abort(new Error('user cancelled'));
        throw new Error('user cancelled');
    } }), /user cancelled/);
    assert.equal(agentCalls, 1, 'a cancellation is never retried');
    assert.equal(f.saved().length, 3);
});

for (const output of [{ text: '' }, { text: 'Partial combination', finishReason: 'length' }]) {
    test(`an ${output.text ? 'incomplete' : 'empty'} synthesis cannot replace the original`, async t => {
        const f = prepared(t, ['one', 'two'].map(id => ({ id, phase: 'post', prompt: id,
            postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 128 } })));
        await f.run({ generate: paid('main', () => 'Original reply'), generateAgent: paid('agents', ({ stepNamespace }) =>
            stepNamespace === 'agent-model:post-synthesis' ? output : stepNamespace) });
        assert.equal(f.saved().length, 4);
        assert.equal(f.saved().at(-1).mes, 'Original reply');
        await f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('Agent repeated') });
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

for (const mode of ['display-only', 'caption']) test(`versioned ${mode} images stay consistent through every bundled reply rewrite`, async t => {
    const names = ['continuity-corrector', 'character-authenticity', 'prompt-adherence-checker', 'format-fixer', 'user-agency-guard', 'knowledge-guard', 'friction-keeper', 'nsfw-enhancer', 'dialogue-humaniser', 'repetition-breaker', 'length-trimmer', 'proofreader'];
    const agents = names.map(name => {
        const template = JSON.parse(fs.readFileSync(new URL(`../public/scripts/extensions/in-chat-agents/templates/${name}.json`, import.meta.url)));
        return { ...template, enabled: true, sourceTemplateId: template.id };
    });
    const { attachmentIdentity } = await import('../public/scripts/prompt-media-policy.js');
    const f = prepared(t, agents, { imagePolicy: true, globalSettings: { appendAgentsExecutionMode: 'sequential' }, configure(records) {
        const item = { type: 'image', url: 'data:image/png;base64,BROKEN', title: 'secret-signal PRIVATE_IMAGE_TITLE', append_title: true };
        item.neconyan_prompt = { version: 1, mode, attachment_hash: roleplayHash(attachmentIdentity(item)),
            ...(mode === 'caption' ? { caption: { source: 'custom', text: 'Reviewed visible description' } } : {}) };
        records[1].extra.media = [item];
    } });
    let mainCalls = 0, agentCalls = 0;
    const inspect = messages => {
        const text = JSON.stringify(messages);
        assert.doesNotMatch(text, /PRIVATE_IMAGE_TITLE|BOUND_LORE_FROM_AGENT|image_url|BROKEN/);
        return text;
    };
    await f.run({ generate: paid('main', ({ messages }) => {
        mainCalls++; const text = inspect(messages); assert.match(text, /Original/);
        if (mode === 'caption') assert.match(text, /Reviewed visible description/);
        return 'Main output';
    }), generateAgent: paid('rewrite', ({ messages }) => { agentCalls++; inspect(messages); return `Pass ${agentCalls}`; }) });
    assert.equal(mainCalls, 1); assert.equal(agentCalls, 12);
    assert.match(f.saved()[1].extra.media[0].url, /BROKEN/);
    await f.run({ generate: () => assert.fail('Repeated main'), generateAgent: () => assert.fail('Repeated rewrite') });
});

test('parallel Companion dispatches share one post-reply freshness check', { timeout: 20000 }, async t => {
    const agents = Array.from({ length: 5 }, (_, index) => ({ id: `side-${index}`, name: `Side ${index}`, enabled: true,
        category: 'companion', execution: 'companion', phase: 'pre', prompt: `TASK_SIDE_${index}`,
        companion: { includeWorldInfo: false } }));
    const f = prepared(t, agents, { globalSettings: { companionExecutionMode: 'parallel' } });
    let checks = 0;
    const calls = [];
    await f.run({
        freshnessGate: check => createFreshnessGate(() => { checks++; check(); }),
        generate: paid('main', () => 'Main reply'),
        generateAgent: paid('agent', ({ messages }) => {
            const task = JSON.stringify(messages).match(/TASK_SIDE_\d/)?.[0];
            calls.push(task);
            return { text: `Note for ${task}` };
        }),
    });
    assert.equal(calls.length, 5);
    assert.equal(checks, 1, 'one check covers every dispatch that arrived in the same turn');
    assert.deepEqual(Object.keys(f.saved().at(-1).extra.inChatAgentCompanionResults).sort(), agents.map(agent => agent.id).sort());
});

test('the completed stream frame gains its token count before a held Companion runs', { timeout: 20000 }, async t => {
    const parent = 'token-count-parent';
    const f = prepared(t, [
        { id: 'side', name: 'Side', enabled: true, category: 'companion', execution: 'companion', phase: 'pre',
            prompt: 'TASK_SIDE', companion: { includeWorldInfo: false } },
    ], { previewParent: parent });
    const frames = [];
    const unsubscribe = subscribeRoleplayPreview(f.scope.owner, parent, preview => frames.push({
        text: preview.text, token_count: preview.token_count, reasoning_tokens: preview.reasoning_tokens, stage: preview.stage,
    }));
    t.after(unsubscribe);
    let releaseCompanion;
    const companionHeld = new Promise(resolve => { releaseCompanion = resolve; });
    let companionEntered;
    const companionStarted = new Promise(resolve => { companionEntered = resolve; });
    const finalText = 'First words and the finished reply.';
    const running = f.run({
        generate: async options => {
            await options.beforeDispatch?.();
            options.onStream({ text: 'First words', reasoning: 'Considering' });
            await nextTurn();
            options.onStream({ text: finalText, reasoning: 'Considering the answer.' });
            return { text: finalText, response: { choices: [{ message: { reasoning_content: 'Considering the answer.' } }] } };
        },
        generateAgent: async () => {
            companionEntered();
            await companionHeld;
            return { text: 'Companion note' };
        },
    });
    await companionStarted;
    const initial = frames.find(frame => frame.text === 'First words' && Number.isInteger(frame.token_count)
        && Number.isInteger(frame.reasoning_tokens));
    assert.ok(initial, 'the initial stream frame is counted');
    const completed = frames.findLast(frame => frame.text === finalText && frame.stage === 'agents'
        && frame.token_count > initial.token_count && frame.reasoning_tokens > initial.reasoning_tokens);
    assert.ok(completed, 'the completed frame is recounted before the Companion runs');
    assert.equal(f.saved().length, 3, 'the reply is not saved while the Companion is held');
    releaseCompanion();
    await running;
    assert.equal(f.saved().at(-1).mes, finalText);
    assert.equal(f.saved().at(-1).extra.token_count, completed.token_count);
    assert.equal(f.saved().at(-1).extra.reasoning_tokens, completed.reasoning_tokens);
});

test('a source edit between the saved Agent input and dispatch refuses without a provider call', async t => {
    const f = prepared(t, [{ id: 'edit', phase: 'post', prompt: 'REWRITE_REPLY', postProcess: {
        enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64,
    } }]);
    let providerCalls = 0;
    await assert.rejects(f.run({
        generate: paid('main', () => 'Main reply'),
        generateAgent: async options => {
            const changed = f.saved();
            changed[2].mes = 'Independent edit';
            fs.writeFileSync(f.filename, changed.map(record => JSON.stringify(record)).join('\n'));
            await options.beforeDispatch();
            providerCalls++;
            return { text: 'Must not be sent' };
        },
    }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(providerCalls, 0, 'the changed source is refused before the provider request');
    assert.ok(readArtifact(f.directories, f.jobId, 'agent-model:post:edit:input'), 'the input was saved before its one remaining gate');
    assert.equal(readArtifact(f.directories, f.jobId, 'agent-model:post:edit:provider'), undefined);
});

test('an approved review publishes pending Companions before post-reply work on the resumed result', { timeout: 20000 }, async t => {
    const parent = 'review-pending-parent';
    const f = prepared(t, [
        { id: 'review', phase: 'pre', prompt: 'REVIEW_EDIT', preProcess: {
            mode: 'intercept', interceptTiming: 'post-main-generation', applyMode: 'replace', maxTokens: 64,
        } },
        { id: 'edit', phase: 'post', prompt: 'EDIT_REPLY', postProcess: { enabled: true, promptTransformEnabled: true } },
        { id: 'side', name: 'Side', enabled: true, category: 'companion', execution: 'companion', phase: 'pre',
            prompt: 'TASK_SIDE', companion: { includeWorldInfo: false } },
    ], { review: true, previewParent: parent });
    const events = [];
    const unsubscribe = subscribeRoleplayPreview(f.scope.owner, parent, preview => events.push({ kind: 'preview',
        stage: preview.stage, side: preview.inChatAgentCompanionResults?.side?.status,
        keys: Object.keys(preview.inChatAgentCompanionResults ?? {}) }));
    t.after(unsubscribe);
    const waiting = await f.run({ generate: paid('main', () => 'Unreviewed answer'), generateAgent: () => assert.fail('review is required') });
    assert.equal(waiting.waiting, true);
    const reviewFrame = events.findLast(event => event.kind === 'preview' && event.stage === 'review');
    assert.ok(reviewFrame, 'the paused review frame is published');
    assert.equal(reviewFrame.keys.length, 0, 'a paused review does not leave a Companion marked as running');
    const approval = getJob(f.directories, f.jobId).result.approval;
    decideJobApproval(f.context(), { id: approval.id, proposalHash: approval.proposalHash, decision: 'continue' });

    let releaseEdit;
    const editHeld = new Promise(resolve => { releaseEdit = resolve; });
    let editEntered;
    const editStarted = new Promise(resolve => { editEntered = resolve; });
    let sideCalls = 0;
    const running = f.run({ generate: () => assert.fail('the saved main result was repeated'), generateAgent: paid('agent', async options => {
        const text = JSON.stringify(options.messages);
        if (text.includes('REVIEW_EDIT')) { events.push({ kind: 'call', agent: 'review' }); return { text: 'Reviewed answer' }; }
        if (text.includes('EDIT_REPLY')) { events.push({ kind: 'call', agent: 'edit' }); editEntered(); await editHeld; return { text: 'Edited answer' }; }
        events.push({ kind: 'call', agent: 'side' });
        sideCalls++;
        return { text: 'Side note' };
    }) });
    await editStarted;
    const reviewCall = events.findLastIndex(event => event.kind === 'call' && event.agent === 'review');
    const announced = events.findLastIndex(event => event.kind === 'preview' && event.stage === 'agents' && event.side === 'pending');
    const editCall = events.findIndex(event => event.kind === 'call' && event.agent === 'edit');
    assert.ok(reviewCall >= 0, 'the approved interceptor ran on the resumed result');
    assert.ok(announced < reviewCall, 'pending cards are published before the reviewed interceptor call');
    assert.ok(announced < editCall, 'pending cards are visible before post-reply work starts');
    assert.equal(sideCalls, 0, 'the one-at-a-time Companion waits for post-reply work');
    releaseEdit();
    await running;
    assert.equal(f.saved().at(-1).mes, 'Edited answer');
    assert.equal(f.saved().at(-1).extra.inChatAgentCompanionResults.side.content, 'Side note');
});
