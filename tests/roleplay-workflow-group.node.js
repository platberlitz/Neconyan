import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { write: writeCard } = await import('../src/character-card-parser.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { runPathfinderToolJob } = await import('../src/generation/pathfinder-tool-jobs.js');
const { captureRoleplayWorkflowRequest, admitRoleplayWorkflowJob, runRoleplayWorkflowJob,
    recoverWaitingRoleplayWorkflow } = await import('../src/generation/roleplay-workflow.js');
const { getJob, recoverJobs, releaseJob, requestCancellation, setJobState, updateJob } = await import('../src/jobs/store.js');
const { readArtifact, providerStep, writeArtifact } = await import('../src/jobs/artifacts.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { markRoleplayAgentsFailed, markRoleplayAgentsRefused, requestRoleplayAgentStop } = await import('../src/generation/roleplay-agent-stop.js');
const { enableMewmoryHiding, rememberSavedChat } = await import('./mewmory-hiding-fixture.js');
const { putRecord, validateRecord } = await import('../src/mewmory/core.js');
const { mutateState } = await import('../src/mewmory/store.js');

const controls = { prompts: [{ identifier: 'main', role: 'system', content: '', system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true }],
prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }] };

function prepared(t, { text = 'Everyone, please answer.', forcedAvatars, disabled = [], strategy = 1,
    autoSwipe = false, autoContinue = false, pathfinder = false, bundledMacros = null, browserMacros = null,
    description = null, history = 0, scene = null, generationMode = 0, promptControls = controls, agents = [], groupSettings = {} } = {}) {
    const f = fixture(t, true);
    const dirs = f.scope.directories;
    if (description !== null) {
        fs.writeFileSync(path.join(dirs.characters, 'Nova.png'), writeCard(png, JSON.stringify({ name: 'Nova', description })));
    }
    f.records[1].extra = {};
    if (history) {
        f.records.splice(1, 0, ...Array.from({ length: history }, (_, index) => ({
            name: index % 2 === 0 ? 'User' : 'Nova', is_user: index % 2 === 0,
            mes: 'history ' + index + ' ' + 'lorem ipsum dolor sit amet '.repeat(20), extra: {},
        })));
    }
    f.records.push({ name: 'User', is_user: true, mes: text, extra: {} });
    scene?.(f.records);
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(dirs.characters, 'Other.png'), writeCard(png,
        JSON.stringify({ name: 'Other', description: 'Second member', data: { name: 'Other', description: 'Second member' } })));
    fs.writeFileSync(path.join(dirs.groups, 'group.json'), JSON.stringify({ id: 'group', members: ['Nova.png', 'Other.png'],
        disabled_members: disabled, chats: ['Source', 'New'], activation_strategy: strategy, generation_mode: generationMode,
        member_models: { 'Other.png': 'fixture-override' }, ...groupSettings }));
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
    if (agents.length) {
        dirs.inChatAgents = path.join(dirs.root, 'InChatAgents');
        fs.mkdirSync(dirs.inChatAgents, { recursive: true });
        for (const agent of agents) fs.writeFileSync(path.join(dirs.inChatAgents, `${agent.id}.json`), JSON.stringify({
            name: agent.id, enabled: true, category: 'custom', ...agent,
        }));
    }
    dirs.openAI_Settings = path.join(dirs.root, 'openai-presets');
    fs.mkdirSync(dirs.openAI_Settings);
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Main.json'), JSON.stringify({ openai_max_context: 4096 }));
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: [] } },
        ...(autoSwipe || autoContinue ? { power_user: { ...(autoSwipe ? { auto_swipe: true,
            auto_swipe_minimum_length: 15 } : {}), ...(autoContinue ? { auto_continue: {
            enabled: true, allow_chat_completions: true, target_length: 30 } } : {}) } } : {}),
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1', function_calling: true },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture', preset: 'Main',
            'api-url': 'http://127.0.0.1:18000/v1' }] },
        ...(pathfinder || agents.length ? { inChatAgents: { globalSettings: { enabled: true, ...(pathfinder ? { pathfinderEnabled: true } : {}) } } } : {}) },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator, groupId: 'group' });
    const request = captureRoleplayWorkflowRequest(f.scope, account, source, { binding: { kind: 'profile',
        ...captureChatProfile(dirs, 'main') }, maxTokens: 32, effect: 'append', forcedAvatars, generationId: 47,
    bundledMacros, browserMacros });
    const { jobId } = admitRoleplayWorkflowJob(f.scope, account, { operationKey: 'group-workflow', source, request });
    releaseJob(dirs, jobId);
    const context = () => ({ owner: f.scope.owner, directories: dirs, job: getJob(dirs, jobId), signal: new AbortController().signal });
    return { f, dirs, source, account, request, jobId, context,
        records: () => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
        async completeCandidate(turn, expected, count) {
            const pointer = readArtifact(dirs, jobId, turn ? `roleplay-workflow-child:${turn}` : 'roleplay-workflow-child');
            const child = getJob(dirs, pointer.jobId);
            assert.equal(child.intent.request.worldInfo.avatar, expected.avatar);
            setJobState(dirs, child.id, 'running');
            await runRoleplayReplyJob({ owner: f.scope.owner, directories: dirs, job: getJob(dirs, child.id),
                signal: new AbortController().signal }, { contextLimit: () => 4096,
                promptBackend: () => ({ backend: 'chat', active: { ...promptControls, function_calling: true },
                    profile: { model: 'fixture' }, source: 'custom' }),
                ...(pathfinder ? { generatePathfinder: async options => {
                    const step = roleplayHash(['group-sidecar', child.id]);
                    options.onProviderStep(`provider:${step}`);
                    return providerStep(options.jobContext, step, async () => { options.beforeDispatch(); return { text: '' }; });
                } } : {}),
                ...(expected.generateAgent ? { generateAgent: async options => {
                    const step = roleplayHash(['group-agent', child.id, options.stepNamespace ?? '', options.messages]);
                    options.onProviderStep?.(`provider:${step}`);
                    return providerStep(options.jobContext, step, async () => {
                        await options.beforeDispatch?.();
                        return { text: await expected.generateAgent(options) };
                    });
                } } : {}),
                generate: async options => {
                    count.value++;
                    assert.equal(options.modelOverride ?? '', expected.modelOverride);
                    assert.ok(options.messages.some(message => String(message.content).includes(`write only as ${expected.name}`)));
                    expected.check?.(options);
                    const step = roleplayHash(['group-workflow', child.id]);
                    options.onProviderStep(`provider:${step}`);
                    return providerStep(options.jobContext, step, async () => { options.beforeDispatch();
                        return expected.response ? { text: expected.reply, response: expected.response } : { text: expected.reply };
                    });
                } });
            setJobState(dirs, child.id, 'completed');
            recoverWaitingRoleplayWorkflow({ directories: dirs, owner: f.scope.owner, job: getJob(dirs, jobId) });
            assert.equal(getJob(dirs, jobId).state, 'queued');
            setJobState(dirs, jobId, 'running');
        },
    };
}

