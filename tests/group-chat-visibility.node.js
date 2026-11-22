import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addGroupHearer, beginGroupPromptScope, canGroupMemberSee, canGroupTargetSee, changeGroupHearers, countGroupPromptHiddenMessages, filterGroupPromptMessages, filterGroupTargetMessages, groupHeardCount, groupMessageAudience, getGroupPromptViewers, groupSceneCardMembers, groupScenePrompt, groupSceneTurnNeedsPage, groupTargetViewers, hasRestrictedGroupHistory, readGroupScene, readGroupSceneRules, sameGroupViewers, withGroupTargetPrompt } from '../public/scripts/group-chat-visibility.js';

test('scene state is bounded to current members and has safe defaults', () => {
    assert.deepEqual(readGroupScene({}, ['kit', 'mira']), { away: [], location: '', whisper_to: [], sees_all: [] });
    assert.deepEqual(readGroupScene({ group_scene: { away: ['kit', 'kit', 'removed'], whisper_to: ['mira', 'removed'], location: 'The archive' } }, ['kit', 'mira']),
        { away: ['kit'], whisper_to: ['mira'], location: 'The archive', sees_all: [] });
});

test('joined cards keep the members still in the scene and always the speakers', () => {
    const metadata = { group_scene: { away: ['mira', 'removed'] } };
    assert.deepEqual(groupSceneCardMembers(metadata, ['kit', 'mira', 'nova']), ['kit', 'nova']);
    assert.deepEqual(groupSceneCardMembers(metadata, ['kit', 'mira', 'nova'], ['mira']), ['kit', 'mira', 'nova']);
    assert.deepEqual(groupSceneCardMembers({}, ['kit', 'mira']), ['kit', 'mira']);
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

test('background Agents writing for a member who sees everything read the lines that member heard', () => {
    const heardByKit = { mes: 'Kit only', extra: { group_scene: { present: ['kit'], whisper_to: [] } } };
    const whisperToKit = { mes: 'Whisper', extra: { group_scene: { present: ['kit', 'mira'], whisper_to: ['kit'] } } };
    const messages = [heardByKit, whisperToKit];
    const miraReply = { original_avatar: 'mira' };
    const rules = readGroupSceneRules({ group_scene: { sees_all: ['mira'] } });
    assert.deepEqual(filterGroupTargetMessages(messages, miraReply, rules), [heardByKit]);
    assert.equal(canGroupTargetSee(heardByKit, miraReply, rules), true);
    withGroupTargetPrompt(miraReply, messages, () => {
        assert.deepEqual(filterGroupPromptMessages(messages), [heardByKit]);
    }, rules);
});

test('an Agent target names the members it writes for, and audiences compare as sets', () => {
    assert.deepEqual(groupTargetViewers({ original_avatar: 'mira', extra: { group_scene: { present: ['kit'], whisper_to: [] } } }), ['mira']);
    assert.deepEqual(groupTargetViewers({ is_user: true, extra: { group_scene: { present: ['kit', 'mira'], whisper_to: ['kit'] } } }), ['kit']);
    assert.deepEqual(groupTargetViewers({ is_user: true, extra: { group_scene: { present: ['kit', 'mira'], whisper_to: [] } } }), ['kit', 'mira']);
    assert.equal(groupTargetViewers({ is_user: true }), null);
    assert.equal(groupTargetViewers(null), null);
    assert.equal(sameGroupViewers(null, null), true);
    assert.equal(sameGroupViewers(['kit'], null), false);
    assert.equal(sameGroupViewers(null, ['kit']), false);
    assert.equal(sameGroupViewers(['kit', 'mira'], ['mira', 'kit']), true);
    assert.equal(sameGroupViewers(['kit'], ['kit', 'mira']), false);
    assert.equal(sameGroupViewers(['kit', 'kit'], ['kit', 'mira']), false);
});

test('a scoped turn names its speakers and counts the lines they missed', () => {
    const messages = [
        { mes: 'Public' },
        { mes: 'Kit only', extra: { group_scene: { present: ['kit'], whisper_to: [] } } },
        { mes: 'Hidden note', is_system: true, extra: { group_scene: { present: ['kit'], whisper_to: [] } } },
    ];
    assert.equal(getGroupPromptViewers(), null);
    assert.equal(countGroupPromptHiddenMessages(), 0);
    const restore = beginGroupPromptScope(['mira'], messages);
    assert.deepEqual(getGroupPromptViewers(), ['mira']);
    assert.equal(countGroupPromptHiddenMessages(), 1);
    restore();
    const everyone = beginGroupPromptScope([], messages);
    assert.equal(hasRestrictedGroupHistory(), false);
    assert.equal(countGroupPromptHiddenMessages(), 0);
    everyone();
});

test('a member who sees everything still misses whispers to someone else', () => {
    const heardByKit = { extra: { group_scene: { present: ['kit'], whisper_to: [] } } };
    const whisperToKit = { extra: { group_scene: { present: ['kit', 'mira'], whisper_to: ['kit'] } } };
    const rules = readGroupSceneRules({ group_scene: { sees_all: ['mira'] } });
    assert.deepEqual(rules, { seesAll: ['mira'] });
    assert.deepEqual(readGroupSceneRules({ group_scene: { sees_all: [] } }), {});
    assert.deepEqual(readGroupScene({ group_scene: { sees_all: ['mira', 'mira', 'gone'] } }, ['kit', 'mira']).sees_all, ['mira']);
    assert.equal(canGroupMemberSee(heardByKit, 'mira'), false);
    assert.equal(canGroupMemberSee(heardByKit, 'mira', rules), true);
    assert.equal(canGroupMemberSee(whisperToKit, 'mira', rules), false);
    const restore = beginGroupPromptScope(['mira'], [heardByKit, whisperToKit], rules);
    try {
        assert.deepEqual(filterGroupPromptMessages([heardByKit, whisperToKit]), [heardByKit]);
    } finally {
        restore();
    }
});

test('a speaker hears the line they reply to, and is recorded as having heard it', () => {
    const earlier = { extra: { group_scene: { present: ['kit'], whisper_to: [] } } };
    const target = { extra: { group_scene: { present: ['kit'], whisper_to: [] } }, swipe_id: 1, swipe_info: [{ extra: { group_scene: { present: ['kit'], whisper_to: [] } } }, { extra: { group_scene: { present: ['kit'], whisper_to: [] } } }] };
    const restore = beginGroupPromptScope(['mira'], [earlier, target], { replyTarget: target });
    try {
        assert.deepEqual(filterGroupPromptMessages([earlier, target]), [target]);
    } finally {
        restore();
    }
    assert.equal(addGroupHearer(target, 'mira'), true);
    assert.deepEqual(target.extra.group_scene.present, ['kit', 'mira']);
    assert.deepEqual(target.swipe_info[1].extra.group_scene.present, ['kit', 'mira']);
    assert.deepEqual(target.swipe_info[0].extra.group_scene.present, ['kit']);
    assert.equal(addGroupHearer(target, 'mira'), false);
    assert.equal(addGroupHearer(target, 'mira', { everySwipe: true }), true);
    assert.deepEqual(target.swipe_info[0].extra.group_scene.present, ['kit', 'mira']);
    const whisper = { extra: { group_scene: { present: ['kit', 'mira'], whisper_to: ['kit'] } } };
    assert.equal(canGroupMemberSee(whisper, 'mira', { replyTarget: whisper }), false);
    assert.equal(addGroupHearer(whisper, 'ash'), false);
    assert.deepEqual(whisper.extra.group_scene.present, ['kit', 'mira']);
    assert.equal(addGroupHearer({ mes: 'Older public line' }, 'mira'), false);
});

test('changing who heard a line updates the message and its own swipe records only', () => {
    const members = ['kit', 'mira', 'ash'];
    const message = {
        mes: 'Kit whistles.',
        extra: { group_scene: { present: ['kit'], whisper_to: [] } },
        swipe_info: [{ extra: { group_scene: { present: ['kit'], whisper_to: [] } } }, { extra: {} }],
    };
    assert.equal(changeGroupHearers(message, { exact: ['kit', 'mira', 'mira'] }, members), true);
    assert.deepEqual(message.extra.group_scene.present, ['kit', 'mira']);
    assert.deepEqual(message.swipe_info[0].extra.group_scene.present, ['kit', 'mira']);
    assert.deepEqual(message.swipe_info[1].extra, {});
    assert.equal(changeGroupHearers(message, { exact: ['mira', 'kit'] }, members), false);

    assert.equal(changeGroupHearers(message, { add: ['ash'], remove: ['kit'] }, members), true);
    assert.deepEqual(message.extra.group_scene.present, ['mira', 'ash']);

    const older = { mes: 'Older public line' };
    assert.equal(changeGroupHearers(older, { add: ['kit'] }, members), false);
    assert.equal(older.extra, undefined);
    assert.equal(changeGroupHearers(older, { remove: ['ash'] }, members), true);
    assert.deepEqual(older.extra.group_scene, { present: ['kit', 'mira'], whisper_to: [] });
});

test('the heard badge counts only lines that some current member missed', () => {
    const members = ['kit', 'mira', 'ash'];
    const line = present => ({ extra: { group_scene: { present, whisper_to: [] } } });
    assert.deepEqual(groupHeardCount(line(['kit']), members), { heard: 1, total: 3 });
    assert.equal(groupHeardCount(line(members), members), null);
    assert.deepEqual(groupHeardCount(line(['kit']), members, { seesAll: ['ash'] }), { heard: 2, total: 3 });
    assert.equal(groupHeardCount({ mes: 'Older public line' }, members), null);
    assert.equal(groupHeardCount({ extra: { group_scene: { present: ['kit'], whisper_to: ['kit'] } } }, members), null);
    assert.equal(groupHeardCount(line(['kit']), []), null);
});

test('a scene turn stays in the page only for whispers, away speakers and an unheard line being answered', () => {
    const members = ['kit', 'mira'];
    const meta = scene => ({ group_scene: { away: [], location: 'The archive', whisper_to: [], ...scene } });
    const missed = { mes: 'Only Kit heard this.', extra: { group_scene: { present: ['kit'], whisper_to: [] } } };
    const shared = { mes: 'Both heard this.', extra: { group_scene: { present: members, whisper_to: [] } } };
    assert.equal(groupSceneTurnNeedsPage([missed, shared], meta(), members, ['mira']), false);
    assert.equal(groupSceneTurnNeedsPage([shared, missed], meta(), members, ['mira']), true);
    assert.equal(groupSceneTurnNeedsPage([shared, missed], meta(), members, ['mira'], { hearReplyTarget: false }), false);
    assert.equal(groupSceneTurnNeedsPage([shared, missed], meta({ sees_all: ['mira'] }), members, ['mira']), false);
    assert.equal(groupSceneTurnNeedsPage([shared], meta({ whisper_to: ['kit'] }), members, ['kit']), true);
    assert.equal(groupSceneTurnNeedsPage([shared], meta({ away: ['mira'] }), members, ['kit']), false);
    assert.equal(groupSceneTurnNeedsPage([shared], meta({ away: ['mira'] }), members, ['mira']), true);
});
