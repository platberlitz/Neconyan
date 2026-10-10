import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';

const { SETTINGS_FILE } = await import('../src/constants.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { getJob, requestCancellation } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { testExports: { runJob }, setDirectoriesResolver } = await import('../src/jobs/runner.js');
const { acceptScratchpadReply, finalizeScratchpadSubmission, registerScratchpadJobs, testExports: jobs } = await import('../src/scratchpad/jobs.js');
const store = await import('../src/scratchpad/store.js');
const { buildScratchpadMessages, buildScratchpadSystemPrompt } = await import('../src/scratchpad/prompt.js');
const { readScratchpadPreview } = await import('../src/scratchpad/preview.js');
const { router } = await import('../src/endpoints/scratchpad.js');
const notebooks = await import('../src/notebooks/store.js');
const notebookAssistant = await import('../src/notebooks/assistant.js');
const { applyPolicyPatch } = await import('../src/notebooks/permissions.js');
const { readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { commitRoleplayLifecycleLocked } = await import('../src/roleplay-lifecycle.js');
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');
const { splitReply } = await import('../public/scripts/scratchpad/proposals.js');
const { characterToolReply, scratchpadCharacterTools } = await import('../src/scratchpad/character-tools.js');

after(() => cancelAutoSaves());

const SOURCE = { kind: 'roleplay', key: 'Nova.png::Source', label: 'Nova' };
const OTHER = { kind: 'conversation', key: 'Nova.png::main', label: 'Nova' };
let counter = 0;

function account(t, { oai = {}, model = 'gpt-4o' } = {}) {
    const f = fixture(t, false, 'scratch');
    const directories = f.scope.directories;
    fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify({
        _version: 0,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model }] } },
        oai_settings: { chat_completion_source: 'openai', ...oai },
    }));
    setDirectoriesResolver(() => directories);
    const request = body => ({ user: { profile: { handle: f.scope.owner }, directories }, get: () => undefined, body });
    const base = store.scratchpadAccountBase(request({}));
    const mutate = (source, change) => store.mutateBucket(base, source, change);
    const read = source => store.withScratchpad(base, lease => store.readBucketLocked(lease, source));
    return { f, directories, request, base, mutate, read };
}

function startSession(a, settings = {}) {
    return a.mutate(SOURCE, bucket => store.createSession(bucket, {
        assistant: 'taro', settings: { connection: { kind: 'profile', profileId: 'saved' }, ...settings },
    }));
}

function sendBody(session, extra = {}) {
    return {
        submissionKey: `send-${++counter}`,
        source: SOURCE,
        sessionId: session.id,
        text: 'What is Nova hiding in this scene?',
        context: '#1 User: Original\n#2 Nova: Answer',
        capabilities: { lore: true, character: true, chat: true },
        names: { user: 'Kris', character: 'Nova' },
        ...extra,
    };
}

test('a reply accepted with the old filename still settles after a protected chat rename', async t => {
    const a = account(t);
    const id = readRoleplayChat(a.f.scope, a.f.locator).instanceId;
    const legacy = { kind: 'roleplay', key: `character:${a.f.locator.avatar}:${a.f.locator.chat}`, label: 'Old chat' };
    const session = a.mutate(legacy, bucket => store.createSession(bucket, { settings: { connection: { kind: 'profile', profileId: 'saved' } } }));
    registerScratchpadJobs({ generate: async () => ({ text: 'This unfinished reply was kept.' }) });
    const body = sendBody(session, { source: legacy });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    store.withScratchpad(a.base, lease => commitRoleplayLifecycleLocked(lease, { operationKey: 'rename-with-old-job', action: 'chat-rename',
        intent: { chat: 'Renamed' }, steps: [{ op: 'move', kind: 'chat', locator: a.f.locator, destination: { ...a.f.locator, chat: 'Renamed' } }] }, roleplayNativeHost));
    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
    const source = { kind: 'roleplay', key: `roleplay:${id}`, legacyKey: `character:${a.f.locator.avatar}:Renamed`, label: 'Renamed' };
    const messages = a.read(source).sessions[0].messages;
    assert.equal(messages[1].state, 'done');
    assert.equal(messages[1].text, 'This unfinished reply was kept.');
    assert.equal(a.read(legacy).sessions[0].messages[1].id, messages[1].id);
});

