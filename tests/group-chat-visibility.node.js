import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginGroupPromptScope, canGroupMemberSee, filterGroupPromptMessages, filterGroupTargetMessages, groupMessageAudience, groupScenePrompt, hasRestrictedGroupHistory, readGroupScene, withGroupTargetPrompt } from '../public/scripts/group-chat-visibility.js';

test('scene state is bounded to current members and has safe defaults', () => {
    assert.deepEqual(readGroupScene({}, ['kit', 'mira']), { away: [], location: '', whisper_to: [] });
    assert.deepEqual(readGroupScene({ group_scene: { away: ['kit', 'kit', 'removed'], whisper_to: ['mira', 'removed'], location: 'The archive' } }, ['kit', 'mira']),
        { away: ['kit'], whisper_to: ['mira'], location: 'The archive' });
});

test('a returning member cannot see messages from while they were away', () => {
    const scene = { away: ['kit'] };
    const message = { extra: { group_scene: groupMessageAudience(scene, ['kit', 'mira']) } };
    scene.away = [];
    assert.equal(canGroupMemberSee(message, 'kit'), false);
    assert.equal(canGroupMemberSee(message, 'mira'), true);
    assert.equal(canGroupMemberSee({ mes: 'Older public history' }, 'kit'), true);
});

test('whispers and their replies stay private even after the audience selection changes', () => {
    const targets = ['mira'];
    const audience = groupMessageAudience({ away: [] }, ['kit', 'mira'], targets);
    targets.push('kit');
    for (const is_user of [true, false]) {
        const message = { is_user, extra: { group_scene: audience } };
        assert.equal(canGroupMemberSee(message, 'kit'), false);
        assert.equal(canGroupMemberSee(message, 'mira'), true);
    }
});

test('scene prompt identifies the location and who cannot participate', () => {
    assert.match(groupScenePrompt({ location: 'Archive', away: ['kit'] }, [{ name: 'Kit', avatar: 'kit' }, { name: 'Mira', avatar: 'mira' }]),
        /Location: Archive\. Present: Mira\. Away: Kit/);
});

test('prompt scopes intersect ensemble audiences, nest safely and restore the full saved chat', () => {
    const messages = [{ mes: 'Public' }, { mes: 'Secret', extra: { group_scene: { present: ['kit'], whisper_to: ['kit'] } } }];
    const restoreKit = beginGroupPromptScope(['kit'], messages);
    assert.deepEqual(filterGroupPromptMessages(messages), messages);
    assert.equal(hasRestrictedGroupHistory(), false);
    const restoreEnsemble = beginGroupPromptScope(['kit', 'mira'], messages);
    assert.deepEqual(filterGroupPromptMessages(messages), [messages[0]]);
    assert.equal(hasRestrictedGroupHistory(), true);
    restoreEnsemble();
    assert.equal(hasRestrictedGroupHistory(), false);
    restoreKit();
    assert.equal(filterGroupPromptMessages(messages), messages);
});

test('background Agent history and macro expansion follow their target after the active turn ends', () => {
    const publicMessage = { mes: 'Public' };
    const secret = { mes: 'Secret', extra: { group_scene: { present: ['kit'], whisper_to: ['kit'] } } };
    const messages = [publicMessage, secret];
    const miraReply = { original_avatar: 'mira' };
    assert.deepEqual(filterGroupTargetMessages(messages, miraReply), [publicMessage]);
    withGroupTargetPrompt(miraReply, messages, () => {
        assert.deepEqual(filterGroupPromptMessages(messages), [publicMessage]);
        assert.equal(hasRestrictedGroupHistory(), true);
    });
    assert.equal(filterGroupPromptMessages(messages), messages);
    assert.throws(() => withGroupTargetPrompt(miraReply, messages, () => { throw new Error('Failed macro'); }));
    assert.equal(filterGroupPromptMessages(messages), messages);
});
