import { describe, expect, test } from '@jest/globals';
import {
    computeConversationGroupMemberEdit,
    describeConversationGroupMemberError,
    isConversationGroupMemberActive,
    orderConversationGroupPickerAvatars,
    pickConversationGroupFollowTarget,
} from '../public/scripts/neconyan-conversation/group-member-edits.js';

const autoName = members => `Group: ${members.map(member => member.replace('.png', '')).join(', ')}`;

describe('computeConversationGroupMemberEdit', () => {
    const base = { members: ['A.png', 'B.png', 'C.png'], disabled: [], visible: ['A.png', 'B.png', 'C.png', 'D.png'] };

    test('unticking one pal and ticking another gives an add, a remove and the next members in server order', () => {
        const edit = computeConversationGroupMemberEdit({ ...base, selected: new Set(['A.png', 'C.png', 'D.png']) });
        expect(edit.add).toEqual(['D.png']);
        expect(edit.remove).toEqual(['B.png']);
        expect(edit.next).toEqual(['A.png', 'C.png', 'D.png']);
        expect(edit.count).toBe(3);
        expect(edit.tooFew).toBe(false);
        expect(edit.unchanged).toBe(false);
    });

    test('a member absent from the listed pals is never removed', () => {
        const edit = computeConversationGroupMemberEdit({ ...base, visible: ['A.png', 'B.png'], selected: ['A.png', 'B.png'] });
        expect(edit.remove).toEqual([]);
        expect(edit.next).toEqual(['A.png', 'B.png', 'C.png']);
    });

    test('a member added elsewhere after the editor opened is not removed by saving', () => {
        // The editor was drawn with [A, B, C]; the latest store also holds D, which the editor never showed.
        const edit = computeConversationGroupMemberEdit({ members: ['A.png', 'B.png', 'C.png'], visible: ['A.png', 'B.png', 'C.png'], selected: ['A.png', 'C.png'] });
        expect(edit.remove).toEqual(['B.png']);
        expect(edit.add).toEqual([]);
    });

    test('a muted member ticked is an add, and a muted member left unticked is not removed by saving another change', () => {
        const ticked = computeConversationGroupMemberEdit({ members: ['A.png', 'B.png', 'C.png'], disabled: ['C.png'], visible: ['A.png', 'B.png', 'C.png'], selected: ['A.png', 'B.png', 'C.png'] });
        expect(ticked.add).toEqual(['C.png']);
        expect(ticked.remove).toEqual([]);
        expect(ticked.unchanged).toBe(false);
        const other = computeConversationGroupMemberEdit({ members: ['A.png', 'B.png', 'C.png'], disabled: ['C.png'], visible: ['A.png', 'B.png', 'C.png', 'D.png'], selected: ['A.png', 'B.png', 'D.png'] });
        expect(other.add).toEqual(['D.png']);
        expect(other.remove).toEqual([]);
        expect(other.next).toEqual(['A.png', 'B.png', 'C.png', 'D.png']);
    });

    test('nothing changed is unchanged, and fewer than two ticked is too few', () => {
        const same = computeConversationGroupMemberEdit({ ...base, selected: ['A.png', 'B.png', 'C.png'] });
        expect(same.unchanged).toBe(true);
        expect(same.tooFew).toBe(false);
        const one = computeConversationGroupMemberEdit({ ...base, selected: ['A.png'] });
        expect(one.tooFew).toBe(true);
        expect(one.count).toBe(1);
    });

    test('the automatic name follows the members only while the drawn name is the automatic name of the drawn members', () => {
        const members = ['A.png', 'B.png', 'C.png'];
        const selected = ['A.png', 'C.png', 'D.png'];
        const named = computeConversationGroupMemberEdit({ ...base, selected, name: autoName(members), autoName });
        expect(named.rename).toEqual({ from: 'Group: A, B, C', to: 'Group: A, C, D' });
        expect(computeConversationGroupMemberEdit({ ...base, selected, name: 'Book club', autoName }).rename).toBeNull();
        expect(computeConversationGroupMemberEdit({ ...base, selected: members, name: autoName(members), autoName }).rename).toBeNull();
        expect(computeConversationGroupMemberEdit({ ...base, selected, name: autoName(members) }).rename).toBeNull();
    });
});