test('a reply runs as a server job, streams a preview and settles into the saved session', async t => {
    const a = account(t);
    const session = startSession(a);
    let seen;
    registerScratchpadJobs({ generate: async options => {
        seen = options;
        options.onStream({ text: 'Nova is', reasoning: 'thinking' });
        assert.equal(readScratchpadPreview(a.f.scope.owner, options.jobContext.job.id).text, 'Nova is');
        options.onStream({ text: 'Nova is hiding' });
        assert.equal(readScratchpadPreview(a.f.scope.owner, options.jobContext.job.id).reasoning, 'thinking', 'text-only chunks keep the thinking preview');
        return { text: '  Nova is hiding the letter.  ', response: { choices: [{ message: { reasoning_content: 'thought it through' } }] } };
    } });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    assert.equal(accepted.created, true);
    const pending = accepted.bucket.sessions[0].messages;
    assert.deepEqual(pending.map(message => [message.role, message.state ?? null]), [['user', null], ['assistant', 'pending']]);

    const again = await acceptScratchpadReply(a.request(body), body);
    assert.equal(again.created, false);
    assert.equal(again.job.id, accepted.job.id, 'a retried send returns the same job instead of sending twice');
    await assert.rejects(acceptScratchpadReply(a.request(sendBody(session)), sendBody(session)), error => error.code === 'SCRATCHPAD_REPLY_PENDING');

    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
    const [user, reply] = a.read(SOURCE).sessions[0].messages;
    assert.equal(user.text, 'What is Nova hiding in this scene?');
    assert.equal(reply.state, 'done');
    assert.equal(reply.text, 'Nova is hiding the letter.');
    assert.equal(reply.reasoning, 'thought it through');
    assert.equal(reply.assistant, 'taro');
    assert.equal(seen.binding.kind, 'profile');
    assert.equal(seen.stream, true);
    assert.equal(seen.maxTokens, 32000, 'new sessions send the new reply limit to the model');
    assert.equal(seen.preparedMessages, true);
    assert.equal(seen.characterName, 'Taro');
    assert.equal(seen.macroEnvironment.extra.characterScope, 'none', 'Scratchpad never speaks as a chat character, so character output rules are skipped');
    assert.match(seen.messages[0].content, /You are Taro/);
    assert.match(seen.messages[1].content, /<story_context>\n#1 User: Original/);
    assert.equal(seen.messages.at(-1).content, 'What is Nova hiding in this scene?');
    assert.deepEqual(readArtifact(a.directories, accepted.job.id, 'result'), { replyId: reply.id, sessionId: session.id });
});

for (const stream of [true, false]) {
    test(`long answers and thinking survive saving and reopening with streaming=${stream}`, async t => {
        const a = account(t);
        const session = startSession(a, { stream });
        const text = 'A complete paragraph. '.repeat(6000) + 'The final answer sentence.';
        const reasoning = 'Checking another detail. '.repeat(8000) + 'The final thinking sentence.';
        assert.ok(Buffer.byteLength(text) > 64 * 1024);
        assert.ok(Buffer.byteLength(reasoning) > 64 * 1024);
        registerScratchpadJobs({ generate: async options => {
            assert.equal(options.stream, stream);
            if (stream) options.onStream({ text, reasoning });
            return { text, response: { choices: [{ message: { content: text, reasoning_content: reasoning } }] } };
        } });
        const body = sendBody(session);
        const accepted = await acceptScratchpadReply(a.request(body), body);
        await runJob(getJob(a.directories, accepted.job.id));
        assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
        const reply = a.read(SOURCE).sessions[0].messages.at(-1);
        assert.equal(reply.text, text);
        assert.equal(reply.reasoning, reasoning);
        assert.equal(reply.state, 'done');
    });
}

for (const roundTable of [false, true]) {
    test(`streaming off is captured for every accepted reply, round table=${roundTable}`, async t => {
        const a = account(t);
        const session = startSession(a, { stream: false, roundTable });
        assert.equal(a.read(SOURCE).sessions[0].settings.stream, false);
        let calls = 0;
        registerScratchpadJobs({ generate: async options => {
            calls++;
            assert.equal(options.stream, false);
            options.onStream({ text: 'Do not show a partial reply.', reasoning: 'Private until finished.' });
            const preview = readScratchpadPreview(a.f.scope.owner, options.jobContext.job.id);
            for (const reply of preview.replies ? Object.values(preview.replies) : [preview]) {
                if (reply.stage === 'generating') assert.equal(reply.text + reply.reasoning, '');
            }
            return { text: 'Finished reply.', response: { choices: [{ message: { reasoning_content: 'Finished thinking.' } }] } };
        } });
        const body = sendBody(session);
        const accepted = await acceptScratchpadReply(a.request(body), body);
        a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { stream: true } }));
        await runJob(getJob(a.directories, accepted.job.id));
        assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
        assert.equal(calls, roundTable ? 3 : 1);
        for (const reply of a.read(SOURCE).sessions[0].messages.filter(message => message.role === 'assistant')) {
            assert.equal(reply.text, 'Finished reply.');
            assert.equal(reply.reasoning, 'Finished thinking.');
        }
    });
}

test('streaming defaults on and a saved choice survives unrelated settings and new sessions', t => {
    const a = account(t);
    assert.equal(store.normaliseSettings({}).stream, true);
    assert.equal(store.normaliseSettings({ stream: 'false' }).stream, true);
    const session = startSession(a, { stream: false });
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { depth: 3 } }));
    assert.equal(a.read(SOURCE).sessions[0].settings.stream, false);
    const next = a.mutate(SOURCE, bucket => store.createSession(bucket));
    assert.equal(next.settings.stream, false);
});

test('the reply limit defaults to 32000 without replacing saved limits', t => {
    assert.equal(store.normaliseSettings({}).maxTokens, 32000);
    assert.equal(store.normaliseSettings({ maxTokens: 'invalid' }).maxTokens, 32000);
    const a = account(t);
    const session = startSession(a, { maxTokens: 16000 });
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { stream: false } }));
    assert.equal(a.read(SOURCE).sessions[0].settings.maxTokens, 16000);
    assert.equal(a.mutate(SOURCE, bucket => store.createSession(bucket)).settings.maxTokens, 16000);
});

