import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { captureAgentRequest, admitAgentJob, runAgentJob } = await import('../src/generation/agent-jobs.js');
const { captureAgentDraftRequest, admitAgentDraftJob, runAgentDraftJob } = await import('../src/generation/agent-draft-jobs.js');
const { getJob, releaseJob, updateJob, recoverJobs } = await import('../src/jobs/store.js');
const { providerStep, readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { normalizeRegexScript } = await import('../public/scripts/extensions/in-chat-agents/regex-scripts.js');
const { getRegexScriptRevision } = await import('../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js');
const { TRACKER_REPAIR_INSTRUCTION } = await import('../public/scripts/extensions/in-chat-agents/tracker-state.js');
after(cancelAutoSaves);

function prepared(t, agents, configure = () => {}, globalSettings = {}) {
    const f = fixture(t), directories = f.scope.directories;
    directories.inChatAgents = path.join(directories.root, 'InChatAgents');
    directories.worlds = path.join(directories.root, 'worlds');
    fs.mkdirSync(directories.inChatAgents);
    fs.mkdirSync(directories.worlds);
    f.records[1].extra = {};
    f.records[2].extra = {};
    f.records[2].swipe_info = [{ extra: {} }, { extra: { preserved: 'alternative' } }];
    configure(f.records);
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    const settings = { power_user: {}, oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1' },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:18000/v1' }] },
            inChatAgents: { globalSettings: { enabled: true, connectionProfile: 'main', hiddenCompanionAgentIds: ['side'], ...globalSettings } } } };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
    for (const agent of agents) fs.writeFileSync(path.join(directories.inChatAgents, `${agent.id}.json`), JSON.stringify({ name: agent.id, prompt: '', ...agent }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    let sequence = 0;
    function action(mode, agentIds = [], index = 1, companionId = '') {
        const source = captureRoleplaySource(f.scope, { locator: f.locator, message: index });
        const request = captureAgentRequest(f.scope, account, source, { avatar: 'Nova.png', mode, agentIds, companionId });
        const operationKey = `manual-agent-${++sequence}`;
        const { jobId } = admitAgentJob(f.scope, account, { operationKey, source, request });
        releaseJob(directories, jobId);
        updateJob(directories, jobId, { state: 'running' });
        const context = () => ({ directories, owner: f.scope.owner, job: getJob(directories, jobId), signal: new AbortController().signal });
        return { source, request, operationKey, jobId, context, run: options => runAgentJob(context(), options) };
    }
    return { ...f, directories, account, action, saved: () => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

function paid(response) {
    return async options => {
        const step = roleplayHash([options.stepNamespace, options.messages]);
        options.onProviderStep(`provider:${step}`);
        return providerStep(options.jobContext, step, async () => {
            await options.beforeDispatch();
            return typeof response === 'function' ? response(options) : typeof response === 'string' ? { text: response } : response;
        });
    };
}

function draftAction(f, draft = 'Original composer draft') {
    const source = f.source();
    const request = captureAgentDraftRequest(f.scope, f.account, source, { avatar: 'Nova.png', agentId: 'draft', draft, draftId: 'composer', revision: '7' });
    const operationKey = 'composer-draft';
    const { jobId } = admitAgentDraftJob(f.scope, f.account, { operationKey, source, request });
    releaseJob(f.directories, jobId);
    updateJob(f.directories, jobId, { state: 'running' });
    const context = () => ({ directories: f.directories, owner: f.scope.owner, job: getJob(f.directories, jobId), signal: new AbortController().signal });
    return { source, request, operationKey, jobId, context, run: options => runAgentDraftJob(context(), options) };
}

test('a saved composer Agent draft retains its exact input and result without writing a chat message or repeating paid work', async t => {
    const f = prepared(t, [{ id: 'draft', enabled: false, prompt: 'EDIT THIS USER DRAFT',
        regexScripts: [
            { id: 'display', findRegex: 'raw', replaceString: 'visible', markdownOnly: true, placement: [2] },
            { id: 'raw', findRegex: 'visible', replaceString: 'saved', markdownOnly: false, promptOnly: false, placement: [2] },
        ] }]);
    const operation = draftAction(f);
    let calls = 0;
    await assert.rejects(operation.run({ generate: paid(options => {
        calls++;
        assert.match(options.messages.at(-1).content, /Original composer draft/);
        return { text: 'The raw user draft' };
    }), beforePublication: () => { throw new Error('pause before publishing draft'); } }), /pause before publishing draft/);
    assert.deepEqual(f.saved(), f.records);
    const context = operation.context();
    const result = await operation.run({ generate: () => assert.fail('the paid draft is already saved') });
    const record = JSON.parse(fs.readFileSync(path.join(f.directories.root, result.result.url.slice(1)), 'utf8'));
    assert.equal(record.draft, 'The saved user draft');
    assert.equal(record.original, 'Original composer draft');
    assert.equal(record.sourceTextHash, roleplayHash(record.original));
    assert.equal(record.draftId, 'composer');
    assert.equal(record.revision, '7');
    assert.equal(result.result.changed, true);
    assert.deepEqual(f.saved(), f.records);
    fs.rmSync(path.join(f.directories.root, 'jobs', 'index.json'));
    fs.rmSync(path.join(f.directories.root, 'jobs', 'artifacts'), { recursive: true });
    assert.deepEqual(await runAgentDraftJob(context, { generate: () => assert.fail('closed draft ownership survives job pruning') }), result);
    assert.equal(admitAgentDraftJob(f.scope, f.account, { operationKey: operation.operationKey, source: operation.source, request: operation.request }).jobId, operation.jobId);
    assert.equal(calls, 1);
});

test('an unknown composer Agent response remains blocked after restart and never changes saved chat text', async t => {
    const f = prepared(t, [{ id: 'draft', enabled: false, prompt: 'EDIT DRAFT' }]);
    const operation = draftAction(f);
    let calls = 0;
    await assert.rejects(operation.run({ generate: paid(() => { calls++; throw new Error('lost draft response'); }) }), /lost draft response/);
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, operation.jobId).state, 'interrupted');
    await assert.rejects(operation.run({ generate: () => assert.fail('unknown paid draft work cannot repeat') }), { code: 'ROLEPLAY_AGENT_RECOVERY' });
    assert.equal(readArtifact(f.directories, operation.jobId, 'agent-draft-output'), undefined);
    assert.deepEqual(f.saved(), f.records);
    assert.equal(calls, 1);
});

test('composer Agent capture refuses companion selections and empty drafts before acceptance', t => {
    const f = prepared(t, [{ id: 'draft', enabled: false, category: 'companion', prompt: 'COMPANION' }]);
    const source = f.source();
    assert.throws(() => captureAgentDraftRequest(f.scope, f.account, source, { avatar: 'Nova.png', agentId: 'draft', draft: 'Text' }), { code: 'ROLEPLAY_AGENT_DRAFT_INVALID' });
    assert.throws(() => captureAgentDraftRequest(f.scope, f.account, source, { avatar: 'Nova.png', agentId: 'draft', draft: '  ' }), { code: 'ROLEPLAY_AGENT_DRAFT_INVALID' });
});

test('an explicitly selected disabled Agent edits only its saved message and preserves other frozen scripts and swipes', async t => {
    const oldScript = normalizeRegexScript({ id: 'old-script', findRegex: 'past', replaceString: 'present', markdownOnly: true });
    const f = prepared(t, [{ id: 'old', enabled: false }, { id: 'selected', enabled: false, phase: 'pre', prompt: 'FORCED',
        conditions: { generationTypes: ['quiet'], triggerProbability: 0 },
        postProcess: { appendText: 'DO NOT APPEND' },
        regexScripts: [{ id: 'new-script', findRegex: 'new', replaceString: 'NEW', markdownOnly: false, promptOnly: false, placement: [2] }] }], records => {
        records[2].extra = { display_text: 'stale translation', server_narration: { status: 'ready' }, retained: 'yes',
            inChatAgents: { activeAgentIds: ['old'], regexScriptRefs: [{ agentId: 'old', scriptId: oldScript.id, revision: getRegexScriptRevision(oldScript) }], nativeRegexScripts: [{ agentId: 'old', script: oldScript }] } };
    });
    const operation = f.action('run', ['selected']);
    let requests = 0;
    const result = await operation.run({ generate: paid(() => { requests++; return { text: 'A new answer' }; }) });
    const saved = f.saved();
    assert.equal(saved.length, f.records.length);
    assert.equal(saved[2].mes, 'A NEW answer');
    assert.equal(saved[2].swipes[1], 'Other');
    assert.deepEqual(saved[2].swipe_info[1], f.records[2].swipe_info[1]);
    assert.equal(saved[2].extra.retained, 'yes');
    assert.equal(saved[2].extra.display_text, undefined);
    assert.equal(saved[2].extra.server_narration, undefined);
    assert.deepEqual(saved[2].extra.inChatAgents.activeAgentIds, ['old', 'selected']);
    assert.equal(saved[2].extra.inChatAgents.nativeRegexScripts.find(item => item.agentId === 'old').script.replaceString, 'present');
    assert.equal(saved[2].extra.inChatAgentTransformHistory.at(-1).beforeText, 'Answer');
    const context = operation.context();
    fs.rmSync(path.join(f.directories.root, 'jobs', 'index.json'));
    fs.rmSync(path.join(f.directories.root, 'jobs', 'artifacts'), { recursive: true });
    assert.deepEqual(await runAgentJob(context, { generate: () => assert.fail('completed manual Agent work must not repeat') }), result);
    assert.equal(admitAgentJob(f.scope, f.account, { operationKey: operation.operationKey, source: operation.source, request: operation.request }).jobId, operation.jobId);
    assert.equal(requests, 1);
});

test('a manual continuity rewrite scans current lore and retains saved tracker and Author\'s Note context on recovery', async t => {
    const f = prepared(t, [
        { id: 'continuity', enabled: false, phase: 'post', prompt: 'REWRITE<t>{{tracker-state}}</t><l>{{active-lore}}</l><n>{{active-authors-note}}</n>',
            postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64 } },
        { id: 'scene', name: 'Scene Tracker', enabled: true, phase: 'post',
            postProcess: { enabled: true, type: 'extract', extractVariable: 'scene', extractPattern: '\\[SCENE\\][\\s\\S]*?\\[/SCENE\\]' } },
        { id: 'disabled', name: 'Disabled Tracker', enabled: false, phase: 'post',
            postProcess: { enabled: true, type: 'extract', extractVariable: 'disabled', extractPattern: '\\[HIDDEN\\][\\s\\S]*?\\[/HIDDEN\\]' } },
    ], records => {
        records[0].chat_metadata = { note_prompt: '{{char}} limps on her left leg.', note_interval: 1, note_position: 1, note_depth: 4,
            variables: { agent_scene: '[SCENE]Hangar[/SCENE]', agent_disabled: '[HIDDEN]Do not send[/HIDDEN]' } };
        records[1].mes = 'Original secret-signal';
    });
    const settingsPath = path.join(f.directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.world_info_settings = { world_info: { globalSelect: ['Town'] }, world_info_budget: 200 };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    fs.writeFileSync(path.join(f.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: { uid: 1, key: ['secret-signal'], keysecondary: [], content: '{{char}} knows the hangar code.', position: 0 },
        2: { uid: 2, key: ['absent-keyword'], keysecondary: [], content: 'INACTIVE_LORE_MUST_STAY_OUT', position: 0 },
    } }));
    const operation = f.action('run', ['continuity']);
    let calls = 0;
    await assert.rejects(operation.run({ generate: paid(({ messages }) => {
        calls++;
        const instruction = messages[0].content;
        assert.match(instruction, /<t><tracker name="Scene Tracker">\n\[SCENE\]Hangar\[\/SCENE\]\n<\/tracker><\/t>/);
        assert.match(instruction, /<l>[^<]*Nova knows the hangar code\.[^<]*<\/l>/);
        assert.match(instruction, /<n>Nova limps on her left leg\.<\/n>/);
        assert.doesNotMatch(instruction, /INACTIVE_LORE_MUST_STAY_OUT|Disabled Tracker|Do not send|\{\{(?:active-lore|tracker-state|active-authors-note)\}\}/);
        return { text: 'Corrected answer' };
    }), beforeCompletion: () => { throw new Error('pause before publication'); } }), /pause before publication/);
    assert.deepEqual(f.saved(), f.records);
    assert.match(readArtifact(f.directories, operation.jobId, 'roleplay-agent-lore:manual').text, /Nova knows the hangar code\./);
    await operation.run({ generate: () => assert.fail('recovery must reuse the paid correction') });
    assert.equal(f.saved()[2].mes, 'Corrected answer');
    assert.equal(f.saved()[1].mes, 'Original secret-signal');
    assert.equal(calls, 1);
});

