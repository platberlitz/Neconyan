import { describe, expect, jest, test } from '@jest/globals';
import { createBubblesBottomBoundary } from '../public/scripts/bubbles-bottom-boundary.js';

function fixture(chatStyle = 'whisperstyle') {
    let clip = '', end = 1200, rowWidth = 760, mode = 'roleplay', excluded = false, system = false, currentStyle = chatStyle;
    const frames = [], handlers = new Map(), observers = [];
    const element = () => ({ style: {}, dataset: {}, parentElement: null, append() {}, remove() {}, setAttribute() {}, contains: () => false, closest: () => null });
    const cap = element(), surface = element();
    const chat = { ...element(), clientLeft: 0, clientWidth: 800, getAttribute: () => clip,
        style: { getPropertyValue: () => clip, getPropertyPriority: () => '', removeProperty() { clip = ''; }, setProperty(_, value) { clip = value; }, set clipPath(value) { clip = value; } },
        getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 601, height: 601 }),
        addEventListener: (name, handler) => handlers.set(name, handler), removeEventListener() {},
    };
    const parent = element(), form = element(), children = [chat, form];
    chat.parentElement = form.parentElement = parent;
    parent.append = jest.fn(node => { const i = children.indexOf(node); if (i >= 0) children.splice(i, 1); children.push(node); node.parentElement = parent; });
    chat.after = jest.fn(node => { const i = children.indexOf(node); if (i >= 0) children.splice(i, 1); children.splice(children.indexOf(chat) + 1, 0, node); node.parentElement = parent; });
    chat.compareDocumentPosition = () => 4;
    const toolbar = { ...element(), getBoundingClientRect: () => ({ top: 601, width: 400, height: 40 }) };
    const row = { ...element(), parentElement: chat, matches: () => system, getAttribute: () => '2', querySelector: () => null, querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 20, bottom: end, left: 20, right: 20 + rowWidth, height: end - 20 }), getAnimations: () => [] };
    const rowStyle = { background: 'rgba(20, 30, 40, 0.8)', opacity: '0.6', borderBottomLeftRadius: '15px', borderBottomRightRadius: '15px' };
    const plain = { opacity: '1', filter: 'none', backdropFilter: 'none', mixBlendMode: 'normal', maskImage: 'none', clipPath: 'none', transform: 'none', zoom: '1', rotate: 'none', scale: 'none', translate: 'none' };
    const chatStyleValues = { ...plain, zIndex: '30' }, formStyle = { zIndex: '30' };
    const styles = new Map([[row, rowStyle], [form, formStyle]]);
    const documentRef = { body: { ...element(), classList: { contains: name => name === currentStyle }, matches: () => !excluded }, documentElement: element(),
        createElement: jest.fn().mockReturnValueOnce(cap).mockReturnValueOnce(surface), getElementById: id => id === 'form_sheld' ? form : null,
        elementsFromPoint: () => [{ closest: () => row }], addEventListener() {}, removeEventListener() {} };
    const windowRef = { innerWidth: 1280, performance: { now: () => 0 },
        getComputedStyle: (el, pseudo) => el === chat ? { ...chatStyleValues, clipPath: clip || 'none' } : pseudo ? { background: 'url(portrait.png)', opacity: '0.5', display: 'block' } : styles.get(el) || {},
        requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {},
        ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
        MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} disconnect() {} },
    };
    const controller = createBubblesBottomBoundary({ chat, toolbar, getMode: () => mode, documentRef, windowRef });
    return { cap, surface, row, rowStyle, chat, parent, form, children, chatStyleValues, formStyle, styles, frames, handlers, observers, windowRef, controller, flush: () => frames.shift()(),
        makeOpaque: (colour = 'rgb(20, 30, 40)') => Object.assign(rowStyle, plain, { background: colour, backgroundColor: colour, backgroundImage: 'none', backgroundClip: 'border-box', borderImageSource: 'none' }),
        setStyle: value => { currentStyle = value; },
        setEnd: value => { end = value; }, setWidth: value => { rowWidth = value; }, setMode: value => { mode = value; },
        exclude: () => { excluded = true; }, setSystem: () => { system = true; } };
}

