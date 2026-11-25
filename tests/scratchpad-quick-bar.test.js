import { describe, expect, test } from '@jest/globals';
import { createQuickBarState, quickBarExpanded, toggleQuickBar, wheelScrollDelta } from '../public/scripts/scratchpad/quick-bar.js';

describe('Scratchpad quick prompts bar', () => {
    test('an empty session shows the row and a session with messages folds it', () => {
        const state = createQuickBarState();
        expect(quickBarExpanded(state, 'empty', 0)).toBe(true);
        expect(quickBarExpanded(state, 'busy', 1)).toBe(false);
        expect(quickBarExpanded(state, 'busy', 12)).toBe(false);
        expect(quickBarExpanded(state, '', 0)).toBe(true);
    });

    test('the row folds once the first message arrives', () => {
        const state = createQuickBarState();
        expect(quickBarExpanded(state, 'a', 0)).toBe(true);
        expect(quickBarExpanded(state, 'a', 2)).toBe(false);
    });

    test('a click opens and closes the row for that session only', () => {
        const state = createQuickBarState();
        expect(toggleQuickBar(state, 'busy', 4)).toBe(true);
        expect(quickBarExpanded(state, 'busy', 4)).toBe(true);
        expect(quickBarExpanded(state, 'other', 4)).toBe(false);
        expect(toggleQuickBar(state, 'busy', 4)).toBe(false);
        expect(quickBarExpanded(state, 'busy', 4)).toBe(false);

        expect(toggleQuickBar(state, 'empty', 0)).toBe(false);
        expect(quickBarExpanded(state, 'empty', 0)).toBe(false);
        expect(quickBarExpanded(state, 'fresh', 0)).toBe(true);
    });

    test('switching sessions follows each session\'s own rule unless it was toggled', () => {
        const state = createQuickBarState();
        toggleQuickBar(state, 'busy', 3);
        expect(quickBarExpanded(state, 'empty', 0)).toBe(true);
        expect(quickBarExpanded(state, 'second', 5)).toBe(false);
        expect(quickBarExpanded(state, 'busy', 3)).toBe(true);
    });

    test('only the most recent toggles are remembered', () => {
        const state = createQuickBarState();
        for (let index = 0; index < 60; index++) toggleQuickBar(state, `s${index}`, 1);
        expect(state.overrides.size).toBe(50);
        expect(quickBarExpanded(state, 's0', 1)).toBe(false);
        expect(quickBarExpanded(state, 's59', 1)).toBe(true);
    });
});

describe('Scratchpad quick prompts wheel scrolling', () => {
    const rail = { scrollLeft: 100, scrollWidth: 1000, clientWidth: 400 };

    test('turns a vertical wheel into a sideways scroll', () => {
        expect(wheelScrollDelta({ deltaY: 120 }, rail)).toBe(120);
        expect(wheelScrollDelta({ deltaY: -53 }, rail)).toBe(-53);
    });

    test('converts line and page wheel steps to pixels', () => {
        expect(wheelScrollDelta({ deltaY: 3, deltaMode: 1 }, rail)).toBe(48);
        expect(wheelScrollDelta({ deltaY: -1, deltaMode: 2 }, rail)).toBe(-400);
    });

    test('leaves sideways, zoom and shift scrolls to the browser', () => {
        expect(wheelScrollDelta({ deltaX: 40, deltaY: 10 }, rail)).toBe(0);
        expect(wheelScrollDelta({ deltaX: 30, deltaY: 30 }, rail)).toBe(0);
        expect(wheelScrollDelta({ deltaY: 100, ctrlKey: true }, rail)).toBe(0);
        expect(wheelScrollDelta({ deltaY: 100, shiftKey: true }, rail)).toBe(0);
        expect(wheelScrollDelta({ deltaY: 0 }, rail)).toBe(0);
    });

    test('lets the page scroll when the row fits or is already at that end', () => {
        expect(wheelScrollDelta({ deltaY: 100 }, { scrollLeft: 0, scrollWidth: 400, clientWidth: 400 })).toBe(0);
        expect(wheelScrollDelta({ deltaY: -100 }, { ...rail, scrollLeft: 0 })).toBe(0);
        expect(wheelScrollDelta({ deltaY: 100 }, { ...rail, scrollLeft: 600 })).toBe(0);
        expect(wheelScrollDelta({ deltaY: 100 }, { ...rail, scrollLeft: 599.5 })).toBe(0);
        expect(wheelScrollDelta({ deltaY: -100 }, { ...rail, scrollLeft: 600 })).toBe(-100);
        expect(wheelScrollDelta({ deltaY: 100 }, { ...rail, scrollLeft: 0 })).toBe(100);
    });
});
