import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const { SETTINGS_FILE } = await import('../src/constants.js');
const CONVERSATION_STORE_KEY = 'neconyan_conversation';
const { acceptConversationRewrite, registerConversationRewriteJobs, finalizeConversationRewriteSubmission } = await import('../src/generation/conversation-rewrite.js');
const { preflightConversationBindings } = await import('../src/generation/conversation-jobs.js');
const { getJob, listJobs } = await import('../src/jobs/store.js');
const { testExports: { runJob }, setDirectoriesResolver } = await import('../src/jobs/runner.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { prepareSettingsSave } = await import('../src/settings-version.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const { getConversationMessageRevision } = await import('../public/scripts/neconyan-conversation/message-identity-utils.js');

after(() => cancelAutoSaves());

const png = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-rewrite-'));
    for (const name of ['characters', 'groups', 'userImages']) fs.mkdirSync(path.join(root, name), { recursive: true });
    const directories = { root, characters: path.join(root, 'characters'), groups: path.join(root, 'groups'), userImages: path.join(root, 'userImages') };
    fs.writeFileSync(path.join(directories.characters, 'nova.png'), writeCard(png, JSON.stringify({ name: 'Nova' })));
    fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify({
        _version: 0,
        extension_settings: {
            connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] },
            [CONVERSATION_STORE_KEY]: {
                version: 1,
                settings: { connection_profile: 'saved', schedule_command_enabled: true, selfie_command_enabled: true },
                characters: {
                    'nova.png': {
                        settings: {}, activeBranchId: 'main',
                        branches: {
                            main: {
                                id: 'main', name: 'Main', createdAt: 1,
                                messages: [
                                    { id: 'm1', role: 'user', name: 'User', mes: 'hi' },
                                    { id: 'm2', role: 'character', name: 'Nova', mes: 'hello there', extra: { conversation_commands: { selfieRequests: ['old'] } } },
                                    { id: 'm3', role: 'user', name: 'User', mes: 'how are you' },
                                ],
                            },
                        },
                    },
                },
                groups: [], reminders: [], legacyThreadPersonaAssignments: {},
            },
        },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    setDirectoriesResolver(() => directories);
    return directories;
}

const file = directories => path.join(directories.root, SETTINGS_FILE);
const readStore = directories => JSON.parse(fs.readFileSync(file(directories), 'utf8')).extension_settings[CONVERSATION_STORE_KEY];
const readMessages = directories => readStore(directories).characters['nova.png'].branches.main.messages;

/** Save the way the page does, so the server stamps edit revisions. */
function saveStore(directories, mutate) {
    const current = JSON.parse(fs.readFileSync(file(directories), 'utf8'));
    const incoming = structuredClone(current);
    mutate(incoming.extension_settings[CONVERSATION_STORE_KEY]);
    const prepared = prepareSettingsSave(incoming, current, { conversationOnly: true });
    assert.equal(prepared.ok, true);
    fs.writeFileSync(file(directories), JSON.stringify(prepared.settings));
}

async function submission(directories, { mode = 'regenerate', messageId = 'm2', through = 2, key = `${mode}-1`, extra = {} } = {}) {
    const request = { user: { profile: { handle: 'tester' }, directories } };
    const messages = readMessages(directories).slice(0, through);
    const body = {
        submissionKey: key, mode, messageId,
        target: { avatar: 'nova.png', groupId: '', personaId: '', branchId: 'main' },
        branchCreatedAt: '1', speakerAvatar: 'nova.png',
        triggers: messages.map(message => ({ messageId: message.id, revision: getConversationMessageRevision(message) })),
        options: { prompt: [{ role: 'user', content: 'Rewrite it' }], systemPrompt: 'Be Nova.', responseLength: 200 },
        timeZone: 'Europe/London',
        ...extra,
    };
    body.bindingRequest = await preflightConversationBindings(request, { ...body, bindingOnly: false });
    return { request, body };
}

test('a polish replaces only the reply text, once, even after an unrelated message arrives', async () => {
    const directories = makeDirectories();
    let calls = 0;
    registerConversationRewriteJobs({ generate: async () => { calls += 1; return { text: '  "Hello there, friend!"  ' }; } });
    const { request, body } = await submission(directories, { mode: 'polish', through: 2, extra: { triggers: undefined } });
    body.triggers = [{ messageId: 'm2', revision: getConversationMessageRevision(readMessages(directories)[1]) }];
    body.bindingRequest = await preflightConversationBindings(request, { ...body, bindingOnly: false });

    const accepted = await acceptConversationRewrite(request, body);
    assert.equal(accepted.created, true);
    assert.equal((await acceptConversationRewrite(request, body)).job.id, accepted.job.id);
    saveStore(directories, store => store.characters['nova.png'].branches.main.messages.push({ id: 'm4', role: 'user', name: 'User', mes: 'still there?' }));
    await runJob(getJob(directories, accepted.job.id));

    assert.equal(getJob(directories, accepted.job.id).state, 'completed');
    const messages = readMessages(directories);
    assert.equal(messages[1].mes, 'Hello there, friend!');
    assert.deepEqual(messages[1].extra, { conversation_commands: { selfieRequests: ['old'] } });
    assert.equal(messages[3].mes, 'still there?');
    await runJob(getJob(directories, accepted.job.id));
    assert.equal(calls, 1);
});