describe.each(['whisperstyle', 'hushstyle', 'ripplestyle'])('%s enclosing-card lower edge', chatStyle => {
    test('covers only opaque card paint above the unchanged notch and beneath the form', () => {
        for (const colour of ['rgb(20, 30, 40)', 'rgb(20 30 40 / 100%)', 'rgba(20, 30, 40, 1)', 'color(srgb 0.1 0.2 0.3)']) {
            const f = fixture(chatStyle); f.makeOpaque(colour); f.flush();
            expect(f.cap.style.top).toBe('589px'); expect(f.cap.style.height).toBe('16px'); expect(f.cap.style.zIndex).toBe('30');
            expect(f.chat.style.getPropertyValue('clip-path')).toContain('590px'); expect(f.children).toEqual([f.chat, f.cap, f.form]);
            f.observers[0]([{ target: f.row, type: 'attributes' }]); f.flush(); expect(f.chat.after).toHaveBeenCalledTimes(1);
            f.rowStyle.opacity = '0.9'; f.observers[0]([{ target: f.row, type: 'attributes' }]); f.flush();
            expect(f.cap.style.top).toBe('590px'); expect(f.cap.style.height).toBe('15px'); expect(f.cap.style.zIndex).toBe('');
            expect(f.children).toEqual([f.chat, f.form, f.cap]); f.controller.dispose();
        }
    });
    test('keeps the raised cap in place while the chat scrolls', () => {
        const f = fixture(chatStyle); f.makeOpaque(); f.flush();
        expect(f.chat.after).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 3; i++) {
            f.handlers.get('scroll')(); expect(f.cap.hidden).toBe(true); expect(f.children).toEqual([f.chat, f.cap, f.form]);
            f.flush(); expect(f.cap.hidden).toBe(false);
        }
        expect(f.chat.after).toHaveBeenCalledTimes(1); f.controller.dispose();
    });
    test('resets raised stacking on hidden/end/width/mode/external-clip paths', () => {
        for (const change of [f => f.setEnd(605), f => f.setWidth(400), f => f.setMode('conversation'), f => { f.windowRef.innerWidth = 768; }, f => f.chat.style.setProperty('clip-path', 'inset(2px)')]) {
            const f = fixture(chatStyle); f.makeOpaque(); f.flush(); change(f);
            f.observers[0]([{ target: f.row, type: 'attributes' }]); f.flush();
            expect(f.cap.hidden).toBe(true); expect(f.cap.style.zIndex).toBe(''); expect(f.children).toEqual([f.chat, f.form, f.cap]);
            f.controller.dispose();
        }
    });
    test('keeps the editor lane in the raised cap and the original native notch', () => {
        const f = fixture(chatStyle); f.makeOpaque();
        const editor = { scrollHeight: 2000, clientHeight: 600, clientWidth: 709, clientLeft: 1, getBoundingClientRect: () => ({ left: 40, right: 760, top: 200, bottom: 1000 }) };
        f.row.querySelectorAll = () => [editor]; f.styles.set(editor, { borderRightWidth: '1px' }); f.flush();
        expect(f.cap.style.top).toBe('589px'); expect(f.cap.style.clipPath).toContain('730px 0'); expect(f.cap.style.clipPath).toContain('739px 0');
        expect(f.chat.style.getPropertyValue('clip-path')).toContain('750px 590px'); f.controller.dispose();
    });
    test('shared parent effects do not disqualify the equally affected native and cap surfaces', () => {
        const f = fixture(chatStyle); f.makeOpaque(); f.styles.set(f.parent, { opacity: '0.8', filter: 'brightness(0.9)' }); f.flush();
        expect(f.cap.style.top).toBe('589px'); expect(f.cap.style.zIndex).toBe('30'); f.controller.dispose();
    });
    test('changing to another style restores the visible original cap placement', () => {
        const f = fixture(chatStyle); f.makeOpaque(); f.flush(); f.setStyle('bubblechat');
        f.observers[0]([{ target: f.row, type: 'attributes' }]); f.flush();
        expect(f.cap.hidden).toBe(false); expect(f.cap.style.top).toBe('590px'); expect(f.cap.style.zIndex).toBe('');
        expect(f.children).toEqual([f.chat, f.form, f.cap]); f.controller.dispose();
    });
    test('copies outer paint, opacity and corners without repeating its portrait', () => {
        const f = fixture(chatStyle); f.flush();
        expect(f.cap.hidden).toBe(false); expect(f.cap.style.top).toBe('590px'); expect(f.cap.style.height).toBe('15px');
        expect(f.cap.style.background).toBe(f.rowStyle.background); expect(f.cap.style.opacity).toBe('0.6');
        expect(f.surface.style.display).toBe('none'); expect(f.cap.style.borderBottomRightRadius).toBe('15px');
        f.controller.dispose();
    });
    test('protects the crossing body scrollbar when reasoning editing precedes it in DOM order', () => {
        const f = fixture(chatStyle);
        const editor = { scrollHeight: 2000, clientHeight: 600, clientWidth: 709, clientLeft: 1,
            getBoundingClientRect: () => ({ left: 40, right: 760, top: 200, bottom: 1000 }) };
        const reasoning = { ...editor, getBoundingClientRect: () => ({ left: 40, right: 760, top: 20, bottom: 150 }) };
        f.row.querySelectorAll = () => [reasoning, editor];
        f.styles.set(reasoning, { borderRightWidth: '1px' }); f.styles.set(editor, { borderRightWidth: '1px' }); f.flush();
        expect(f.cap.hidden).toBe(false); expect(f.cap.style.clipPath).toContain('730px 0'); expect(f.cap.style.clipPath).toContain('739px 0');
        expect(f.chat.style.getPropertyValue('clip-path')).toContain('750px 590px'); f.controller.dispose();
    });
    test('refreshes stationary selection paint and clears synchronously on scroll', () => {
        const f = fixture(chatStyle); f.flush(); f.rowStyle.background = 'red';
        f.observers[0]([{ target: f.row, type: 'attributes' }]); f.flush(); expect(f.cap.style.background).toBe('red');
        f.handlers.get('scroll')(); expect(f.cap.hidden).toBe(true); f.flush(); expect(f.cap.hidden).toBe(false); f.controller.dispose();
    });
    test('clears at natural card ends and when the card is no wider than the toolbar', () => {
        const f = fixture(chatStyle); f.flush(); f.setEnd(605); f.handlers.get('scroll')(); f.flush(); expect(f.cap.hidden).toBe(true);
        f.setEnd(1200); f.setWidth(400); f.handlers.get('scroll')(); f.flush(); expect(f.cap.hidden).toBe(true); f.controller.dispose();
    });
    test('preserves external clipping and clears hidden/system rows, phones and excluded modes', () => {
        for (const change of [f => f.chat.style.setProperty('clip-path', 'inset(2px)'), f => f.setSystem(), f => { f.windowRef.innerWidth = 768; }, f => f.exclude(), f => f.setMode('conversation')]) {
            const f = fixture(chatStyle); f.flush(); change(f); f.handlers.get('scroll')(); f.flush(); expect(f.cap.hidden).toBe(true);
            f.controller.dispose();
        }
    });
});

