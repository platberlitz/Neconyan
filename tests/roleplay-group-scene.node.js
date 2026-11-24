import assert from 'node:assert/strict';
import test from 'node:test';

import { blankUnheardGroupRecords, savedGroupAwayMembers, savedGroupReplyAudience } from '../src/generation/roleplay-group-scene.js';
import { selectRoleplayPromptRecords } from '../src/generation/roleplay-prompt.js';

const group = { locator: { group: true, chat: 'Scene' }, groupId: 'group' };

function records() {
    return [
        { chat_metadata: { group_scene: { away: ['mira.png'], location: '', whisper_to: [], sees_all: ['nova.png'] } } },
        { name: 'User', is_user: true, mes: 'Hello all.', send_date: 'a', extra: { group_scene: { present: ['kit.png', 'mira.png', 'nova.png'], whisper_to: [] } } },
        { name: 'User', is_user: true, mes: 'Only Kit hears this.', send_date: 'b', extra: { group_scene: { present: ['kit.png'], whisper_to: [] }, files: ['secret.txt'] } },
        { name: 'User', is_user: true, mes: 'A whisper to Kit.', send_date: 'c', extra: { group_scene: { present: ['kit.png', 'nova.png'], whisper_to: ['kit.png'] } } },
        { name: 'Kit', is_user: false, mes: 'An older public line.', send_date: 'd', extra: {} },
    ];
}

test('a group speaker reads blank rows in place of lines they did not hear', () => {
    const saved = records();
    const mira = blankUnheardGroupRecords(saved, group, 'mira.png');
    assert.equal(mira.length, saved.length);
    assert.deepEqual(mira.map(row => row.mes), [undefined, 'Hello all.', '', '', 'An older public line.']);
    assert.deepEqual(mira[2], { name: '', is_user: false, is_system: true, mes: '', send_date: 'b', extra: { group_scene_unheard: true } });
    assert.equal(saved[2].mes, 'Only Kit hears this.');

    const nova = blankUnheardGroupRecords(saved, group, 'nova.png');
    assert.deepEqual(nova.map(row => row.mes), [undefined, 'Hello all.', 'Only Kit hears this.', '', 'An older public line.']);

    assert.equal(blankUnheardGroupRecords(saved, group, 'kit.png'), saved);
    assert.equal(blankUnheardGroupRecords(saved, { locator: { chat: 'Solo' } }, 'mira.png'), saved);
    assert.equal(blankUnheardGroupRecords(saved, group, null), saved);
});

test('the protected prompt view blanks unheard rows after cutting at its target', () => {
    const saved = records();
    const view = selectRoleplayPromptRecords(saved, { ...group, message: { index: 2 } }, 'swipe', 'mira.png');
    assert.deepEqual(view.map(row => row.mes), [undefined, 'Hello all.', '']);
    assert.equal(selectRoleplayPromptRecords(saved, group, 'append'), saved);
});

test('the saved scene names away members and the audience of a new server reply', () => {
    const members = ['kit.png', 'mira.png', 'nova.png'];
    const metadata = records()[0].chat_metadata;
    assert.deepEqual(savedGroupAwayMembers(metadata, members), ['mira.png']);
    assert.deepEqual(savedGroupReplyAudience(metadata, members, 'kit.png'), { present: ['kit.png', 'nova.png'], whisper_to: [] });
    assert.deepEqual(savedGroupReplyAudience({ group_scene: { away: ['kit.png'], whisper_to: ['mira.png'] } }, members, 'kit.png'),
        { present: ['mira.png', 'nova.png', 'kit.png'], whisper_to: ['mira.png'] });
    assert.deepEqual(savedGroupReplyAudience({}, members, 'kit.png'), { present: members, whisper_to: [] });
});
