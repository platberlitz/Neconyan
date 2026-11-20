// The server-side Conversation DM delete: what it removes, what it keeps, and the jobs it stops.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { A, B, C, KEY, checkKeptScheduleRecord, openReplyJob, seedA0 } from './conversation-delete-helpers.js';
import { deleteConversationThreads } from '../src/endpoints/conversation-delete.js';

const { acceptJob, getJob } = await import('../src/jobs/store.js');

const reminder = (id, avatar, groupId = '', personaId = '') => ({
    id, avatar, groupId, personaId, branchId: 'main', triggerAt: Date.now() + 3600000, text: id, fired: false, createdAt: 1,
});

/** Edit the seeded settings file the way another writer would: the settings version moves. */
function editStore(seed, mutate) {
    const file = path.join(seed.directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(settings.extension_settings.neconyan_conversation, settings);
    settings._version = (settings._version || 0) + 1;
    fs.writeFileSync(file, JSON.stringify(settings));
}

const version = seed => JSON.parse(fs.readFileSync(path.join(seed.directories.root, 'settings.json'), 'utf8'))._version;

function seedGroups(t) {
    const seed = seedA0(t);
    const thread = () => ({ activeBranchId: 'main', settings: { enabled: true }, branches: { main: { id: 'main', createdAt: 1, messages: [{ id: 'g1', role: 'user', name: 'User', mes: 'Group hi', extra: {} }] } } });
    editStore(seed, store => {
        store.groups.push({ id: 'g2', personaId: '', members: [B, C], createdAt: 6, updatedAt: 6 });
        Object.assign(store.characters, {
            [`group:g1:${A}`]: thread(), [`group:g1:${B}`]: thread(),
            [`group:g2:${B}`]: thread(), [`group:rp:${A}`]: thread(),
        });
        store.reminders = [reminder('r-solo-a', A), reminder('r-g1', A, 'g1'), reminder('r-g2', B, 'g2'), reminder('r-rp', A, 'rp'), reminder('r-solo-b', B)];
    });
    fs.writeFileSync(path.join(seed.directories.groups, 'rp.json'), JSON.stringify({ id: 'rp', members: [A, B], chats: [] }));
    return seed;
}

test('the route as producer passes every kept-schedule check (A0 with the real delete)', async t => {
    const readings = await checkKeptScheduleRecord(t, request => deleteConversationThreads(request, { avatar: A }));
    t.diagnostic(`A0 readings with the route: ${JSON.stringify(readings)}`);
    assert.deepEqual(readings.control, [KEY(A)]);
    assert.deepEqual(readings.after, [KEY(C)]);
});

test('a solo delete removes A, its reminders and its memory, keeps group DMs and other pals, and a repeat writes nothing', async t => {
    const seed = seedGroups(t);
    const result = await deleteConversationThreads(seed.request, { avatar: C });
    assert.equal(result.changed, true);
    assert.deepEqual(result.scope.removeKeys, [C]);
    assert.equal(Object.hasOwn(seed.disk().characters, C), false);
    const solo = await deleteConversationThreads(seed.request, { avatar: B });
    assert.equal(solo.changed, true);
    const store = seed.disk();
    assert.equal(Object.hasOwn(store.characters, B), false);
    for (const key of [A, `group:g1:${A}`, `group:g1:${B}`, `group:g2:${B}`, `group:rp:${A}`]) assert.equal(Object.hasOwn(store.characters, key), true, key);
    assert.deepEqual(store.reminders.map(item => item.id), ['r-solo-a', 'r-g1', 'r-g2', 'r-rp']);
    assert.deepEqual(store.groups.map(group => group.id), ['g1', 'g2']);
    const before = version(seed);
    const repeat = await deleteConversationThreads(seed.request, { avatar: B });
    assert.equal(repeat.changed, false);
    assert.equal(version(seed), before);
    assert.equal(repeat.version, before);
});

test('a group delete removes the record, its member threads and its reminders only', async t => {
    const seed = seedGroups(t);
    const result = await deleteConversationThreads(seed.request, { groupId: 'g1' });
    assert.equal(result.changed, true);
    assert.equal(result.scope.keyPrefix, 'group:g1:');
    assert.equal(result.scope.groupId, 'g1');
    assert.deepEqual(result.scope.removeKeys.sort(), [`group:g1:${A}`, `group:g1:${B}`].sort());
    const store = seed.disk();
    assert.deepEqual(store.groups.map(group => group.id), ['g2']);
    assert.deepEqual(Object.keys(store.characters).sort(), [A, B, C, `group:g2:${B}`, `group:rp:${A}`].sort());
    assert.deepEqual(store.reminders.map(item => item.id), ['r-solo-a', 'r-g2', 'r-rp', 'r-solo-b']);
    // The solo DMs of the members are untouched, schedule included.
    assert.equal(store.characters[A].schedule.generatedAt, 5);
    assert.equal(store.characters[A].branches.main.messages.length, 1);
    const before = version(seed);
    assert.equal((await deleteConversationThreads(seed.request, { groupId: 'g1' })).changed, false);
    assert.equal(version(seed), before);
});

test('deleting a Roleplay group\'s Conversation history removes keys and reminders only and never its group file', async t => {
    const seed = seedGroups(t);
    const file = path.join(seed.directories.groups, 'rp.json');
    const bytes = fs.readFileSync(file);
    const result = await deleteConversationThreads(seed.request, { groupId: 'rp' });
    assert.equal(result.changed, true);
    const store = seed.disk();
    assert.equal(Object.hasOwn(store.characters, `group:rp:${A}`), false);
    assert.deepEqual(store.groups.map(group => group.id), ['g1', 'g2']);
    assert.deepEqual(store.reminders.map(item => item.id), ['r-solo-a', 'r-g1', 'r-g2', 'r-solo-b']);
    assert.deepEqual(fs.readFileSync(file), bytes);
});

test('a reply job open for a deleted DM is cancelled and its next append is refused (in-flight case ii)', async t => {
    const seed = seedA0(t);
    const job = await openReplyJob(seed, C);
    assert.equal((await deleteConversationThreads(seed.request, { avatar: C })).changed, true);
    const current = getJob(seed.directories, job.job.id);
    assert.ok(current.cancellation?.requested === true || current.state === 'cancelled', JSON.stringify(current.cancellation));
    const refusal = await job.append();
    assert.ok(refusal, 'the late append must be refused');
    assert.equal(refusal.message, 'The Conversation job was cancelled.');
    assert.equal(Object.hasOwn(seed.disk().characters, C), false);
});

test('a group job whose target is an alias key the store no longer holds is still cancelled', async t => {
    const seed = seedGroups(t);
    const { job } = acceptJob(seed.directories, {
        owner: seed.owner, type: 'conversation.reply', submissionKey: 'delete:alias', intent: {},
        target: { kind: 'conversation', id: 'group:g1:Ghost.png', branchId: 'main' },
    });
    const other = acceptJob(seed.directories, {
        owner: seed.owner, type: 'conversation.reply', submissionKey: 'delete:kept', intent: {},
        target: { kind: 'conversation', id: `group:g2:${B}`, branchId: 'main' },
    }).job;
    assert.equal((await deleteConversationThreads(seed.request, { groupId: 'g1' })).changed, true);
    const cancelled = getJob(seed.directories, job.id);
    assert.ok(cancelled.cancellation?.requested === true || cancelled.state === 'cancelled');
    const kept = getJob(seed.directories, other.id);
    assert.notEqual(kept.cancellation?.requested, true);
});
