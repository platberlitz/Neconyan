/* global globalThis */
import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { beginRoleplayReplacement, commitRoleplayReplacement } from '../public/scripts/neconyan-conversation/roleplay-replacement.js';

let rows;
let original;
const connected = element => rows.includes(element);
function element() {
    const node = { dataset: {}, inert: false };
    Object.defineProperty(node, 'isConnected', { get: () => connected(node) });
    node.before = other => rows.splice(rows.indexOf(node), 0, other);
    node.remove = () => { rows = rows.filter(row => row !== node); };
    node.replaceWith = other => { rows.splice(rows.indexOf(node), 1, other); };
    return node;
}

beforeEach(() => {
    original = element();
    rows = [original];
    const chat = { querySelector: selector => selector === '[data-roleplay-replacement]'
        ? rows.find(row => row.dataset.roleplayReplacement !== undefined)
        : rows.find(row => row === original) };
    globalThis.document = { querySelector: () => chat, createElement: element };
});
afterEach(() => { delete globalThis.document; });

test('waiting for a replacement keeps the original height and disables its controls', () => {
    const restore = beginRoleplayReplacement('roleplay.swipe', 1, () => true);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe(original);
    expect(rows[0].hidden).toBe(true);
    expect(original.inert).toBe(true);
    restore();
    expect(rows).toEqual([original]);
    expect(original.inert).toBe(false);
});

test('the prepared preview commits the replacement once and cancellation restores it', () => {
    const restore = beginRoleplayReplacement('roleplay.swipe', 1, () => true);
    const marker = rows[0];
    commitRoleplayReplacement(marker);
    commitRoleplayReplacement(marker);
    expect(rows).toEqual([marker]);
    restore();
    restore();
    expect(rows).toEqual([original]);
    expect(original.inert).toBe(false);
});

test('cancellation retains the original disabled state', () => {
    original.inert = true;
    const restore = beginRoleplayReplacement('guided.regenerate', 1, () => true);
    commitRoleplayReplacement(rows[0]);
    restore();
    expect(original.inert).toBe(true);
});

test.each([false, true])('leaving the chat does not restore an old reply, committed: %s', committed => {
    let current = true;
    const restore = beginRoleplayReplacement('roleplay.swipe', 1, () => current);
    if (committed) commitRoleplayReplacement(rows[0]);
    current = false;
    restore();
    expect(rows).toEqual([]);
});

test('saved readback owns the chat once it removes the marker', () => {
    const restore = beginRoleplayReplacement('roleplay.swipe', 1, () => true);
    commitRoleplayReplacement(rows[0]);
    rows = [element()];
    const saved = rows[0];
    restore();
    expect(rows).toEqual([saved]);
});

test('ordinary sends never reserve an existing reply', () => {
    beginRoleplayReplacement('roleplay.send', 1, () => true)();
    expect(rows).toEqual([original]);
    expect(original.inert).toBe(false);
});
