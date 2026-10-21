import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGroupSpeakerPool, rememberGroupSpeaker, restoreGroupSpeaker } from '../public/scripts/group-chat-speakers.js';

test('speaker snapshots preserve old variants when another member writes the new variant', () => {
    const message = { name: 'Mira', original_avatar: 'mira.png', force_avatar: '/mira', extra: {}, swipe_info: [{ extra: {} }, { extra: {} }] };
    rememberGroupSpeaker(message);
    Object.assign(message, { name: 'Kit', original_avatar: 'kit.png', force_avatar: '/kit' });
    rememberGroupSpeaker(message);
    assert.equal(message.extra.group_speaker.name, 'Kit');
    message.extra = message.swipe_info[0].extra;
    restoreGroupSpeaker(message);
    assert.equal(message.name, 'Mira');
    assert.equal(message.original_avatar, 'mira.png');
    assert.equal(message.force_avatar, '/mira');
});

test('a narrator variant clears a character avatar when restored', () => {
    const message = { name: 'Narrator', extra: {}, swipe_info: [] };
    rememberGroupSpeaker(message);
    message.name = 'Kit'; message.original_avatar = 'kit.png'; message.force_avatar = '/kit';
    restoreGroupSpeaker(message);
    assert.equal(message.name, 'Narrator');
    assert.equal(message.original_avatar, undefined);
    assert.equal(message.force_avatar, undefined);
});

test('pooled preview excludes members who spoke, then excludes the last speaker when resetting', () => {
    const members = ['kit', 'mira'];
    const messages = [{ is_user: true }, { original_avatar: 'kit' }];
    assert.deepEqual(getGroupSpeakerPool(members, messages), ['mira']);
    messages.push({ original_avatar: 'mira' });
    assert.deepEqual(getGroupSpeakerPool(members, messages), ['kit']);
    assert.deepEqual(getGroupSpeakerPool(members, messages, true), members);
});
