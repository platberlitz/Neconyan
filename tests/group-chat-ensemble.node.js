import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnsemblePrompt, splitEnsembleReply, createEnsembleMessages } from '../public/scripts/group-chat-ensemble.js';

const members = [{ name: 'Mira', avatar: 'mira.png' }, { name: 'Kit (Jr.)', avatar: 'kit.png' }];

test('ensemble splits exact speaker headings, including markdown, without losing dialogue', () => {
    assert.deepEqual(splitEnsembleReply('**Mira:**\nCome in.\n\n**Kit (Jr.)**: Gladly.', members), [
        { ...members[0], text: 'Come in.' }, { ...members[1], text: 'Gladly.' },
    ]);
    assert.deepEqual(splitEnsembleReply('Mira: Come in.\nKit (Jr.): Gladly.', members), [
        { ...members[0], text: 'Come in.' }, { ...members[1], text: 'Gladly.' },
    ]);
});

test('ensemble preserves ambiguous output for the narrator rather than discarding text', () => {
    for (const text of [
        'A door opens.\nMira: Come in.\nKit (Jr.): Gladly.',
        'Kit (Jr.): Gladly.\nMira: Come in.',
        'Mira: Come in.',
        'Mira: Come in.\nKit (Jr.):',
        'Mira: Come in.\nKit (Jr.): Gladly.\nMira: Welcome.',
    ]) assert.equal(splitEnsembleReply(text, members), null);
    assert.equal(splitEnsembleReply('Mira: One.\nMira: Two.', [members[0], members[0]]), null);
});

test('ensemble prompt specifies the requested order and protects the user role', () => {
    const prompt = buildEnsemblePrompt(members.map(member => member.name), 'Alex');
    assert.match(prompt, /Mira, Kit \(Jr\.\), in that order/);
    assert.match(prompt, /Never write dialogue, decisions or thoughts for Alex/);
});

test('ensemble messages retain identities, swipe text and request-wide metadata without duplication', () => {
    const original = { name: 'Narrator', mes: 'Mira: Come in.\nKit (Jr.): Gladly.', mewmory_id: 'first-id',
        is_user: false, extra: { gen_id: 12, token_count: 20, reasoning: 'Shared reasoning' } };
    const result = createEnsembleMessages(original, members, avatar => `/avatar/${avatar}`, '/narrator.png');
    assert.equal(result[0].mewmory_id, 'first-id');
    assert.equal(result[1].mewmory_id, undefined);
    assert.equal(result[0].extra.reasoning, 'Shared reasoning');
    assert.equal(result[1].extra.reasoning, undefined);
    assert.equal(result[1].extra.token_count, undefined);
    assert.equal(result[1].original_avatar, 'kit.png');
    assert.equal(result[1].force_avatar, '/avatar/kit.png');
    assert.deepEqual(result[1].swipes, ['Gladly.']);
    assert.equal(original.name, 'Narrator');
    const fallback = createEnsembleMessages({ ...original, mes: 'An unsplit scene.' }, members, avatar => avatar, '/narrator.png');
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].mes, 'An unsplit scene.');
    assert.equal(fallback[0].name, 'Narrator');
});
