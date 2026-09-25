import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { write: writeCard } = await import('../src/character-card-parser.js');
const { captureRoleplayWorldInfo, assertRoleplayWorldInfoCurrent, prepareRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { saveRoleplayPromptContributions } = await import('../src/generation/roleplay-contributions.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { getJob, releaseJob, jobKey } = await import('../src/jobs/store.js');
const { providerStep, readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const { stageBoundModelToolCalls, admitBoundModelToolCall, readBoundModelToolResult,
    releaseBoundModelToolCall } = await import('../src/generation/roleplay-tool-dispatch.js');
const { runAssistantToolJob } = await import('../src/generation/assistant-tool-jobs.js');
const { runPathfinderNotebookJob } = await import('../src/generation/pathfinder-notebook-jobs.js');
const { validFunctionTools } = await import('../public/scripts/chat-input-capabilities.js');
const { ASSISTANT_TOOL_NAMES, PATHFINDER_TOOL_NAMES } = await import('../src/generation/native-tool-definitions.js');

function prepared(t, { assistant = false, pathfinder = false, sidecarEnabled = true, profile = false } = {}) {
    const f = fixture(t);
    const dirs = f.scope.directories;
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    if (assistant) {
        const card = { name: 'Nova', description: 'Assistant', data: { name: 'Nova', description: 'Assistant',
            extensions: { neconyan_assistant: { id: 'miso-male' } } } };
        fs.writeFileSync(path.join(dirs.characters, 'Nova.png'), writeCard(png, JSON.stringify(card)));
    }
    dirs.worlds = path.join(dirs.root, 'worlds');
    dirs.inChatAgents = path.join(dirs.root, 'InChatAgents');
    fs.mkdirSync(dirs.worlds);
    fs.mkdirSync(dirs.inChatAgents);
    const book = path.join(dirs.worlds, 'Manual.json');
    fs.writeFileSync(book, JSON.stringify({ entries: { 12: { uid: 12, comment: 'Observatory', content: 'A clockwork telescope.', key: ['telescope'] } } }));
    if (pathfinder) fs.writeFileSync(path.join(dirs.inChatAgents, 'pathfinder.json'), JSON.stringify({ id: 'pathfinder', name: 'Pathfinder',
        category: 'tool', enabled: true, settings: { sidecarEnabled, pipelineEnabled: false,
            enabledLorebooks: ['Manual'], includeContextualLorebooks: false } }));
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({ world_info_settings: { world_info: { globalSelect: [] } },
        ...(profile ? { oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1',
            function_calling: true } } : {}),
        extension_settings: { inChatAgents: { globalSettings: { enabled: true, pathfinderEnabled: true } },
            ...(profile ? { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture',
                'api-url': 'http://127.0.0.1:18000/v1' }] } } : {}) } }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const snapshot = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 4000, serverPrompt: true });
    return { f, dirs, book, source, snapshot };
}

test('an assistant card offers exactly the native bound functions without trusting supplied browser tools', t => {
    const f = prepared(t, { assistant: true });
    assert.deepEqual(f.snapshot.tools.assistant, { avatar: 'Nova.png', id: 'miso-male' });
    assert.equal(f.snapshot.tools.pathfinder, null);
    assert.deepEqual(f.snapshot.tools.definitions.map(tool => tool.function.name), ASSISTANT_TOOL_NAMES);
    assert.equal(validFunctionTools(f.snapshot.tools.definitions), true);
    assert.deepEqual(f.snapshot.tools.definitions.find(tool => tool.function.name === 'Neconyan_Assistant_EditAgent')
        .function.parameters.required, ['id', 'field', 'value', 'userConfirmed']);
    assert.doesNotThrow(() => assertRoleplayWorldInfoCurrent(f.f.scope, f.snapshot));
});

