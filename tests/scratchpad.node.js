/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test, { after } from 'node:test';
import express from 'express';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { SETTINGS_FILE } = await import('../src/constants.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { getJob, requestCancellation } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { testExports: { runJob }, setDirectoriesResolver } = await import('../src/jobs/runner.js');
const { acceptScratchpadReply, finalizeScratchpadSubmission, registerScratchpadJobs, testExports: jobs } = await import('../src/scratchpad/jobs.js');
const store = await import('../src/scratchpad/store.js');
const { readInstructionsLocked, updateInstructionsLocked } = await import('../src/scratchpad/instructions.js');
const { readAssistantsLocked, saveAssistantLocked, deleteAssistantLocked, readAssistantCardLocked, assistantPortrait, resolveAssistant } = await import('../src/scratchpad/assistants.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const { buildScratchpadMessages, buildScratchpadSystemPrompt } = await import('../src/scratchpad/prompt.js');
const { readScratchpadPreview, publishScratchpadPreview } = await import('../src/scratchpad/preview.js');
const { router } = await import('../src/endpoints/scratchpad.js');
const notebooks = await import('../src/notebooks/store.js');
const notebookAssistant = await import('../src/notebooks/assistant.js');
const { applyPolicyPatch } = await import('../src/notebooks/permissions.js');
const bridge = await import('../src/scratchpad/notebooks.js');
const { readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { commitRoleplayLifecycleLocked } = await import('../src/roleplay-lifecycle.js');
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');
const { splitReply } = await import('../public/scripts/scratchpad/proposals.js');
const { characterToolReply, scratchpadCharacterTools } = await import('../src/scratchpad/character-tools.js');
const { runChatProfile } = await import('../src/generation/service.js');

after(() => cancelAutoSaves());

const SOURCE = { kind: 'roleplay', key: 'Nova.png::Source', label: 'Nova' };
const OTHER = { kind: 'conversation', key: 'Nova.png::main', label: 'Nova' };
const GENERAL = { kind: 'general', key: 'general', label: 'General Scratchpad', contextMode: 'roleplay', personaId: 'User.png' };
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

function readInstructions(a) {
    return store.withScratchpad(a.base, readInstructionsLocked);
}

function saveInstructions(a, text, assistants = null) {
    return store.withScratchpad(a.base, lease => updateInstructionsLocked(lease,
        { text, scope: assistants ? 'selected' : 'all', assistants: assistants ?? store.ASSISTANT_IDS }, readInstructionsLocked(lease).revision));
}

function saveAssistant(a, input, revision) {
    return store.withScratchpad(a.base, lease => saveAssistantLocked(lease, input, revision ?? readAssistantsLocked(lease).revision));
}

test('General with no card clamps a forged character capability and records no shared avatar', async t => {
    const a = account(t);
    const source = { kind: 'general', key: 'general', label: 'General Scratchpad' };
    const session = a.mutate(source, bucket => store.createSession(bucket, { settings: { connection: { kind: 'profile', profileId: 'saved' } } }));
    registerScratchpadJobs({ generate: async () => ({ text: 'A general answer.' }) });
    const body = sendBody(session, { source, capabilities: { character: true }, sharedAvatar: 'Nova.png' });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(a.read(source).sessions[0].messages.at(-1).sharedAvatar, undefined);
});

test('stored General origins refuse forged shared-avatar authority for another context card', () => {
    const input = { role: 'assistant', text: 'A suggestion.', contextSource: { kind: 'general', key: 'general', avatar: 'Nova.png' }, sharedAvatar: 'Kit.png' };
    assert.equal(store.testExports.normaliseMessage(input, { allowInternalKeys: true }).sharedAvatar, undefined);
    assert.equal(store.testExports.normaliseMessage({ ...input, sharedAvatar: 'Nova.png' }, { allowInternalKeys: true }).sharedAvatar, 'Nova.png');
});

test('chat message origins and imported origins omit storage scope while retaining exact chat identity', async t => {
    const a = account(t);
    const source = { kind: 'roleplay', key: 'character:Nova.png:Source', label: 'Nova', scope: { kind: 'character', id: 'Nova.png' } };
    const session = a.mutate(source, bucket => store.createSession(bucket, { settings: { connection: { kind: 'profile', profileId: 'saved' } } }));
    registerScratchpadJobs({ generate: async () => ({ text: 'A scoped answer.' }) });
    const body = sendBody(session, { source });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    for (const message of a.read(source).sessions[0].messages) {
        assert.equal(message.contextSource.scope, undefined);
        assert.equal(message.contextSource.key, source.key);
    }
    const imported = a.mutate(source, bucket => store.createSession(bucket, { messages: [{ role: 'assistant', text: 'Imported.' }] }));
    assert.equal(imported.messages[0].contextSource.scope, undefined);
    assert.equal(imported.messages[0].contextSource.key, source.key);
});

test('a custom prompt saved from General defaults does not duplicate its context notice', () => {
    const options = { assistant: 'miso', sourceKind: 'general', userName: 'User', capabilities: {} };
    const defaults = buildScratchpadSystemPrompt(options).text;
    const saved = buildScratchpadSystemPrompt({ ...options, customPrompt: defaults }).text;
    assert.equal(saved.match(/No story chat is open/g)?.length, 1);
});

test('an ordinary text reply survives an invalid shared image target', async t => {
    const a = account(t);
    const session = startSession(a);
    registerScratchpadJobs({ generate: async () => ({ text: 'A plain answer.' }) });
    // A very long name is shortened and a malformed avatar is dropped, so neither fails the send.
    const body = sendBody(session, { targets: [{ avatar: 'Nova.png', name: 'N'.repeat(500) }, { avatar: '../bad.png', name: 'Bad' }] });
    const request = jobs.normaliseReplyRequest(body);
    assert.deepEqual(request.targets, [{ avatar: 'Nova.png', name: 'N'.repeat(200) }]);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
});

test('General sources strictly validate their one storage key and optional context', () => {
    assert.deepEqual(store.normaliseSource({ ...GENERAL, avatar: 'Nova.png', unexpected: 'ignored' }), { ...GENERAL, avatar: 'Nova.png' });
    for (const changed of [{ key: 'other' }, { key: 'shared:character:Nova.png' }, { scope: { kind: 'character', id: 'Nova.png' } },
        { legacyKey: 'character:Nova.png:chat' }, { avatar: '../Nova.png' }, { avatar: 'Nova.txt' }, { avatar: 'N\n.png' },
        { avatar: 'n'.repeat(256) + '.png' }, { contextMode: 'home' }, { personaId: '../User.png' }, { personaId: 'u'.repeat(257) }]) {
        assert.throws(() => store.normaliseSource({ ...GENERAL, ...changed }), { code: 'SCRATCHPAD_SOURCE_INVALID' });
        assert.throws(() => store.normaliseSource({ ...GENERAL, ...changed }, { allowInternalKeys: true }), { code: 'SCRATCHPAD_SOURCE_INVALID' });
    }
});

test('General keeps one account-owned list, context origins and ordinary session limits and cleanup', t => {
    const a = account(t), b = account(t);
    const selected = { ...GENERAL, avatar: 'Nova.png' };
    const session = a.mutate(selected, bucket => store.createSession(bucket, { name: 'General ideas', messages: [{ role: 'user', text: 'An idea.' }] }));
    assert.equal(a.read(GENERAL).sessions[0].id, session.id);
    assert.deepEqual(a.read(GENERAL).sessions[0].messages[0].contextSource, selected);
    assert.equal(b.read(GENERAL).sessions.length, 0);
    const file = JSON.parse(fs.readFileSync(store.scratchpadFile(a.directories.root, GENERAL), 'utf8'));
    assert.deepEqual(file.source, { kind: 'general', key: 'general', label: 'General Scratchpad' });
    a.mutate(GENERAL, bucket => {
        for (let i = 1; i < store.MAX_SESSIONS; i++) store.createSession(bucket);
        bucket.sessions.forEach((item, index) => { item.updated = new Date(1700000000000 - index * 1000).toISOString(); });
        assert.throws(() => store.createSession(bucket), { code: 'SCRATCHPAD_SESSION_LIMIT' });
    });
    store.withScratchpad(a.base, lease => store.updateCleanupLocked(lease, { enabled: true, keep: 1 }));
    a.mutate(GENERAL, () => {});
    assert.equal(a.read(GENERAL).sessions.length, 1);
    assert.equal(b.read(GENERAL).cleanup.enabled, false);
});

test('General prompts and custom prompts describe no story and disable chat and lore changes', () => {
    for (const customPrompt of [undefined, 'MY-CUSTOM-VOICE']) {
        const result = buildScratchpadSystemPrompt({ assistant: 'miso', gender: 'neutral', sourceKind: 'general', userName: 'Kris',
            customPrompt, capabilities: { chat: true, lore: true } });
        assert.match(result.text, /General Scratchpad/);
        assert.match(result.text, /No story chat is open/);
        assert.doesNotMatch(result.text, /Story chat messages \(use|Lorebook entries \(only/);
        if (customPrompt) assert.ok(result.text.startsWith(customPrompt));
        assert.match(result.text, /create-character|new character/i);
    }
    const messages = buildScratchpadMessages({ system: 'System', context: 'No chat.', history: [], text: 'Help.' });
    assert.equal(messages[2].content, 'I have read the shared context. What would you like to work on?');
});

for (const roundTable of [false, true]) {
    test(`General replies complete and reopen without chat files, round table=${roundTable}`, async t => {
        const a = account(t);
        fs.rmSync(a.directories.chats, { recursive: true, force: true });
        const source = { ...GENERAL, avatar: 'Nova.png' };
        const session = a.mutate(source, bucket => store.createSession(bucket, { settings: { roundTable, connection: { kind: 'profile', profileId: 'saved' } } }));
        const seen = [];
        registerScratchpadJobs({ generate: async options => { seen.push(options); return { text: 'General answer.' }; } });
        const body = sendBody(session, { source, context: 'General Scratchpad: no story chat is open.', text: 'Help me decide.' });
        const input = jobs.normaliseReplyRequest(body);
        assert.equal(input.capabilities.chat, false);
        assert.equal(input.capabilities.lore, false);
        assert.deepEqual(input.capabilities.members, []);
        const accepted = await acceptScratchpadReply(a.request(body), body);
        await runJob(getJob(a.directories, accepted.job.id));
        assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
        assert.equal(seen.length, roundTable ? 3 : 1);
        assert.ok(seen.every(options => options.binding.kind === 'profile' && options.messages[0].content.includes('General Scratchpad')));
        const saved = a.read(GENERAL).sessions[0];
        const reply = saved.messages.at(-1);
        assert.deepEqual(reply.contextSource, source);
        assert.equal(reply.sharedAvatar, 'Nova.png');
        assert.equal(reply.state, 'done');
        for (const changed of [{ avatar: 'Kit.png' }, { personaId: 'Other.png' }, { contextMode: 'conversation' }]) {
            await assert.rejects(acceptScratchpadReply(a.request({}), sendBody(session, { source: { ...source, ...changed }, regenerate: reply.id })), { code: 'SCRATCHPAD_REGENERATE_INVALID' });
        }
        const again = await acceptScratchpadReply(a.request({}), sendBody(session, { source, regenerate: reply.id }));
        await runJob(getJob(a.directories, again.job.id));
        assert.equal(a.read(GENERAL).sessions[0].messages.length, saved.messages.length);
    });
}

test('General cancellation remains in its original list and a new context may start a new message', async t => {
    const a = account(t);
    const session = a.mutate(GENERAL, bucket => store.createSession(bucket, { settings: { connection: { kind: 'profile', profileId: 'saved' } } }));
    const accepted = await acceptScratchpadReply(a.request({}), sendBody(session, { source: GENERAL }));
    requestCancellation(a.directories, accepted.job.id, { reason: 'user' });
    const projected = store.projectPending(a.read(GENERAL), id => getJob(a.directories, id));
    assert.equal(projected.sessions[0].messages.at(-1).state, 'failed');
    assert.equal(a.read(SOURCE).sessions.length, 0);
    const changed = { ...GENERAL, personaId: 'Other.png' };
    const next = await acceptScratchpadReply(a.request({}), sendBody(session, { source: changed }));
    registerScratchpadJobs({ generate: async () => ({ text: 'New context.' }) });
    await runJob(getJob(a.directories, next.job.id));
    assert.equal(a.read(GENERAL).sessions[0].messages.at(-1).contextSource.personaId, 'Other.png');
});

test('General uses a saved Text Completion profile and builds the real provider prompt without a chat file', async t => {
    const a = account(t);
    fs.rmSync(a.directories.chats, { recursive: true, force: true });
    const filename = path.join(a.directories.root, SETTINGS_FILE);
    const settings = JSON.parse(fs.readFileSync(filename, 'utf8'));
    settings.extension_settings.connectionManager.profiles = [{ id: 'text', api: 'llamacpp', mode: 'tc', 'api-url': 'http://127.0.0.1:6000' }];
    settings.textgenerationwebui_settings = { type: 'llamacpp', banned_tokens: '', global_banned_tokens: '', dry_sequence_breakers: '[]' };
    settings.power_user = { instruct: { enabled: false }, custom_stopping_strings: '[]' };
    settings.max_context = 8192;
    fs.writeFileSync(filename, JSON.stringify(settings));
    const session = a.mutate(GENERAL, bucket => store.createSession(bucket, { settings: { maxTokens: 256, stream: false, connection: { kind: 'profile', profileId: 'text' } } }));
    let calls = 0;
    registerScratchpadJobs({ generate: options => runChatProfile({ ...options, fetch: async (_url, request) => {
        calls++;
        const body = JSON.parse(request.body);
        assert.match(body.prompt, /General Scratchpad/);
        assert.match(body.prompt, /No story chat is open/);
        assert.match(body.prompt, /TEXT-GENERAL-QUESTION/);
        assert.equal(body.n_predict, 256);
        return new Response(JSON.stringify({ choices: [{ text: 'General TC answer.' }] }));
    } }) });
    const body = sendBody(session, { source: GENERAL, text: 'TEXT-GENERAL-QUESTION', context: 'General Scratchpad: no story chat is open.' });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed', JSON.stringify(getJob(a.directories, accepted.job.id).error));
    assert.equal(calls, 1);
    assert.equal(a.read(GENERAL).sessions[0].messages.at(-1).text, 'General TC answer.');
});

test('assistant libraries are account-owned, validate profiles and reject stale saves without losing edits', t => {
    const a = account(t), b = account(t);
    const saved = saveAssistant(a, { name: 'Jun', personality: 'Patient and direct.', avatar: '' });
    assert.match(saved.assistant.id, /^assistant_[a-f0-9]{24}$/);
    assert.equal(store.withScratchpad(b.base, readAssistantsLocked).assistants.length, 0);
    assert.throws(() => saveAssistant(a, { ...saved.assistant, personality: 'Stale' }, 0), error => error.status === 409);
    for (const input of [{ name: '', personality: 'Valid' }, { name: 'Jun', personality: '' },
        { name: 'Jun', personality: '字'.repeat(22000) }, { name: 'Jun', personality: 'Valid', avatar: 'data:image/svg+xml;base64,AAAA' }]) {
        assert.throws(() => saveAssistant(a, input), error => error.code === 'SCRATCHPAD_ASSISTANT_INVALID');
    }
    assert.throws(() => resolveAssistant({ assistants: [] }, saved.assistant.id), /unavailable/);
    assert.equal(store.withScratchpad(a.base, readAssistantsLocked).assistants[0].personality, 'Patient and direct.');
    const file = path.join(a.directories.root, 'scratchpad', 'assistants.json');
    fs.writeFileSync(file, '{broken');
    assert.throws(() => saveAssistant(a, saved.assistant), error => error.code === 'SCRATCHPAD_ASSISTANTS_DAMAGED');
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('character-card assistants copy characterisation and a metadata-free portrait without changing the card', async t => {
    const a = account(t);
    const filename = path.join(a.directories.characters, 'Nova.png');
    const before = fs.readFileSync(filename);
    const card = store.withScratchpad(a.base, lease => readAssistantCardLocked(lease, 'Nova.png'));
    assert.equal(card.profile.name, 'Nova');
    const avatar = await assistantPortrait(card.bytes);
    assert.match(avatar, /^data:image\/jpeg;base64,/);
    const saved = saveAssistant(a, { ...card.profile, avatar });
    assert.ok(saved.assistant.personality.trim());
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.throws(() => store.withScratchpad(a.base, lease => readAssistantCardLocked(lease, '../Nova.png')));
    await assert.rejects(assistantPortrait(Buffer.from('not an image')), /could not be read/);
});

test('long character cards are shortened to fit an assistant instead of being refused', t => {
    const a = account(t);
    fs.writeFileSync(path.join(a.directories.characters, 'Long.png'), writeCard(png, JSON.stringify({
        name: `${'N'.repeat(79)}😀 tail`, description: '字'.repeat(30000), mes_example: 'e'.repeat(70000),
    })));
    const card = store.withScratchpad(a.base, lease => readAssistantCardLocked(lease, 'Long.png'));
    assert.equal(card.profile.name, 'N'.repeat(79));
    assert.ok(Buffer.byteLength(card.profile.personality) <= 64000);
    assert.ok(card.profile.personality.length > 21000);
    assert.doesNotMatch(card.profile.personality, /\uFFFD/);
    assert.equal(card.profile.examples.length, 64000);
    assert.equal(saveAssistant(a, card.profile).assistant.name, 'N'.repeat(79));
});

test('deleting a library assistant needs the current revision and leaves session copies usable', t => {
    const a = account(t);
    const { assistant, library } = saveAssistant(a, { name: 'Jun', personality: 'Patient and direct.' });
    const remove = (id, revision) => store.withScratchpad(a.base, lease => deleteAssistantLocked(lease, id, revision));
    assert.throws(() => remove(assistant.id, library.revision - 1), error => error.status === 409);
    assert.throws(() => remove('miso', library.revision), error => error.status === 404);
    assert.throws(() => remove('assistant_222222222222222222222222', library.revision), error => error.status === 404);
    const deleted = remove(assistant.id, library.revision);
    assert.equal(deleted.library.assistants.length, 0);
    assert.equal(deleted.library.revision, library.revision + 1);
    assert.equal(store.withScratchpad(a.base, readAssistantsLocked).assistants.length, 0);
    assert.equal(resolveAssistant(deleted.library, assistant.id, { [assistant.id]: assistant }).personality, 'Patient and direct.');
    assert.throws(() => resolveAssistant(deleted.library, assistant.id), /unavailable/);
});

test('custom assistants keep their accepted personality, names, round-table history and portable session copies', async t => {
    const a = account(t);
    const { assistant } = saveAssistant(a, { name: 'Jun', personality: 'ORIGINAL-VOICE. Call {{user}} by name.', examples: '{{char}}: Let us check.' });
    const session = a.mutate(SOURCE, bucket => store.createSession(bucket, {
        assistant: assistant.id, settings: { assistants: { [assistant.id]: assistant }, roundTable: true, participants: ['taro', assistant.id],
            assistantConnections: { [assistant.id]: { kind: 'profile', profileId: 'saved' }, taro: { kind: 'profile', profileId: 'saved' } } },
    }));
    assert.equal(session.name, 'Jun\'s notes');
    saveInstructions(a, 'JUN-ONLY', [assistant.id]);
    const prompts = [];
    registerScratchpadJobs({ generate: async options => { prompts.push({ name: options.characterName, messages: options.messages }); return { text: 'Saved answer.' }; } });
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    saveAssistant(a, { ...assistant, name: 'June', personality: 'EDITED-VOICE' });
    await runJob(getJob(a.directories, accepted.job.id));
    const original = prompts.find(item => item.name === 'Jun').messages[0].content;
    assert.match(original, /ORIGINAL-VOICE/);
    assert.match(original, /Call Kris by name/);
    assert.match(original, /Jun: Let us check/);
    assert.match(original, /JUN-ONLY/);
    assert.match(original, /round table with Taro, Jun/);
    assert.doesNotMatch(original, /one of the three Neconyan assistants|EDITED-VOICE/);
    const next = sendBody(session);
    const second = await acceptScratchpadReply(a.request(next), next);
    await runJob(getJob(a.directories, second.job.id));
    assert.match(prompts.find(item => item.name === 'June').messages[0].content, /EDITED-VOICE/);
    assert.ok(prompts.filter(item => item.name === 'Taro').at(-1).messages.some(item => item.content.includes('[Earlier reply from Jun in Scratchpad]')));
    const persisted = a.read(SOURCE).sessions[0];
    assert.equal(persisted.messages.find(item => item.assistant === assistant.id).assistantName, 'Jun');
    assert.equal(persisted.settings.assistants[assistant.id].name, 'June');
    const b = account(t);
    const imported = b.mutate(SOURCE, bucket => store.createSession(bucket, persisted));
    const importedBody = sendBody(imported);
    const copy = await acceptScratchpadReply(b.request(importedBody), importedBody);
    await runJob(getJob(b.directories, copy.job.id));
    assert.equal(prompts.at(-1).name, 'June');
    assert.equal(store.withScratchpad(b.base, readAssistantsLocked).assistants.length, 0);
    assert.throws(() => store.normaliseSettings({ participants: ['miso', 'taro', 'nori', assistant.id] }), /up to three/);
});

test('global instructions are account-owned, bounded and protected against stale saves or damaged files', t => {
    const a = account(t);
    const b = account(t);
    assert.equal(readInstructions(a).text, '');
    const saved = saveInstructions(a, 'Use short paragraphs.\r\nKeep my wording.', ['nori']);
    assert.deepEqual(readInstructions(a), saved);
    assert.equal(readInstructions(b).text, '');
    const update = (input, revision = saved.revision) => store.withScratchpad(a.base, lease => updateInstructionsLocked(lease, input, revision));
    assert.throws(() => update({ ...saved, text: 'Stale' }, 0), error => error.code === 'SCRATCHPAD_INSTRUCTIONS_CHANGED');
    assert.throws(() => update({ ...saved, assistants: [] }), /Choose at least one/);
    assert.throws(() => update({ ...saved, assistants: ['unknown'] }), /Choose all assistants/);
    assert.throws(() => update({ ...saved, text: '字'.repeat(22000) }), error => error.status === 413);
    assert.throws(() => update({ ...saved, text: null }), error => error.status === 400);
    assert.deepEqual(readInstructions(a), saved);
    const filename = path.join(a.directories.root, 'scratchpad', 'global-instructions.json');
    fs.writeFileSync(filename, '{broken');
    assert.throws(() => saveInstructions(a, 'Do not overwrite'), error => error.code === 'SCRATCHPAD_INSTRUCTIONS_DAMAGED');
    assert.equal(fs.readFileSync(filename, 'utf8'), '{broken');
});

test('global instructions select each round-table speaker and accepted replies keep their captured instructions', async t => {
    const a = account(t);
    const session = startSession(a, { roundTable: true, participants: ['miso', 'taro', 'nori'], assistantPrompts: { taro: 'Custom Taro prompt.' } });
    const prompts = [];
    registerScratchpadJobs({ generate: async options => { prompts.push({ name: options.characterName, text: options.messages[0].content }); return { text: 'A reply.' }; } });
    saveInstructions(a, 'GLOBAL-ONE', ['taro', 'nori']);
    const body = sendBody(session);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    saveInstructions(a, 'GLOBAL-TWO');
    const retry = await acceptScratchpadReply(a.request(body), body);
    assert.equal(retry.job.id, accepted.job.id);
    assert.equal(retry.created, false);
    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(prompts.length, 3);
    for (const prompt of prompts) {
        assert.equal(prompt.text.includes('GLOBAL-ONE'), prompt.name !== 'Miso');
        assert.equal(prompt.text.includes('GLOBAL-TWO'), false);
    }
    assert.match(prompts.find(prompt => prompt.name === 'Taro').text, /^Custom Taro prompt\./);
    const next = sendBody(session);
    const all = await acceptScratchpadReply(a.request(next), next);
    await runJob(getJob(a.directories, all.job.id));
    assert.ok(prompts.slice(3).every(prompt => prompt.text.includes('GLOBAL-TWO')));
    // Regeneration follows the original speaker, even after the active assistant changes.
    const taroReply = a.read(SOURCE).sessions[0].messages.filter(message => message.assistant === 'taro').at(-1);
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { assistant: 'miso' }));
    saveInstructions(a, 'TARO-ONLY', ['taro']);
    const regenerated = sendBody(session, { text: undefined, regenerate: taroReply.id });
    const replacement = await acceptScratchpadReply(a.request(regenerated), regenerated);
    await runJob(getJob(a.directories, replacement.job.id));
    assert.equal(prompts.at(-1).name, 'Taro');
    assert.match(prompts.at(-1).text, /TARO-ONLY/);
});

test('global instructions reach existing and new sessions across source kinds and blank text disables them', async t => {
    const a = account(t);
    const old = startSession(a);
    saveInstructions(a, 'EVERYWHERE');
    const prompts = [];
    registerScratchpadJobs({ generate: async options => { prompts.push(options.messages[0].content); return { text: 'A reply.' }; } });
    for (const source of [SOURCE, OTHER, { kind: 'notebook', key: 'note-global-test', label: 'Note' }]) {
        const session = source === SOURCE ? old : a.mutate(source, bucket => store.createSession(bucket, { assistant: 'miso', settings: old.settings }));
        const body = sendBody(session, { source });
        const accepted = await acceptScratchpadReply(a.request(body), body);
        await runJob(getJob(a.directories, accepted.job.id));
        assert.match(prompts.at(-1), /EVERYWHERE/);
        assert.equal(JSON.stringify(a.read(source)).includes('EVERYWHERE'), false, 'global text is not copied into session data');
    }
    saveInstructions(a, '  \n');
    const body = sendBody(old);
    const accepted = await acceptScratchpadReply(a.request(body), body);
    await runJob(getJob(a.directories, accepted.job.id));
    assert.doesNotMatch(prompts.at(-1), /global Scratchpad instructions|EVERYWHERE/);
});

test('changing global instructions during preparation rejects the send before messages are added', async t => {
    const a = account(t);
    const session = startSession(a);
    saveInstructions(a, 'Before');
    const body = sendBody(session);
    const sending = acceptScratchpadReply(a.request(body), body);
    saveInstructions(a, 'After');
    await assert.rejects(sending, error => error.code === 'SCRATCHPAD_INSTRUCTIONS_CHANGED');
    assert.equal(a.read(SOURCE).sessions[0].messages.length, 0);
});

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

test('a Bun request-only abort releases Scratchpad preview checks without cancelling its reply', async t => {
    const a = account(t);
    const accepted = await acceptScratchpadReply(a.request({}), sendBody(startSession(a)));
    const request = Object.assign(new EventEmitter(), a.request({}), { params: { id: accepted.job.id } });
    const writes = [];
    const response = Object.assign(new EventEmitter(), {
        set: () => response, flushHeaders() {}, write: value => writes.push(value), end() { this.writableEnded = true; },
    });
    const timers = new Set();
    const clearInterval = globalThis.clearInterval;
    t.mock.method(globalThis, 'setInterval', callback => { timers.add(callback); return callback; });
    t.mock.method(globalThis, 'clearInterval', timer => { if (!timers.delete(timer)) clearInterval(timer); });
    try {
        router.stack.find(layer => layer.route?.path === '/preview/:id').route.stack[0].handle(request, response);
        assert.equal(timers.size, 1);
        request.emit('aborted');
        assert.equal(timers.size, 0);
        const before = writes.length;
        publishScratchpadPreview(a.base.owner, accepted.job.id, { stage: 'generating', text: 'Still working' });
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(writes.length, before);
        assert.equal(getJob(a.directories, accepted.job.id).cancellation.requested, false);
        response.emit('finish');
    } finally { response.emit('close'); }
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
    assert.ok(reply.token_count > 0);
    assert.ok(reply.reasoning_tokens > 0);
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

test('sharing the current preset starts off, is saved when chosen and carries to new sessions', t => {
    assert.equal(store.defaultSettings().include.preset, false);
    assert.equal(store.normaliseSettings({ include: { card: false } }).include.preset, false);
    assert.equal(store.normaliseSettings({ include: { preset: 'true' } }).include.preset, false);
    const a = account(t);
    const session = startSession(a, {});
    assert.equal(session.settings.include.preset, false);
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { include: { preset: true } } }));
    const saved = a.read(SOURCE).sessions[0].settings.include;
    assert.equal(saved.preset, true);
    assert.equal(saved.card, true);
    const next = a.mutate(SOURCE, bucket => store.createSession(bucket));
    assert.equal(next.settings.include.preset, true);
});

test('the reply limit defaults to 32000 without replacing saved limits', t => {
    assert.equal(store.normaliseSettings({}).maxTokens, 32000);
    assert.equal(store.normaliseSettings({ maxTokens: 'invalid' }).maxTokens, 32000);
    const saved = { ...store.defaultSettings(), maxTokens: 16000, depth: 3 };
    for (const invalid of ['invalid', '', '  ', null]) {
        assert.equal(store.normaliseSettings({ maxTokens: invalid }, saved).maxTokens, 16000, 'an invalid limit keeps the saved value');
        assert.equal(store.normaliseSettings({ depth: invalid }, saved).depth, 3, 'an invalid depth keeps the saved value');
    }
    const a = account(t);
    const session = startSession(a, { maxTokens: 16000 });
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { stream: false } }));
    assert.equal(a.read(SOURCE).sessions[0].settings.maxTokens, 16000);
    assert.equal(a.mutate(SOURCE, bucket => store.createSession(bucket)).settings.maxTokens, 16000);
});

test('the web search switch starts off, is saved and carries to new sessions', t => {
    assert.equal(store.normaliseSettings({}).webSearch, false);
    const a = account(t);
    const session = startSession(a, { webSearch: true });
    assert.equal(a.read(SOURCE).sessions[0].settings.webSearch, true);
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { webSearch: false } }));
    assert.equal(a.read(SOURCE).sessions[0].settings.webSearch, false);
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { webSearch: true } }));
    assert.equal(a.mutate(SOURCE, bucket => store.createSession(bucket)).settings.webSearch, true);
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
    }), error => error.code === 'SCRATCHPAD_STORAGE_FULL' && error.status === 413 && /Delete old sessions/.test(error.message)
        && /automatic cleanup/.test(error.message));
    assert.equal(a.read(SOURCE).sessions[0].messages.length, 6);
});

