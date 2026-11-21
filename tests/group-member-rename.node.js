import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameGroupMemberFields, renameGroupSceneRecords } from '../public/scripts/group-member-rename.js';
import { canGroupMemberSee, readGroupScene } from '../public/scripts/group-chat-visibility.js';

test('a renamed member keeps their mute, role and model', () => {
    const group = {
        members: ['kit.png', 'mira.png'],
        disabled_members: ['kit.png'],
        member_roles: { 'kit.png': 'narrator' },
        member_models: { 'kit.png': 'model-a', 'mira.png': 'model-b' },
    };
    const changes = renameGroupMemberFields(group, 'kit.png', 'kat.png');
    assert.deepEqual(changes, {
        members: ['kat.png', 'mira.png'],
        disabled_members: ['kat.png'],
        member_roles: { 'kat.png': 'narrator' },
        member_models: { 'mira.png': 'model-b', 'kat.png': 'model-a' },
    });
    assert.deepEqual(group.members, ['kit.png', 'mira.png'], 'the input group is not changed');
    assert.deepEqual(renameGroupMemberFields(group, 'other.png', 'new.png'), {});
});

test('a renamed member keeps what they heard, their whispers and being away', () => {
    const records = [
        { chat_metadata: { group_scene: { away: ['kit.png'], whisper_to: ['kit.png'], location: 'Hall' } } },
        { is_user: true, mes: 'Only Kit heard this', extra: { group_scene: { present: ['kit.png'], whisper_to: [] } } },
        { mes: 'Mira answers', extra: { group_scene: { present: ['mira.png'], whisper_to: ['kit.png'] } },
            swipe_info: [{ extra: { group_scene: { present: ['kit.png', 'mira.png'], whisper_to: [] } } }, { extra: {} }] },
        { mes: 'Older public message' },
    ];
    assert.equal(renameGroupSceneRecords(records, 'kit.png', 'kat.png'), true);

    const members = ['kat.png', 'mira.png'];
    assert.deepEqual(readGroupScene(records[0].chat_metadata, members), { away: ['kat.png'], whisper_to: ['kat.png'], location: 'Hall' });
    assert.equal(canGroupMemberSee(records[1], 'kat.png'), true);
    assert.equal(canGroupMemberSee(records[1], 'mira.png'), false);
    assert.deepEqual(records[2].extra.group_scene.whisper_to, ['kat.png']);
    assert.deepEqual(records[2].swipe_info[0].extra.group_scene.present, ['kat.png', 'mira.png']);
    assert.equal(renameGroupSceneRecords(records, 'kit.png', 'kat.png'), false, 'a second pass finds nothing left to rename');
});
