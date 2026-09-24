/* eslint playwright/expect-expect: off -- Node assertions exercise server scans. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';
import { constructScopedTextPrompt, createRawPrompt } from '../public/scripts/generation-format.js';
import { scanWorldInfo } from '../src/generation/world-info-scan.js';
import { assertWorldInfoDepthHistory, buildRoleplaySavedHistory, insertRoleplayChatSystem, insertRoleplayPostHistory, insertWorldInfoAuthorNote, insertWorldInfoDepth, insertWorldInfoExamples, insertWorldInfoOutlets } from '../src/generation/roleplay-prompt.js';
import { write as writeCard } from '../src/character-card-parser.js';

const { captureRoleplayWorldInfo, prepareRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { admitRoleplayJob, applyRoleplayJobEffect } = await import('../src/roleplay-jobs.js');
const { getJob, releaseJob } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { runRoleplayReplyJob: runReply } = await import('../src/generation/roleplay-execution.js');
const { resetRoleplayAccount } = await import('../src/roleplay-store.js');
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');
const { captureGenerationBinding } = await import('../src/generation/profiles.js');
const { runChatProfile } = await import('../src/generation/service.js');

const blankChatControls = { prompts: [{ identifier: 'main', role: 'system', system_prompt: true, content: '' },
    { identifier: 'chatHistory', marker: true, system_prompt: true }], prompt_order: [{ character_id: 100001,
    order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }] };
const runRoleplayReplyJob = (context, options = {}) => runReply(context, {
    contextLimit: () => 4096, promptBackend: () => ({ backend: 'chat', active: blankChatControls }), ...options,
});

const settings = { world_info_depth: 2, world_info_budget: 100, world_info_budget_cap: 0,
    world_info_recursive: true, world_info_min_activations: 0, world_info_case_sensitive: false,
    world_info_match_whole_words: false, world_info_use_group_scoring: false };
const entry = (uid, key, content, more = {}) => ({ world: 'Town', uid, hash: uid, key: [key],
    keysecondary: [], content, position: 0, probability: 100, useProbability: true, order: 10 - uid,
    decorators: [], ...more });
const scan = (entries, overrides = {}) => scanWorldInfo({ entries, chat: ['A cat runs'], metadata: {}, settings,
    maxContext: 100, countTokens: async text => text.length, ...overrides });

test('bound Chat Completion keeps its saved main prompt before protected history', () => {
    const history = [{ role: 'user', content: 'Question' }];
    const snapshot = { systemPrompt: '', global: { characterDescription: 'A harbour', characterPersonality: '',
        scenario: '', personaDescription: '' } };
    const controls = { prompts: [
        { identifier: 'main', role: 'system', system_prompt: true, content: 'Write {{char}} to {{user}}.' },
        { identifier: 'chatHistory', marker: true, system_prompt: true },
    ], prompt_order: [{ character_id: 100001, order: [
        { identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true },
    ] }] };
    assert.deepEqual(insertRoleplayChatSystem(history, snapshot, { backend: 'chat', active: controls }, 'User', 'Nova'), [
        { role: 'system', content: 'Write Nova to User.' }, ...history,
    ]);
    assert.deepEqual(insertRoleplayChatSystem(history, { ...snapshot, systemPrompt: 'Saved rule' },
        { backend: 'chat', active: controls }, 'User', 'Nova')[0], { role: 'system', content: 'Saved rule' });
    assert.throws(() => insertRoleplayChatSystem(history, snapshot, { backend: 'chat', active: {
        ...controls, prompt_order: [{ character_id: 100001, order: [
            { identifier: 'main', enabled: true }, { identifier: 'unknown', enabled: true },
            { identifier: 'chatHistory', enabled: true },
        ] }],
    } }, 'User', 'Nova'), { code: 'ROLEPLAY_INVALID' });
});

test('a server-owned reply sends the saved main prompt before protected history', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'bound-main', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 20, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    const controls = { ...blankChatControls, prompts: [{ ...blankChatControls.prompts[0],
        content: 'Write {{char}} to {{user}}.' }, blankChatControls.prompts[1]] };
    await runRoleplayReplyJob({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal }, { promptBackend: () => ({ backend: 'chat', active: controls }),
        generate: async ({ messages, beforeDispatch }) => {
            beforeDispatch();
            assert.deepEqual(messages.map(message => message.content), ['Write Nova to User.', 'Original', 'Answer']);
            return { text: 'Bound answer' };
        } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Bound answer');
});

test('saved post-history instructions follow the selected provider and continuation position', () => {
    const messages = [{ role: 'system', content: 'Story' }, { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Partial' }];
    const saved = { character: 'Character instruction', text: 'Global instruction', textEnabled: true };
    assert.deepEqual(insertRoleplayPostHistory(messages, saved, 'text', 'append').map(message => message.content),
        ['Story', 'Question', 'Partial', 'Character instruction']);
    assert.deepEqual(insertRoleplayPostHistory(messages, saved, 'text', 'continue').map(message => message.content),
        ['Story', 'Question', 'Character instruction', 'Partial']);
    assert.deepEqual(insertRoleplayPostHistory(messages, { ...saved, character: '' }, 'kobold', 'append').at(-1),
        { role: 'user', content: 'Global instruction' });
    assert.equal(insertRoleplayPostHistory(messages, { ...saved, textEnabled: false }, 'text', 'append'), messages);
    const controls = { prompt_order: [{ character_id: 100001, order: [
        { identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: true },
    ] }], prompts: [{ identifier: 'jailbreak', role: 'system', system_prompt: true, content: '' }] };
    assert.deepEqual(insertRoleplayPostHistory(messages, saved, 'chat', 'append', { preset: controls }).at(-1),
        { role: 'system', content: 'Character instruction' });
    assert.throws(() => insertRoleplayPostHistory(messages, { ...saved, character: '{{unsafe}}' }, 'chat', 'append',
        { preset: controls }), { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => insertRoleplayPostHistory(messages, saved, 'chat', 'append', { preset: {
        ...controls, prompts: [{ identifier: 'jailbreak', role: 'user' }],
    } }), { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => insertRoleplayPostHistory(messages, saved, 'chat', 'append', { preset: {
        ...controls, prompt_order: [{ character_id: 100001, order: [
            { identifier: 'chatHistory', enabled: false }, { identifier: 'jailbreak', enabled: true },
        ] }],
    } }), { code: 'ROLEPLAY_INVALID' });
    assert.equal(insertRoleplayPostHistory(messages, saved, 'chat', 'append', { preset: {
        ...controls, prompt_order: [{ character_id: 100001, order: [
            { identifier: 'chatHistory', enabled: true }, { identifier: 'jailbreak', enabled: false },
        ] }],
    } }), messages);
    assert.throws(() => insertRoleplayPostHistory(messages, saved, 'chat', 'append', { preset: {
        ...controls, prompt_order: [{ character_id: 100001, order: [
            { identifier: 'jailbreak', enabled: true }, { identifier: 'chatHistory', enabled: true },
        ] }],
    } }), { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => insertRoleplayPostHistory(messages, saved, 'chat', 'append'), { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => insertRoleplayPostHistory(messages, { ...saved, character: '{{unsafe}}' }, 'text', 'append'),
        { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => insertRoleplayPostHistory([{ role: 'assistant', content: 'Partial' },
        { role: 'system', content: 'Depth lore' }], saved, 'text', 'continue'), { code: 'ROLEPLAY_INVALID' });
    assert.deepEqual(messages.map(message => message.content), ['Story', 'Question', 'Partial']);
});

test('group history keeps the selected Chat Completion speaker naming policy', () => {
    const records = [{ user_name: 'User', character_name: 'Nova', chat_metadata: {} },
        { name: 'User', is_user: true, mes: 'Question' },
        { name: 'Nova', is_user: false, mes: 'Answer' }];
    const base = { group: true, userName: 'User', characterName: 'Nova' };
    assert.deepEqual(buildRoleplaySavedHistory(records, { ...base, namesBehavior: 0 }).map(message => message.content),
        ['Question', 'Nova: Answer']);
    assert.deepEqual(buildRoleplaySavedHistory(records, { ...base, namesBehavior: -1 }).map(message => message.content),
        ['Question', 'Answer']);
    assert.deepEqual(buildRoleplaySavedHistory(records, { ...base, namesBehavior: 2 }).map(message => message.content),
        ['User: Question', 'Nova: Answer']);
    records[0].user_name = 'Visitor';
    records[1].name = 'Visitor';
    assert.deepEqual(buildRoleplaySavedHistory(records, { group: true, characterName: 'Nova', namesBehavior: 0 })
        .map(message => message.content), ['Question', 'Nova: Answer']);
    assert.deepEqual(buildRoleplaySavedHistory(records, { ...base, namesBehavior: 1 }), [
        { role: 'user', content: 'Question', name: 'Visitor' },
        { role: 'assistant', content: 'Answer', name: 'Nova' },
    ]);
    records[1].name = 'Visitor, guest';
    assert.equal(buildRoleplaySavedHistory(records, { ...base, namesBehavior: 1 })[0].name, 'Visitor__guest');
    assert.deepEqual(buildRoleplaySavedHistory(records, { ...base, namesBehavior: 'provider' }), [
        { role: 'user', content: 'Question', name: 'Visitor, guest' },
        { role: 'assistant', content: 'Answer', name: 'Nova' },
    ]);
    records[1].name = 'User';
    assert.throws(() => buildRoleplaySavedHistory(records, base), { code: 'ROLEPLAY_INVALID' });
});

test('saved group names reach the native text and legacy prompt formatters exactly once', () => {
    const records = [{ user_name: 'Visitor', chat_metadata: {} },
        { name: 'Visitor', is_user: true, mes: 'Question' },
        { name: 'Nova', is_user: false, mes: 'Answer' }];
    const messages = buildRoleplaySavedHistory(records, { group: true, namesBehavior: 'provider' });
    const options = { name1: 'Visitor', name2: 'Nova', selectedGroup: true };
    assert.equal(createRawPrompt(structuredClone(messages), 'kobold', false, false, '', '', options),
        'Visitor: Question\nNova: Answer\n');
    const instruct = { enabled: true, names_behavior: 'always', input_sequence: '<user>', output_sequence: '<assistant>',
        input_suffix: '\n', output_suffix: '\n' };
    assert.match(constructScopedTextPrompt([...structuredClone(messages), { role: 'user', content: 'Next', name: 'Visitor' }],
        instruct, options), /Nova: Answer/);
});

test('a server-owned group reply uses its saved Chat Completion naming controls', async t => {
    const f = fixture(t, true);
    f.records[0].user_name = 'Visitor';
    f.records[1].name = 'Visitor';
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        power_user: { context: { story_string: 'Story: {{description}}', story_string_position: 0 } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const snapshot = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'group-speaker-policy', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 20, characterName: 'Nova', worldInfo: snapshot } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await runRoleplayReplyJob(context, { promptBackend: () => ({ backend: 'chat', preset: { names_behavior: 0 } }),
        generate: async ({ messages, userName, beforeDispatch }) => {
            beforeDispatch();
            assert.equal(userName, 'Visitor');
            assert.deepEqual(messages.map(message => message.content), ['Story: Original', 'Original', 'Nova: Answer']);
            return { text: 'Group answer' };
        } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Group answer');
});

test('a server-owned group reply sends saved speaker names as provider fields', async t => {
    const f = fixture(t, true);
    f.records[0].user_name = 'Visitor';
    f.records[1].name = 'Visitor';
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ power_user: {
        context: { story_string: 'Story: {{description}}', story_string_position: 0 },
    } }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const snapshot = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'group-name-field', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 20, characterName: 'Nova', worldInfo: snapshot } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await runRoleplayReplyJob(context, { promptBackend: () => ({ backend: 'chat', preset: { names_behavior: 1 } }),
        generate: async ({ messages, beforeDispatch }) => {
            beforeDispatch();
            assert.deepEqual(messages, [
                { role: 'system', content: 'Story: Original' },
                { role: 'user', content: 'Original', name: 'Visitor' },
                { role: 'assistant', content: 'Answer', name: 'Nova' },
            ]);
            return { text: 'Group answer' };
        } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Group answer');
});

test('a server-owned legacy group reply leaves speaker formatting to the bound provider', async t => {
    const f = fixture(t, true);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ power_user: {
        context: { story_string: 'Story: {{description}}', story_string_position: 0 },
    } }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const snapshot = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'group-provider-format', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 20, characterName: 'Nova', worldInfo: snapshot } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await runRoleplayReplyJob(context, { promptBackend: () => ({ backend: 'kobold' }),
        generate: async ({ messages, beforeDispatch }) => {
            beforeDispatch();
            assert.deepEqual(messages, [
                { role: 'system', content: 'Story: Original' },
                { role: 'user', content: 'Original', name: 'User' },
                { role: 'assistant', content: 'Answer', name: 'Nova' },
            ]);
            return { text: 'Group answer' };
        } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Group answer');
});

test('server-owned replies place saved post-history instructions according to the selected provider', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    const settingsFile = path.join(f.scope.directories.root, 'settings.json');
    const save = () => fs.writeFileSync(settingsFile, JSON.stringify({ power_user: {
        prefer_character_jailbreak: true, sysprompt: { enabled: true, post_history: 'Global instruction' },
        context: { story_string: 'Character: {{description}}', story_string_position: 0 },
    } }));
    save();
    const cardPath = path.join(f.scope.directories.characters, 'Nova.png');
    fs.writeFileSync(cardPath, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Original',
        data: { name: 'Nova', description: 'Original', post_history_instructions: 'Character instruction' } })));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const snapshot = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    assert.deepEqual(snapshot.postHistory, { character: 'Character instruction', textEnabled: true, text: 'Global instruction' });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true,
        messages: [], maxTokens: 20, characterName: 'Nova', worldInfo: snapshot };
    const context = (key, input, acceptedSource = source) => {
        const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: key, effect: 'append', source: acceptedSource, request: input });
        releaseJob(f.scope.directories, jobId);
        return { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
            owner: f.scope.owner, signal: new AbortController().signal };
    };
    const text = context('text-post-history', request);
    await runRoleplayReplyJob(text, { promptBackend: () => ({ backend: 'text' }), generate: async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.deepEqual(messages.map(message => message.content), [
            'Character: Original', 'Original', 'Answer', 'Character instruction',
        ]);
        return { text: 'Following instruction' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Following instruction');

    const updatedSource = captureRoleplaySource(f.scope, { locator: f.locator });
    const chatRequest = { ...request, worldInfo: captureRoleplayWorldInfo(f.scope, account, updatedSource,
        { avatar: 'Nova.png', maxContext: 200 }) };
    const chat = context('chat-post-history', chatRequest, updatedSource);
    await assert.rejects(runRoleplayReplyJob(chat, {
        promptBackend: () => ({ backend: 'chat' }), generate: () => { throw Error('Provider called'); },
    }), { code: 'ROLEPLAY_INVALID' });
    const controls = { prompts: [{ identifier: 'jailbreak', role: 'system', system_prompt: true, content: '' }],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true },
            { identifier: 'jailbreak', enabled: true },
        ] }] };
    const allowed = context('chat-post-history-bound', chatRequest, updatedSource);
    await runRoleplayReplyJob(allowed, { promptBackend: () => ({ backend: 'chat', preset: controls }),
        generate: async ({ messages, beforeDispatch }) => {
            beforeDispatch();
            assert.deepEqual(messages.map(message => message.content), [
                'Character: Original', 'Original', 'Answer', 'Following instruction', 'Character instruction',
            ]);
            return { text: 'Following the saved order' };
        } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Following the saved order');
});

test('saved Author\'s Note surrounds selected lore only at its configured interval and position', () => {
    const messages = [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Original' }];
    const note = { prompt: 'Original note', interval: 2, position: 1, depth: 0, role: 0,
        userMessages: 2, scoped: { useChara: true, prompt: 'Character note', position: 1 } };
    assert.deepEqual(insertWorldInfoAuthorNote(messages, ['Top'], ['Bottom'], note, 1), [
        { role: 'system', content: 'Rules' }, { role: 'user', content: 'Original' },
        { role: 'system', content: 'Top\nCharacter note\nOriginal note\nBottom' },
    ]);
    assert.equal(insertWorldInfoAuthorNote(messages, ['Top'], ['Bottom'], { ...note, userMessages: 1 }, 1), messages);
    assert.equal(insertWorldInfoAuthorNote(messages, [], [], note, 1), messages);
    assert.throws(() => insertWorldInfoAuthorNote(messages, ['Top'], [], { ...note, role: '0' }, 1),
        { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => insertWorldInfoAuthorNote(messages, ['Top'], [], { ...note, position: 0 }, 1),
        { code: 'ROLEPLAY_INVALID' });
    for (const [position, expected] of [[2, ['Top\nCharacter note\nOriginal note', 'Rules', 'Original']],
        [0, ['Rules', 'Top\nCharacter note\nOriginal note', 'Original']]]) {
        assert.deepEqual(insertWorldInfoAuthorNote(messages, ['Top'], [], { ...note, position }, 1, true)
            .map(message => message.content), expected);
    }
    assert.deepEqual(insertWorldInfoAuthorNote(messages, ['Top'], [], { ...note, position: 2, userMessages: 1 }, 1), messages);
});

test('named lore outlets render at their saved story template positions', () => {
    const snapshot = { storyTemplate: '{{#if description}}{{description}}\n{{/if}}{{outlet::harbour}}',
        storyPosition: 0, global: { characterDescription: 'A harbour' } };
    const history = [{ role: 'user', content: 'Original' }];
    const placed = insertWorldInfoOutlets(history, { harbour: ['Safe waters'] }, snapshot, 0, 'User', 'Nova');
    assert.deepEqual(placed, [{ role: 'system', content: 'A harbour\nSafe waters' }, ...history]);
    assert.deepEqual(history, [{ role: 'user', content: 'Original' }]);
    assert.throws(() => insertWorldInfoOutlets(history, { missing: ['Lost'] }, snapshot, 0, 'User', 'Nova'),
        { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => insertWorldInfoOutlets([{ role: 'system', content: 'Unbound story' }, ...history],
        { harbour: ['Safe waters'] }, snapshot, 1, 'User', 'Nova'), { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => insertWorldInfoOutlets(history, { harbour: ['Safe waters'] }, {
        ...snapshot, storyTemplate: '{{outlet::harbour}} {{lookup description "secret"}}',
    }, 0, 'User', 'Nova'), { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => insertWorldInfoOutlets(history, { harbour: ['Safe waters'] }, {
        ...snapshot, storyTemplate: '{{outlet::harbour}} {{#each description}}{{this}}{{/each}}',
    }, 0, 'User', 'Nova'), { code: 'ROLEPLAY_INVALID' });
    assert.deepEqual(insertWorldInfoOutlets(history, { harbour: ['Safe waters'] }, {
        ...snapshot, storyTemplate: '{{wiBefore}} {{outlet::harbour}} {{wiAfter}}',
    }, 0, 'User', 'Nova', 'Earlier', 'Later'), [
        { role: 'system', content: 'Earlier Safe waters Later' }, ...history,
    ]);
    assert.throws(() => insertWorldInfoOutlets(history, { harbour: ['Safe waters'] }, snapshot,
        0, 'User', 'Nova', 'Missing placement'), { code: 'ROLEPLAY_INVALID' });
    assert.deepEqual(insertWorldInfoOutlets(history, {}, {
        ...snapshot, storyTemplate: '{{wiBefore}}\n{{description}}\n{{wiAfter}}',
    }, 0, 'User', 'Nova', 'Earlier', 'Later'), [
        { role: 'system', content: 'Earlier\nA harbour\nLater' }, ...history,
    ]);
});

test('server story system instructions come from the saved chat and card, not accepted text', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    const settingsFile = path.join(f.scope.directories.root, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ power_user: { prefer_character_prompt: true,
        context: { story_string: '{{system}}\n{{description}}', story_string_position: 0 } } }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const cardPath = path.join(f.scope.directories.characters, 'Nova.png');
    fs.writeFileSync(cardPath, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Original',
        data: { name: 'Nova', description: 'Original', system_prompt: 'Saved card rule' } })));
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const fromCard = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 });
    assert.equal(fromCard.systemPrompt, 'Saved card rule');
    assert.equal(insertWorldInfoOutlets([], {}, fromCard, 0, 'User', 'Nova', '', '', true)[0].content,
        'Saved card rule\nOriginal');
    assert.throws(() => insertWorldInfoOutlets([], {}, { ...fromCard, storyTemplate: '{{system}} {{unsafe}}' },
        0, 'User', 'Nova', '', '', true), { code: 'ROLEPLAY_INVALID' });
    fs.writeFileSync(settingsFile, JSON.stringify({ power_user: { prefer_character_prompt: false,
        context: { story_string: '{{system}}\n{{description}}', story_string_position: 0 } } }));
    assert.equal(captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 }).systemPrompt, '');
    fs.writeFileSync(settingsFile, JSON.stringify({ power_user: { prefer_character_prompt: true,
        context: { story_string: '{{system}}\n{{description}}', story_string_position: 0 } } }));
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true,
        messages: [], maxTokens: 20, characterName: 'Nova', worldInfo: fromCard };
    const { jobId } = admitRoleplayJob(f.scope, account,
        { operationKey: 'bound-card-system', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    await runRoleplayReplyJob({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal }, { generate: async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.deepEqual(messages.map(message => message.content), ['Saved card rule\nOriginal', 'Original', 'Answer']);
        return { text: 'Following the card' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Following the card');
    const another = fixture(t);
    another.records[0].chat_metadata.system_prompt = 'Saved chat rule';
    fs.writeFileSync(another.filename, another.records.map(record => JSON.stringify(record)).join('\n'));
    const chatAccount = { accountId: another.scope.accountId, dataEpoch: another.scope.dataEpoch };
    const chatSource = captureRoleplaySource(another.scope, { locator: another.locator });
    assert.equal(captureRoleplayWorldInfo(another.scope, chatAccount, chatSource,
        { avatar: 'Nova.png', maxContext: 100 }).systemPrompt, 'Saved chat rule');
});

test('a bound reply uses the saved story outlet and retains its decision on replay', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'The harbour is safe', { world: undefined, hash: undefined,
            position: 7, outletName: 'harbour' }),
        2: entry(2, 'Original', 'Before the story', { position: 0 }),
        3: entry(3, 'Original', 'After the story', { position: 1 }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        power_user: { context: { story_string: '{{wiBefore}}\nHarbour: {{outlet::harbour}}\n{{wiAfter}}', story_string_position: 0 } },
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, historyStart: 0,
        messages: [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }],
        maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'saved-outlet', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    let calls = 0;
    const options = { generate: async ({ beforeDispatch, messages }) => {
        beforeDispatch();
        calls++;
        assert.deepEqual(messages.map(message => message.content), [
            'Before the story\nHarbour: The harbour is safe\nAfter the story', 'Original', 'Answer',
        ]);
        return { text: 'A safe answer' };
    } };
    await runRoleplayReplyJob(context, options);
    await runRoleplayReplyJob(context, options);
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'A safe answer');
});

test('saved story lore without outlets follows its template and refuses missing placement', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'Saved harbour', { position: 0, constant: true }),
    } }));
    const settingsFile = path.join(f.scope.directories.root, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({
        power_user: { context: { story_string: 'Bound: {{wiBefore}}', story_string_position: 0 } },
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, historyStart: 0,
        messages: [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }],
        maxTokens: 32, characterName: 'Nova', worldInfo: captureRoleplayWorldInfo(f.scope, account, source,
            { avatar: 'Nova.png', maxContext: 200 }) };
    const first = admitRoleplayJob(f.scope, account, { operationKey: 'saved-story', effect: 'append', source, request });
    releaseJob(f.scope.directories, first.jobId);
    const context = jobId => ({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal });
    await runRoleplayReplyJob(context(first.jobId), { generate: async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.deepEqual(messages.map(message => message.content), ['Bound: Saved harbour', 'Original', 'Answer']);
        return { text: 'Safe' };
    } });
    fs.writeFileSync(settingsFile, JSON.stringify({
        power_user: { context: { story_string: 'Bound but missing lore', story_string_position: 0 } },
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const updatedSource = captureRoleplaySource(f.scope, { locator: f.locator });
    const refused = admitRoleplayJob(f.scope, account, { operationKey: 'missing-story-position', effect: 'append',
        source: updatedSource, request: { ...request,
            messages: [...request.messages, { role: 'assistant', content: 'Safe' }],
            worldInfo: captureRoleplayWorldInfo(f.scope, account, updatedSource, { avatar: 'Nova.png', maxContext: 200 }) } });
    releaseJob(f.scope.directories, refused.jobId);
    await assert.rejects(runRoleplayReplyJob(context(refused.jobId), {
        generate: () => { throw Error('Provider called'); },
    }), { code: 'ROLEPLAY_INVALID' });
});

test('a scan without selected entries does not call the per-pass hook', async () => {
    let calls = 0;
    const result = await scan([], { onScan: () => { calls++; } });
    assert.equal(calls, 0);
    assert.equal(result.iterations, 0);
});

test('a saved null timed window uses the same empty metadata as the browser', async () => {
    const result = await scan([entry(1, 'cat', 'Sticky lore', { sticky: 2 })], {
        metadata: { timedWorldInfo: null },
    });
    assert.equal(result.worldInfoBefore, 'Sticky lore');
    assert.equal(result.timedWorldInfo.sticky['Town.1'].end, 3);
});

test('saved depth injections preserve the system prefix and browser history order', () => {
    const messages = [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Reply' }, { role: 'user', content: 'Latest' }];
    const inserted = insertWorldInfoDepth(messages, [
        { depth: 0, role: 0, entries: ['After latest'] },
        { depth: 1, role: 1, entries: ['Before latest'] },
        { depth: 3, role: 2, entries: ['Before first'] },
    ], 1);
    assert.deepEqual(inserted.map(value => value.content), ['Rules', 'Before first', 'First', 'Reply',
        'Before latest', 'Latest', 'After latest']);
    assert.deepEqual(messages.map(value => value.content), ['Rules', 'First', 'Reply', 'Latest']);
    assert.throws(() => insertWorldInfoDepth(messages, [{ depth: 1, role: 5, entries: ['bad'] }], 1),
        { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => insertWorldInfoDepth(messages, [{ depth: 1, role: '0', entries: ['lost'] }], 1),
        { code: 'ROLEPLAY_INVALID' });
});

test('saved card examples sit between before/after lore examples and ahead of protected history', () => {
    const messages = [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Original' }];
    const inserted = insertWorldInfoExamples(messages, [
        { position: 0, content: 'User: First\nNova: Before' },
        { position: 1, content: 'User: Last\nNova: After' },
    ], '<START>\nUser: Card\nNova: Sample', 1, 'User', 'Nova');
    assert.deepEqual(inserted.map(value => value.content), ['Rules', 'First', 'Before', 'Card', 'Sample',
        'Last', 'After', 'Original']);
    assert.deepEqual(inserted.slice(1, -1).map(value => value.name), ['example_user', 'example_assistant',
        'example_user', 'example_assistant', 'example_user', 'example_assistant']);
    assert.deepEqual(messages.map(value => value.content), ['Rules', 'Original']);
    assert.throws(() => insertWorldInfoExamples(messages, [{ position: 0, content: 'Hi' }], '', 3, 'User', 'Nova'),
        { code: 'ROLEPLAY_INVALID' });
});

test('depth placement refuses unhandled saved attachments and a fabricated empty history', t => {
    const f = fixture(t);
    assert.throws(() => assertWorldInfoDepthHistory(f.records, [{ role: 'user', content: 'Original' }], 0),
        { code: 'ROLEPLAY_INVALID' });
    f.records[1].extra = {};
    assert.throws(() => assertWorldInfoDepthHistory(f.records, [{ role: 'system', content: 'Forged' }], 1),
        { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('saved text files enter a bound prompt and changed files refuse before provider dispatch', async t => {
    const f = fixture(t);
    f.records[1].extra = { files: [{ url: '/user/files/note.txt', name: 'note.txt' }] };
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.files = path.join(f.scope.directories.root, 'files');
    fs.mkdirSync(f.scope.directories.files);
    const attachment = path.join(f.scope.directories.files, 'note.txt');
    fs.writeFileSync(attachment, 'The saved note');
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    assert.equal(worldInfo.chat[1], 'User: The saved note\n\nOriginal');
    assert.deepEqual(buildRoleplaySavedHistory(f.records, { attachments: worldInfo.attachments }).map(message => message.content),
        ['The saved note\n\nOriginal', 'Answer']);
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'saved-text-file', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 20, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    fs.writeFileSync(attachment, 'Replaced note');
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { throw Error('Provider called'); } }),
        { code: 'ROLEPLAY_SOURCE_CHANGED' });
    fs.writeFileSync(attachment, 'The saved note');
    await assert.rejects(runRoleplayReplyJob(context, { generate: async ({ beforeDispatch }) => {
        fs.writeFileSync(attachment, 'Changed after prompt preparation');
        beforeDispatch();
    } }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    fs.writeFileSync(attachment, 'The saved note');
    await runRoleplayReplyJob(context, { generate: async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.deepEqual(messages.map(message => message.content), ['The saved note\n\nOriginal', 'Answer']);
        return { text: 'Reply with note' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Reply with note');
});

test('a bound text attachment refuses escaped and aliased account files', t => {
    for (const url of ['/user/files/%2e%2e%2fsource.txt', '/user/files/other%2fnote.txt',
        'https://outside.example/file.txt']) {
        const f = fixture(t);
        f.scope.directories.files = path.join(f.scope.directories.root, 'files');
        fs.mkdirSync(f.scope.directories.files);
        const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
        f.records[1].extra = { files: [{ url }] };
        fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
        assert.throws(() => captureRoleplayWorldInfo(f.scope, account, f.source(),
            { avatar: 'Nova.png', maxContext: 200 }), { code: 'ROLEPLAY_INVALID' });
    }
    const f = fixture(t);
    f.scope.directories.files = path.join(f.scope.directories.root, 'files');
    fs.mkdirSync(f.scope.directories.files);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    f.records[1].extra = { files: [{ url: '/user/files/alias.txt' }] };
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.symlinkSync(f.filename, path.join(f.scope.directories.files, 'alias.txt'));
    assert.throws(() => captureRoleplayWorldInfo(f.scope, account,
        captureRoleplaySource(f.scope, { locator: f.locator }), { avatar: 'Nova.png', maxContext: 200 }),
    { code: 'ROLEPLAY_STORE_DAMAGED' });
});

test('a saved account image reaches only a bound vision prompt and changed bytes refuse dispatch', async t => {
    const f = fixture(t);
    f.records[1].extra = { media: [{ url: '/user/images/Nova/one.png', type: 'image' }], inline_image: true };
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.userImages = path.join(f.scope.directories.root, 'user', 'images');
    const imagePath = path.join(f.scope.directories.userImages, 'Nova', 'one.png');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, png);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 300 });
    const expected = { role: 'user', content: [{ type: 'text', text: 'Original' }, { type: 'image_url',
        image_url: { url: `data:image/png;base64,${png.toString('base64')}`, detail: 'auto' } }] };
    assert.deepEqual(buildRoleplaySavedHistory(f.records, { images: worldInfo.images })[0], expected);
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'bound-image', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 20, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    const vision = { source: 'custom', active: { ...blankChatControls, media_inlining: true, inline_image_quality: 'auto' } };
    fs.writeFileSync(imagePath, Buffer.concat([png, Buffer.from('changed')]));
    await assert.rejects(runRoleplayReplyJob(context, { promptBackend: () => vision,
        generate: () => { throw Error('Provider called'); } }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    fs.writeFileSync(imagePath, png);
    await assert.rejects(runRoleplayReplyJob(context, { promptBackend: () => ({ ...vision,
        active: { media_inlining: false } }), generate: () => { throw Error('Provider called'); } }),
    { code: 'ROLEPLAY_INVALID' });
    await assert.rejects(runRoleplayReplyJob(context, { promptBackend: () => vision,
        generate: async ({ beforeDispatch }) => { fs.writeFileSync(imagePath, Buffer.concat([png, Buffer.from('changed')])); beforeDispatch(); } }),
    { code: 'ROLEPLAY_SOURCE_CHANGED' });
    fs.writeFileSync(imagePath, png);
    await runRoleplayReplyJob(context, { promptBackend: () => vision, generate: async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.deepEqual(messages, [expected, { role: 'assistant', content: 'Answer' }]);
        return { text: 'Image reply' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Image reply');
});

test('a bound image refuses unsafe paths and links before a provider call', t => {
    for (const url of ['/user/images/%2e%2e/one.png', 'https://other.example/one.png',
        '/user/images/Nova/%2e%2e%2fone.png']) {
        const f = fixture(t);
        f.scope.directories.userImages = path.join(f.scope.directories.root, 'user', 'images');
        f.records[1].extra = { media: [{ url, type: 'image' }] };
        fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
        assert.throws(() => captureRoleplayWorldInfo(f.scope,
            { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch }, f.source(),
            { avatar: 'Nova.png', maxContext: 300 }), { code: 'ROLEPLAY_INVALID' });
    }
    const f = fixture(t);
    f.scope.directories.userImages = path.join(f.scope.directories.root, 'user', 'images');
    const imagePath = path.join(f.scope.directories.userImages, 'Nova', 'one.png');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.symlinkSync(f.filename, imagePath);
    f.records[1].extra = { media: [{ url: '/user/images/Nova/one.png', type: 'image' }] };
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    assert.throws(() => captureRoleplayWorldInfo(f.scope,
        { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch }, f.source(),
        { avatar: 'Nova.png', maxContext: 300 }), { code: 'ROLEPLAY_STORE_DAMAGED' });
});

test('a bound account image reaches the native Custom request with image budget reserved', async t => {
    const f = fixture(t);
    f.records[1].extra = { media: [{ url: '/user/images/Nova/one.png', type: 'image' }] };
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.userImages = path.join(f.scope.directories.root, 'user', 'images');
    const imagePath = path.join(f.scope.directories.userImages, 'Nova', 'one.png');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, png);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ _settingsRevision: 1,
        main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model: 'vision-fixture' },
        oai_settings: { ...blankChatControls, chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000',
            custom_model: 'vision-fixture', media_inlining: true, inline_image_quality: 'low', openai_max_context: 256 },
        power_user: { custom_stopping_strings: '[]' },
    }));
    const binding = captureGenerationBinding(f.scope.directories, { kind: 'active' }, { settingsRevision: 1 });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 220 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'native-bound-image', effect: 'append', source,
        request: { binding, serverPrompt: true, messages: [], maxTokens: 24, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    let calls = 0;
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await runReply(context, { contextLimit: undefined,
        generate: options => runChatProfile({ ...options, fetch: async (_url, request) => {
            calls++;
            const body = JSON.parse(request.body);
            assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'Original' }, { type: 'image_url',
                image_url: { url: `data:image/png;base64,${png.toString('base64')}`, detail: 'low' } }]);
            return new Response(JSON.stringify({ choices: [{ message: { content: 'Saw the image' } }] }));
        } }),
    });
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Saw the image');
});

test('gallery selection skips unselected images and reserves image tokens before provider work', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    f.records[2].extra = { media_display: 'gallery', media_index: 1, media: [
        { url: '/user/images/Nova/missing.png', type: 'image' },
        { url: '/user/images/Nova/one.png', type: 'image' },
    ] };
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.userImages = path.join(f.scope.directories.root, 'user', 'images');
    const imagePath = path.join(f.scope.directories.userImages, 'Nova', 'one.png');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, png);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 70 });
    assert.equal(worldInfo.images.length, 1);
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'gallery-budget', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true,
            messages: [], maxTokens: 20, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    await assert.rejects(runRoleplayReplyJob({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal }, {
        contextLimit: () => 100,
        promptBackend: () => ({ source: 'custom', active: { media_inlining: true, inline_image_quality: 'low' } }),
        generate: () => { throw Error('Provider called'); },
    }), { code: 'ROLEPLAY_INVALID' });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
});

test('saved display metadata does not block a protected text history', t => {
    const f = fixture(t);
    f.records[1].extra = { isSmallSys: false, token_count: 12 };
    f.records[2].extra = { token_count: 7 };
    assert.deepEqual(buildRoleplaySavedHistory(f.records), [
        { role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' },
    ]);
    f.records[2].extra.reasoning = 'A hidden thought';
    assert.deepEqual(buildRoleplaySavedHistory(f.records), [
        { role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' },
    ]);
    assert.throws(() => buildRoleplaySavedHistory(f.records, { reasoningInPrompt: true }), { code: 'ROLEPLAY_INVALID' });
    f.records[2].extra.reasoning_signature = 'model-bound signature';
    assert.throws(() => buildRoleplaySavedHistory(f.records), { code: 'ROLEPLAY_INVALID' });
});

test('saved reasoning is added from newest to oldest only within the saved prompt limit', t => {
    const f = fixture(t);
    f.records[1].extra = {};
    f.records[2].extra = { reasoning: 'First thought' };
    f.records.push({ name: 'Nova', is_user: false, mes: 'Later', extra: { reasoning: 'Latest thought' } });
    const options = { reasoningInPrompt: true, reasoning: {
        prefix: '<think>', suffix: '</think>', separator: '\n', max_additions: 1,
    } };
    const messages = buildRoleplaySavedHistory(f.records, options);
    assert.deepEqual(messages.map(message => message.content), ['Original', 'Answer', '<think>Latest thought</think>\nLater']);
    assert.doesNotThrow(() => assertWorldInfoDepthHistory(f.records, messages, 0, options));
    f.records.at(-1).name = 'Another character';
    assert.deepEqual(buildRoleplaySavedHistory(f.records, { ...options, characterName: 'Nova', group: true,
        userName: 'User', namesBehavior: 0 }).map(message => message.content),
    ['Original', 'Nova: <think>First thought</think>\nAnswer', 'Another character: Later']);
    f.records.at(-1).name = 'Nova';
    assert.deepEqual(buildRoleplaySavedHistory(f.records, { ...options, reasoning: { ...options.reasoning, max_additions: 0 } })
        .map(message => message.content), ['Original', 'Answer', 'Later']);
    assert.throws(() => buildRoleplaySavedHistory(f.records, { ...options,
        reasoning: { ...options.reasoning, prefix: '{{unsafe}}' } }), { code: 'ROLEPLAY_INVALID' });
    assert.throws(() => buildRoleplaySavedHistory(f.records, { ...options,
        regex: [{ placement: [6], findRegex: 'thought', replaceString: 'idea', promptOnly: true }] }),
    { code: 'ROLEPLAY_INVALID' });
});

test('a server-owned next turn formats saved reasoning when enabled', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    f.records[2].extra = { reasoning: 'Private thought' };
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        power_user: { reasoning: { add_to_prompts: true, max_additions: 1,
            prefix: '<think>', suffix: '</think>', separator: '\n' } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true,
        messages: [], maxTokens: 20, characterName: 'Nova',
        worldInfo: captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 }) };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'enabled-prompt-reasoning', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    await runRoleplayReplyJob({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal }, { generate: async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.deepEqual(messages.map(message => message.content), ['Original', '<think>Private thought</think>\nAnswer']);
        return { text: 'Next reply' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Next reply');
});

test('server-owned prompts derive history from the protected chat and reject browser-prepared text', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        power_user: { context: { story_string: 'Character: {{description}}', story_string_position: 0 } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
        maxTokens: 32, userName: 'User', characterName: 'Nova', worldInfo };
    const prepare = (operationKey, input) => {
        const { jobId } = admitRoleplayJob(f.scope, account, { operationKey, effect: 'append', source, request: input });
        releaseJob(f.scope.directories, jobId);
        return { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
            owner: f.scope.owner, signal: new AbortController().signal };
    };
    const forged = prepare('server-prompt-forged', { ...request, messages: [{ role: 'user', content: 'Forged' }] });
    await assert.rejects(runRoleplayReplyJob(forged, { generate: () => { throw Error('Provider called'); } }),
        { code: 'ROLEPLAY_INVALID' });
    assert.deepEqual(buildRoleplaySavedHistory(readRoleplayChat(f.scope, f.locator).records), [
        { role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' },
    ]);
    const accepted = prepare('server-prompt-bound', request);
    await runRoleplayReplyJob(accepted, { generate: async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.deepEqual(messages.map(message => message.content), ['Character: Original', 'Original', 'Answer']);
        return { text: 'Bound reply' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Bound reply');
});

test('completed saved tool calls preserve their calls and results in bound Custom prompts', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    f.records.splice(2, 0, { name: 'System', is_system: true, is_user: false, mes: 'Tool calls',
        extra: { isSmallSys: true, api: 'custom', model: 'tool-model', tool_invocations: [
            { id: 'call-1', name: 'lookup', parameters: '{"term":"sea"}', result: 'Calm seas' },
            { id: 'call-2', name: 'weather', parameters: '{}', result: 'Clear' },
        ] } });
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 300 });
    const material = { backend: 'chat', source: 'custom', profile: { model: 'tool-model' },
        active: { ...blankChatControls, function_calling: true, custom_prompt_post_processing: '' } };
    assert.deepEqual(buildRoleplaySavedHistory(f.records, { toolHistory: true, toolSource: 'custom', toolModel: 'tool-model' }), [
        { role: 'user', content: 'Original' },
        { role: 'assistant', tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"term":"sea"}' } },
            { id: 'call-2', type: 'function', function: { name: 'weather', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'call-1', content: 'Calm seas' },
        { role: 'tool', tool_call_id: 'call-2', content: 'Clear' },
        { role: 'assistant', content: 'Answer' },
    ]);
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'saved-tool-history', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 20, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { promptBackend: () => ({ ...material,
        active: { function_calling: false } }), generate: () => { throw Error('Provider called'); } }),
    { code: 'ROLEPLAY_INVALID' });
    await assert.rejects(runRoleplayReplyJob(context, { promptBackend: () => ({ ...material,
        profile: { model: 'different-model' } }), generate: () => { throw Error('Provider called'); } }),
    { code: 'ROLEPLAY_INVALID' });
    await runRoleplayReplyJob(context, { promptBackend: () => material, generate: async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'assistant']);
        assert.equal(messages[1].tool_calls[0].function.name, 'lookup');
        assert.equal(messages[3].tool_call_id, 'call-2');
        return { text: 'New reply' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'New reply');
});

test('saved tool history refuses malformed or unsigned calls before provider work', t => {
    const f = fixture(t);
    f.records[1].extra = {};
    const tool = { name: 'System', is_system: true, is_user: false, mes: 'Tool calls',
        extra: { isSmallSys: true, api: 'custom', model: 'tool-model', tool_invocations: [
            { id: 'call-1', name: 'lookup', parameters: '{}', result: 'safe', signature: 'signed' },
        ] } };
    f.records.splice(2, 0, tool);
    assert.throws(() => buildRoleplaySavedHistory(f.records, { toolHistory: true, toolSource: 'custom', toolModel: 'tool-model' }),
        { code: 'ROLEPLAY_INVALID' });
    delete tool.extra.tool_invocations[0].signature;
    tool.extra.tool_invocations[0].id = '__proto__';
    assert.deepEqual(buildRoleplaySavedHistory(f.records, { toolHistory: true, toolSource: 'custom', toolModel: 'tool-model' })[2].tool_call_id,
        '__proto__');
    tool.extra.tool_invocations.push({ ...tool.extra.tool_invocations[0] });
    assert.throws(() => buildRoleplaySavedHistory(f.records, { toolHistory: true, toolSource: 'custom', toolModel: 'tool-model' }),
        { code: 'ROLEPLAY_INVALID' });
});

test('context trimming keeps a saved tool call together with every result', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    f.records[1].mes = 'Old context '.repeat(80);
    f.records.splice(2, 0, { name: 'System', is_system: true, is_user: false, mes: 'Tool calls',
        extra: { isSmallSys: true, api: 'custom', model: 'tool-model', tool_invocations: [
            { id: 'call-1', name: 'lookup', parameters: '{}', result: 'Calm seas' },
        ] } });
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 120 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'trim-tool-history', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 20, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await runRoleplayReplyJob(context, { contextLimit: () => 140,
        promptBackend: () => ({ backend: 'chat', source: 'custom', profile: { model: 'tool-model' },
            active: { ...blankChatControls, function_calling: true, custom_prompt_post_processing: '' } }),
        generate: async ({ messages, beforeDispatch }) => {
            beforeDispatch();
            assert.deepEqual(messages.map(item => item.role), ['assistant', 'tool', 'assistant']);
            assert.equal(messages[0].tool_calls[0].id, messages[1].tool_call_id);
            return { text: 'Reply' };
        },
    });
});

test('the native Custom request receives saved tool calls and their linked results', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    f.records.splice(2, 0, { name: 'System', is_system: true, is_user: false, mes: 'Tool calls',
        extra: { isSmallSys: true, api: 'custom', model: 'tool-model', tool_invocations: [
            { id: 'call-1', name: 'lookup', parameters: '{}', result: 'Calm seas' },
        ] } });
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ _settingsRevision: 1,
        main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model: 'tool-model' },
        oai_settings: { ...blankChatControls, chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000',
            custom_model: 'tool-model', function_calling: true, openai_max_context: 512 },
        power_user: { custom_stopping_strings: '[]' },
    }));
    const binding = captureGenerationBinding(f.scope.directories, { kind: 'active' }, { settingsRevision: 1 });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 400 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'native-tool-history', effect: 'append', source,
        request: { binding, serverPrompt: true, messages: [], maxTokens: 24, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    let calls = 0;
    await runReply({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal }, { contextLimit: undefined,
        generate: options => runChatProfile({ ...options, fetch: async (_url, request) => {
            calls++;
            const { messages } = JSON.parse(request.body);
            assert.deepEqual(messages.map(item => item.role), ['user', 'assistant', 'tool', 'assistant']);
            assert.deepEqual(messages[1].tool_calls, [{ id: 'call-1', type: 'function',
                function: { name: 'lookup', arguments: '{}' } }]);
            assert.equal(messages[2].tool_call_id, 'call-1');
            assert.equal(messages[2].content, 'Calm seas');
            return new Response(JSON.stringify({ choices: [{ message: { content: 'Safe return' } }] }));
        } }),
    });
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Safe return');
});

test('server-owned prompts refuse unsupported saved media before paying a provider', async t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'server-prompt-media', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 32, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    await assert.rejects(runRoleplayReplyJob({ job: getJob(f.scope.directories, jobId),
        directories: f.scope.directories, owner: f.scope.owner, signal: new AbortController().signal },
    { generate: () => { throw Error('Provider called'); } }), { code: 'ROLEPLAY_INVALID' });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
});

test('server-owned prompts use protected history when no story template is saved', async t => {
    const f = fixture(t);
    f.records[1].extra = { isSmallSys: false, token_count: 12 };
    f.records[2].extra = { token_count: 7 };
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true,
        messages: [], maxTokens: 20, characterName: 'Nova',
        worldInfo: captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 }) };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'plain-server-history', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    await runRoleplayReplyJob({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal }, {
        generate: async ({ messages, beforeDispatch }) => {
            beforeDispatch();
            assert.deepEqual(messages, [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }]);
            return { text: 'Bound reply' };
        },
    });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Bound reply');
});

test('a saved reply with disabled prompt reasoning can be used on the next server-owned turn', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        power_user: { context: { story_string: 'Character: {{description}}', story_string_position: 0 },
            reasoning: { add_to_prompts: false } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const context = (key, source) => {
        const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true,
            messages: [], maxTokens: 20, characterName: 'Nova',
            worldInfo: captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 }) };
        const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: key, effect: 'append', source, request });
        releaseJob(f.scope.directories, jobId);
        return { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
            owner: f.scope.owner, signal: new AbortController().signal };
    };
    await runRoleplayReplyJob(context('first-reasoning', captureRoleplaySource(f.scope, { locator: f.locator })), {
        generate: async ({ beforeDispatch }) => { beforeDispatch(); return { text: 'First reply', response: { thinking: 'Private note' } }; },
    });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).extra.reasoning, 'Private note');
    await runRoleplayReplyJob(context('second-reasoning', captureRoleplaySource(f.scope, { locator: f.locator })), {
        generate: async ({ beforeDispatch, messages }) => {
            beforeDispatch();
            assert.deepEqual(messages.map(item => item.content), ['Character: Original', 'Original', 'Answer', 'First reply']);
            return { text: 'Second reply' };
        },
    });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Second reply');
});

test('a fresh protected chat uses its saved story and refuses an empty prompt', async t => {
    const f = fixture(t);
    f.records.splice(1);
    fs.writeFileSync(f.filename, JSON.stringify(f.records[0]));
    assert.deepEqual(buildRoleplaySavedHistory(readRoleplayChat(f.scope, f.locator).records), []);
    const settingsFile = path.join(f.scope.directories.root, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({
        power_user: { context: { story_string: 'Character: {{description}}', story_string_position: 0 } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true,
        messages: [], maxTokens: 20, characterName: 'Nova',
        worldInfo: captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 }) };
    const prepare = (key, input) => {
        const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: key, effect: 'append', source, request: input });
        releaseJob(f.scope.directories, jobId);
        return { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
            owner: f.scope.owner, signal: new AbortController().signal };
    };
    fs.writeFileSync(settingsFile, '{}');
    const blank = prepare('empty-server-prompt', { ...request,
        worldInfo: captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 }) });
    await assert.rejects(runRoleplayReplyJob(blank, { generate: () => { throw Error('Provider called'); } }),
        { code: 'ROLEPLAY_INVALID' });
    fs.writeFileSync(settingsFile, JSON.stringify({
        power_user: { context: { story_string: 'Character: {{description}}', story_string_position: 0 } },
    }));
    const context = prepare('fresh-server-prompt', request);
    await runRoleplayReplyJob(context, { generate: async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.deepEqual(messages, [{ role: 'system', content: 'Character: Original' }]);
        return { text: 'First reply' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'First reply');
});

test('server-owned prompts trim old saved history and rebuild lore depth within the bound context', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    for (let index = 0; index < 24; index++) {
        f.records.push({ name: 'User', is_user: true, mes: `Old message ${index} with repeated words to fill the prompt.` });
    }
    f.records.push({ name: 'Nova', is_user: false, mes: 'Most recent answer' });
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Most recent', 'Saved depth lore', { position: 4, depth: 0 }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        power_user: { context: { story_string: 'Character: {{description}}', story_string_position: 0 } },
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true,
        messages: [], maxTokens: 20, characterName: 'Nova', userName: 'User',
        worldInfo: captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 80 }) };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'trim-saved-history', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await runRoleplayReplyJob(context, { contextLimit: () => 100, generate: async ({ messages, beforeDispatch }) => {
        beforeDispatch();
        assert.equal(messages[0].content, 'Character: Original');
        assert.deepEqual(messages.slice(-2).map(message => message.content), ['Most recent answer', 'Saved depth lore']);
        assert.ok(messages.length < f.records.length);
        assert.ok(!messages.some(message => message.content.startsWith('Old message 0')));
        return { text: 'Bound reply' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Bound reply');
});

test('server selection recurses on saved text and places entries with a bounded budget', async () => {
    const result = await scan([entry(1, 'cat', 'The moon is bright'), entry(2, 'moon', 'A gate opens')]);
    assert.deepEqual(result.activated.map(value => value.uid), [1, 2]);
    assert.equal(result.worldInfoBefore, 'A gate opens\nThe moon is bright');
    assert.equal(result.iterations, 3);
});

test('an activated automation is identified before a bound provider can run', async () => {
    const result = await scan([entry(1, 'cat', 'Execute this', { automationId: 'quick-reply-1' })]);
    assert.equal(result.activated[0].automationId, 'quick-reply-1');
});

test('probability, group choices and timed cooldowns use repeatable draws', async () => {
    const entries = [entry(1, 'cat', 'First', { group: 'one', groupWeight: 1, probability: 50 }),
        entry(2, 'cat', 'Second', { group: 'one', groupWeight: 3, cooldown: 3 })];
    const options = { random: () => 0.75, metadata: { timedWorldInfo: { sticky: {}, cooldown: {} } } };
    const selected = await scan(entries, options);
    assert.deepEqual(selected.activated.map(value => value.uid), [2]);
    assert.deepEqual(await scan(entries, options), selected);
    const blocked = await scan(entries, { ...options, random: () => 0.2, metadata: { timedWorldInfo: { sticky: {}, cooldown: {
        'Town.2': { hash: 2, start: 1, end: 4, protected: true },
    } } } });
    assert.deepEqual(blocked.activated.map(value => value.uid), [1]);
    assert.equal(blocked.draws.length, 1);
});

test('group scoring counts secondary hits only for the browser positive selection logic', async () => {
    const first = entry(1, 'cat', 'Primary only', { group: 'choice', keysecondary: ['runs'], selectiveLogic: 2 });
    const second = entry(2, 'cat', 'Positive secondary', { group: 'choice', keysecondary: ['runs'], selectiveLogic: 0 });
    const result = await scan([first, second], { settings: { ...settings, world_info_use_group_scoring: true } });
    assert.deepEqual(result.activated.map(value => value.uid), [2]);
});

test('group scoring ignores blank secondary keys before comparing complete matches', async () => {
    const first = entry(1, 'cat', 'One', { group: 'choice', keysecondary: ['{{blank}}', 'runs'], selectiveLogic: 3 });
    const second = entry(2, 'cat', 'Two', { group: 'choice', keysecondary: ['runs'], selectiveLogic: 2 });
    const result = await scan([first, second], { settings: { ...settings, world_info_use_group_scoring: true },
        substitute: key => key === '{{blank}}' ? '' : key });
    assert.deepEqual(result.activated.map(value => value.uid), [1]);
});

test('group scoring gives no weight to an entry with only blank primary keys', async () => {
    const blank = entry(1, 'cat', 'Blank primary', { group: 'choice', key: ['{{blank}}'],
        keysecondary: ['runs'], selectiveLogic: 0, constant: true });
    const matching = entry(2, 'cat', 'Matching primary', { group: 'choice' });
    const result = await scan([blank, matching], { settings: { ...settings, world_info_use_group_scoring: true },
        substitute: key => key === '{{blank}}' ? '' : key });
    assert.deepEqual(result.activated.map(value => value.uid), [2]);
});

test('group scoring treats a malformed primary key list as no keys', async () => {
    const malformed = entry(1, 'cat', 'Malformed', { group: 'choice', key: 'cat', constant: true });
    const matching = entry(2, 'cat', 'Matching', { group: 'choice' });
    const result = await scan([malformed, matching], { settings: { ...settings, world_info_use_group_scoring: true } });
    assert.deepEqual(result.activated.map(value => value.uid), [2]);
});

test('a malformed trigger field does not act as a browser generation trigger filter', async () => {
    const result = await scan([entry(1, 'cat', 'Kept', { triggers: 'swipe' })], { global: { trigger: 'normal' } });
    assert.deepEqual(result.activated.map(value => value.uid), [1]);
});

test('the scan hook can change the next state and budget before any provider call', async () => {
    let calls = 0;
    const result = await scan([entry(1, 'cat', 'Present')], { onScan: async hook => {
        calls++;
        hook.state.next = 0;
    } });
    assert.equal(calls, 1);
    assert.equal(result.iterations, 1);
});

test('scan hooks and random choices cannot escape bounded saved decision states', async () => {
    await assert.rejects(scan([entry(1, 'cat', 'Present', { probability: 50 })], { random: () => NaN }),
        { code: 'ROLEPLAY_INVALID' });
    await assert.rejects(scan([entry(1, 'cat', 'Present')], { onScan: hook => { hook.state.next = 99; } }),
        { code: 'ROLEPLAY_INVALID' });
});

test('a scan hook cannot expand its budget or recursive text beyond the saved context limit', async () => {
    const entries = [entry(1, 'cat', 'Present'), entry(2, 'Present', 'Long '.repeat(100))];
    await assert.rejects(scan(entries, { onScan: hook => { hook.budget.current = 10000; } }),
        { code: 'ROLEPLAY_INVALID' });
    await assert.rejects(scan([entries[0]], { onScan: hook => { hook.activated.text = 'Unbudgeted '.repeat(100); } }),
        { code: 'ROLEPLAY_INVALID' });
});

test('a scan hook cannot replace its saved activation set with an unselected entry', async () => {
    const selected = entry(1, 'cat', 'Selected');
    const foreign = entry(2, 'cat', 'Unsaved');
    await assert.rejects(scan([selected], { onScan: hook => { hook.activated.entries.add(foreign); } }),
        { code: 'ROLEPLAY_INVALID' });
});

test('a scan hook cannot change an accepted entry after its token budget was checked', async () => {
    await assert.rejects(scan([entry(1, 'cat', 'Short')], { onScan: hook => {
        if (hook.new.successful.length) hook.new.successful[0].content = 'Unbudgeted '.repeat(100);
    } }), { code: 'ROLEPLAY_INVALID' });
});

test('a scan hook cannot invent a timed effect outside a recorded activation', async () => {
    await assert.rejects(scan([entry(1, 'cat', 'Short')], { onScan: hook => {
        hook.timedEffects.metadata.sticky['Town.1'] = { hash: 1, start: 2, end: 200, protected: true };
    } }), { code: 'ROLEPLAY_INVALID' });
});

test('a scan hook cannot bypass a saved cooldown during a later pass', async () => {
    const blocked = entry(2, 'cat', 'Blocked', { cooldown: 3 });
    await assert.rejects(scan([entry(1, 'cat', 'Selected'), blocked], {
        metadata: { timedWorldInfo: { cooldown: { 'Town.2': { hash: 2, start: 1, end: 4, protected: true } } } },
        onScan: hook => { hook.timedEffects.active.cooldown.clear(); },
    }), { code: 'ROLEPLAY_INVALID' });
});

test('a scan hook cannot invent delayed recursion levels or move the saved level', async () => {
    const delayed = entry(2, 'cat', 'Later', { delayUntilRecursion: 2 });
    await assert.rejects(scan([entry(1, 'cat', 'Selected'), delayed], { onScan: hook => {
        hook.recursionDelay.availableLevels.push(999);
    } }), { code: 'ROLEPLAY_INVALID' });
    await assert.rejects(scan([entry(1, 'cat', 'Selected'), delayed], { onScan: hook => {
        hook.recursionDelay.currentLevel = 999;
    } }), { code: 'ROLEPLAY_INVALID' });
});

test('the account captures saved books and refuses a changed book before the provider runs', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    const filename = path.join(f.scope.directories.worlds, 'Town.json');
    const book = { entries: { 7: entry(7, 'Original', 'The harbour is safe', { world: undefined, hash: undefined }) } };
    fs.writeFileSync(filename, JSON.stringify(book));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_depth: 2, world_info_budget: 100,
            world_info_recursive: true },
    }));
    const snapshot = captureRoleplayWorldInfo(f.scope, { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch },
        f.source(), { avatar: 'Nova.png', maxContext: 100 });
    assert.equal(snapshot.bookHashes.Town.length, 64);
    const first = await prepareRoleplayWorldInfo(f.scope, snapshot);
    assert.deepEqual(first.activated.map(value => value.uid), [7]);
    assert.equal(first.worldInfoBefore, 'The harbour is safe');
    assert.deepEqual(await prepareRoleplayWorldInfo(f.scope, snapshot), first);
    book.entries[7].content = 'Other harbour';
    fs.writeFileSync(filename, JSON.stringify(book));
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('production lore activation macros read only this job’s saved selection, including on replay', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        7: entry(7, 'Original', 'The harbour is safe', { comment: 'Harbour', world: undefined, hash: undefined }),
        8: entry(8, 'Elsewhere', 'Inactive lore', { comment: 'Other', world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        power_user: { experimental_macro_engine: true },
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'production-lore-macros', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 32, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    let calls = 0;
    const options = { generate: async ({ beforeDispatch, macroEnvironment }) => {
        beforeDispatch();
        assert.equal(macroEnvironment.evaluate('{{loreactive}}'), 'Harbour');
        assert.equal(macroEnvironment.evaluate('{{loreactive::;}}'), 'Harbour');
        assert.equal(macroEnvironment.evaluate('{{lorecount}}'), '1');
        assert.equal(macroEnvironment.evaluate('{{lorecount::bound}}'), '2');
        assert.equal(macroEnvironment.evaluate('{{lorebooks}}'), 'Town');
        assert.equal(macroEnvironment.evaluate('{{loreentries}}'), 'Harbour, Other');
        assert.equal(macroEnvironment.evaluate('{{loreentries::Town::;}}'), 'Harbour;Other');
        assert.equal(macroEnvironment.evaluate('{{loreentries::Missing}}'), '');
        assert.equal(macroEnvironment.evaluate('{{lore::Harbour}}'), 'The harbour is safe');
        assert.equal(macroEnvironment.evaluate('{{wi::7::Town}}'), 'The harbour is safe');
        assert.equal(macroEnvironment.evaluate('{{lorekeys::Harbour}}'), 'Original');
        assert.equal(macroEnvironment.evaluate('{{loreexists::Other}}'), 'true');
        assert.equal(macroEnvironment.evaluate('{{loreexists::Absent}}'), 'false');
        assert.equal(macroEnvironment.evaluate('{{lorefield::Harbour::content}}'), 'The harbour is safe');
        assert.equal(macroEnvironment.evaluate('{{lorefield::Harbour::uid}}'), '7');
        assert.equal(macroEnvironment.evaluate('{{lorefield::Harbour::__proto__}}'), '');
        assert.equal(macroEnvironment.evaluate('{{lorepick::Town}}'), 'Inactive lore');
        assert.equal(macroEnvironment.evaluate('{{loretokens}}'), String(Math.ceil('The harbour is safe'.length / 4)));
        assert.equal(macroEnvironment.evaluate('{{loretokens::bound}}'),
            String(Math.ceil('The harbour is safe\nInactive lore'.length / 4)));
        if (++calls === 1) throw Error('Provider unavailable');
        return { text: 'Saved reply' };
    } };
    await assert.rejects(runRoleplayReplyJob(context, options), /Provider unavailable/);
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info').activeLore[0].title, 'Harbour');
    await runRoleplayReplyJob(context, options);
    assert.equal(calls, 2);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Saved reply');
    const nextSource = captureRoleplaySource(f.scope, { locator: f.locator });
    const nextWorldInfo = captureRoleplayWorldInfo(f.scope, account, nextSource, { avatar: 'Nova.png', maxContext: 200 });
    const next = admitRoleplayJob(f.scope, account, { operationKey: 'next-lore-macros', effect: 'append', source: nextSource,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, serverPrompt: true, messages: [],
            maxTokens: 32, characterName: 'Nova', worldInfo: nextWorldInfo } });
    releaseJob(f.scope.directories, next.jobId);
    await runRoleplayReplyJob({ ...context, job: getJob(f.scope.directories, next.jobId) }, {
        generate: async ({ beforeDispatch, macroEnvironment }) => {
            beforeDispatch();
            assert.equal(macroEnvironment.evaluate('{{loreactive}}'), '');
            assert.equal(macroEnvironment.evaluate('{{lorecount}}'), '0');
            assert.equal(macroEnvironment.evaluate('{{lorecount::bound}}'), '2');
            return { text: 'Next reply' };
        },
    });
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info').activeLore[0].title, 'Harbour');
});

test('disabled MacroEnhanced aliases cannot activate server lore macros', t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        power_user: { experimental_macro_engine: true },
        extension_settings: { disabledExtensions: ['MacroEnhanced'] },
    }));
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    assert.equal(snapshot.enhancedLoreMacros, false);
});

test('saved books and outlets named like object properties keep their own content', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, '__proto__.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'Prototype lore', { world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['__proto__'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    assert.equal(Object.hasOwn(snapshot.bookHashes, '__proto__'), true);
    assert.equal((await prepareRoleplayWorldInfo(f.scope, snapshot)).worldInfoBefore, 'Prototype lore');
    const outlet = await scan([entry(2, 'cat', 'Outlet lore', { position: 7, outletName: 'constructor' })]);
    assert.deepEqual(outlet.outletEntries.constructor, ['Outlet lore']);
});

test('an entries-loaded hook cannot add a book entry outside the saved selection', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'cat', 'Allowed', { world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot, { onEntriesLoaded: lore => {
        lore.globalLore.push(entry(2, 'cat', 'Not in the saved book'));
    } }), { code: 'ROLEPLAY_INVALID' });
});

test('a scan refuses book edits made while an asynchronous hook is running', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    const filename = path.join(f.scope.directories.worlds, 'Town.json');
    const book = { entries: { 1: entry(1, 'Original', 'Saved lore', { world: undefined, hash: undefined }) } };
    fs.writeFileSync(filename, JSON.stringify(book));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot, { onScan: async () => {
        book.entries[1].content = 'Changed during hook';
        fs.writeFileSync(filename, JSON.stringify(book));
    } }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('a saved scan refuses changed settings or a reset before reading new account books', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {} }));
    const filename = path.join(f.scope.directories.root, 'settings.json');
    fs.writeFileSync(filename, JSON.stringify({ world_info_settings: { world_info: { globalSelect: ['Town'] } } }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    fs.writeFileSync(filename, JSON.stringify({ world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_depth: 3 } }));
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    resetRoleplayAccount(f.scope, account, 'reset');
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
});

test('a fabricated scan input cannot replace saved chat or lore controls before dispatch', async t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    const fabricated = structuredClone(snapshot);
    fabricated.chat = ['Invented keyword'];
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, fabricated), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    fabricated.chat = snapshot.chat;
    fabricated.global.personaDescription = 'Invented persona';
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, fabricated), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('saved default name inclusion activates speaker keys before provider work', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'User:', 'The user speaks', { world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    assert.ok(snapshot.chat.some(line => line.startsWith('User:')));
    const selected = await prepareRoleplayWorldInfo(f.scope, snapshot);
    assert.equal(selected.worldInfoBefore, 'The user speaks');
});

test('ordinary hidden system messages do not trigger saved World Info', async t => {
    const f = fixture(t);
    f.records.push({ name: 'System', is_user: false, is_system: true, mes: 'Hidden keyword' });
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Hidden keyword', 'Unexpected lore', { world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    assert.ok(snapshot.chat.every(text => !text.includes('Hidden keyword')));
    assert.equal((await prepareRoleplayWorldInfo(f.scope, snapshot)).activated.length, 0);
});

test('a saved swipe trigger selects only swipe lore and remains bound to that effect', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'Swipe lore', { world: undefined, hash: undefined, triggers: ['swipe'] }),
        2: entry(2, 'Original', 'Normal lore', { world: undefined, hash: undefined, triggers: ['normal'] }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const swipe = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100, trigger: 'swipe' });
    assert.equal((await prepareRoleplayWorldInfo(f.scope, swipe)).worldInfoBefore, 'Swipe lore');
    assert.equal((await prepareRoleplayWorldInfo(f.scope, captureRoleplayWorldInfo(f.scope, account, source,
        { avatar: 'Nova.png', maxContext: 100 }))).worldInfoBefore, 'Normal lore');
    assert.throws(() => captureRoleplayWorldInfo(f.scope, account, source,
        { avatar: 'Nova.png', maxContext: 100, trigger: 'quiet' }), { code: 'ROLEPLAY_INVALID' });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, messages: [{ role: 'user', content: 'Original' }],
        maxTokens: 32, characterName: 'Nova', worldInfo: swipe };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'wrong-trigger', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { throw Error('Provider called'); } }),
        { code: 'ROLEPLAY_INVALID' });
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'), undefined);
});

test('a caller cannot enlarge the saved lore context beyond the bound provider limit', async t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 40 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'oversized-lore-context', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, messages: [{ role: 'user', content: 'Original' }],
            maxTokens: 32, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    let calls = 0;
    await assert.rejects(runRoleplayReplyJob(context, { contextLimit: () => 64,
        generate: () => { calls++; return { text: 'Unexpected reply' }; } }), { code: 'ROLEPLAY_INVALID' });
    assert.equal(calls, 0);
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'), undefined);
});

test('the response allowance is reserved before selecting any World Info', async t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 60 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'response-budget-lore', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, messages: [{ role: 'user', content: 'Original' }],
            maxTokens: 32, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    await assert.rejects(runRoleplayReplyJob({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal }, { contextLimit: () => 80,
        generate: () => { throw Error('Provider called'); } }), { code: 'ROLEPLAY_INVALID' });
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'), undefined);
});

test('active provider context is checked without trusting the accepted lore limit', async t => {
    const f = fixture(t);
    const saved = { _settingsRevision: 1, main_api: 'kobold', max_context: 64,
        active_generation: { api: 'kobold' }, kai_settings: { api_server: 'http://127.0.0.1:6000', preset_settings: 'gui' } };
    const filename = path.join(f.scope.directories.root, 'settings.json');
    fs.writeFileSync(filename, JSON.stringify(saved));
    const binding = captureGenerationBinding(f.scope.directories, { kind: 'active' }, { settingsRevision: 1 });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'bound-provider-limit', effect: 'append', source,
        request: { binding, messages: [{ role: 'user', content: 'Original' }], maxTokens: 32, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    let calls = 0;
    await assert.rejects(runReply({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal }, {
        generate: () => { calls++; return { text: 'Unexpected reply' }; },
    }), { code: 'ROLEPLAY_INVALID' });
    assert.equal(calls, 0);
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'), undefined);
});

test('saved World Info prompt transformations apply before the scan is saved', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'The old harbour', { world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
        extension_settings: { regex: [{ findRegex: '/old/g', replaceString: 'new', placement: [5],
            promptOnly: true, markdownOnly: false }] },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    const selected = await prepareRoleplayWorldInfo(f.scope, snapshot);
    assert.equal(selected.worldInfoBefore, 'The new harbour');
});

test('a saved World Info transformation cannot expand lore beyond the context limit', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'short', { world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
        extension_settings: { regex: [{ findRegex: '/short/g', replaceString: 'long '.repeat(200), placement: [5],
            promptOnly: true, markdownOnly: false }] },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot), { code: 'ROLEPLAY_INVALID' });
});

test('a macro-dependent World Info transformation refuses before dispatch', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'The old harbour', { world: undefined, hash: undefined }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
        extension_settings: { regex: [{ findRegex: '/old/g', replaceString: '{{user}}', placement: [5],
            promptOnly: true, markdownOnly: false }] },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    await assert.rejects(prepareRoleplayWorldInfo(f.scope, snapshot), { code: 'ROLEPLAY_INVALID' });
});

test('saved persona, card notes and character tags decide activation without browser state', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.characters, 'Nova.png'), writeCard(png, JSON.stringify({
        name: 'Nova', creator_notes: 'The sentinel', data: { name: 'Nova', creator_notes: 'The sentinel',
            extensions: { depth_prompt: { prompt: 'The beacon' } } },
    })));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'The visitor', 'Persona lore', { matchPersonaDescription: true }),
        2: entry(2, 'The sentinel', 'Notes lore', { matchCreatorNotes: true }),
        3: entry(3, 'The beacon', 'Depth lore', { matchCharacterDepthPrompt: true }),
        4: entry(4, 'Original', 'Filtered lore', { characterFilter: { tags: ['absent'], isExclude: false } }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        power_user: { persona_description: 'The visitor' },
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 100 });
    assert.equal(snapshot.global.personaDescription, 'The visitor');
    assert.equal(snapshot.global.creatorNotes, 'The sentinel');
    assert.equal(snapshot.global.characterDepthPrompt, 'The beacon');
    const result = await prepareRoleplayWorldInfo(f.scope, snapshot);
    assert.deepEqual(result.activated.map(value => value.uid), [1, 2, 3]);
});

test('the worker saves scan decisions before a provider call and closes timed effects with the reply', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        7: entry(7, 'Original', 'The harbour is safe', { hash: undefined, world: undefined, sticky: 2 }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_depth: 2, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, messages: [{ role: 'user', content: 'Forged' }],
        historyStart: 0, maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'lore', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    let hooks = 0;
    let calls = 0;
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { throw Error('Provider called'); } }),
        { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.ok(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'));
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
    const valid = { ...request, messages: [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }] };
    const admitted = admitRoleplayJob(f.scope, account, { operationKey: 'lore-bound', effect: 'append', source, request: valid });
    releaseJob(f.scope.directories, admitted.jobId);
    const boundContext = { ...context, job: getJob(f.scope.directories, admitted.jobId) };
    const options = { worldInfoHooks: { onScan: async () => { hooks++; } },
        generate: async ({ beforeDispatch, messages }) => {
            beforeDispatch();
            assert.equal(readArtifact(f.scope.directories, admitted.jobId, 'roleplay-world-info').activated[0].uid, 7);
            assert.deepEqual(messages[0], { role: 'system', content: 'The harbour is safe' });
            assert.equal(valid.messages[0].content, 'Original');
            if (++calls === 1) throw new Error('Provider never reached');
            return { text: 'The answer' };
        } };
    await assert.rejects(runRoleplayReplyJob(boundContext, options), /Provider never reached/);
    await runRoleplayReplyJob(boundContext, options);
    assert.equal(hooks, 2);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'The answer');
    assert.equal(readRoleplayChat(f.scope, f.locator).records[0].chat_metadata.timedWorldInfo.sticky['Town.7'].end, 4);
});

test('a saved scan cannot dispatch after its book changes between attempts', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    const filename = path.join(f.scope.directories.worlds, 'Town.json');
    const book = { entries: { 1: entry(1, 'Original', 'Saved lore', { world: undefined, hash: undefined }) } };
    fs.writeFileSync(filename, JSON.stringify(book));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'changed-after-scan', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, maxTokens: 32, characterName: 'Nova',
            historyStart: 0, messages: [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }], worldInfo } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { throw Error('Provider unavailable'); } }),
        /Provider unavailable/);
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info').worldInfoBefore, 'Saved lore');
    book.entries[1].content = 'Changed lore';
    fs.writeFileSync(filename, JSON.stringify(book));
    let calls = 0;
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { calls++; return { text: 'Wrong' }; } }),
        { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(calls, 0);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
    book.entries[1].content = 'Saved lore';
    fs.writeFileSync(filename, JSON.stringify(book));
    const admitted = admitRoleplayJob(f.scope, account, { operationKey: 'changed-before-dispatch', effect: 'append', source,
        request: context.job.intent.request });
    releaseJob(f.scope.directories, admitted.jobId);
    await assert.rejects(runRoleplayReplyJob({ ...context, job: getJob(f.scope.directories, admitted.jobId) }, {
        generate: ({ beforeDispatch }) => {
            book.entries[1].content = 'Changed before dispatch';
            fs.writeFileSync(filename, JSON.stringify(book));
            beforeDispatch();
            calls++;
            return { text: 'Wrong' };
        },
    }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(calls, 0);
});

test('a selected Quick Reply automation refuses before paid provider work', async t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'Automated lore', { world: undefined, hash: undefined, automationId: 'quick-reply-1' }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' },
        messages: [{ role: 'user', content: 'Original' }], maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'automation-lore', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { throw Error('Provider called'); } }),
        { code: 'ROLEPLAY_INVALID' });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
});

test('a saved World Info selection cannot name another chat in a paid Roleplay job', async t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' },
        messages: [{ role: 'user', content: 'Original' }], maxTokens: 32, characterName: 'Nova',
        worldInfo: { account, source: { ...source, locator: { ...source.locator, chat: 'Other' } },
            avatar: 'Nova.png' } };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'foreign-lore', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { throw Error('Provider called'); } }),
        { code: 'ROLEPLAY_INVALID' });
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'), undefined);
});

test('a group World Info selection cannot borrow a character outside its saved members', async t => {
    const f = fixture(t, true);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    fs.writeFileSync(path.join(f.scope.directories.characters, 'Outside.png'), writeCard(png, JSON.stringify({
        name: 'Outside', description: 'A different group member',
    })));
    assert.throws(() => captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Outside.png', maxContext: 100 }),
        { code: 'ROLEPLAY_INVALID' });
});

test('a bound reply places saved card and lore examples before history without repeating provider work', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(f.scope.directories.characters, 'Nova.png'), writeCard(png, JSON.stringify({
        name: 'Nova', mes_example: '<START>\nUser: Card\nNova: Sample',
    })));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'User: Before\nNova: First', { world: undefined, hash: undefined, position: 5 }),
        2: entry(2, 'Original', 'User: After\nNova: Last', { world: undefined, hash: undefined, position: 6 }),
        3: entry(3, 'Original', 'Nearby', { world: undefined, hash: undefined, position: 4, depth: 0 }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, historyStart: 1,
        messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Original' },
            { role: 'assistant', content: 'Answer' }], maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'saved-examples', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    let calls = 0;
    const options = { generate: async ({ beforeDispatch, messages }) => {
        beforeDispatch();
        calls++;
        assert.deepEqual(messages.map(value => value.content), ['Rules', 'Before', 'First', 'Card', 'Sample',
            'After', 'Last', 'Original', 'Answer', 'Nearby']);
        return { text: 'Saved answer' };
    } };
    await runRoleplayReplyJob(context, options);
    await runRoleplayReplyJob(context, options);
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Saved answer');
});

test('an admitted reply places World Info around the saved active Author\'s Note', async t => {
    const f = fixture(t);
    f.records[0].chat_metadata = { note_prompt: 'Saved note', note_interval: 1, note_position: 1,
        note_depth: 0, note_role: 0 };
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'Above', { position: 2 }),
        2: entry(2, 'Original', 'Below', { position: 3 }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, historyStart: 0,
        messages: [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }],
        maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'saved-note', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await runRoleplayReplyJob(context, { generate: async ({ beforeDispatch, messages }) => {
        beforeDispatch();
        assert.deepEqual(messages.map(message => message.content), ['Original', 'Answer', 'Above\nSaved note\nBelow']);
        return { text: 'Noted' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Noted');
});

test('an admitted reply places saved Author\'s Note lore before its bound story', async t => {
    const f = fixture(t);
    f.records[0].chat_metadata = { note_prompt: 'Saved note', note_interval: 1, note_position: 2,
        note_depth: 0, note_role: 0 };
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'Above', { position: 2 }),
        2: entry(2, 'Original', 'Below', { position: 3 }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        power_user: { context: { story_string: 'Story: {{description}}', story_string_position: 0 } },
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, historyStart: 0,
        messages: [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }],
        maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'saved-note-before-story', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await runRoleplayReplyJob(context, { generate: async ({ beforeDispatch, messages }) => {
        beforeDispatch();
        assert.deepEqual(messages.map(message => message.content), ['Above\nSaved note\nBelow', 'Story: Original', 'Original', 'Answer']);
        return { text: 'Noted' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Noted');
});

test('example blocks that exhaust the bound prompt limit refuse before paid work', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.characters, 'Nova.png'), writeCard(png, JSON.stringify({
        name: 'Nova', mes_example: '<START>\nUser: ' + Array.from({ length: 500 }, (_, i) => `card${i}`).join(' '),
    })));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'User: Short', { world: undefined, hash: undefined, position: 5 }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'example-overflow', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, historyStart: 0,
            messages: [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }],
            maxTokens: 32, characterName: 'Nova', worldInfo } });
    releaseJob(f.scope.directories, jobId);
    await assert.rejects(runRoleplayReplyJob({ job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal }, { contextLimit: () => 132,
        generate: () => { throw Error('Provider called'); } }), { code: 'ROLEPLAY_INVALID' });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
});

test('unsupported insertion positions refuse before provider dispatch and before changing the chat', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'A note', { position: 4, depth: 2 }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100 });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, messages: [{ role: 'user', content: 'Original' }],
        maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'depth', effect: 'append', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { generate: () => { throw new Error('Provider called'); } }),
        { code: 'ROLEPLAY_INVALID' });
    assert.ok(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'));
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length);
    const bound = { ...request, historyStart: 0, messages: [{ role: 'user', content: 'Original' },
        { role: 'assistant', content: 'Answer' }] };
    const forged = admitRoleplayJob(f.scope, account, { operationKey: 'depth-forged', effect: 'append', source,
        request: { ...bound, messages: [{ role: 'user', content: 'Forged' }] } });
    releaseJob(f.scope.directories, forged.jobId);
    await assert.rejects(runRoleplayReplyJob({ ...context, job: getJob(f.scope.directories, forged.jobId) },
        { generate: () => { throw Error('Provider called'); } }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    const admitted = admitRoleplayJob(f.scope, account, { operationKey: 'depth-bound', effect: 'append', source, request: bound });
    releaseJob(f.scope.directories, admitted.jobId);
    const next = { ...context, job: getJob(f.scope.directories, admitted.jobId) };
    await runRoleplayReplyJob(next, { generate: async ({ beforeDispatch, messages }) => {
        beforeDispatch();
        assert.deepEqual(messages.map(value => value.content), ['A note', 'Original', 'Answer']);
        return { text: 'Answer' };
    } });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.at(-1).mes, 'Answer');
});

test('a saved timed window refuses delivery after the chat grows while the provider was away', async t => {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: entry(1, 'Original', 'A note', { sticky: 2 }),
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator, message: 0 });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 100, trigger: 'swipe' });
    const request = { binding: { profileId: 'saved', fingerprint: 'bound' }, historyStart: 0,
        messages: [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }],
        maxTokens: 32, characterName: 'Nova', worldInfo };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'timed-swipe', effect: 'swipe', source, request });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { generate: async () => { throw Error('outcome unknown'); } }), /outcome unknown/);
    const saved = readArtifact(f.scope.directories, jobId, 'roleplay-world-info');
    assert.equal(saved.chatLength, 2);
    const { commitSingleChatWrite } = await import('../src/roleplay-lifecycle.js');
    const { captureRoleplayStorageSource } = await import('../src/generation/roleplay-source.js');
    commitSingleChatWrite(f.scope, { operationKey: 'unrelated', sourceKind: 'storage', mode: 'update',
        source: captureRoleplayStorageSource(f.scope, f.locator),
        records: [...readRoleplayChat(f.scope, f.locator).records, { name: 'User', is_user: true, mes: 'Later' }],
        backup: { deferBackup: true } }, roleplayNativeHost);
    assert.throws(() => applyRoleplayJobEffect(f.scope, account, { operationKey: 'timed-swipe', jobId,
        output: { text: 'Later swipe', timedWorldInfo: saved.timedWorldInfo,
            timedBaseline: saved.timedBaseline, timedChatLength: saved.chatLength } }, roleplayNativeHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(readRoleplayChat(f.scope, f.locator).records.length, f.records.length + 1);
});
