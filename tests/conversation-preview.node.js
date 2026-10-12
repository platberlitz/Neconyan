import assert from 'node:assert/strict';
import test from 'node:test';
import { publishConversationPreview, readConversationPreview, subscribeConversationPreview } from '../src/generation/conversation-preview.js';
import { publishRoleplayPreview, subscribeRoleplayPreview } from '../src/generation/roleplay-preview.js';
import { publishScratchpadPreview, subscribeScratchpadPreview } from '../src/scratchpad/preview.js';

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

test('a late unsubscribe from a closed viewer keeps a reconnected viewer listening', () => {
    const publishers = {
        conversation: () => publishConversationPreview({ owner: 'late', job: { id: 'speaker', parentId: 'root' } },
            { target: { avatar: 'one.png', branchId: 'main' }, speaker: { avatar: 'one.png', name: 'One' } }, { text: 'Hello' }),
        roleplay: () => publishRoleplayPreview({ owner: 'late', job: { id: 'child',
            intent: { request: { characterName: 'One', workflowCandidate: { parentJobId: 'root' } } } } }, { stage: 'generating', text: 'Hello' }),
        scratchpad: () => publishScratchpadPreview('late', 'root', { text: 'Hello' }),
    };
    const subscribers = { conversation: subscribeConversationPreview, roleplay: subscribeRoleplayPreview, scratchpad: subscribeScratchpadPreview };
    for (const [name, subscribe] of Object.entries(subscribers)) {
        const closed = subscribe('late', 'root', () => {});
        closed();
        let received = 0;
        const reconnected = subscribe('late', 'root', () => { received += 1; });
        closed();
        publishers[name]();
        assert.equal(received, 1, `${name} previews still reach the reconnected viewer`);
        reconnected();
    }
    publishConversationPreview({ owner: 'late', job: { id: 'speaker', parentId: 'root' } }, {}, null);
});
