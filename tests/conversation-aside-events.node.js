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
const { registerConversationReplyJob } = await import('../src/generation/conversation-jobs.js');
const { acceptConversationAsideEvent, drawConversationAsideEvent, normalizeConversationAsideEvent } = await import('../src/generation/conversation-aside-events.js');
const { getJob, listJobs } = await import('../src/jobs/store.js');
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

/** The chance draw the server makes for one event, from 0 to 99; below 18 earns an aside. */
const drawOf = (event, purpose = 'chance', bound = 100) => drawConversationAsideEvent('tester', normalizeConversationAsideEvent(event), purpose, bound);

/**
 * The draw is fixed by the event, so a test cannot ask for a result: it looks
 * for the wording of a saved line whose event draws the way the test needs.
 */
function lineThatDraws(eventFor, wanted) {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
        const mes = `Hold the line, attempt ${attempt}.`;
        if (wanted(eventFor(mes))) return mes;
    }
    throw new Error('No line drew the wanted result.');
}

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
    const line = (index, mes) => ({ id: `m${index}`, role: 'character', name: 'Nova', mes, original_avatar: 'nova.png' });
    const eventAt = (index, mes) => groupEvent(directories, { group, messages: { [index]: line(index, mes) }, messageIndex: index, kind: 'rendered', speakerAvatar: 'nova.png' });
    const messages = [
        { id: 'm0', role: 'user', name: 'User', mes: 'The bridge creaks.' },
        line(1, lineThatDraws(mes => eventAt(1, mes), event => drawOf(event) >= 18)),
        line(2, lineThatDraws(mes => eventAt(2, mes), event => drawOf(event) < 18)),
    ];
    writeChat(path.join(directories.groupChats, 'crew.jsonl'), messages);

    // This used to expect a second submission of a sampled-out event to roll again
    // and be answered. That re-roll was the defect: every tab, device and reload
    // got a fresh chance at the same message. A sampled-out event now stays out.
    for (let submission = 0; submission < 3; submission += 1) {
        const sampledOut = await acceptConversationAsideEvent(request, eventAt(1, messages[1].mes));
        assert.deepEqual(
            { accepted: sampledOut.accepted, skipped: sampledOut.skipped, jobId: sampledOut.jobId },
            { accepted: false, skipped: 'sampled_out', jobId: null });
    }

    // The only member left is the speaker, and the server answers for them as a
    // reaction, the reason the page used when the speaker was chosen.
    const event = eventAt(2, messages[2].mes);
    const spoken = await acceptConversationAsideEvent(request, event);
    assert.equal(spoken.accepted, true);
    assert.equal(spoken.avatar, 'nova.png');
    assert.equal(spoken.reason, 'reaction');
    assert.equal(getJob(directories, spoken.jobId).intent.automation.delayMs, 2000);

    // A second render of the same message is the same event, not a second call.
    const again = await acceptConversationAsideEvent(request, event);
    assert.equal(again.accepted, false);
    assert.equal(again.jobId, spoken.jobId);
});

test('the same rendered event submitted again never pays a second group member', async () => {
    const { directories, request } = setup();
    const group = { id: 'g9', name: 'Crew', members: ['nova.png', 'lyra.png'], disabled_members: [], chats: ['crew'] };
    fs.writeFileSync(path.join(directories.groups, 'g9.json'), JSON.stringify(group));
    const line = mes => ({ id: 'm1', role: 'character', name: 'Nova', mes, original_avatar: 'nova.png' });
    const eventFor = mes => groupEvent(directories, { group, messages: { 1: line(mes) }, messageIndex: 1, kind: 'rendered', speakerAvatar: 'nova.png' });
    // Sampled in, and the speaker is not preferred, so the other member is chosen.
    const mes = lineThatDraws(eventFor, event => drawOf(event) < 18 && drawOf(event, 'speaker') >= 65);
    writeChat(path.join(directories.groupChats, 'crew.jsonl'), [{ id: 'm0', role: 'user', name: 'User', mes: 'The bridge creaks.' }, line(mes)]);

    const first = await acceptConversationAsideEvent(request, eventFor(mes));
    assert.deepEqual({ accepted: first.accepted, avatar: first.avatar, reason: first.reason }, { accepted: true, avatar: 'lyra.png', reason: 'random' });
    // Another tab, another device and a reloaded page each submit the same event.
    for (let submission = 0; submission < 5; submission += 1) {
        const repeated = await acceptConversationAsideEvent(request, { ...eventFor(mes), eventKey: `another-tab:${submission}` });
        assert.deepEqual({ accepted: repeated.accepted, avatar: repeated.avatar, jobId: repeated.jobId }, { accepted: false, avatar: 'lyra.png', jobId: first.jobId });
    }
    assert.equal(listJobs(directories, { owner: 'tester', includeDismissed: true }).filter(job => !job.parentId).length, 1);
});