test.each(['whisperstyle', 'hushstyle', 'ripplestyle'])('%s unsupported colour, paint, effects or stacking retains the original cap', chatStyle => {
    const changes = [
        f => { f.rowStyle.backgroundColor = 'rgba(20, 30, 40, 0.999)'; }, f => { f.rowStyle.backgroundColor = 'color(srgb 0.1 0.2 0.3 / 99%)'; },
        f => { f.rowStyle.backgroundColor = 'lab(50% 0 0)'; }, f => { f.rowStyle.backgroundImage = 'linear-gradient(red, blue)'; },
        f => { f.rowStyle.backgroundClip = 'padding-box'; }, f => { f.rowStyle.borderImageSource = 'url(border.png)'; },
        ...['filter', 'backdropFilter', 'maskImage', 'clipPath', 'transform', 'rotate', 'scale', 'translate'].map(key => f => { f.rowStyle[key] = 'custom'; }),
        f => { f.rowStyle.zoom = '1.1'; }, f => { f.rowStyle.mixBlendMode = 'multiply'; },
        f => { f.chatStyleValues.opacity = '0.9'; }, f => { f.chatStyleValues.transform = 'matrix(1,0,0,1,0,0)'; },
        f => { f.chatStyleValues.zIndex = '31'; }, f => { f.formStyle.zIndex = '31'; },
        f => { f.form.parentElement = {}; }, f => { f.chat.compareDocumentPosition = () => 2; },
        f => f.setStyle('bubblechat'),
    ];
    for (const change of changes) {
        const f = fixture(chatStyle); f.makeOpaque(); change(f); f.flush();
        expect(f.cap.style.top).toBe('590px'); expect(f.cap.style.height).toBe('15px'); expect(f.cap.style.zIndex).not.toBe('30');
        expect(f.children).toEqual([f.chat, f.form, f.cap]); f.controller.dispose();
    }
});
