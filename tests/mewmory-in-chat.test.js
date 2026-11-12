import { describe, expect, test } from '@jest/globals';
import { messageChips, putBackOnRecord, recallSummary, stampMessage, usedLabel, MEWMORY_RECALL_LIMIT } from '../public/scripts/mewmory/in-chat.js';

describe('Mewmory chat controls', () => {
    test('a reply keeps the memory ids it used and only counts original passages', () => {
        const summary = recallSummary({ retrieval: { selected: ['event:gift', 'source:chat:a:0', 'event:gift', 'commitment:return', 'source:chat:b:1', '', 7] } }, 5);
        expect(summary).toEqual({ at: 5, records: ['event:gift', 'commitment:return'], passages: 2 });
        expect(recallSummary(null)).toBeNull();
        expect(recallSummary({ retrieval: {} })).toBeNull();
        const many = recallSummary({ retrieval: { selected: Array.from({ length: 90 }, (_, index) => 'event:' + index) } });
        expect(many.records).toHaveLength(MEWMORY_RECALL_LIMIT);
    });

    test('stamping writes onto the message and its current swipe, and putting it back clears every swipe', () => {
        const message = { mes: 'Hi', extra: { reasoning: 'kept' }, swipe_id: 1, swipe_info: [{ extra: {} }, { extra: { token_count: 3 } }] };
        const summary = { at: 1, records: ['event:gift'], passages: 0 };
        expect(stampMessage(message, { summary, offRecord: true })).toBe(true);
        expect(message.extra).toEqual({ reasoning: 'kept', mewmoryRecall: summary, mewmoryExclude: true });
        expect(message.swipe_info[1].extra).toEqual({ token_count: 3, mewmoryRecall: summary, mewmoryExclude: true });
        expect(message.swipe_info[0].extra).toEqual({});
        message.swipe_info[0].extra.mewmoryExclude = true;
        expect(putBackOnRecord(message)).toBe(true);
        expect(message.extra.mewmoryExclude).toBeUndefined();
        expect(message.swipe_info.every(swipe => swipe.extra.mewmoryExclude === undefined)).toBe(true);
        expect(message.extra.mewmoryRecall).toEqual(summary);
        expect(putBackOnRecord(message)).toBe(false);
        expect(stampMessage({ mes: 'Hi' }, {})).toBe(false);
    });

    test('chips appear only when there is something to say, and never on hidden system notes', () => {
        expect(messageChips({ mes: 'Hi', extra: {} })).toBeNull();
        expect(messageChips({ extra: { mewmoryRecall: { records: ['a', 'b'], passages: 1 } } })).toEqual({ used: 2, passages: 1, offRecord: false });
        expect(messageChips({ extra: { mewmoryExclude: true } })).toEqual({ used: 0, passages: 0, offRecord: true });
        expect(messageChips({ is_system: true, extra: { mewmoryExclude: true } })).toBeNull();
        expect(messageChips({ is_system: true, extra: { mewmoryKeepHidden: true, mewmoryExclude: true } })).not.toBeNull();
        expect(usedLabel({ used: 1, passages: 0 })).toBe('Used 1 memory');
        expect(usedLabel({ used: 3, passages: 2 })).toBe('Used 3 memories');
        expect(usedLabel({ used: 0, passages: 1 })).toBe('Used 1 earlier passage');
        expect(usedLabel({ used: 0, passages: 4 })).toBe('Used 4 earlier passages');
    });
});
