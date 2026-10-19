import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, jest, test } from '@jest/globals';
import { isEchoMessage, resolveEchoSurface, clearEchoMessage } from '../public/scripts/echo-message-layout.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const read = relativePath => readFileSync(path.join(repoRoot, relativePath), 'utf8');

const rect = (top, bottom) => ({ left: 20, right: 620, top, bottom, toJSON() { return { left: this.left, right: this.right, top: this.top, bottom: this.bottom }; } });
describe('Echo user header width', () => {
    test('stacks the user header in a column so it shrink-wraps like the assistant header', () => {
        const css = read('public/css/neconyan.css');
        // Desktop only: the 769-1000px card and the phone share the same header rules as before.
        const desktop = css.slice(css.indexOf('@media (min-width: 1001px)', css.indexOf('body.neconyan.echostyle')));
        expect(desktop).toContain('body.neconyan.echostyle:not(.sbterm) #chat .mes.nn-echo-layout[is_user=\'true\'] .ch_name { flex-direction: column; align-items: flex-end; }');
        // The rule stays on the user row: the assistant header is untouched.
        expect(desktop).not.toContain('.mes.nn-echo-layout .ch_name { flex-direction: column');
        expect(desktop).not.toContain('.mes.nn-echo-layout[is_user=\'true\'] .ch_name .mes_buttons');
        // The core button width is what the column shrink-wraps around.
        expect(css).toMatch(/body\.neconyan #chat \.mes_buttons \{\n {4}width: 100%;/);
    });
});
describe('Echo native surface contract', () => {
    test('enrols only actual desktop/tablet Roleplay, never notices or other shell modes', () => {
        const row = { matches: jest.fn(() => true) };
        const shell = { dataset: {} }, body = { matches: () => true, dataset: { neconyanChatMode: 'roleplay' } };
        const documentRef = { body, getElementById: () => shell }, windowRef = { innerWidth: 769 };
        expect(isEchoMessage(row, windowRef, documentRef)).toBe(true);
        windowRef.innerWidth = 768; expect(isEchoMessage(row, windowRef, documentRef)).toBe(false);
        windowRef.innerWidth = 1280; shell.dataset.sbConversationMode = 'on'; expect(isEchoMessage(row, windowRef, documentRef)).toBe(false);
        shell.dataset.sbConversationMode = 'off'; shell.dataset.sbtwMode = 'on'; expect(isEchoMessage(row, windowRef, documentRef)).toBe(false);
        shell.dataset.sbtwMode = 'off'; body.dataset.neconyanChatMode = 'story'; expect(isEchoMessage(row, windowRef, documentRef)).toBe(false);
        body.dataset.neconyanChatMode = 'roleplay'; row.matches.mockReturnValue(false); expect(isEchoMessage(row, windowRef, documentRef)).toBe(false);
    });
    test('text and adjacent Notes share bounds, while paint changes at their actual joint', () => {
        const notes = { matches: () => true, getBoundingClientRect: () => rect(700, 950) };
        const text = { nextElementSibling: notes, getBoundingClientRect: () => rect(200, 700) };
        const row = { matches: () => false, querySelector: () => text };
        const surface = resolveEchoSurface(row, 600, { innerWidth: 1280 });
        expect(surface.box.bottom).toBe(950); expect(surface.paint).toBe(text); expect(surface.radius).toBe(notes);
        expect(resolveEchoSurface(row, 800, { innerWidth: 1280 }).paint).toBe(notes);
        expect(resolveEchoSurface(row, 150, { innerWidth: 1280 })).toBeNull();
        expect(resolveEchoSurface(row, 951, { innerWidth: 1280 })).toBeNull();
        notes.getBoundingClientRect = () => rect(720, 950);
        expect(resolveEchoSurface(row, 710, { innerWidth: 1280 })).toBeNull();
        expect(surface.targets).toEqual([row, text, notes]); expect(surface.underlay).toBe(row);
    });
    test('tablet resolves the enclosing row and system rows resolve no surface', () => {
        const row = { matches: () => false, getBoundingClientRect: () => rect(100, 1000) };
        const surface = resolveEchoSurface(row, 700, { innerWidth: 1000 });
        expect(surface.paint).toBe(row); expect(surface.radius).toBe(row); expect(surface.targets).toEqual([row]);
        row.matches = () => true; expect(resolveEchoSurface(row, 700, { innerWidth: 1000 })).toBeNull();
    });
    test('a joined inside footer continues Notes, while detached footer and intervening gap resolve separately', () => {
        const footer = { matches: () => true, classList: { contains: name => name === 'nn-echo-footer-joined' }, getBoundingClientRect: () => rect(950, 1000) };
        const notes = { matches: () => true, getBoundingClientRect: () => rect(700, 950) };
        const text = { nextElementSibling: notes, getBoundingClientRect: () => rect(200, 700) };
        const row = { matches: () => false, querySelector: selector => selector.includes('nn-response-controls') ? footer : text };
        const surface = resolveEchoSurface(row, 800, { innerWidth: 1280 });
        expect(surface.box.bottom).toBe(1000); expect(surface.radius).toBe(footer);
        expect(resolveEchoSurface(row, 975, { innerWidth: 1280 }).paint).toBe(footer);
        footer.classList.contains = () => false; footer.getBoundingClientRect = () => rect(1100, 1150);
        expect(resolveEchoSurface(row, 1000, { innerWidth: 1280 })).toBeNull();
        expect(resolveEchoSurface(row, 800, { innerWidth: 1280 }).box.bottom).toBe(950);
        expect(resolveEchoSurface(row, 1120, { innerWidth: 1280 }).box.top).toBe(1100);
        footer.classList.contains = name => name === 'nn-echo-overlay-footer'; footer.getBoundingClientRect = () => rect(900, 950);
        expect(resolveEchoSurface(row, 925, { innerWidth: 1280 }).paint).toBe(notes);
        expect(resolveEchoSurface(row, 1000, { innerWidth: 1280 })).toBeNull();
    });
    test('cleanup removes only owned decoration and leaves avatar/foreign style intact', () => {
        const values = new Map([['--mes-avatar-url', 'portrait'], ['clip-path', 'inset(2px)'], ['--nn-echo-cat-top', '40px']]);
        const plate = { remove: jest.fn() };
        const row = { classList: { contains: () => true, remove: jest.fn() }, style: { removeProperty: key => values.delete(key) }, querySelector: selector => selector.includes('plate') ? plate : null };
        clearEchoMessage(row);
        expect(values.get('--mes-avatar-url')).toBe('portrait'); expect(values.get('clip-path')).toBe('inset(2px)');
        expect(values.has('--nn-echo-cat-top')).toBe(false); expect(plate.remove).toHaveBeenCalledTimes(1);
    });
    test('repeated cleanup leaves a non-Echo row class attribute untouched', () => {
        const classes = new Set(['mes', 'last_mes']);
        const remove = jest.fn((...names) => names.forEach(name => classes.delete(name)));
        const row = {
            classList: { contains: name => classes.has(name), remove },
            style: { removeProperty: jest.fn() },
            querySelector: () => null,
            querySelectorAll: () => [],
        };
        for (let index = 0; index < 10; index++) clearEchoMessage(row);
        expect(remove).not.toHaveBeenCalled();
        expect([...classes]).toEqual(['mes', 'last_mes']);
        classes.add('nn-echo-cutoff');
        classes.add('nn-echo-footer-adjacent');
        clearEchoMessage(row);
        expect([...classes]).toEqual(['mes', 'last_mes']);
        expect(remove).toHaveBeenCalledTimes(2);
        clearEchoMessage(row);
        expect(remove).toHaveBeenCalledTimes(2);
    });
});