function datedSessions(a, count) {
    const ids = [];
    for (let index = 0; index < count; index++) ids.push(a.mutate(SOURCE, bucket => store.createSession(bucket)).id);
    a.mutate(SOURCE, bucket => {
        for (const session of bucket.sessions) session.updated = `2026-01-${String(ids.indexOf(session.id) + 1).padStart(2, '0')}T00:00:00.000Z`;
    });
    return ids;
}

test('automatic cleanup is off by default and keeps a sensible number of sessions', () => {
    assert.deepEqual(store.normaliseCleanup(undefined), { enabled: false, keep: 10 });
    assert.deepEqual(store.normaliseCleanup({ enabled: 'yes', keep: 'many' }), { enabled: false, keep: 10 });
    assert.equal(store.normaliseCleanup({ keep: 0 }).keep, 1);
    assert.equal(store.normaliseCleanup({ keep: 999 }).keep, store.MAX_SESSIONS);
    assert.deepEqual(store.normaliseCleanup({ keep: 4 }, { enabled: true, keep: 7 }), { enabled: true, keep: 4 });
});

test('cleanup is shared by existing and future chats and notes, but not other accounts', t => {
    const a = account(t), b = account(t);
    datedSessions(a, 4);
    const stale = a.read(SOURCE);
    a.mutate(OTHER, (bucket, lease) => store.updateCleanupLocked(lease, { enabled: true, keep: 2 }));
    const cleanup = JSON.parse(fs.readFileSync(path.join(a.directories.root, 'scratchpad', 'cleanup.json'), 'utf8'));
    assert.deepEqual(cleanup, { version: 1, shared: true, enabled: true, keep: 2 });
    assert.equal(fs.existsSync(store.scratchpadFile(a.directories.root, OTHER)), false);
    for (const source of [SOURCE, OTHER, { kind: 'notebook', key: 'note-1' }, { ...SOURCE, key: 'future-chat' }]) {
        assert.deepEqual(a.read(source).cleanup, { enabled: true, keep: 2 });
    }
    assert.deepEqual(b.read(SOURCE).cleanup, store.defaultCleanup());
    // Reading another chat does not delete anything. Its next save uses the shared choice,
    // even if that caller retained an older bucket (as a background operation might).
    assert.equal(a.read(SOURCE).sessions.length, 4);
    store.withScratchpad(a.base, lease => store.writeBucketLocked(lease, stale));
    assert.equal(a.read(SOURCE).sessions.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(store.scratchpadFile(a.directories.root, SOURCE))).cleanup, undefined);
    a.mutate(OTHER, (bucket, lease) => store.updateCleanupLocked(lease, { enabled: false }));
    a.mutate(SOURCE, bucket => store.createSession(bucket));
    assert.equal(a.read(SOURCE).sessions.length, 3);
    assert.deepEqual(a.read(SOURCE).cleanup, { enabled: false, keep: 2 });
});