test('long replies fit with room to spare and a full Scratchpad file explains what to do', t => {
    const a = account(t);
    const session = startSession(a);
    const long = 'x'.repeat(store.MAX_MESSAGE_BYTES);
    a.mutate(SOURCE, bucket => {
        const target = bucket.sessions.find(item => item.id === session.id);
        for (let index = 0; index < 6; index++) {
            target.messages.push({ id: `long-${index}`, role: 'assistant', assistant: 'taro', state: 'done', text: long, reasoning: long, created: new Date().toISOString() });
        }
    });
    assert.equal(a.read(SOURCE).sessions[0].messages.length, 6);
    assert.throws(() => a.mutate(SOURCE, bucket => {
        const target = bucket.sessions.find(item => item.id === session.id);
        for (let index = 6; index < 10; index++) {
            target.messages.push({ id: `long-${index}`, role: 'assistant', assistant: 'taro', state: 'done', text: long, reasoning: long, created: new Date().toISOString() });
        }
    }), error => error.code === 'SCRATCHPAD_STORAGE_FULL' && error.status === 413 && /Delete old sessions/.test(error.message));
    assert.equal(a.read(SOURCE).sessions[0].messages.length, 6);
});

test('edited replies keep the long reply limit while typed messages keep the short one', () => {
    const bucket = { sessions: [{ id: 's1', messages: [
        { id: 'u1', role: 'user', text: 'question' },
        { id: 'r1', role: 'assistant', assistant: 'taro', state: 'done', text: 'answer' },
    ] }] };
    assert.equal(store.updateMessage(bucket, 's1', 'r1', 'z'.repeat(store.MAX_INPUT_BYTES + 1)).text.length, store.MAX_INPUT_BYTES + 1);
    assert.throws(() => store.updateMessage(bucket, 's1', 'u1', 'z'.repeat(store.MAX_INPUT_BYTES + 1)), error => error.code === 'SCRATCHPAD_TEXT_TOO_LARGE');
    assert.equal(store.updateMessage(bucket, 's1', 'u1', 'z'.repeat(store.MAX_INPUT_BYTES)).text.length, store.MAX_INPUT_BYTES);
});

test('finished thinking is retained across provider formats when streaming is off', () => {
    const cases = [
        ['claude', { content: [{ type: 'thinking', thinking: 'Consider the scene.' }, { type: 'text', text: 'Answer.' }] }],
        ['makersuite', { responseContent: { parts: [{ thought: true, text: 'Consider the scene.' }, { text: 'Answer.' }] } }],
        ['mistralai', { choices: [{ message: { content: [{ thinking: [{ text: 'Consider the scene.' }] }] } }] }],
        ['custom', { choices: [{ message: { reasoning_content: 'Consider the scene.' } }] }],
    ];
    for (const [source, response] of cases) assert.equal(jobs.reasoningFrom({ response, generation: { backend: 'chat', source } }), 'Consider the scene.');
    assert.equal(jobs.reasoningFrom({ response: { thinking: 'Consider the scene.' }, generation: { backend: 'text', source: 'ollama' } }), 'Consider the scene.');
});

function sharedNote(a) {
    return store.withScratchpad(a.base, lease => {
        const notebookId = notebooks.ensureDefaultNotebookLocked(lease).id;
        const created = notebooks.createNoteLocked(lease, { notebookId, title: 'Plan', text: 'A saved idea.', operationId: `fixture-note-${++counter}` });
        notebooks.writePoliciesLocked(lease, notebookId, applyPolicyPatch(notebooks.readPoliciesLocked(lease, notebookId), { assistant: 'edit' }));
        return { notebookId, noteId: created.noteId, revision: created.revision };
    });
}