test('saved whole-group turn completes speakers in order and retains each protected write across a restart', async t => {
    const f = prepared(t);
    assert.deepEqual(f.request.group.speakers.map(speaker => speaker.avatar), ['Nova.png', 'Other.png']);
    assert.equal(f.request.capacity.companionTurns, 2);
    assert.equal(f.request.capacity.maxTurns, 16);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const count = { value: 0 };
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Nova replies.' }, count);
    assert.equal(f.records().length, 4);
    const waiting = await runRoleplayWorkflowJob(f.context());
    assert.equal(waiting.waiting, true);
    assert.equal(f.records().at(-1).mes, 'Nova replies.');
    assert.equal(f.records().at(-1).original_avatar, 'Nova.png');
    assert.equal(f.records().at(-1).extra.gen_id, 47);
    assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-workflow-speaker:0').result.rawHash,
        readArtifact(f.dirs, f.jobId, 'roleplay-workflow-group-lineage:1').source.rawHash);
    await f.completeCandidate(1, { avatar: 'Other.png', name: 'Other', modelOverride: 'fixture-override', reply: 'Other replies.' }, count);
    const completed = await runRoleplayWorkflowJob(f.context());
    assert.equal(completed.result.status, 'completed');
    assert.deepEqual(f.records().slice(4).map(record => [record.name, record.mes, record.original_avatar, record.extra.gen_id]), [
        ['Nova', 'Nova replies.', 'Nova.png', 47], ['Other', 'Other replies.', 'Other.png', 47],
    ]);
    assert.equal(f.records()[2].mes, 'Answer');
    assert.equal(count.value, 2);
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), completed);
});

test('server group replies leave out lines a speaker did not hear and record who heard each reply', async t => {
    const f = prepared(t, { scene: records => {
        records[0].chat_metadata = { group_scene: { away: [], location: '', whisper_to: [] } };
        records[1].mes = 'Only Nova heard the marigold code.';
        records[1].extra = { group_scene: { present: ['Nova.png'], whisper_to: [] } };
    } });
    assert.deepEqual(f.request.group.speakers.map(speaker => speaker.audience), [
        { present: ['Nova.png', 'Other.png'], whisper_to: [] },
        { present: ['Nova.png', 'Other.png'], whisper_to: [] },
    ]);
    const promptOf = options => options.messages.map(message => String(message.content)).join('\n');
    updateJob(f.dirs, f.jobId, { state: 'running' });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const count = { value: 0 };
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Nova replies.',
        check: options => assert.match(promptOf(options), /marigold/) }, count);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    await f.completeCandidate(1, { avatar: 'Other.png', name: 'Other', modelOverride: 'fixture-override', reply: 'Other replies.',
        check: options => {
            const prompt = promptOf(options);
            assert.doesNotMatch(prompt, /marigold/);
            assert.match(prompt, /Nova replies\./);
        } }, count);
    const completed = await runRoleplayWorkflowJob(f.context());
    assert.equal(completed.result.status, 'completed');
    const saved = f.records();
    assert.equal(saved[1].mes, 'Only Nova heard the marigold code.');
    assert.deepEqual(saved.slice(4).map(record => record.extra.group_scene), [
        { present: ['Nova.png', 'Other.png'], whisper_to: [] },
        { present: ['Nova.png', 'Other.png'], whisper_to: [] },
    ]);
});

