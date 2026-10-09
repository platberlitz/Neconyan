import { describe, expect, jest, test } from '@jest/globals';
import { isEchoMessage, resolveEchoSurface, clearEchoMessage } from '../public/scripts/echo-message-layout.js';

const rect = (top, bottom) => ({ left: 20, right: 620, top, bottom, toJSON() { return { left: this.left, right: this.right, top: this.top, bottom: this.bottom }; } });
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
        const row = { classList: { remove: jest.fn() }, style: { removeProperty: key => values.delete(key) }, querySelector: selector => selector.includes('plate') ? plate : null };
        clearEchoMessage(row);
        expect(values.get('--mes-avatar-url')).toBe('portrait'); expect(values.get('clip-path')).toBe('inset(2px)');
        expect(values.has('--nn-echo-cat-top')).toBe(false); expect(plate.remove).toHaveBeenCalledTimes(1);
    });
});