test('a secrets-only manual rewrite reads enabled Secrets Tracker copies without unrelated or disabled state', async t => {
    const tracker = { enabled: true, phase: 'post', sourceTemplateId: 'tpl-secrets-tracker',
        postProcess: { enabled: true, type: 'extract', extractVariable: 'private', extractPattern: '\\[SECRET\\|[^\\]]*\\]' } };
    const f = prepared(t, [
        { id: 'guard', enabled: false, prompt: 'REWRITE {{secrets-tracker}}',
            postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMaxTokens: 64 } },
        { ...tracker, id: 'renamed', name: 'Private ledger' },
        { ...tracker, id: 'disabled', enabled: false, postProcess: { ...tracker.postProcess, extractVariable: 'off' } },
        { ...tracker, id: 'scene', sourceTemplateId: 'tpl-scene-tracker', postProcess: { ...tracker.postProcess, extractVariable: 'scene' } },
    ], records => {
        records[0].chat_metadata = { variables: { agent_private: '[SECRET|Nova|Hidden name|Nobody]', agent_off: 'DISABLED_SECRET', agent_scene: 'UNRELATED_SCENE' } };
    });
    let calls = 0;
    await f.action('run', ['guard']).run({ generate: paid(({ messages }) => {
        calls++;
        assert.match(messages[0].content, /<tracker name="Private ledger">\n\[SECRET\|Nova\|Hidden name\|Nobody\]\n<\/tracker>/);
        assert.doesNotMatch(messages[0].content, /DISABLED_SECRET|UNRELATED_SCENE|\{\{secrets-tracker\}\}/);
        return { text: 'Corrected answer' };
    }) });
    assert.equal(calls, 1);
    assert.equal(f.saved()[2].mes, 'Corrected answer');
});

