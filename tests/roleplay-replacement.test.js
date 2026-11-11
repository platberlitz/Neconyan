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

test('waiting for a replacement keeps the original row and disables its controls', () => {
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

function withReply() {
    const kept = [{ old: 1 }, { old: 2 }];
    const text = { childNodes: [...kept] };
    Object.defineProperty(text, 'firstChild', { get: () => text.childNodes[0] });
    text.replaceChildren = (...nodes) => { text.childNodes = nodes; };
    const timer = { hidden: false };
    const alreadyHidden = { hidden: true };
    const block = { children: [text] };
    block.insertBefore = (node, next) => block.children.splice(next ? block.children.indexOf(next) : block.children.length, 0, node);
    const footer = { parentNode: block };
    const notes = { parentNode: block, nextSibling: footer };
    notes.remove = () => { block.children = block.children.filter(child => child !== notes); };
    block.children.push(notes, footer);
    original.style = { minHeight: '' };
    original.querySelector = selector => selector === '.mes_text' ? text : block.children.find(child => child === notes) ?? null;
    original.querySelectorAll = selector => selector === '.ica--companion-ledger' ? block.children.filter(child => child === notes) : [timer, alreadyHidden];
    globalThis.document.createTextNode = value => ({ value });
    return { kept, text, timer, alreadyHidden, block, notes, footer };
}

test('a server swipe empties the old reply and its notes at once without reserving their height', () => {
    const { kept, text, timer, alreadyHidden, block, notes, footer } = withReply();
    const restore = beginRoleplayReplacement('roleplay.swipe', 1, () => true);
    expect(text.childNodes).toEqual([{ value: '...' }]);
    expect(timer.hidden).toBe(true);
    expect(block.children).toEqual([text, footer]);
    expect(original.style.minHeight).toBe('');
    restore();
    expect(text.childNodes).toEqual(kept);
    expect(timer.hidden).toBe(false);
    expect(alreadyHidden.hidden).toBe(true);
    expect(block.children).toEqual([text, notes, footer]);
});

test('restoring never adds a second set of notes after they were redrawn while waiting', () => {
    const { block, notes } = withReply();
    const restore = beginRoleplayReplacement('roleplay.swipe', 1, () => true);
    const redrawn = {};
    original.querySelector = selector => selector === '.ica--companion-ledger' ? redrawn : null;
    restore();
    expect(block.children).not.toContain(notes);
});

test('a refused regenerate puts the old reply back after the preview had replaced it', () => {
    const { kept, text } = withReply();
    const restore = beginRoleplayReplacement('roleplay.correct', 1, () => true);
    commitRoleplayReplacement(rows[0]);
    restore();
    expect(rows).toEqual([original]);
    expect(text.childNodes).toEqual(kept);
});

test('restoring never overwrites a message that was redrawn while waiting', () => {
    const { text } = withReply();
    const restore = beginRoleplayReplacement('roleplay.swipe', 1, () => true);
    const redrawn = [{ fresh: true }];
    text.childNodes = redrawn;
    restore();
    expect(text.childNodes).toBe(redrawn);
});
