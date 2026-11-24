// A reply to a message from a pal who is no longer an active member of the group goes to ordinary selection instead of failing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { readConversationTarget, prepareConversationTarget } = await import('../src/generation/conversation-effects.js');
const { acceptConversationSubmission } = await import('../src/generation/conversation-jobs.js');
const { readConversationStoreForWrite, saveConversationStore, readUserSettingsWithStatus } = await import('../src/endpoints/conversation-store.js');
const { normalizeConversationGroupRecord } = await import('../src/endpoints/conversation-groups.js');
const { normalizeConversationSettings } = await import('../src/endpoints/conversation-generation.js');
const { getSettingsVersion } = await import('../src/settings-version.js');
const { getJob } = await import('../src/jobs/store.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const { getConversationMessageRevision } = await import('../public/scripts/neconyan-conversation/message-identity-utils.js');

const A = 'Nova.png';
const B = 'Kit.png';
const C = 'Zed.png';
const KEY = `group:G:${A}`;
const target = { avatar: A, groupId: 'G', personaId: '', branchId: 'main' };

function seed(t) {
    const f = fixture(t);
    t.after(() => cancelAutoSaves());
    const { directories, owner } = f.scope;
    for (const [file, name] of [[B, 'Kit'], [C, 'Zed']]) {
        fs.writeFileSync(path.join(directories.characters, file), writeCard(png, JSON.stringify({ name, description: name })));
    }
    const messages = [
        { id: 'm1', role: 'user', name: 'User', mes: 'Hello all', created_at: 1, extra: {} },
        { id: 'm2', role: 'character', name: 'Nova', mes: 'Hi there', created_at: 2, extra: {} },
        { id: 'm3', role: 'partner', name: 'Kit', mes: 'Hello from Kit', created_at: 3, extra: { partner_avatar: B } },
    ];
    const store = {
        version: 1, settings: { connection_profile: 'saved' }, automation: { mode: 'off', timeZone: 'UTC' }, reminders: [], legacyThreadPersonaAssignments: {},
        groups: [{ id: 'G', personaId: '', name: 'Crew', members: [A, B, C], disabled_members: [], conversation_settings: { multi_char: true }, createdAt: 5, updatedAt: 5 }],
        characters: {
            [KEY]: { threadAvatar: A, groupId: 'G', settings: {}, activeBranchId: 'main', branches: { main: { id: 'main', name: 'Main', createdAt: 1, lastActivity: 3, messages } } },
            [A]: { settings: {}, activeBranchId: 'main', branches: { main: { id: 'main', name: 'Main', createdAt: 1, lastActivity: 2, messages: messages.slice(0, 2) } } },
        },
    };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({
        _version: 0,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] }, neconyan_conversation: store },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    return { directories, owner, request: { user: { directories, profile: { handle: owner } } } };
}

/** A plain save, as an ordinary page save would write it. */
async function plainSave(request, mutate) {
    const version = getSettingsVersion(readUserSettingsWithStatus(request).data);
    const context = readConversationStoreForWrite(request, version, group => normalizeConversationGroupRecord(group, normalizeConversationSettings));
    assert.equal(context.ok, true);
    mutate(context.store);
    const saved = await saveConversationStore(request, context.store, version);
    assert.equal(saved.ok, true, JSON.stringify(saved.body ?? null));
}

/** The reply body a page would send for a quoted message: its id and revision as they are saved. */
async function replyBody(request, key, messageId, scope = target) {
    await prepareConversationTarget(request, scope);
    const message = readConversationTarget(request, scope).branch.messages.find(item => item.id === messageId);
    return { submissionKey: key, mode: 'send', target: scope, messages: [{ mes: 'Still there?' }], replyTarget: { messageId, revision: getConversationMessageRevision(message) } };
}

for (const [label, drop] of [
    ['removed', store => { store.groups[0].members = [A, C]; }],
    ['muted', store => { store.groups[0].disabled_members = [B]; }],
]) {
    test(`a reply to a ${label} pal's old message is accepted and goes to ordinary selection`, async t => {
        const seeded = seed(t);
        await plainSave(seeded.request, drop);
        const accepted = await acceptConversationSubmission(seeded.request, await replyBody(seeded.request, `reply-${label}`, 'm3'));
        const job = getJob(seeded.directories, accepted.job.id);
        const speakers = Object.keys(job.config?.participantBindings || {});
        assert.ok(speakers.length > 0, 'someone still in the group answers');
        assert.equal(speakers.includes(B), false, `B is not a speaker: ${speakers.join(', ')}`);
        const saved = JSON.parse(fs.readFileSync(path.join(seeded.directories.root, 'settings.json'), 'utf8')).extension_settings.neconyan_conversation;
        assert.ok(saved.characters[KEY].branches.main.messages.some(message => message.role === 'user' && message.mes === 'Still there?'), 'the user message is saved');
    });
}

test('controls: a changed reply target and a reply to a user message are still refused', async t => {
    const seeded = seed(t);
    const body = await replyBody(seeded.request, 'control-changed', 'm2');
    await assert.rejects(acceptConversationSubmission(seeded.request, { ...body, replyTarget: { ...body.replyTarget, revision: 'changed' } }),
        error => error.message === 'The message you replied to changed. Try again.');
    const userReply = await replyBody(seeded.request, 'control-user', 'm1');
    await assert.rejects(acceptConversationSubmission(seeded.request, userReply), error => error.message === 'That message cannot be replied to.');
});
