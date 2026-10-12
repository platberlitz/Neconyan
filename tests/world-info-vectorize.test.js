/* eslint-disable playwright/no-standalone-expect -- These are parameterised Jest tests. */
import { describe, expect, test } from '@jest/globals';
import { planWorldInfoVectorization } from '../public/scripts/world-info-vectorize.js';

function mixedBook() {
    return { entries: {
        0: { uid: 0, constant: false, vectorized: false, key: ['cat'], content: 'Cat' },
        1: { uid: 1, constant: true, vectorized: false },
        2: { uid: 2, vectorized: true },
        3: { uid: 3, disable: true, content: '' },
        4: { uid: 4, constant: true, vectorized: true, disable: true },
        5: { uid: 5, vectorized: true, disable: true },
    } };
}

describe('whole-lorebook Vectorization planning', () => {
    test('counts mutually exclusive states with disabled entries overlapping them', () => {
        expect(planWorldInfoVectorization(mixedBook())).toEqual({
            keywordCount: 2, constantCount: 2, vectorizedCount: 2, disabledCount: 3,
            changes: [{ key: '0', uid: 0 }, { key: '3', uid: 3 }],
        });
    });

    test('constants are opt-in, including entries with both flags true', () => {
        const plan = planWorldInfoVectorization(mixedBook(), { includeConstants: true });
        expect(plan).toMatchObject({ keywordCount: 2, constantCount: 2, vectorizedCount: 2, disabledCount: 3 });
        expect(plan.changes.map(change => change.uid)).toEqual([0, 1, 3, 4]);
        expect(plan.changes.map(change => change.key)).toEqual(['0', '1', '3', '4']);
    });

    test('disabled counting matches the editor filter for truthy imported flags', () => {
        const data = { entries: { 0: { uid: 0, disable: 1 } } };
        expect(planWorldInfoVectorization(data).disabledCount).toBe(1);
        expect(planWorldInfoVectorization(data).changes).toEqual([{ key: '0', uid: 0 }]);
        expect(data.entries[0].disable).toBe(1);
    });

    test('empty normal entries are included and invalid records ignored', () => {
        const data = { entries: { 7: {}, 8: null, 9: [], 10: 'bad', 11: false, 12: 5 } };
        expect(planWorldInfoVectorization(data)).toEqual({ keywordCount: 1, constantCount: 0, vectorizedCount: 0, disabledCount: 0,
            changes: [{ key: '7', uid: '7' }] });
    });

    test.each([undefined, null, {}, { entries: {} }])('missing/empty books have zero counts: %j', data => {
        expect(planWorldInfoVectorization(data)).toEqual({ keywordCount: 0, constantCount: 0, vectorizedCount: 0, disabledCount: 0, changes: [] });
    });

    test('already-vectorized entries and repeated conversion produce no changes', () => {
        const data = mixedBook();
        for (const { key } of planWorldInfoVectorization(data, { includeConstants: true }).changes) Object.assign(data.entries[key], { constant: false, vectorized: true });
        expect(planWorldInfoVectorization(data, { includeConstants: true })).toEqual({
            keywordCount: 0, constantCount: 0, vectorizedCount: 6, disabledCount: 3, changes: [],
        });
    });

    test('planning does not mutate flags, keywords, content or metadata', () => {
        const data = mixedBook();
        data.entries[0].extensions = { foreign: 'kept' };
        const before = structuredClone(data);
        planWorldInfoVectorization(data);
        planWorldInfoVectorization(data, { includeConstants: true });
        expect(data).toEqual(before);
    });

    test('keeps storage keys separate from imported entry UIDs', () => {
        const data = { entries: { 7: { uid: 42 }, 12: { uid: 74, constant: true } } };
        expect(planWorldInfoVectorization(data, { includeConstants: true }).changes).toEqual([
            { key: '7', uid: 42 },
            { key: '12', uid: 74 },
        ]);
    });
});
