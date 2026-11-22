import assert from 'node:assert/strict';
import test from 'node:test';

import {
    copyHeard,
    everyoneHeard,
    everyoneHears,
    forgetHeard,
    heardBy,
    importPresenceRecords,
    noOneHeard,
    parseHeardRange,
    rememberHeard,
    transferHeard,
} from '../public/scripts/group-chat-heard-tools.js';
import { canGroupMemberSee } from '../public/scripts/group-chat-visibility.js';

const members = ['kit.png', 'mira.png', 'nova.png'];
const heard = (present, whisper_to = []) => ({ mes: 'line', extra: { group_scene: { present, whisper_to } } });
const present = messages => messages.map(message => message.extra?.group_scene?.present ?? null);

test('chats from the SillyTavern Presence extension keep who heard each line', () => {
    const messages = [
        { mes: 'Everyone', present: ['kit.png', 'mira.png', 'kit.png'] },
        { mes: 'Only Kit', present: ['kit.png'] },
        { mes: 'Universal', present: ['presence_universal_tracker', 'kit.png'] },
        { mes: 'Already ours', present: ['kit.png'], extra: { group_scene: { present: ['mira.png'], whisper_to: [] } } },
        { mes: 'Never tracked' },
    ];
    const metadata = { ignore_presence: ['nova.png'], presence_extension: { char_mode: { 'mira.png': 'ignore', 'kit.png': 'present' } } };

    assert.equal(importPresenceRecords(messages, metadata), true);
    assert.deepEqual(present(messages), [['kit.png', 'mira.png'], ['kit.png'], ['kit.png'], ['mira.png'], null]);
    assert.deepEqual(messages[2].extra.group_scene, { present: ['kit.png'], whisper_to: [], everyone: true }, 'a universal line becomes an everyone line');
    assert.deepEqual(messages[1].present, ['kit.png'], 'the extension field stays for SillyTavern');
    assert.deepEqual(metadata.group_scene, { away: [], location: '', whisper_to: [], sees_all: ['nova.png', 'mira.png'] });
    assert.equal(canGroupMemberSee(messages[1], 'mira.png'), false);
    assert.equal(canGroupMemberSee(messages[2], 'mira.png'), true);
    assert.equal(canGroupMemberSee(messages[2], 'joined-later.png'), true);

    assert.equal(importPresenceRecords(messages, metadata), false, 'reading it twice changes nothing');
    const scene = { group_scene: { away: ['kit.png'], location: 'Inn', whisper_to: [], sees_all: [] } };
    importPresenceRecords([], { ...scene, ignore_presence: ['nova.png'] });
    assert.deepEqual(scene.group_scene.sees_all, [], 'a scene set in Neconyan wins over the extension');
});

test('message ranges read one number, a span either way round, or the whole chat', () => {
    assert.deepEqual(parseHeardRange('', 9), { start: 0, end: 9 });
    assert.deepEqual(parseHeardRange('4', 9), { start: 4, end: 4 });
    assert.deepEqual(parseHeardRange('7 - 2', 9), { start: 2, end: 7 });
    assert.deepEqual(parseHeardRange('5-40', 9), { start: 5, end: 9 });
    assert.equal(parseHeardRange('12', 9), null);
    assert.equal(parseHeardRange('Kit', 9), null);
    assert.equal(parseHeardRange('-3', 9), null);
    assert.equal(parseHeardRange('', -1), null);
});

test('forgetting and remembering change only the chosen lines, and whispers stay private', () => {
    const messages = [heard(['kit.png', 'mira.png']), heard(['kit.png']), heard(['kit.png'], ['kit.png']), { mes: 'old' }];

    assert.equal(forgetHeard(messages, { start: 0, end: 0 }, 'mira.png', members), 1);
    assert.deepEqual(present(messages)[0], ['kit.png']);

    assert.equal(rememberHeard(messages, { start: 0, end: 3 }, 'mira.png', members), 2);
    assert.deepEqual(present(messages), [['kit.png', 'mira.png'], ['kit.png', 'mira.png'], ['kit.png'], null]);

    assert.equal(forgetHeard(messages, { start: 3, end: 3 }, 'nova.png', members), 1, 'an old line heard by all can be forgotten');
    assert.deepEqual(present(messages)[3], ['kit.png', 'mira.png']);
});

