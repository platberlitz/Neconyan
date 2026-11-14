import { describe, expect, test } from '@jest/globals';
import { getChatPickerTitle, matchesChatPickerQuery, resolveChatPickerPlacement } from '../public/scripts/chat-picker-model.js';

describe('chat browser labels and filtering', () => {
    test.each([
        ['Kaveh & Alhaitham - Market debate.jsonl', 'Kaveh & Alhaitham', 'Market debate'],
        ['Nova - Branch #2 - Rain', 'Nova', 'Branch #2 - Rain'],
        ['Nova Star - Saved chat', 'Nova: Star', 'Saved chat'],
        ['Novabelle - Saved chat', 'Nova', 'Novabelle - Saved chat'],
        ['A renamed chat', 'Nova', 'A renamed chat'],
        ['Nova - ', 'Nova', 'Nova -'],
    ])('keeps the distinguishing part of %s', (file, owner, title) => {
        expect(getChatPickerTitle(file, owner)).toBe(title);
    });

    test('matches all words across the title, full name and preview', () => {
        const entry = { title: 'Quiet evening', fileName: 'Nova - Quiet evening', preview: 'A cup of tea' };
        expect(matchesChatPickerQuery(entry, 'NOVA tea')).toBe(true);
        expect(matchesChatPickerQuery(entry, '  ')).toBe(true);
        expect(matchesChatPickerQuery(entry, 'evening missing')).toBe(false);
    });
});

describe('chat browser viewport placement', () => {
    test.each([
        [{ top: 650, bottom: 684, left: 260 }, { top: 0, left: 0, width: 393, height: 852 }],
        [{ top: 650, bottom: 684, left: 260 }, { top: 60, left: 0, width: 393, height: 380 }],
        [{ top: 30, bottom: 64, left: 1200 }, { top: 0, left: 0, width: 1280, height: 900 }],
        [{ top: 200, bottom: 244, left: 0 }, { top: 0, left: 0, width: 320, height: 300 }],
    ])('fits the visible viewport, including a covered trigger', (anchor, viewport) => {
        const p = resolveChatPickerPlacement({ anchor, viewport });
        const top = p.above ? p.edgeTop - p.maxHeight : p.edgeTop;
        expect(top).toBeGreaterThanOrEqual(viewport.top + 8);
        expect(top + p.maxHeight).toBeLessThanOrEqual(viewport.top + viewport.height - 8);
        expect(p.left).toBeGreaterThanOrEqual(viewport.left + 8);
        expect(p.left + p.width).toBeLessThanOrEqual(viewport.left + viewport.width - 8);
    });

    test('opens a settings list below its trigger unless only the space above fits it', () => {
        const desktop = { top: 0, left: 0, width: 1280, height: 900 };
        const below = resolveChatPickerPlacement({ anchor: { top: 255, bottom: 301, left: 263 }, viewport: desktop, preferredHeight: 420, preferBelow: true });
        expect(below).toMatchObject({ above: false, edgeTop: 309, maxHeight: 420 });

        const phone = { top: 0, left: 0, width: 393, height: 852 };
        const nearBottom = resolveChatPickerPlacement({ anchor: { top: 700, bottom: 746, left: 18 }, viewport: phone, preferredHeight: 420, preferBelow: true });
        expect(nearBottom.above).toBe(true);
        expect(nearBottom.maxHeight).toBe(420);

        const keyboardOpen = { top: 0, left: 0, width: 393, height: 380 };
        const cramped = resolveChatPickerPlacement({ anchor: { top: 150, bottom: 196, left: 18 }, viewport: keyboardOpen, preferredHeight: 420, preferBelow: true });
        expect(cramped.above).toBe(false);
    });
});
