import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureCompanionCapacity } = await import('../src/generation/companion-capacity.js');
const { captureRoleplayWorkflowCapacity } = await import('../src/generation/roleplay-workflow-capacity.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { releaseJob, getJob, updateJob, recoverJobs } = await import('../src/jobs/store.js');
const { readArtifact, providerStep } = await import('../src/jobs/artifacts.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { getRegexScriptRevision } = await import('../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js');
const { MEMORY_SHARD_TEMPLATE_ID } = await import('../public/scripts/extensions/in-chat-agents/companion/companion-shared.js');
after(cancelAutoSaves);

const controls = { prompts: [{ identifier: 'main', role: 'system', system_prompt: true, content: '' },
    { identifier: 'worldInfoBefore', marker: true, system_prompt: true }, { identifier: 'chatHistory', marker: true, system_prompt: true }],
prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'worldInfoBefore', enabled: true }, { identifier: 'chatHistory', enabled: true }] }] };
const companion = (id, options = {}) => ({ id, name: id.toUpperCase(), enabled: true, category: 'companion', execution: 'companion',
    phase: 'pre', prompt: `TASK_${id.toUpperCase()}`, companion: { includeWorldInfo: false, ...options } });
function prepared(t, agents, { global = {}, effect = 'append', changeRecords, extraCard = false } = {}) {
    const f = fixture(t), directories = f.scope.directories;
    directories.worlds = path.join(directories.root, 'worlds');
    directories.inChatAgents = path.join(directories.root, 'InChatAgents');
    for (const directory of [directories.worlds, directories.inChatAgents]) fs.mkdirSync(directory, { recursive: true });
    f.records[1].extra = {};
    f.records[2].extra ??= {};
    changeRecords?.(f.records);
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n') + '\n');
    if (extraCard) fs.copyFileSync(path.join(directories.characters, 'Nova.png'), path.join(directories.characters, 'Kit.png'));
    fs.writeFileSync(path.join(directories.worlds, 'Bells.json'), JSON.stringify({ entries: { 1: { uid: 1, key: ['evening-bell'],
        content: 'THE_COMPANION_BELL_LORE', position: 0, order: 100, disable: false } } }));
    const settings = { name1: 'Ari', power_user: { sysprompt: { content: 'Saved system instructions' } },
        world_info_settings: { world_info: { globalSelect: ['Bells'] }, world_info_budget: 200 },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1' },
        extension_settings: { note: { default: 'Saved author note' }, connectionManager: { profiles: [{ id: 'main', name: 'Saved Main',
            api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:18000/v1' }] },
        inChatAgents: { globalSettings: { enabled: true, connectionProfile: 'main', postMainInterceptShowMessageFirst: false, ...global } } } };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
    for (const agent of agents) fs.writeFileSync(path.join(directories.inChatAgents, `${agent.id}.json`), JSON.stringify(agent));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const anchored = ['continue', 'swipe'].includes(effect);
    const source = captureRoleplaySource(f.scope, { locator: f.locator, ...(anchored ? { message: f.records.length - 2 } : {}) });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 4000, serverPrompt: true, trigger: anchored ? effect : 'normal' });
    const request = { binding: { kind: 'profile', ...captureChatProfile(directories, 'main') }, maxTokens: 32, characterName: 'Nova', worldInfo, serverPrompt: true, messages: [] };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'companions-native', source, effect, request });
    releaseJob(directories, jobId);
    updateJob(directories, jobId, { state: 'running' });
    const context = () => ({ owner: f.scope.owner, directories, job: getJob(directories, jobId), signal: new AbortController().signal });
    return { ...f, directories, account, source, request, worldInfo, jobId, context,
        rows: () => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
        run: options => runRoleplayReplyJob(context(), { contextLimit: () => 4096, promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }), ...options }) };
}

function paid(label, callback) {
    return async options => {
        const key = roleplayHash({ label, step: options.stepNamespace ?? '', messages: options.messages });
        options.onProviderStep?.(`provider:${key}`);
        return providerStep(options.jobContext, key, async () => {
            await options.beforeDispatch?.();
            return typeof callback === 'function' ? callback(options) : { text: callback };
        });
    };
}