test('legacy per-chat cleanup cannot enable or override the shared choice', t => {
    const a = account(t);
    datedSessions(a, 4);
    const filename = store.scratchpadFile(a.directories.root, SOURCE);
    const legacy = JSON.parse(fs.readFileSync(filename));
    legacy.cleanup = { enabled: true, keep: 1 };
    fs.writeFileSync(filename, JSON.stringify(legacy));
    assert.deepEqual(a.read(SOURCE).cleanup, store.defaultCleanup());
    a.mutate(SOURCE, () => {});
    assert.equal(a.read(SOURCE).sessions.length, 4);
    a.mutate(OTHER, (bucket, lease) => store.updateCleanupLocked(lease, { enabled: true, keep: 3 }));
    fs.writeFileSync(filename, JSON.stringify(legacy));
    assert.deepEqual(a.read(SOURCE).cleanup, { enabled: true, keep: 3 });
    a.mutate(SOURCE, () => {});
    assert.equal(a.read(SOURCE).sessions.length, 3);
});

test('a stale bucket cannot re-enable cleanup after another chat disables it', t => {
    const a = account(t);
    datedSessions(a, 4);
    a.mutate(OTHER, (bucket, lease) => store.updateCleanupLocked(lease, { enabled: true, keep: 1 }));
    const stale = a.read(SOURCE);
    a.mutate(OTHER, (bucket, lease) => store.updateCleanupLocked(lease, { enabled: false }));
    store.withScratchpad(a.base, lease => store.writeBucketLocked(lease, stale));
    assert.equal(a.read(SOURCE).sessions.length, 4);
    assert.deepEqual(a.read(SOURCE).cleanup, { enabled: false, keep: 1 });
});