test('a regeneration saves the reply, its commands and reminders in one write', async () => {
    const directories = makeDirectories();
    registerConversationRewriteJobs({ generate: async () => ({ text: 'Fresh reply [selfie: context="at the park"] [reminder: 10 minutes | tea]' }) });
    const { request, body } = await submission(directories);
    const accepted = await acceptConversationRewrite(request, body);
    await runJob(getJob(directories, accepted.job.id));

    assert.equal(getJob(directories, accepted.job.id).state, 'completed');
    const store = readStore(directories);
    const message = store.characters['nova.png'].branches.main.messages[1];
    assert.equal(message.mes, 'Fresh reply');
    assert.deepEqual(message.extra.conversation_commands.selfieRequests, ['at the park']);
    assert.equal(typeof message.extra.regenerated_at, 'number');
    assert.equal(store.reminders.length, 1);
    assert.equal(store.reminders[0].text, 'tea');
    assert.equal(store.reminders[0].avatar, 'nova.png');
    assert.deepEqual(readArtifact(directories, accepted.job.id, 'result'), { messageId: 'm2', text: 'Fresh reply' });
});

test('an edit during the provider call keeps the original reply and never repeats the paid call', async () => {
    const directories = makeDirectories();
    let calls = 0;
    registerConversationRewriteJobs({ generate: async () => {
        calls += 1;
        saveStore(directories, store => { store.characters['nova.png'].branches.main.messages[0].mes = 'hi (edited)'; });
        return { text: 'Replacement' };
    } });
    const { request, body } = await submission(directories);
    const accepted = await acceptConversationRewrite(request, body);
    await runJob(getJob(directories, accepted.job.id));

    const job = getJob(directories, accepted.job.id);
    assert.notEqual(job.state, 'completed');
    assert.match(job.error.message, /original reply was kept/);
    assert.equal(readMessages(directories)[1].mes, 'hello there');
    assert.deepEqual(readArtifact(directories, accepted.job.id, 'reply'), { text: 'Replacement' });
    assert.equal(calls, 1);
});

test('a regeneration refuses before the provider call when its context already changed', async () => {
    const directories = makeDirectories();
    let calls = 0;
    registerConversationRewriteJobs({ generate: async () => { calls += 1; return { text: 'Nope' }; } });
    const { request, body } = await submission(directories);
    const accepted = await acceptConversationRewrite(request, body);
    saveStore(directories, store => { store.characters['nova.png'].branches.main.messages[1].mes = 'hand edited'; });
    await runJob(getJob(directories, accepted.job.id));

    assert.notEqual(getJob(directories, accepted.job.id).state, 'completed');
    assert.equal(calls, 0);
    assert.equal(readMessages(directories)[1].mes, 'hand edited');
});

test('a deleted reply is not recreated', async () => {
    const directories = makeDirectories();
    registerConversationRewriteJobs({ generate: async () => {
        saveStore(directories, store => { store.characters['nova.png'].branches.main.messages.splice(1, 1); });
        return { text: 'Ghost' };
    } });
    const { request, body } = await submission(directories);
    const accepted = await acceptConversationRewrite(request, body);
    await runJob(getJob(directories, accepted.job.id));

    assert.notEqual(getJob(directories, accepted.job.id).state, 'completed');
    assert.equal(readMessages(directories).some(message => message.mes === 'Ghost'), false);
});

test('an empty provider reply fails honestly and leaves the reply alone', async () => {
    const directories = makeDirectories();
    registerConversationRewriteJobs({ generate: async () => ({ text: '   ' }) });
    const { request, body } = await submission(directories, { mode: 'polish', extra: {} });
    const accepted = await acceptConversationRewrite(request, body);
    await runJob(getJob(directories, accepted.job.id));

    const job = getJob(directories, accepted.job.id);
    assert.equal(job.state, 'failed');
    assert.equal(job.error.message, 'Could not rewrite the reply. The model returned no text.');
    assert.equal(readMessages(directories)[1].mes, 'hello there');
});

test('submissions that cannot be rewritten are refused without a job', async () => {
    const directories = makeDirectories();
    registerConversationRewriteJobs({ generate: async () => ({ text: 'x' }) });
    const user = await submission(directories, { messageId: 'm1', through: 1, key: 'user-message' });
    await assert.rejects(acceptConversationRewrite(user.request, user.body), /Only a character reply/);
    const outside = await submission(directories, { messageId: 'm2', through: 1, key: 'outside' });
    await assert.rejects(acceptConversationRewrite(outside.request, outside.body), /part of the captured context/);
    const mode = await submission(directories, { key: 'mode' });
    await assert.rejects(acceptConversationRewrite(mode.request, { ...mode.body, mode: 'translate' }), /mode is invalid/);
    const zone = await submission(directories, { key: 'zone' });
    await assert.rejects(acceptConversationRewrite(zone.request, { ...zone.body, timeZone: 'Mars/Olympus' }), /timezone is invalid/);
    assert.equal(listJobs(directories, { owner: 'tester', includeDismissed: true }).length, 0);

    const reused = await submission(directories, { key: 'reused' });
    await acceptConversationRewrite(reused.request, reused.body);
    await assert.rejects(acceptConversationRewrite(reused.request, { ...reused.body, options: { ...reused.body.options, responseLength: 300 } }), /another operation/);
});

test('a paused rewrite without its saved request fails for a deliberate retry after a crash', async () => {
    const directories = makeDirectories();
    const { request, body } = await submission(directories);
    const accepted = await acceptConversationRewrite(request, body);
    fs.rmSync(path.join(directories.root, 'jobs', 'artifacts'), { recursive: true, force: true });
    assert.equal(readArtifact(directories, accepted.job.id, 'request'), undefined);
    const job = await finalizeConversationRewriteSubmission(request, getJob(directories, accepted.job.id));
    assert.equal(job.state, 'failed');
    assert.equal(job.recoverability, 'needs-retry');
});
