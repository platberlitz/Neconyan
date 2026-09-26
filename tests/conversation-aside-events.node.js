import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const { SETTINGS_FILE } = await import('../src/constants.js');
const CONVERSATION_STORE_KEY = 'sillybunny_conversation';
const { registerConversationReplyJob } = await import('../src/generation/conversation-jobs.js');
const { acceptConversationAsideEvent } = await import('../src/generation/conversation-aside-events.js');
const { getJob } = await import('../src/jobs/store.js');
const { testExports: { runJob }, setDirectoriesResolver } = await import('../src/jobs/runner.js');
const { testExports: { reconcileConversationJob } } = await import('../src/generation/conversation-worker.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { getRoleplayGroupRevision, getRoleplaySourceMessageRevision } = await import('../public/scripts/neconyan-conversation/roleplay-source.js');
const { write: writeCard } = await import('../src/character-card-parser.js');

after(() => cancelAutoSaves());

const CARDS = { 'nova.png': 'Nova', 'lyra.png': 'Lyra' };
const BRANCHES = Object.fromEntries(Object.keys(CARDS).map(avatar => [avatar, {
    settings: { enabled: true, roleplay_reactions: true },
    activeBranchId: 'main',
    branches: { main: { id: 'main', name: 'Main', createdAt: 1, messages: [] } },
}]));

function makeDirectories() {
    // The protected store lives beside the account root, so give each account its own parent folder.
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-aside-events-')), 'account');
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
                characters: structuredClone(BRANCHES),
                groups: [], reminders: [], legacyThreadPersonaAssignments: {},
            },
        },
        oai_settings: { chat_completion_source: 'openai' },
    }));
}

function writeCards(directories) {
    const png = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));
    for (const [avatar, name] of Object.entries(CARDS)) {
        fs.writeFileSync(path.join(directories.characters, avatar), writeCard(png, JSON.stringify({ name, description: 'x' })));
    }
}

function writeChat(filePath, messages) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [JSON.stringify({ chat_metadata: {} }), ...messages.map(message => JSON.stringify(message))].join('\n') + '\n');
}

function readStore(directories) {
    return JSON.parse(fs.readFileSync(path.join(directories.root, SETTINGS_FILE), 'utf8')).extension_settings[CONVERSATION_STORE_KEY];
}

function conversationSettings(directories, threadKey, values) {
    const store = readStore(directories);
    const thread = store.characters[threadKey] ?? {};
    thread.settings = { ...(thread.settings || {}), ...values };
    store.characters[threadKey] = thread;
    fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify({
        _version: 0,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] }, [CONVERSATION_STORE_KEY]: store },
        oai_settings: { chat_completion_source: 'openai' },
    }));
}

async function runFamily(directories, rootId) {
    await runJob(getJob(directories, rootId));
    for (const childId of getJob(directories, rootId).children || []) await runJob(getJob(directories, childId));
    await reconcileConversationJob(directories, getJob(directories, rootId));
}

function setup() {
    const directories = makeDirectories();
    writeSettings(directories);
    writeCards(directories);
    setDirectoriesResolver(() => directories);
    registerConversationReplyJob({ generate: async () => ({ text: 'private aside' }) });
    return { directories, request: { user: { profile: { handle: 'tester' }, directories } } };
}

const always = () => true;
const never = () => false;

function groupEvent(directories, { group, messages, messageIndex = 0, kind = 'mention', speakerAvatar = '', personaId = '' }) {
    const message = messages[messageIndex];
    return {
        eventKey: `event:${kind}:${group.id}:${message.id}`,
        personaId,
        kind,
        source: { locator: { chat: 'crew', avatar: '', group: true }, groupId: group.id },
        messageIndex,
        messageRevision: getRoleplaySourceMessageRevision(message),
        groupRevision: getRoleplayGroupRevision(group),
        speakerAvatar,
    };
}