test('damaged shared cleanup settings are kept rather than replaced or applied', t => {
    const a = account(t);
    datedSessions(a, 3);
    const filename = path.join(a.directories.root, 'scratchpad', 'cleanup.json');
    for (const damaged of ['{', '{"version":2,"enabled":true,"keep":1}', '{"version":3,"enabled":true,"keep":1}', '{"version":1,"enabled":true,"keep":0}']) {
        fs.writeFileSync(filename, damaged);
        assert.throws(() => a.read(SOURCE), error => error.code === 'SCRATCHPAD_CLEANUP_DAMAGED');
        assert.throws(() => store.withScratchpad(a.base, lease => store.updateCleanupLocked(lease, { enabled: false })),
            error => error.code === 'SCRATCHPAD_CLEANUP_DAMAGED');
        assert.equal(fs.readFileSync(filename, 'utf8'), damaged);
    }
    fs.unlinkSync(filename);
    assert.equal(a.read(SOURCE).sessions.length, 3);
});

test('automatic cleanup keeps the newest sessions and never the open one', t => {
    const a = account(t);
    const ids = datedSessions(a, 5);
    a.mutate(SOURCE, bucket => store.activateSession(bucket, ids[0]));
    assert.equal(a.read(SOURCE).sessions.length, 5);
    a.mutate(SOURCE, (bucket, lease) => store.updateCleanupLocked(lease, { enabled: true, keep: 3 }));
    assert.deepEqual(a.read(SOURCE).sessions.map(session => session.id).sort(), [ids[0], ids[3], ids[4]].sort());
    a.mutate(SOURCE, (bucket, lease) => store.updateCleanupLocked(lease, { keep: 1 }));
    assert.deepEqual(a.read(SOURCE).sessions.map(session => session.id).sort(), [ids[0], ids[4]].sort());
    const saved = a.read(SOURCE);
    assert.deepEqual(saved.cleanup, { enabled: true, keep: 1 });
});

