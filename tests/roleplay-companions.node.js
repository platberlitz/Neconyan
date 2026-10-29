import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureCompanionCapacity } = await import('../src/generation/companion-capacity.js');
const { captureRoleplayWorkflowCapacity } = await import('../src/generation/roleplay-workflow-capacity.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { releaseJob, getJob, updateJob } = await import('../src/jobs/store.js');
const { readArtifact, providerStep } = await import('../src/jobs/artifacts.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { runRoleplayCompanions, planRoleplayCompanionStart, pendingRoleplayCompanionCards } = await import('../src/generation/roleplay-companions.js');
const { prepareRoleplayAgentContributions } = await import('../src/generation/roleplay-agent-processing.js');
const { subscribeRoleplayPreview } = await import('../src/generation/roleplay-preview.js');
const { createFreshnessGate } = await import('../src/generation/roleplay-freshness-gate.js');
const { requestRoleplayAgentStop } = await import('../src/generation/roleplay-agent-stop.js');
const { savedRoleplayMacroSnapshot } = await import('../src/generation/roleplay-prompt.js');
const { getRegexScriptRevision } = await import('../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js');
const { MEMORY_SHARD_TEMPLATE_ID } = await import('../public/scripts/extensions/in-chat-agents/companion/companion-shared.js');
const { decodeCompatibleImage, managedImageUrl, publishManagedImage } = await import('../src/managed-image-files.js');
after(cancelAutoSaves);

const controls = { prompts: [{ identifier: 'main', role: 'system', system_prompt: true, content: '' },
    { identifier: 'worldInfoBefore', marker: true, system_prompt: true }, { identifier: 'chatHistory', marker: true, system_prompt: true }],
prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'worldInfoBefore', enabled: true }, { identifier: 'chatHistory', enabled: true }] }] };
const companion = (id, options = {}) => ({ id, name: id.toUpperCase(), enabled: true, category: 'companion', execution: 'companion',
    phase: 'pre', prompt: `TASK_${id.toUpperCase()}`, companion: { includeWorldInfo: false, ...options } });