for (const roundTable of [false, true]) {
    test(`native character calls become durable review cards, round table=${roundTable}`, async t => {
        const a = account(t, { oai: { function_calling: true } });
        const session = startSession(a, { roundTable, assistantPrompts: { taro: 'Be a concise editor.' } });
        const before = fs.readdirSync(a.directories.characters);
        let generated = 0;
        registerScratchpadJobs({ generate: async options => {
            generated++;
            assert.equal(options.generationType, 'quiet', 'tools must not turn a side request into a main chat turn');
            assert.deepEqual(options.functionTools.map(tool => tool.function.name), ['Neconyan_Assistant_CreateCharacter']);
            assert.match(options.messages[0].content, /Nothing|does not save/);
            return { text: '', response: { choices: [{ message: { tool_calls: [{ id: 'create-card', type: 'function', function: {
                name: 'Neconyan_Assistant_CreateCharacter', arguments: JSON.stringify({ character: { name: options.characterName + ' draft',
                    description: 'Keeps a journal.\n```text\nAn excerpt.\n```', first_mes: '{{char}} smiles at {{user}}.' },
                characterNote: '[curious;]', alternateGreetings: ['An alternate greeting.'] }),
            } }] } }] } };
        } });
        const body = sendBody(session, { capabilities: {}, context: '' });
        const accepted = await acceptScratchpadReply(a.request(body), body);
        await runJob(getJob(a.directories, accepted.job.id));
        assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
        const replies = a.read(SOURCE).sessions[0].messages.filter(message => message.role === 'assistant');
        assert.equal(replies.length, roundTable ? 3 : 1);
        for (const reply of replies) {
            assert.equal(reply.state, 'done');
            const parts = splitReply(reply.text);
            assert.equal(parts.length, 1);
            assert.equal(parts[0].error, '');
            assert.equal(parts[0].change.action, 'create');
            assert.match(parts[0].change.character.description, /```text/);
            assert.equal(parts[0].change.character.first_mes, '{{char}} smiles at {{user}}.');
            assert.deepEqual(parts[0].change.alternateGreetings, ['An alternate greeting.']);
        }
        assert.deepEqual(fs.readdirSync(a.directories.characters), before, 'the owner has not saved a review yet');
        await jobs.runScratchpadReply({ directories: a.directories, job: getJob(a.directories, accepted.job.id) }, { generate: () => { throw new Error('Must not regenerate'); } });
        assert.equal(generated, replies.length);
        assert.deepEqual(a.read(SOURCE).sessions[0].messages.filter(message => message.role === 'assistant'), replies);
    });
}

for (const [label, options] of [
    ['function calling is off', { oai: { function_calling: false } }],
    ['the model only takes tools through the Responses API', { oai: { function_calling: true }, model: 'gpt-6-astra' }],
    ['prompt post-processing strips tools', { oai: { function_calling: true, custom_prompt_post_processing: 'single' } }],
]) {
    test(`Scratchpad asks for a text draft instead of sending tools when ${label}`, async t => {
        const a = account(t, options);
        const session = startSession(a);
        let seen;
        registerScratchpadJobs({ generate: async request => {
            seen = request;
            return { text: 'Plain answer.' };
        } });
        const body = sendBody(session);
        const accepted = await acceptScratchpadReply(a.request(body), body);
        await runJob(getJob(a.directories, accepted.job.id));
        assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
        assert.deepEqual(seen.functionTools, []);
        assert.equal(seen.generationType, 'quiet');
        assert.match(seen.messages[0].content, /Without function tools, write the same draft in a scratchpad-change fenced JSON block/);
        assert.equal(a.read(SOURCE).sessions[0].messages[1].text, 'Plain answer.');
    });
}

test('character tools normalise provider formats and reject unsupported or malformed calls', () => {
    const tools = scratchpadCharacterTools();
    const name = tools[0].function.name;
    const args = { character: { name: 'Nova' } };
    for (const response of [
        { output: [{ type: 'function_call', call_id: 'call', name, arguments: JSON.stringify(args) }] },
        { content: [{ type: 'tool_use', id: 'call', name, input: args }] },
        { candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] },
    ]) {
        assert.equal(splitReply(characterToolReply({ response }, tools).text)[0].change.character.name, 'Nova');
        assert.throws(() => characterToolReply({ response }, []), /unregistered/);
    }
    const response = argumentsText => ({ response: { output: [{ type: 'function_call', call_id: 'call', name, arguments: argumentsText }] } });
    assert.throws(() => characterToolReply(response('{'), tools), /not JSON/);
    const kept = characterToolReply({ ...response('{"character":{"name":"../bad"}}'), text: 'Here is my idea.' }, tools);
    assert.match(kept.text, /^Here is my idea\.\n\nA character draft could not be used: .*path separators/, 'one bad draft keeps the reply text');
    assert.equal(splitReply(kept.text).some(part => part.change), false);
    assert.match(characterToolReply(response('{"character":{"name":"Nova","extensions":{}}}'), tools).text, /Invalid character field/);
    assert.deepEqual(characterToolReply({ text: 'Ordinary reply.' }, []), { text: 'Ordinary reply.', hasTools: false });
    assert.throws(() => characterToolReply({ ...response(JSON.stringify(args)), text: '```scratchpad-change\n{}\n```\n'.repeat(24) }, tools), /24 changes/);
});

test('server-built note context reaches the provider and finished suggestions register one shared review without saving', async t => {
    const a = account(t);
    const note = sharedNote(a);
    const session = startSession(a, { notes: [{ notebookId: note.notebookId, noteId: note.noteId }], assistantPrompts: { taro: 'Be brief.' } });
    let seen;
    const suggestion = { type: 'notebook', action: 'append-note', args: { notebookId: note.notebookId, noteId: note.noteId, expectedRevision: note.revision, markdown: 'Another idea.' } };
    registerScratchpadJobs({ generate: async options => {
        seen = options.messages;
        return { text: `Useful advice.\n\`\`\`scratchpad-change\n${JSON.stringify(suggestion)}\n\`\`\`` };
    } });
    const body = sendBody(session, { notebookContext: 'Forged note text.', capabilities: { notebook: false } });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    assert.match(seen[0].content, /^Be brief\./);
    assert.match(seen[0].content, /edit-note-selection/);
    assert.match(seen.find(message => message.content.startsWith('<notebook_context>')).content, /A saved idea\./);
    assert.ok(!JSON.stringify(seen).includes('Forged note text.'));
    const reply = a.read(SOURCE).sessions[0].messages.at(-1);
    assert.equal(reply.state, 'done');
    assert.match(reply.notebookProposals[0].id, /^p_[a-f0-9]{24}$/);
    store.withScratchpad(a.base, lease => {
        assert.equal(notebooks.readNoteLocked(lease, note).entry.text, 'A saved idea.');
        assert.equal(notebookAssistant.listProposalsLocked(lease).length, 1);
    });
});

