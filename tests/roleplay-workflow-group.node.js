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
const { readArtifact, providerStep } = await import('../src/jobs/artifacts.js');
const { roleplayHash } = await import('../src/roleplay-store.js');

const controls = { prompts: [{ identifier: 'main', role: 'system', content: '', system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true }],
prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }] };

function prepared(t, { text = 'Everyone, please answer.', forcedAvatars, disabled = [], strategy = 1,
    autoSwipe = false, autoContinue = false, pathfinder = false } = {}) {
    const f = fixture(t, true);
    const dirs = f.scope.directories;
    f.records[1].extra = {};
    f.records.push({ name: 'User', is_user: true, mes: text, extra: {} });
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(dirs.characters, 'Other.png'), writeCard(png,
        JSON.stringify({ name: 'Other', description: 'Second member', data: { name: 'Other', description: 'Second member' } })));
    fs.writeFileSync(path.join(dirs.groups, 'group.json'), JSON.stringify({ id: 'group', members: ['Nova.png', 'Other.png'],
        disabled_members: disabled, chats: ['Source', 'New'], activation_strategy: strategy, generation_mode: 0,
        member_models: { 'Other.png': 'fixture-override' } }));
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
            auto_swipe_minimum_length: 15 } : {}), ...(autoContinue ? { auto_continue: {
            enabled: true, allow_chat_completions: true, target_length: 30 } } : {}) } } : {}),
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1', function_calling: true },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture', preset: 'Main',
            'api-url': 'http://127.0.0.1:18000/v1' }] },
        ...(pathfinder ? { inChatAgents: { globalSettings: { enabled: true, pathfinderEnabled: true } } } : {}) },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator, groupId: 'group' });
    const request = captureRoleplayWorkflowRequest(f.scope, account, source, { binding: { kind: 'profile',
        ...captureChatProfile(dirs, 'main') }, maxTokens: 32, effect: 'append', forcedAvatars, generationId: 47 });
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
                promptBackend: () => ({ backend: 'chat', active: { ...controls, function_calling: true },
                    profile: { model: 'fixture' }, source: 'custom' }),
                ...(pathfinder ? { generatePathfinder: async options => {
                    const step = roleplayHash(['group-sidecar', child.id]);
                    options.onProviderStep(`provider:${step}`);
                    return providerStep(options.jobContext, step, async () => { options.beforeDispatch(); return { text: '' }; });
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

test('saved group selection refuses disabled and forged speaker identities before paying', t => {
    const disabled = prepared(t, { disabled: ['Other.png'], forcedAvatars: ['Nova.png'] });
    assert.deepEqual(disabled.request.group.speakers.map(speaker => speaker.avatar), ['Nova.png']);
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