function prepared(t, agents, { global = {}, profiles = [], effect = 'append', changeRecords, extraCard = false, imagePolicy = false, previewParent = null } = {}) {
    const f = fixture(t), directories = f.scope.directories;
    directories.worlds = path.join(directories.root, 'worlds');
    directories.inChatAgents = path.join(directories.root, 'InChatAgents');
    for (const directory of [directories.worlds, directories.inChatAgents]) fs.mkdirSync(directory, { recursive: true });
    f.records[1].extra = {};
    f.records[2].extra ??= {};
    changeRecords?.(f.records, directories);
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n') + '\n');
    if (extraCard) fs.copyFileSync(path.join(directories.characters, 'Nova.png'), path.join(directories.characters, 'Kit.png'));
    fs.writeFileSync(path.join(directories.worlds, 'Bells.json'), JSON.stringify({ entries: { 1: { uid: 1, key: ['evening-bell'],
        content: 'THE_COMPANION_BELL_LORE', position: 0, order: 100, disable: false } } }));
    const settings = { name1: 'Ari', power_user: { sysprompt: { content: 'Saved system instructions' } },
        world_info_settings: { world_info: { globalSelect: ['Bells'] }, world_info_budget: 200 },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1' },
        extension_settings: { note: { default: 'Saved author note' }, connectionManager: { profiles: [{ id: 'main', name: 'Saved Main',
            api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:18000/v1' }, ...profiles] },
        inChatAgents: { globalSettings: { enabled: true, connectionProfile: 'main', postMainInterceptShowMessageFirst: false, ...global } } } };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
    for (const agent of agents) fs.writeFileSync(path.join(directories.inChatAgents, `${agent.id}.json`), JSON.stringify(agent));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const anchored = ['continue', 'swipe'].includes(effect);
    const source = captureRoleplaySource(f.scope, { locator: f.locator, ...(anchored ? { message: f.records.length - 2 } : {}) });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 4000, serverPrompt: true, ...(imagePolicy ? { mediaPolicyVersion: 1 } : {}), trigger: anchored ? effect : 'normal' });
    const request = { binding: { kind: 'profile', ...captureChatProfile(directories, 'main') }, maxTokens: 32, characterName: 'Nova', worldInfo, serverPrompt: true, messages: [],
        ...(previewParent ? { workflowCandidate: { version: 1, parentJobId: previewParent } } : {}) };
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

test('Companions publish independent progress without letting an observer change paid results', async t => {
    const f = prepared(t, [companion('early'), companion('late')]);
    const progress = [];
    const savedDuringProgress = [];
    let calls = 0;
    const generateAgent = paid('notes', ({ messages }) => {
        calls++;
        return { text: JSON.stringify(messages).includes('TASK_EARLY') ? 'First note' : 'Last note' };
    });
    await f.run({ generateAgent, generate: async options => {
        const main = await paid('main', 'Main reply')(options);
        await runRoleplayCompanions(options.jobContext, { base: f.scope, snapshot: f.worldInfo,
            records: f.records, value: 'Main reply', generationType: 'normal', effect: 'append',
            assistantName: 'Nova', binding: f.request.binding, generate: generateAgent,
            macros: savedRoleplayMacroSnapshot(f.worldInfo, f.records),
            assertCurrent: options.beforeDispatch,
            onProgress(results) {
                progress.push(structuredClone(results));
                savedDuringProgress.push(f.rows().at(-1).mes);
                if (results.early?.status === 'done') results.early.content = 'Observer changed its copy';
                throw new Error('A disconnected observer must not interrupt generation');
            } });
        return main;
    } });
    assert.equal(calls, 2, 'The ordinary completion reuses both acknowledged results');
    assert.ok(savedDuringProgress.every(text => text !== 'Main reply'), 'Progress has not saved the reply early');
    assert.equal(progress[0].early.status, 'pending');
    assert.equal(progress[0].late.status, 'pending');
    assert.ok(progress.some(results => results.early?.content === 'First note' && results.late?.status === 'pending'));
    assert.equal(progress.at(-1).late.content, 'Last note');
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults.early.content, 'First note');
});

test('companion prompts expand the separate saved secrets macro', async t => {
    const f = prepared(t, [
        { ...companion('reader'), prompt: 'READ_SECRETS {{secrets-tracker}}' },
        { id: 'secrets', name: 'Private ledger', enabled: true, phase: 'post', sourceTemplateId: 'tpl-secrets-tracker',
            postProcess: { enabled: true, type: 'extract', extractVariable: 'private', extractPattern: '\\[SECRET\\|[^\\]]*\\]' } },
    ], { changeRecords: records => {
        records[0].chat_metadata = { variables: { agent_private: '[SECRET|Nova|Hidden name|Nobody]', agent_scene: 'UNRELATED_SCENE' } };
    } });
    let calls = 0;
    await f.run({ generate: paid('main', 'Main reply'), generateAgent: paid('secrets', ({ messages }) => {
        calls++;
        const prompt = messages.map(message => message.content).join('\n');
        assert.match(prompt, /<tracker name="Private ledger">\n\[SECRET\|Nova\|Hidden name\|Nobody\]\n<\/tracker>/);
        assert.doesNotMatch(prompt, /\{\{secrets-tracker\}\}|UNRELATED_SCENE/);
        return { text: 'Checked knowledge boundaries' };
    }) });
    assert.equal(calls, 1);
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults.reader.content, 'Checked knowledge boundaries');
});

function continuityPair({ companionEnabled = true } = {}) {
    return [
        { id: 'corrector', name: 'Continuity Corrector', enabled: true, phase: 'post', sourceTemplateId: 'tpl-continuity-corrector',
            prompt: 'FIX_REPLY <notes>{{continuity-notes}}</notes>', postProcess: { enabled: true, promptTransformEnabled: true } },
        { ...companion('audit'), name: 'Continuity Companion', enabled: companionEnabled, sourceTemplateId: 'tpl-continuity-companion',
            prompt: 'AUDIT_REPLY <fixes>{{continuity-corrections}}</fixes>' },
    ];
}

const earlierContinuityNote = records => {
    records[2].extra.inChatAgentCompanionResults = { audit: { status: 'done', content: 'Mara lost her left glove at the gate.' } };
};