test('automatic cleanup never deletes a session with a reply in progress', t => {
    const a = account(t);
    const ids = datedSessions(a, 3);
    a.mutate(SOURCE, (bucket, lease) => {
        bucket.sessions.find(session => session.id === ids[0]).messages.push({ id: 'waiting', role: 'assistant', state: 'pending', jobId: 'job-1', text: '' });
        store.updateCleanupLocked(lease, { enabled: true, keep: 1 });
    });
    assert.deepEqual(a.read(SOURCE).sessions.map(session => session.id).sort(), [ids[0], ids[2]].sort());
});

test('automatic cleanup makes room for a new session at the session limit', t => {
    const a = account(t);
    datedSessions(a, store.MAX_SESSIONS);
    assert.throws(() => a.mutate(SOURCE, bucket => store.createSession(bucket)), error => error.code === 'SCRATCHPAD_SESSION_LIMIT');
    a.mutate(SOURCE, (bucket, lease) => store.updateCleanupLocked(lease, { enabled: true, keep: store.MAX_SESSIONS }));
    const created = a.mutate(SOURCE, bucket => store.createSession(bucket));
    const saved = a.read(SOURCE);
    assert.equal(saved.sessions.length, store.MAX_SESSIONS);
    assert.equal(saved.activeSessionId, created.id);
});

