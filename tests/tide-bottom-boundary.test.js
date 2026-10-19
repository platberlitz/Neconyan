import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, jest } from '@jest/globals';
import { createBubblesBottomBoundary } from '../public/scripts/bubbles-bottom-boundary.js';
import { resolveTideSurface } from '../public/scripts/echo-message-layout.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const read = relativePath => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const boundarySource = read('public/scripts/bubbles-bottom-boundary.js');
const layoutSource = read('public/scripts/echo-message-layout.js');

const box = (state = {}) => ({ width: 100, height: 40, left: 20, top: 100, right: 120, bottom: 140, ...state });
const element = (state = {}) => ({
    display: 'block', visibility: 'visible', width: 100, height: 40, left: 20, top: 100, right: 120, bottom: 140,
    attrs: [], ...state,
    hasAttribute(name) { return this.attrs.includes(name); },
    getBoundingClientRect() {
        return { width: this.width, height: this.height, left: this.left, top: this.top, right: this.right, bottom: this.bottom };
    },
});
const windowRef = { getComputedStyle: node => ({ display: node.display, visibility: node.visibility }) };

describe('Tide lower-edge wiring', () => {
    it('joins the shared painter with its own gate, paint and editor lane', () => {
        expect(boundarySource).toContain('import { resolveEchoSurface, disposeEchoLayout, resolveTideSurface, disposeTideLayout } from \'./echo-message-layout.js\';');
        expect(boundarySource).toContain('const tide = !echo && body.classList?.contains(\'tidestyle\') === true;');
        expect(boundarySource).toContain('tide ? \'.neconyan.tidestyle:not(.sbterm):not(.sbstory)\'');
        expect(boundarySource).toContain('const descriptor = row && echo ? resolveEchoSurface(row, y, windowRef) : row && tide ? resolveTideSurface(row, y, windowRef) : null;');
        expect(boundarySource).toContain('if (!row || (!echo && !cardStyle && !tide && row.querySelector(\'.edit_textarea, .reasoning_edit_textarea\'))) return;');
        expect(boundarySource).toContain('if ((echo || tide) && !descriptor) return;');
        expect(boundarySource).toContain(': tide ? { background: underlay.background, opacity: underlay.opacity, display: \'block\' }');
        expect(boundarySource).toContain('const insideBar = box.left >= bar.left - 1 && box.right <= bar.right + 1;');
        expect(boundarySource).toContain('if ((echo || cardStyle) && box.right - box.left <= bar.width + 1) return;');
        expect(boundarySource).toContain('if (tide && insideBar) return;');
        expect(boundarySource).toContain('const editors = cardStyle || tide ? [...row.querySelectorAll(\'.edit_textarea, .reasoning_edit_textarea\')] : [echo && row.querySelector(\'.mes_text .edit_textarea\')];');
        expect(boundarySource).toContain('clear(); resize.disconnect(); observer.disconnect(); cap.remove();');
        expect(boundarySource).toContain('disposeEchoLayout(chat);\n        disposeTideLayout(chat);');
        // R7 deletes the one-line hiding: nothing in the painter names it any more.
        for (const gone of ['nn-tide-underbar', 'underBarBubbles', 'clearUnderBar', 'hideOneLineBubbles', 'tideBubbleTags']) {
            expect(boundarySource).not.toContain(gone);
        }
    });
});

describe('Tide container surface', () => {
    const row = ({ container = null, system = false } = {}) => ({
        matches: selector => system && selector === '.smallSysMes, [is_system="true"]',
        getBoundingClientRect: () => box({ top: 0, bottom: 400 }),
        querySelector: selector => selector === ':scope > .nn-tide-container' ? container : null,
        querySelectorAll: () => [],
    });
    const container = (state = {}) => element({ top: 300, bottom: 400, left: 20, right: 320, ...state });

    it('paints through the container while y crosses it and nothing in the gaps', () => {
        const elementRef = container();
        const surface = resolveTideSurface(row({ container: elementRef }), 320, windowRef);
        expect(surface.paint).toBe(elementRef);
        expect(surface.radius).toBe(elementRef);
        expect(surface.underlay).toBe(elementRef);
        expect(surface.box).toMatchObject({ top: 300, bottom: 400 });
        expect(surface.targets).toEqual([expect.any(Object)]);
        // The gap between two containers, and both edges, resolve no surface.
        expect(resolveTideSurface(row({ container: elementRef }), 299, windowRef)).toBe(null);
        expect(resolveTideSurface(row({ container: elementRef }), 400, windowRef)).toBe(null);
        expect(resolveTideSurface(row({}), 320, windowRef)).toBe(null);
    });

    it('resolves no surface for system rows', () => {
        const system = { matches: selector => selector === '.smallSysMes, [is_system="true"]', getBoundingClientRect: () => box() };
        expect(resolveTideSurface(system, 120, windowRef)).toBe(null);
        expect(layoutSource).toContain('if (row.matches(\'.smallSysMes, [is_system="true"]\')) return null;');
        expect(jest.isMockFunction(resolveTideSurface)).toBe(false);
    });
});