for (const kind of ['text', 'permissions']) {
    test(`a note ${kind} change during send refuses the outdated snapshot before any provider call`, async t => {
        const a = account(t);
        const note = sharedNote(a);
        const session = startSession(a, { notes: [{ notebookId: note.notebookId, noteId: note.noteId }] });
        let calls = 0;
        registerScratchpadJobs({ generate: async () => { calls++; return { text: 'Never sent.' }; } });
        const body = sendBody(session);
        const sending = acceptScratchpadReply(a.request(body), body);
        store.withScratchpad(a.base, lease => {
            if (kind === 'text') notebooks.updateNoteLocked(lease, { ...note, expectedRevision: note.revision, operationId: `fixture-note-${++counter}`, changes: [{ type: 'append', markdown: 'Owner edit.' }] });
            else notebooks.writePoliciesLocked(lease, note.notebookId, applyPolicyPatch(notebooks.readPoliciesLocked(lease, note.notebookId), { assistant: 'none' }));
        });
        await assert.rejects(sending, error => error.code === 'SCRATCHPAD_NOTES_CHANGED');
        assert.equal(calls, 0);
        assert.equal(a.read(SOURCE).sessions[0].messages.length, 0);
    });
}

test('custom assistant prompts persist independently, reach the provider and reset to defaults', async t => {
    const a = account(t);
    const session = startSession(a, { assistantPrompts: { taro: 'Answer as a concise editor.', miso: 'Offer three ideas.' } });
    const prompts = [];
    registerScratchpadJobs({ generate: async options => { prompts.push(options.messages[0].content); return { text: 'A reply.' }; } });
    const body = sendBody(session, { help: 'Application reference.' });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    assert.match(prompts[0], /^Answer as a concise editor\./);
    assert.match(prompts[0], /Application reference\./);
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { assistantPrompts: { taro: null } } }));
    assert.deepEqual(a.read(SOURCE).sessions[0].settings.assistantPrompts, { miso: 'Offer three ideas.' });
    const next = sendBody(session);
    const reset = await acceptScratchpadReply(a.request(next), next);
    await runJob(getJob(a.directories, reset.job.id));
    assert.match(prompts[1], /You are Taro/);
    assert.doesNotMatch(prompts[1], /concise editor/);
    assert.throws(() => store.normaliseSettings({ assistantPrompts: { miso: ' ' } }), /Write a prompt/);
    assert.throws(() => store.normaliseSettings({ assistantPrompts: { miso: '字'.repeat(22000) } }), /Write a prompt/);
});

test('regenerating replaces only the latest reply and keeps earlier turns as history', async t => {
    const a = account(t);
    const session = startSession(a);
    const replies = ['First answer.', 'Second answer.', 'Better second answer.'];
    const prompts = [];
    registerScratchpadJobs({ generate: async options => {
        prompts.push(options.messages.slice(3).map(message => `${message.role}:${message.content}`));
        return { text: replies.shift() };
    } });
    for (const text of ['One?', 'Two?']) {
        const body = sendBody(session, { text });
        const accepted = await acceptScratchpadReply(a.request(body), body);
        await runJob(getJob(a.directories, accepted.job.id));
    }
    const before = a.read(SOURCE).sessions[0].messages;
    await assert.rejects(acceptScratchpadReply(a.request(sendBody(session, { regenerate: before[1].id })), sendBody(session, { regenerate: before[1].id })),
        error => error.code === 'SCRATCHPAD_REGENERATE_INVALID');
    const body = sendBody(session, { text: undefined, regenerate: before[3].id });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    const after = a.read(SOURCE).sessions[0].messages;
    assert.deepEqual(after.map(message => message.text), ['One?', 'First answer.', 'Two?', 'Better second answer.']);
    assert.equal(after[3].id === before[3].id, false);
    assert.deepEqual(prompts.at(-1), ['user:One?', 'assistant:First answer.', 'user:Two?']);
});

test('a failed or stopped reply is saved as failed and no longer blocks the session', async t => {
    const a = account(t);
    const session = startSession(a);
    registerScratchpadJobs({ generate: async () => { throw Object.assign(new Error('Provider said no.'), { status: 400 }); } });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    const failed = a.read(SOURCE).sessions[0].messages.at(-1);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, 'Provider said no.');

    registerScratchpadJobs({ generate: async () => ({ text: 'never runs' }) });
    const queued = sendBody(session, { text: 'Second try' });
    const second = await acceptScratchpadReply(a.request(queued), queued);
    requestCancellation(a.directories, second.job.id, { reason: 'test' });
    const projected = store.projectPending(a.read(SOURCE), id => getJob(a.directories, id)).sessions[0].messages.at(-1);
    assert.deepEqual([projected.state, projected.error], ['failed', 'Stopped.']);
    const third = sendBody(session, { text: 'Third try' });
    const resumed = await acceptScratchpadReply(a.request(third), third);
    assert.equal(resumed.created, true, 'a cancelled reply is settled instead of blocking the next message');
});

test('sessions are kept per source chat and temporary sessions disappear when another opens', async t => {
    const a = account(t);
    const kept = startSession(a);
    const temporary = a.mutate(SOURCE, bucket => store.createSession(bucket, { assistant: 'nori', temporary: true }));
    assert.equal(a.read(SOURCE).sessions.length, 2);
    a.mutate(SOURCE, bucket => store.activateSession(bucket, kept.id));
    assert.deepEqual(a.read(SOURCE).sessions.map(session => session.id), [kept.id]);
    assert.notEqual(temporary.id, kept.id);
    assert.equal(a.read(OTHER).sessions.length, 0, 'another chat starts with an empty Scratchpad');
    a.mutate(OTHER, bucket => store.createSession(bucket, { assistant: 'miso' }));
    assert.equal(a.read(OTHER).sessions[0].assistant, 'miso');
    assert.equal(a.read(SOURCE).sessions[0].assistant, 'taro');
    assert.notEqual(store.scratchpadFile(a.directories.root, SOURCE), store.scratchpadFile(a.directories.root, OTHER));
    a.mutate(SOURCE, bucket => store.updateSession(bucket, kept.id, { settings: { maxTokens: 4096 } }));
    assert.equal(a.read(SOURCE).sessions[0].settings.maxTokens, 4096, 'a saved reply limit is not replaced by a new default');
});