function sceneMemories(t, options = {}) {
    const f = prepared(t, { ...options, scene: records => {
        records[0].chat_metadata = { group_scene: { away: [], location: 'The archive', whisper_to: [] } };
        records[1].extra = { group_scene: { present: ['Nova.png'], whisper_to: [] } };
    } });
    enableMewmoryHiding(f.dirs, f.f.locator, { autoHide: false });
    const remember = (state, id, ref, text, present) => {
        const record = validateRecord(state, { id, kind: 'event', text, refs: [ref], subjectIds: ['archive'], evidenceStatus: 'established' },
            { asOf: state.timeline.indexOf(ref), origin: 'objective_extractor' });
        record.provenance = { policy: 'test', jobId: 'job', audience: { present, whisper_to: [] } };
        putRecord(state, record, { automatic: true });
    };
    mutateState(f.dirs, f.f.locator, state => {
        remember(state, 'event:secret', state.timeline[0], 'Nova overheard the secret plan.', ['Nova.png']);
        remember(state, 'event:archive', state.timeline[1], 'Everyone gathered in the archive.', ['Nova.png', 'Other.png']);
    });
    return f;
}

const promptOf = options => options.messages.map(message => String(message.content)).join('\n');
const childOf = (f, turn) => readArtifact(f.dirs, f.jobId, turn ? `roleplay-workflow-child:${turn}` : 'roleplay-workflow-child').jobId;

test('server group replies carry the scene line and recall only the memories each speaker heard', async t => {
    const f = sceneMemories(t);
    const line = '[Scene: Location: The archive. Present: Nova, Other.]';
    assert.ok(f.request.group.speakers.every(speaker => speaker.contextPrompt.endsWith(`\n${line}`)));
    const memoryOf = turn => readArtifact(f.dirs, childOf(f, turn), 'roleplay-mewmory');
    updateJob(f.dirs, f.jobId, { state: 'running' });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const count = { value: 0 };
    let novaPrompt = '';
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Nova replies.',
        check: options => { novaPrompt = promptOf(options); } }, count);
    assert.ok(novaPrompt.includes(line));
    assert.ok(novaPrompt.includes('Nova overheard the secret plan.'));
    assert.ok(novaPrompt.includes('Everyone gathered in the archive.'));
    assert.equal(memoryOf(0).viewers, undefined);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    let otherPrompt = '';
    await f.completeCandidate(1, { avatar: 'Other.png', name: 'Other', modelOverride: 'fixture-override', reply: 'Other replies.',
        check: options => { otherPrompt = promptOf(options); } }, count);
    assert.ok(otherPrompt.includes(line));
    assert.ok(otherPrompt.includes('Everyone gathered in the archive.'), 'Other should recall the memory of a line they heard');
    assert.ok(!otherPrompt.includes('Nova overheard the secret plan.'), 'Other should not recall a line they missed');
    assert.ok(!otherPrompt.includes('Original'), 'the line Other missed should stay out of their history');
    assert.equal(memoryOf(1).enabled, true);
    assert.deepEqual(memoryOf(1).viewers, ['Other.png']);
    assert.equal((await runRoleplayWorkflowJob(f.context())).result.status, 'completed');
});

test('a server group reply prepared before speakers had their own recall still finishes without memories', async t => {
    const f = sceneMemories(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const count = { value: 0 };
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Nova replies.' }, count);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    writeArtifact(f.dirs, childOf(f, 1), 'roleplay-mewmory', { enabled: false, restricted: true, npcText: '', memoryText: '',
        interviewText: '', factsText: '', excludedIndices: [], presentationVersion: 1 });
    let otherPrompt = '';
    await f.completeCandidate(1, { avatar: 'Other.png', name: 'Other', modelOverride: 'fixture-override', reply: 'Other replies.',
        check: options => { otherPrompt = promptOf(options); } }, count);
    assert.ok(!otherPrompt.includes('Everyone gathered in the archive.'));
    assert.equal((await runRoleplayWorkflowJob(f.context())).result.status, 'completed');
    assert.deepEqual(f.records().slice(4).map(record => record.mes), ['Nova replies.', 'Other replies.']);
});

test('a server group Agent reads the memories its speaker heard', async t => {
    const f = sceneMemories(t, { agents: [{ id: 'reader', phase: 'pre', prompt: 'READ {{full-mewmory}}',
        preProcess: { mode: 'intercept', applyMode: 'wrap', wrapPosition: 'before', wrapPrefix: '<agent>', wrapSuffix: '</agent>', maxTokens: 64 } }] });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const count = { value: 0 };
    const read = {};
    const reader = name => options => {
        read[name] = String(options.messages[0].content);
        return `${name} notes`;
    };
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Nova replies.', generateAgent: reader('Nova') }, count);
    assert.ok(read.Nova.includes('Nova overheard the secret plan.'));
    assert.ok(read.Nova.includes('Everyone gathered in the archive.'));
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    await f.completeCandidate(1, { avatar: 'Other.png', name: 'Other', modelOverride: 'fixture-override', reply: 'Other replies.',
        generateAgent: reader('Other') }, count);
    assert.ok(read.Other.includes('Everyone gathered in the archive.'), 'the Agent should read what Other heard');
    assert.ok(!read.Other.includes('Nova overheard the secret plan.'), 'the Agent should not read what Other missed');
    assert.equal((await runRoleplayWorkflowJob(f.context())).result.status, 'completed');
});