test('manual Agent undo and redo keep the history chain and reconcile tracker state against the actual edited chat', async t => {
    const afterText = 'Changed [SCENE]Garden[/SCENE]';
    const f = prepared(t, [{ id: 'scene', enabled: true, category: 'tracker', phase: 'post', postProcess: { enabled: true, type: 'extract', extractVariable: 'scene', extractPattern: '\\[SCENE\\]([\\s\\S]*?)\\[/SCENE\\]' } }], records => {
        records[0].chat_metadata = { variables: { agent_scene: '[SCENE]Garden[/SCENE]', keep: 'value' }, agent_scene: '[SCENE]Garden[/SCENE]' };
        records[2].mes = afterText;
        records[2].swipes[0] = afterText;
        records[2].extra.inChatAgentTransformHistory = [{ agentId: 'scene', agentName: 'Scene', mode: 'rewrite', beforeText: 'Answer', afterText, timestamp: 1 }];
    });
    await f.action('undo').run({ generate: () => assert.fail('undo is a saved edit') });
    let saved = f.saved();
    assert.equal(saved[2].mes, 'Answer');
    assert.equal(saved[0].chat_metadata.agent_scene, undefined);
    assert.equal(saved[0].chat_metadata.variables.agent_scene, undefined);
    assert.equal(saved[0].chat_metadata.variables.keep, 'value');
    assert.equal(saved[2].extra.inChatAgentTransformHistory.length, 1);
    assert.equal(saved[2].extra.inChatAgentTransformRedo.length, 1);
    await f.action('redo').run({ generate: () => assert.fail('redo is a saved edit') });
    saved = f.saved();
    assert.equal(saved[2].mes, afterText);
    assert.equal(saved[0].chat_metadata.agent_scene, '[SCENE]Garden[/SCENE]');
    assert.equal(saved[2].extra.inChatAgentTransformRedo.length, 0);
    assert.equal(saved[2].swipes[1], 'Other');
});