test('an oversized bound Companion set refuses admission before any model or chat change', t => {
    const agents = Array.from({ length: 27 }, (_, index) => companion(`capacity-${index}`));
    assert.throws(() => prepared(t, agents), { code: 'ROLEPLAY_COMPANION_CAPACITY', status: 507 });
});

test('hidden Companions do not reserve automatic workflow capacity or call a model', async t => {
    const agents = Array.from({ length: 31 }, (_, index) => companion(`capacity-${index}`));
    const hiddenIds = agents.slice(9).map(agent => agent.id);
    const f = prepared(t, agents, { global: { hiddenCompanionAgentIds: hiddenIds,
        companionExecutionMode: 'parallel', companionConcurrentWithPostGen: true } });
    assert.equal(f.worldInfo.companionCapacity.companionCount, 9);
    const capacity = captureRoleplayWorkflowCapacity(f.scope, f.account, f.source,
        { companionBytes: f.worldInfo.companionCapacity.requiredBytes });
    assert.equal(capacity.maxTurns, 16);
    const calls = [];
    await f.run({ generate: paid('main', 'Main reply'), generateAgent: paid('agent', options => {
        const task = JSON.stringify(options.messages).match(/TASK_CAPACITY-\d+/)?.[0];
        calls.push(task);
        return { text: `Note for ${task}` };
    }) });
    assert.deepEqual(calls.sort(), agents.slice(0, 9).map(agent => `TASK_${agent.id.toUpperCase()}`).sort());
    assert.deepEqual(Object.keys(f.rows().at(-1).extra.inChatAgentCompanionResults).sort(), agents.slice(0, 9).map(agent => agent.id).sort());
});

test('hidden Companions still reserve explicit manual runs and retained notes', () => {
    const agents = [companion('hidden')], source = { message: { index: 0 } };
    const hiddenIds = ['hidden'];
    assert.equal(captureCompanionCapacity(agents, [], source, { hiddenIds }), null);
    const manual = captureCompanionCapacity(agents, [], source, { hiddenIds, agentContext: true });
    assert.equal(manual.companionCount, 1);
    const existing = { hidden: { status: 'done', content: 'Retained note' } };
    const records = [{}, { extra: { inChatAgentCompanionResults: existing } }];
    const continued = captureCompanionCapacity(agents, records, source, { hiddenIds, trigger: 'continue' });
    assert.equal(continued.companionCount, 0);
    assert.equal(continued.baselineBytes, Buffer.byteLength(JSON.stringify(existing)));
    assert.ok(continued.requiredBytes > continued.baselineBytes);
});

test('swiping with Agents preserves the original host while reconciling reply metadata', async t => {
    const f = prepared(t, [{ ...companion('side'), conditions: { generationTypes: ['swipe'] } }], { effect: 'swipe' });
    const original = f.rows().at(-1).mes;
    await f.run({ generate: paid('main', 'Replacement reply'), generateAgent: paid('agent', 'Replacement note') });
    const row = f.rows().at(-1);
    assert.equal(row.mes, 'Replacement reply');
    assert.ok(row.swipes.includes(original));
    assert.ok(row.swipes.includes('Replacement reply'));
    assert.equal(row.extra.inChatAgentCompanionResults.side.content, 'Replacement note');
    assert.equal(row.extra.inChatAgentCompanionResults.side.status, 'done');
});

