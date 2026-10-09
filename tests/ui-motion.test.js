/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

let motion, media, bodyClasses, preferenceChanged;
const elements = [];

beforeEach(async () => {
    jest.resetModules();
    bodyClasses = new Set();
    media = { matches: false, addEventListener: jest.fn() };
    globalThis.document = { body: { classList: { contains: value => bodyClasses.has(value) } } };
    globalThis.window = { matchMedia: () => media };
    globalThis.getComputedStyle = element => ({ visibility: 'visible', opacity: element.opacity ?? '1', translate: '0px 0px' });
    globalThis.MutationObserver = class {
        constructor(callback) { preferenceChanged = callback; }
        observe() {}
    };
    motion = await import('../public/scripts/ui-motion.js');
});

afterEach(() => {
    elements.splice(0).forEach(element => motion.finishUiMotion(element));
    for (const key of ['document', 'window', 'getComputedStyle', 'MutationObserver']) delete globalThis[key];
});

function surface(visible = true) {
    const animations = [];
    const element = {
        isConnected: true, visible, inert: false,
        getClientRects: () => element.visible ? [{}] : [],
        animate: jest.fn((frames, options) => {
            const animation = { cancel: jest.fn(), frames, options };
            animations.push(animation);
            return animation;
        }),
    };
    const apply = jest.fn(open => { element.visible = open; });
    elements.push(element);
    return { element, apply, animations };
}

describe('interruptible UI motion', () => {
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
});