for (const index of [0, 1]) {
    test(`a manual Companion retry on a ${index ? 'renamed assistant' : 'user'} message preserves its accepted input`, async t => {
        const f = prepared(t, [{ id: 'side', enabled: true, category: 'companion', prompt: 'SIDE {{char}}' }], records => {
            records[2].name = 'Earlier Nova';
            records[index + 1].extra.inChatAgentCompanionResults = { side: { status: 'error', content: '', error: 'Companion returned no output.' } };
        });
        const operation = f.action('companions', ['side'], index);
        const context = operation.context();
        const accepted = structuredClone(context.job.intent);
        let calls = 0;
        const result = await runAgentJob(context, { generate: paid(({ messages }) => {
            calls++;
            assert.match(JSON.stringify(messages), new RegExp(`SIDE ${index ? 'Earlier Nova' : 'User'}`));
            return { text: 'A refreshed note' };
        }) });
        assert.deepEqual(context.job.intent, accepted);
        assert.equal(f.saved()[index + 1].extra.inChatAgentCompanionResults.side.content, 'A refreshed note');
        assert.equal(f.saved()[index + 1].extra.inChatAgentCompanionResults.side.status, 'done');
        assert.deepEqual(await runAgentJob(context, { generate: () => assert.fail('completed retries must not repeat paid work') }), result);
        assert.equal(calls, 1);
    });
}

