import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverConversationReply } from '../public/scripts/neconyan-conversation/reply-delivery.js';

test('shared delivery preserves quoted commands, speaker references and the successful-append boundary', async () => {
    const speakers = [{ avatar: 'a.png', name: 'Aster' }, { avatar: 'b.png', name: 'Birch' }];
    const settings = { schedule_command_enabled: true, selfie_command_enabled: true };
    const events = [];
    const host = {
        fallbackSpeaker: speakers[0], groupId: 'group', getSpeakers: () => speakers,
        append: async (text, speaker, options) => { events.push(['append', text, speaker.avatar, options]); return true; },
        commitCommands: async (commands, speaker) => { events.push(['commands', commands, speaker]); },
        generateImage: async (context, speaker, options) => { events.push(['image', context, speaker.avatar, options]); return true; },
    };
    const output = await deliverConversationReply('Aster: Hello [schedule_update: status="dnd" activity="working"]\nBirch: Hi [selfie: context="at my desk"]\nBirch: Another message', settings, host);
    assert.equal(output.posted, true);
    assert.deepEqual(output.text, ['Hello', 'Hi', 'Another message']);
    assert.deepEqual(events.map(event => event[0]), ['append', 'commands', 'append', 'image', 'append']);
    assert.deepEqual(events[1][1].scheduleUpdates, ['status="dnd" activity="working"']);
    assert.equal(events[2][3].attachReplyReference, true);
    assert.equal(events[3][1], 'at my desk');
    assert.equal(events[3][3].attachReplyReference, false);
    assert.equal(events[4][3].attachReplyReference, false);
    events.length = 0;
    await deliverConversationReply('Aster: Later [schedule_update: status="dnd"]', settings, { ...host, append: async () => false });
    assert.equal(events.length, 0);
    await deliverConversationReply('Later [schedule_update: status="dnd"]\nAgain', settings, { ...host, groupId: '', splitEveryLine: true });
    assert.deepEqual(events[1][1].scheduleUpdates, ['status="dnd"']);
});

test('a schedule command in its own paragraph does not create an empty bubble', async () => {
    const speaker = { avatar: 'a.png', name: 'Aster' };
    const settings = { schedule_command_enabled: true };
    const messages = [];
    const updates = [];
    const host = {
        fallbackSpeaker: speaker, getSpeakers: () => [speaker],
        append: async text => { messages.push(text); return true; },
        commitCommands: async commands => { updates.push(...commands.scheduleUpdates); },
    };
    const command = '[schedule_update: status="dnd"]';
    const empty = await deliverConversationReply(command, settings, host);
    assert.equal(empty.posted, false);
    assert.deepEqual(updates, []);
    const reply = await deliverConversationReply(`${command}\n\nI’ll be working.\n\n${command}`, settings, host);
    assert.equal(reply.posted, true);
    assert.deepEqual(messages, ['I’ll be working.']);
    assert.deepEqual(updates, ['status="dnd"', 'status="dnd"']);
});