test('server group replies leave out every line before the chat\'s memory starting point, and what was remembered from them', async t => {
    const f = prepared(t, { scene: records => {
        records[0].chat_metadata = { group_scene: { away: [], location: '', whisper_to: [], heard_from: 2 } };
    } });
    enableMewmoryHiding(f.dirs, f.f.locator, { autoHide: false });
    mutateState(f.dirs, f.f.locator, state => {
        const record = validateRecord(state, { id: 'event:archive', kind: 'event', text: 'Everyone gathered in the archive.', refs: [state.timeline[1]],
            subjectIds: ['archive'], evidenceStatus: 'established' }, { asOf: 1, origin: 'objective_extractor' });
        record.provenance = { policy: 'test', jobId: 'job', audience: { present: ['Nova.png', 'Other.png'], whisper_to: [] } };
        putRecord(state, record, { automatic: true });
    });
    const memoryOf = turn => readArtifact(f.dirs, childOf(f, turn), 'roleplay-mewmory');
    updateJob(f.dirs, f.jobId, { state: 'running' });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const count = { value: 0 };
    const prompts = [];
    for (const [turn, avatar, name, modelOverride] of [[0, 'Nova.png', 'Nova', ''], [1, 'Other.png', 'Other', 'fixture-override']]) {
        await f.completeCandidate(turn, { avatar, name, modelOverride, reply: `${name} replies.`,
            check: options => { prompts.push(promptOf(options)); } }, count);
        assert.deepEqual(memoryOf(turn).viewers, [avatar]);
        await runRoleplayWorkflowJob(f.context());
    }
    for (const prompt of prompts) {
        assert.match(prompt, /Everyone, please answer\./);
        assert.doesNotMatch(prompt, /Original|\bAnswer\b/, 'lines before the starting point stay out of the history');
        assert.ok(!prompt.includes('Everyone gathered in the archive.'), 'and so do memories of them');
    }
    assert.match(prompts[1], /Nova replies\./);
    assert.deepEqual(f.records().slice(1, 3).map(record => record.mes), ['Original', 'Answer']);
});

test('a server speaker who remembers only with the group leaves out lines nobody now in the scene heard with them', async t => {
    const f = prepared(t, { scene: records => {
        records[0].chat_metadata = { group_scene: { away: ['Nova.png'], location: '', whisper_to: [], with_group: ['Other.png'] } };
        records[1].mes = 'They both heard the marigold code.';
        records[1].extra = { group_scene: { present: ['Nova.png', 'Other.png'], whisper_to: [] } };
    } });
    assert.deepEqual(f.request.group.speakers.map(speaker => speaker.avatar), ['Other.png']);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    await f.completeCandidate(0, { avatar: 'Other.png', name: 'Other', modelOverride: 'fixture-override', reply: 'Other replies.',
        check: options => {
            const prompt = promptOf(options);
            assert.doesNotMatch(prompt, /marigold/, 'Nova heard it with them, but Nova is away');
            assert.match(prompt, /Everyone, please answer\./);
        } }, { value: 0 });
    assert.equal((await runRoleplayWorkflowJob(f.context())).result.status, 'completed');
    assert.equal(f.records()[1].mes, 'They both heard the marigold code.');
});

test('members marked away in the saved scene are not picked for a server group reply', async t => {
    const away = records => {
        records[0].chat_metadata = { group_scene: { away: ['Other.png'], location: '', whisper_to: [] } };
    };
    const f = prepared(t, { scene: away });
    assert.deepEqual(f.request.group.speakers.map(speaker => speaker.avatar), ['Nova.png']);
    assert.deepEqual(f.request.group.speakers[0].audience, { present: ['Nova.png'], whisper_to: [] });
    assert.throws(() => prepared(t, { scene: away, forcedAvatars: ['Nova.png', 'Other.png'] }),
        /not distinct enabled members/);
});

test('a whispered server group turn is answered by the members it is for, privately', async t => {
    const f = prepared(t, { text: 'Psst, a word in private.', scene: records => {
        records[0].chat_metadata = { group_scene: { away: [], location: '', whisper_to: ['Nova.png'] } };
        records.at(-1).extra = { group_scene: { present: ['Nova.png', 'Other.png'], whisper_to: ['Nova.png'] } };
    } });
    assert.deepEqual(f.request.group.speakers.map(speaker => [speaker.avatar, speaker.whisper]), [['Nova.png', ['Nova']]]);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    let prompt = '';
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Nova whispers back.',
        check: options => { prompt = promptOf(options); } }, { value: 0 });
    assert.match(prompt, /\[Private whisper between User and Nova\. Other members cannot hear or react to it\. Keep the reply private\.\]/);
    assert.equal((await runRoleplayWorkflowJob(f.context())).result.status, 'completed');
    const reply = f.records().at(-1);
    assert.equal(reply.mes, 'Nova whispers back.');
    assert.deepEqual(reply.extra.group_scene, { present: ['Nova.png', 'Other.png'], whisper_to: ['Nova.png'] });
});

