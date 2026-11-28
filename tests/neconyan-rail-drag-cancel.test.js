import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

// Returns the source from `start` to the brace that closes the first block after it.
function sliceBlock(source, start) {
    const from = source.indexOf(start);
    if (from < 0) throw new Error(`Missing ${start}`);
    let depth = 0;
    for (let index = source.indexOf('{', from); index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) return source.slice(from, index + 1);
    }
    throw new Error(`Unclosed ${start}`);
}

describe('Touch Punch interrupted touches', () => {
    function loadTouchPunch() {
        const dispatched = [];
        const captures = [];
        const handlers = {};
        const target = { dispatchEvent: event => dispatched.push(event.type) };
        const mouseProto = {
            _mouseInit() {},
            _mouseDestroy() {},
            _mouseCapture: () => captures.push('capture') > 0,
        };
        const $ = () => ({ is: () => false });
        $.ui = { mouse: function Mouse() {} };
        $.ui.mouse.prototype = mouseProto;
        $.support = {};
        $.proxy = (self, name) => (...args) => self[name](...args);
        const document = {
            ontouchstart: null,
            createEvent: () => ({ initMouseEvent(type) { this.type = type; } }),
        };
        const window = { navigator: { maxTouchPoints: 5 }, document };
        const context = vm.createContext({ window, document, navigator: window.navigator, jQuery: $ });
        vm.runInContext(readSource('public', 'lib', 'jquery.ui.touch-punch.min.js'), context);
        const widget = () => {
            const own = {};
            const instance = Object.create(mouseProto);
            instance.element = { 0: { style: {} }, on: map => Object.assign(own, map), off() {} };
            instance._mouseInit();
            return own;
        };
        Object.assign(handlers, widget());
        const originalTouch = (touches = []) => ({ touches, changedTouches: [{ pageX: 10, pageY: 10, screenX: 10, screenY: 10, clientX: 10, clientY: 10 }] });
        // jQuery wraps the browser's event afresh for every element it reaches,
        // so a bubbling touch gives each widget its own wrapper around one originalEvent.
        const wrap = (timeStamp, originalEvent) => ({ target, timeStamp, cancelable: true, preventDefault() {}, originalEvent });
        const touch = (timeStamp, touches = []) => wrap(timeStamp, originalTouch(touches));
        return { dispatched, captures, handlers, touch, widget, wrap, originalTouch };
    }

    test('a cancelled touch ends the press without a click and frees the next touch', () => {
        const { dispatched, handlers, touch } = loadTouchPunch();
        handlers.touchstart(touch(0, [{}]));
        handlers.touchmove(touch(900, [{}]));
        expect(dispatched).toEqual(['mouseover', 'mousemove', 'mousedown', 'mousemove']);

        dispatched.length = 0;
        handlers.touchcancel?.(touch(1000));
        expect(dispatched).toEqual(['mouseup', 'mouseout']);

        dispatched.length = 0;
        handlers.touchstart(touch(2000, [{}]));
        expect(dispatched).toEqual(['mouseover', 'mousemove', 'mousedown']);
    });

    test('a touchcancel with no press in hand does nothing', () => {
        const { dispatched, handlers, touch } = loadTouchPunch();
        handlers.touchcancel?.(touch(0));
        expect(dispatched).toEqual([]);
        expect(typeof handlers.touchcancel).toBe('function');
    });

    test('a touch that never got its touchend does not eat the next one-finger drag', () => {
        const { dispatched, handlers, touch } = loadTouchPunch();
        handlers.touchstart(touch(0, [{}]));
        handlers.touchmove(touch(900, [{}]));

        // The page lost focus and the finger's touchend never arrived.
        dispatched.length = 0;
        handlers.touchstart(touch(2000, [{}]));
        expect(dispatched).toEqual(['mouseover', 'mousemove', 'mousedown']);

        dispatched.length = 0;
        handlers.touchmove(touch(2900, [{}]));
        handlers.touchend(touch(3000));
        expect(dispatched).toEqual(['mousemove', 'mouseup', 'mouseout']);
    });

    test('the same touchstart bubbling to an outer widget still starts only one press', () => {
        const { dispatched, handlers, widget, wrap, originalTouch } = loadTouchPunch();
        const outer = widget();
        const start = originalTouch([{}]);
        handlers.touchstart(wrap(0, start));
        outer.touchstart(wrap(0, start));
        expect(dispatched).toEqual(['mouseover', 'mousemove', 'mousedown']);

        // Even after an earlier press was left hanging.
        dispatched.length = 0;
        const next = originalTouch([{}]);
        handlers.touchstart(wrap(5000, next));
        outer.touchstart(wrap(5000, next));
        expect(dispatched).toEqual(['mouseover', 'mousemove', 'mousedown']);
    });

    test('a second finger landing during a press is still ignored', () => {
        const { dispatched, captures, handlers, widget, touch } = loadTouchPunch();
        const other = widget();
        handlers.touchstart(touch(0, [{}]));
        dispatched.length = 0;
        captures.length = 0;
        other.touchstart(touch(300, [{}, {}]));
        handlers.touchstart(touch(300, [{}, {}]));
        expect(dispatched).toEqual([]);
        // No widget gets the chance to take the second finger for itself.
        expect(captures).toEqual([]);

        handlers.touchmove(touch(900, [{}]));
        expect(dispatched).toEqual(['mousemove']);
    });
});

