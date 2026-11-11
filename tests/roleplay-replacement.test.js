/* global globalThis */
import { afterEach, beforeEach, expect, test } from '@jest/globals';
import {
    beginRoleplayReplacement,
    commitRoleplayReplacement,
    holdRoleplayReplacementReserve,
    releaseRoleplayReplacementReserve,
    syncRoleplayReplacementReserve,
    transferRoleplayReplacementReserve,
} from '../public/scripts/neconyan-conversation/roleplay-replacement.js';

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

function createScrollableChat({ historyHeight = 5000, oldHeight = 2500, previewNaturalHeight = 130, clientHeight = 700, scrollTop = 6800 }) {
    const listeners = new Set();
    const chat = {
        clientHeight,
        scrollTop,
        get scrollHeight() {
            const active = rows.find(row => row === original || row.id === 'preview' || row.id === 'saved');
            const tailHeight = active === original ? oldHeight : active?.renderedHeight ?? 0;
            return historyHeight + tailHeight;
        },
        getBoundingClientRect: () => ({ top: 100 }),
        addEventListener: (type, handler) => { if (type === 'scroll') listeners.add(handler); },
        removeEventListener: (type, handler) => { if (type === 'scroll') listeners.delete(handler); },
        emitScroll: () => { for (const handler of [...listeners]) handler(); },
        querySelector: selector => selector === '[data-roleplay-replacement]'
            ? rows.find(row => row.dataset.roleplayReplacement !== undefined)
            : rows.find(row => row === original),
    };
    const makeRow = (id, naturalHeight) => {
        const node = element();
        node.id = id;
        node.style = { minHeight: '', flexShrink: '' };
        Object.defineProperty(node, 'parentElement', { get: () => connected(node) ? chat : null });
        Object.defineProperty(node, 'nextElementSibling', {
            get: () => connected(node) ? rows[rows.indexOf(node) + 1] ?? null : null,
        });
        Object.defineProperty(node, 'renderedHeight', {
            get: () => Math.max(naturalHeight, Number.parseFloat(node.style.minHeight) || 0),
        });
        node.getBoundingClientRect = () => ({
            top: 100 + historyHeight - chat.scrollTop,
            height: node.renderedHeight,
        });
        return node;
    };
    withReply();
    original.getBoundingClientRect = () => ({
        top: 100 + historyHeight - chat.scrollTop,
        height: oldHeight,
    });
    globalThis.document.querySelector = () => chat;
    const preview = makeRow('preview', previewNaturalHeight);
    return { chat, preview, makeRow, listeners };
}

test('swapping a long reply places the preview at the top of the viewport with only the needed reserve', () => {
    const { chat, preview } = createScrollableChat({ historyHeight: 5000, oldHeight: 2500, clientHeight: 700, scrollTop: 6800 });
    const restore = beginRoleplayReplacement('roleplay.swipe', 1, () => true);
    const marker = rows[0];
    commitRoleplayReplacement(marker, preview, chat);

    expect(chat.scrollTop).toBe(5000);
    expect(preview.getBoundingClientRect().top - chat.getBoundingClientRect().top).toBe(0);
    expect(preview.style.minHeight).toBe('700px');
    expect(chat.scrollHeight - chat.scrollTop - chat.clientHeight).toBe(0);
    expect(preview.style.flexShrink).toBe('0');

    releaseRoleplayReplacementReserve(preview);
    preview.remove();
    restore();
    expect(rows).toEqual([original]);
});

test('swapping a short reply whose top is visible keeps the row top in place', () => {
    const { chat, preview } = createScrollableChat({ historyHeight: 5000, oldHeight: 240, clientHeight: 700, scrollTop: 4540 });
    beginRoleplayReplacement('roleplay.swipe', 1, () => true);
    commitRoleplayReplacement(rows[0], preview, chat);

    expect(chat.scrollTop).toBe(4540);
    expect(preview.getBoundingClientRect().top - chat.getBoundingClientRect().top).toBe(460);
    expect(preview.style.minHeight).toBe('240px');
    expect(chat.scrollHeight - chat.scrollTop - chat.clientHeight).toBe(0);
    releaseRoleplayReplacementReserve(preview);
});

test('transferring the reserve to the saved row shrinks on scroll and clears at natural height', () => {
    const { chat, preview, makeRow, listeners } = createScrollableChat({ historyHeight: 5000, oldHeight: 2500, clientHeight: 700, scrollTop: 6800 });
    beginRoleplayReplacement('roleplay.swipe', 1, () => true);
    commitRoleplayReplacement(rows[0], preview, chat);

    let holdReleased = 0;
    const saved = makeRow('saved', 280);
    rows = [saved];
    expect(transferRoleplayReplacementReserve(preview, saved, chat, { onUserScroll: () => { holdReleased += 1; } })).toBe(true);
    expect(preview.style.minHeight).toBe('');
    expect(saved.style.minHeight).toBe('700px');
    syncRoleplayReplacementReserve(saved);
    expect(saved.style.minHeight).toBe('700px');

    chat.scrollTop = 4800;
    chat.emitScroll();
    expect(holdReleased).toBe(1);
    expect(saved.style.minHeight).toBe('500px');
    expect(chat.scrollHeight - chat.scrollTop - chat.clientHeight).toBe(0);

    // Scrolling past natural height (500 - 250 = 250 < 280) removes the style and listener.
    chat.scrollTop = 4550;
    chat.emitScroll();
    expect(saved.style.minHeight).toBe('');
    expect(saved.style.flexShrink).toBe('');
    expect(listeners.size).toBe(0);
});

test('appending a newer message after a reserved row drops the reserve at once', () => {
    const { chat, makeRow, listeners } = createScrollableChat({ historyHeight: 5000, oldHeight: 2500, clientHeight: 700, scrollTop: 5000 });
    const saved = makeRow('saved', 260);
    rows = [saved];
    holdRoleplayReplacementReserve(saved, chat, 700);
    expect(saved.style.minHeight).toBe('700px');

    const newer = makeRow('next', 120);
    newer.classList = { contains: name => name === 'mes' };
    rows.push(newer);
    chat.emitScroll();
    expect(saved.style.minHeight).toBe('');
    expect(listeners.size).toBe(0);
});
