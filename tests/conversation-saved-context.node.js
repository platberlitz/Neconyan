import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { write as writeCharacterCard } from '../src/character-card-parser.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.resolve('default/config.yaml'));
const { buildSavedConversationContext } = await import('../src/generation/conversation-context.js');
const { getConversationThreadKey } = await import('../src/endpoints/conversation-store.js');
const { resolveConversationPartners, buildConversationParticipantPlan, buildConversationParticipantSnapshot } = await import('../src/generation/conversation-participants.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');

test('saved context uses only the captured persona and evaluates schedules in the captured timezone', async () => {
    const target = { avatar: 'nova.png', personaId: 'alice.png', groupId: '', branchId: 'main' };
    const thread = summary => ({ activeBranchId: 'main', branches: { main: { memorySummary: summary, updatedAt: 1 } } });
    const characters = {
        [getConversationThreadKey(target.avatar, 'one', target.personaId)]: thread('Alice group memory'),
        [getConversationThreadKey(target.avatar, 'one', 'bob.png')]: thread('Private Bob memory'),
        [getConversationThreadKey(target.avatar, 'legacy', '')]: thread('Unscoped memory'),
        [getConversationThreadKey(target.avatar, '', target.personaId)]: { schedule: { days: {
            1: [{ time: '15:00-18:00', activity: 'working', status: 'dnd' }],
        } } },
    };
    const current = { store: { characters, groups: [{ id: 'one', name: 'Pals' }] } };
    const result = await buildSavedConversationContext({}, current, target, { name: 'Nova' }, { include_related_memory: true },
        'Asia/Manila', Date.parse('2026-09-21T08:00:00Z'));
    assert.deepEqual(result.context.groupMemories.map(item => item.summary), ['Alice group memory']);
    assert.equal(result.context.groupMemories[0].groupName, 'Pals');
    assert.match(result.context.lifeContext, /16:00.*working \(status: dnd\)/);
    assert.deepEqual(result.speakers, [{ avatar: 'nova.png', name: 'Nova' }]);
});

test('solo context resolves known partners while group discovery excludes muted, removed and non-members', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-partners-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root, characters: path.join(root, 'characters') };
    fs.mkdirSync(directories.characters);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
    for (const name of ['Host', 'Partner', 'Muted', 'Removed', 'Outsider']) {
        fs.writeFileSync(path.join(directories.characters, name + '.png'), writeCharacterCard(png, JSON.stringify({ name })));
    }
    const settings = { oai_settings: {}, extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:5000' }] } } };
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
    const request = { user: { profile: { handle: 'tester' }, directories } };
    const target = { avatar: 'Host.png', personaId: '', groupId: '', branchId: 'main' };
    const branch = { lastActivity: Date.now(), messages: [{ role: 'partner', mes: 'Old reply', extra: { partner_avatar: 'Removed.png' } },
        { role: 'user', mes: '@Partner, please answer.' }] };
    const current = { settings, branch, store: { settings: { connection_profile: 'saved', multi_char_names: 'Partner.png,Muted.png,Outsider.png' }, characters: {} } };
    const partners = await resolveConversationPartners(request, current, target);
    assert.deepEqual(partners.map(partner => partner.name), ['Partner', 'Muted', 'Outsider', 'Removed']);
    const context = await buildSavedConversationContext(request, current, target, { name: 'Host' }, current.store.settings, 'UTC', Date.now());
    assert.deepEqual(context.speakers.map(speaker => speaker.name).sort(), ['Host', 'Muted', 'Outsider', 'Partner', 'Removed']);
    const group = { members: ['Host.png', 'Partner.png', 'Muted.png'], disabled_members: ['Muted.png'] };
    assert.deepEqual((await resolveConversationPartners(request, { ...current, group }, { ...target, groupId: 'group' })).map(partner => partner.name), ['Partner']);
    const plan = await buildConversationParticipantPlan(request, current, target, { includeChimes: true });
    assert.equal(plan[1].avatar, 'Partner.png');
    fs.unlinkSync(path.join(directories.characters, 'Partner.png'));
    await assert.rejects(buildConversationParticipantSnapshot(request, current, target, plan[1], {
        binding: captureChatProfile(directories, 'saved'), directive: plan[1].directive, timeZone: 'UTC',
    }), error => error.status === 409 && /card no longer exists/.test(error.message));
});

test('an oversized solo partner list rejects strictly but stays total for the background scan', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-partner-cap-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root, characters: path.join(root, 'characters') };
    fs.mkdirSync(directories.characters);
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ oai_settings: {}, extension_settings: {} }));
    const request = { user: { profile: { handle: 'tester' }, directories } };
    const target = { avatar: 'Host.png', personaId: '', groupId: '', branchId: 'main' };
    const messages = Array.from({ length: 129 }, (_, index) => ({ role: 'partner', mes: 'Old reply', extra: { partner_avatar: `p${index}.png` } }));
    const current = { settings: {}, branch: { lastActivity: Date.now(), messages }, store: { settings: {}, characters: {} } };
    await assert.rejects(resolveConversationPartners(request, current, target, Date.now(), 'UTC', { strict: true }),
        error => error.status === 400 && /Too many Conversation partners/.test(error.message));
    assert.deepEqual(await resolveConversationPartners(request, current, target), []);
});