test('the Continuity Corrector reads the latest Continuity note and the Companion hears what it fixed', async t => {
    const f = prepared(t, continuityPair(), { changeRecords: earlierContinuityNote });
    let audited = 0;
    await f.run({ generate: paid('main', 'Mara pulls on both gloves. The bell rings.'), generateAgent: paid('agent', ({ messages }) => {
        const prompt = messages.map(message => message.content).join('\n');
        if (prompt.includes('FIX_REPLY')) {
            assert.match(prompt, /<notes>Mara lost her left glove at the gate\.<\/notes>/);
            return { text: 'Mara pulls on her right glove. The bell rings.' };
        }
        audited++;
        assert.match(prompt, /<fixes>- Changed "Mara pulls on both gloves\." to "Mara pulls on her right glove\."<\/fixes>/);
        return { text: 'Fixed: the lost glove.' };
    }) });
    const row = f.rows().at(-1);
    assert.equal(audited, 1);
    assert.equal(row.mes, 'Mara pulls on her right glove. The bell rings.');
    const run = row.extra.inChatAgentPromptRuns.find(entry => entry.agentId === 'corrector');
    assert.deepEqual(run.corrections, [{ before: 'Mara pulls on both gloves.', after: 'Mara pulls on her right glove.' }]);
});

test('a switched-off Continuity Companion gives the Corrector no notes', async t => {
    const f = prepared(t, continuityPair({ companionEnabled: false }), { changeRecords: earlierContinuityNote });
    let corrected = 0;
    await f.run({ generate: paid('main', 'Mara waits.'), generateAgent: paid('agent', ({ messages }) => {
        const prompt = messages.map(message => message.content).join('\n');
        assert.match(prompt, /FIX_REPLY <notes><\/notes>/);
        corrected++;
        return { text: 'Mara waits.' };
    }) });
    assert.equal(corrected, 1);
});

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

