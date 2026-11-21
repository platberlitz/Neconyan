// The server-side group DM member edit: the jobs it stops and what the automation worker does after a holder leaves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';
import { updateConversationGroupMembers } from '../src/endpoints/conversation-group-members.js';

const { prepareConversationTarget, appendConversationJobMessage } = await import('../src/generation/conversation-effects.js');
const { acceptJob, acceptChildJobs, getJob, listJobs } = await import('../src/jobs/store.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { scanConversationAutonomy } = await import('../src/generation/conversation-worker.js');
const { write: writeCard } = await import('../src/character-card-parser.js');

const A = 'Nova.png';
const B = 'Kit.png';
const C = 'Zed.png';
const KEY = avatar => `group:G:${avatar}`;
const DUE = { enabled: true, auto_message: true, cooldown: 0 };

/** A group G(A, B, C) held by A, with cards for A, B, C and a spare, a connection profile and server automation on. */
function seedGroup(t, { reminders = [], groupSettings = {} } = {}) {
    const f = fixture(t);
    t.after(() => cancelAutoSaves());
    const { directories, owner } = f.scope;
    for (const [file, name] of [[B, 'Kit'], [C, 'Zed'], ['Dot.png', 'Dot']]) {
        fs.writeFileSync(path.join(directories.characters, file), writeCard(png, JSON.stringify({ name, description: name })));
    }
    const request = { user: { directories, profile: { handle: owner } } };
    const messages = [
        { id: 'm1', role: 'user', name: 'User', mes: 'Hello all', created_at: 1, extra: {} },
        { id: 'm2', role: 'character', name: 'Nova', mes: 'Hi there', created_at: 2, extra: {} },
    ];
    const store = {
        version: 1, settings: { connection_profile: 'saved' }, automation: { mode: 'server', timeZone: 'UTC' },
        groups: [{ id: 'G', personaId: '', name: 'Crew', members: [A, B, C], disabled_members: [], conversation_settings: groupSettings, createdAt: 5, updatedAt: 5 }],
        reminders, legacyThreadPersonaAssignments: {},
        characters: { [KEY(A)]: { threadAvatar: A, groupId: 'G', settings: { ...DUE }, activeBranchId: 'main', branches: { main: { id: 'main', name: 'Main', createdAt: 1, lastActivity: 2, messages } } } },
    };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({
        _version: 0,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] }, neconyan_conversation: store },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    const disk = () => JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8')).extension_settings.neconyan_conversation;
    return { directories, owner, request, disk };
}

const jobTarget = key => ({ kind: 'conversation', id: key, branchId: 'main' });

async function openRoot(seed, key, avatar, name) {
    const captured = await prepareConversationTarget(seed.request, { avatar, groupId: 'G', branchId: 'main' });
    const { job } = acceptJob(seed.directories, {
        owner: seed.owner, type: 'conversation.reply', submissionKey: `members:${name}`, intent: { target: captured },
        target: { ...jobTarget(key), createdAt: captured.createdAt },
    });
    return { captured, job };
}

const appendAs = async (seed, job, captured, effectId) => {
    try {
        await appendConversationJobMessage({ owner: seed.owner, directories: seed.directories, job }, captured, effectId, { role: 'character', name: 'Late', mes: 'Late reply' });
        return null;
    } catch (error) {
        return error;
    }
};

test('removing the holder cancels the root and child jobs on its old key, and their next append is refused', async t => {
    const seed = seedGroup(t);
    const { captured, job: root } = await openRoot(seed, KEY(A), A, 'root');
    const [child] = acceptChildJobs(seed.directories, root.id, [{ participantKey: A, intent: {}, target: jobTarget(KEY(A)), config: { speakerAvatar: A, speakerName: 'Nova' } }]);
    const result = await updateConversationGroupMembers(seed.request, { groupId: 'G', remove: [A] });
    assert.equal(result.changed, true, JSON.stringify(result.body ?? null));
    assert.equal(getJob(seed.directories, root.id).cancellation?.requested, true);
    assert.equal(getJob(seed.directories, child.id).cancellation?.requested, true);
    const refusal = await appendAs(seed, root, captured, 'reply');
    assert.ok(refusal, 'the late append must be refused');
    assert.equal(refusal.message, 'The Conversation job was cancelled.');
    assert.equal(Object.hasOwn(seed.disk().characters, KEY(A)), false);
});

test('removing a speaker cancels only that speaker\'s child on the holder\'s key', async t => {
    const seed = seedGroup(t);
    const { captured, job: root } = await openRoot(seed, KEY(A), A, 'root');
    const children = acceptChildJobs(seed.directories, root.id, ['B', 'C'].map(letter => {
        const avatar = letter === 'B' ? B : C;
        return { participantKey: avatar, intent: {}, target: jobTarget(KEY(A)), config: { speakerAvatar: avatar, speakerName: letter } };
    }));
    const [childB, childC] = children;
    const result = await updateConversationGroupMembers(seed.request, { groupId: 'G', remove: [B] });
    assert.equal(result.changed, true, JSON.stringify(result.body ?? null));
    assert.equal(getJob(seed.directories, childB.id).cancellation?.requested, true);
    assert.notEqual(getJob(seed.directories, childC.id).cancellation?.requested, true);
    assert.notEqual(getJob(seed.directories, root.id).cancellation?.requested, true);
    const refusal = await appendAs(seed, childC, captured, 'reply-c');
    assert.equal(refusal, null, refusal?.message);
    assert.ok(seed.disk().characters[KEY(A)].branches.main.messages.some(message => message.mes === 'Late reply'));
});

test('after the holder leaves, a due group reminder is accepted on the new holder\'s key and never on the old one', async t => {
    const seed = seedGroup(t, {
        groupSettings: { ...DUE },
        reminders: [{ id: 'r1', avatar: A, groupId: 'G', personaId: '', branchId: 'main', triggerAt: Date.now() - 60000, text: 'Remember the party', fired: false, createdAt: 1 }],
    });
    const result = await updateConversationGroupMembers(seed.request, { groupId: 'G', remove: [A] });
    assert.equal(result.changed, true, JSON.stringify(result.body ?? null));
    assert.equal(result.anchor.avatar, B);
    assert.equal(seed.disk().reminders[0].avatar, B);
    const scan = await scanConversationAutonomy({ owners: [seed.owner], directoriesFor: () => seed.directories, now: Date.now() });
    const jobs = listJobs(seed.directories, { owner: seed.owner, includeDismissed: true }).filter(job => job.target?.kind === 'conversation');
    assert.equal(scan.accepted.length, 1, JSON.stringify({ scan, jobs: jobs.map(job => job.target) }));
    assert.deepEqual([...new Set(jobs.map(job => job.target.id))], [KEY(B)]);
});
