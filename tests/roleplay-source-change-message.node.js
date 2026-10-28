import assert from 'node:assert/strict';
import test from 'node:test';

import { describeRoleplaySourceChange } from '../src/generation/roleplay-source.js';

const OUTCOME = 'after this was requested, so it was stopped instead of saving over that change. Try again.';

function source(overrides = {}) {
    return {
        accountId: 'account', dataEpoch: 1, instanceId: 'chat-1', revision: 87, rawHash: 'a',
        locator: { avatar: 'Ryan Wilson.png', fileName: 'Ryan Wilson - 2026-10-28' },
        dependencies: [{ kind: 'character', instanceId: 'char-1', revision: 4, contentHash: 'c',
            locator: { avatar: 'Ryan Wilson.png' } }],
        ...overrides,
    };
}

function describe(changes) {
    return describeRoleplaySourceChange(source(), source(changes));
}

test('a plain chat save says the chat was saved by another change', () => {
    const { reason, message } = describe({ revision: 88, rawHash: 'b' });
    assert.equal(reason, 'chat-saved');
    assert.equal(message, `The chat was saved by another change (an edit, a new message, or an extension rewriting messages) ${OUTCOME}`);
});

test('a saved character card is named', () => {
    const { reason, message } = describe({ dependencies: [{ ...source().dependencies[0], revision: 5, contentHash: 'd' }] });
    assert.equal(reason, 'character');
    assert.equal(message, `The character card 'Ryan Wilson' was saved ${OUTCOME}`);
});

test('an edited target message is named before the chat save it caused', () => {
    const message = { index: 3, recordHash: 'x', selectedSwipeId: 0, selectedSwipeHash: 'y', selectedSwipeInfoHash: 'z' };
    const result = describeRoleplaySourceChange(source({ message }),
        source({ revision: 88, rawHash: 'b', message: { ...message, recordHash: 'w' } }));
    assert.equal(result.reason, 'message');
    assert.match(result.message, /^The message this was for was edited, swiped or deleted after this was requested/);
});

test('changes to the chat itself outrank changes inside it', () => {
    assert.equal(describe({ dataEpoch: 2, revision: 88 }).reason, 'account');
    assert.equal(describe({ instanceId: 'chat-2', revision: 88 }).reason, 'chat-replaced');
    assert.equal(describe({ locator: { avatar: 'Ryan Wilson.png', fileName: 'Renamed' } }).reason, 'chat-moved');
});

test('a group member change says the group changed', () => {
    const group = { kind: 'group', instanceId: 'group-1', revision: 1, contentHash: 'g', locator: { groupId: 'g1' } };
    const before = source({ groupId: 'g1', dependencies: [group, source().dependencies[0]] });
    const added = { kind: 'character', instanceId: 'char-2', revision: 1, contentHash: 'e', locator: { avatar: 'Nova.png' } };
    const after = source({ groupId: 'g1', dependencies: [{ ...group, revision: 2 }, source().dependencies[0], added] });
    const { reason, message } = describeRoleplaySourceChange(before, after);
    assert.equal(reason, 'group');
    assert.equal(message, `The group's settings or members were changed ${OUTCOME}`);
});

test('no message keeps the old vague wording', () => {
    for (const changes of [{ revision: 88 }, { dataEpoch: 2 }, { locator: {} }]) {
        assert.doesNotMatch(describe(changes).message, /Roleplay source|work was prepared/);
    }
});
