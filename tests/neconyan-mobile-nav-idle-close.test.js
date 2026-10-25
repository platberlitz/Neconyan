import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { resolveMobileNavOpenState } from '../public/scripts/mobile-shell-lifecycle/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');

const CLOSED_ICON = 'fa-compass';
const CLOSED_MARKUP = `<i class="fa-solid ${CLOSED_ICON}" aria-hidden="true"></i>`;
const OPEN_MARKUP = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';

function getFunctionSource(name) {
    const marker = `function ${name}(`;
    const start = tabsSource.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const paramsStart = tabsSource.indexOf('(', start);
    let parenDepth = 0;
    let paramsEnd = -1;

    for (let index = paramsStart; index < tabsSource.length; index++) {
        const char = tabsSource[index];
        if (char === '(') {
            parenDepth++;
        } else if (char === ')') {
            parenDepth--;
            if (parenDepth === 0) {
                paramsEnd = index;
                break;
            }
        }
    }

    expect(paramsEnd).toBeGreaterThan(paramsStart);

    const bodyStart = tabsSource.indexOf('{', paramsEnd);
    let depth = 0;

    for (let index = bodyStart; index < tabsSource.length; index++) {
        const char = tabsSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return tabsSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

class FakeElement {}

function createFakeElement({ attrs = {}, hidden = false, classes = [], innerHTML = '', inert = false } = {}) {
    const attributes = new Map(Object.entries(attrs));
    const classSet = new Set(classes);
    const writes = [];
    const element = Object.create(FakeElement.prototype);
    let hiddenValue = hidden;
    let inertValue = inert;
    let innerHTMLValue = innerHTML;

    Object.defineProperties(element, {
        hidden: {
            get: () => hiddenValue,
            set: value => {
                writes.push(['hidden', value]);
                hiddenValue = value;
            },
        },
        inert: {
            get: () => inertValue,
            set: value => {
                writes.push(['inert', value]);
                inertValue = value;
            },
        },
        innerHTML: {
            get: () => innerHTMLValue,
            set: value => {
                writes.push(['innerHTML', value]);
                innerHTMLValue = value;
            },
        },
        title: {
            get: () => attributes.get('title') ?? '',
            set: value => {
                writes.push(['title', value]);
                attributes.set('title', String(value));
            },
        },
    });

    element.writes = writes;
    element.classList = {
        contains: token => classSet.has(token),
        toggle: (token, force) => {
            writes.push(['toggle', token, force]);
            if (force) classSet.add(token);
            else classSet.delete(token);
        },
        remove: token => {
            writes.push(['remove', token]);
            classSet.delete(token);
        },
    };
    element.getAttribute = name => attributes.has(name) ? attributes.get(name) : null;
    element.hasAttribute = name => attributes.has(name);
    element.setAttribute = (name, value) => {
        writes.push(['setAttribute', name, String(value)]);
        attributes.set(name, String(value));
    };
    element.removeAttribute = name => {
        writes.push(['removeAttribute', name]);
        attributes.delete(name);
    };
    element.focus = () => writes.push(['focus']);
    element.contains = () => false;
    element.querySelector = () => null;

    return element;
}

function createDocumentStub(elements, { bodyClasses = ['neconyan'] } = {}) {
    return {
        body: {
            classList: {
                contains: token => bodyClasses.includes(token),
                remove: token => bodyClasses.splice(bodyClasses.indexOf(token), 1),
            },
        },
        activeElement: null,
        getElementById: id => elements.get(id) ?? null,
    };
}

function createMobileNavOpenStateHarness({ overlay, button }) {
    const elements = new Map([
        ['sb-mobile-nav', overlay],
        ['sb-hamburger', button],
    ]);
    const calls = { ensure: 0, refresh: 0, modal: 0, reset: 0, labels: 0, frames: 0 };
    const nnState = { mobileNav: { lastOpenedAt: 0 } };
    const document = createDocumentStub(elements);
    const window = {
        requestAnimationFrame: () => {
            calls.frames++;
            return calls.frames;
        },
    };
    const fn = new Function(
        'document',
        'window',
        'HTMLElement',
        'performance',
        'nnState',
        'nnMobileShellLifecycle',
        'ensureMobileNavReady',
        'isMobileViewport',
        'queueMobileModalStateSync',
        'refreshMobileNavQuickActions',
        'requestMobileViewportReset',
        'updateMobileNavButtonLabel',
        'NN_NECONYAN_MOBILE_NAV_CLOSED_ICON',
        'NN_MOBILE_NAV_CLOSED_ICON',
        `${getFunctionSource('setMobileNavOpenState')}\nreturn setMobileNavOpenState;`,
    )(
        document,
        window,
        FakeElement,
        { now: () => 1234 },
        nnState,
        { nav: { resolveOpenState: resolveMobileNavOpenState } },
        () => {
            calls.ensure++;
            return overlay;
        },
        () => true,
        () => { calls.modal++; },
        () => { calls.refresh++; },
        () => { calls.reset++; },
        () => { calls.labels++; },
        CLOSED_ICON,
        'fa-bars',
    );

    return { fn, calls, nnState, document };
}

function createClosedOverlay() {
    return createFakeElement({
        attrs: { 'aria-hidden': 'true' },
        hidden: true,
        inert: true,
    });
}

function createClosedButton() {
    return createFakeElement({
        attrs: { 'aria-expanded': 'false' },
        innerHTML: CLOSED_MARKUP,
    });
}

describe('mobile nav idle close', () => {
    test('closing before the nav exists does not create it or write button state', () => {
        const button = createClosedButton();
        const { fn, calls } = createMobileNavOpenStateHarness({ overlay: null, button });
        fn(false);
        expect(calls.ensure).toBe(0);
        expect(calls.refresh).toBe(0);
        expect(calls.modal).toBe(0);
        expect(button.writes).toEqual([]);
    });

    test('a close on an already closed nav performs no DOM writes and keeps quick actions', () => {
        const overlay = createClosedOverlay();
        const button = createClosedButton();
        const { fn, calls } = createMobileNavOpenStateHarness({ overlay, button });

        fn(false);

        expect(overlay.writes).toEqual([]);
        expect(button.writes).toEqual([]);
        expect(calls.refresh).toBe(0);
        expect(calls.modal).toBe(0);
        expect(calls.reset).toBe(0);
        expect(calls.labels).toBe(1);
    });

    test('a close repairs stale accessibility state without rebuilding quick actions', () => {
        const overlay = createFakeElement({
            attrs: { 'aria-hidden': 'false' },
            hidden: true,
            inert: false,
        });
        const button = createFakeElement({
            attrs: { 'aria-expanded': 'true' },
            innerHTML: CLOSED_MARKUP,
        });
        const { fn, calls } = createMobileNavOpenStateHarness({ overlay, button });

        fn(false);

        expect(overlay.writes).toEqual([
            ['setAttribute', 'aria-hidden', 'true'],
            ['inert', true],
        ]);
        expect(button.writes).toEqual([
            ['setAttribute', 'aria-expanded', 'false'],
        ]);
        expect(calls.refresh).toBe(0);
        expect(calls.modal).toBe(1);
        expect(calls.labels).toBe(1);
    });

    test('opening a closed nav applies its state and refreshes quick actions', () => {
        const overlay = createClosedOverlay();
        const button = createClosedButton();
        const { fn, calls, nnState } = createMobileNavOpenStateHarness({ overlay, button });

        fn(true);

        expect(overlay.writes).toEqual([
            ['hidden', false],
            ['toggle', 'sb-nav-open', true],
            ['setAttribute', 'aria-hidden', 'false'],
            ['inert', false],
        ]);
        expect(button.writes).toEqual([
            ['toggle', 'is-open', true],
            ['setAttribute', 'aria-expanded', 'true'],
            ['innerHTML', OPEN_MARKUP],
        ]);
        expect(calls.refresh).toBe(1);
        expect(calls.modal).toBe(1);
        expect(calls.frames).toBe(1);
        expect(nnState.mobileNav.lastOpenedAt).toBe(1234);
    });

    test('an open request on an open nav still refreshes quick actions without rewriting state', () => {
        const overlay = createFakeElement({
            attrs: { 'aria-hidden': 'false' },
            hidden: false,
            classes: ['sb-nav-open'],
            inert: false,
        });
        const button = createFakeElement({
            attrs: { 'aria-expanded': 'true' },
            classes: ['is-open'],
            innerHTML: OPEN_MARKUP,
        });
        const { fn, calls } = createMobileNavOpenStateHarness({ overlay, button });

        fn(true);

        expect(overlay.writes).toEqual([]);
        expect(button.writes).toEqual([]);
        expect(calls.refresh).toBe(1);
        expect(calls.modal).toBe(0);
    });
});

describe('mobile nav quick action refs', () => {
    test('binds an existing list without rebuilding its buttons', () => {
        const section = createFakeElement();
        const list = createFakeElement();
        list.closest = selector => selector === '.sb-mobile-quick-action-section' ? section : null;
        const overlay = createFakeElement();
        overlay.querySelector = selector => selector === '.sb-mobile-quick-action-list' ? list : null;
        const nnState = { mobileNav: {} };
        let refreshes = 0;
        const bindRefs = new Function(
            'HTMLElement',
            'nnState',
            'refreshMobileNavQuickActions',
            `${getFunctionSource('syncExistingMobileNavQuickActions')}\nreturn syncExistingMobileNavQuickActions;`,
        )(FakeElement, nnState, () => { refreshes++; });

        bindRefs(overlay);

        expect(refreshes).toBe(0);
        expect(nnState.mobileNav.quickActionContainer).toBe(list);
        expect(nnState.mobileNav.quickActionSection).toBe(section);
    });
});

describe('mobile nav button label', () => {
    function createLabelHarness({ button, overlay }) {
        const document = createDocumentStub(new Map([
            ['sb-hamburger', button],
            ['sb-mobile-nav', overlay],
        ]));
        const translateTag = (strings, ...values) => strings.reduce((result, text, index) => `${result}${text}${values[index] ?? ''}`, '');
        const updateLabel = new Function(
            'document',
            'HTMLElement',
            'getMobileNavReplacementTargetConfig',
            't',
            'translate',
            'nnState',
            `${getFunctionSource('updateMobileNavButtonLabel')}\nreturn updateMobileNavButtonLabel;`,
        )(
            document,
            FakeElement,
            () => ({ label: 'Connections' }),
            translateTag,
            value => value,
            { mobileNav: { replaceQuickActions: false } },
        );

        return updateLabel;
    }

    test('leaves a matching label alone', () => {
        const button = createFakeElement({
            attrs: { 'aria-label': 'Open menu' },
            innerHTML: CLOSED_MARKUP,
        });
        button.title = 'Open menu';
        button.writes.length = 0;
        const updateLabel = createLabelHarness({ button, overlay: createClosedOverlay() });

        updateLabel();

        expect(button.writes).toEqual([]);
    });

    test('replaces a stale label when the nav state changes', () => {
        const button = createFakeElement({
            attrs: { 'aria-label': 'Close menu' },
            innerHTML: CLOSED_MARKUP,
        });
        button.title = 'Close menu';
        button.writes.length = 0;
        const updateLabel = createLabelHarness({ button, overlay: createClosedOverlay() });

        updateLabel();

        expect(button.writes).toEqual([
            ['title', 'Open menu'],
            ['setAttribute', 'aria-label', 'Open menu'],
        ]);
    });
});

describe('workspace rail idle close', () => {
    function createRailHarness({ rail, button, scrim, isRailOpen = false, mobile = true, closing = null }) {
        const calls = { setUiVisibility: 0, exclusivity: 0, nav: 0, reset: 0, labels: 0, scrims: 0 };
        const bodyClasses = ['neconyan'];
        const document = {
            body: {
                classList: {
                    contains: token => bodyClasses.includes(token),
                    remove: token => bodyClasses.splice(bodyClasses.indexOf(token), 1),
                },
            },
            getElementById: id => id === 'neconyan-workspace-rail' ? rail : id === 'sb-hamburger' ? button : null,
        };
        const fn = new Function(
            'document',
            'HTMLElement',
            'nnMobileShellLifecycle',
            'isNeconyanRailDrawerOpen',
            'isUiClosing',
            'ensureNeconyanRailScrim',
            'setUiVisibility',
            'applyMobileSurfaceExclusivity',
            'setMobileNavOpenState',
            'updateMobileNavButtonLabel',
            'requestMobileViewportReset',
            'isMobileViewport',
            'NN_NECONYAN_MOBILE_NAV_CLOSED_ICON',
            `${getFunctionSource('setNeconyanRailDrawerOpen')}\nreturn setNeconyanRailDrawerOpen;`,
        )(
            document,
            FakeElement,
            { overlays: { resolveExclusiveOpen: () => ({ closeSurfaces: [] }), surface: { RAIL_DRAWER: 'rail' } } },
            () => isRailOpen,
            element => element === closing,
            () => {
                calls.scrims++;
                return scrim;
            },
            () => { calls.setUiVisibility++; },
            () => { calls.exclusivity++; },
            () => { calls.nav++; },
            () => { calls.labels++; },
            () => { calls.reset++; },
            () => mobile,
            CLOSED_ICON,
        );

        return { fn, calls, bodyClasses };
    }

    function createRailButton() {
        return createFakeElement({
            attrs: { 'aria-expanded': 'false' },
            innerHTML: CLOSED_MARKUP,
        });
    }

    test('a close on an already closed rail performs no DOM writes', () => {
        const rail = createFakeElement({
            attrs: { 'aria-hidden': 'true' },
            inert: true,
        });
        const button = createRailButton();
        const scrim = createFakeElement({ hidden: true });
        const { fn, calls } = createRailHarness({ rail, button, scrim });

        fn(false);

        expect(rail.writes).toEqual([]);
        expect(button.writes).toEqual([]);
        expect(scrim.writes).toEqual([]);
        expect(calls.setUiVisibility).toBe(0);
        expect(calls.exclusivity).toBe(0);
        expect(calls.nav).toBe(0);
        expect(calls.reset).toBe(0);
        expect(calls.labels).toBe(1);
    });

    test('a close repairs stale rail state and restores focus on request', () => {
        const rail = createFakeElement({
            attrs: { 'aria-hidden': 'false' },
            inert: false,
        });
        const button = createFakeElement({
            attrs: { 'aria-expanded': 'true' },
            classes: ['is-open'],
            innerHTML: OPEN_MARKUP,
        });
        const scrim = createFakeElement({ hidden: false });
        const { fn, calls } = createRailHarness({ rail, button, scrim });

        fn(false, { restoreFocus: true });

        expect(scrim.writes).toEqual([['hidden', true]]);
        expect(rail.writes).toEqual([
            ['inert', true],
            ['setAttribute', 'aria-hidden', 'true'],
        ]);
        expect(button.writes).toEqual([
            ['remove', 'is-open'],
            ['setAttribute', 'aria-expanded', 'false'],
            ['innerHTML', CLOSED_MARKUP],
            ['focus'],
        ]);
        expect(calls.setUiVisibility).toBe(0);
        expect(calls.reset).toBe(0);
        expect(calls.labels).toBe(1);
    });

    test('a desktop idle close restores rail accessibility', () => {
        const rail = createFakeElement({ attrs: { 'aria-hidden': 'true' }, inert: true });
        const { fn, calls } = createRailHarness({
            rail, button: createRailButton(), scrim: createFakeElement({ hidden: true }), mobile: false,
        });
        fn(false);
        expect(rail.inert).toBe(false);
        expect(rail.hasAttribute('aria-hidden')).toBe(false);
        expect(calls.setUiVisibility).toBe(0);
    });

    test('an in-progress rail close keeps the normal motion path', () => {
        const rail = createFakeElement();
        const { fn, calls } = createRailHarness({
            rail, button: createRailButton(), scrim: createFakeElement(), closing: rail,
        });
        fn(false);
        expect(calls.setUiVisibility).toBe(2);
    });

    test('a settled rail does not cut off the remaining scrim fade', () => {
        const scrim = createFakeElement({ hidden: false });
        const { fn } = createRailHarness({
            rail: createFakeElement({ attrs: { 'aria-hidden': 'true' }, inert: true }),
            button: createRailButton(), scrim, closing: scrim,
        });
        fn(false);
        expect(scrim.hidden).toBe(false);
        expect(scrim.writes).toEqual([]);
    });
});
