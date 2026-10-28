import { messageHistoryPlan } from '../public/scripts/mewmory/history-policy.js';

describe('message-based recent history', () => {
    test.each([[0, 0], [9, 0], [10, 0], [14, 0], [15, 5], [16, 5], [19, 5], [20, 10]])(
        'with %i messages removes %i fully preserved messages', (count, removed) => {
            const indices = Array.from({ length: count }, (_, index) => index);
            expect(messageHistoryPlan(indices, 10, 5, () => true).excluded).toEqual(indices.slice(0, removed));
        },
    );

    test('leaves a whole unpreserved group and every later group in context', () => {
        const indices = Array.from({ length: 20 }, (_, index) => index);
        expect(messageHistoryPlan(indices, 10, 5, index => index !== 7)).toEqual({
            excluded: indices.slice(0, 5), target: 10, waitingForPreservation: true,
        });
        expect(messageHistoryPlan(indices, 10, 5, index => index !== 2).excluded).toEqual([]);
    });
});
