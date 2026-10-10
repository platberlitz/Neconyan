/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

let motion, media, bodyClasses, preferenceChanged, pendingFrames, pressed, bars;
const elements = [];

beforeEach(async () => {
    jest.resetModules();
    bodyClasses = new Set();
    pendingFrames = null;
    media = { matches: false, addEventListener: jest.fn() };
    bars = {};
    globalThis.document = {
        body: { classList: { contains: value => bodyClasses.has(value) } },
        addEventListener: (type, listener) => { if (type === 'click') pressed = listener; },
        querySelector: selector => bars[selector] ?? null,
    };
    globalThis.window = { matchMedia: () => media };
    // Frames run at once unless a test queues them to step through the first paint.
    globalThis.requestAnimationFrame = callback => pendingFrames ? pendingFrames.push(callback) : callback();
    globalThis.getComputedStyle = element => ({ visibility: 'visible', opacity: element.opacity ?? '1', translate: element.translate ?? '0px 0px', zIndex: element.zIndex ?? 'auto' });
    globalThis.MutationObserver = class {
        constructor(callback) { preferenceChanged = callback; }
        observe() {}
    };
    motion = await import('../public/scripts/ui-motion.js');
});

afterEach(() => {
    elements.splice(0).forEach(element => motion.finishUiMotion(element));
    for (const key of ['document', 'window', 'getComputedStyle', 'MutationObserver', 'requestAnimationFrame']) delete globalThis[key];
});

function surface(visible = true) {
    const animations = [];
    const declarations = new Map();
    const element = {
        isConnected: true, visible, inert: false,
        style: {
            getPropertyValue: name => declarations.get(name)?.[0] ?? '',
            getPropertyPriority: name => declarations.get(name)?.[1] ?? '',
            setProperty: (name, value, priority = '') => value ? declarations.set(name, [value, priority]) : declarations.delete(name),
        },
        getClientRects: () => element.visible ? [{}] : [],
        animate: jest.fn((frames, options) => {
            const animation = { cancel: jest.fn(), play: jest.fn(), frames, options, currentTime: null, playState: 'running' };
            animations.push(animation);
            return animation;
        }),
    };
    const apply = jest.fn(open => { element.visible = open; });
    elements.push(element);
    return { element, apply, animations };
}

