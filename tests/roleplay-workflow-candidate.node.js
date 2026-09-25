import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { write: writeCard } = await import('../src/character-card-parser.js');
const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { captureRoleplayWorkflowCapacity } = await import('../src/generation/roleplay-workflow-capacity.js');
const { admitNativeMediaJob } = await import('../src/generation/media-jobs.js');
const { admitRoleplayJob, readRoleplayJobResult } = await import('../src/roleplay-jobs.js');
const { attachOwnedChild, getJob, releaseJob } = await import('../src/jobs/store.js');
const { providerStep, readArtifact } = await import('../src/jobs/artifacts.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { stageBoundModelToolCalls, admitBoundModelToolCall, releaseBoundModelToolCall,
    readBoundModelToolResult } = await import('../src/generation/roleplay-tool-dispatch.js');

const controls = { prompts: [{ identifier: 'main', role: 'system', content: '', system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true }],
prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true },
    { identifier: 'chatHistory', enabled: true }] }], function_calling: true };

function prepared(t, { assistant = false, attach = true } = {}) {
    const f = fixture(t);
    const dirs = f.scope.directories;
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    if (assistant) {
        const card = { name: 'Nova', data: { name: 'Nova', extensions: { neconyan_assistant: { id: 'miso-male' } } } };
        fs.writeFileSync(path.join(dirs.characters, 'Nova.png'), writeCard(png, JSON.stringify(card)));
    }
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({ world_info_settings: { world_info: { globalSelect: [] } },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1', function_calling: true },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture',
            'api-url': 'http://127.0.0.1:18000/v1' }] } } }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const root = admitNativeMediaJob(f.scope, account, { operationKey: 'workflow-parent', source, kind: 'roleplay-workflow',
        request: { version: 1, avatar: 'Nova.png', capacity: captureRoleplayWorkflowCapacity(f.scope, account, source) },
        target: { kind: 'chat', id: source.instanceId } });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 4000, serverPrompt: true });
    const request = { binding: { kind: 'profile', ...captureChatProfile(dirs, 'main') }, worldInfo,
        serverPrompt: true, characterName: 'Nova', maxTokens: 32, messages: [],
        workflowCandidate: { version: 1, parentJobId: root.jobId, parentIntentHash: roleplayHash(getJob(dirs, root.jobId).intent) } };
    const operationKey = 'workflow-candidate';
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey, effect: 'append', source, request, type: 'roleplay.candidate' });
    if (attach) attachOwnedChild(dirs, root.jobId, jobId, { parentIntentHash: roleplayHash(getJob(dirs, root.jobId).intent),
        childIntentHash: roleplayHash(getJob(dirs, jobId).intent) });
    releaseJob(dirs, jobId);
    return { f, dirs, account, source, request, root, jobId, operationKey,
        context: () => ({ owner: f.scope.owner, directories: dirs, job: getJob(dirs, jobId), signal: new AbortController().signal }),
        run: (result, calls) => runRoleplayReplyJob({ owner: f.scope.owner, directories: dirs,
            job: getJob(dirs, jobId), signal: new AbortController().signal }, { contextLimit: () => 4096,
            promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }),
            generate: async options => {
                calls.count++;
                const step = roleplayHash(['candidate-main', jobId]);
                options.onProviderStep(`provider:${step}`);
                return providerStep(options.jobContext, step, async () => {
                    options.beforeDispatch();
                    return result;
                });
            } }) };
}

test('an attached text candidate saves its paid result without writing a provisional chat reply', async t => {
    const f = prepared(t);
    const calls = { count: 0 };
    const result = await f.run({ text: 'A possible response.' }, calls);
    assert.equal(result.result.kind, 'candidate');
    assert.equal(result.result.turnKind, 'text');
    assert.equal(calls.count, 1);
    assert.equal(fs.readFileSync(f.f.filename, 'utf8').trim().split('\n').length, 3);
    assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-candidate').output.message.mes, 'A possible response.');
    const cached = await f.run({ text: 'Unrelated second result.' }, calls);
    assert.deepEqual(cached, result);
    assert.equal(calls.count, 1);
    assert.deepEqual(readRoleplayJobResult(f.f.scope, f.account, { operationKey: f.operationKey, jobId: f.jobId,
        effect: 'append', source: f.source, request: f.request }), result.result);
    assert.deepEqual(getJob(f.dirs, f.jobId).parentId, f.root.jobId);
});

test('an unattached candidate refuses before an external model can run', async t => {
    const f = prepared(t, { attach: false });
    const calls = { count: 0 };
    await assert.rejects(f.run({ text: 'Never dispatched.' }, calls), { code: 'ROLEPLAY_JOB_REJECTED' });
    assert.equal(calls.count, 0);
    assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-main-provider'), undefined);
});

test('a bound tool-turn candidate admits its actual assistant action without saving an interim chat message', async t => {
    const f = prepared(t, { assistant: true });
    const calls = { count: 0 };
    const result = await f.run({ text: '', response: { choices: [{ message: { tool_calls: [{ id: 'tool-1', type: 'function',
        function: { name: 'Neconyan_Assistant_ListCharacters', arguments: '{}' } }] } }] } }, calls);
    assert.equal(result.result.kind, 'candidate');
    assert.equal(result.result.turnKind, 'tool-turn');
    assert.equal(readArtifact(f.dirs, f.jobId, 'roleplay-candidate').callsHash, readArtifact(f.dirs, f.jobId, 'roleplay-native-tool-calls').hash);
    const child = admitBoundModelToolCall(f.context(), 0);
    assert.equal(stageBoundModelToolCalls(f.context()).calls[0].id, 'tool-1');
    assert.equal(releaseBoundModelToolCall(f.context(), 0).state, 'queued');
    assert.equal(readBoundModelToolResult(f.context(), 0).completed, false);
    assert.equal(calls.count, 1);
    assert.equal(fs.readFileSync(f.f.filename, 'utf8').trim().split('\n').length, 3);
    assert.equal(getJob(f.dirs, child.childJobId).intent.request.callId, 'tool-1');
});
