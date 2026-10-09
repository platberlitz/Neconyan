import { describe, expect, jest, test } from '@jest/globals';
import { createBubblesBottomBoundary } from '../public/scripts/bubbles-bottom-boundary.js';

function fixture() {
    let clip = '', y = 600;
    const frames = [], handlers = new Map(), observers = [];
    const element = () => ({ style: {}, dataset: {}, parentElement: null, append() {}, remove() {}, setAttribute() {}, contains: () => false, closest: () => null });
    const box = (top, bottom) => ({ top, bottom, left: 20, right: 780, height: bottom - top, toJSON() { return { top, bottom, left: 20, right: 780 }; } });
    const chat = { ...element(), clientLeft: 0, clientWidth: 800, getAttribute: () => clip,
        style: { getPropertyValue: () => clip, getPropertyPriority: () => '', removeProperty() { clip = ''; }, setProperty(_, value) { clip = value; }, set clipPath(value) { clip = value; } },
        getBoundingClientRect: () => ({ left: 0, top: 0, bottom: y + 1, height: y + 1 }),
        addEventListener: (name, handler) => handlers.set(name, handler), removeEventListener() {},
    };
    chat.parentElement = element();
    const toolbar = { ...element(), getBoundingClientRect: () => ({ top: y + 1, width: 400, height: 40 }) };
    const cap = element(), surface = element();
    const notes = { ...element(), matches: () => true, getBoundingClientRect: () => box(700, 1200), getAnimations: jest.fn(() => []) };
    const text = { ...element(), nextElementSibling: notes, getBoundingClientRect: () => box(100, 700), getAnimations: jest.fn(() => []) };
    const row = { ...element(), parentElement: chat, matches: () => false, getAttribute: () => '3', getBoundingClientRect: () => box(20, 1300),
        querySelector: selector => selector.includes('mes_text') ? text : null, getAnimations: jest.fn(() => []) };
    const styles = new Map([[row, { background: 'red', opacity: '1' }], [text, { background: 'rgba(0, 0, 255, 0.3)', opacity: '1', borderBottomLeftRadius: '0px', borderBottomRightRadius: '0px' }],
        [notes, { background: 'rgba(0, 255, 0, 0.3)', opacity: '1', borderBottomLeftRadius: '15px', borderBottomRightRadius: '15px' }]]);
    const documentRef = { body: { ...element(), classList: { contains: () => true }, matches: () => true }, documentElement: element(),
        createElement: jest.fn().mockReturnValueOnce(cap).mockReturnValueOnce(surface), getElementById: () => null,
        elementsFromPoint: () => [{ closest: () => row }], addEventListener() {}, removeEventListener() {} };
    const windowRef = { innerWidth: 1280, performance: { now: () => 0 },
        getComputedStyle: el => el === chat ? { clipPath: clip || 'none' } : styles.get(el) || {},
        requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {},
        ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
        MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} disconnect() {} },
    };
    const controller = createBubblesBottomBoundary({ chat, toolbar, getMode: () => 'roleplay', documentRef, windowRef });
    return { cap, surface, row, text, notes, styles, handlers, frames, observers, controller, flush: () => frames.shift()(), setY: value => { y = value; } };
}
describe('Echo lower edge shares native surface paint and lifecycle', () => {
    test('composites translucent text over selection underlay and uses Notes final corners', () => {
        const f = fixture(); f.flush();
        expect(f.cap.style.background).toBe('red'); expect(f.surface.style.background).toBe('rgba(0, 0, 255, 0.3)');
        expect(f.cap.style.borderBottomLeftRadius).toBe('15px');
        f.setY(800); f.handlers.get('scroll')(); f.flush();
        expect(f.surface.style.background).toBe('rgba(0, 255, 0, 0.3)');
        f.setY(1250); f.handlers.get('scroll')(); f.flush(); expect(f.cap.hidden).toBe(true);
        f.controller.dispose();
    });
    test('identical transition properties on separate paint elements remain independent', () => {
        const f = fixture(); f.flush();
        const event = target => ({ target, propertyName: 'background-color', pseudoElement: '', type: 'transitionrun' });
        f.handlers.get('transitionrun')(event(f.row)); f.handlers.get('transitionrun')(event(f.text)); f.flush();
        f.handlers.get('transitionend')({ ...event(f.row), type: 'transitionend' }); f.flush();
        expect(f.frames).toHaveLength(1);
        f.handlers.get('transitionend')({ ...event(f.text), type: 'transitionend' }); f.flush(); expect(f.frames).toHaveLength(0);
        f.controller.dispose();
    });
    test('changing text to Notes within the same row samples already-running paint transitions', () => {
        const f = fixture(); f.flush();
        f.notes.getAnimations.mockReturnValue([{ playState: 'running', transitionProperty: 'opacity', effect: { pseudoElement: null } }]);
        f.setY(800); f.handlers.get('scroll')(); f.flush();
        expect(f.frames).toHaveLength(1); expect(f.notes.getAnimations).toHaveBeenCalledTimes(2);
        f.controller.dispose();
    });
    test('a real Echo text surface retains its cap during editing and preserves the editor scrollbar lane', () => {
        const f = fixture();
        const editor = { scrollHeight: 2000, clientHeight: 600, clientWidth: 709, clientLeft: 1,
            getBoundingClientRect: () => ({ left: 40, right: 760, top: 200, bottom: 1000 }) };
        f.row.querySelector = selector => selector === '.mes_text .edit_textarea' || selector === '.edit_textarea, .reasoning_edit_textarea' ? editor : selector.includes('mes_text') ? f.text : null;
        f.styles.set(editor, { borderRightWidth: '1px' }); f.flush();
        expect(f.cap.hidden).toBe(false);
        expect(f.cap.style.clipPath).toContain('730px 0'); expect(f.cap.style.clipPath).toContain('739px 0');
        f.setY(50); f.handlers.get('scroll')(); f.flush();
        expect(f.cap.hidden).toBe(true); // A reasoning editor crossing the header is not a reading surface.
        f.controller.dispose();
    });
});