test('a completed partial companion batch retries only its missing task, while a lost batch response still saves the reply', async t => {
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
            await run();
            assert.deepEqual(calls, ['batch', 'batch']);
            assert.equal(f.rows().length, f.records.length + 1);
            assert.equal(f.rows().at(-1).mes, 'Main reply');
            assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults?.b, undefined);
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

for (const [placement, stripAll] of [['latest', false], ['source', false], ['block', false], ['block', true]]) {
    test(`retained hidden ${placement} companion notes preserve lore scanning through ${stripAll ? 'whole-note' : 'keyword'} prompt regex`, async t => {
        const script = { id: 'old-script', findRegex: stripAll ? '/[\\s\\S]+/g' : '/evening-bell/g', replaceString: '', placement: [2], promptOnly: true, markdownOnly: false,
            trimStrings: [], disabled: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null };
        const f = prepared(t, [], { changeRecords(records) {
            records[2].is_system = true;
            records[2].mes = 'SECRET_HIDDEN_MESSAGE';
            records[2].extra = { title: 'SECRET_HIDDEN_TITLE', append_title: true,
                inChatAgents: { regexScriptRefs: [{ agentId: 'removed-agent', scriptId: script.id, revision: getRegexScriptRevision(script) }],
                    nativeRegexScripts: [{ agentId: 'removed-agent', script }] },
                inChatAgentCompanionResults: { old: { status: 'done', content: 'ONLY_NOTE evening-bell by {{char}}', includeInChatHistory: true,
                    includeAllChatHistory: true, chatHistoryDepth: 1, keepInChatHistoryWhenHostHidden: true,
                    chatHistoryPlacement: placement, chatHistoryInjection: { position: 1, depth: 0, role: 0, scan: true } } } };
            records.push({ name: 'Ari', is_user: true, mes: 'Next question', extra: {} });
        } });
        await f.run({ generate: paid('main', options => {
            const text = JSON.stringify(options.messages);
            if (stripAll) {
                assert.doesNotMatch(text, /ONLY_NOTE|kept notes/);
            } else {
                assert.match(text, /ONLY_NOTE\s+by Nova/);
                assert.equal((text.match(/ONLY_NOTE/g) ?? []).length, 1);
            }
            assert.doesNotMatch(text, /SECRET_HIDDEN|evening-bell/);
            assert.match(text, /THE_COMPANION_BELL_LORE/);
            return { text: 'Visible reply' };
        }), generateAgent: () => assert.fail('retained notes paid for a new companion') });
        assert.equal(f.rows()[2].mes, 'SECRET_HIDDEN_MESSAGE');
        assert.equal(f.rows()[2].extra.inChatAgentCompanionResults.old.content, 'ONLY_NOTE evening-bell by {{char}}');
    });
}

test('kept notes stay on their own reply or travel as one labelled block when their Companion asks for it', async t => {
    const note = (content, placement, extra = {}) => ({ status: 'done', content, agentName: placement === 'block' ? 'Keeper' : 'Lens',
        includeInChatHistory: true, includeAllChatHistory: true, chatHistoryDepth: 1, chatHistoryPlacement: placement, ...extra });
    const injection = { position: 1, depth: 0, role: 0, scan: false };
    let firstReply = '';
    const f = prepared(t, [], { changeRecords(records) {
        firstReply = records[2].mes;
        records[2].extra.inChatAgentCompanionResults = { lens: note('SOURCE_NOTE_ONE', 'source'), keep: note('BLOCK_NOTE_ONE', 'block', { chatHistoryInjection: injection }) };
        records.push({ name: 'Ari', is_user: true, mes: 'Second question', extra: {} },
            { name: 'Nova', is_user: false, mes: 'Second answer', extra: { inChatAgentCompanionResults: {
                lens: note('SOURCE_NOTE_TWO', 'source'), keep: note('BLOCK_NOTE_TWO', 'block', { chatHistoryInjection: injection }) } } },
            { name: 'Ari', is_user: true, mes: 'Third question', extra: {} });
    } });
    await f.run({ generate: paid('main', options => {
        const contents = options.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
        const first = contents.find(content => content.includes(firstReply));
        const second = contents.find(content => content.includes('Second answer'));
        assert.match(first, /SOURCE_NOTE_ONE/);
        assert.doesNotMatch(first, /SOURCE_NOTE_TWO|BLOCK_NOTE/);
        assert.match(second, /SOURCE_NOTE_TWO/);
        assert.doesNotMatch(second, /SOURCE_NOTE_ONE|BLOCK_NOTE/);
        const block = options.messages.find(message => String(message.content).includes('[Keeper - kept notes]'));
        assert.ok(block, 'the kept notes block reaches the prompt');
        assert.equal(block.role, 'system');
        assert.match(block.content, /BLOCK_NOTE_ONE\s+BLOCK_NOTE_TWO/);
        assert.equal(contents.filter(content => content.includes('BLOCK_NOTE_ONE')).length, 1);
        return { text: 'Visible reply' };
    }), generateAgent: () => assert.fail('kept notes paid for a new companion') });
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

test('a saved length-limited batch failure survives the automatic retry after another companion result is acknowledged', async t => {
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
    await f.run({ generate, generateAgent });
    assert.equal(interrupt, false);
    assert.equal(calls, 2);
    assert.equal(readArtifact(f.directories, f.jobId, 'roleplay-companion:a').record.status, 'error');
    assert.equal(f.rows().at(-1).mes, 'Reply');
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults.c.content, 'Complete C');
});

const trackerCompanion = id => ({ ...companion(id), category: 'tracker',
    prompt: `TASK_${id.toUpperCase()}\n[WORLD|Place]\ndetail: note\n[/WORLD]`,
    postProcess: { enabled: true, type: 'extract', extractPattern: '\\[WORLD\\|[^\\]]*\\][\\s\\S]*?\\[\\/WORLD\\]', extractVariable: `${id}_world` } });
const trackerBlock = '[WORLD|Market]\ndetail: Bells mark closing time.\n[/WORLD]';

test('a compatible image copy survives the companion prompt and its post-processing pass', async t => {
    const originalUrl = `data:image/png;base64,${png.toString('base64')}`;
    const f = prepared(t, [trackerCompanion('world')], { imagePolicy: true, changeRecords(records, directories) {
        directories.userImages = path.join(directories.root, 'user/images');
        fs.mkdirSync(directories.userImages, { recursive: true });
        const image = decodeCompatibleImage(originalUrl);
        publishManagedImage(directories, image);
        records[1].extra.media = [{ type: 'image', url: originalUrl, neconyan_prompt: {
            version: 1, mode: 'include', attachment_hash: roleplayHash(['image', originalUrl]), image_url: managedImageUrl(image),
        } }];
    } });
    let calls = 0;
    await f.run({ promptBackend: () => ({ backend: 'chat', active: { ...controls, media_inlining: true }, profile: { model: 'fixture' }, source: 'custom' }),
        generate: paid('main', 'Main reply'), generateAgent: paid('agent', () => {
            calls++; return { text: trackerBlock };
        }) });
    const result = f.rows().at(-1).extra.inChatAgentCompanionResults.world;
    assert.equal(calls, 1);
    assert.equal(result.status, 'done');
    assert.equal(result.content, trackerBlock);
    assert.equal(f.rows()[1].extra.media[0].url, originalUrl);
});
const trackerRoleplay = 'Mira wandered past the stalls, trailing her fingers over the bolts of silk. "You will not find better '
    + 'cloth this side of the river," the merchant called after her, and she laughed despite herself.';

test('native trackers exhaust unusable replies in saved order before accepting the fourth fallback', async t => {
    const ids = ['limited', 'malformed', 'empty', 'working'];
    const f = prepared(t, [trackerCompanion('world')], {
        global: { companionConnectionFallbacks: ids },
        profiles: ids.map(id => ({ id, name: id, api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:18000/v1' })),
    });
    const calls = [];
    await f.run({ generate: paid('main', 'Main reply'), generateAgent: paid('agent', ({ binding }) => {
        calls.push(binding.profileId);
        if (binding.profileId === 'main') throw new Error('Provider overloaded');
        if (binding.profileId === 'limited') return { text: trackerBlock, finishReason: 'length' };
        if (binding.profileId === 'malformed') return { text: `[WORLD|Market]\n${trackerRoleplay}` };
        return { text: binding.profileId === 'working' ? trackerBlock : '' };
    }) });
    const result = f.rows().at(-1).extra.inChatAgentCompanionResults.world;
    assert.deepEqual(calls, ['main', ...ids]);
    assert.equal(result.status, 'done');
    assert.equal(result.content, trackerBlock);
});

test('native tracker Companions regenerate a reply that carries roleplay', async t => {
    const f = prepared(t, [trackerCompanion('world')]);
    const replies = [`${trackerRoleplay}\n\n${trackerBlock}`, trackerBlock];
    const prompts = [];
    await f.run({ generate: paid('main', 'Main reply'), generateAgent: paid('agent', options => {
        prompts.push(JSON.stringify(options.messages));
        return { text: replies[prompts.length - 1] };
    }) });
    const result = f.rows().at(-1).extra.inChatAgentCompanionResults.world;
    assert.equal(prompts.length, 2);
    assert.equal(result.status, 'done');
    assert.equal(result.content, trackerBlock);
    assert.ok(!prompts[1].includes('Repair mode'));
    assert.ok(result.tokenUsage.outputTokens > 0);
});

test('native tracker Companions repair a broken reply and fail without closing a block around prose', async t => {
    const f = prepared(t, [trackerCompanion('world'), trackerCompanion('lost')]);
    const prompts = [];
    await f.run({ generate: paid('main', 'Main reply'), generateAgent: paid('agent', options => {
        const text = JSON.stringify(options.messages);
        prompts.push(text);
        if (text.includes('TASK_LOST')) return { text: `[WORLD|Market]\n${trackerRoleplay}` };
        return { text: text.includes('Repair mode') ? `Fixed:\n${trackerBlock}` : `[WORLD|Market]\ndetail: Bells\n${trackerRoleplay}` };
    }) });
    const results = f.rows().at(-1).extra.inChatAgentCompanionResults;
    const repairs = prompts.filter(prompt => prompt.includes('Repair mode'));
    assert.equal(prompts.length, 4);
    assert.equal(repairs.length, 2);
    assert.ok(repairs.every(prompt => prompt.includes('Current companion agent note') && prompt.includes('Mira wandered')));
    assert.equal(results.world.status, 'done');
    assert.equal(results.world.content, trackerBlock);
    assert.equal(results.lost.status, 'error');
    assert.match(results.lost.error, /Tracker repair returned invalid output/);
});

for (const accepted of [true, false]) {
    test(`native tracker cleanup ${accepted ? 'repairs' : 'rejects'} a closed but unrenderable Event record`, async t => {
        const template = JSON.parse(fs.readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/event-tracker.json', import.meta.url)));
        const scripts = JSON.parse(fs.readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/regex-bundles.json', import.meta.url)))[template.id];
        const event = '[EVENT|✅ RESOLVED|The war question was answered|Tonight]\ncontext: The answer is the Archon War.\n[/EVENT]';
        const broken = event.replace('|✅ RESOLVED|', '|⚠️ THREAT|✅ RESOLVED|');
        const f = prepared(t, [{ ...template, ...companion('events'), category: 'tracker', prompt: template.prompt, regexScripts: scripts }]);
        const prompts = [];
        await f.run({ generate: paid('main', 'Main reply'), generateAgent: paid('agent', options => {
            prompts.push(JSON.stringify(options.messages));
            return { text: prompts.length === 1 || !accepted ? broken : event };
        }) });
        const result = f.rows().at(-1).extra.inChatAgentCompanionResults.events;
        assert.equal(prompts.length, 2);
        assert.match(prompts[1], /Repair mode/);
        assert.match(prompts[1], /Current companion agent note/);
        if (accepted) assert.equal(result.content, event);
        else {
            assert.equal(result.status, 'error');
            assert.match(result.error, /Tracker repair returned invalid output/);
        }
    });
}

test('versioned show-only broken images survive companion lore recapture without leaking titles', async t => {
    const f = prepared(t, [companion('side', { includeWorldInfo: true, contextMessages: 4 })], { imagePolicy: true, changeRecords(records) {
        records[0].chat_metadata.neconyan_prompt_media = { version: 1, images: 'display-only' };
        records[1].extra.media = [{ type: 'image', url: 'data:image/png;base64,BROKEN', title: 'evening-bell PRIVATE_IMAGE_TITLE', append_title: true }];
    } });
    let calls = 0;
    await f.run({ generate: paid('main', ({ messages }) => {
        assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_IMAGE_TITLE|THE_COMPANION_BELL_LORE|image_url/); return { text: 'Preserved answer' };
    }), generateAgent: paid('agent', ({ messages }) => {
        calls++; const text = JSON.stringify(messages);
        assert.match(text, /Original/); assert.doesNotMatch(text, /PRIVATE_IMAGE_TITLE|THE_COMPANION_BELL_LORE|BROKEN|image_url/);
        return { text: 'Companion note' };
    }) });
    assert.equal(calls, 1);
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults.side.content, 'Companion note');
    assert.match(f.rows()[1].extra.media[0].url, /BROKEN/);
});

function companionPlans() {
    const base = { includeWorldInfo: false, trigger: 'auto', minContextTokens: 0, format: 'text' };
    const agent = (id, companion = {}) => ({
        id, name: id.toUpperCase(), enabled: true, category: 'companion', execution: 'companion', phase: 'pre', prompt: `TASK_${id.toUpperCase()}`,
        companion: { ...base, ...companion },
    });
    return { agent };
}

test('the early Companion plan uses the real eligibility rule and never lists hidden, manual or under-sized work', () => {
    const { agent } = companionPlans();
    const snapshot = { agents: { hiddenIds: ['hidden'] }, mediaPolicy: null };
    const agents = [agent('auto'), agent('hidden'), agent('manual', { trigger: 'manual' }), agent('too-small', { minContextTokens: 100000 }), agent('keyword-off')];
    const plan = planRoleplayCompanionStart({ agents, snapshot, pre: { activeIds: ['auto', 'hidden', 'manual', 'too-small'] },
        records: [], value: 'A short reply', effect: 'append', assistantName: 'Nova' });
    assert.deepEqual(plan.pending.map(item => item.id), ['auto']);
});

test('the finished reply announces Agents and pending Companions before the first post-reply Agent call', { timeout: 20000 }, async t => {
    const parent = 'preview-parent';
    const f = prepared(t, [companion('side'), { id: 'edit', name: 'Edit', enabled: true, phase: 'post', prompt: 'EDIT_REPLY',
        postProcess: { enabled: true, promptTransformEnabled: true } }], { previewParent: parent, global: { companionConcurrentWithPostGen: false } });
    const events = [];
    const unsubscribe = subscribeRoleplayPreview(f.scope.owner, parent, preview => events.push({ kind: 'preview',
        stage: preview.stage, status: preview.inChatAgentCompanionResults?.side?.status, text: preview.text }));
    t.after(unsubscribe);
    let releaseEdit;
    const editHeld = new Promise(resolve => { releaseEdit = resolve; });
    let editEntered;
    const editStarted = new Promise(resolve => { editEntered = resolve; });
    let sideCalls = 0;
    const generateAgent = paid('agent', async options => {
        const text = JSON.stringify(options.messages);
        if (text.includes('EDIT_REPLY')) {
            events.push({ kind: 'call', agent: 'edit' });
            editEntered();
            await editHeld;
            return { text: 'Edited reply' };
        }
        events.push({ kind: 'call', agent: 'side' });
        sideCalls++;
        return { text: 'Side note' };
    });
    const running = f.run({ generate: paid('main', 'Raw reply'), generateAgent,
        freshnessGate: check => createFreshnessGate(() => { events.push({ kind: 'check' }); check(); }) });
    await editStarted;
    const announced = events.findIndex(event => event.kind === 'preview' && event.stage === 'agents' && event.status === 'pending');
    const editCall = events.findIndex(event => event.kind === 'call' && event.agent === 'edit');
    const firstCheck = events.findIndex(event => event.kind === 'check');
    assert.ok(announced >= 0, 'a pending Companion card is published with the finished reply');
    assert.ok(announced < firstCheck, 'the card is visible before the first post-reply freshness check');
    assert.ok(firstCheck < editCall, 'the first Agent call follows its freshness check');
    assert.equal(sideCalls, 0, 'one-at-a-time Companion work waits for the post-reply Agent');
    releaseEdit();
    await running;
    const sideCall = events.findIndex(event => event.kind === 'call' && event.agent === 'side');
    assert.ok(sideCall > editCall, 'the Companion request follows the post-reply Agent');
    assert.equal(f.rows().at(-1).mes, 'Edited reply');
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults.side.content, 'Side note');
});

function directCompanionRun(f, generateAgent, value = 'Main reply') {
    const agentCache = new Map();
    const options = { base: f.scope, snapshot: f.worldInfo, records: f.records, policyRecords: f.records,
        macros: savedRoleplayMacroSnapshot(f.worldInfo, f.records), generationType: 'normal', agentCache, assertCurrent: () => {} };
    prepareRoleplayAgentContributions(f.context(), options);
    return { ...options, value, effect: 'append', assistantName: 'Nova', binding: f.request.binding, generate: generateAgent };
}

test('a Companion without World Info sends before a broken World Info scan and its saved result is reused', async t => {
    const build = () => prepared(t, [companion('fast'), companion('wi', { includeWorldInfo: true })]);
    const fastMessages = [];
    const broken = build();
    fs.rmSync(path.join(broken.directories.worlds, 'Bells.json'));
    const brokenOptions = directCompanionRun(broken, paid('agent', ({ messages }) => {
        const text = JSON.stringify(messages);
        if (text.includes('TASK_FAST')) { fastMessages.push(structuredClone(messages)); return { text: 'Fast note' }; }
        assert.fail('a World Info Companion cannot send after its scan failed');
    }), 'The evening-bell rings.');
    await assert.rejects(runRoleplayCompanions(broken.context(), brokenOptions), error =>
        ['ROLEPLAY_SOURCE_CHANGED', 'ROLEPLAY_SOURCE_DAMAGED'].includes(error.code));
    // The broken scan is deterministic, and the first paid note must replay
    // instead of being bought again on the retry.
    await assert.rejects(runRoleplayCompanions(broken.context(), brokenOptions), error =>
        ['ROLEPLAY_SOURCE_CHANGED', 'ROLEPLAY_SOURCE_DAMAGED'].includes(error.code));
    assert.equal(fastMessages.length, 1, 'the successful Companion provider call happened exactly once');
    assert.doesNotMatch(JSON.stringify(fastMessages[0]), /THE_COMPANION_BELL_LORE/);

    const workingMessages = [];
    const working = build();
    await runRoleplayCompanions(working.context(), directCompanionRun(working, paid('agent', ({ messages }) => {
        const text = JSON.stringify(messages);
        if (text.includes('TASK_FAST')) { workingMessages.push(structuredClone(messages)); return { text: 'Fast note' }; }
        assert.match(text, /THE_COMPANION_BELL_LORE/);
        return { text: 'Lore note' };
    }), 'The evening-bell rings.'));
    assert.deepEqual(fastMessages[0], workingMessages[0], 'the lazily skipped World Info section leaves prompt bytes unchanged');
});

test('a Companion with no output Agents skips the empty postprocessing phase and saves the same note', async t => {
    const f = prepared(t, [companion('side')]);
    await f.run({ generate: paid('main', 'Main reply'), generateAgent: paid('agent', 'Side note') });
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults.side.content, 'Side note');
    assert.equal(readArtifact(f.directories, f.jobId, 'roleplay-agent-post:companion:side'), undefined);
    assert.equal(readArtifact(f.directories, f.jobId, 'roleplay-agent-post:companion:side:plan'), undefined);
});

test('the owner Stop clears pending Companion cards and still saves the reply', { timeout: 20000 }, async t => {
    const parent = 'stop-pending-parent';
    const f = prepared(t, [companion('side')], { previewParent: parent });
    const previews = [];
    const unsubscribe = subscribeRoleplayPreview(f.scope.owner, parent, preview => previews.push({
        stage: preview.stage, results: preview.inChatAgentCompanionResults,
    }));
    t.after(unsubscribe);
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const running = f.run({ generate: paid('main', 'Main reply'), generateAgent: paid('agent', async options => {
        entered();
        await held;
        options.signal.throwIfAborted();
        return { text: 'Must not be kept' };
    }) });
    await started;
    assert.equal(requestRoleplayAgentStop(f.context()), true);
    release();
    await running;
    assert.equal(f.rows().at(-1).mes, 'Main reply');
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults, undefined);
    const lastCards = previews.filter(preview => preview.results !== undefined).at(-1);
    assert.ok(lastCards, 'the run published Companion state');
    assert.ok(Object.values(lastCards.results).every(result => result.status !== 'pending'), 'no stopped Companion keeps a pending card');
});

test('retry-once republishes pending cards without repeating a completed paid Companion call', { timeout: 20000 }, async t => {
    const parent = 'retry-pending-parent';
    const f = prepared(t, [companion('done'), companion('fail')], { previewParent: parent,
        global: { companionExecutionMode: 'sequential' } });
    const previews = [];
    const unsubscribe = subscribeRoleplayPreview(f.scope.owner, parent, preview => {
        if (preview.inChatAgentCompanionResults) previews.push(structuredClone(preview.inChatAgentCompanionResults));
    });
    t.after(unsubscribe);
    let doneCalls = 0, failCalls = 0;
    await f.run({ generate: paid('main', 'Main reply'), generateAgent: paid('agent', ({ messages }) => {
        const text = JSON.stringify(messages);
        if (text.includes('TASK_DONE')) { doneCalls++; return { text: 'Done note' }; }
        failCalls++;
        if (failCalls === 1) throw new Error('transient Companion failure');
        return { text: 'Fail note' };
    }) });
    assert.equal(doneCalls, 1, 'the completed Companion is reused after the retry');
    assert.equal(failCalls, 2, 'only the failed Companion is asked again');
    const republished = previews.findLast(results => results.fail?.status === 'pending');
    assert.ok(republished, 'the retry republishes the unfinished Companion as pending');
    assert.notEqual(republished.done?.status, 'pending', 'a durable completed Companion is not shown as running again');
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults.done.content, 'Done note');
    assert.equal(f.rows().at(-1).extra.inChatAgentCompanionResults.fail.content, 'Fail note');
});

test('pending cards exclude a saved Companion even when it is listed after an unfinished one', () => {
    const pending = [{ id: 'held' }, { id: 'saved' }];
    const cards = pendingRoleplayCompanionCards(pending, agent => agent.id === 'saved');
    assert.deepEqual(cards.map(agent => agent.id), ['held'], 'a durable result listed later is not shown running');
});
