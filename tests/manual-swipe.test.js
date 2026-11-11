import { describe, expect, test } from '@jest/globals';
import { appendManualSwipe, selectManualSwipe } from '../public/scripts/manual-swipe.js';

describe('hand-written reply versions', () => {
    test('starts a version list from the current text and adds the new one without showing it', () => {
        const message = { mes: 'First.', extra: { model: 'story' } };
        const index = appendManualSwipe(message, 'Second.', { sendDate: 'today', bias: ' bias' });
        expect(index).toBe(1);
        expect(message).toMatchObject({ mes: 'First.', swipe_id: 0, swipes: ['First.', 'Second.'], extra: { model: 'story' } });
        expect(message.swipe_info[1]).toMatchObject({ send_date: 'today', gen_started: null, gen_finished: null, extra: { bias: ' bias', api: 'manual', model: 'slash command' } });
    });

    test('repairs missing version details and shows the chosen version with its own details', () => {
        const message = { mes: 'B.', swipe_id: 1, swipes: ['A.', 'B.'], extra: { model: 'story' } };
        const index = appendManualSwipe(message, 'C.', { sendDate: 'today', model: 'Scratchpad' });
        expect(message.swipe_info).toHaveLength(3);
        selectManualSwipe(message, index);
        expect(message).toMatchObject({ mes: 'C.', swipe_id: 2, extra: { api: 'manual', model: 'Scratchpad' } });
        expect(message.extra).not.toBe(message.swipe_info[2].extra);
    });
});
