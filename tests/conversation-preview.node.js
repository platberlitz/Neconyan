import assert from 'node:assert/strict';
import test from 'node:test';
import { publishConversationPreview, readConversationPreview, subscribeConversationPreview } from '../src/generation/conversation-preview.js';

test('Conversation previews isolate accounts and keep concurrent speakers separate', () => {
    const one = { owner: 'first', job: { id: 'speaker-one', parentId: 'root' } };
    const two = { owner: 'first', job: { id: 'speaker-two', parentId: 'root' } };
    const other = { owner: 'second', job: { id: 'speaker-one', parentId: 'root' } };
    const snapshot = { target: { avatar: 'one.png', branchId: 'main' }, speaker: { avatar: 'one.png', name: 'One' } };
    const notices = [];
    const unsubscribe = subscribeConversationPreview('first', 'root', value => notices.push(value));
    publishConversationPreview(one, snapshot, { text: 'First', token_count: 1, reasoning_tokens: 2 });
    publishConversationPreview(two, { ...snapshot, speaker: { avatar: 'two.png', name: 'Two' } }, { text: 'Second', token_count: 3 });
    publishConversationPreview(other, snapshot, { text: 'Private', token_count: 8 });
    assert.equal(notices.length, 2);
    assert.deepEqual(readConversationPreview('first', 'root').participants.map(value => value.token_count), [1, 3]);
    assert.equal(readConversationPreview('second', 'root').participants[0].text, 'Private');
    publishConversationPreview(one, snapshot, null);
    assert.equal(readConversationPreview('first', 'root').participants[0].avatar, 'two.png');
    publishConversationPreview(two, snapshot, null);
    publishConversationPreview(other, snapshot, null);
    assert.deepEqual(readConversationPreview('first', 'root'), { participants: [] });
    unsubscribe();
});