describe('interruptible UI motion', () => {
    test.each([
        ['left', '-100% 0'], ['right', '100% 0'], ['top', '0 -100%'], ['bottom', '0 100%'],
    ])('%s drawers leave through their entry edge and reverse from the current position', (edge, translate) => {
        const { element, apply, animations } = surface(false);
        motion.setUiVisibility(element, true, apply, { edge });
        expect(animations[0].frames).toEqual([{ opacity: 1, translate }, { opacity: 1, translate: '0 0' }]);
        animations[0].onfinish();
        motion.setUiVisibility(element, false, apply, { edge });
        expect(animations[1].frames).toEqual([...animations[0].frames].reverse());
        expect(element.visible).toBe(true);
        expect(element.inert).toBe(true);
        element.translate = translate.replace('100%', '110px');
        const obsoleteFinish = animations[1].onfinish;
        motion.setUiVisibility(element, true, apply, { edge });
        obsoleteFinish();
        expect(animations[2].frames[0].translate).toBe(element.translate);
        expect(element.visible).toBe(true);
        expect(element.inert).toBe(false);
    });

    test('closing disables interaction immediately and hides only after its short exit', () => {
        const { element, apply, animations } = surface();
        motion.setUiVisibility(element, false, apply);
        expect(element.inert).toBe(true);
        expect(element.visible).toBe(true);
        expect(motion.isUiClosing(element)).toBe(true);
        expect(apply).not.toHaveBeenCalled();
        animations[0].onfinish();
        expect(element.inert).toBe(false);
        expect(element.visible).toBe(false);
        expect(motion.isUiClosing(element)).toBe(false);
        expect(animations[0].cancel).toHaveBeenCalledTimes(1);
    });

    test('a closing surface lets taps through to what lies beneath, then gets its own value back', () => {
        const { element, apply, animations } = surface();
        element.style.setProperty('pointer-events', 'auto');
        motion.setUiVisibility(element, false, apply);
        expect(element.style.getPropertyValue('pointer-events')).toBe('none');
        expect(element.style.getPropertyPriority('pointer-events')).toBe('important');
        animations[0].onfinish();
        expect(element.style.getPropertyValue('pointer-events')).toBe('auto');
        expect(element.style.getPropertyPriority('pointer-events')).toBe('');

        const fresh = surface();
        motion.setUiVisibility(fresh.element, false, fresh.apply);
        motion.setUiVisibility(fresh.element, true, fresh.apply);
        expect(fresh.element.style.getPropertyValue('pointer-events')).toBe('');
    });

    test('reopening cancels an obsolete hide even if its completion was already queued', () => {
        const { element, apply, animations } = surface();
        motion.setUiVisibility(element, false, apply);
        const oldFinish = animations[0].onfinish;
        element.opacity = '0.4';
        motion.setUiVisibility(element, true, apply);
        oldFinish();
        expect(element.visible).toBe(true);
        expect(element.inert).toBe(false);
        expect(apply.mock.calls).toEqual([[true]]);
        expect(animations[1].frames[0].opacity).toBe('0.4');
        animations[1].onfinish();
        expect(element.visible).toBe(true);
    });

    test('repeated closes cannot extend the exit or run competing callbacks', () => {
        const { element, apply, animations } = surface();
        motion.setUiVisibility(element, false, apply);
        motion.setUiVisibility(element, false, apply);
        expect(animations).toHaveLength(1);
        motion.finishUiMotion(element);
        expect(apply).toHaveBeenCalledTimes(1);
    });

    test('repeated opens keep the in-flight arrival instead of snapping to its end', () => {
        const { element, apply, animations } = surface(false);
        motion.setUiVisibility(element, true, apply);
        motion.setUiVisibility(element, true, apply);
        expect(animations).toHaveLength(1);
        expect(animations[0].cancel).not.toHaveBeenCalled();
        animations[0].onfinish();
        expect(element.visible).toBe(true);
    });

    test.each(['app', 'device'])('%s reduced motion applies visibility synchronously', preference => {
        if (preference === 'app') bodyClasses.add('reduced-motion');
        else media.matches = true;
        const { element, apply } = surface(false);
        motion.setUiVisibility(element, true, apply);
        motion.revealUi(element);
        motion.setUiVisibility(element, false, apply);
        expect(apply.mock.calls).toEqual([[true], [false]]);
        expect(element.animate).not.toHaveBeenCalled();
    });

    test.each(['app', 'device'])('changing %s motion preference settles an active close', preference => {
        const { element, apply } = surface();
        motion.setUiVisibility(element, false, apply);
        if (preference === 'app') {
            bodyClasses.add('reduced-motion');
            preferenceChanged();
        } else {
            media.matches = true;
            media.addEventListener.mock.calls[0][1]();
        }
        expect(element.visible).toBe(false);
        expect(element.inert).toBe(false);
    });

    test('hidden content and browsers without the animation API remain functional', () => {
        const { element, apply } = surface(false);
        motion.revealUi(element);
        expect(element.animate).not.toHaveBeenCalled();
        delete element.animate;
        motion.setUiVisibility(element, true, apply);
        expect(element.visible).toBe(true);
        motion.setUiVisibility(element, false, apply);
        expect(element.visible).toBe(false);
    });

    test('reveals leave no persistent effect or change to scroll position', () => {
        const { element, animations } = surface();
        element.scrollTop = 375;
        motion.revealUi(element);
        animations[0].onfinish();
        expect(element.scrollTop).toBe(375);
        expect(animations[0].cancel).toHaveBeenCalledTimes(1);
        expect(animations[0].frames.every(frame => Object.keys(frame).every(key => ['opacity', 'translate'].includes(key)))).toBe(true);
    });

    test('a second reveal leaves an arrival under way alone, and plays again once it settles', () => {
        const { element, animations } = surface();
        motion.revealUi(element);
        motion.revealUi(element);
        expect(animations).toHaveLength(1);
        expect(animations[0].cancel).not.toHaveBeenCalled();
        animations[0].onfinish();
        motion.revealUi(element);
        expect(animations).toHaveLength(2);
    });

    test('drawers glide on the iOS sheet curve for longer than menus fade', () => {
        const drawer = surface(false);
        motion.setUiVisibility(drawer.element, true, drawer.apply, { edge: 'left' });
        drawer.animations[0].onfinish();
        motion.setUiVisibility(drawer.element, false, drawer.apply, { edge: 'left' });
        const menu = surface(false);
        motion.setUiVisibility(menu.element, true, menu.apply);
        menu.animations[0].onfinish();
        motion.setUiVisibility(menu.element, false, menu.apply);

        const { drawerInMs, drawerOutMs, fadeInMs, fadeOutMs } = motion.UI_MOTION_TIMING;
        expect(drawer.animations.map(animation => animation.options.duration)).toEqual([drawerInMs, drawerOutMs]);
        expect(menu.animations.map(animation => animation.options.duration)).toEqual([fadeInMs, fadeOutMs]);
        expect(drawerInMs).toBeGreaterThanOrEqual(340);
        expect(drawerOutMs).toBeGreaterThanOrEqual(240);
        expect(drawerOutMs).toBeLessThan(drawerInMs);
        expect(fadeInMs).toBeGreaterThanOrEqual(200);
        expect(fadeOutMs).toBeLessThan(fadeInMs);
        expect(drawer.animations[0].options.easing).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
        expect(menu.animations[0].options.easing).toBe('cubic-bezier(0.22, 1, 0.36, 1)');
    });

    test('a scrim paced with its drawer fades on the drawer timing', () => {
        const { element, apply, animations } = surface(false);
        motion.setUiVisibility(element, true, apply, { distance: 0, drawerPace: true });
        expect(animations[0].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
        expect(animations[0].options).toMatchObject({ duration: motion.UI_MOTION_TIMING.drawerInMs, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
    });

    test('a surface that does not travel leaves the translate that positions it alone', () => {
        const { element, apply, animations } = surface(false);
        motion.setUiVisibility(element, true, apply, { distance: 0 });
        element.opacity = '0.4';
        element.translate = '0px -100%';
        motion.setUiVisibility(element, false, apply, { distance: 0 });
        expect(animations[1].frames).toEqual([{ opacity: '0.4' }, { opacity: 0 }]);
        expect(animations.flatMap(animation => animation.frames).some(frame => 'translate' in frame)).toBe(false);

        const reveal = surface(true);
        motion.revealUi(reveal.element, { distance: 0 });
        expect(reveal.animations[0].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    });

    test('a blurred overlay fades in place while only its panel slides from the edge', () => {
        const { element, apply, animations } = surface(false);
        const panel = surface(false);
        motion.setUiVisibility(element, true, apply, { edge: 'right', slideTarget: panel.element });
        expect(animations[0].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
        expect(panel.animations[0].frames).toEqual([{ translate: '100% 0' }, { translate: '0 0' }]);
        expect(panel.animations[0].options.duration).toBe(animations[0].options.duration);
        animations[0].onfinish();
        expect(panel.animations[0].cancel).toHaveBeenCalledTimes(1);

        motion.setUiVisibility(element, false, apply, { edge: 'right', slideTarget: panel.element });
        expect(panel.animations[1].frames).toEqual([{ translate: '0 0' }, { translate: '100% 0' }]);
        expect(element.visible).toBe(true);
        panel.element.translate = '40px 0px';
        motion.setUiVisibility(element, true, apply, { edge: 'right', slideTarget: panel.element });
        expect(panel.animations[1].cancel).toHaveBeenCalledTimes(1);
        expect(panel.animations[2].frames[0]).toEqual({ translate: '40px 0px' });
        expect(element.visible).toBe(true);
    });

    test('the first frame rewinds a drawer and its linked parts, so tap work cannot eat the slide', () => {
        pendingFrames = [];
        const { element, apply, animations } = surface(false);
        const panel = surface(false);
        motion.setUiVisibility(element, true, apply, { edge: 'right', slideTarget: panel.element });
        // Safari has already advanced the clock by the time the tap's work is done.
        animations[0].currentTime = 220;
        panel.animations[0].currentTime = 220;
        pendingFrames.shift()();
        expect(animations[0].currentTime).toBe(0);
        expect(panel.animations[0].currentTime).toBe(0);
        expect(animations[0].play).not.toHaveBeenCalled();
    });

    test('a slide that ran out before its first frame plays again instead of snapping open or shut', () => {
        pendingFrames = [];
        const { element, apply, animations } = surface();
        motion.setUiVisibility(element, false, apply, { edge: 'right' });
        animations[0].currentTime = 280;
        animations[0].playState = 'finished';
        animations[0].onfinish();
        expect(element.visible).toBe(true);
        expect(motion.isUiClosing(element)).toBe(true);
        expect(animations[0].currentTime).toBe(0);
        expect(animations[0].play).toHaveBeenCalledTimes(1);
        pendingFrames.shift()();
        animations[0].onfinish();
        expect(element.visible).toBe(false);
    });

    test('a hidden page settles its motion without waiting for a frame that never comes', () => {
        pendingFrames = [];
        globalThis.document.hidden = true;
        const { element, apply, animations } = surface();
        motion.setUiVisibility(element, false, apply, { edge: 'right' });
        animations[0].onfinish();
        expect(element.visible).toBe(false);
    });

    test('a motion cancelled before its first frame is not rewound afterwards', () => {
        pendingFrames = [];
        const { element, apply, animations } = surface();
        motion.setUiVisibility(element, false, apply, { edge: 'right' });
        motion.finishUiMotion(element);
        animations[0].currentTime = 140;
        pendingFrames.shift()();
        expect(animations[0].currentTime).toBe(140);
    });

    test('visibility checks read styles instead of forcing a layout when the browser can', () => {
        const { element, apply, animations } = surface(true);
        element.checkVisibility = jest.fn(() => true);
        element.getClientRects = jest.fn(() => { throw new Error('forced layout'); });
        motion.setUiVisibility(element, false, apply, { edge: 'left' });
        expect(element.checkVisibility).toHaveBeenCalledWith({ visibilityProperty: true });
        expect(animations).toHaveLength(1);
    });
});

describe('motion that follows what was pressed', () => {
    const press = selector => pressed({ target: { closest: candidate => candidate === selector ? {} : null } });

    test('a page opened from the top bar drops from it and goes back up when it closes', () => {
        const page = { dataset: {} };
        press('#top-bar');
        expect(motion.getUiDrawerEdge(page, true, 'left')).toBe('top');
        expect(motion.getUiDrawerEdge(page, false, 'left')).toBe('top');
    });

    test('a page opened from the sidebar slides out of it, and one opened elsewhere keeps its own side', () => {
        const page = { dataset: {} };
        press('#neconyan-workspace-rail');
        expect(motion.getUiDrawerEdge(page, true, 'right')).toBe('left');
        press('#chat');
        expect(motion.getUiDrawerEdge(page, true, 'right')).toBe('right');
        expect(motion.getUiDrawerEdge(page, false, 'right')).toBe('right');
    });

    test('a tap counts for one opening and only for a moment', () => {
        const now = jest.spyOn(performance, 'now').mockReturnValue(1000);
        const page = { dataset: {} };
        press('#top-bar');
        expect(motion.getUiDrawerEdge(page, true, 'left')).toBe('top');
        expect(motion.getUiDrawerEdge(page, true, 'left')).toBe('left');
        press('#top-bar');
        now.mockReturnValue(2500);
        expect(motion.getUiDrawerEdge(page, true, 'left')).toBe('left');
        now.mockRestore();
    });

    test('the top bar stays in front of a page travelling to or from it, then gets its own value back', () => {
        const { element, apply, animations } = surface(false);
        const holder = { zIndex: '1100', parentElement: globalThis.document.body };
        Object.assign(element, { dataset: {}, parentElement: holder });
        const topBar = surface();
        topBar.element.contains = () => false;
        bars['#top-bar'] = topBar.element;
        press('#top-bar');
        const edge = motion.getUiDrawerEdge(element, true, 'left');
        motion.setUiVisibility(element, true, apply, { edge });
        expect(animations[0].frames[0]).toEqual({ opacity: 1, translate: '0 -100%' });
        expect(topBar.element.style.getPropertyValue('z-index')).toBe('1101');
        expect(topBar.element.style.getPropertyPriority('z-index')).toBe('important');
        animations[0].onfinish();
        expect(topBar.element.style.getPropertyValue('z-index')).toBe('');
        motion.setUiVisibility(element, false, apply, { edge: motion.getUiDrawerEdge(element, false, 'left') });
        expect(topBar.element.style.getPropertyValue('z-index')).toBe('1101');
        animations[1].onfinish();
        expect(topBar.element.style.getPropertyValue('z-index')).toBe('');
    });

    test('a page on its own side leaves the bars where they are', () => {
        const { element, apply } = surface(false);
        element.dataset = {};
        const topBar = surface();
        topBar.element.contains = () => false;
        bars['#top-bar'] = topBar.element;
        motion.setUiVisibility(element, true, apply, { edge: motion.getUiDrawerEdge(element, true, 'left') });
        expect(topBar.element.style.getPropertyValue('z-index')).toBe('');
    });
});

describe('chat and swipe motion', () => {
    test('an opened chat rises further and more slowly than a menu reveal', () => {
        const { element, animations } = surface();
        motion.revealChat(element);
        expect(animations[0].frames).toEqual([{ opacity: 0, translate: '0 16px' }, { opacity: 1, translate: '0 0' }]);
        expect(animations[0].options.duration).toBe(motion.UI_MOTION_TIMING.chatRevealMs);
        expect(motion.UI_MOTION_TIMING.chatRevealMs).toBeGreaterThan(motion.UI_MOTION_TIMING.revealMs);
    });
});