test('with automatic cleanup on, a full Scratchpad file drops its oldest sessions instead of failing', t => {
    const a = account(t);
    const [oldest, newest] = datedSessions(a, 2);
    const long = 'x'.repeat(store.MAX_MESSAGE_BYTES);
    const fill = (id, from, to) => a.mutate(SOURCE, bucket => {
        const target = bucket.sessions.find(item => item.id === id);
        for (let index = from; index < to; index++) {
            target.messages.push({ id: `long-${index}`, role: 'assistant', assistant: 'taro', state: 'done', text: long, reasoning: long, created: new Date().toISOString() });
        }
    });
    fill(oldest, 0, 6);
    a.mutate(SOURCE, (bucket, lease) => store.updateCleanupLocked(lease, { enabled: true }));
    fill(newest, 6, 10);
    const saved = a.read(SOURCE);
    assert.deepEqual(saved.sessions.map(session => session.id), [newest]);
    assert.equal(saved.sessions[0].messages.length, 4);
    assert.throws(() => fill(newest, 10, 20), error => error.code === 'SCRATCHPAD_STORAGE_FULL' && /open session/.test(error.message));
    assert.equal(a.read(SOURCE).sessions[0].messages.length, 4);
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

test('Scratchpad native character replies recover only unambiguous creation aliases', () => {
    const tools = scratchpadCharacterTools();
    const name = tools[0].function.name;
    const reply = args => characterToolReply({ text: 'A draft for review.', response: { output: [
        { type: 'function_call', call_id: 'compatibility', name, arguments: JSON.stringify(args) },
    ] } }, tools);
    const characterNote = '  Keep this note.\n';
    const alternateGreetings = ['  Keep this greeting.\n', 'A second greeting.'];
    for (const key of ['alternateGreetings', 'alternate_greetings']) {
        const args = { character: { name: 'New Nova', characterNote, [key]: alternateGreetings } };
        const before = structuredClone(args);
        const result = reply(args);
        assert.equal(result.hasTools, true);
        assert.match(result.text, /^A draft for review\./);
        const change = splitReply(result.text).find(part => part.type === 'change');
        assert.equal(change.error, '');
        assert.deepEqual(change.change, { type: 'character', action: 'create', character: { name: 'New Nova' },
            characterNote, alternateGreetings, avatarPrompt: '', reason: '' });
        assert.deepEqual(args, before);
    }
    for (const extra of [{ characterNote: 'Conflicting.' }, { characterNote: false },
        { alternateGreetings: ['Conflicting.'] }, { alternate_greetings: ['Conflicting.'] },
        { alternate_greetings: ['G'.repeat(100001)] }, { avatarPrompt: 'Do not generate.' }, { extensions: {} }]) {
        const result = reply({ character: { name: 'New Nova', ...extra }, characterNote, alternateGreetings });
        assert.equal(result.hasTools, true);
        assert.match(result.text, /A draft for review\.[\s\S]*A character draft could not be used:/);
        assert.equal(splitReply(result.text).some(part => part.change), false);
    }
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

for (const file of ['policies.json', 'manifest.json']) {
    test(`a damaged notebook ${file} keeps the finished reply, and Review reports the damage until it is repaired`, async t => {
        const a = account(t);
        const note = sharedNote(a);
        const session = startSession(a, { notes: [{ notebookId: note.notebookId, noteId: note.noteId }] });
        const control = path.join(a.directories.root, 'notebook-control', note.notebookId, file);
        const intact = fs.readFileSync(control);
        const warn = t.mock.method(console, 'warn', () => {});
        const suggestion = { type: 'notebook', action: 'append-note', args: { notebookId: note.notebookId, noteId: note.noteId, expectedRevision: note.revision, markdown: 'Another idea.' } };
        const text = `Useful advice.\n\`\`\`scratchpad-change\n${JSON.stringify(suggestion)}\n\`\`\``;
        registerScratchpadJobs({ generate: async () => {
            fs.writeFileSync(control, '{ not json');
            return { text };
        } });
        const body = sendBody(session);
        const accepted = await acceptScratchpadReply(a.request(body), body);
        await runJob(getJob(a.directories, accepted.job.id));
        assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
        const reply = a.read(SOURCE).sessions[0].messages.at(-1);
        assert.equal(reply.state, 'done');
        assert.equal(reply.text, text);
        assert.equal(reply.error, undefined);
        assert.equal(reply.notebookProposals, undefined);
        assert.ok(warn.mock.calls.some(call => call.arguments.includes('NOTEBOOK_CONTROL_DAMAGED')), 'the skipped suggestion is logged');
        const review = () => store.withScratchpad(a.base, lease => bridge.prepareNotebookProposalLocked(lease, SOURCE, { sessionId: session.id, messageId: reply.id, index: 0 }));
        assert.throws(review, error => error.code === 'NOTEBOOK_CONTROL_DAMAGED');
        fs.writeFileSync(control, intact);
        assert.match(review().proposalId, /^p_[a-f0-9]{24}$/);
    });
}

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

test('shared sessions keep pending replies and retries tied to their original chat', async t => {
    const a = account(t);
    const source = { kind: 'roleplay', key: 'character:Nova.png:Source', scope: { kind: 'character', id: 'Nova.png' } };
    const other = { ...source, key: 'character:Nova.png:Other' };
    const session = a.mutate(source, bucket => store.createSession(bucket, { settings: { connection: { kind: 'profile', profileId: 'saved' } } }));
    registerScratchpadJobs({ generate: async () => ({ text: 'A shared answer.' }) });
    const body = sendBody(session, { source });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    assert.equal(a.read(other).sessions[0].messages.at(-1).state, 'pending');
    await runJob(getJob(a.directories, accepted.job.id));
    const reply = a.read(other).sessions[0].messages.at(-1);
    assert.equal(reply.text, 'A shared answer.');
    const wrongChat = sendBody(session, { source: other, text: undefined, regenerate: reply.id });
    await assert.rejects(acceptScratchpadReply(a.request(wrongChat), wrongChat), { code: 'SCRATCHPAD_REGENERATE_INVALID' });
    const original = sendBody(session, { source, text: undefined, regenerate: reply.id });
    const retry = await acceptScratchpadReply(a.request(original), original);
    await runJob(getJob(a.directories, retry.job.id));
    assert.equal(a.read(other).sessions[0].messages.filter(message => message.role === 'assistant').length, 1);
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

test('Random selects each eligible assistant, reserves one answer and never changes a retry speaker', () => {
    const settings = store.normaliseSettings({ roundTable: true, randomReply: true, participants: ['miso', 'nori'] });
    const session = { assistant: 'taro', settings, messages: [] };
    for (const index of [0, 1]) {
        assert.deepEqual(jobs.planReply(session, { text: 'Hi' }, length => {
            assert.equal(length, 2);
            return index;
        }).assistants, [settings.participants[index]]);
    }
    session.messages = Array.from({ length: store.MAX_MESSAGES - 2 }, (_, index) => ({ id: String(index), role: 'user', text: 'Hi' }));
    assert.equal(jobs.planReply(session, { text: 'Hi' }).assistants.length, 1);
    session.messages.push({ id: 'last-user', role: 'user', text: 'Question' }, { id: 'answer', role: 'assistant', assistant: 'miso', state: 'done', text: 'Answer' });
    assert.throws(() => jobs.planReply(session, { text: 'Hi' }), error => error.code === 'SCRATCHPAD_SESSION_FULL');
    session.settings.participants = ['nori'];
    assert.deepEqual(jobs.planReply(session, { regenerate: 'answer' }, () => assert.fail('Retries must not choose again')).assistants, ['miso']);
    session.messages = [];
    assert.deepEqual(jobs.planReply(session, { text: 'Hi' }).assistants, ['nori']);
    session.settings.roundTable = false;
    assert.deepEqual(jobs.planReply(session, { text: 'Hi' }).assistants, ['taro']);
});

test('Random is saved with the session and an accepted send keeps exactly one durable speaker', async t => {
    const a = account(t);
    const session = startSession(a, { roundTable: true, randomReply: true, participants: ['miso', 'nori'] });
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { depth: 3 } }));
    assert.equal(a.read(SOURCE).sessions[0].settings.randomReply, true);
    assert.equal(store.defaultSettings().randomReply, false);
    const calls = [];
    registerScratchpadJobs({ generate: async options => { calls.push(options); return { text: 'One answer.' }; } });
    const body = sendBody(session, { genders: { miso: 'female', nori: 'male' } });
    const accepted = await acceptScratchpadReply(a.request(body), body);
    const pending = accepted.bucket.sessions[0].messages;
    assert.equal(pending.length, 2);
    assert.ok(['miso', 'nori'].includes(pending[1].assistant));
    assert.equal(pending[1].gender, body.genders[pending[1].assistant]);
    const captured = readArtifact(a.directories, accepted.job.id, 'request');
    assert.equal(captured.assistant, pending[1].assistant);
    assert.match(captured.messages[0].content, /only assistant replying to this message/);
    assert.doesNotMatch(captured.messages[0].content, /answers independently at the same time/);
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { randomReply: false } }));
    const duplicate = await acceptScratchpadReply(a.request(body), body);
    assert.equal(duplicate.job.id, accepted.job.id);
    assert.equal(duplicate.created, false);
    await runJob(getJob(a.directories, accepted.job.id));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].characterName.toLowerCase(), pending[1].assistant);
    assert.equal(a.read(SOURCE).sessions[0].messages.at(-1).text, 'One answer.');
    const next = sendBody(session);
    const all = await acceptScratchpadReply(a.request(next), next);
    await runJob(getJob(a.directories, all.job.id));
    assert.equal(calls.length, 3, 'turning Random off restores replies from both participants');
    a.mutate(SOURCE, bucket => store.updateSession(bucket, session.id, { settings: { randomReply: true } }));
    const inherited = a.mutate(SOURCE, bucket => store.createSession(bucket, {}));
    assert.equal(inherited.settings.randomReply, true);
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