test('native companions see the processed reply, saved lore, original notes and bound extra cards, then run their own post passes', async t => {
    const note = companion('side', { includeWorldInfo: true, includeInChatHistory: true, contextMessages: 2 });
    note.sourceTemplateId = 'tpl-chatroom-companion';
    note.settings = { chatroomStyle: 'custom', chatroomCustomStyles: 'Quiet: Whisper softly', chatroomCustomStyleName: 'Quiet', chatroomExtraCharacterAvatars: ['Kit.png'] };
    const f = prepared(t, [
        { id: 'edit', name: 'Edit', enabled: true, phase: 'post', prompt: 'EDIT_REPLY', postProcess: { enabled: true, promptTransformEnabled: true } }, note,
        { id: 'note-pass', name: 'Note pass', enabled: true, phase: 'post', prompt: 'EDIT_NOTE', conditions: { generationTypes: ['unused'], runOnCompanionOutputs: true, companionOutputTargetAgentIds: ['side'] },
            postProcess: { enabled: true, promptTransformEnabled: true, type: 'append', appendText: 'MUST_NOT_APPEND' },
            regexScripts: [{ id: 'display', findRegex: '/dressed/g', replaceString: 'polished', placement: [2], markdownOnly: true },
                { id: 'raw', findRegex: '/polished/g', replaceString: 'finished', placement: [2], markdownOnly: false, promptOnly: false }] },
    ], { extraCard: true, changeRecords(records) { records[2].extra.inChatAgentCompanionResults = { side: { status: 'done', content: 'Earlier {{original}} by {{char}}',
        includeInChatHistory: true, includeAllChatHistory: true, chatHistoryDepth: 1, keepInChatHistoryWhenHostHidden: true } }; } });
    const seen = [];
    await f.run({ generate: paid('main', options => {
        const text = JSON.stringify(options.messages);
        assert.match(text, /Earlier Answer by Nova/);
        assert.equal((text.match(/Earlier Answer by Nova/g) ?? []).length, 1);
        return { text: 'Raw reply' };
    }), generateAgent: paid('agent', options => {
        const text = JSON.stringify(options.messages);
        seen.push(options.stepNamespace);
        if (text.includes('EDIT_REPLY')) return { text: 'Rewritten with evening-bell' };
        if (text.includes('EDIT_NOTE')) return { text: 'note dressed' };
        assert.match(text, /TASK_SIDE/);
        assert.match(text, /Rewritten with evening-bell/);
        assert.match(text, /THE_COMPANION_BELL_LORE/);
        assert.match(text, /Earlier Answer by Nova/);
        assert.match(text, /Saved system instructions/);
        assert.match(text, /Saved author note/);
        assert.match(text, /Chatroom Extra Character Cards/);
        assert.match(text, /Whisper softly/);
        return { text: 'initial note' };
    }) });
    const row = f.rows().at(-1), result = row.extra.inChatAgentCompanionResults.side;
    assert.equal(row.mes, 'Rewritten with evening-bell');
    assert.equal(result.content, 'note finished');
    assert.equal(result.status, 'done');
    assert.equal(result.includeInChatHistory, true);
    assert.equal(result.profileLabel, 'Saved Main');
    assert.ok(result.tokenUsage.inputTokens > 0 && result.tokenUsage.outputTokens > 0);
    assert.equal(seen.length, 3);
    assert.ok(f.worldInfo.agents.extraCharacters.some(character => character.avatar === 'Kit.png'));
    await f.run({ generate: () => assert.fail('completed main repeated'), generateAgent: () => assert.fail('completed companion repeated') });
});

test('saved companion batches, waiting dependencies and manual dependants run in deterministic waves', async t => {
    const tracker = { ...companion('a', { batch: true, batchAgentIds: ['b'] }), category: 'tracker' };
    const f = prepared(t, [tracker, companion('b'),
        companion('c', { dependencies: ['a'], waitForDependencies: true }), companion('d', { trigger: 'manual', dependencies: ['c'], waitForDependencies: true })]);
    const calls = [];
    await f.run({ generate: paid('main', 'Main reply'), generateAgent: paid('agent', options => {
        const text = JSON.stringify(options.messages);
        if (text.includes('[Tasks]')) {
            calls.push('batch');
            assert.match(text, /<<<companion:a>>>/); assert.match(text, /<<<companion:b>>>/);
            return { text: '<<<COMPANION:a>>>A note<<<END:a>>>\n<<<companion:b>>>B note<<<end:b>>>' };
        }
        if (text.includes('TASK_C')) { calls.push('c'); assert.match(text, /Completed companion: A/); assert.match(text, /A note/); return { text: 'C note' }; }
        calls.push('d'); assert.match(text, /TASK_D/); assert.match(text, /Completed companion: C/); return { text: 'D note' };
    }) });
    assert.deepEqual(calls, ['batch', 'c', 'd']);
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults.a.agentCategory, 'tracker');
    assert.deepEqual(Object.values(f.rows().at(-1).extra.inChatAgentCompanionResults).map(result => result.content), ['A note', 'B note', 'C note', 'D note']);
});