test('a group mention event is answered by the member the message names, and repeating it never pays twice', async () => {
    const { directories, request } = setup();
    const group = { id: 'g1', name: 'Crew', members: ['nova.png', 'lyra.png'], disabled_members: [], chats: ['crew'] };
    fs.writeFileSync(path.join(directories.groups, 'g1.json'), JSON.stringify(group));
    const messages = [
        { id: 'm0', role: 'user', name: 'User', mes: '@Lyra are you awake?' },
        { id: 'm1', role: 'character', name: 'Nova', mes: 'Still here.', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.groupChats, 'crew.jsonl'), messages);
    const event = groupEvent(directories, { group, messages });

    // The page names no recipient. The member the saved message names answers.
    const decided = await acceptConversationAsideEvent(request, event);
    assert.equal(decided.accepted, true);
    assert.equal(decided.avatar, 'lyra.png');
    assert.equal(decided.reason, 'mention');
    assert.equal(decided.skipped, null);
    assert.equal(getJob(directories, decided.jobId).intent.automation.delayMs, 900);

    const repeated = await acceptConversationAsideEvent(request, event);
    assert.equal(repeated.accepted, false);
    assert.equal(repeated.avatar, 'lyra.png');
    assert.equal(repeated.jobId, decided.jobId);

    await runFamily(directories, decided.jobId);
    const branch = readStore(directories).characters['lyra.png'].branches.main;
    const delivered = branch.messages[branch.messages.length - 1];
    assert.equal(delivered.mes, 'private aside');
    assert.equal(delivered.extra.group_aside_reason, 'mention');
    assert.equal(readStore(directories).characters['nova.png'].branches.main.messages.length, 0);
});

test('a rendered group event is sampled by the server, answers for the only member left, and repeats as the same job', async () => {
    const { directories, request } = setup();
    const group = { id: 'g2', name: 'Crew', members: ['nova.png', 'lyra.png'], disabled_members: ['lyra.png'], chats: ['crew'] };
    fs.writeFileSync(path.join(directories.groups, 'g2.json'), JSON.stringify(group));
    const messages = [
        { id: 'm0', role: 'user', name: 'User', mes: 'The bridge creaks.' },
        { id: 'm1', role: 'character', name: 'Nova', mes: 'Hold the line.', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.groupChats, 'crew.jsonl'), messages);
    const event = groupEvent(directories, { group, messages, messageIndex: 1, kind: 'rendered', speakerAvatar: 'nova.png' });

    const sampledOut = await acceptConversationAsideEvent(request, event, { rollPercent: never });
    assert.deepEqual(
        { accepted: sampledOut.accepted, skipped: sampledOut.skipped, jobId: sampledOut.jobId },
        { accepted: false, skipped: 'sampled_out', jobId: null });

    // The only member left is the speaker, and the server answers for them as a
    // reaction, the reason the page used when the speaker was chosen.
    const spoken = await acceptConversationAsideEvent(request, event, { rollPercent: always });
    assert.equal(spoken.accepted, true);
    assert.equal(spoken.avatar, 'nova.png');
    assert.equal(spoken.reason, 'reaction');
    assert.equal(getJob(directories, spoken.jobId).intent.automation.delayMs, 2000);

    // A second render of the same message is the same event, not a second call.
    const again = await acceptConversationAsideEvent(request, event, { rollPercent: always });
    assert.equal(again.accepted, false);
    assert.equal(again.jobId, spoken.jobId);
});

test('a rendered solo event is opt-in and sampled, then answers for the chat\'s own character without a group cooldown', async () => {
    const { directories, request } = setup();
    const messages = [
        { id: 'r0', role: 'user', name: 'User', mes: 'The dragon roars.' },
        { id: 'r1', role: 'character', name: 'Nova', mes: 'I draw my blade.', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.chats, 'nova', 'roleplay.jsonl'), messages);
    const event = {
        eventKey: 'event:rendered:roleplay:r1',
        personaId: '',
        kind: 'rendered',
        source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
        messageIndex: 1,
        messageRevision: getRoleplaySourceMessageRevision(messages[1]),
        groupRevision: '',
        speakerAvatar: '',
    };

    // Solo reactions stay off until the character's own thread opts in.
    conversationSettings(directories, 'nova.png', { roleplay_reactions: false });
    assert.equal((await acceptConversationAsideEvent(request, event, { rollPercent: always })).skipped, 'disabled');
    conversationSettings(directories, 'nova.png', { roleplay_reactions: true });
    assert.equal((await acceptConversationAsideEvent(request, event, { rollPercent: never })).skipped, 'sampled_out');

    const decided = await acceptConversationAsideEvent(request, event, { rollPercent: always });
    assert.equal(decided.accepted, true);
    assert.equal(decided.avatar, 'nova.png');
    assert.equal(decided.reason, 'reaction');
    await runFamily(directories, decided.jobId);
    assert.equal(getJob(directories, decided.jobId).state, 'completed');
    assert.equal(readStore(directories).groupAsideLastSent, undefined);
});