for (const hearReplyTarget of [true, false]) test(`a first server speaker who missed the line they answer ${hearReplyTarget ? 'hears it' : 'stays out of it when the group says so'}`, async t => {
    const f = prepared(t, { forcedAvatars: ['Other.png', 'Nova.png'], groupSettings: hearReplyTarget ? {} : { hear_reply_target: false },
        scene: records => {
            records[0].chat_metadata = { group_scene: { away: [], location: '', whisper_to: [] } };
            records.at(-1).extra = { group_scene: { present: ['Nova.png'], whisper_to: [] } };
        } });
    assert.deepEqual(f.request.group.speakers.map(speaker => speaker.hears ?? null), [hearReplyTarget ? 2 : null, null]);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const count = { value: 0 };
    let otherPrompt = '';
    await f.completeCandidate(0, { avatar: 'Other.png', name: 'Other', modelOverride: 'fixture-override', reply: 'Other replies.',
        check: options => { otherPrompt = promptOf(options); } }, count);
    assert.equal(otherPrompt.includes('Everyone, please answer.'), hearReplyTarget);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    assert.equal(f.records().at(-1).mes, 'Other replies.');
    assert.deepEqual(f.records()[3].extra.group_scene.present, hearReplyTarget ? ['Nova.png', 'Other.png'] : ['Nova.png']);
    await f.completeCandidate(1, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Nova replies.',
        check: options => assert.match(promptOf(options), /Other replies\./) }, count);
    assert.equal((await runRoleplayWorkflowJob(f.context())).result.status, 'completed');
    const saved = f.records();
    assert.deepEqual(saved.slice(4).map(record => record.mes), ['Other replies.', 'Nova replies.']);
    assert.deepEqual(saved[3].extra.group_scene.present, hearReplyTarget ? ['Nova.png', 'Other.png'] : ['Nova.png']);
});

for (const generationMode of [1, 2]) test(`joined-cards mode ${generationMode} leaves an away member's card out of a server group reply`, async t => {
    const cards = { prompts: [...controls.prompts, { identifier: 'charDescription', marker: true, system_prompt: true }],
        prompt_order: [{ character_id: 100001, order: [...controls.prompt_order[0].order, { identifier: 'charDescription', enabled: true }] }] };
    const promptOf = options => options.messages.map(message => String(message.content)).join('\n');
    const replyPrompt = async away => {
        const f = prepared(t, { generationMode, promptControls: cards, description: 'Nova card', disabled: generationMode === 2 ? ['Other.png'] : [],
            forcedAvatars: ['Nova.png'], scene: records => {
                records[0].chat_metadata = { group_scene: { away, location: '', whisper_to: [] } };
            } });
        updateJob(f.dirs, f.jobId, { state: 'running' });
        assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
        let prompt = '';
        await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Nova replies.',
            check: options => { prompt = promptOf(options); } }, { value: 0 });
        return prompt;
    };
    const together = await replyPrompt([]);
    assert.ok(together.includes('Nova card'));
    assert.ok(together.includes('Second member'), 'the joined card should be present while Other is in the scene');
    const apart = await replyPrompt(['Other.png']);
    assert.ok(apart.includes('Nova card'));
    assert.ok(!apart.includes('Second member'), 'an away member\'s card should stay out of the joined prompt');
});

test('group speakers keep their owned identities while clearing older history between speakers', async t => {
    const f = prepared(t, { history: 20 });
    enableMewmoryHiding(f.dirs, f.f.locator, { autoHideTokens: 1024 });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const count = { value: 0 };
    const firstReply = 'First speaker ' + 'long detail '.repeat(600);
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: firstReply }, count);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const firstWrite = readArtifact(f.dirs, f.jobId, 'roleplay-workflow-speaker:0');
    const nextLineage = readArtifact(f.dirs, f.jobId, 'roleplay-workflow-group-lineage:1');
    assert.equal(firstWrite.result.rawHash, nextLineage.source.rawHash);
    // Mewmory reads the first speaker's reply before the second one lands.
    rememberSavedChat(f.dirs, f.f.locator);
    await f.completeCandidate(1, { avatar: 'Other.png', name: 'Other', modelOverride: 'fixture-override',
        reply: 'Second speaker reply' }, count);
    const completed = await runRoleplayWorkflowJob(f.context());
    assert.equal(completed.result.status, 'completed');
    const saved = f.records();
    const first = saved.find(record => record.mes === firstReply);
    assert.ok(first?.is_system, 'the first speaker should be hidden once the second reply no longer fits');
    assert.equal(first.extra?.mewmoryKeepHidden, true);
    assert.equal(saved.at(-1).mes, 'Second speaker reply');
    assert.ok(!saved.at(-1).is_system);
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), completed);
    assert.deepEqual(f.records(), saved);
    assert.equal(count.value, 2);
});