test('the aside draw keeps the old odds and spreads the choice evenly across members', () => {
    const total = 30000;
    const event = index => ({ personaId: '', kind: 'rendered', messageIndex: index, messageRevision: `revision-${index}`,
        source: { groupId: 'g1', locator: { chat: 'crew', avatar: '', group: true } } });
    let sampled = 0;
    let speaker = 0;
    const members = [0, 0, 0];
    const membersWhenSampled = [0, 0, 0];
    for (let index = 0; index < total; index += 1) {
        const chance = drawConversationAsideEvent('tester', event(index), 'chance', 100);
        assert.equal(drawConversationAsideEvent('tester', event(index), 'chance', 100), chance);
        const member = drawConversationAsideEvent('tester', event(index), 'member', 3);
        members[member] += 1;
        if (drawConversationAsideEvent('tester', event(index), 'speaker', 100) < 65) speaker += 1;
        if (chance < 18) {
            sampled += 1;
            membersWhenSampled[member] += 1;
        }
    }
    const near = (count, of, share) => Math.abs(count / of - share) < 0.02;
    assert.ok(near(sampled, total, 0.18), `sampled in ${sampled} of ${total}`);
    assert.ok(near(speaker, total, 0.65), `speaker preferred ${speaker} of ${total}`);
    for (const count of members) assert.ok(near(count, total, 1 / 3), `member chosen ${count} of ${total}`);
    // The member draw does not lean on the chance draw: the spread holds among events that earn an aside.
    for (const count of membersWhenSampled) assert.ok(near(count, sampled, 1 / 3), `member chosen ${count} of ${sampled} sampled`);
    // The owner, the persona and the kind are part of the event, so they change the draw.
    const differs = change => Array.from({ length: 200 }, (_, index) => drawConversationAsideEvent(change.owner ?? 'tester', { ...event(index), ...change.event }, 'chance', 1000)
        !== drawConversationAsideEvent('tester', event(index), 'chance', 1000)).filter(Boolean).length > 150;
    assert.ok(differs({ owner: 'other' }));
    assert.ok(differs({ event: { personaId: 'persona.png' } }));
    assert.ok(differs({ event: { kind: 'mention' } }));
    assert.ok(differs({ event: { messageIndex: 30001 } }));
    assert.ok(differs({ event: { messageRevision: 'changed text' } }));
    for (const purpose of ['chance', 'speaker', 'member']) {
        assert.equal(drawConversationAsideEvent('tester', { ...event(0), eventKey: 'another page', groupRevision: 'changed group' }, purpose, 100),
            drawConversationAsideEvent('tester', event(0), purpose, 100));
    }
});

test('a rendered solo event is opt-in and sampled, then answers for the chat\'s own character without a group cooldown', async () => {
    const { directories, request } = setup();
    const line = (index, mes) => ({ id: `r${index}`, role: 'character', name: 'Nova', mes, original_avatar: 'nova.png' });
    const eventAt = (index, mes) => ({
        eventKey: `event:rendered:roleplay:r${index}`,
        personaId: '',
        kind: 'rendered',
        source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
        messageIndex: index,
        messageRevision: getRoleplaySourceMessageRevision(line(index, mes)),
        groupRevision: '',
        speakerAvatar: '',
    });
    const messages = [
        { id: 'r0', role: 'user', name: 'User', mes: 'The dragon roars.' },
        line(1, lineThatDraws(mes => eventAt(1, mes), event => drawOf(event) >= 18)),
        line(2, lineThatDraws(mes => eventAt(2, mes), event => drawOf(event) < 18)),
    ];
    writeChat(path.join(directories.chats, 'nova', 'roleplay.jsonl'), messages);
    const event = eventAt(2, messages[2].mes);

    // Solo reactions stay off until the character's own thread opts in.
    conversationSettings(directories, 'nova.png', { roleplay_reactions: false });
    assert.equal((await acceptConversationAsideEvent(request, event)).skipped, 'disabled');
    conversationSettings(directories, 'nova.png', { roleplay_reactions: true });
    for (let submission = 0; submission < 3; submission += 1) {
        const sampledOut = await acceptConversationAsideEvent(request, eventAt(1, messages[1].mes));
        assert.equal(sampledOut.skipped, 'sampled_out');
        assert.equal(sampledOut.jobId, null);
    }

    const decided = await acceptConversationAsideEvent(request, event);
    assert.equal(decided.accepted, true);
    assert.equal(decided.avatar, 'nova.png');
    assert.equal(decided.reason, 'reaction');
    const repeated = await acceptConversationAsideEvent(request, event);
    assert.equal(repeated.accepted, false);
    assert.equal(repeated.jobId, decided.jobId);
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
