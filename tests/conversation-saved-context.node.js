import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.resolve('default/config.yaml'));
const { buildSavedConversationContext } = await import('../src/generation/conversation-context.js');
const { getConversationThreadKey } = await import('../src/endpoints/conversation-store.js');

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