test('a captured page instruction and browser-local names reach every initial group speaker and its next lineage', async t => {
    const f = prepared(t, { bundledMacros: { dialoguecolors: 'Colour the group dialogue.' },
        browserMacros: ['PrivateGreeting', 'me-PrivateGreeting'] });
    const browserMacros = ['privategreeting', 'me-privategreeting'];
    assert.deepEqual(f.request.worldInfo.bundledMacros, { dialoguecolors: 'Colour the group dialogue.' });
    assert.deepEqual(f.request.worldInfo.browserMacros, browserMacros);
    assert.deepEqual(f.request.group.speakers.map(speaker => speaker.worldInfo.bundledMacros),
        Array.from({ length: 2 }, () => ({ dialoguecolors: 'Colour the group dialogue.' })));
    assert.deepEqual(f.request.group.speakers.map(speaker => speaker.worldInfo.browserMacros),
        Array.from({ length: 2 }, () => browserMacros));
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const count = { value: 0 };
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Nova replies.' }, count);
    await runRoleplayWorkflowJob(f.context());
    const lineage = readArtifact(f.dirs, f.jobId, 'roleplay-workflow-group-lineage:1');
    assert.deepEqual(lineage.worldInfo.bundledMacros, { dialoguecolors: 'Colour the group dialogue.' });
    assert.deepEqual(lineage.worldInfo.browserMacros, browserMacros);
    const next = getJob(f.dirs, readArtifact(f.dirs, f.jobId, 'roleplay-workflow-child:1').jobId);
    assert.deepEqual(next.intent.request.worldInfo.bundledMacros, { dialoguecolors: 'Colour the group dialogue.' });
    assert.deepEqual(next.intent.request.worldInfo.browserMacros, browserMacros);
});

test('a group speaker refuses a browser-local custom macro before dispatch', async t => {
    const f = prepared(t, { browserMacros: ['PrivateGreeting', 'me-PrivateGreeting'],
        description: 'Nova speaks {{me-PrivateGreeting}}.' });
    assert.deepEqual(f.request.worldInfo.browserMacros, ['privategreeting', 'me-privategreeting']);
    assert.deepEqual(f.request.group.speakers.map(speaker => speaker.worldInfo.browserMacros),
        [['privategreeting', 'me-privategreeting'], ['privategreeting', 'me-privategreeting']]);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const count = { value: 0 };
    await assert.rejects(f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '',
        reply: 'This must never be generated.' }, count), { code: 'MACRO_BROWSER_ONLY', status: 409 });
    assert.equal(count.value, 0);
});

for (const reason of ['owner', 'failed', 'refused']) test(`a group Agent ${reason} stop saves the current speaker and its warning after recovery`, async t => {
    const f = prepared(t, { pathfinder: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const count = { value: 0 };
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Keep this completed reply.' }, count);
    if (reason === 'owner') assert.equal(requestRoleplayAgentStop(f.context()), true);
    else {
        const child = getJob(f.dirs, getJob(f.dirs, f.jobId).children[0]);
        const mark = reason === 'failed' ? markRoleplayAgentsFailed : markRoleplayAgentsRefused;
        assert.equal(mark({ ...f.context(), job: child }), true);
    }
    await assert.rejects(runRoleplayWorkflowJob(f.context(), { beforePublication: () => {
        throw new Error('Lost acknowledgement after saving');
    } }), /Lost acknowledgement/);
    assert.equal(f.records().at(-1).mes, 'Keep this completed reply.');
    const completed = await runRoleplayWorkflowJob(f.context());
    assert.equal(completed.result.status, 'completed');
    assert.equal(completed.result.agentsFailed, reason === 'failed' ? true : undefined);
    assert.equal(getJob(f.dirs, f.jobId).children.length, 1);
    assert.equal(f.records().length, 5);
    assert.equal(count.value, 1);
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), completed);
});

test('saved group selection refuses disabled and forged speaker identities before paying', t => {
    const disabled = prepared(t, { disabled: ['Other.png'], forcedAvatars: ['Nova.png'] });
    assert.deepEqual(disabled.request.group.speakers.map(speaker => speaker.avatar), ['Nova.png']);
    assert.equal(disabled.request.capacity.companionTurns, 1);
    const forgedCapacity = { ...disabled.request.capacity, companionTurns: 2 };
    delete forgedCapacity.hash;
    assert.throws(() => admitRoleplayWorkflowJob(disabled.f.scope, disabled.account, { operationKey: 'forged-capacity',
        source: disabled.source, request: { ...disabled.request, capacity: { ...forgedCapacity, hash: roleplayHash(forgedCapacity) } } }),
    { code: 'ROLEPLAY_WORKFLOW_INVALID' });
    const changed = prepared(t, { disabled: ['Other.png'], forcedAvatars: ['Nova.png'] });
    changed.request.group.speakers[0].name = 'Other';
    assert.throws(() => admitRoleplayWorkflowJob(changed.f.scope, changed.account, { operationKey: 'forged-group',
        source: changed.source, request: changed.request }), { code: 'ROLEPLAY_WORKFLOW_INVALID' });
    assert.throws(() => captureRoleplayWorkflowRequest(disabled.f.scope, disabled.account, disabled.source, {
        binding: disabled.request.binding, effect: 'append', avatar: 'Other.png', maxTokens: 32,
        forcedAvatars: ['Other.png'] }), { code: 'ROLEPLAY_WORKFLOW_INVALID' });
});