test('empty sessions follow the chosen assistant without overwriting custom or established names', t => {
    const a = account(t);
    const session = startSession(a);
    const switchTo = assistant => a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { assistant }));
    switchTo('nori');
    assert.equal(a.read(SOURCE).sessions[0].name, 'Nori\'s notes');
    switchTo('taro');
    assert.equal(a.read(SOURCE).sessions[0].name, 'Taro\'s notes');
    const other = a.mutate(SOURCE, bucket => store.createSession(bucket, { assistant: 'nori' }));
    switchTo('nori');
    assert.equal(a.read(SOURCE).sessions.find(item => item.id === session.id).name, 'Nori\'s notes 2');
    switchTo('nori');
    assert.equal(a.read(SOURCE).sessions.find(item => item.id === session.id).name, 'Nori\'s notes 2');
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { name: 'Miso\'s notes' }));
    switchTo('taro');
    assert.equal(a.read(SOURCE).sessions.find(item => item.id === session.id).name, 'Miso\'s notes', 'an explicitly chosen name stays even if it resembles a default');
    a.mutate(SOURCE, bucket => {
        store.findSession(bucket, other.id).messages.push({ id: 'question', role: 'user', text: 'An established discussion.' });
        store.updateSession(bucket, other.id, { assistant: 'miso' });
    });
    assert.equal(a.read(SOURCE).sessions.find(item => item.id === other.id).name, 'Nori\'s notes');
});

test('legacy empty sessions recognise generated names and preserve custom names', () => {
    const bucket = store.normaliseBucket({ version: 1, sessions: [
        { id: 'legacy', assistant: 'taro', name: 'Miso\'s notes 2', messages: [] },
        { id: 'custom', assistant: 'taro', name: 'My plan', messages: [] },
    ] }, SOURCE);
    store.updateSession(bucket, 'legacy', { assistant: 'nori' });
    store.updateSession(bucket, 'custom', { assistant: 'nori' });
    assert.equal(bucket.sessions[0].name, 'Nori\'s notes');
    assert.equal(bucket.sessions[1].name, 'My plan');
});

test('Conversation uses its saved chat connection without changing the session default', async t => {
    const a = account(t);
    const session = a.mutate(OTHER, bucket => store.createSession(bucket, { assistant: 'miso' }));
    const body = sendBody(session, { source: OTHER, chatProfileId: 'saved' });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    assert.equal(accepted.job.credentialRef.kind, 'profile');
    assert.equal(accepted.job.credentialRef.profileId, 'saved');
    assert.equal(a.read(OTHER).sessions[0].settings.connection.kind, 'current');
});

test('each assistant keeps its own connection when switching speakers and starting another session', async t => {
    const a = account(t);
    const file = path.join(a.directories.root, SETTINGS_FILE);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.extension_settings.connectionManager.profiles.push({ id: 'other', api: 'openai', model: 'gpt-4o-mini' });
    fs.writeFileSync(file, JSON.stringify(settings));
    const session = startSession(a);
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { assistantConnections: { miso: { kind: 'profile', profileId: 'other' } } } }));
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { assistantConnections: { nori: { kind: 'current' } } } }));
    assert.equal(store.assistantConnection(a.read(SOURCE).sessions[0].settings, 'taro').profileId, 'saved', 'existing session choices remain the fallback');
    const used = [];
    registerScratchpadJobs({ generate: async options => {
        used.push([options.characterName, options.binding.profileId]);
        return { text: 'A reply.' };
    } });
    for (const assistant of ['miso', 'taro', 'miso']) {
        a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { assistant }));
        const body = sendBody(session);
        const accepted = await acceptScratchpadReply(a.request(body), body);
        await runJob(getJob(a.directories, accepted.job.id));
    }
    assert.deepEqual(used, [['Miso', 'other'], ['Taro', 'saved'], ['Miso', 'other']]);
    const inherited = a.mutate(SOURCE, bucket => store.createSession(bucket, { assistant: 'nori' }));
    assert.deepEqual(inherited.settings.assistantConnections, { miso: { kind: 'profile', profileId: 'other' }, nori: { kind: 'current' } });
});

test('changing session settings while a send is prepared refuses the stale request', async t => {
    const a = account(t);
    const session = startSession(a);
    const body = sendBody(session);
    const sending = acceptScratchpadReply(a.request(body), body);
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { depth: 0 } }));
    await assert.rejects(sending, error => error.code === 'SCRATCHPAD_CHANGED');
    assert.equal(a.read(SOURCE).sessions[0].messages.length, 0);
});