test('a completed partial companion batch retries only its missing task, while a lost batch response cannot fall back', async t => {
    for (const lost of [false, true]) {
        const f = prepared(t, [companion('a', { batch: true, batchAgentIds: ['b'] }), companion('b')]);
        const calls = [];
        const run = () => f.run({ generate: paid('main', 'Main reply'), generateAgent: paid('agent', options => {
            if (JSON.stringify(options.messages).includes('[Tasks]')) {
                calls.push('batch');
                if (lost) throw new Error('Lost paid batch response');
                return { text: '<<<companion:a>>>A note<<<end:a>>>' };
            }
            calls.push('missing-b'); assert.match(JSON.stringify(options.messages), /TASK_B/); return { text: 'B note' };
        }) });
        if (!lost) { await run(); assert.deepEqual(calls, ['batch', 'missing-b']); }
        else {
            await assert.rejects(run(), /Lost paid batch response/);
            assert.deepEqual(f.rows(), f.records);
            recoverJobs(f.directories);
            assert.equal(getJob(f.directories, f.jobId).state, 'interrupted');
            await assert.rejects(f.run({ generate: () => assert.fail('main repeated'), generateAgent: () => assert.fail('lost batch repeated') }), { code: 'ROLEPLAY_AGENT_RECOVERY' });
            assert.deepEqual(calls, ['batch']);
        }
    }
});

test('concurrent companions use the frozen unedited reply while post passes finish independently', { timeout: 10000 }, async t => {
    const f = prepared(t, [companion('side'), { id: 'edit', name: 'Edit', enabled: true, phase: 'post', prompt: 'EDIT_REPLY',
        postProcess: { enabled: true, promptTransformEnabled: true } }], { global: { companionConcurrentWithPostGen: true } });
    let entered = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    await f.run({ generate: paid('main', 'Raw reply'), generateAgent: paid('agent', async options => {
        const text = JSON.stringify(options.messages);
        if (++entered === 2) release();
        await gate;
        if (text.includes('EDIT_REPLY')) return { text: 'Edited reply' };
        assert.match(text, /Raw reply/); assert.doesNotMatch(text, /Edited reply/);
        return { text: 'Note about the raw reply' };
    }) });
    assert.equal(entered, 2);
    assert.equal(f.rows().at(-1).mes, 'Edited reply');
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults.side.content, 'Note about the raw reply');
});

test('a length-limited continued companion retains its last good selected note and a dependency cycle pays no companion', async t => {
    const previous = { status: 'done', content: 'Last good note', includeInChatHistory: false };
    const limited = prepared(t, [companion('side')], { effect: 'continue', changeRecords(records) { records[2].extra.inChatAgentCompanionResults = { side: previous }; } });
    await limited.run({ generate: paid('main', ' again'), generateAgent: paid('agent', () => ({ text: 'Cut-off note', response: { choices: [{ finish_reason: 'length' }] } })) });
    assert.equal(limited.rows().at(-1).mes, 'Answer again');
    assert.equal(limited.rows().at(-1).extra.inChatAgentCompanionResults.side.content, 'Last good note');
    assert.equal(readArtifact(limited.directories, limited.jobId, 'roleplay-companions').results.side.content, 'Last good note');
    assert.match(limited.rows().at(-1).extra.inChatAgentCompanionResults.side.lastRunError, /output limit/);
    assert.equal(limited.rows().at(-1).extra.inChatAgentCompanionResults.side.lastRunFailureKind, 'limit');
    const cycle = prepared(t, [companion('a', { dependencies: ['b'], waitForDependencies: true }), companion('b', { dependencies: ['a'], waitForDependencies: true })]);
    await cycle.run({ generate: paid('main', 'Reply survives known dependency failure'), generateAgent: () => assert.fail('cyclic dependency reached a provider') });
    assert.equal(cycle.rows().at(-1).extra.inChatAgentCompanionResults.a.status, 'error');
    assert.match(cycle.rows().at(-1).extra.inChatAgentCompanionResults.b.error, /cycle/);
    assert.equal(cycle.rows().at(-1).extra.inChatAgentCompanionResults.b.failureKind, 'cycle');
});

