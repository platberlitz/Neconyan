/* eslint playwright/expect-expect: off -- Node assertions exercise protected retrieval and recovery. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { assertRoleplayWorldInfoCurrent, captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { readArtifact, providerStep } = await import('../src/jobs/artifacts.js');
const { getJob, recoverJobs, releaseJob, updateJob } = await import('../src/jobs/store.js');
const { readRoleplayChat } = await import('../src/generation/roleplay-source.js');

const controls = { function_calling: true, prompts: [{ identifier: 'main', role: 'system', system_prompt: true, content: '' },
    { identifier: 'chatHistory', marker: true, system_prompt: true }], prompt_order: [{ character_id: 100001,
    order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }] };

function prepared(t, { pipelineEnabled = true, skipSecondPass = false, connectionProfile = '', entries,
    settings: moreSettings = {} } = {}) {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    f.scope.directories.inChatAgents = path.join(f.scope.directories.root, 'InChatAgents');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.mkdirSync(f.scope.directories.inChatAgents);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Manual.json'), JSON.stringify({ entries: entries ?? {
        12: { uid: 12, comment: 'Location: Observatory', key: ['never-activated'], content: 'The telescope is broken.' },
    } }));
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: { uid: 1, comment: 'Original', key: ['Original'], content: 'Naturally activated town lore.' },
    } }));
    const agentFile = path.join(f.scope.directories.inChatAgents, 'pathfinder.json');
    const agent = { id: 'pathfinder', category: 'tool', name: 'Pathfinder', enabled: true,
        settings: { sidecarEnabled: !pipelineEnabled, pipelineEnabled, skipSecondPass, enabledLorebooks: ['Manual'],
            includeContextualLorebooks: false, connectionProfile, ...moreSettings } };
    fs.writeFileSync(agentFile, JSON.stringify(agent));
    const settingsFile = path.join(f.scope.directories.root, 'settings.json');
    const settings = { world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 200 },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1', function_calling: true },
        extension_settings: {
            inChatAgents: { globalSettings: { enabled: true, pathfinderEnabled: true } },
            connectionManager: { profiles: [
                { id: 'main', name: 'Main', api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:18000/v1' },
                { id: 'aux', name: 'Aux', api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:18000/v1' },
            ] },
        } };
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png',
        maxContext: 4000, serverPrompt: true });
    const binding = { kind: 'profile', ...captureChatProfile(f.scope.directories, 'main') };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'pathfinder-native', effect: 'append', source,
        request: { binding, maxTokens: 32, characterName: 'Nova', worldInfo, serverPrompt: true, messages: [] } });
    releaseJob(f.scope.directories, jobId);
    const context = () => ({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal });
    const run = (generatePathfinder, generate = async ({ beforeDispatch }) => {
        beforeDispatch();
        return { text: 'A safe answer.' };
    }) => runRoleplayReplyJob(context(), { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }),
        generate, generatePathfinder });
    return { f, account, source, worldInfo, binding, jobId, context, run, agent, agentFile, settings, settingsFile };
}

function paidResponse(f, texts, requests) {
    return async ({ messages, binding, beforeDispatch, onProviderStep, jobContext }) => {
        const first = messages[0].content;
        const step = first.includes('relevance filter') ? 'filter' : first.includes('predictive lorebook') ? 'candidate' : 'legacy';
        requests.push({ messages, binding, step });
        onProviderStep(`provider:pathfinder-fixture:${step}`);
        return providerStep(jobContext, `pathfinder-fixture:${step}`, async () => {
            beforeDispatch();
            const text = typeof texts[step] === 'function' ? await texts[step]() : texts[step];
            return { text };
        });
    };
}

test('native two-stage retrieval binds manual lore, uses the explicit profile, and injects only selected text', async t => {
    const f = prepared(t, { connectionProfile: 'aux' });
    const requests = [];
    const name = '["Manual",12] Location: Observatory';
    await f.run(paidResponse(f, { candidate: JSON.stringify({ candidates: [name] }),
        filter: JSON.stringify({ selected: [name] }) }, requests));
    assert.equal(requests.length, 2);
    assert(requests.every(request => request.binding.profileId === 'aux'));
    assert.match(requests[0].messages[1].content, /\["Manual",12\] Location: Observatory/);
    assert.match(requests[1].messages[1].content, /The telescope is broken/);
    const retrieved = readArtifact(f.f.scope.directories, f.jobId, 'roleplay-pathfinder');
    assert.equal(retrieved.mode, 'pipeline');
    assert.deepEqual(retrieved.selected, [['Manual', 12]]);
    assert.match(retrieved.prompt.content, /The telescope is broken/);
    assert.deepEqual(retrieved.stageResults.map(stage => stage.promptId), ['candidate-selector', 'relevance-filter']);
    const prompt = readArtifact(f.f.scope.directories, f.jobId, 'roleplay-prompt');
    assert.equal(prompt.pathfinderHash, retrieved.hash);
    assert.match(JSON.stringify(prompt.messages), /The telescope is broken/);
    assert.equal(readRoleplayChat(f.f.scope, f.f.locator).records.at(-1).mes, 'A safe answer.');
});

test('legacy sidecar stores deterministic book-scoped nodes and selects only the returned waypoint', async t => {
    const f = prepared(t, { pipelineEnabled: false });
    const requests = [];
    const generatePathfinder = async params => {
        const node = params.messages[1].content.match(/node_[a-f0-9]{20}/)?.[0];
        assert(node);
        return paidResponse(f, { legacy: node }, requests)(params);
    };
    await f.run(generatePathfinder);
    const saved = readArtifact(f.f.scope.directories, f.jobId, 'roleplay-pathfinder');
    assert.equal(saved.mode, 'sidecar');
    assert.deepEqual(saved.selected, [['Manual', 12]]);
    assert.equal(requests[0].binding.profileId, 'main');
    assert.match(saved.prompt.content, /The telescope is broken/);
});

test('edited or replaced manual lore and changed selected settings invalidate the accepted source', t => {
    const changed = prepared(t);
    const filename = path.join(changed.f.scope.directories.worlds, 'Manual.json');
    fs.writeFileSync(filename, JSON.stringify({ entries: {} }));
    assert.throws(() => assertRoleplayWorldInfoCurrent(changed.f.scope, changed.worldInfo), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    const replacement = prepared(t);
    const book = path.join(replacement.f.scope.directories.worlds, 'Manual.json');
    fs.renameSync(book, `${book}.old`);
    fs.writeFileSync(book, fs.readFileSync(`${book}.old`));
    assert.throws(() => assertRoleplayWorldInfoCurrent(replacement.f.scope, replacement.worldInfo), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    const settings = prepared(t);
    settings.agent.settings.pipelineId = 'single-pass';
    fs.writeFileSync(settings.agentFile, JSON.stringify(settings.agent));
    assert.throws(() => assertRoleplayWorldInfoCurrent(settings.f.scope, settings.worldInfo), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('a recovered unknown sidecar outcome does not repeat its paid call or reach the main provider', async t => {
    const f = prepared(t, { skipSecondPass: true });
    updateJob(f.f.scope.directories, f.jobId, { state: 'running' });
    let attempts = 0;
    const requests = [];
    const candidate = paidResponse(f, { candidate: () => { attempts++; throw Error('The connection disappeared after dispatch.'); } }, requests);
    await assert.rejects(f.run(candidate, () => { throw Error('Main provider called'); }), /connection disappeared/);
    assert.equal(attempts, 1);
    assert(readArtifact(f.f.scope.directories, f.jobId, 'pathfinder:0:input'));
    assert.equal(readArtifact(f.f.scope.directories, f.jobId, 'provider:pathfinder-fixture:candidate'), undefined);
    const retried = paidResponse(f, { candidate: () => { attempts++; return '{}'; } }, requests);
    await assert.rejects(f.run(retried, () => { throw Error('Main provider called'); }), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    assert.equal(attempts, 1);
    recoverJobs(f.f.scope.directories);
    assert.equal(getJob(f.f.scope.directories, f.jobId).state, 'interrupted');
    await assert.rejects(f.run(() => { throw Error('An unresolved sidecar was invoked.'); },
        () => { throw Error('Main provider called'); }), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    assert.equal(attempts, 1);
});

test('a saved first stage resumes after a known second-stage failure without repeating its paid result', async t => {
    const f = prepared(t);
    const requests = [];
    const name = '["Manual",12] Location: Observatory';
    let candidateCalls = 0;
    let filterCalls = 0;
    const first = paidResponse(f, { candidate: () => { candidateCalls++; return JSON.stringify({ candidates: [name] }); },
        filter: () => { filterCalls++; throw Error('Network disconnected.'); } }, requests);
    await assert.rejects(f.run(first, () => { throw Error('Main provider called'); }), /Network disconnected/);
    assert.equal(candidateCalls, 1);
    assert.equal(filterCalls, 1);
    await assert.rejects(f.run(paidResponse(f, { candidate: () => { candidateCalls++; return '{}'; },
        filter: () => { filterCalls++; return '{}'; } }, requests), () => { throw Error('Main provider called'); }),
    { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    assert.equal(candidateCalls, 1);
    assert.equal(filterCalls, 1);
    assert(readArtifact(f.f.scope.directories, f.jobId, 'provider:pathfinder-fixture:candidate'));
});