test('round tables run all selected assistants together, keep successful replies and retry only the chosen speaker', { timeout: 10000 }, async t => {
    const a = account(t);
    const session = startSession(a, { roundTable: true, participants: ['miso', 'taro', 'nori'] });
    const started = Promise.withResolvers();
    const gates = new Map();
    registerScratchpadJobs({ generate: async options => {
        const gate = Promise.withResolvers();
        gates.set(options.characterName, gate);
        options.onStream({ text: `${options.characterName} thinking` });
        options.onStream({ text: `${options.characterName} thinking`, reasoning: `${options.characterName} reasoning` });
        if (gates.size === 3) started.resolve();
        return gate.promise;
    } });
    const body = sendBody(session, { text: 'Compare ways to learn a language.', genders: { miso: 'female', taro: 'male', nori: 'neutral' } });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    assert.deepEqual(accepted.bucket.sessions[0].messages.slice(1).map(message => [message.assistant, message.gender]), [['miso', 'female'], ['taro', 'male'], ['nori', 'neutral']]);
    const running = runJob(getJob(a.directories, accepted.job.id));
    await started.promise;
    const preview = readScratchpadPreview(a.f.scope.owner, accepted.job.id);
    assert.deepEqual(Object.values(preview.replies).map(reply => reply.text), ['Miso thinking', 'Taro thinking', 'Nori thinking']);
    assert.deepEqual(Object.values(preview.replies).map(reply => reply.reasoning), ['Miso reasoning', 'Taro reasoning', 'Nori reasoning']);
    gates.get('Miso').resolve({ text: 'Miso suggests reading.' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(a.read(SOURCE).sessions[0].messages[1].state, 'done', 'one answer is saved while the others are still running');
    gates.get('Taro').resolve({ text: 'Taro suggests practice.' });
    gates.get('Nori').reject(new Error('Nori could not connect.'));
    await running;
    const before = a.read(SOURCE).sessions[0].messages;
    assert.deepEqual(before.slice(1).map(message => message.state), ['done', 'done', 'failed']);
    assert.equal(getJob(a.directories, accepted.job.id).state, 'failed');
    assert.equal((await acceptScratchpadReply(a.request(body), body)).job.id, accepted.job.id, 'a repeated acceptance never starts a second round');

    const called = [];
    registerScratchpadJobs({ generate: async options => {
        called.push(options.characterName);
        return { text: 'Nori suggests a film.' };
    } });
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { assistant: 'miso' }));
    const retry = sendBody(session, { regenerate: before[3].id });
    const retried = await acceptScratchpadReply(a.request(retry), retry);
    await runJob(getJob(a.directories, retried.job.id));
    const after = a.read(SOURCE).sessions[0].messages;
    assert.deepEqual(called, ['Nori']);
    assert.deepEqual(after.slice(0, 3), before.slice(0, 3), 'redoing one answer preserves the question and both other answers');
    assert.equal(after[3].text, 'Nori suggests a film.');

    const followUp = sendBody(session, { text: 'Compare those three approaches.' });
    const following = await acceptScratchpadReply(a.request(followUp), followUp);
    const requests = readArtifact(a.directories, following.job.id, 'request').replies;
    for (const request of requests) {
        assert.match(request.messages[0].content, /about anything/);
        assert.match(request.messages[0].content, /answers independently at the same time/);
        for (const peer of ['Miso', 'Taro', 'Nori'].filter(name => name !== request.characterName)) {
            assert.ok(request.messages.some(message => message.role === 'user' && message.content.startsWith(`[Earlier reply from ${peer} in Scratchpad]`)));
        }
    }
});

test('stopping a round table retains finished answers and stops all remaining speakers', { timeout: 10000 }, async t => {
    const a = account(t);
    const session = startSession(a, { roundTable: true });
    const started = Promise.withResolvers();
    const gates = new Map();
    registerScratchpadJobs({ generate: async options => {
        const gate = Promise.withResolvers();
        gates.set(options.characterName, gate);
        if (gates.size === 3) started.resolve();
        return gate.promise;
    } });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    const running = runJob(getJob(a.directories, accepted.job.id));
    await started.promise;
    gates.get('Miso').resolve({ text: 'Already saved.' });
    await new Promise(resolve => setImmediate(resolve));
    requestCancellation(a.directories, accepted.job.id, { reason: 'stop-all' });
    gates.get('Taro').resolve({ text: 'Too late.' });
    gates.get('Nori').resolve({ text: 'Too late.' });
    await running;
    const messages = a.read(SOURCE).sessions[0].messages.slice(1);
    assert.deepEqual(messages.map(message => [message.state, message.text]), [['done', 'Already saved.'], ['failed', ''], ['failed', '']]);
    assert.equal(getJob(a.directories, accepted.job.id).state, 'cancelled');
});

test('round tables require a recognised speaker and reserve room for every answer', () => {
    assert.throws(() => store.normaliseSettings({ participants: [] }), error => error.code === 'SCRATCHPAD_PARTICIPANTS_INVALID');
    const settings = store.normaliseSettings({ roundTable: true, participants: ['nori', 'other', 'taro', 'miso', 'taro'] });
    assert.deepEqual(settings.participants, ['miso', 'taro', 'nori']);
    const messages = Array.from({ length: store.MAX_MESSAGES - 2 }, (_, index) => ({ id: String(index), role: 'user', text: 'Hi' }));
    assert.throws(() => jobs.planReply({ settings, messages }, { text: 'Question' }), error => error.code === 'SCRATCHPAD_SESSION_FULL');
});

test('a provider response arriving after Stop is not saved as a completed reply', async t => {
    const a = account(t);
    const session = startSession(a);
    registerScratchpadJobs({ generate: async options => {
        requestCancellation(a.directories, options.jobContext.job.id, { reason: 'stopped-during-response' });
        return { text: 'This arrived too late.' };
    } });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    const reply = a.read(SOURCE).sessions[0].messages.at(-1);
    assert.equal(reply.state, 'failed');
    assert.equal(reply.text, '');
    assert.equal(getJob(a.directories, accepted.job.id).state, 'cancelled');
    assert.equal(readArtifact(a.directories, accepted.job.id, 'result'), undefined);
});