test('the selected Pathfinder owner exposes enabled tools and physically binds every accessible manual book', async t => {
    const f = prepared(t, { pathfinder: true });
    assert.equal(f.snapshot.tools.pathfinder.agentId, 'pathfinder');
    assert.deepEqual(f.snapshot.tools.pathfinder.books, ['Manual']);
    assert.deepEqual(f.snapshot.tools.definitions.map(tool => tool.function.name), PATHFINDER_TOOL_NAMES);
    assert.equal(validFunctionTools(f.snapshot.tools.definitions), true);
    assert.equal(f.snapshot.bookHashes.Manual.length, 64);
    assert.equal((await prepareRoleplayWorldInfo(f.f.scope, f.snapshot, { promptChat: ['Original question.'] })).snapshotHash.length, 64);
    const temp = path.join(f.dirs.worlds, 'replacement.json');
    fs.writeFileSync(temp, fs.readFileSync(f.book));
    fs.renameSync(temp, f.book);
    assert.throws(() => assertRoleplayWorldInfoCurrent(f.f.scope, f.snapshot), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('without the Pathfinder sidecar only its summary function is offered, and both owners remain independent', t => {
    const f = prepared(t, { assistant: true, pathfinder: true, sidecarEnabled: false });
    assert.deepEqual(f.snapshot.tools.definitions.map(tool => tool.function.name), [...ASSISTANT_TOOL_NAMES, 'Pathfinder_Summarize']);
    assert.deepEqual(f.snapshot.tools.pathfinder.books, ['Manual']);
    assert.doesNotThrow(() => assertRoleplayWorldInfoCurrent(f.f.scope, f.snapshot));
});

test('a previously accepted prompt keeps its original source and tool definitions after native bindings are introduced', async t => {
    const f = prepared(t, { assistant: true, profile: true });
    const legacy = captureRoleplayWorldInfo(f.f.scope, f.snapshot.account, f.source,
        { avatar: 'Nova.png', maxContext: 4000, serverPrompt: true, nativeBindingVersion: 0 });
    assert.equal(Object.hasOwn(legacy, 'nativeBindingVersion'), false);
    assert.equal(Object.hasOwn(legacy, 'tools'), false);
    assert.doesNotThrow(() => assertRoleplayWorldInfoCurrent(f.f.scope, legacy));
    assert.ok(f.snapshot.nativeBindingVersion === 1 && f.snapshot.tools.definitions.length === 14);
    const request = { binding: { kind: 'profile', ...captureChatProfile(f.dirs, 'main') }, worldInfo: legacy,
        serverPrompt: true, characterName: 'Nova', maxTokens: 32, messages: [] };
    const { jobId } = admitRoleplayJob(f.f.scope, legacy.account,
        { operationKey: 'accepted-before-native-bindings', effect: 'append', source: f.source, request });
    releaseJob(f.dirs, jobId);
    const context = { owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, jobId), signal: new AbortController().signal };
    const savedTools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }];
    saveRoleplayPromptContributions(context, { extensions: [], history: [], tools: savedTools });
    let calls = 0;
    await runRoleplayReplyJob(context, { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: { prompts: [{ identifier: 'main', role: 'system', content: '' },
            { identifier: 'chatHistory', marker: true, system_prompt: true }], prompt_order: [{ character_id: 100001,
            order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }], function_calling: true },
        profile: { model: 'fixture' }, source: 'custom' }),
        generate: async ({ beforeDispatch, functionTools }) => {
            beforeDispatch();
            calls++;
            assert.deepEqual(functionTools, savedTools);
            return { text: 'Existing accepted tools retained.' };
        } });
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(f.f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1).mes,
        'Existing accepted tools retained.');
});