test('a manually selected hidden companion can repair its note on a user message without paying or erasing other notes', async t => {
    const f = prepared(t, [{ id: 'side', enabled: false, category: 'tracker', execution: 'companion', prompt: 'SIDE TRACKER',
        postProcess: { enabled: true, type: 'extract', extractVariable: 'side', extractPattern: '\\[SIDE\\]([\\s\\S]*?)\\[/SIDE\\]' } }], records => {
        records[1].extra.inChatAgentCompanionResults = { side: { status: 'done', content: '[SIDE]\ndetail\n/SIDE]', collapsed: true }, other: { status: 'done', content: 'Keep this note' } };
    });
    const operation = f.action('repair-companions', ['side'], 0);
    await operation.run({ generate: () => assert.fail('the exact note can be repaired locally') });
    const saved = f.saved();
    assert.equal(saved[1].mes, 'Original');
    assert.equal(saved[1].extra.inChatAgentCompanionResults.side.content, '[SIDE]\ndetail\n[/SIDE]');
    assert.equal(saved[1].extra.inChatAgentCompanionResults.side.collapsed, true);
    assert.equal(saved[1].extra.inChatAgentCompanionResults.other.content, 'Keep this note');
    assert.deepEqual(saved[2], f.records[2]);
});

test('a saved manual Companion run cleans older copies atomically without touching another Companion or chat text', async t => {
    const old = { side: { status: 'done', content: 'Old side note' }, other: { status: 'done', content: 'Keep other' } };
    const f = prepared(t, [{ id: 'side', enabled: true, category: 'companion', prompt: 'SIDE' }], records => {
        records[1].extra.inChatAgentCompanionResults = structuredClone(old);
        records[1].is_user = false;
        records[1].swipe_info = [{ extra: { inChatAgentCompanionResults: structuredClone(old) } }];
    }, { companionAutoCleanupEnabled: true, companionAutoCleanupOlderNotes: 0 });
    const operation = f.action('companions', ['side']);
    await operation.run({ generate: paid('New readable note') });
    const saved = f.saved();
    assert.equal(saved[1].extra.inChatAgentCompanionResults.side, undefined);
    assert.equal(saved[1].swipe_info[0].extra.inChatAgentCompanionResults.side, undefined);
    assert.equal(saved[1].extra.inChatAgentCompanionResults.other.content, 'Keep other');
    assert.equal(saved[2].extra.inChatAgentCompanionResults.side.content, 'New readable note');
    assert.deepEqual(saved.map(record => record.mes), f.records.map(record => record.mes));
    await operation.run({ generate: () => assert.fail('saved cleanup must not rerun paid work') });
    assert.deepEqual(f.saved(), saved);
});

