import { describe, expect, jest, test } from '@jest/globals';
import { createBubblesBottomBoundary } from '../public/scripts/bubbles-bottom-boundary.js';

function fixture() {
    let clip = '', priority = '', mode = 'roleplay';
    const frames = [], observers = [], handlers = new Map();
    const element = () => ({ hidden: false, style: {}, dataset: {}, parentElement: null, append: jest.fn(), remove: jest.fn(), setAttribute: jest.fn(), contains: () => false, closest: () => null });
    const cap = element(), surface = element();
    const chat = { ...element(), clientLeft: 0, clientWidth: 380, getAttribute: () => clip,
        style: { getPropertyValue: () => clip, getPropertyPriority: () => priority, setProperty: (_, value, p) => { clip = value; priority = p; }, removeProperty: () => { clip = ''; }, set clipPath(value) { clip = value; } },
        getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 700, height: 600 }),
        addEventListener: (name, handler) => handlers.set(name, handler), removeEventListener: jest.fn(),
    };
    chat.parentElement = element();
    const toolbar = { ...element(), getBoundingClientRect: () => ({ top: 700, height: 40 }) };
    const row = { ...element(), parentElement: chat, getAttribute: () => '7', querySelector: () => null,
        getBoundingClientRect: () => ({ left: 90, right: 500, top: 150, bottom: 1000 }), closest: () => null };
    const rowStyle = { background: 'red', borderBottomLeftRadius: '10px', borderBottomRightRadius: '10px' };
    const paint = { background: 'blue', opacity: '0.5', display: 'block' };
    const documentRef = { body: { ...element(), matches: () => true }, documentElement: element(),
        createElement: jest.fn().mockReturnValueOnce(cap).mockReturnValueOnce(surface), getElementById: () => null,
        elementsFromPoint: () => [{ closest: () => row }], addEventListener: jest.fn(), removeEventListener: jest.fn() };
    const windowRef = { innerWidth: 1280, performance: { now: () => 0 },
        requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame: jest.fn(),
        getComputedStyle: (el, pseudo) => el === chat ? { clipPath: clip || 'none' } : el === row ? pseudo ? paint : rowStyle : {},
        addEventListener: jest.fn(), removeEventListener: jest.fn(),
        ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
        MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} disconnect() {} },
    };
    const controller = createBubblesBottomBoundary({ chat, toolbar, getMode: () => mode, documentRef, windowRef });
    return { cap, surface, chat, row, rowStyle, paint, frames, observers, handlers, controller, windowRef,
        flush: () => frames.shift()(), clip: () => clip, setMode: value => { mode = value; } };
}

describe('Bubbles bottom boundary lifecycle', () => {
    test('notches only the bubble inside the content box and clears stale paint synchronously', () => {
        const f = fixture(); f.flush();
        expect(f.cap.style.left).toBe('100px');
        expect(f.cap.style.width).toBe('380px');
        expect(f.cap.style.top).toBe('694px');
        expect(f.clip()).toContain('380px 594px');
        expect(f.surface.style.background).toBe('blue');
        f.handlers.get('scroll')();
        expect(f.cap.hidden).toBe(true); expect(f.clip()).toBe('');
        f.handlers.get('scroll')(); expect(f.frames).toHaveLength(1);
        f.flush(); expect(f.cap.hidden).toBe(false);
        f.controller.dispose(); expect(f.clip()).toBe('');
    });
    test('refreshes stationary paint and suspends native editing', () => {
        const f = fixture(); f.flush(); f.rowStyle.background = 'darkred';
        f.observers[0]([{ target: f.row, type: 'attributes' }]); f.flush();
        expect(f.cap.style.background).toBe('darkred');
        f.row.querySelector = () => ({});
        f.observers[0]([{ target: f.row, type: 'childList' }]); f.flush();
        expect(f.cap.hidden).toBe(true); expect(f.clip()).toBe('');
        f.row.querySelector = () => null;
        f.observers[0]([{ target: f.row, type: 'childList' }]); f.flush();
        expect(f.cap.hidden).toBe(false); f.controller.dispose();
    });
    test('preserves external clipping and excludes phones and other modes', () => {
        const f = fixture(); f.chat.style.setProperty('clip-path', 'inset(2px)', 'important'); f.flush();
        expect(f.clip()).toBe('inset(2px)'); expect(f.cap.hidden).toBe(true);
        f.chat.style.removeProperty(); f.handlers.get('scroll')(); f.flush(); expect(f.cap.hidden).toBe(false);
        f.setMode('conversation'); f.handlers.get('scroll')(); f.flush(); expect(f.clip()).toBe('');
        f.setMode('roleplay'); f.windowRef.innerWidth = 768; f.handlers.get('scroll')(); f.flush();
        expect(f.cap.hidden).toBe(true); f.controller.dispose();
    });
    test('stops paint transition resampling at transition end', () => {
        const f = fixture(); f.flush();
        const event = { target: f.row, propertyName: 'background-color', pseudoElement: '', type: 'transitionrun' };
        f.handlers.get('transitionrun')(event); f.flush(); expect(f.frames).toHaveLength(1);
        f.handlers.get('transitionend')({ ...event, type: 'transitionend' }); f.flush();
        expect(f.frames).toHaveLength(0); f.controller.dispose();
    });
    test('suppresses an active cap when another owner supplies custom clipping', () => {
        const f = fixture(); f.flush(); expect(f.cap.hidden).toBe(false);
        f.chat.style.setProperty('clip-path', 'inset(3px)', 'important');
        f.observers[0]([{ target: f.chat, type: 'attributes', attributeName: 'style' }]);
        f.flush(); expect(f.cap.hidden).toBe(true); expect(f.clip()).toBe('inset(3px)');
        f.controller.dispose(); expect(f.clip()).toBe('inset(3px)');
    });
    test('resamples a relevant transition already running when a row enters the edge', () => {
        const f = fixture();
        f.row.getAnimations = jest.fn(() => [
            { playState: 'running', transitionProperty: 'background-color', effect: { pseudoElement: null } },
            { playState: 'finished', transitionProperty: 'opacity' },
            { playState: 'running', transitionProperty: 'transform' },
        ]);
        f.flush(); expect(f.frames).toHaveLength(1);
        f.rowStyle.background = 'darkred'; f.flush();
        expect(f.cap.style.background).toBe('darkred');
        expect(f.row.getAnimations).toHaveBeenCalledTimes(1);
        f.handlers.get('transitionend')({ target: f.row, type: 'transitionend', propertyName: 'background-color', pseudoElement: '' });
        f.flush(); expect(f.frames).toHaveLength(0);
        f.controller.dispose();
    });
});