test('the private Roleplay model receives only the definitions frozen under its protected account', async t => {
    const f = prepared(t, { assistant: true, profile: true });
    const binding = { kind: 'profile', ...captureChatProfile(f.dirs, 'main') };
    const request = { binding, worldInfo: f.snapshot, serverPrompt: true, characterName: 'Nova', maxTokens: 32, messages: [] };
    const { jobId } = admitRoleplayJob(f.f.scope, f.snapshot.account, { operationKey: 'bound-native-tools',
        effect: 'append', source: f.source, request });
    releaseJob(f.dirs, jobId);
    let calls = 0;
    await runRoleplayReplyJob({ owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, jobId),
        signal: new AbortController().signal }, { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: { prompts: [{ identifier: 'main', role: 'system', content: 'Hi' },
            { identifier: 'chatHistory', marker: true, system_prompt: true }], prompt_order: [{ character_id: 100001,
            order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }], function_calling: true },
        profile: { model: 'fixture' }, source: 'custom' }),
        generate: async options => {
            calls++;
            assert.deepEqual(options.functionTools, f.snapshot.tools.definitions);
            options.beforeDispatch();
            return { text: 'Bound tools only.' };
        } });
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(f.f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1).mes, 'Bound tools only.');
});

test('a saved model function call admits one native assistant child with its own durable result', async t => {
    const f = prepared(t, { assistant: true, profile: true });
    const request = { binding: { kind: 'profile', ...captureChatProfile(f.dirs, 'main') }, worldInfo: f.snapshot,
        serverPrompt: true, characterName: 'Nova', maxTokens: 32, messages: [] };
    const { jobId } = admitRoleplayJob(f.f.scope, f.snapshot.account, { operationKey: 'native-tool-child',
        effect: 'append', source: f.source, request });
    releaseJob(f.dirs, jobId);
    const context = () => ({ owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, jobId),
        signal: new AbortController().signal });
    const mainStep = roleplayHash(['saved-tool-main', jobId]);
    await assert.rejects(runRoleplayReplyJob(context(), { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: { prompts: [{ identifier: 'main', role: 'system', content: 'Hi' },
            { identifier: 'chatHistory', marker: true, system_prompt: true }], prompt_order: [{ character_id: 100001,
            order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }], function_calling: true },
        profile: { model: 'fixture' }, source: 'custom' }),
        generate: async options => {
            options.onProviderStep(`provider:${mainStep}`);
            return providerStep(options.jobContext, mainStep, async () => {
                options.beforeDispatch();
                return { text: '', response: { choices: [{ message: { tool_calls: [{ id: 'call-1', type: 'function',
                    function: { name: 'Neconyan_Assistant_ListCharacters', arguments: '{}' } }] } }] } };
            });
        } }), { code: 'ROLEPLAY_TOOLS_PENDING' });
    const staged = stageBoundModelToolCalls(context());
    assert.equal(staged.calls.length, 1);
    assert.equal(staged.calls[0].id, 'call-1');
    const first = admitBoundModelToolCall(context(), 0);
    assert.equal(first.created, true);
    const again = admitBoundModelToolCall(context(), 0);
    assert.equal(again.childJobId, first.childJobId);
    assert.equal(readBoundModelToolResult(context(), 0).completed, false);
    assert.equal(releaseBoundModelToolCall(context(), 0).state, 'queued');
    assert.equal(releaseBoundModelToolCall(context(), 0).state, 'queued');
    const child = await runAssistantToolJob({ owner: f.f.scope.owner, directories: f.dirs,
        job: getJob(f.dirs, first.childJobId), signal: new AbortController().signal });
    assert.equal(child.result.result.characters.some(entry => entry.avatar === 'Nova.png'), true);
    assert.equal(fs.readFileSync(f.f.filename, 'utf8').trim().split('\n').length, 3);
    const replay = await runAssistantToolJob({ owner: f.f.scope.owner, directories: f.dirs,
        job: getJob(f.dirs, first.childJobId), signal: new AbortController().signal });
    assert.deepEqual(replay, child);
    assert.deepEqual(readBoundModelToolResult(context(), 0).result, child.result);
    const ledger = path.join(f.dirs.root, 'jobs/index.json');
    const stored = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    delete stored.jobs[jobKey(first.childJobId)];
    fs.writeFileSync(ledger, JSON.stringify(stored));
    assert.deepEqual(readBoundModelToolResult(context(), 0).result, child.result);
    const prompt = readArtifact(f.dirs, jobId, 'roleplay-prompt');
    writeArtifact(f.dirs, jobId, 'roleplay-prompt', { ...prompt, messages: [{ role: 'user', content: 'An unrelated replacement.' }] });
    assert.throws(() => stageBoundModelToolCalls(context()), { code: 'ROLEPLAY_TOOL_RECOVERY' });
    assert.throws(() => readBoundModelToolResult(context(), 0), { code: 'ROLEPLAY_TOOL_RECOVERY' });
    writeArtifact(f.dirs, jobId, 'roleplay-prompt', prompt);
    const pointer = readArtifact(f.dirs, jobId, 'roleplay-native-tool-child:0');
    writeArtifact(f.dirs, jobId, 'roleplay-native-tool-child:0', { ...pointer, childJobId: 'unrelated' });
    assert.throws(() => readBoundModelToolResult(context(), 0), { code: 'ROLEPLAY_TOOL_RECOVERY' });
});

