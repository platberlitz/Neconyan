import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

import { OFFSCREEN_ATTRIBUTE, createOffscreenMotionPauser } from '../public/scripts/chat-offscreen-motion.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');

function createMessage(className = 'mes') {
    const attributes = new Set();
    const writes = [];
    return {
        nodeType: 1,
        writes,
        classList: { contains: name => className.split(' ').includes(name) },
        hasAttribute: name => attributes.has(name),
        toggleAttribute(name, force) {
            writes.push(force);
            if (force) attributes.add(name);
            else attributes.delete(name);
        },
        removeAttribute: name => attributes.delete(name),
    };
}

function createHarness(children) {
    const state = { observed: new Set(), intersect: null, mutate: null, options: null, disconnected: 0 };
    class Intersections {
        constructor(callback, options) {
            state.intersect = callback;
            state.options = options;
        }
        observe(node) { state.observed.add(node); }
        unobserve(node) { state.observed.delete(node); }
        disconnect() { state.disconnected += 1; }
    }
    class Mutations {
        constructor(callback) { state.mutate = callback; }
        observe(target, options) { state.mutationTarget = { target, options }; }
        disconnect() { state.disconnected += 1; }
    }
    const chat = {
        children,
        querySelectorAll: () => children.filter(child => child.hasAttribute(OFFSCREEN_ATTRIBUTE)),
    };
    const pauser = createOffscreenMotionPauser({ chat, IntersectionObserver: Intersections, MutationObserver: Mutations });
    return { state, chat, pauser };
}

describe('off-screen chat motion', () => {
    it('marks messages that leave the view and clears the mark when they return', () => {
        const message = createMessage();
        const { state } = createHarness([message]);

        expect(state.options).toEqual({ rootMargin: '300px 0px' });
        state.intersect([{ target: message, isIntersecting: false }]);
        expect(message.hasAttribute(OFFSCREEN_ATTRIBUTE)).toBe(true);

        state.intersect([{ target: message, isIntersecting: true }]);
        expect(message.hasAttribute(OFFSCREEN_ATTRIBUTE)).toBe(false);
    });

    it('writes the attribute only when the state changes', () => {
        const message = createMessage();
        const { state } = createHarness([message]);

        state.intersect([{ target: message, isIntersecting: true }]);
        state.intersect([{ target: message, isIntersecting: false }]);
        state.intersect([{ target: message, isIntersecting: false }]);

        expect(message.writes).toEqual([true]);
    });

    it('watches message rows only, including ones added later, and drops removed ones', () => {
        const first = createMessage();
        const other = createMessage('typing_indicator');
        const { state, chat } = createHarness([first, other]);

        expect(state.mutationTarget).toEqual({ target: chat, options: { childList: true } });
        expect([...state.observed]).toEqual([first]);

        const added = createMessage('mes last_mes');
        state.mutate([{ addedNodes: [added, { nodeType: 3 }], removedNodes: [first] }]);
        expect([...state.observed]).toEqual([added]);
    });

    it('clears every mark when destroyed', () => {
        const message = createMessage();
        const { state, pauser } = createHarness([message]);
        state.intersect([{ target: message, isIntersecting: false }]);

        pauser.destroy();

        expect(message.hasAttribute(OFFSCREEN_ATTRIBUTE)).toBe(false);
        expect(state.disconnected).toBe(2);
    });

    it('does nothing where the browser lacks the observers', () => {
        expect(createOffscreenMotionPauser({ chat: {}, IntersectionObserver: undefined, MutationObserver: undefined })).toBeNull();
        expect(createOffscreenMotionPauser({ chat: null })).toBeNull();
    });

    it('is loaded with the app and paired with a rule that pauses marked messages', () => {
        expect(read('public/script.js')).toContain('import \'./scripts/chat-offscreen-motion.js\';');
        const rule = read('public/css/neconyan.css').match(/#chat > \.mes\[data-nn-offscreen\] \*,[^{]*\{([^}]*)\}/);
        expect(rule?.[0]).toContain('*::before');
        expect(rule?.[0]).toContain('*::after');
        expect(rule?.[1]).toContain('animation-play-state: paused !important;');
    });

    it('moves every animated regex theme glow in steps rather than on every frame', () => {
        const css = read('public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/style.css');
        const animations = css.match(/animation: rat-[a-z0-9-]+ [^;]*infinite;/g) ?? [];

        expect(animations).toHaveLength(26);
        for (const animation of animations) expect(animation).toMatch(/ steps\(\d+\) infinite;$/);
    });
});