test('a group speaker completes bound tools before the next speaker receives the protected source', async t => {
    const f = prepared(t, { pathfinder: true });
    assert.equal(f.request.capacity.maxTurns, 16);
    assert.equal(f.request.capacity.companionTurns, 2);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const count = { value: 0 };
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: '',
        response: { choices: [{ message: { tool_calls: [{ id: 'group-summary', type: 'function', function: {
            name: 'Pathfinder_Summarize', arguments: JSON.stringify({ title: 'Safe hall', content: 'The hall is clear.', book: 'Manual' }),
        } }] } }] } }, count);
    const waiting = await runRoleplayWorkflowJob(f.context());
    assert.equal(waiting.waiting, true);
    const toolId = waiting.childJobId;
    setJobState(f.dirs, toolId, 'running');
    await runPathfinderToolJob({ owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, toolId),
        signal: new AbortController().signal });
    setJobState(f.dirs, toolId, 'completed');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    setJobState(f.dirs, f.jobId, 'running');
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    assert.equal(f.records().length, 4);
    await f.completeCandidate(1, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'The hall is safe.',
        check: options => assert.ok(options.messages.some(message => message.role === 'tool'
            && message.tool_call_id === 'group-summary')) }, count);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    assert.equal(f.records().at(-1).mes, 'The hall is safe.');
    await f.completeCandidate(2, { avatar: 'Other.png', name: 'Other', modelOverride: 'fixture-override',
        reply: 'I see it too.' }, count);
    assert.equal((await runRoleplayWorkflowJob(f.context())).result.status, 'completed');
    assert.deepEqual(f.records().slice(4).map(record => [record.original_avatar, record.mes]), [
        ['Nova.png', 'The hall is safe.'], ['Other.png', 'I see it too.'],
    ]);
    assert.equal(count.value, 3);
});

test('automatic group alternatives and continuations remain with their saved speaker', async t => {
    const f = prepared(t, { autoSwipe: true, autoContinue: true });
    assert.equal(f.request.capacity.companionTurns, 16);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const count = { value: 0 };
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Short' }, count);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    assert.equal(f.records().length, 4);
    await f.completeCandidate(1, { avatar: 'Nova.png', name: 'Nova', modelOverride: '',
        reply: 'The first complete sentence is saved.' }, count);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-workflow-decision:1').decision.kind, 'continue');
    assert.equal(f.records().length, 4);
    await f.completeCandidate(2, { avatar: 'Nova.png', name: 'Nova', modelOverride: '',
        reply: ' A longer continuation completes this group answer with enough detail for everyone.'.repeat(5) }, count);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    assert.ok(f.records().at(-1).mes.startsWith('The first complete sentence is saved. A longer continuation'),
        JSON.stringify(f.records().at(-1).mes));
    assert.deepEqual(f.records().at(-1).swipes[0], 'Short');
    assert.equal(f.records().at(-1).swipe_id, 1);
    await f.completeCandidate(3, { avatar: 'Other.png', name: 'Other', modelOverride: 'fixture-override',
        reply: 'I have already seen the protected first answer and I will answer with enough detail for the saved turn.'
            .repeat(5) }, count);
    assert.equal((await runRoleplayWorkflowJob(f.context())).result.status, 'completed');
    assert.equal(f.records().at(-1).original_avatar, 'Other.png');
    assert.equal(count.value, 4);
});

test('an interrupted group delivery reuses its protected first speaker write after restart', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const count = { value: 0 };
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Saved first speaker.' }, count);
    await assert.rejects(runRoleplayWorkflowJob(f.context(), { beforePublication: index => {
        if (index === 0) throw new Error('Lost group parent acknowledgement');
    } }), /Lost group parent acknowledgement/);
    const saved = f.records();
    assert.equal(saved.length, 5);
    assert.equal(saved.at(-1).mes, 'Saved first speaker.');
    const next = await runRoleplayWorkflowJob(f.context());
    assert.equal(next.waiting, true);
    assert.deepEqual(f.records(), saved);
    await f.completeCandidate(1, { avatar: 'Other.png', name: 'Other', modelOverride: 'fixture-override',
        reply: 'Saved second speaker.' }, count);
    const done = await runRoleplayWorkflowJob(f.context());
    assert.equal(done.result.status, 'completed');
    assert.deepEqual(f.records().slice(4).map(record => record.mes), ['Saved first speaker.', 'Saved second speaker.']);
    assert.equal(count.value, 2);
});