test('everyone, no one and copying set whole lists without opening whispers', () => {
    const messages = [heard(['kit.png']), heard([], ['mira.png']), heard(['nova.png'])];

    assert.equal(everyoneHeard(messages, { start: 0, end: 1 }, members), 2);
    assert.equal(canGroupMemberSee(messages[1], 'kit.png'), false, 'a whisper stays with Mira');
    assert.equal(canGroupMemberSee(messages[1], 'mira.png'), true);

    assert.equal(noOneHeard(messages, { start: 0, end: 0 }, members), 1);
    assert.deepEqual(present(messages)[0], []);

    assert.equal(copyHeard(messages, 2, 0, members), true);
    assert.deepEqual(present(messages)[0], ['nova.png']);
    assert.equal(copyHeard(messages, 2, 2, members), false);
    assert.equal(copyHeard(messages, 2, 9, members), false);
});

test('everyone hears a range of lines, members added later included, and the other tools still read them', () => {
    const messages = [heard(['kit.png']), heard([], ['mira.png']), { mes: 'old' }, heard(['nova.png'])];

    assert.equal(everyoneHears(messages, { start: 0, end: 2 }, members), 2, 'the whisper stays as it was');
    assert.deepEqual(messages[0].extra.group_scene, { present: ['kit.png', 'mira.png', 'nova.png'], whisper_to: [], everyone: true });
    assert.equal(messages[2].extra.group_scene.everyone, true, 'a line without a record gets one');
    assert.equal(canGroupMemberSee(messages[0], 'joined-later.png'), true);
    assert.equal(canGroupMemberSee(messages[1], 'kit.png'), false);
    assert.equal(everyoneHears(messages, { start: 0, end: 0 }, members), 0, 'marking it twice changes nothing');

    assert.equal(copyHeard(messages, 0, 3, members), true, 'copying from an everyone line copies every member');
    assert.deepEqual(present(messages)[3], ['nova.png', 'kit.png', 'mira.png']);
    assert.equal(transferHeard(messages, { start: 2, end: 2 }, 'kit.png', 'old.png', members), 1);
    assert.equal(messages[2].extra.group_scene.everyone, undefined, 'moving a member out makes it an ordinary list');
    assert.equal(canGroupMemberSee(messages[2], 'kit.png'), false);
    assert.equal(forgetHeard(messages, { start: 0, end: 0 }, 'mira.png', members), 1);
    assert.deepEqual(messages[0].extra.group_scene, { present: ['kit.png', 'nova.png'], whisper_to: [] });
});

test('transferring memory moves it to another member, or copies it with keep', () => {
    const messages = [heard(['kit.png']), heard(['mira.png']), heard(['kit.png'], ['kit.png'])];

    assert.equal(transferHeard(messages, { start: 0, end: 2 }, 'kit.png', 'nova.png', members, { keep: true }), 1);
    assert.deepEqual(present(messages), [['kit.png', 'nova.png'], ['mira.png'], ['kit.png']]);
    assert.equal(canGroupMemberSee(messages[2], 'nova.png'), false, 'Kit\'s whisper is not handed on');

    assert.equal(transferHeard(messages, { start: 0, end: 2 }, 'kit.png', 'old.png', members), 2);
    assert.deepEqual(present(messages), [['nova.png', 'old.png'], ['mira.png'], []]);
});

test('who heard a line lists current members it reaches and people who have left', () => {
    assert.deepEqual(heardBy(heard(['kit.png', 'gone.png']), members), ['kit.png', 'gone.png']);
    assert.deepEqual(heardBy(heard(['kit.png']), members, { seesAll: ['nova.png'] }), ['kit.png', 'nova.png']);
    assert.deepEqual(heardBy(heard(['kit.png', 'mira.png'], ['mira.png']), members, { seesAll: ['nova.png'] }), ['mira.png']);
    assert.deepEqual(heardBy({ mes: 'old' }, members), members);
    assert.deepEqual(heardBy(null, members), []);
});