test('an aside event refuses a stale source, a wrong-kind event and a page that names its own recipient', async () => {
    const { directories, request } = setup();
    const group = { id: 'g3', name: 'Crew', members: ['nova.png'], disabled_members: [], chats: ['crew'] };
    fs.writeFileSync(path.join(directories.groups, 'g3.json'), JSON.stringify(group));
    const messages = [
        { id: 'm0', role: 'user', name: 'User', mes: 'Anyone there?' },
        { id: 'm1', role: 'character', name: 'Nova', mes: 'Here.', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.groupChats, 'crew.jsonl'), messages);
    writeChat(path.join(directories.chats, 'nova', 'roleplay.jsonl'), messages);
    const mention = groupEvent(directories, { group, messages });

    await assert.rejects(
        () => acceptConversationAsideEvent(request, { ...mention, messageRevision: 'stale' }),
        error => error.status === 409 && error.apiError === 'roleplay_message_revision_mismatch');
    await assert.rejects(
        () => acceptConversationAsideEvent(request, { ...mention, groupRevision: 'stale' }),
        error => error.status === 409 && error.apiError === 'roleplay_group_revision_mismatch');
    await assert.rejects(
        () => acceptConversationAsideEvent(request, { ...mention, target: { avatar: 'lyra.png' } }),
        error => error.status === 400 && error.apiError === 'invalid_aside_event');
    await assert.rejects(
        () => acceptConversationAsideEvent(request, { ...mention, kind: 'shrug' }),
        error => error.status === 400 && error.apiError === 'invalid_aside_event');
    await assert.rejects(
        () => acceptConversationAsideEvent(request, { ...mention, messageIndex: -1 }),
        error => error.status === 400 && error.apiError === 'invalid_aside_event');

    // A mention needs a user-authored message; a character message is a
    // malformed event, refused by the same rule the recipient path uses.
    const onCharacter = groupEvent(directories, { group, messages, messageIndex: 1, kind: 'mention' });
    await assert.rejects(
        () => acceptConversationAsideEvent(request, onCharacter),
        error => error.status === 409 && error.apiError === 'roleplay_mention_not_user');
    const soloMention = {
        eventKey: 'event:mention:roleplay:r1', personaId: '', kind: 'mention',
        source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
        messageIndex: 0, messageRevision: getRoleplaySourceMessageRevision(messages[0]), groupRevision: '', speakerAvatar: '',
    };
    assert.equal((await acceptConversationAsideEvent(request, soloMention)).skipped, 'mention_requires_group');
    assert.equal((await acceptConversationAsideEvent(request, { ...mention, messageIndex: 0, messageRevision: getRoleplaySourceMessageRevision(messages[0]) })).skipped, 'no_mention');
});

test('an ineligible member costs nothing: the server reports the decision instead of calling a provider', async () => {
    const { directories, request } = setup();
    const group = { id: 'g4', name: 'Crew', members: ['nova.png'], disabled_members: [], chats: ['crew'] };
    fs.writeFileSync(path.join(directories.groups, 'g4.json'), JSON.stringify(group));
    const messages = [
        { id: 'm0', role: 'user', name: 'User', mes: '@Nova hello' },
        { id: 'm1', role: 'character', name: 'Nova', mes: 'Hey.', original_avatar: 'nova.png' },
    ];
    writeChat(path.join(directories.groupChats, 'crew.jsonl'), messages);
    const event = groupEvent(directories, { group, messages });

    // Opted-out members are filtered before anybody is chosen, as the page did.
    conversationSettings(directories, 'group:g4:nova.png', { roleplay_reactions: false });
    const disabled = await acceptConversationAsideEvent(request, event);
    assert.equal(disabled.accepted, false);
    assert.equal(disabled.skipped, 'no_member');

    conversationSettings(directories, 'group:g4:nova.png', { roleplay_reactions: true, enabled: false });
    assert.equal((await acceptConversationAsideEvent(request, event)).skipped, 'no_member');
    conversationSettings(directories, 'group:g4:nova.png', { roleplay_reactions: true, enabled: true });

    const store = readStore(directories);
    delete store.characters['nova.png'].activeBranchId;
    fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify({
        _version: 0,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] }, [CONVERSATION_STORE_KEY]: store },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    const noBranch = await acceptConversationAsideEvent(request, event);
    assert.equal(noBranch.accepted, false);
    assert.equal(noBranch.skipped, 'ineligible');
    assert.equal(noBranch.jobId, null);
});