describe('Tide lower edge: the container is the only surface', () => {
    // Drives the shared painter with a Tide body: a container that lies inside the bottom bar
    // scrolls behind it untouched, one that sticks out past either bar edge paints the rounded cap
    // with the container's own radius and tint, and an active editor keeps its scrollbar lane.
    function fixture({ containerLeft = 20, containerWidth = 300, containerTop = 480, containerHeight = 160, barLeft = 100, barWidth = 400, editor = null }) {
        let containerTopValue = containerTop;
        let clip = '';
        const frames = [], handlers = new Map(), observers = [];
        const element = () => ({ style: {}, dataset: {}, parentElement: null, append() {}, remove() {}, setAttribute() {}, contains: () => false, closest: () => null, getAnimations: () => [] });
        const cap = element(), surface = element();
        const chat = {
            ...element(), clientLeft: 0, clientWidth: 800,
            style: {
                getPropertyValue: () => clip, getPropertyPriority: () => '',
                removeProperty() { clip = ''; }, setProperty(_, value) { clip = value; },
                set clipPath(value) { clip = value; }, get clipPath() { return clip; },
            },
            getAttribute: () => clip,
            getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 601, height: 601 }),
            addEventListener: (name, handler) => handlers.set(name, handler), removeEventListener() {},
        };
        chat.parentElement = element();
        const toolbar = { ...element(), getBoundingClientRect: () => ({ left: barLeft, right: barLeft + barWidth, top: 601, width: barWidth, height: 40 }) };
        const containerClasses = new Set();
        const container = {
            tagName: 'DIV',
            classList: { add: name => containerClasses.add(name), remove: name => containerClasses.delete(name), contains: name => containerClasses.has(name) },
            contains: () => false, querySelector: () => null, hasAttribute: () => false,
            getBoundingClientRect: () => ({ left: containerLeft, top: containerTopValue, right: containerLeft + containerWidth, bottom: containerTopValue + containerHeight, width: containerWidth, height: containerHeight }),
        };
        const row = {
            ...element(), parentElement: chat, matches: () => false, getAttribute: () => '1',
            getBoundingClientRect: () => ({ left: 20, top: 20, right: 820, bottom: 596, width: 800, height: 576 }),
            querySelector: selector => selector === ':scope > .nn-tide-container' ? container : null,
            querySelectorAll: selector => selector.includes('edit_textarea') ? (editor ? [editor] : []) : [],
        };
        const containerStyle = {
            background: 'color(srgb 0.141176 0.141176 0.12549 / 0.55)', opacity: '1', display: 'block', visibility: 'visible',
            borderLeft: '1px solid rgb(80, 80, 70)', borderRight: '1px solid rgb(80, 80, 70)', borderBottom: '1px solid rgb(80, 80, 70)',
            borderBottomLeftRadius: '22px', borderBottomRightRadius: '22px',
        };
        const documentRef = {
            body: { ...element(), classList: { contains: name => name === 'tidestyle' }, matches: () => true }, documentElement: element(),
            createElement: jest.fn().mockReturnValueOnce(cap).mockReturnValueOnce(surface), getElementById: () => null,
            elementsFromPoint: () => [{ closest: () => row }], addEventListener() {}, removeEventListener() {},
        };
        const windowRef = {
            innerWidth: 1280, performance: { now: () => 0 },
            getComputedStyle: node => node === chat ? { clipPath: clip || 'none' } : node === editor ? { borderRightWidth: '1px', display: 'block' } : containerStyle,
            requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {},
            ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
            MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} disconnect() {} },
        };
        const controller = createBubblesBottomBoundary({ chat, toolbar, getMode: () => 'roleplay', documentRef, windowRef });
        return { cap, surface, chat, frames, handlers, controller, container, containerClasses, setContainer: top => { containerTopValue = top; }, flush: () => frames.shift()() };
    }

    it('scrolls a container that lies inside the bottom bar behind it without a cap or a clip', () => {
        const inside = fixture({ containerLeft: 150, containerWidth: 300 });
        inside.flush();
        expect(inside.cap.hidden).toBe(true);
        expect(inside.chat.style.getPropertyValue('clip-path')).toBe('');
        expect(inside.cap.style.background).toBeUndefined();
        inside.controller.dispose();
    });

    it('paints the cap with the container\'s radius and tint when it sticks out past the bar\'s left edge', () => {
        const offset = fixture({ containerLeft: 20, containerWidth: 300 });
        offset.flush();
        expect(offset.cap.hidden).toBe(false);
        expect(offset.cap.style.background).toBe('color(srgb 0.141176 0.141176 0.12549 / 0.55)');
        expect(offset.cap.style.borderBottomLeftRadius).toBe('22px');
        expect(offset.cap.style.height).toBe('22px');
        offset.controller.dispose();
    });

    it('paints the cap for a container that sticks out past the bar\'s right edge', () => {
        const offset = fixture({ containerLeft: 400, containerWidth: 300 });
        offset.flush();
        expect(offset.cap.hidden).toBe(false);
        expect(offset.cap.style.background).toBe('color(srgb 0.141176 0.141176 0.12549 / 0.55)');
        expect(offset.cap.style.left).toBe('400px');
        expect(offset.cap.style.width).toBe('300px');
        offset.controller.dispose();
    });

    it('paints the rounded cap for a container wider than the bottom bar', () => {
        const wide = fixture({ containerWidth: 700 });
        wide.flush();
        expect(wide.cap.hidden).toBe(false);
        expect(wide.cap.style.background).toBe('color(srgb 0.141176 0.141176 0.12549 / 0.55)');
        expect(wide.cap.style.borderBottomLeftRadius).toBe('22px');
        expect(wide.cap.style.height).toBe('22px');
        expect(wide.chat.style.getPropertyValue('clip-path')).toContain('polygon');
        expect(wide.cap.style.clipPath).toBe('none');
        wide.controller.dispose();
    });

    it('keeps a short container crossing the edge visible and hides no bubble', () => {
        // The container is about one text line tall and spans the cap band, so it paints like any other.
        const crossing = fixture({ containerLeft: 20, containerWidth: 300, containerTop: 560, containerHeight: 55 });
        crossing.flush();
        expect(crossing.cap.hidden).toBe(false);
        expect(crossing.cap.style.borderBottomLeftRadius).toBe('22px');
        expect(crossing.containerClasses.size).toBe(0);
        // A short container that stops above the cap band is left alone entirely.
        const clear = fixture({ containerLeft: 20, containerWidth: 300, containerTop: 400, containerHeight: 20 });
        clear.flush();
        expect(clear.cap.hidden).toBe(true);
        expect(clear.containerClasses.size).toBe(0);
        crossing.controller.dispose();
        clear.controller.dispose();
    });

    it('notches the scrollbar lane of an active editor under the wide cap', () => {
        const editor = {
            scrollHeight: 2000, clientHeight: 600, clientWidth: 600, clientLeft: 0,
            getBoundingClientRect: () => ({ left: 40, right: 780, top: 200, bottom: 1000, width: 740, height: 800 }),
        };
        const wide = fixture({ containerWidth: 700, editor });
        wide.flush();
        expect(wide.cap.hidden).toBe(false);
        // The cap's own clip carries the lane (620..700 inside the box), and the chat's clip
        // notches the same lane at the notch's top edge.
        expect(wide.cap.style.clipPath).toContain('620px');
        expect(wide.cap.style.clipPath).toContain('700px');
        expect(wide.chat.style.getPropertyValue('clip-path')).toContain('720px 583px');
        expect(wide.chat.style.getPropertyValue('clip-path')).toContain('640px 583px');
        wide.controller.dispose();
    });
});
