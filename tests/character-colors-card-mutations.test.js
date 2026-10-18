import { describe, expect, jest, test } from '@jest/globals';

import { mutationTouchesCharacterCards } from '../public/scripts/extensions/third-party/sillytavern-character-colors/src/card-mutations.js';

function matchesToken(element, token) {
    if (token.startsWith('#')) return element.id === token.slice(1);
    if (token.startsWith('.')) return element.classes.has(token.slice(1));
    if (token === '[data-roleplay-draft]') return element.draft === true;
    return false;
}

function createElement({ id = '', classes = [], children = [], parent = null, draft = false } = {}) {
    const element = {
        nodeType: 1,
        id,
        classes: new Set(classes),
        children,
        parentElement: parent,
        draft,
        querySelector: jest.fn(selector => {
            for (const child of element.children) {
                if (child.matches(selector)) return child;
                const nested = child.querySelector(selector);
                if (nested) return nested;
            }
            return null;
        }),
        matches(selector) {
            return selector.split(',').some(token => matchesToken(element, token.trim()));
        },
        closest(selector) {
            let current = element;
            while (current) {
                if (current.matches(selector)) return current;
                current = current.parentElement;
            }
            return null;
        },
    };
    Object.defineProperty(element, 'firstElementChild', { get: () => element.children[0] ?? null });
    for (const child of children) child.parentElement = element;
    return element;
}

function mutation(target, added = [], removed = [], type = 'childList') {
    return { type, target, addedNodes: added, removedNodes: removed };
}

describe('Character Colors card mutation detection', () => {
    test('detects inner group-member and avatar changes under group add members', () => {
        const container = createElement({ id: 'rm_group_add_members' });
        const groupMember = createElement({ classes: ['group_member'], parent: container });
        const name = createElement({ classes: ['group_member_name'], parent: groupMember });
        const avatar = createElement({ classes: ['avatar'], parent: container });

        expect(mutationTouchesCharacterCards([mutation(name, [createElement()])])).toBe(true);
        expect(mutationTouchesCharacterCards([mutation(avatar, [createElement()])])).toBe(true);
    });

    test('detects wrapper insertions that carry cards outside the chat', () => {
        const body = createElement();
        const movingDivs = createElement({ id: 'movingDivs', parent: body });
        const popout = createElement({
            id: 'groupMemberListPopout',
            parent: movingDivs,
            children: [createElement({ classes: ['group_member'] })],
        });
        const arbitraryWrapper = createElement({
            parent: body,
            children: [createElement({ classes: ['character_select'] })],
        });

        expect(mutationTouchesCharacterCards([mutation(movingDivs, [popout])])).toBe(true);
        expect(mutationTouchesCharacterCards([mutation(body, [arbitraryWrapper])])).toBe(true);
    });

    test('detects removed wrappers that held cards', () => {
        const body = createElement();
        const removed = createElement({
            parent: body,
            children: [createElement({ classes: ['character_select'] })],
        });
        expect(mutationTouchesCharacterCards([mutation(body, [], [removed])])).toBe(true);
    });

    test('ignores unrelated body work and chat message mutations without scans', () => {
        const body = createElement();
        const unrelated = createElement({ parent: body });
        expect(mutationTouchesCharacterCards([mutation(body, [unrelated])])).toBe(false);

        const chat = createElement({ id: 'chat', parent: body });
        const message = createElement({ classes: ['mes'], parent: chat });
        const messageBody = createElement({ classes: ['mes_text'], parent: message });
        expect(mutationTouchesCharacterCards([mutation(messageBody, [createElement()])])).toBe(false);
        expect(message.querySelector).not.toHaveBeenCalled();

        const unrelatedContainer = createElement({ parent: body, children: [createElement()] });
        expect(mutationTouchesCharacterCards([mutation(body, [{ nodeType: 3, parentElement: body }])])).toBe(false);
        expect(unrelatedContainer.querySelector).not.toHaveBeenCalled();
    });

    test('ignores attribute changes, drafts and unrelated chat subtrees', () => {
        const body = createElement();
        const draft = createElement({ classes: ['mes'], parent: body, draft: true });
        expect(mutationTouchesCharacterCards([mutation(draft, [createElement()])])).toBe(false);
        expect(mutationTouchesCharacterCards([mutation(body, [createElement()], [], 'attributes')])).toBe(false);
    });
});