test('default prompts carry the bundled personality through practical help for every assistant variant', () => {
    for (const assistant of store.ASSISTANT_IDS) {
        for (const gender of store.ASSISTANT_GENDERS) {
            const { text, persona } = buildScratchpadSystemPrompt({ assistant, gender, userName: 'Kris', help: 'REFERENCE-END' });
            assert.match(text, new RegExp(`Stay fully in character as ${persona.name} in every reply`));
            assert.ok(text.includes(persona.personality));
            assert.ok(text.includes(persona.summary));
            assert.ok(text.indexOf('Your personality and character details:') < text.indexOf('context block'));
            assert.ok(text.lastIndexOf(persona.personality) > text.indexOf('REFERENCE-END'), 'personality remains active after the technical reference');
            assert.doesNotMatch(text, /Scratchpad is out of character|not from this Scratchpad|Keep cat puns rare/);
            assert.match(text, /Brief expressive actions/);
        }
    }
    const { text } = buildScratchpadSystemPrompt({ assistant: 'taro', customPrompt: 'My own voice.', userInstructions: 'Keep it short.' });
    assert.match(text, /^My own voice\./);
    assert.match(text, /Keep it short\./);
    assert.doesNotMatch(text, /Stay fully in character|For this reply, be Taro/);
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

    const initial = await post('/instructions', {});
    assert.equal(initial.status, 200, 'instructions do not need an open chat');
    const { instructions } = await initial.json();
    const payload = { instructions: { ...instructions, text: 'ENDPOINT-GLOBAL', scope: 'selected', assistants: ['miso'] }, expectedRevision: instructions.revision };
    assert.equal((await post('/instructions/update', payload)).status, 200);
    assert.equal((await (await post('/instructions', {})).json()).instructions.text, 'ENDPOINT-GLOBAL');
    assert.equal((await post('/instructions/update', payload)).status, 409);
    assert.equal((await post('/instructions', {}, 'someone-else')).status, 409);
    assert.equal((await post('/instructions/update', payload, 'someone-else')).status, 409);
    const initialWebSearch = await post('/web-search', {});
    assert.equal(initialWebSearch.status, 200);
    const webState = await initialWebSearch.json();
    assert.equal(webState.webSearch.provider, 'off');
    assert.equal(webState.readiness.configured, false);
    const webPayload = { webSearch: { provider: 'searxng', searxngUrl: 'https://search.example.com/searxng', results: 4 }, expectedRevision: webState.webSearch.revision };
    const savedWebSearch = await post('/web-search/update', webPayload);
    assert.equal(savedWebSearch.status, 200);
    assert.equal((await savedWebSearch.json()).webSearch.results, 4);
    assert.equal((await post('/web-search/update', webPayload)).status, 409);
    assert.equal((await post('/web-search', {}, 'someone-else')).status, 409);
    assert.equal((await post('/web-search/update', { webSearch: { provider: 'searxng', searxngUrl: 'http://127.0.0.1:8080' },
        expectedRevision: 1 })).status, 403, 'a non-admin account cannot point SearXNG at a loopback address');
    const defaults = await (await post('/prompt', { assistant: 'miso' })).json();
    assert.doesNotMatch(defaults.text, /ENDPOINT-GLOBAL/, 'editing a base prompt must not bake in global text');
    const generalPrompt = await (await post('/prompt', { source: GENERAL, assistant: 'miso', capabilities: { chat: true, lore: true } })).json();
    assert.match(generalPrompt.text, /No story chat is open/);
    assert.doesNotMatch(generalPrompt.text, /Story chat messages \(use|Lorebook entries \(only/);

    const profile = { name: 'Jun', personality: 'ENDPOINT-PERSONALITY' };
    const saved = await post('/assistants/save', { assistant: profile, expectedRevision: 0 });
    assert.equal(saved.status, 200);
    const { assistant } = await saved.json();
    assert.equal((await post('/assistants/save', { assistant, expectedRevision: 0 })).status, 409);
    assert.equal((await post('/assistants', {}, 'someone-else')).status, 409);
    assert.equal((await post('/assistants/save', { assistant, expectedRevision: 1 }, 'someone-else')).status, 409);
    assert.equal((await post('/assistants/save', { card: '../Nova.png', expectedRevision: 1 })).status, 400);
    assert.match((await (await post('/prompt', { assistant: assistant.id })).json()).text, /ENDPOINT-PERSONALITY/);

    const portable = { ...assistant, id: 'assistant_111111111111111111111111', name: 'Imported Jun' };
    const imported = await post('/session/import', { source: OTHER, session: { assistant: portable.id,
        settings: { assistants: { [portable.id]: portable } } } });
    assert.equal(imported.status, 200);
    const inherited = await post('/session/create', { source: OTHER, assistant: portable.id });
    assert.equal(inherited.status, 200, 'new sessions inherit the imported assistant copy');
    const inheritedBucket = (await inherited.json()).bucket;
    const inheritedSession = inheritedBucket.sessions.find(item => item.id === inheritedBucket.activeSessionId);
    assert.equal(inheritedSession.settings.assistants[portable.id].personality, portable.personality);
    assert.match((await (await post('/prompt', { source: OTHER, sessionId: inheritedSession.id, assistant: portable.id })).json()).text, /ENDPOINT-PERSONALITY/);
    const missingProfile = await post('/session/import', { source: OTHER, session: { assistant: 'assistant_222222222222222222222222' } });
    assert.equal(missingProfile.status, 404, 'an import cannot leave an unusable assistant behind');
    assert.equal((await (await post('/bucket', { source: OTHER })).json()).bucket.sessions.length, 2);
    const active = bucket => bucket.sessions.find(item => item.id === bucket.activeSessionId);
    const withJun = active((await (await post('/session/create', { source: OTHER, assistant: assistant.id })).json()).bucket);
    assert.deepEqual(Object.keys(withJun.settings.assistants).sort(), [assistant.id, portable.id].sort());
    const fresh = active((await (await post('/session/create', { source: OTHER, assistant: 'miso' })).json()).bucket);
    assert.deepEqual(Object.keys(fresh.settings.assistants ?? {}), [portable.id], 'library assistants are not copied into every new session');

    assert.equal((await post('/assistants/delete', { id: assistant.id, expectedRevision: 0 })).status, 409);
    assert.equal((await post('/assistants/delete', { id: assistant.id, expectedRevision: 1 }, 'someone-else')).status, 409);
    const removed = await post('/assistants/delete', { id: assistant.id, expectedRevision: 1 });
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json()).library.assistants, []);
    assert.equal((await post('/assistants/delete', { id: assistant.id, expectedRevision: 2 })).status, 404);
    assert.match((await (await post('/prompt', { source: OTHER, sessionId: inheritedSession.id, assistant: portable.id })).json()).text, /ENDPOINT-PERSONALITY/,
        'sessions keep their own copy after a library delete');

    const created = await post('/session/create', { source: SOURCE, assistant: 'nori', gender: 'male' });
    assert.equal(created.status, 200);
    const { bucket } = await created.json();
    assert.equal(bucket.sessions[0].assistant, 'nori');
    assert.equal(bucket.sessions[0].name, 'Nori\'s notes');
    const renamed = await post('/session/update', { source: SOURCE, sessionId: bucket.sessions[0].id, changes: { name: 'Plot holes' } });
    assert.equal((await renamed.json()).bucket.sessions[0].name, 'Plot holes');
    const cleaned = await post('/cleanup', { source: SOURCE, cleanup: { enabled: true, keep: 3 } });
    assert.deepEqual((await cleaned.json()).bucket.cleanup, { enabled: true, keep: 3 });
    assert.deepEqual((await (await post('/bucket', { source: OTHER })).json()).bucket.cleanup, { enabled: true, keep: 3 });
    assert.equal((await post('/cleanup', { source: OTHER, cleanup: { keep: 1 } }, 'someone-else')).status, 409);
    const disabled = await post('/cleanup', { source: OTHER, cleanup: { enabled: false } });
    assert.deepEqual((await disabled.json()).bucket.cleanup, { enabled: false, keep: 3 });
    assert.deepEqual((await (await post('/bucket', { source: SOURCE })).json()).bucket.cleanup, { enabled: false, keep: 3 });
    const wrong = await post('/bucket', { source: SOURCE }, 'someone-else');
    assert.equal(wrong.status, 409);
    const missing = await post('/session/delete', { source: SOURCE, sessionId: 'nope' });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'SCRATCHPAD_SESSION_MISSING');
    const preview = await fetch(`${url}/preview/not-a-job`, { headers: { Connection: 'close' } });
    assert.equal(preview.status, 404);
});
