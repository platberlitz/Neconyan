import { describe, expect, test } from '@jest/globals';

import {
    captureVisibleMessageAnchor,
    restoreVisibleMessageAnchor,
    settleVisibleMessageAnchor,
} from '../public/scripts/chat-render-lifecycle/anchor.js';

class FakeMessageElement {
    constructor(messageId, rect, parts = {}, {
        hidden = false,
        attributes = null,
        inlineDisplayNone = false,
        classes = [],
        hasMesid = true,
    } = {}) {
        this.messageId = String(messageId);
        this.rect = rect;
        this.parts = parts;
        this.hidden = hidden;
        this.attributes = attributes;
        this.hasMesid = hasMesid;
        this.parentElement = null;
        this.rectReads = 0;
        this.style = inlineDisplayNone ? { display: 'none' } : undefined;
        this.classList = {
            contains: className => (hidden && className === 'displayNone') || classes.includes(className),
        };
    }

    getAttribute(attribute) {
        if (attribute === 'mesid' && !this.hasMesid) {
            return null;
        }

        return this.attributes?.[attribute] ?? (attribute === 'mesid' ? this.messageId : null);
    }

    hasAttribute(attribute) {
        if (attribute === 'mesid') {
            return this.hasMesid;
        }

        return Boolean(this.attributes && Object.hasOwn(this.attributes, attribute));
    }

    getBoundingClientRect() {
        this.rectReads += 1;
        return this.rect;
    }

    querySelector(selector) {
        return this.parts[selector] ?? null;
    }
}

class FakeScrollElement {
    constructor(messages, rect = { top: 0, bottom: 100 }, { selector = '.mes[mesid]', nativeSelection = true } = {}) {
        this.messages = messages;
        this.rect = rect;
        this.scrollTop = 0;
        this.selector = selector;
        this.nativeSelectionCalls = 0;
        this.querySelectorAllCalls = 0;

        if (!nativeSelection) {
            this.getElementsByClassName = undefined;
        }

        for (const message of messages) {
            message.parentElement = this;
        }
    }

    getBoundingClientRect() {
        return this.rect;
    }

    getElementsByClassName(className) {
        this.nativeSelectionCalls += 1;
        return className === 'mes' ? this.messages : [];
    }

    querySelectorAll(selector) {
        this.querySelectorAllCalls += 1;
        return selector === this.selector ? this.messages : [];
    }
}

function createUnrenderedRect() {
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
}

function countMessageRectReads(messages) {
    return messages.reduce((total, message) => total + message.rectReads, 0);
}

function buildOrderedMessages(count = 100, rowHeight = 80) {
    return Array.from({ length: count }, (_, index) => new FakeMessageElement(index, {
        top: index * rowHeight,
        bottom: (index + 1) * rowHeight,
    }));
}