describe('pickConversationGroupFollowTarget', () => {
    const group = { id: 'G', is_conversation_group: true, members: ['B.png', 'C.png'], disabled_members: [] };
    const common = { groupId: 'G', personaId: 'p.png', group };

    test('follows to the anchor when the avatar left the owned group', () => {
        expect(pickConversationGroupFollowTarget({ ...common, avatar: 'A.png', anchorAvatar: 'B.png' })).toEqual({ follow: true, avatar: 'B.png' });
    });

    test('follows when a removed key parses to the avatar, the group and the persona and the anchor differs', () => {
        const removedTargets = [{ avatar: 'B.png', groupId: 'G', personaId: 'p.png' }];
        expect(pickConversationGroupFollowTarget({ ...common, avatar: 'B.png', anchorAvatar: 'C.png', removedTargets })).toEqual({ follow: true, avatar: 'C.png' });
    });

    test('follows when a removed key is a legacy unscoped key of the avatar and the group', () => {
        const removedTargets = [{ avatar: 'B.png', groupId: 'G', personaId: '' }];
        expect(pickConversationGroupFollowTarget({ ...common, avatar: 'B.png', anchorAvatar: 'C.png', removedTargets })).toEqual({ follow: true, avatar: 'C.png' });
    });

    test('does not follow an active member whose keys were not removed, another group kind, no group, or an anchor equal to the avatar', () => {
        expect(pickConversationGroupFollowTarget({ ...common, avatar: 'B.png', anchorAvatar: 'C.png' })).toEqual({ follow: false });
        expect(pickConversationGroupFollowTarget({ ...common, avatar: 'B.png', anchorAvatar: 'C.png', removedTargets: [{ avatar: 'B.png', groupId: 'other', personaId: 'p.png' }] })).toEqual({ follow: false });
        expect(pickConversationGroupFollowTarget({ ...common, avatar: 'A.png', anchorAvatar: 'B.png', group: { ...group, is_conversation_group: false } })).toEqual({ follow: false });
        expect(pickConversationGroupFollowTarget({ ...common, avatar: 'A.png', anchorAvatar: 'B.png', group: null })).toEqual({ follow: false });
        expect(pickConversationGroupFollowTarget({ avatar: 'A.png', groupId: '', personaId: '', group: null, anchorAvatar: 'B.png' })).toEqual({ follow: false });
        expect(pickConversationGroupFollowTarget({ ...common, avatar: 'B.png', anchorAvatar: 'B.png', removedTargets: [{ avatar: 'B.png', groupId: 'G', personaId: 'p.png' }] })).toEqual({ follow: false });
    });

    test('must follow with no anchor to leave when nobody is left to hold the group', () => {
        expect(pickConversationGroupFollowTarget({ ...common, avatar: 'A.png', anchorAvatar: '' })).toEqual({ follow: true, avatar: '' });
    });
});

describe('orderConversationGroupPickerAvatars', () => {
    test('members first in member order, then the others in their original order', () => {
        expect(orderConversationGroupPickerAvatars(['X.png', 'C.png', 'Y.png', 'A.png', 'B.png'], ['A.png', 'B.png', 'C.png']))
            .toEqual(['A.png', 'B.png', 'C.png', 'X.png', 'Y.png']);
    });
});

describe('describeConversationGroupMemberError', () => {
    test.each([
        ['members_required', 'too_few'],
        ['no_available_members', 'too_few'],
        ['member_not_found', 'missing_card'],
        ['group_not_found', 'gone'],
        ['too_many_members', 'connection'],
        ['Conversation store request failed with 500.', 'connection'],
    ])('%s is %s', (message, kind) => {
        expect(describeConversationGroupMemberError(new Error(message))).toBe(kind);
    });

    test('an unknown value is a connection problem', () => {
        expect(describeConversationGroupMemberError(undefined)).toBe('connection');
    });
});

describe('isConversationGroupMemberActive', () => {
    test('false for a removed or muted member and for no group', () => {
        const group = { members: ['A.png', 'B.png'], disabled_members: ['B.png'] };
        expect(isConversationGroupMemberActive(group, 'A.png')).toBe(true);
        expect(isConversationGroupMemberActive(group, 'B.png')).toBe(false);
        expect(isConversationGroupMemberActive(group, 'C.png')).toBe(false);
        expect(isConversationGroupMemberActive(null, 'A.png')).toBe(false);
    });
});
