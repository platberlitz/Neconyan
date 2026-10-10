import { describe, expect, jest, test } from '@jest/globals';
import { createBubblesBottomBoundary } from '../public/scripts/bubbles-bottom-boundary.js';

function fixture() {
    let clip = '', end = 1200, rowWidth = 760, mode = 'roleplay', excluded = false, system = false;
    const frames = [], handlers = new Map(), observers = [];
    const element = () => ({ style: {}, dataset: {}, parentElement: null, append() {}, remove() {}, setAttribute() {}, contains: () => false, closest: () => null });
    const cap = element(), surface = element();
    const chat = { ...element(), clientLeft: 0, clientWidth: 800, getAttribute: () => clip,
        style: { getPropertyValue: () => clip, getPropertyPriority: () => '', removeProperty() { clip = ''; }, setProperty(_, value) { clip = value; }, set clipPath(value) { clip = value; } },
        getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 601, height: 601 }),
        addEventListener: (name, handler) => handlers.set(name, handler), removeEventListener() {},
    };
    chat.parentElement = element();
    const toolbar = { ...element(), getBoundingClientRect: () => ({ top: 601, width: 400, height: 40 }) };
    const row = { ...element(), parentElement: chat, matches: () => system, getAttribute: () => '2', querySelector: () => null, querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 20, bottom: end, left: 20, right: 20 + rowWidth, height: end - 20 }), getAnimations: () => [] };
    const rowStyle = { background: 'rgba(20, 30, 40, 0.8)', opacity: '0.6', borderBottomLeftRadius: '15px', borderBottomRightRadius: '15px' };
    const styles = new Map([[row, rowStyle]]);
    const documentRef = { body: { ...element(), classList: { contains: name => name === 'whisperstyle' }, matches: () => !excluded }, documentElement: element(),
        createElement: jest.fn().mockReturnValueOnce(cap).mockReturnValueOnce(surface), getElementById: () => null,
        elementsFromPoint: () => [{ closest: () => row }], addEventListener() {}, removeEventListener() {} };
    const windowRef = { innerWidth: 1280, performance: { now: () => 0 },
        getComputedStyle: (el, pseudo) => el === chat ? { clipPath: clip || 'none' } : pseudo ? { background: 'url(portrait.png)', opacity: '0.5', display: 'block' } : styles.get(el) || {},
        requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {},
        ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
        MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} disconnect() {} },
    };
    const controller = createBubblesBottomBoundary({ chat, toolbar, getMode: () => mode, documentRef, windowRef });
    return { cap, surface, row, rowStyle, chat, styles, frames, handlers, observers, windowRef, controller, flush: () => frames.shift()(),
        setEnd: value => { end = value; }, setWidth: value => { rowWidth = value; }, setMode: value => { mode = value; },
        exclude: () => { excluded = true; }, setSystem: () => { system = true; } };
}

describe('Whisper enclosing-card lower edge', () => {
    test('copies outer paint, opacity and corners without repeating its portrait', () => {
        const f = fixture(); f.flush();
        expect(f.cap.hidden).toBe(false); expect(f.cap.style.top).toBe('590px'); expect(f.cap.style.height).toBe('15px');
        expect(f.cap.style.background).toBe(f.rowStyle.background); expect(f.cap.style.opacity).toBe('0.6');
        expect(f.surface.style.display).toBe('none'); expect(f.cap.style.borderBottomRightRadius).toBe('15px');
        f.controller.dispose();
    });
    test('protects the crossing body scrollbar when reasoning editing precedes it in DOM order', () => {
        const f = fixture();
        const editor = { scrollHeight: 2000, clientHeight: 600, clientWidth: 709, clientLeft: 1,
            getBoundingClientRect: () => ({ left: 40, right: 760, top: 200, bottom: 1000 }) };
        const reasoning = { ...editor, getBoundingClientRect: () => ({ left: 40, right: 760, top: 20, bottom: 150 }) };
        f.row.querySelectorAll = () => [reasoning, editor];
        f.styles.set(reasoning, { borderRightWidth: '1px' }); f.styles.set(editor, { borderRightWidth: '1px' }); f.flush();
        expect(f.cap.hidden).toBe(false); expect(f.cap.style.clipPath).toContain('730px 0'); expect(f.cap.style.clipPath).toContain('739px 0');
        expect(f.chat.style.getPropertyValue('clip-path')).toContain('750px 590px'); f.controller.dispose();
    });
    test('refreshes stationary selection paint and clears synchronously on scroll', () => {
        const f = fixture(); f.flush(); f.rowStyle.background = 'red';
        f.observers[0]([{ target: f.row, type: 'attributes' }]); f.flush(); expect(f.cap.style.background).toBe('red');
        f.handlers.get('scroll')(); expect(f.cap.hidden).toBe(true); f.flush(); expect(f.cap.hidden).toBe(false); f.controller.dispose();
    });
    test('clears at natural card ends and when the card is no wider than the toolbar', () => {
        const f = fixture(); f.flush(); f.setEnd(605); f.handlers.get('scroll')(); f.flush(); expect(f.cap.hidden).toBe(true);
        f.setEnd(1200); f.setWidth(400); f.handlers.get('scroll')(); f.flush(); expect(f.cap.hidden).toBe(true); f.controller.dispose();
    });
    test('preserves external clipping and clears hidden/system rows, phones and excluded modes', () => {
        for (const change of [f => f.chat.style.setProperty('clip-path', 'inset(2px)'), f => f.setSystem(), f => { f.windowRef.innerWidth = 768; }, f => f.exclude(), f => f.setMode('conversation')]) {
            const f = fixture(); f.flush(); change(f); f.handlers.get('scroll')(); f.flush(); expect(f.cap.hidden).toBe(true);
            f.controller.dispose();
        }
    });
});