test('a reply that never finished preparing is failed after a restart, and a saved one is released', async t => {
    const a = account(t);
    const session = startSession(a);
    registerScratchpadJobs({ generate: async () => ({ text: 'ok' }) });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    assert.equal(finalizeScratchpadSubmission({ directories: a.directories, job: getJob(a.directories, accepted.job.id) }), false, 'a released reply needs no recovery');
    const waiting = { ...getJob(a.directories, accepted.job.id), state: 'waiting', stage: 'preparing', createdAt: Date.now() - 120000 };
    assert.equal(finalizeScratchpadSubmission({ directories: a.directories, job: waiting }), true);
});

test('history keeps the newest turns that fit and always starts with a user turn', () => {
    const history = jobs.historyFrom([
        { role: 'assistant', state: 'done', text: 'orphan' },
        { role: 'user', text: 'a' },
        { role: 'assistant', state: 'failed', text: '' },
        { role: 'user', text: 'b' },
        { role: 'assistant', state: 'done', text: 'c' },
    ]);
    assert.deepEqual(history.map(item => item.text), ['a', 'b', 'c']);
    const long = jobs.historyFrom([
        { role: 'user', text: 'first question' },
        { role: 'assistant', state: 'done', text: 'first answer' },
        { role: 'user', text: 'second question' },
        { role: 'assistant', state: 'done', text: 'y'.repeat(store.MAX_MESSAGE_BYTES) },
    ]);
    assert.deepEqual(long.slice(0, 3).map(item => item.text), ['first question', 'first answer', 'second question'], 'one very long reply does not push out earlier turns');
    assert.ok(Buffer.byteLength(long[3].text) <= 128 * 1024);
    assert.throws(() => jobs.normaliseReplyRequest({ submissionKey: 'k', source: SOURCE, sessionId: 'abc', text: 'x'.repeat(store.MAX_INPUT_BYTES + 1) }), error => error.code === 'SCRATCHPAD_TEXT_TOO_LARGE');
    assert.equal(jobs.normaliseReplyRequest({ submissionKey: 'k', source: SOURCE, sessionId: 'abc', text: 'x'.repeat(store.MAX_INPUT_BYTES) }).text.length, store.MAX_INPUT_BYTES);
    assert.throws(() => jobs.normaliseReplyRequest({ submissionKey: 'k', source: SOURCE, sessionId: 'abc', text: '   ' }), error => error.code === 'SCRATCHPAD_TEXT_REQUIRED');
    assert.throws(() => jobs.normaliseReplyRequest({ submissionKey: 'k', source: { kind: 'roleplay', key: '' }, sessionId: 'abc', text: 'x' }), error => error.code === 'SCRATCHPAD_SOURCE_INVALID');
});

test('the system prompt keeps each assistant identity and only offers the changes the page can apply', () => {
    for (const assistant of ['miso', 'taro', 'nori']) {
        const { text, persona } = buildScratchpadSystemPrompt({ assistant, gender: 'female', userName: 'Kris', characterName: 'Nova',
            capabilities: { lore: true, character: false, chat: false } });
        assert.match(text, new RegExp(`You are ${persona.name}`));
        assert.doesNotMatch(text, /\u2014/, 'no em dashes in the instructions');
        assert.match(text, /"type": ?"lorebook"/);
        assert.doesNotMatch(text, /"type": ?"chat"/);
    }
    const messages = buildScratchpadMessages({ system: 'S', context: '', history: [], text: 'Hi' });
    assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
    const characterPrompt = buildScratchpadSystemPrompt({ assistant: 'miso', capabilities: { character: true } }).text;
    assert.match(characterPrompt, /"action":"append"[^\n]+"field":"alternate_greetings"/);
    assert.match(characterPrompt, /include only the new greetings/);
    assert.match(characterPrompt, /after the last existing alternate greeting/);
});

test('the endpoint checks the account and answers with the saved Scratchpad', async t => {
    const a = account(t);
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: a.f.scope.owner }, directories: a.directories };
        next();
    });
    app.use('/scratchpad', router);
    const server = await new Promise(resolve => {
        const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}/scratchpad`;
    const post = (route, body, owner = a.f.scope.owner) => fetch(url + route, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close', 'X-Neconyan-Account': owner }, body: JSON.stringify(body) });

    const created = await post('/session/create', { source: SOURCE, assistant: 'nori', gender: 'male' });
    assert.equal(created.status, 200);
    const { bucket } = await created.json();
    assert.equal(bucket.sessions[0].assistant, 'nori');
    assert.equal(bucket.sessions[0].name, 'Nori\'s notes');
    const renamed = await post('/session/update', { source: SOURCE, sessionId: bucket.sessions[0].id, changes: { name: 'Plot holes' } });
    assert.equal((await renamed.json()).bucket.sessions[0].name, 'Plot holes');
    const wrong = await post('/bucket', { source: SOURCE }, 'someone-else');
    assert.equal(wrong.status, 409);
    const missing = await post('/session/delete', { source: SOURCE, sessionId: 'nope' });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'SCRATCHPAD_SESSION_MISSING');
    const preview = await fetch(`${url}/preview/not-a-job`, { headers: { Connection: 'close' } });
    assert.equal(preview.status, 404);
});