test('manual tracker repair writes a valid selected block while later assistant tracker state remains authoritative', async t => {
    const f = prepared(t, [{ id: 'scene', enabled: true, category: 'tracker', phase: 'post', prompt: 'REPAIR SCENE',
        postProcess: { enabled: true, type: 'extract', extractVariable: 'scene', extractPattern: '\\[SCENE\\]([\\s\\S]*?)\\[/SCENE\\]' } }], records => {
        records.push({ name: 'User', is_user: true, mes: 'Later' }, { name: 'Nova', is_user: false, mes: '[SCENE]Later garden[/SCENE]' });
    });
    let requests = 0;
    await f.action('repair-trackers', ['scene']).run({ generate: paid(options => {
        requests++;
        assert.match(options.messages[0].content, /repair/i);
        return { text: '[SCENE]Earlier courtyard[/SCENE]' };
    }) });
    const saved = f.saved();
    assert.match(saved[2].mes, /Earlier courtyard/);
    assert.match(saved[2].mes, /Answer/);
    assert.equal(saved[0].chat_metadata.agent_scene, '[SCENE]Later garden[/SCENE]');
    assert.deepEqual(saved.slice(3), f.records.slice(3));
    assert.equal(requests, 1);
});

test('repairing selected companion cards does not turn a dependent companion task into a tracker repair', async t => {
    const f = prepared(t, [
        { id: 'side', enabled: false, category: 'tracker', execution: 'companion', prompt: 'SIDE', companion: { batch: true, batchAgentIds: ['second'] }, postProcess: { extractPattern: '\\[SIDE\\]([\\s\\S]*?)\\[/SIDE\\]' } },
        { id: 'second', enabled: false, category: 'tracker', execution: 'companion', prompt: 'SECOND', postProcess: { extractPattern: '\\[SECOND\\]([\\s\\S]*?)\\[/SECOND\\]' } },
        { id: 'dependant', enabled: true, category: 'companion', prompt: 'DEPENDANT', companion: { trigger: 'manual', dependencies: ['side'], waitForDependencies: true } },
    ], records => {
        records[2].extra.inChatAgentCompanionResults = { side: { status: 'done', content: '[SIDE]\nx\n/SIDE]' }, second: { status: 'done', content: '[SECOND]\ny\n/SECOND]' } };
    });
    let requests = 0;
    await f.action('repair-companions', ['side', 'second']).run({ generate: paid(options => {
        requests++;
        const prompt = JSON.stringify(options.messages);
        assert.match(prompt, /DEPENDANT/);
        assert.equal(options.messages.some(message => message.content.includes(TRACKER_REPAIR_INSTRUCTION)), false);
        assert.match(prompt, /Completed companion: side/);
        return { text: 'A normal dependent note' };
    }) });
    const result = f.saved()[2].extra.inChatAgentCompanionResults;
    assert.equal(result.side.content, '[SIDE]\nx\n[/SIDE]');
    assert.equal(result.second.content, '[SECOND]\ny\n[/SECOND]');
    assert.equal(result.dependant.content, 'A normal dependent note');
    assert.equal(requests, 1);
});

