/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings[0] }));
const { StreamingThinkingIndicator } = await import('../public/scripts/streaming-thinking.js');

function message() {
    const parent = { children: [] };
    const details = {
        visible: false,
        checkVisibility() { return this.visible; },
        getClientRects() { return this.visible ? [{ width: 1 }] : []; },
    };
    const text = { parentElement: parent, before(element) {
        element.parentElement = parent;
        element.isConnected = true;
        parent.children.push(element);
    } };
    return { parent, details, querySelector: selector => selector === '.mes_text' ? text : details };
}

describe('stream-owned Thinking label', () => {
    beforeEach(() => {
        globalThis.document = { createElement: () => ({
            setAttribute: jest.fn(),
            remove() {
                this.parentElement.children = this.parentElement.children.filter(child => child !== this);
                this.isConnected = false;
            },
        }) };
    });

    test('announces the wait once, then removes it when output starts', () => {
        const node = message();
        const indicator = new StreamingThinkingIndicator();
        indicator.update(node, true);
        const label = node.parent.children[0];
        expect(label.textContent).toBe('Thinking...');
        expect(label.setAttribute).toHaveBeenCalledWith('role', 'status');
        indicator.update(node, true);
        expect(node.parent.children).toEqual([label]);
        indicator.update(node, false);
        expect(node.parent.children).toEqual([]);
    });

    test('defers to a visible reasoning header, including hidden-reasoning models', () => {
        const node = message();
        const indicator = new StreamingThinkingIndicator();
        indicator.update(node, true);
        node.details.checkVisibility = () => true;
        indicator.update(node, true);
        expect(node.parent.children).toEqual([]);
    });

    test('falls back to rendered boxes when checkVisibility is missing', () => {
        const node = message();
        delete node.details.checkVisibility;
        const indicator = new StreamingThinkingIndicator();
        indicator.update(node, true);
        expect(node.parent.children).toHaveLength(1);
        expect(node.parent.children[0].textContent).toBe('Thinking...');
        node.details.visible = true;
        indicator.update(node, true);
        expect(node.parent.children).toEqual([]);
    });

    test('old stream cleanup cannot erase a new stream label on the same message', () => {
        const node = message();
        const old = new StreamingThinkingIndicator();
        const current = new StreamingThinkingIndicator();
        old.update(node, true);
        current.update(node, true);
        const currentLabel = node.parent.children[1];
        old.clear();
        expect(node.parent.children).toEqual([currentLabel]);
    });

    test('moves to a replacement message element after the chat redraws', () => {
        const old = message();
        const next = message();
        const indicator = new StreamingThinkingIndicator();
        indicator.update(old, true);
        indicator.update(next, true);
        expect(old.parent.children).toEqual([]);
        expect(next.parent.children).toHaveLength(1);
        indicator.clear();
        expect(next.parent.children).toEqual([]);
    });
});
