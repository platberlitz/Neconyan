/* eslint playwright/expect-expect: off -- Node assertions exercise saved prompt assembly. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';
import { write as writeCard } from '../src/character-card-parser.js';

const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { getJob, releaseJob } = await import('../src/jobs/store.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { injectChatPromptDepth } = await import('../public/scripts/chat-prompt-depth.js');
const { loadCurrentStateSync } = await import('../src/mewmory/sources.js');
const { mutateState } = await import('../src/mewmory/store.js');
const { putRecord, validateRecord } = await import('../src/mewmory/core.js');
const { withRoleplayAccount } = await import('../src/roleplay-store.js');
const { buildRoleplaySavedHistory } = await import('../src/generation/roleplay-prompt.js');
const { saveRoleplayPromptContributions } = await import('../src/generation/roleplay-contributions.js');
const { captureGenerationBinding, resolveGenerationProfile } = await import('../src/generation/profiles.js');
const { runChatProfile } = await import('../src/generation/service.js');
const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');

function promptJob(t, prompts, order, settings = {}, prepare = () => {}, captureBinding = () => ({ profileId: 'saved', fingerprint: 'bound' }), requestFields = {}) {
    const f = fixture(t);
    f.records[1].extra = {};
    prepare(f);
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify(settings));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'prompt-assembly', effect: 'append', source,
        request: { ...requestFields, binding: captureBinding(f.scope.directories), serverPrompt: true, messages: [],
            maxTokens: 20, characterName: 'Nova', worldInfo: captureRoleplayWorldInfo(f.scope, account, source,
                { avatar: 'Nova.png', maxContext: 200 }) } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    const options = {
        contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: { prompts, prompt_order: [{ character_id: 100001,
            order: order.map(identifier => ({ identifier, enabled: true })) }] } }),
    };
    return { f, context, options, run: generate => runRoleplayReplyJob(context, { ...options, generate }) };
}

async function promptFor(t, prompts, order, settings = {}) {
    const job = promptJob(t, prompts, order, settings);
    let result;
    await job.run(async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        result = messages;
        return { text: 'Saved result' };
    });
    return result;
}

const main = { identifier: 'main', role: 'system', system_prompt: true, content: 'Main' };
const history = { identifier: 'chatHistory', marker: true, system_prompt: true };

test('saved custom prompts keep their roles and positions on both sides of history', async t => {
    const messages = await promptFor(t, [main, history,
        { identifier: 'before', role: 'assistant', system_prompt: false, content: 'Before {{char}}' },
        { identifier: 'after', role: 'user', system_prompt: false, content: 'After {{user}}' },
    ], ['before', 'main', 'chatHistory', 'after']);
    assert.deepEqual(messages, [
        { role: 'assistant', content: 'Before Nova' }, { role: 'system', content: 'Main' },
        { role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' },
        { role: 'user', content: 'After User' },
    ]);
});

test('saved depth prompts combine by priority and role before the selected history message', async t => {
    const messages = await promptFor(t, [main, history,
        { identifier: 'near', role: 'system', system_prompt: false, content: 'Near',
            injection_position: 1, injection_depth: 1, injection_order: 10 },
        { identifier: 'far', role: 'system', system_prompt: false, content: 'Far',
            injection_position: 1, injection_depth: 1, injection_order: 100 },
    ], ['main', 'near', 'far', 'chatHistory']);
    assert.deepEqual(messages.map(message => message.content), ['Main', 'Original', 'Near', 'Far', 'Answer']);
});

test('saved Author note is included even when no lore entry targets it', async t => {
    const messages = await promptFor(t, [main, history], ['main', 'chatHistory'], {
        extension_settings: { note: { default: 'Remember the rain', defaultInterval: 1, defaultDepth: 0 } },
    });
    assert.deepEqual(messages.map(message => message.content), ['Main', 'Original', 'Answer', 'Remember the rain']);
});

test('inactive notes stay absent and depth personas use their saved role and depth', async t => {
    const messages = await promptFor(t, [main, history], ['main', 'chatHistory'], {
        extension_settings: { note: { default: 'Inactive note', defaultInterval: 2 } },
        power_user: { persona_description: 'Visiting astronomer', persona_description_position: 4,
            persona_description_depth: 1, persona_description_role: 1 },
    });
    assert.deepEqual(messages, [{ role: 'system', content: 'Main' }, { role: 'user', content: 'Original' },
        { role: 'user', content: 'Visiting astronomer' }, { role: 'assistant', content: 'Answer' }]);
});

test('prompt macros use saved card and variables instead of supplied page values', async t => {
    const job = promptJob(t, [{ ...main, content: '{{description}} / {{getvar::weather}}' }, history], ['main', 'chatHistory'],
        {}, undefined, undefined, { macros: { character: { description: 'Forged' }, variables: { local: { weather: 'forged' } } } });
    await job.run(async ({ messages }) => {
        assert.equal(messages[0].content, 'Original / ');
        return { text: 'Saved result' };
    });
});

test('the fully assembled prompt is durable before dispatch and reused on a preparation retry', async t => {
    const job = promptJob(t, [{ ...main, content: '{{random::one::two::three}}' }, history], ['main', 'chatHistory']);
    let prepared;
    await assert.rejects(job.run(async ({ messages }) => {
        prepared = structuredClone(messages);
        assert.deepEqual(readArtifact(job.context.directories, job.context.job.id, 'roleplay-prompt').messages, prepared);
        throw new Error('Stopped before provider dispatch');
    }), /Stopped before provider dispatch/);
    await job.run(async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.deepEqual(messages, prepared);
        return { text: 'Saved result' };
    });
});

test('damaged prompt evidence refuses instead of rebuilding a possibly dispatched request', async t => {
    const job = promptJob(t, [main, history], ['main', 'chatHistory']);
    await assert.rejects(job.run(async () => { throw new Error('Preparation checkpoint'); }), /Preparation checkpoint/);
    const prepared = readArtifact(job.context.directories, job.context.job.id, 'roleplay-prompt');
    prepared.messages[0].content = 'Changed on disk';
    writeArtifact(job.context.directories, job.context.job.id, 'roleplay-prompt', prepared);
    await assert.rejects(job.run(async () => { assert.fail('Provider must stay idle'); }), { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
});

test('prepared prompt retries retain request-local macro variables for provider formatting', async t => {
    const job = promptJob(t, [{ ...main, content: '{{setvar::weather::rain}}Main' }, history], ['main', 'chatHistory']);
    await assert.rejects(job.run(async ({ macroEnvironment }) => {
        assert.equal(macroEnvironment.evaluate('{{getvar::weather}}', { legacy: true }), 'rain');
        throw new Error('Before provider formatting');
    }), /Before provider formatting/);
    await job.run(async ({ macroEnvironment }) => {
        assert.equal(macroEnvironment.evaluate('{{getvar::weather}}', { legacy: true }), 'rain');
        return { text: 'Saved result' };
    });
});

test('shared depth placement retains Agent inspection data and does not mutate source history', async () => {
    const messages = [{ role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Question' }];
    const result = await injectChatPromptDepth([{ role: 'system', content: 'Agent', injection_depth: 1 }], messages, {
        maxDepth: 1, describePrompt: () => [{ identifier: 'agent', content: 'Agent' }],
        extensionAt: (depth, role) => depth === 1 && role === 'system'
            ? { content: 'Tracker', contributions: [{ identifier: 'tracker', content: 'Tracker' }] } : null,
    });
    assert.deepEqual(result.map(message => message.content), ['Question', 'Agent\nTracker', 'Answer']);
    assert.deepEqual(result[1].agentContributions.map(item => item.identifier), ['agent', 'tracker']);
    assert.equal(result[1].injected, true);
    assert.deepEqual(messages.map(message => message.content), ['Answer', 'Question']);
});

function enableMemory(job) {
    const { f } = job;
    withRoleplayAccount(f.scope, { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch }, () => {
        loadCurrentStateSync(f.scope.directories, f.locator);
        mutateState(f.scope.directories, f.locator, state => {
            state.enabled = true;
            const record = validateRecord(state, { id: 'event:original', kind: 'event', text: 'The Original parcel was blue.',
                refs: [state.timeline[0]], subjectIds: ['parcel'], evidenceStatus: 'established' },
            { asOf: 0, origin: 'objective_extractor' });
            putRecord(state, record, { automatic: true });
        });
    });
}

test('saved Mewmory context is assembled natively and retained outside Prompt Manager markers', async t => {
    const job = promptJob(t, [main, history], ['main', 'chatHistory']);
    enableMemory(job);
    await job.run(async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.match(messages.at(-1).content, /The Original parcel was blue/);
        assert.deepEqual(messages.slice(0, 3).map(message => message.content), ['Main', 'Original', 'Answer']);
        const memory = readArtifact(job.context.directories, job.context.job.id, 'roleplay-mewmory');
        assert.equal(memory.enabled, true);
        assert.equal(memory.inspection.status, 'local');
        return { text: 'Saved result' };
    });
});

test('Mewmory changes during preparation refuse dispatch and retain the earlier prompt evidence', async t => {
    const job = promptJob(t, [main, history], ['main', 'chatHistory']);
    enableMemory(job);
    await assert.rejects(job.run(async ({ beforeDispatch }) => {
        withRoleplayAccount(job.f.scope, { accountId: job.f.scope.accountId, dataEpoch: job.f.scope.dataEpoch }, () => {
            mutateState(job.context.directories, job.f.locator, state => { state.enabled = false; });
        });
        beforeDispatch();
        assert.fail('Provider must stay idle');
    }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.ok(readArtifact(job.context.directories, job.context.job.id, 'roleplay-prompt'));
    await assert.rejects(job.run(async () => assert.fail('Provider must stay idle')), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('enabled Mewmory refuses a disabled history marker instead of discarding retained history', async t => {
    const job = promptJob(t, [main], ['main']);
    enableMemory(job);
    await assert.rejects(job.run(async () => assert.fail('Provider must stay idle')), /Mewmory needs.*Chat History/);
});

test('real browser message metadata preserves prompt text and skips hidden system rows', () => {
    const records = [{ user_name: 'User', character_name: 'Nova', chat_metadata: {} },
        { name: 'User', is_user: true, is_system: false, mes: 'Question', mewmory_id: 'user-1',
            force_avatar: '/thumbnail?type=persona&file=user.png', extra: { isSmallSys: false } },
        { name: 'System', is_user: false, is_system: true, mes: 'Hidden notification', extra: { type: 'generic' } },
        { name: 'Nova', is_user: false, mes: 'Answer', title: '', gen_started: '2026-09-24T01:00:00Z',
            gen_finished: '2026-09-24T01:00:01Z', mewmory_id: 'reply-1', extra: { api: 'custom', model: 'saved',
                reasoning_effort: 'auto', reasoning: '', reasoning_duration: null, reasoning_signature: null,
                inChatAgentPostRuns: ['normal|completed'],
                token_count: 1, reasoning_tokens: 0, time_to_first_token: 0.1 } },
    ];
    assert.deepEqual(buildRoleplaySavedHistory(records), [{ role: 'user', content: 'Question' }, { role: 'assistant', content: 'Answer' }]);
});

test('saved card and persona names replace the unused browser header placeholders', async t => {
    const job = promptJob(t, [{ ...main, content: '{{char}} speaks to {{user}}' }, history], ['main', 'chatHistory'],
        { username: 'Visitor' }, f => { f.records[0].user_name = f.records[0].character_name = 'unused'; });
    await job.run(async ({ messages }) => {
        assert.equal(messages[0].content, 'Nova speaks to Visitor');
        return { text: 'Saved result' };
    });
});

test('unpinned example blocks use only spare context while pinned examples stay mandatory', async t => {
    for (const pinned of [false, true]) {
        const job = promptJob(t, [main, history, { identifier: 'dialogueExamples', marker: true, system_prompt: true }],
            ['main', 'dialogueExamples', 'chatHistory'], { power_user: { pin_examples: pinned } }, f => {
                fs.writeFileSync(path.join(f.scope.directories.characters, 'Nova.png'), writeCard(png, JSON.stringify({
                    name: 'Nova', mes_example: '<START>\nUser: ' + 'Optional example '.repeat(500),
                })));
            });
        job.options.contextLimit = () => 240;
        const run = job.run(async ({ messages }) => {
            assert.equal(pinned, false);
            assert.deepEqual(messages.map(message => message.content), ['Main', 'Original', 'Answer']);
            return { text: 'Saved result' };
        });
        if (pinned) await assert.rejects(run, /prompt exceeds/);
        else await run;
    }
});

test('character prompt overrides can reference the saved original preset prompt', async t => {
    const job = promptJob(t, [main, history], ['main', 'chatHistory'], {}, f => {
        fs.writeFileSync(path.join(f.scope.directories.characters, 'Nova.png'), writeCard(png, JSON.stringify({
            name: 'Nova', system_prompt: '{{original}} / {{char}}',
        })));
    });
    await job.run(async ({ messages }) => {
        assert.equal(messages[0].content, 'Main / Nova');
        return { text: 'Saved result' };
    });
});

test('a partial saved preset retains the inherited prompt order and content-name setting', async t => {
    const job = promptJob(t, [main, history], ['main', 'chatHistory']);
    const material = job.options.promptBackend();
    job.options.promptBackend = () => ({ active: { ...material.active, names_behavior: 2 }, preset: { temp_openai: 0.3 } });
    await job.run(async ({ messages }) => {
        assert.deepEqual(messages.map(message => message.content), ['Main', 'User: Original', 'Nova: Answer']);
        return { text: 'Saved result' };
    });
});

test('prompt transformations feed saved lore selection and retain request-local macro state', async t => {
    const job = promptJob(t, [{ ...main, content: '{{getvar::weather}}' }, history,
        { identifier: 'worldInfoBefore', role: 'system', system_prompt: true, marker: true }],
    ['main', 'worldInfoBefore', 'chatHistory'], {
        extension_settings: { regex: [{ placement: [1], findRegex: 'Original', replaceString: '{{setvar::weather::rain}}Changed',
            promptOnly: true, markdownOnly: false }] },
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }, f => {
        f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
        fs.mkdirSync(f.scope.directories.worlds);
        fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
            1: { uid: 1, key: ['Changed'], keysecondary: [], content: 'Lore after transformation', position: 0,
                order: 100, probability: 100, useProbability: true },
        } }));
    });
    await job.run(async ({ messages }) => {
        assert.deepEqual(messages.map(message => message.content), ['rain', 'Lore after transformation', 'Changed', 'Answer']);
        const prepared = readArtifact(job.context.directories, job.context.job.id, 'roleplay-history-input');
        assert.equal(prepared.content[0], 'Changed');
        assert.equal(prepared.macroState.variables.local.weather, 'rain');
        return { text: 'Saved result' };
    });
    assert.equal(JSON.parse(fs.readFileSync(job.f.filename, 'utf8').split('\n')[1]).mes, 'Original');
});

test('saved HTML and OOC depth rules include captions without rewriting the source messages', async t => {
    const job = promptJob(t, [main, history], ['main', 'chatHistory'], {
        power_user: { html_context_depth: 0, ooc_context_depth: 0 },
    }, f => {
        f.records[1].mes = '<b>Old</b> ((omit this))';
        f.records[1].extra = { append_title: true, title: '<i>A cat</i>' };
        f.records[2].mes = '<b>Current</b> ((keep this))';
    });
    await job.run(async ({ messages }) => {
        assert.deepEqual(messages.map(message => message.content), ['Main', 'Old\n\n A cat', '<b>Current</b> ((keep this))']);
        return { text: 'Saved result' };
    });
});

test('saved contributor results keep extension ordering and literal text in the actual provider request', async t => {
    const prompts = [main, history];
    const order = ['main', 'chatHistory'];
    const settings = { _settingsRevision: 1, username: 'User', main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'gpt-4o' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'gpt-4o',
            openai_max_context: 4096, prompts, function_calling: true, custom_prompt_post_processing: '',
            prompt_order: [{ character_id: 100001, order: order.map(identifier => ({ identifier, enabled: true })) }] },
        power_user: { custom_stopping_strings: '[]' } };
    const job = promptJob(t, prompts, order, settings, () => {},
        directories => captureGenerationBinding(directories, { kind: 'active' }, { settingsRevision: 1 }));
    job.options.promptBackend = resolveGenerationProfile;
    const tools = [{ type: 'function', function: { name: 'lookup', description: 'Read saved evidence.',
        parameters: { type: 'object', properties: {}, additionalProperties: false } } }];
    const values = { extensions: [
        { key: 'z-note', content: 'Later note', position: 1, depth: 0, role: 'system', scan: false },
        { key: 'a-note', content: '{{input}} stays literal', position: 1, depth: 0, role: 'system', scan: false },
    ], history: [{ role: 'assistant', content: '{{input}} is saved model output' }], tools };
    saveRoleplayPromptContributions(job.context, values);
    assert.deepEqual(saveRoleplayPromptContributions(job.context, values), values);
    assert.throws(() => saveRoleplayPromptContributions(job.context, { ...values, history: [] }), { code: 'ROLEPLAY_INVALID' });
    let calls = 0;
    await job.run(options => runChatProfile({ ...options, fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        assert.deepEqual(body.tools, tools);
        assert.equal(body.tool_choice, 'auto');
        assert.deepEqual(body.messages.map(message => message.content), ['Main', 'Original', 'Answer',
            '{{input}} is saved model output', '{{input}} stays literal\nLater note']);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Saved final reply' } }] }));
    } }));
    await job.run(async () => assert.fail('Reopening must not run a provider'));
    assert.equal(calls, 1);
});

test('saved progressive tool results must include the complete linked call group', t => {
    const job = promptJob(t, [main, history], ['main', 'chatHistory']);
    assert.throws(() => saveRoleplayPromptContributions(job.context, { extensions: [], history: [
        { role: 'tool', tool_call_id: 'missing', content: 'Orphaned result' },
    ] }), /matching call/);
    assert.throws(() => saveRoleplayPromptContributions(job.context, { extensions: [], history: [
        { role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
    ] }), /incomplete results/);
    const completedHistory = [{ role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call', content: 'Saved result' }];
    assert.deepEqual(saveRoleplayPromptContributions(job.context, { extensions: [], history: completedHistory }).history, completedHistory);
});

for (const effect of ['swipe', 'replace', 'continue']) test(`saved ${effect} prompts stop at their target while preserving later messages`, async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    f.records.push({ name: 'User', is_user: true, mes: 'Future question', extra: { future_hint: 'keep' } });
    fs.writeFileSync(f.filename, f.records.map(JSON.stringify).join('\n'));
    const source = captureRoleplaySource(f.scope, { locator: f.locator,
        ...(effect === 'replace' ? { range: { start: 1, count: 1 } } : { message: 1 }) });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'target-prompt', effect, source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 20, characterName: 'Nova', worldInfo: captureRoleplayWorldInfo(f.scope, account, source,
                { avatar: 'Nova.png', maxContext: 200, trigger: effect === 'replace' ? 'regenerate' : effect, serverPrompt: true }) } });
    releaseJob(f.scope.directories, jobId);
    await runRoleplayReplyJob({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal }, {
        contextLimit: () => 4096, promptBackend: () => ({ backend: 'chat', active: { prompts: [main, history],
            prompt_order: [{ character_id: 100001, order: ['main', 'chatHistory'].map(identifier => ({ identifier, enabled: true })) }] } }),
        generate: async ({ messages, beforeDispatch }) => {
            beforeDispatch();
            assert.deepEqual(messages.map(message => message.content), effect === 'continue' ? ['Main', 'Original', 'Answer'] : ['Main', 'Original']);
            assert.equal(readRoleplayChat(f.scope, f.locator).records[2].mes, 'Answer');
            const { commitSingleChatWrite } = await import('../src/roleplay-lifecycle.js');
            const { captureRoleplayStorageSource } = await import('../src/generation/roleplay-source.js');
            const { roleplayNativeHost } = await import('../src/endpoints/chats.js');
            if (effect !== 'replace') commitSingleChatWrite(f.scope, { operationKey: 'while-away', sourceKind: 'storage', mode: 'update',
                source: captureRoleplayStorageSource(f.scope, f.locator),
                records: [...readRoleplayChat(f.scope, f.locator).records, { name: 'User', is_user: true, mes: 'While away' }],
                backup: { deferBackup: true } }, roleplayNativeHost);
            return { text: ' replacement' };
        },
    });
    const rows = readRoleplayChat(f.scope, f.locator).records;
    assert.equal(rows[2].mes, effect === 'continue' ? 'Answer replacement' : ' replacement');
    assert.equal(rows[3].mes, 'Future question');
    assert.equal(rows[3].extra.future_hint, 'keep');
    assert.equal(rows.at(-1).mes, effect === 'replace' ? 'Future question' : 'While away');
});

test('saved note and character macros can activate lore and named outlets fill custom chat slots', async t => {
    const job = promptJob(t, [{ ...main, content: '{{outlet::harbour}}' }, history], ['main', 'chatHistory'], {
        extension_settings: { note: { allowWIScan: true, default: '{{char}} remembers the tide', defaultInterval: 1 } },
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }, f => {
        f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
        fs.mkdirSync(f.scope.directories.worlds);
        fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
            1: { uid: 1, key: ['Nova remembers the tide'], keysecondary: [], content: 'The harbour is open', position: 7,
                outletName: 'harbour', order: 100, probability: 100, useProbability: true },
        } }));
    });
    await job.run(async ({ messages }) => {
        assert.equal(messages[0].content, 'The harbour is open');
        assert.ok(messages.some(message => message.content === 'Nova remembers the tide'));
        return { text: 'Saved result' };
    });
});

test('early native macros use saved model limits, formatting, examples and character identity', async t => {
    const job = promptJob(t, [main, history], ['main', 'chatHistory'], {
        power_user: { context: { example_separator: 'Example' } },
        extension_settings: { note: { default: '{{mesExamples}} {{charVersion}}', defaultInterval: 1, defaultPosition: 1, defaultDepth: 0 } },
    }, f => fs.writeFileSync(path.join(f.scope.directories.characters, 'Nova.png'), writeCard(png, JSON.stringify({
        name: 'Nova', character_version: 'saved-version', description: '{{model}} {{maxContext}} {{maxResponse}}', mes_example: '<START>\nNova: Sample',
    }))));
    job.options.promptBackend = () => ({ backend: 'chat', profile: { model: 'saved-model' }, active: {
        prompts: [main, history, { identifier: 'charDescription', marker: true }], prompt_order: [{ character_id: 100001,
            order: ['main', 'charDescription', 'chatHistory'].map(identifier => ({ identifier, enabled: true })) }] } });
    await job.run(async ({ messages }) => {
        const prompt = JSON.stringify(messages);
        assert.match(prompt, /saved-model 4096 20/);
        assert.match(prompt, /Sample/);
        assert.match(prompt, /saved-version/);
        return { text: 'Macro result' };
    });
});

test('saved group append fields and depth notes use each member identity and disabled policy', async t => {
    const f = fixture(t, true);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(JSON.stringify).join('\n'));
    for (const name of ['Nova', 'Other', 'Muted']) fs.writeFileSync(path.join(f.scope.directories.characters, name + '.png'), writeCard(png,
        JSON.stringify({ name, description: '{{char}} description', extensions: { depth_prompt: { prompt: '{{char}} depth', depth: 0, role: 'system' } } })));
    fs.writeFileSync(path.join(f.scope.directories.groups, 'group.json'), JSON.stringify({ id: 'group', members: ['Nova.png', 'Other.png', 'Muted.png'],
        disabled_members: ['Muted.png'], chats: ['Source'], generation_mode: 2, generation_mode_join_prefix: '<FIELDNAME>: ' }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({}));
    const source = f.source();
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 1000, serverPrompt: true });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'group-prompt', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [], maxTokens: 20, characterName: 'Nova', worldInfo: snapshot } });
    releaseJob(f.scope.directories, jobId);
    await runRoleplayReplyJob({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories, owner: f.scope.owner, signal: new AbortController().signal }, {
        contextLimit: () => 4096, promptBackend: () => ({ backend: 'chat', active: {
            prompts: [main, history, { identifier: 'charDescription', marker: true }], prompt_order: [{ character_id: 100001,
                order: ['main', 'charDescription', 'chatHistory'].map(identifier => ({ identifier, enabled: true })) }] } }),
        generate: async ({ messages }) => {
            const prompt = JSON.stringify(messages);
            for (const name of ['Nova', 'Other', 'Muted']) assert.ok(prompt.includes(`Description: ${name} description`), prompt);
            assert.ok(prompt.includes('Other depth'));
            assert.ok(!prompt.includes('Muted depth'));
            return { text: 'Group result' };
        },
    });
});

test('a scanned note is expanded once and the exact saved value reaches the provider', async t => {
    const job = promptJob(t, [main, history], ['main', 'chatHistory'], {
        extension_settings: { note: { allowWIScan: true, default: 'Note {{incvar::note}}', defaultInterval: 1, defaultDepth: 0 } },
    });
    await job.run(async ({ messages }) => {
        const prepared = readArtifact(job.context.directories, job.context.job.id, 'roleplay-history-input');
        assert.equal(prepared.global.inject[0], 'Note 1');
        assert.ok(messages.some(message => message.content === 'Note 1'), JSON.stringify(messages));
        return { text: 'Same note' };
    });
});

test('prompt transformations omit messages whose text and attachments are empty', async t => {
    const messages = await promptFor(t, [main, history], ['main', 'chatHistory'], {
        extension_settings: { regex: [{ scriptName: 'Remove old user text', findRegex: 'Original', replaceString: '', placement: [1],
            disabled: false, promptOnly: true, markdownOnly: false, runOnEdit: false, substituteRegex: 0, trimStrings: [] }] },
    });
    assert.deepEqual(messages.map(message => message.content), ['Main', 'Answer']);
});

test('a saved system prompt can stand alone after every history row is filtered', async t => {
    const messages = await promptFor(t, [main, history], ['main', 'chatHistory'], {
        extension_settings: { regex: [{ scriptName: 'Remove history', findRegex: 'Original|Answer', replaceString: '', placement: [1, 2],
            disabled: false, promptOnly: true, markdownOnly: false, runOnEdit: false, substituteRegex: 0, trimStrings: [] }] },
    });
    assert.deepEqual(messages, [{ role: 'system', content: 'Main' }]);
});

test('a saved reply containing text and tool calls remains pending without provider replay', async t => {
    const prompts = [main, history];
    const order = ['main', 'chatHistory'];
    const settings = { _settingsRevision: 1, username: 'User', main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'gpt-4o' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'gpt-4o',
            openai_max_context: 4096, prompts, function_calling: true, custom_prompt_post_processing: '',
            prompt_order: [{ character_id: 100001, order: order.map(identifier => ({ identifier, enabled: true })) }] },
        power_user: { custom_stopping_strings: '[]' } };
    const job = promptJob(t, prompts, order, settings, () => {},
        directories => captureGenerationBinding(directories, { kind: 'active' }, { settingsRevision: 1 }));
    job.options.promptBackend = resolveGenerationProfile;
    const tools = [{ type: 'function', function: { name: 'lookup', description: 'Read saved evidence.',
        parameters: { type: 'object', properties: {}, additionalProperties: false } } }];
    saveRoleplayPromptContributions(job.context, { extensions: [], history: [], tools });
    let calls = 0;
    await assert.rejects(job.run(options => runChatProfile({ ...options, fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'I will look it up.', tool_calls: [
            { id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ] } }] }));
    } })), { code: 'ROLEPLAY_TOOLS_PENDING' });
    await assert.rejects(job.run(async () => assert.fail('A saved tool decision cannot repeat the provider')), { code: 'ROLEPLAY_TOOLS_PENDING' });
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(job.f.scope, job.f.locator).records.at(-1).mes, 'Answer');
});
