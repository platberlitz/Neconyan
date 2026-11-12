import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const functions = ['canDeleteAddSwipe', 'isDeleteAddSwipeApplicable'].map(name =>
    source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0]).join('\n');

function actions({ allowed = true, swipes = true, swipeable = true, overswipe = 'regenerate' } = {}) {
    return new Function('isSwipingAllowed', 'swipes', 'isMessageSwipeable', 'getOverswipeBehavior', 'OVERSWIPE_BEHAVIOR',
        `${functions}\nreturn { visible: isDeleteAddSwipeApplicable, enabled: canDeleteAddSwipe };`)(
        () => allowed, swipes, () => swipeable, () => overswipe, { REGENERATE: 'regenerate' });
}

describe('Del + Reswipe availability', () => {
    const message = { swipes: ['first', 'second'], swipe_id: 1 };

    test('a busy run keeps the action visible but cannot execute it', () => {
        const busy = actions({ allowed: false });
        expect(busy.visible(1, message)).toBe(true);
        expect(busy.enabled(1, message)).toBe(false);
        expect(actions().enabled(1, message)).toBe(true);
    });

    test('a first swipe reserves the action without enabling deletion of the only saved reply', () => {
        const onlyReply = { swipes: ['first'], swipe_id: 0 };
        expect(actions().visible(1, onlyReply, true)).toBe(true);
        expect(actions().enabled(1, onlyReply)).toBe(false);
        expect(actions({ swipeable: false }).visible(1, onlyReply, true)).toBe(false);
    });

    test.each([
        { swipes: false }, { swipeable: false }, { overswipe: 'loop' },
    ])('inapplicable messages have no action: %j', settings => {
        expect(actions(settings).visible(1, message)).toBe(false);
        expect(actions(settings).enabled(1, message)).toBe(false);
    });

    test.each([undefined, {}, { swipes: ['only'], swipe_id: 0 },
        { ...message, swipe_id: -1 }, { ...message, swipe_id: 2 }, { ...message, swipe_id: 0.5 }])(
        'missing alternatives or an invalid selection cannot be deleted: %j', candidate => {
            // Explicit null avoids the renderer's default lookup in the chat array.
            expect(actions().visible(1, candidate ?? null)).toBe(false);
        });
});