describe('Edit sidebar drag interruptions', () => {
    const source = readSource('public', 'scripts', 'welcome-screen.js');

    function loadRailPress() {
        const scroller = { style: { overflowAnchor: '' } };
        const rail = { querySelector: selector => (selector === '.neconyan-rail-scroll' ? scroller : null) };
        const document = new EventTarget();
        document.visibilityState = 'visible';
        const window = new EventTarget();
        const saved = [];
        const instances = new Map();
        const $ = host => ({ sortable: command => (command === 'instance' ? instances.get(host) : undefined) });
        $.Event = function Event(type, props) { Object.assign(this, { type }, props); };
        const context = vm.createContext({ rail, document, window, $, saved, AbortController });
        const stop = sliceBlock(source, 'stop: (_event, ui) => {').replace(/^stop: /, '');
        const script = `
            const neconyanRailGroups = {};
            let cancelNeconyanRailPress = () => {};
            let suppressClickUntil = 0;
            let railSorting = false;
            let cancellingDrag = false;
            let releaseScrollAnchor = null;
            const saveOrder = button => saved.push(button);
            ${sliceBlock(source, 'const cancelRailPress = () => {')};
            cancelNeconyanRailPress = cancelRailPress;
            ${sliceBlock(source, 'const holdScrollAnchor = () => {')};
            const stop = ${stop};
            ({
                groups: neconyanRailGroups,
                holdScrollAnchor,
                stop,
                startDrag: () => { railSorting = true; suppressClickUntil = Infinity; },
                state: () => ({ railSorting, suppressClickUntil, held: Boolean(releaseScrollAnchor) }),
                applyCancel: () => cancelNeconyanRailPress(),
            });
        `;
        const api = vm.runInContext(script, context);
        const addGroup = (name, instance) => {
            const host = { name };
            api.groups[name] = { host, sortableReady: Boolean(instance) };
            if (instance) instances.set(host, instance);
        };
        return { api, scroller, document, window, saved, addGroup };
    }

    function draggingSortable(api) {
        const calls = [];
        const instance = {
            dragging: true,
            // jQuery UI's cancel() runs the stop callback with the row where the finger left it.
            cancel() {
                calls.push('cancel');
                this.dragging = false;
                api.stop({}, { item: ['home'] });
            },
            _mouseUp() { calls.push('mouseUp'); },
        };
        return { instance, calls };
    }

    function pendingSortable() {
        const calls = [];
        return {
            calls,
            instance: {
                dragging: false,
                // jQuery UI sets this on mousedown; a list that was never pressed has none.
                _mouseMoveDelegate() {},
                cancel() { calls.push('cancel'); },
                _mouseUp(event) { calls.push(`mouseUp:${event.type}`); },
            },
        };
    }

    const interruptions = {
        pointercancel: ({ document }) => document.dispatchEvent(new Event('pointercancel')),
        touchcancel: ({ document }) => document.dispatchEvent(new Event('touchcancel')),
        blur: ({ window }) => window.dispatchEvent(new Event('blur')),
        pagehide: ({ window }) => window.dispatchEvent(new Event('pagehide')),
        hidden: ({ document }) => {
            document.visibilityState = 'hidden';
            document.dispatchEvent(new Event('visibilitychange'));
        },
    };

    for (const [name, interrupt] of Object.entries(interruptions)) {
        test(`${name} mid-drag puts the row back without saving and turns scroll anchoring back on`, () => {
            const rig = loadRailPress();
            const { instance, calls } = draggingSortable(rig.api);
            rig.addGroup('primary', instance);
            rig.addGroup('advanced', null);
            rig.api.holdScrollAnchor();
            rig.api.startDrag();
            expect(rig.scroller.style.overflowAnchor).toBe('none');

            interrupt(rig);

            expect(calls).toEqual(['cancel']);
            expect(rig.saved).toEqual([]);
            expect(rig.scroller.style.overflowAnchor).toBe('');
            expect(rig.api.state()).toMatchObject({ railSorting: false, held: false });
            expect(rig.api.state().suppressClickUntil).toBeLessThan(Infinity);
        });

        test(`${name} during the hold before a drag drops the pending press`, () => {
            const rig = loadRailPress();
            const { instance, calls } = pendingSortable();
            rig.addGroup('primary', instance);
            rig.api.holdScrollAnchor();
            expect(rig.scroller.style.overflowAnchor).toBe('none');

            interrupt(rig);

            expect(calls).toEqual(['mouseUp:mouseup']);
            expect(rig.scroller.style.overflowAnchor).toBe('');
            expect(rig.api.state()).toMatchObject({ railSorting: false, held: false });
        });
    }

    test('the interruption listeners go away once the press is over', () => {
        const rig = loadRailPress();
        const { instance, calls } = pendingSortable();
        rig.addGroup('primary', instance);
        rig.api.holdScrollAnchor();
        rig.document.dispatchEvent(new Event('pointerup'));
        expect(rig.scroller.style.overflowAnchor).toBe('');

        interruptions.pointercancel(rig);
        interruptions.blur(rig);
        expect(calls).toEqual([]);
    });

    test('the page becoming visible again is not an interruption', () => {
        const rig = loadRailPress();
        const { instance, calls } = draggingSortable(rig.api);
        rig.addGroup('primary', instance);
        rig.api.holdScrollAnchor();
        rig.api.startDrag();
        rig.document.dispatchEvent(new Event('visibilitychange'));
        expect(calls).toEqual([]);
        expect(rig.scroller.style.overflowAnchor).toBe('none');
    });

    test('a drag after a cancelled one saves again', () => {
        const rig = loadRailPress();
        const { instance, calls } = draggingSortable(rig.api);
        rig.addGroup('primary', instance);
        rig.api.holdScrollAnchor();
        rig.api.startDrag();
        interruptions.pointercancel(rig);
        expect(calls).toEqual(['cancel']);
        expect(rig.saved).toEqual([]);

        rig.api.holdScrollAnchor();
        rig.api.startDrag();
        rig.api.stop({}, { item: ['characters'] });
        expect(rig.saved).toEqual(['characters']);
    });

    test('a list that is not set up yet does not stop a later list being put back', () => {
        const rig = loadRailPress();
        const { instance, calls } = draggingSortable(rig.api);
        rig.addGroup('primary', null);
        rig.addGroup('advanced', instance);
        rig.api.holdScrollAnchor();
        rig.api.startDrag();
        interruptions.blur(rig);
        expect(calls).toEqual(['cancel']);
        expect(rig.saved).toEqual([]);
    });

    test('a list that was never pressed is left alone', () => {
        const rig = loadRailPress();
        const { instance, calls } = pendingSortable();
        delete instance._mouseMoveDelegate;
        rig.addGroup('primary', instance);
        rig.api.holdScrollAnchor();
        interruptions.pointercancel(rig);
        expect(calls).toEqual([]);
        expect(rig.scroller.style.overflowAnchor).toBe('');
    });

    test('scroll anchoring and saving come back even if putting the row back throws', () => {
        const rig = loadRailPress();
        const { instance } = draggingSortable(rig.api);
        instance.cancel = () => { throw new Error('cancel failed'); };
        rig.addGroup('primary', instance);
        rig.api.holdScrollAnchor();
        rig.api.startDrag();
        expect(() => rig.api.applyCancel()).toThrow('cancel failed');
        expect(rig.scroller.style.overflowAnchor).toBe('');
        expect(rig.api.state()).toMatchObject({ railSorting: false, held: false });

        rig.api.stop({}, { item: ['home'] });
        expect(rig.saved).toEqual(['home']);
    });

    test('a finished drag still saves the new order', () => {
        const rig = loadRailPress();
        rig.api.holdScrollAnchor();
        rig.api.startDrag();
        rig.api.stop({}, { item: ['home'] });
        expect(rig.saved).toEqual(['home']);
        expect(rig.scroller.style.overflowAnchor).toBe('');
    });

    test('laying the rows out again first puts back a row still held', () => {
        const rig = loadRailPress();
        const { instance, calls } = draggingSortable(rig.api);
        rig.addGroup('primary', instance);
        rig.api.holdScrollAnchor();
        rig.api.startDrag();
        rig.api.applyCancel();
        expect(calls).toEqual(['cancel']);
        expect(rig.saved).toEqual([]);
        expect(rig.scroller.style.overflowAnchor).toBe('');

        const apply = sliceBlock(source, 'function applyNeconyanRailOrder() {');
        expect(apply).toMatch(/^function applyNeconyanRailOrder\(\) \{\n(?:\s*\/\/.*\n)*\s*cancelNeconyanRailPress\(\);/);
    });
});
