import { describe, expect, test } from '@jest/globals';

import {
    captureVisibleMessageAnchor,
    restoreVisibleMessageAnchor,
    settleVisibleMessageAnchor,
} from '../public/scripts/chat-render-lifecycle/anchor.js';

class FakeMessageElement {
    constructor(messageId, rect, parts = {}) {
        this.messageId = String(messageId);
        this.rect = rect;
        this.parts = parts;
    }

    getAttribute(attribute) {
        return attribute === 'mesid' ? this.messageId : null;
    }

    getBoundingClientRect() {
        return this.rect;
    }

    querySelector(selector) {
        return this.parts[selector] ?? null;
    }
}

class FakeScrollElement {
    constructor(messages, rect = { top: 0, bottom: 100 }) {
        this.messages = messages;
        this.rect = rect;
        this.scrollTop = 0;
    }

    getBoundingClientRect() {
        return this.rect;
    }

    querySelectorAll(selector) {
        return selector === '.mes[mesid]' ? this.messages : [];
    }
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
});
