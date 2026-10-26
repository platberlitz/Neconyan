import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { acceptRoleplayAgentAction } = await import('../src/generation/roleplay-acceptance.js');
const { runAgentJob } = await import('../src/generation/agent-jobs.js');
const { getJob, setJobState } = await import('../src/jobs/store.js');
const { providerStep } = await import('../src/jobs/artifacts.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { getRoleplaySourceMessageRevision } = await import('../public/scripts/neconyan-conversation/roleplay-source.js');
after(cancelAutoSaves);

/** A chat whose Agents have no connection of their own, so they use the active one the browser acknowledged. */
function prepared(t, agents = [{ id: 'edit', enabled: true, phase: 'post', prompt: 'EDIT THIS REPLY' }]) {
    const f = fixture(t);
    const dirs = f.scope.directories;
    dirs.inChatAgents = path.join(dirs.root, 'InChatAgents');
    dirs.worlds = path.join(dirs.root, 'worlds');
    dirs.openAI_Settings = path.join(dirs.root, 'openai-presets');
    for (const directory of [dirs.inChatAgents, dirs.worlds, dirs.openAI_Settings]) fs.mkdirSync(directory);
    f.records[1].extra = {};
    f.records[2].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Main.json'), JSON.stringify({ openai_max_context: 4096 }));
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({
        _settingsRevision: 7,
        power_user: { reply_generation_location: 'server' },
        main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1', openai_max_context: 4096, openai_max_tokens: 512 },
        extension_settings: {
            connectionManager: { profiles: [{ id: 'active', api: 'custom', model: 'fixture', preset: 'Main', 'api-url': 'http://127.0.0.1:18000/v1' }] },
            inChatAgents: { globalSettings: { enabled: true } },
        },
    }));
    for (const agent of agents) fs.writeFileSync(path.join(dirs.inChatAgents, `${agent.id}.json`), JSON.stringify({ name: agent.id, ...agent }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const saved = () => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const request = () => ({ user: { profile: { handle: f.scope.owner }, directories: dirs } });
    const body = ({ key = 'agent-action', mode = 'run', agentIds = ['edit'], messageIndex = 1, ...rest } = {}) => ({
        key, mode, agentIds, source: { locator: f.locator }, messageIndex,
        messageRevision: getRoleplaySourceMessageRevision(saved().slice(1)[messageIndex]),
        account, acknowledgement: { account: f.scope.owner, settingsRevision: 7 }, ...rest,
    });
    return { ...f, dirs, saved, accept: options => acceptRoleplayAgentAction(request(), body(options)) };
}

test('a manual Agent action is accepted as one server job and finishes without the page', async t => {
    const f = prepared(t);
    const accepted = await f.accept();
    assert.equal(accepted.created, true);
    assert.equal(accepted.mode, 'run');
    assert.equal(getJob(f.dirs, accepted.jobId).type, 'roleplay.agent');

    const replay = await f.accept();
    assert.equal(replay.jobId, accepted.jobId);
    assert.equal(replay.created, false);

    setJobState(f.dirs, accepted.jobId, 'running');
    let requests = 0;
    await runAgentJob({ directories: f.dirs, owner: f.scope.owner, job: getJob(f.dirs, accepted.jobId), signal: new AbortController().signal }, {
        generate: async options => {
            requests++;
            const step = roleplayHash([options.stepNamespace, options.messages]);
            options.onProviderStep(`provider:${step}`);
            return providerStep(options.jobContext, step, async () => { await options.beforeDispatch(); return { text: 'Edited on the server' }; });
        },
    });
    assert.equal(requests, 1);
    assert.equal(f.saved()[2].mes, 'Edited on the server');
});

test('a manual Agent action refuses a changed message, unacknowledged settings and an action the server cannot run', async t => {
    const f = prepared(t, [{ id: 'edit', enabled: true, phase: 'post', prompt: 'EDIT' }, { id: 'other', enabled: true, phase: 'post', prompt: 'OTHER' }]);
    await assert.rejects(f.accept({ messageRevision: 'stale' }), { status: 409, apiError: 'roleplay_workflow_changed' });
    await assert.rejects(f.accept({ acknowledgement: { account: f.scope.owner, settingsRevision: 6 } }), { status: 409, apiError: 'roleplay_settings_ack_required' });
    await assert.rejects(f.accept({ agentIds: ['edit', 'other'] }), { status: 409, code: 'ROLEPLAY_AGENT_INVALID' });
    await assert.rejects(f.accept({ mode: 'run', messageIndex: 0 }), { status: 409, code: 'ROLEPLAY_AGENT_INVALID' });
    await assert.rejects(f.accept({ mode: 'unknown' }), { status: 409, code: 'ROLEPLAY_AGENT_INVALID' });
    await assert.rejects(f.accept({ source: { locator: { ...f.locator, group: true } } }), { status: 400 });
    assert.equal(f.saved()[2].mes, 'Answer');
});