test('an unrelated edit after the last group speaker cannot close the parent as a successful turn', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const count = { value: 0 };
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'First saved.' }, count);
    await runRoleplayWorkflowJob(f.context());
    await f.completeCandidate(1, { avatar: 'Other.png', name: 'Other', modelOverride: 'fixture-override',
        reply: 'Second saved.' }, count);
    await assert.rejects(runRoleplayWorkflowJob(f.context(), { beforePublication: index => {
        if (index !== 1) return;
        const changed = f.records();
        changed[1].mes = 'Unrelated changed user.';
        fs.writeFileSync(f.f.filename, changed.map(record => JSON.stringify(record)).join('\n'));
    } }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(f.records()[1].mes, 'Unrelated changed user.');
    await assert.rejects(runRoleplayWorkflowJob(f.context()), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(count.value, 2);
});

test('a lost group provider result interrupts the family without paying again or replacing old messages', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const pointer = readArtifact(f.dirs, f.jobId, 'roleplay-workflow-child');
    const child = getJob(f.dirs, pointer.jobId);
    setJobState(f.dirs, child.id, 'running');
    let calls = 0;
    const fake = { owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, child.id),
        signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(fake, { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: { ...controls, function_calling: true },
            profile: { model: 'fixture' }, source: 'custom' }),
        generate: async options => {
            calls++;
            const step = roleplayHash(['group-unknown', child.id]);
            options.onProviderStep(`provider:${step}`);
            return providerStep(options.jobContext, step, async () => { options.beforeDispatch(); throw new Error('Lost provider result'); });
        } }), /Lost provider result/);
    recoverJobs(f.dirs);
    assert.equal(getJob(f.dirs, child.id).state, 'interrupted');
    recoverWaitingRoleplayWorkflow({ directories: f.dirs, owner: f.f.scope.owner, job: getJob(f.dirs, f.jobId) });
    assert.equal(getJob(f.dirs, f.jobId).state, 'interrupted');
    assert.equal(f.records().length, 4);
    assert.equal(f.records()[2].mes, 'Answer');
    await assert.rejects(runRoleplayReplyJob({ ...fake, job: getJob(f.dirs, child.id) }, { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: { ...controls, function_calling: true },
            profile: { model: 'fixture' }, source: 'custom' }),
        generate: () => { calls++; throw new Error('The provider was called twice'); } }), { code: 'ROLEPLAY_JOB_REJECTED' });
    assert.equal(calls, 1);
});

test('cancelling a waiting group parent stops every queued speaker before paying', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const childId = getJob(f.dirs, f.jobId).children[0];
    requestCancellation(f.dirs, f.jobId);
    assert.equal(getJob(f.dirs, f.jobId).state, 'cancelled');
    assert.equal(getJob(f.dirs, childId).state, 'cancelled');
    await assert.rejects(runRoleplayWorkflowJob(f.context()), { code: 'ROLEPLAY_WORKFLOW_RECOVERY' });
    assert.equal(f.records().length, 4);
});

test('cancelling after a completed speaker retains that owned reply and stops the next speaker', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const calls = { value: 0 };
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'First was saved.' }, calls);
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    assert.equal(f.records().at(-1).mes, 'First was saved.');
    const nextChild = getJob(f.dirs, f.jobId).children.at(-1);
    requestCancellation(f.dirs, f.jobId);
    assert.equal(getJob(f.dirs, f.jobId).state, 'cancelled');
    assert.equal(getJob(f.dirs, nextChild).state, 'cancelled');
    await assert.rejects(runRoleplayWorkflowJob(f.context()), { code: 'ROLEPLAY_WORKFLOW_RECOVERY' });
    assert.equal(f.records().length, 5);
    assert.equal(f.records().at(-1).mes, 'First was saved.');
    assert.equal(calls.value, 1);
});

test('an unowned chat change between group speakers cannot become the next accepted source', async t => {
    const f = prepared(t);
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'Saved first speaker.' }, { value: 0 });
    assert.equal((await runRoleplayWorkflowJob(f.context())).waiting, true);
    const old = f.records();
    old[1].mes = 'Externally changed';
    fs.writeFileSync(f.f.filename, old.map(record => JSON.stringify(record)).join('\n'));
    let paid = 0;
    const child = getJob(f.dirs, getJob(f.dirs, f.jobId).children.at(-1));
    setJobState(f.dirs, child.id, 'running');
    await assert.rejects(runRoleplayReplyJob({ owner: f.f.scope.owner, directories: f.dirs,
        job: getJob(f.dirs, child.id), signal: new AbortController().signal }, {
        generate: () => { paid++; return { text: 'Unsafe next speaker' }; },
    }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(paid, 0);
    assert.equal(getJob(f.dirs, f.jobId).children.length, 2);
});

test('a filtered group candidate is delivered immediately without the next speaker or automatic continuation', async t => {
    const f = prepared(t, { autoContinue: true });
    updateJob(f.dirs, f.jobId, { state: 'running' });
    await runRoleplayWorkflowJob(f.context());
    const count = { value: 0 };
    await f.completeCandidate(0, { avatar: 'Nova.png', name: 'Nova', modelOverride: '', reply: 'An unfinished sentence',
        response: { choices: [{ message: { content: 'An unfinished sentence' }, finish_reason: 'content_filter' }] } }, count);
    const first = await runRoleplayWorkflowJob(f.context(), { decideCandidate: async () => { throw new Error('A blocked group candidate must not be judged'); } });
    assert.equal(first.result.status, 'completed');
    assert.equal(first.result.speakers.length, 1);
    assert.equal(f.records().at(-1).mes, 'An unfinished sentence');
    assert.equal(f.records().at(-1).extra.generation_outcome.status, 'blocked');
    assert.equal(f.records().at(-1).original_avatar, 'Nova.png');
    assert.equal(count.value, 1);
    assert.deepEqual(await runRoleplayWorkflowJob(f.context()), first);
});