test('retained hidden companion notes use their original host and frozen prompt regex without exposing hidden message text', async t => {
    const script = { id: 'old-script', findRegex: '/evening-bell/g', replaceString: '', placement: [2], promptOnly: true, markdownOnly: false,
        trimStrings: [], disabled: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null };
    const f = prepared(t, [], { changeRecords(records) {
        records[2].is_system = true;
        records[2].mes = 'SECRET_HIDDEN_MESSAGE';
        records[2].extra = { title: 'SECRET_HIDDEN_TITLE', append_title: true,
            inChatAgents: { regexScriptRefs: [{ agentId: 'removed-agent', scriptId: script.id, revision: getRegexScriptRevision(script) }],
                nativeRegexScripts: [{ agentId: 'removed-agent', script }] },
            inChatAgentCompanionResults: { old: { status: 'done', content: 'ONLY_NOTE evening-bell by {{char}}', includeInChatHistory: true,
                includeAllChatHistory: true, chatHistoryDepth: 1, keepInChatHistoryWhenHostHidden: true } } };
        records.push({ name: 'Ari', is_user: true, mes: 'Next question', extra: {} });
    } });
    await f.run({ generate: paid('main', options => {
        const text = JSON.stringify(options.messages);
        assert.match(text, /ONLY_NOTE\s+by Nova/);
        assert.equal((text.match(/ONLY_NOTE/g) ?? []).length, 1);
        assert.doesNotMatch(text, /SECRET_HIDDEN|evening-bell/);
        assert.match(text, /THE_COMPANION_BELL_LORE/);
        return { text: 'Visible reply' };
    }), generateAgent: () => assert.fail('retained notes paid for a new companion') });
    assert.equal(f.rows()[2].mes, 'SECRET_HIDDEN_MESSAGE');
    assert.equal(f.rows()[2].extra.inChatAgentCompanionResults.old.content, 'ONLY_NOTE evening-bell by {{char}}');
});

test('continuing excludes the current companion note but uses its latest saved history policy', async t => {
    const note = (content, depth) => ({ status: 'done', content, includeInChatHistory: true, includeAllChatHistory: false, chatHistoryDepth: depth });
    const f = prepared(t, [], { effect: 'continue', changeRecords(records) {
        records[2].extra.inChatAgentCompanionResults = { old: note('OLDER_NOTE', 10) };
        records.push({ name: 'Ari', is_user: true, mes: 'Second question', extra: {} },
            { name: 'Nova', is_user: false, mes: 'Second answer', extra: { inChatAgentCompanionResults: { old: note('RECENT_NOTE', 10) } } },
            { name: 'Ari', is_user: true, mes: 'Third question', extra: {} },
            { name: 'Nova', is_user: false, mes: 'Current answer', swipes: ['Current answer', 'Alternative'], swipe_id: 0, swipe_info: [{}, {}],
                extra: { inChatAgentCompanionResults: { old: note('CURRENT_NOTE', 1) } } });
    } });
    await f.run({ generate: paid('main', options => {
        const text = JSON.stringify(options.messages);
        assert.match(text, /RECENT_NOTE/);
        assert.doesNotMatch(text, /OLDER_NOTE|CURRENT_NOTE/);
        return { text: ' continued' };
    }), generateAgent: () => assert.fail('history selection paid for a companion') });
    assert.equal(f.rows().at(-1).mes, 'Current answer continued');
    assert.equal(f.rows().at(-1).swipes[1], 'Alternative');
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults.old.content, 'CURRENT_NOTE');
});