const eventTemplate = JSON.parse(fs.readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/event-tracker.json', import.meta.url)));
const eventScripts = JSON.parse(fs.readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/regex-bundles.json', import.meta.url)))[eventTemplate.id];
const fixedEvent = '[EVENT|✅ RESOLVED|The war question was answered|Tonight]\ncontext: The answer is the Archon War.\n[/EVENT]';
const keptEvent = '[EVENT|💬 PROMISE|Defer the remaining questions|Tomorrow]\ncontext: They will talk after resting.\n[/EVENT]';
const brokenEvents = `${fixedEvent.replace('|✅ RESOLVED|', '|⚠️ THREAT|✅ RESOLVED|')}\n\n${keptEvent}`;
const fixedEvents = `${fixedEvent}\n\n${keptEvent}`;

for (const mode of ['repair-trackers', 'repair-companions']) {
    for (const [label, output, accepted] of [['valid', fixedEvents, true], ['unrenderable', brokenEvents, false], ['missing record', fixedEvent, false], ['empty sentinel', 'tracker-none', false]]) {
        test(`${mode} checks every Event Tracker record and preserves the source on ${label} output`, async t => {
            const sidecar = mode === 'repair-companions';
            const agent = { ...eventTemplate, id: 'events', enabled: true, execution: sidecar ? 'companion' : 'inline', regexScripts: eventScripts };
            const original = `Before\n${brokenEvents}\nAfter`;
            const prior = { status: 'done', content: brokenEvents, collapsed: true, updatedAt: 1, tokenUsage: { inputTokens: 12, outputTokens: 4 } };
            const f = prepared(t, [agent], records => {
                records[2].mes = sidecar ? 'Answer' : original;
                records[2].swipes[0] = records[2].mes;
                if (sidecar) records[2].extra.inChatAgentCompanionResults = { events: prior, other: { status: 'done', content: 'Keep other' } };
            });
            let calls = 0;
            await f.action(mode, ['events']).run({ generate: paid(({ messages }) => {
                calls++;
                assert.match(JSON.stringify(messages), /Repair mode/);
                return { text: output };
            }) });
            const result = f.saved()[2];
            assert.equal(calls, 1);
            assert.deepEqual(result.swipe_info[1], f.records[2].swipe_info[1]);
            if (sidecar) {
                assert.equal(result.mes, 'Answer');
                const note = result.extra.inChatAgentCompanionResults.events;
                assert.equal(note.content, accepted ? fixedEvents : brokenEvents);
                assert.equal(note.collapsed, true);
                assert.equal(result.extra.inChatAgentCompanionResults.other.content, 'Keep other');
                if (!accepted) assert.deepEqual(note, { ...prior, lastRunError: 'Tracker repair returned invalid output.', lastRunFailureKind: 'invalid' });
            } else {
                assert.equal(result.mes, accepted ? `Before\n${fixedEvents}\n\n\nAfter` : original);
                if (!accepted) assert.equal(result.extra.inChatAgentTransformHistory, undefined);
            }
            if (accepted) await f.action(mode, ['events']).run({ generate: () => assert.fail('already-renderable records need no model call') });
        });
    }

    test(`${mode} reorders labelled fields locally instead of paying for a rewrite`, async t => {
        const sidecar = mode === 'repair-companions';
        const correct = '[STATE|Nova]\ndate: Tonight\nturn: Keep this fact\n[/STATE]';
        const broken = correct.replace('date: Tonight\nturn: Keep this fact', 'turn: Keep this fact\ndate: Tonight');
        const f = prepared(t, [{ id: 'ordered', enabled: true, category: 'tracker', phase: 'pre', execution: sidecar ? 'companion' : 'inline', prompt: correct,
            postProcess: { enabled: true, type: 'extract', extractVariable: 'ordered', extractPattern: '\\[STATE\\|[^\\]]*\\][\\s\\S]*?\\[/STATE\\]' },
            regexScripts: [{ findRegex: '\\[STATE\\|([^\\]]*)\\]\\ndate: ([^\\n]*)\\nturn: ([^\\n]*)\\n\\[/STATE\\]', replaceString: '<aside>$1 $2 $3</aside>', placement: [2], markdownOnly: true }] }], records => {
            if (sidecar) records[2].extra.inChatAgentCompanionResults = { ordered: { status: 'done', content: broken } };
            else records[2].mes = `Before\n${broken}\nAfter`;
        });
        await f.action(mode, ['ordered']).run({ generate: () => assert.fail('field order can be fixed without a model') });
        const result = f.saved()[2];
        assert.equal(sidecar ? result.extra.inChatAgentCompanionResults.ordered.content : result.mes, sidecar ? correct : `Before\n${correct}\nAfter`);
    });
}

test('a length-limited manual rewrite preserves the original message or note without applying later regex scripts', async t => {
    const f = prepared(t, [{ id: 'edit', enabled: true, prompt: 'EDIT', regexScripts: [{ id: 'replace', findRegex: 'Answer', replaceString: 'WRONG', markdownOnly: false, promptOnly: false, placement: [2] }] }], records => {
        records[2].extra.inChatAgentCompanionResults = { side: { status: 'done', content: 'Answer in a note', updatedAt: 1 } };
    });
    for (const mode of ['run', 'companion-output']) {
        await f.action(mode, ['edit'], 1, mode === 'companion-output' ? 'side' : '').run({ generate: paid({ text: 'Incomplete', response: { choices: [{ finish_reason: 'length' }] } }) });
        const saved = f.saved()[2];
        assert.equal(saved.mes, 'Answer');
        assert.deepEqual(saved.extra.inChatAgentCompanionResults.side, f.records[2].extra.inChatAgentCompanionResults.side);
        assert.equal(saved.extra.inChatAgents, undefined);
        if (mode === 'run') assert.equal(saved.extra.inChatAgentPromptRuns.find(run => run.agentId === 'edit')?.status, 'length-limited');
    }
});

test('a saved manual Agent result resumes its atomic write while an unknown request never repeats', async t => {
    const f = prepared(t, [{ id: 'edit', enabled: true, prompt: 'EDIT' }]);
    const operation = f.action('run', ['edit']);
    let requests = 0;
    await assert.rejects(operation.run({ generate: paid(() => { requests++; return { text: 'Saved edit' }; }), beforeCompletion: () => { throw new Error('stop before chat write'); } }), /stop before chat write/);
    assert.equal(f.saved()[2].mes, 'Answer');
    await operation.run({ generate: () => assert.fail('the saved edit already has a result') });
    assert.equal(f.saved()[2].mes, 'Saved edit');
    assert.equal(requests, 1);

    const second = f.action('run', ['edit']);
    await assert.rejects(second.run({ generate: paid(() => { requests++; throw new Error('lost manual result'); }) }), /lost manual result/);
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, second.jobId).state, 'interrupted');
    await assert.rejects(second.run({ generate: () => assert.fail('unknown manual work must not be resubmitted') }), { code: 'ROLEPLAY_AGENT_RECOVERY' });
    assert.equal(f.saved()[2].mes, 'Saved edit');
    assert.equal(requests, 2);
});

test('damaged manual output cannot change a message or tracker metadata', async t => {
    const f = prepared(t, [{ id: 'edit', enabled: true, prompt: 'EDIT' }]);
    const operation = f.action('run', ['edit']);
    await assert.rejects(operation.run({ generate: paid('Saved edit'), beforeCompletion: () => {
        const saved = readArtifact(f.directories, operation.jobId, 'agent-manual-output');
        writeArtifact(f.directories, operation.jobId, 'agent-manual-output', { ...saved, text: 'Tampered' });
        throw new Error('simulated stop');
    } }), /simulated stop/);
    await assert.rejects(operation.run({ generate: () => assert.fail('damaged proof must not invoke a model') }), { status: 409 });
    assert.equal(f.saved()[2].mes, 'Answer');
    assert.deepEqual(f.saved()[0], f.records[0]);
});