test('a mutating model notebook child retains its exact result after changing the chat and pruning its job', async t => {
    const f = prepared(t, { pathfinder: true, profile: true });
    const request = { binding: { kind: 'profile', ...captureChatProfile(f.dirs, 'main') }, worldInfo: f.snapshot,
        serverPrompt: true, characterName: 'Nova', maxTokens: 32, messages: [] };
    const { jobId } = admitRoleplayJob(f.f.scope, f.snapshot.account, { operationKey: 'native-notebook-child',
        effect: 'append', source: f.source, request });
    releaseJob(f.dirs, jobId);
    const context = () => ({ owner: f.f.scope.owner, directories: f.dirs, job: getJob(f.dirs, jobId),
        signal: new AbortController().signal });
    const mainStep = roleplayHash(['saved-notebook-main', jobId]);
    await assert.rejects(runRoleplayReplyJob(context(), { contextLimit: () => 4096,
        generatePathfinder: async options => {
            options.onProviderStep('provider:pathfinder-notebook-fixture');
            return providerStep(options.jobContext, 'pathfinder-notebook-fixture', async () => {
                options.beforeDispatch();
                return { text: '' };
            });
        },
        promptBackend: () => ({ backend: 'chat', active: { prompts: [{ identifier: 'main', role: 'system', content: 'Hi' },
            { identifier: 'chatHistory', marker: true, system_prompt: true }], prompt_order: [{ character_id: 100001,
            order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }], function_calling: true },
        profile: { model: 'fixture' }, source: 'custom' }),
        generate: async options => {
            options.onProviderStep(`provider:${mainStep}`);
            return providerStep(options.jobContext, mainStep, async () => {
                options.beforeDispatch();
                return { text: '', response: { choices: [{ message: { tool_calls: [{ id: 'call-notebook', type: 'function',
                    function: { name: 'Pathfinder_Notebook', arguments: JSON.stringify({ action: 'write', key: 'clue', content: 'The door is locked.' }) } }] } }] } };
            });
        } }), { code: 'ROLEPLAY_TOOLS_PENDING' });
    const first = admitBoundModelToolCall(context(), 0);
    assert.equal(first.created, true);
    assert.equal(releaseBoundModelToolCall(context(), 0).state, 'queued');
    const child = await runPathfinderNotebookJob({ owner: f.f.scope.owner, directories: f.dirs,
        job: getJob(f.dirs, first.childJobId), signal: new AbortController().signal });
    assert.equal(child.result.result, '📓 Wrote "clue" to notebook.');
    assert.equal(fs.readFileSync(f.f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line))[0]
        .chat_metadata.pathfinder_notebook.entries[0].content, 'The door is locked.');
    const saved = readBoundModelToolResult(context(), 0);
    assert.equal(saved.completed, true);
    assert.deepEqual(saved.result, child.result);
    const ledger = path.join(f.dirs.root, 'jobs/index.json');
    const stored = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    delete stored.jobs[jobKey(first.childJobId)];
    fs.writeFileSync(ledger, JSON.stringify(stored));
    assert.deepEqual(readBoundModelToolResult(context(), 0).result, child.result);
});