describe('chat render lifecycle anchor helpers', () => {
    test('captures the first message intersecting the chat viewport', () => {
        const messages = [
            new FakeMessageElement(4, { top: -120, bottom: -20 }),
            new FakeMessageElement(5, { top: 24, bottom: 84 }),
            new FakeMessageElement(6, { top: 90, bottom: 160 }),
        ];

        expect(captureVisibleMessageAnchor(new FakeScrollElement(messages))).toEqual({
            messageId: '5',
            offsetTop: 24,
        });
    });

    test('restores the captured message to the same viewport offset', () => {
        const anchorMessage = new FakeMessageElement(5, { top: 24, bottom: 84 });
        const scrollElement = new FakeScrollElement([anchorMessage]);
        const anchor = captureVisibleMessageAnchor(scrollElement);

        anchorMessage.rect = { top: 96, bottom: 156 };
        restoreVisibleMessageAnchor(scrollElement, anchor);

        expect(scrollElement.scrollTop).toBe(72);
    });

    test('measures the requested part of the anchor row', () => {
        const text = { rect: { top: 140, bottom: 260 }, getBoundingClientRect() { return this.rect; } };
        const message = new FakeMessageElement(5, { top: 100, bottom: 300 }, { '.mes_text': text });
        const scrollElement = new FakeScrollElement([message]);
        const anchor = { messageId: '5', offsetTop: 140, part: '.mes_text' };

        message.rect = { top: 140, bottom: 340 };
        text.rect = { top: 180, bottom: 300 };
        expect(restoreVisibleMessageAnchor(scrollElement, anchor)).toBe(true);

        expect(scrollElement.scrollTop).toBe(40);
    });

    test('uses the fallback row when the anchored reply has not rendered', () => {
        const previous = new FakeMessageElement(4, { top: 60, bottom: 100 });
        const scrollElement = new FakeScrollElement([previous]);
        const anchor = { messageId: '5', offsetTop: 140, part: '.mes_text', fallback: { messageId: '4', offsetTop: 60 } };

        previous.rect = { top: 75, bottom: 115 };
        expect(restoreVisibleMessageAnchor(scrollElement, anchor)).toBe(true);

        expect(scrollElement.scrollTop).toBe(15);
    });

    test('falls back to the row when the requested part is missing', () => {
        const message = new FakeMessageElement(5, { top: 100, bottom: 300 });
        const scrollElement = new FakeScrollElement([message]);
        const anchor = { messageId: '5', offsetTop: 100, part: '.mes_text' };

        message.rect = { top: 125, bottom: 325 };
        restoreVisibleMessageAnchor(scrollElement, anchor);

        expect(scrollElement.scrollTop).toBe(25);
    });

    test('reports false when neither the anchor row nor its fallback exists', () => {
        const scrollElement = new FakeScrollElement([]);
        const anchor = { messageId: '5', offsetTop: 140, part: '.mes_text', fallback: { messageId: '4', offsetTop: 60 } };

        expect(restoreVisibleMessageAnchor(scrollElement, anchor)).toBe(false);
        expect(scrollElement.scrollTop).toBe(0);
    });

    test('preserves viewport-relative anchors during top, middle, and tail replacements', () => {
        const cases = [
            {
                messages: [
                    new FakeMessageElement(10, { top: 12, bottom: 68 }),
                    new FakeMessageElement(11, { top: 76, bottom: 132 }),
                    new FakeMessageElement(12, { top: 140, bottom: 196 }),
                ],
                mutate(messages) {
                    messages[0].rect = { top: 42, bottom: 118 };
                },
                expectedScrollTop: 30,
            },
            {
                messages: [
                    new FakeMessageElement(20, { top: -92, bottom: -24 }),
                    new FakeMessageElement(21, { top: 18, bottom: 82 }),
                    new FakeMessageElement(22, { top: 90, bottom: 160 }),
                ],
                mutate(messages) {
                    messages[1].rect = { top: -14, bottom: 106 };
                },
                expectedScrollTop: -32,
            },
            {
                messages: [
                    new FakeMessageElement(30, { top: -150, bottom: -80 }),
                    new FakeMessageElement(31, { top: -72, bottom: -8 }),
                    new FakeMessageElement(32, { top: 28, bottom: 94 }),
                ],
                mutate(messages) {
                    messages[2].rect = { top: 64, bottom: 156 };
                },
                expectedScrollTop: 36,
            },
        ];

        for (const { messages, mutate, expectedScrollTop } of cases) {
            const scrollElement = new FakeScrollElement(messages);
            const anchor = captureVisibleMessageAnchor(scrollElement);

            mutate(messages);
            restoreVisibleMessageAnchor(scrollElement, anchor);

            expect(scrollElement.scrollTop).toBe(expectedScrollTop);
        }
    });

    test('settles the anchor across multiple animation frames', async () => {
        const anchorMessage = new FakeMessageElement(5, { top: 10, bottom: 60 });
        const scrollElement = new FakeScrollElement([anchorMessage]);
        const anchor = captureVisibleMessageAnchor(scrollElement);
        const frameCallbacks = [];
        const settling = settleVisibleMessageAnchor(scrollElement, anchor, {
            frames: 2,
            requestAnimationFrameRef: callback => frameCallbacks.push(callback),
        });

        anchorMessage.rect = { top: 40, bottom: 90 };
        frameCallbacks.shift()();
        await Promise.resolve();
        expect(scrollElement.scrollTop).toBe(30);

        anchorMessage.rect = { top: 65, bottom: 115 };
        frameCallbacks.shift()();
        await settling;
        expect(scrollElement.scrollTop).toBe(85);
    });

    test('ignores missing scroll elements and anchors', () => {
        expect(captureVisibleMessageAnchor(null)).toBeNull();

        const scrollElement = new FakeScrollElement([]);
        restoreVisibleMessageAnchor(scrollElement, null);

        expect(scrollElement.scrollTop).toBe(0);
    });

    test('an outdated anchor cannot undo a newer scroll position', async () => {
        const message = new FakeMessageElement(5, { top: 10, bottom: 60 });
        const element = new FakeScrollElement([message]);
        const anchor = captureVisibleMessageAnchor(element);
        const frames = [];
        let current = true;
        const settling = settleVisibleMessageAnchor(element, anchor, {
            frames: 2,
            requestAnimationFrameRef: callback => frames.push(callback),
            isCurrent: () => current,
        });

        message.rect = { top: 40, bottom: 90 };
        frames.shift()();
        await Promise.resolve();
        expect(element.scrollTop).toBe(30);

        current = false;
        element.scrollTop = 800;
        frames.shift()();
        await settling;
        expect(element.scrollTop).toBe(800);
    });

    test('captures a long ordered chat without measuring every row', () => {
        const rowHeight = 80;
        const messages = buildOrderedMessages(100, rowHeight);
        const scrollElement = new FakeScrollElement(messages, {
            top: 0, bottom: 600, left: 0, right: 1000, width: 1000, height: 600,
        });

        for (const fraction of [0.15, 0.5, 0.9]) {
            const scrollTop = (messages.length * rowHeight - scrollElement.rect.bottom) * fraction;
            messages.forEach((message, index) => {
                message.rect = {
                    top: index * rowHeight - scrollTop,
                    bottom: (index + 1) * rowHeight - scrollTop,
                };
                message.rectReads = 0;
            });

            const anchor = captureVisibleMessageAnchor(scrollElement);
            const firstVisibleIndex = Math.floor(scrollTop / rowHeight);

            expect(anchor.messageId).toBe(String(firstVisibleIndex));
            expect(anchor.offsetTop).toBeCloseTo(firstVisibleIndex * rowHeight - scrollTop, 6);
            expect(countMessageRectReads(messages)).toBeLessThan(10);
        }
    });

    test('uses the native class lookup for the default selector without losing mesid filtering', () => {
        const messages = buildOrderedMessages(30, 60);
        messages.forEach((message, index) => {
            message.rect = { top: 60 + index * 60, bottom: 120 + index * 60 };
        });
        const withoutMesid = new FakeMessageElement('draft', { top: 0, bottom: 60 }, {}, { hasMesid: false });
        messages.unshift(withoutMesid);
        const scrollElement = new FakeScrollElement(messages, {
            top: 0, bottom: 400, left: 0, right: 1000, width: 1000, height: 400,
        });

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({ messageId: '0', offsetTop: 60 });
        expect(scrollElement.nativeSelectionCalls).toBeGreaterThan(0);
        expect(scrollElement.querySelectorAllCalls).toBe(0);
    });

    test('falls back to the selector when the native class lookup is unavailable', () => {
        const messages = buildOrderedMessages(30, 60);
        const scrollElement = new FakeScrollElement(messages, {
            top: 0, bottom: 400, left: 0, right: 1000, width: 1000, height: 400,
        }, { nativeSelection: false });

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({ messageId: '0', offsetTop: 0 });
        expect(scrollElement.querySelectorAllCalls).toBeGreaterThan(0);
    });

    test('falls back to the selector when a candidate lacks attribute lookup', () => {
        const messages = buildOrderedMessages(30, 60);
        messages[0].hasAttribute = undefined;
        const scrollElement = new FakeScrollElement(messages, {
            top: 0, bottom: 400, left: 0, right: 1000, width: 1000, height: 400,
        });

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({ messageId: '0', offsetTop: 0 });
        expect(scrollElement.nativeSelectionCalls).toBeGreaterThan(0);
        expect(scrollElement.querySelectorAllCalls).toBeGreaterThan(0);
    });

    test('falls back to the exact scan when a row cannot be measured', () => {
        const rowHeight = 80;
        const messages = buildOrderedMessages(100, rowHeight);
        const scrollTop = 1110;
        messages.forEach((message, index) => {
            message.rect = {
                top: index * rowHeight - scrollTop,
                bottom: (index + 1) * rowHeight - scrollTop,
            };
        });
        messages[0].getBoundingClientRect = null;
        const scrollElement = new FakeScrollElement(messages, {
            top: 0, bottom: 600, left: 0, right: 1000, width: 1000, height: 600,
        });

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({ messageId: '13', offsetTop: -70 });
    });

    test('re-reads geometry on every capture instead of reusing an earlier anchor', () => {
        const messages = buildOrderedMessages(30, 60);
        const scrollElement = new FakeScrollElement(messages, {
            top: 0, bottom: 300, left: 0, right: 1000, width: 1000, height: 300,
        });

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({ messageId: '0', offsetTop: 0 });

        messages[0].rect = { top: -120, bottom: -60 };
        messages[1].rect = { top: -60, bottom: 0 };
        messages[2].rect = { top: 0, bottom: 60 };

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({ messageId: '2', offsetTop: 0 });
    });

    test('skips display-none rows while searching for the first visible row', () => {
        const messages = buildOrderedMessages(30, 60);
        messages.forEach((message, index) => {
            message.rect = { top: (index - 1) * 60, bottom: index * 60 };
        });
        const hidden = new FakeMessageElement('hidden', { top: 0, bottom: 0 }, {}, { hidden: true });
        messages.splice(1, 0, hidden);
        const scrollElement = new FakeScrollElement(messages, {
            top: 0, bottom: 600, left: 0, right: 1000, width: 1000, height: 600,
        });

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({ messageId: '1', offsetTop: 0 });
        expect(hidden.rectReads).toBe(0);
    });

    test.each([24, 44])('ignores inline and CSS-hidden rows inside a %ipx inter-message gap', gap => {
        const rowHeight = 60;
        const messages = Array.from({ length: 30 }, (_, index) => new FakeMessageElement(index, {
            top: index * (rowHeight + gap),
            bottom: index * (rowHeight + gap) + rowHeight,
        }));
        const inlineHidden = new FakeMessageElement('hidden-inline', createUnrenderedRect(), {}, {
            inlineDisplayNone: true,
        });
        const cssHidden = new FakeMessageElement('hidden-css', createUnrenderedRect(), {}, {
            classes: ['custom-hidden'],
        });

        // Both hidden rows sit in the gap after rendered row 9.
        messages.splice(10, 0, inlineHidden, cssHidden);
        const gapStart = 9 * (rowHeight + gap) + rowHeight;
        const scrollTop = gapStart + gap / 2;
        const scrollElement = new FakeScrollElement(messages, {
            top: scrollTop,
            bottom: scrollTop + 400,
            left: 0,
            right: 1000,
            width: 1000,
            height: 400,
        });

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({
            messageId: '10',
            offsetTop: gap / 2,
        });
        expect(inlineHidden.rectReads).toBe(0);
        expect(cssHidden.rectReads).toBeGreaterThan(0);
        expect(countMessageRectReads(messages)).toBeLessThan(8);
    });

    test.each([24, 44])('keeps the first visible row above hidden rows when the top %ipx is margin', topMargin => {
        const rowHeight = 60;
        // The old 25% hit point landed on the second row, 144px below the real
        // first visible row, after treating the hidden rows as above the viewport.
        const wrongAnchorDistance = 144;
        const first = new FakeMessageElement('first', {
            top: topMargin,
            bottom: topMargin + rowHeight,
        });
        const second = new FakeMessageElement('second', {
            top: topMargin + wrongAnchorDistance,
            bottom: topMargin + wrongAnchorDistance + rowHeight,
        });
        const messages = [
            first,
            new FakeMessageElement('hidden-inline', createUnrenderedRect(), {}, { inlineDisplayNone: true }),
            new FakeMessageElement('hidden-css', createUnrenderedRect(), {}, { classes: ['custom-hidden'] }),
            second,
        ];
        for (let index = 2; index < 30; index++) {
            messages.push(new FakeMessageElement(index, {
                top: second.rect.top + (index - 1) * 80,
                bottom: second.rect.top + (index - 1) * 80 + rowHeight,
            }));
        }
        const scrollElement = new FakeScrollElement(messages, {
            top: 0, bottom: 800, left: 0, right: 1000, width: 1000, height: 800,
        });

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({
            messageId: 'first',
            offsetTop: topMargin,
        });
        expect(countMessageRectReads(messages)).toBeLessThan(10);
    });

    test('matches the exact scan across scroll positions with hidden rows between messages', () => {
        const rowHeight = 60;
        const gap = 24;
        const viewportHeight = 400;
        const rendered = Array.from({ length: 120 }, (_, index) => new FakeMessageElement(index, {
            top: index * (rowHeight + gap),
            bottom: index * (rowHeight + gap) + rowHeight,
        }));
        const messages = [...rendered];
        messages.splice(8, 0,
            new FakeMessageElement('inline-8', createUnrenderedRect(), {}, { inlineDisplayNone: true }),
            new FakeMessageElement('css-9', createUnrenderedRect(), {}, { classes: ['custom-hidden'] }));
        messages.splice(35, 0,
            new FakeMessageElement('hidden-35', createUnrenderedRect(), {}, { hidden: true }));
        messages.splice(70, 0,
            new FakeMessageElement('css-70', createUnrenderedRect(), {}, { classes: ['custom-hidden'] }),
            new FakeMessageElement('inline-71', createUnrenderedRect(), {}, { inlineDisplayNone: true }));
        const scrollElement = new FakeScrollElement(messages, {
            top: 0, bottom: viewportHeight, left: 0, right: 1000, width: 1000, height: viewportHeight,
        });
        const maxScroll = rendered.at(-1).rect.bottom - viewportHeight;

        for (let step = 0; step <= 20; step++) {
            const scrollTop = (maxScroll * step) / 20;
            rendered.forEach((message, index) => {
                message.rect = {
                    top: index * (rowHeight + gap) - scrollTop,
                    bottom: index * (rowHeight + gap) + rowHeight - scrollTop,
                };
            });

            let expected = null;
            let expectedRect = null;
            for (const message of messages) {
                const rect = message.getBoundingClientRect();
                if (rect.bottom > 0 && rect.top < viewportHeight) {
                    expected = message;
                    expectedRect = rect;
                    break;
                }
            }
            messages.forEach(message => {
                message.rectReads = 0;
            });
            scrollElement.rect = {
                top: 0,
                bottom: viewportHeight,
                left: 0,
                right: 1000,
                width: 1000,
                height: viewportHeight,
            };

            const actual = captureVisibleMessageAnchor(scrollElement);

            expect(expected).not.toBeNull();
            expect(actual).not.toBeNull();
            expect(actual.messageId).toBe(expected.getAttribute('mesid'));
            expect(actual.offsetTop).toBeCloseTo(expectedRect.top, 6);
            expect(countMessageRectReads(messages)).toBeLessThan(20);
        }
    });

    test('keeps an earlier row that overlaps into the viewport above the search candidate', () => {
        const messages = buildOrderedMessages(30, 60);
        messages[0].rect = { top: 0, bottom: 300 };
        messages[1].rect = { top: 40, bottom: 100 };
        const scrollElement = new FakeScrollElement(messages, {
            top: 120, bottom: 720, left: 0, right: 1000, width: 1000, height: 600,
        });

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({ messageId: '0', offsetTop: -120 });
    });

    test('keeps a zero-height row inside the viewport as the anchor', () => {
        const messages = buildOrderedMessages(30, 60);
        messages[0].rect = { top: -60, bottom: 0 };
        messages[1].rect = { top: 20, bottom: 20 };
        const scrollElement = new FakeScrollElement(messages, {
            top: 0, bottom: 600, left: 0, right: 1000, width: 1000, height: 600,
        });

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({ messageId: '1', offsetTop: 20 });
    });

    test('keeps hidden-row semantics when the chat starts above the window', () => {
        const messages = Array.from({ length: 30 }, (_, index) => new FakeMessageElement(index, {
            top: 40 + index * 60,
            bottom: 100 + index * 60,
        }));
        const hidden = new FakeMessageElement('hidden', { top: 0, bottom: 0 }, {}, { hidden: true });
        messages.unshift(hidden);
        const scrollElement = new FakeScrollElement(messages, {
            top: -20, bottom: 580, left: 0, right: 1000, width: 1000, height: 600,
        });

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({ messageId: 'hidden', offsetTop: 20 });
    });

    test('keeps an earlier visible row ahead of a hidden zero rectangle above a negative viewport top', () => {
        const messages = buildOrderedMessages(30, 60);
        messages.forEach((message, index) => {
            message.rect = { top: index * 60 - 40, bottom: (index + 1) * 60 - 40 };
        });
        const hidden = new FakeMessageElement('hidden', createUnrenderedRect(), {}, { hidden: true });
        messages.splice(1, 0, hidden);
        const scrollElement = new FakeScrollElement(messages, {
            top: -20, bottom: 380, left: 0, right: 1000, width: 1000, height: 400,
        });

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({ messageId: '0', offsetTop: -20 });
    });

    test('keeps custom selectors and key attributes working', () => {
        const rows = [
            new FakeMessageElement('a', { top: -80, bottom: -10 }, {}, { attributes: { 'data-agent-id': 'agent-a' } }),
            new FakeMessageElement('b', { top: 20, bottom: 80 }, {}, { attributes: { 'data-agent-id': 'agent-b' } }),
            new FakeMessageElement('c', { top: 90, bottom: 150 }, {}, { attributes: { 'data-agent-id': 'agent-c' } }),
        ];
        const scrollElement = new FakeScrollElement(rows, { top: 0, bottom: 100 }, {
            selector: '.agent-row[data-agent-id]',
        });

        expect(captureVisibleMessageAnchor(scrollElement, {
            messageSelector: '.agent-row[data-agent-id]',
            keyAttribute: 'data-agent-id',
        })).toEqual({ messageId: 'agent-b', offsetTop: 20 });
    });

    test('measures nested rows through the exact scan', () => {
        const messages = buildOrderedMessages(30, 60);
        messages.forEach((message, index) => {
            message.rect = { top: (index - 1) * 60, bottom: index * 60 };
        });
        const scrollElement = new FakeScrollElement(messages, {
            top: 0, bottom: 600, left: 0, right: 1000, width: 1000, height: 600,
        });
        messages[1].parentElement = messages[0];

        expect(captureVisibleMessageAnchor(scrollElement)).toEqual({ messageId: '1', offsetTop: 0 });
    });
});
