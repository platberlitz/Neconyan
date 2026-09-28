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
const { acceptConversationAside, registerConversationReplyJob } = await import('../src/generation/conversation-jobs.js');
const { getJob } = await import('../src/jobs/store.js');
const { testExports: { runJob }, setDirectoriesResolver } = await import('../src/jobs/runner.js');
const { testExports: { reconcileConversationJob } } = await import('../src/generation/conversation-worker.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { getRoleplayGroupRevision, getRoleplaySourceMessageRevision } = await import('../public/scripts/neconyan-conversation/roleplay-source.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const { createConversationImageGenerator } = await import('../src/generation/conversation-images.js');

after(() => cancelAutoSaves());

function makeDirectories() {
    // The protected store lives beside the account root, so give each account its own parent folder.
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-roleplay-source-')), 'account');
    for (const name of ['characters', 'chats', 'groupChats', 'groups', 'userImages']) fs.mkdirSync(path.join(root, name), { recursive: true });
    return { root, characters: path.join(root, 'characters'), chats: path.join(root, 'chats'), groupChats: path.join(root, 'groupChats'), groups: path.join(root, 'groups'), userImages: path.join(root, 'userImages') };
}

function writeSettings(directories) {
    fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify({
        _version: 0,
        extension_settings: {
            connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] },
            [CONVERSATION_STORE_KEY]: {
                version: 1,
                settings: { connection_profile: 'saved', enabled: true, roleplay_reactions: true },
                characters: {
                    'nova.png': {
                        settings: { enabled: true, roleplay_reactions: true }, activeBranchId: 'main',
                        branches: {
                            main: {
                                id: 'main', name: 'Main', createdAt: 1,
                                messages: [
                                    { id: 'm1', role: 'user', name: 'User', mes: 'hi' },
                                    { id: 'm2', role: 'character', name: 'Nova', mes: 'hello there' },
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
}

function writeCardFile(directories) {
    const png = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));
    fs.writeFileSync(path.join(directories.characters, 'nova.png'), writeCard(png, JSON.stringify({ name: 'Nova', description: 'x' })));
}

function writeChat(filePath, messages) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [JSON.stringify({ chat_metadata: {} }), ...messages.map(message => JSON.stringify(message))].join('\n') + '\n');
}

function readStore(directories) {
    return JSON.parse(fs.readFileSync(path.join(directories.root, SETTINGS_FILE), 'utf8')).extension_settings[CONVERSATION_STORE_KEY];
}

async function runFamily(directories, rootId) {
    await runJob(getJob(directories, rootId));
    for (const childId of getJob(directories, rootId).children || []) await runJob(getJob(directories, childId));
    await reconcileConversationJob(directories, getJob(directories, rootId));
}

function setup() {
    const directories = makeDirectories();
    writeSettings(directories);
    writeCardFile(directories);
    setDirectoriesResolver(() => directories);
    registerConversationReplyJob({ generate: async () => ({ text: 'private aside' }) });
    return { directories, request: { user: { profile: { handle: 'tester' }, directories } } };
}

test('a group mention aside is accepted natively, sets a durable delay and claims the cooldown once', async () => {
    const { directories, request } = setup();
    const group = { id: 'g1', name: 'Crew', members: ['nova.png'], disabled_members: [], chats: ['crew'] };
    fs.writeFileSync(path.join(directories.groups, 'g1.json'), JSON.stringify(group));
    const messages = [
        { id: 'g0', role: 'user', name: 'User', mes: '@Nova hello' },
        { id: 'g1', role: 'character', name: 'Nova', mes: 'Hey there', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.groupChats, 'crew.jsonl'), messages);
    const submission = {
        target: { avatar: 'nova.png', personaId: '', branchId: 'main' },
        source: { locator: { chat: 'crew', avatar: '', group: true }, groupId: 'g1' },
        messageIndex: 0,
        messageRevision: getRoleplaySourceMessageRevision(messages[0]),
        groupRevision: getRoleplayGroupRevision(group),
        reason: 'mention',
    };

    const accepted = await acceptConversationAside(request, submission);
    assert.equal(accepted.created, true);
    assert.equal(accepted.job.intent.automation.delayMs, 900);

    await runFamily(directories, accepted.job.id);
    const finished = getJob(directories, accepted.job.id);
    assert.equal(finished.state, 'completed', JSON.stringify(finished.error));

    const branch = readStore(directories).characters['nova.png'].branches.main;
    const delivered = branch.messages[branch.messages.length - 1];
    assert.equal(delivered.mes, 'private aside');
    assert.equal(delivered.extra.source_group_id, 'g1');
    assert.equal(delivered.extra.group_aside_reason, 'mention');
    const key = JSON.stringify(['', 'g1', 'nova.png']);
    assert.equal(typeof readStore(directories).groupAsideLastSent[key], 'number');
    assert.equal(fs.existsSync(path.join(directories.root, 'mewmory')), false);

    const duplicate = await acceptConversationAside(request, submission);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, accepted.job.id);

    const second = { ...submission, messageIndex: 1, messageRevision: getRoleplaySourceMessageRevision(messages[1]), reason: 'random' };
    const cooled = await acceptConversationAside(request, second);
    assert.equal(cooled.created, false);
    assert.equal(cooled.skipped, 'cooldown');
});

test('a solo side DM is accepted with its own delay and no group cooldown', async () => {
    const { directories, request } = setup();
    const messages = [
        { id: 'r0', role: 'user', name: 'User', mes: 'The dragon roars.' },
        { id: 'r1', role: 'character', name: 'Nova', mes: 'I draw my blade.', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.chats, 'nova', 'roleplay.jsonl'), messages);

    const accepted = await acceptConversationAside(request, {
        target: { avatar: 'nova.png', personaId: '', branchId: 'main' },
        source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
        messageIndex: 1,
        messageRevision: getRoleplaySourceMessageRevision(messages[1]),
        reason: 'reaction',
    });
    assert.equal(accepted.created, true);
    assert.equal(accepted.job.intent.automation.delayMs, 2000);

    await runFamily(directories, accepted.job.id);
    assert.equal(getJob(directories, accepted.job.id).state, 'completed');
    const branch = readStore(directories).characters['nova.png'].branches.main;
    assert.equal(branch.messages[branch.messages.length - 1].mes, 'private aside');
    assert.equal(readStore(directories).groupAsideLastSent, undefined);
});

test('a delivered aside stores narration once and recovery never narrates an already delivered bubble', async () => {
    const { directories, request } = setup();
    const messages = [
        { id: 'n0', role: 'user', name: 'User', mes: 'The dragon roars.' },
        { id: 'n1', role: 'character', name: 'Nova', mes: 'I draw my blade.', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.chats, 'nova', 'narration.jsonl'), messages);

    const narration = { status: 'ready', job: 'narration-child', artifact: 'narration:reply:0', mimeType: 'audio/mpeg' };
    let narratedText = '';
    let narrationCalls = 0;
    registerConversationReplyJob({
        generate: async () => ({ text: 'narrated aside' }),
        narrate: async (context, snapshot, text) => { narrationCalls++; narratedText = text; return narration; },
    });

    const accepted = await acceptConversationAside(request, {
        target: { avatar: 'nova.png', personaId: '', branchId: 'main' },
        source: { locator: { chat: 'narration', avatar: 'nova.png', group: false } },
        messageIndex: 1,
        messageRevision: getRoleplaySourceMessageRevision(messages[1]),
        reason: 'reaction',
    });

    await runFamily(directories, accepted.job.id);
    assert.equal(getJob(directories, accepted.job.id).state, 'completed');

    const branch = readStore(directories).characters['nova.png'].branches.main;
    const delivered = branch.messages[branch.messages.length - 1];
    assert.equal(narratedText, 'narrated aside');
    assert.equal(branch.unread, 1);
    assert.deepEqual(branch.pendingPresentations[delivered.id].narration, narration);
    const { writeArtifact } = await import('../src/jobs/artifacts.js');
    const { updateJob } = await import('../src/jobs/store.js');
    const child = getJob(directories, accepted.job.id).children[0];
    writeArtifact(directories, child, 'result', null);
    updateJob(directories, child, { state: 'queued' });
    await runJob(getJob(directories, child));
    assert.equal(getJob(directories, child).state, 'completed');
    assert.equal(narrationCalls, 1);
    // A delivered receipt must not bypass source validation on a later recovery.
    messages[1].mes = 'The source has changed';
    writeChat(path.join(directories.chats, 'nova', 'narration.jsonl'), messages);
    writeArtifact(directories, child, 'result', null);
    updateJob(directories, child, { state: 'queued' });
    await runJob(getJob(directories, child));
    assert.notEqual(getJob(directories, child).state, 'completed');
    assert.equal(narrationCalls, 1);
});

test('an aside source edited during speech synthesis is rejected before delivery', async () => {
    const { directories, request } = setup();
    const messages = [{ id: 'n0', role: 'character', name: 'Nova', mes: 'Original', original_avatar: 'nova.png' }];
    const filename = path.join(directories.chats, 'nova', 'pending-speech.jsonl');
    writeChat(filename, messages);
    registerConversationReplyJob({
        generate: async () => ({ text: 'Must not be delivered' }),
        narrate: async () => { messages[0].mes = 'Edited'; writeChat(filename, messages); return null; },
    });
    const accepted = await acceptConversationAside(request, {
        target: { avatar: 'nova.png', personaId: '', branchId: 'main' },
        source: { locator: { chat: 'pending-speech', avatar: 'nova.png', group: false } },
        messageIndex: 0, messageRevision: getRoleplaySourceMessageRevision(messages[0]), reason: 'reaction',
    });
    await runFamily(directories, accepted.job.id);
    assert.notEqual(getJob(directories, accepted.job.id).state, 'completed');
    const branch = readStore(directories).characters['nova.png'].branches.main;
    assert.equal(branch.messages.some(message => message.mes === 'Must not be delivered'), false);
});

test('the bridge refuses changed revisions, unknown fields and missing chats', async () => {
    const { directories, request } = setup();
    const group = { id: 'g1', name: 'Crew', members: ['nova.png'], disabled_members: [], chats: ['crew'] };
    fs.writeFileSync(path.join(directories.groups, 'g1.json'), JSON.stringify(group));
    const messages = [
        { id: 'g0', role: 'user', name: 'User', mes: '@Nova hello' },
        { id: 'g1', role: 'character', name: 'Nova', mes: 'Hey there', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.groupChats, 'crew.jsonl'), messages);
    const submission = {
        target: { avatar: 'nova.png', personaId: '', branchId: 'main' },
        source: { locator: { chat: 'crew', avatar: '', group: true }, groupId: 'g1' },
        messageIndex: 1,
        messageRevision: getRoleplaySourceMessageRevision(messages[1]),
        groupRevision: getRoleplayGroupRevision(group),
        reason: 'random',
    };

    await assert.rejects(() => acceptConversationAside(request, { ...submission, messageRevision: 'stale' }), error => error.apiError === 'roleplay_message_revision_mismatch');
    await assert.rejects(() => acceptConversationAside(request, { ...submission, directive: 'not allowed' }), error => error.apiError === 'invalid_aside_submission');
    await assert.rejects(() => acceptConversationAside(request, {
        ...submission,
        source: { locator: { chat: 'missing', avatar: '', group: true }, groupId: 'g1' },
    }), error => error.apiError === 'roleplay_chat_not_found');
});

test('a mention built from a character message is refused', async () => {
    const { directories, request } = setup();
    const group = { id: 'g1', name: 'Crew', members: ['nova.png'], disabled_members: [], chats: ['crew'] };
    fs.writeFileSync(path.join(directories.groups, 'g1.json'), JSON.stringify(group));
    const messages = [
        { id: 'g0', role: 'user', name: 'User', mes: '@Nova hello' },
        { id: 'g1', role: 'character', name: 'Nova', mes: 'Hey there', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.groupChats, 'crew.jsonl'), messages);

    await assert.rejects(() => acceptConversationAside(request, {
        target: { avatar: 'nova.png', personaId: '', branchId: 'main' },
        source: { locator: { chat: 'crew', avatar: '', group: true }, groupId: 'g1' },
        messageIndex: 1,
        messageRevision: getRoleplaySourceMessageRevision(messages[1]),
        groupRevision: getRoleplayGroupRevision(group),
        reason: 'mention',
    }), error => error.apiError === 'roleplay_mention_not_user');
});

test('a group aside only accepts a chat the group owns', async () => {
    const { directories, request } = setup();
    const group = { id: 'g1', name: 'Crew', members: ['nova.png'], disabled_members: [], chats: ['other'] };
    fs.writeFileSync(path.join(directories.groups, 'g1.json'), JSON.stringify(group));
    const messages = [
        { id: 'g0', role: 'user', name: 'User', mes: '@Nova hello' },
        { id: 'g1', role: 'character', name: 'Nova', mes: 'Hey there', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.groupChats, 'crew.jsonl'), messages);

    await assert.rejects(() => acceptConversationAside(request, {
        target: { avatar: 'nova.png', personaId: '', branchId: 'main' },
        source: { locator: { chat: 'crew', avatar: '', group: true }, groupId: 'g1' },
        messageIndex: 0,
        messageRevision: getRoleplaySourceMessageRevision(messages[0]),
        groupRevision: getRoleplayGroupRevision(group),
        reason: 'random',
    }), error => error.apiError === 'roleplay_group_chat_mismatch');
});

test('a source changed after acceptance is refused before generation', async () => {
    const { directories, request } = setup();
    const group = { id: 'g1', name: 'Crew', members: ['nova.png'], disabled_members: [], chats: ['crew'] };
    fs.writeFileSync(path.join(directories.groups, 'g1.json'), JSON.stringify(group));
    const messages = [
        { id: 'g0', role: 'user', name: 'User', mes: '@Nova hello' },
        { id: 'g1', role: 'character', name: 'Nova', mes: 'Hey there', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.groupChats, 'crew.jsonl'), messages);
    const accepted = await acceptConversationAside(request, {
        target: { avatar: 'nova.png', personaId: '', branchId: 'main' },
        source: { locator: { chat: 'crew', avatar: '', group: true }, groupId: 'g1' },
        messageIndex: 0,
        messageRevision: getRoleplaySourceMessageRevision(messages[0]),
        groupRevision: getRoleplayGroupRevision(group),
        reason: 'random',
    });

    let generated = false;
    registerConversationReplyJob({ generate: async () => { generated = true; return { text: 'should not happen' }; } });
    writeChat(path.join(directories.groupChats, 'crew.jsonl'), [{ ...messages[0], mes: '@Nova hello there' }, messages[1]]);
    await runFamily(directories, accepted.job.id).catch(() => {});

    assert.equal(generated, false);
    assert.equal(readStore(directories).characters['nova.png'].branches.main.messages.length, 3);
});

test('the aside delay is resumable across a restart', async () => {
    const { directories, request } = setup();
    const messages = [
        { id: 'r0', role: 'user', name: 'User', mes: 'The dragon roars.' },
        { id: 'r1', role: 'character', name: 'Nova', mes: 'I draw my blade.', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.chats, 'nova', 'roleplay.jsonl'), messages);
    let jobId = '';
    const observed = [];
    registerConversationReplyJob({
        generate: async () => ({ text: 'private aside' }),
        sleep: async () => {
            const root = getJob(directories, jobId);
            const childId = (root?.children || [])[0];
            observed.push((childId ? getJob(directories, childId)?.resume : null) || null);
        },
    });
    const accepted = await acceptConversationAside(request, {
        target: { avatar: 'nova.png', personaId: '', branchId: 'main' },
        source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
        messageIndex: 1,
        messageRevision: getRoleplaySourceMessageRevision(messages[1]),
        reason: 'reaction',
    });
    jobId = accepted.job.id;

    await runFamily(directories, jobId);

    assert.ok(observed.includes('automation-delay'), JSON.stringify(observed));
    assert.equal(getJob(directories, jobId).state, 'completed');
});

test('image delivery revalidates the Roleplay aside source before any image work', async t => {
    const directories = makeDirectories();
    t.after(() => { cancelAutoSaves(); fs.rmSync(path.dirname(directories.root), { recursive: true, force: true }); });
    writeSettings(directories);
    writeCardFile(directories);
    const { initialiseRoleplayAccount } = await import('../src/roleplay-store.js');
    const { captureConversationTarget } = await import('../src/generation/conversation-effects.js');
    const { acceptJob } = await import('../src/jobs/store.js');
    const owner = path.basename(directories.root);
    initialiseRoleplayAccount({ owner, directories });
    const request = { user: { profile: { handle: owner }, directories } };
    const target = captureConversationTarget(request, { avatar: 'nova.png', personaId: '', branchId: 'main' });
    const { job } = acceptJob(directories, { owner, type: 'conversation.reply', submissionKey: 'image-aside-source', intent: { target } });
    const generateImage = createConversationImageGenerator({ fetchImpl: () => assert.fail('A missing aside source must not reach the image provider.') });
    const staleSource = {
        target: { avatar: 'nova.png', personaId: '', branchId: 'main' },
        source: { locator: { chat: 'missing', avatar: '', group: true }, groupId: 'g1' },
        messageIndex: 0, messageRevision: 'stale', groupRevision: 'stale', reason: 'random',
    };
    await assert.rejects(
        () => generateImage(
            { directories, owner, job, signal: new AbortController().signal },
            {
                settings: { image_gen_enabled: true },
                automation: { roleplaySource: staleSource },
                target,
                userName: 'User',
            },
            'show me',
            { avatar: 'nova.png', name: 'Nova' },
        ),
        error => error.apiError === 'roleplay_chat_not_found',
    );
});

test('a protected account binds the aside to the chat instance and refuses a replaced chat', async () => {
    const { directories, request } = setup();
    const { initialiseRoleplayAccount } = await import('../src/roleplay-store.js');
    initialiseRoleplayAccount({ owner: path.basename(directories.root), directories });
    const messages = [
        { id: 'p0', role: 'user', name: 'User', mes: 'The storm breaks.' },
        { id: 'p1', role: 'character', name: 'Nova', mes: 'I hold the line.', original_avatar: 'nova.png' },
    ];
    const chatFile = path.join(directories.chats, 'nova', 'protected.jsonl');
    writeChat(chatFile, messages);
    const submission = {
        target: { avatar: 'nova.png', personaId: '', branchId: 'main' },
        source: { locator: { chat: 'protected', avatar: 'nova.png', group: false }, groupId: '' },
        messageIndex: 1,
        messageRevision: getRoleplaySourceMessageRevision(messages[1]),
        groupRevision: '',
        reason: 'random',
    };
    const accepted = await acceptConversationAside(request, submission);
    assert.equal(accepted.created, true);
    const instanceId = accepted.job.intent.automation.roleplaySource.instanceId;
    assert.match(instanceId, /^[0-9a-f-]{36}$/);

    const replay = await acceptConversationAside(request, submission);
    assert.equal(replay.created, false);
    assert.equal(replay.job.id, accepted.job.id);

    fs.rmSync(chatFile);
    writeChat(chatFile, messages);
    await runFamily(directories, accepted.job.id);
    const finished = getJob(directories, accepted.job.id);
    assert.notEqual(finished.state, 'completed');
    const branch = readStore(directories).characters['nova.png'].branches.main;
    assert.equal(branch.messages.some(message => message.mes === 'private aside'), false);
});
