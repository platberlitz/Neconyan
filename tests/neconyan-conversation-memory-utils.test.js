import { describe, expect, test } from '@jest/globals';

import {
    collectGroupConversationMemorySummaries,
    collectSoloConversationMemorySummary,
} from '../public/scripts/neconyan-conversation/memory-utils.js';

describe('neconyan conversation memory utils', () => {
    test('collects the active solo memory summary for a character', () => {
        const store = {
            char_a: {
                activeBranchId: 'main',
                branches: {
                    main: { memorySummary: '  Solo promise and private joke.  ', updatedAt: 100 },
                },
            },
        };

        expect(collectSoloConversationMemorySummary(store, 'char_a')).toEqual({
            avatar: 'char_a',
            summary: 'Solo promise and private joke.',
            updatedAt: 100,
        });
        expect(collectSoloConversationMemorySummary(store, 'missing')).toBeNull();
    });

    test('collects group memories for the same avatar newest first', () => {
        const store = {
            char_a: {
                activeBranchId: 'main',
                branches: {
                    main: { memorySummary: 'Solo memory', updatedAt: 400 },
                },
            },
            'group:alpha:char_a': {
                activeBranchId: 'main',
                branches: {
                    main: { memorySummary: '  Alpha group memory.  ', updatedAt: 200 },
                },
            },
            'group:beta:char_a': {
                activeBranchId: 'branch_2',
                branches: {
                    main: { memorySummary: 'Old beta memory.', updatedAt: 100 },
                    branch_2: { memorySummary: 'Beta branch memory.', updatedAt: 300 },
                },
            },
            'group:gamma:char_b': {
                activeBranchId: 'main',
                branches: {
                    main: { memorySummary: 'Wrong avatar memory.', updatedAt: 500 },
                },
            },
            'group:empty:char_a': {
                activeBranchId: 'main',
                branches: {
                    main: { memorySummary: '   ', updatedAt: 600 },
                },
            },
        };

        expect(collectGroupConversationMemorySummaries(store, 'char_a', {
            getGroupName: groupId => ({ alpha: 'Alpha Squad', beta: 'Beta Crew' }[groupId]),
        })).toEqual([
            { groupId: 'beta', groupName: 'Beta Crew', summary: 'Beta branch memory.', updatedAt: 300 },
            { groupId: 'alpha', groupName: 'Alpha Squad', summary: 'Alpha group memory.', updatedAt: 200 },
        ]);
    });

    test.each(['personaId', 'persona', 'personaAvatar', 'userAvatar'])('matches the saved group owner via %s and requires active membership', ownerField => {
        const store = { 'group:alpha:holder': { memorySummary: 'Shared' } };
        const group = { id: 'alpha', name: 'Pals', [ownerField]: ' alice ', members: ['holder', 'pal', 'muted'], disabled_members: ['muted'] };
        const options = { groups: [group], personaId: 'alice', getGroupName: () => 'Legacy' };
        const read = avatar => collectGroupConversationMemorySummaries(store, avatar, options);

        expect(read('pal')).toEqual([{ groupId: 'alpha', groupName: 'Pals', summary: 'Shared', updatedAt: 0 }]);
        expect(read('outsider')).toEqual([]);
        expect(read('muted')).toEqual([]);
        group.disabled_members.push('holder');
        expect(read('holder')).toEqual([]);
        group.members = ['pal', 'muted'];
        group.disabled_members = [];
        expect(read('holder')).toEqual([]);
        group.members.push('holder');
        options.personaId = 'bob';
        expect(read('holder')).toEqual([]);
        options.groups = [];
        expect(read('holder')[0].groupName).toBe('Legacy');
        expect(read('pal')).toEqual([]);
    });

    test('selects the newest nonempty alias per group before limiting, with stable key order for ties', () => {
        const store = {
            'group:alpha:z': { memorySummary: 'Tied, later key', memoryUpdatedAt: 45 },
            'group:alpha:q': { memorySummary: 'Older', memoryUpdatedAt: 40 },
            'group:alpha:b': { memorySummary: 'Thread summary', memoryUpdatedAt: 45,
                branches: { main: { memorySummary: 'Branch summary', updatedAt: 100 } } },
            'group:alpha:c': { memoryUpdatedAt: 50 },
            'group:beta:p': { activeBranchId: 'branch', branches: { main: { memorySummary: 'Older branch' }, branch: { memorySummary: 'Beta', createdAt: 32 } } },
            'group:gamma:p': { memorySummary: 'Excluded', memoryUpdatedAt: 60 },
        };
        const options = { personaId: 'alice', groups: ['alpha', 'beta', 'gamma'].map(id => ({ id, name: id, personaId: 'alice', members: ['pal', 'p'] })),
            excludeGroupId: 'gamma', max: 2 };
        const expected = [{ groupId: 'alpha', groupName: 'alpha', summary: 'Thread summary', updatedAt: 45 },
            { groupId: 'beta', groupName: 'beta', summary: 'Beta', updatedAt: 32 }];
        expect(collectGroupConversationMemorySummaries(store, 'pal', options)).toEqual(expected);
        expect(collectGroupConversationMemorySummaries(Object.fromEntries(Object.entries(store).reverse()), 'pal', options)).toEqual(expected);
    });

    test('limits and excludes group memories', () => {
        const store = {
            'group:alpha:char_a': { branches: { main: { memorySummary: 'Alpha.', updatedAt: 100 } } },
            'group:beta:char_a': { branches: { main: { memorySummary: 'Beta.', updatedAt: 200 } } },
            'group:gamma:char_a': { branches: { main: { memorySummary: 'Gamma.', updatedAt: 300 } } },
        };

        expect(collectGroupConversationMemorySummaries(store, 'char_a', { excludeGroupId: 'gamma', max: 1 })).toEqual([
            { groupId: 'beta', groupName: '', summary: 'Beta.', updatedAt: 200 },
        ]);
    });
});
