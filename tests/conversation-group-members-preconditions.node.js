// Facts the group member edit relies on, checked against modules that exist before the edit route does (green on the base by design):
// once a save drops a member from a group, partner resolution and speaker selection no longer name them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { readConversationTarget } = await import('../src/generation/conversation-effects.js');
const { resolveConversationPartners, buildConversationParticipantPlan } = await import('../src/generation/conversation-participants.js');
const { readConversationStoreForWrite, saveConversationStore, readUserSettingsWithStatus } = await import('../src/endpoints/conversation-store.js');
const { normalizeConversationGroupRecord } = await import('../src/endpoints/conversation-groups.js');
const { normalizeConversationSettings } = await import('../src/endpoints/conversation-generation.js');
const { getSettingsVersion } = await import('../src/settings-version.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { write: writeCard } = await import('../src/character-card-parser.js');

const A = 'Nova.png';
const B = 'Kit.png';
const C = 'Zed.png';
const KEY = `group:G:${A}`;

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
        { id: 'm3', role: 'user', name: 'User', mes: '@Kit are you there?', created_at: 3, extra: {} },
    ];
    const store = {
        version: 1, settings: {}, automation: { mode: 'off', timeZone: 'UTC' }, reminders: [], legacyThreadPersonaAssignments: {},
        groups: [{ id: 'G', personaId: '', name: 'Crew', members: [A, B, C], disabled_members: [], conversation_settings: { multi_char: true }, createdAt: 5, updatedAt: 5 }],
        characters: { [KEY]: { threadAvatar: A, groupId: 'G', settings: { multi_char: true }, activeBranchId: 'main', branches: { main: { id: 'main', name: 'Main', createdAt: 1, lastActivity: 3, messages } } } },
    };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ _version: 0, extension_settings: { neconyan_conversation: store } }));
    return { request: { user: { directories, profile: { handle: owner } } } };
}

const target = { avatar: A, groupId: 'G', personaId: '', branchId: 'main' };

test('after a plain save drops a member, partner resolution and speaker selection no longer name them', async t => {
    const { request } = seed(t);
    const before = await resolveConversationPartners(request, readConversationTarget(request, target), target);
    assert.ok(before.some(partner => partner.avatar === B), `control: B is a partner while a member (${JSON.stringify(before.map(partner => partner.avatar))})`);

    const version = getSettingsVersion(readUserSettingsWithStatus(request).data);
    const context = readConversationStoreForWrite(request, version, group => normalizeConversationGroupRecord(group, normalizeConversationSettings));
    assert.equal(context.ok, true);
    context.store.groups[0].members = [A, C];
    const saved = await saveConversationStore(request, context.store, version);
    assert.equal(saved.ok, true, JSON.stringify(saved.body ?? null));

    const current = readConversationTarget(request, target);
    const partners = await resolveConversationPartners(request, current, target);
    assert.deepEqual(partners.map(partner => partner.avatar).filter(avatar => avatar === B), []);
    const plan = await buildConversationParticipantPlan(request, current, target, { random: () => 0 });
    assert.ok(plan.length > 0, 'a plan is still drawn from the remaining members');
    assert.deepEqual(plan.map(item => item.avatar).filter(avatar => avatar === B), []);
});