test('auxiliary tracker feedback is bounded to its owner and cannot erase a main inline tracker', async t => {
    const note = companion('side', { trigger: 'manual', feedback: { enabled: true, depth: 1 } });
    note.category = 'tracker';
    note.postProcess = { enabled: true, type: 'extract', extractVariable: 'side', extractPattern: '\\[SIDE\\]([\\s\\S]*?)\\[/SIDE\\]' };
    const f = prepared(t, [note, { id: 'clock', name: 'Clock', enabled: true, category: 'tracker', phase: 'post', prompt: '',
        postProcess: { enabled: true, type: 'extract', extractVariable: 'clock', extractPattern: '\\[CLOCK\\]([\\s\\S]*?)\\[/CLOCK\\]' } }], { changeRecords(records) {
        records[2].extra.inChatAgentCompanionResults = { side: { status: 'done', content: '[SIDE|old]\nplace: garden\n[/SIDE]\n[CLOCK]nine[/CLOCK]', includeInChatHistory: false } };
    } });
    await f.run({ generate: paid('main', options => {
        const text = JSON.stringify(options.messages);
        assert.match(text, /auxiliary notes/);
        assert.match(text, /SIDE/);
        return { text: '[SIDE|new]\nplace: garden\n[/SIDE]\n[CLOCK]ten[/CLOCK]\nStory stays.' };
    }), generateAgent: () => assert.fail('a manual feedback-only companion ran automatically') });
    assert.match(f.rows().at(-1).mes, /\[CLOCK\]ten\[\/CLOCK\]/);
    assert.match(f.rows().at(-1).mes, /Story stays/);
    assert.doesNotMatch(f.rows().at(-1).mes, /\[SIDE|place: garden/);
    assert.equal(f.rows()[0].chat_metadata.agent_clock, '[CLOCK]ten[/CLOCK]');
});

test('hidden automatic companions do not run and a memory shard records its exact source coverage', async t => {
    const shard = companion('memory');
    shard.sourceTemplateId = MEMORY_SHARD_TEMPLATE_ID;
    const f = prepared(t, [companion('hidden'), shard], { global: { hiddenCompanionAgentIds: ['hidden'] } });
    let calls = 0;
    await f.run({ generate: paid('main', 'New answer'), generateAgent: paid('agent', options => {
        calls++;
        assert.match(JSON.stringify(options.messages), /TASK_MEMORY/);
        assert.doesNotMatch(JSON.stringify(options.messages), /TASK_HIDDEN/);
        return { text: 'Saved memory' };
    }) });
    assert.equal(calls, 1);
    const results = f.rows().at(-1).extra.inChatAgentCompanionResults;
    assert.equal(results.hidden, undefined);
    assert.ok(results.memory.contextCoverage.length >= 3);
    assert.ok(results.memory.contextCoverage.every(entry => Number.isSafeInteger(entry.index) && typeof entry.hash === 'number' && entry.length > 0));
});

test('a replaced extra character card is rejected before the main or companion provider is contacted', async t => {
    const note = companion('side');
    note.sourceTemplateId = 'tpl-chatroom-companion'; note.settings = { chatroomExtraCharacterAvatars: ['Kit.png'] };
    const f = prepared(t, [note], { extraCard: true });
    const filename = path.join(f.directories.characters, 'Kit.png');
    fs.writeFileSync(`${filename}.replacement`, fs.readFileSync(filename));
    fs.renameSync(`${filename}.replacement`, filename);
    await assert.rejects(f.run({ generate: () => assert.fail('changed card reached main provider'),
        generateAgent: () => assert.fail('changed card reached companion provider') }), error => error.status === 409);
});

test('a saved length-limited batch failure survives an interruption after another companion result is acknowledged', async t => {
    const a = companion('a', { batch: true, batchAgentIds: ['b'] }), b = companion('b'), c = companion('c');
    const f = prepared(t, [a, b, c], { global: { companionExecutionMode: 'sequential' } });
    let calls = 0, interrupt = true;
    const generate = paid('main', 'Reply');
    const request = paid('agent', options => {
        calls++;
        return JSON.stringify(options.messages).includes('<<<companion:a>>>')
            ? { text: 'Incomplete batch', response: { choices: [{ finish_reason: 'length' }] } } : { text: 'Complete C' };
    });
    const generateAgent = async options => {
        const result = await request(options);
        if (options.stepNamespace.endsWith('companion:c') && interrupt) { interrupt = false; throw new Error('interrupted after acknowledged C'); }
        return result;
    };
    await assert.rejects(f.run({ generate, generateAgent }), /interrupted after acknowledged C/);
    const failed = readArtifact(f.directories, f.jobId, 'roleplay-companion:a');
    assert.equal(failed.record.status, 'error');
    await f.run({ generate: () => assert.fail('saved main repeated'), generateAgent: () => assert.fail('acknowledged companion repeated') });
    assert.equal(calls, 2);
    assert.deepEqual(readArtifact(f.directories, f.jobId, 'roleplay-companion:a'), failed);
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults.c.content, 'Complete C');
});
