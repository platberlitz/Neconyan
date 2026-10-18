/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

const STYLE_ID = 'csss--css-snippets';

function classListOf(classes = []) {
    const values = new Set(classes);
    return {
        add: (...names) => names.forEach(name => values.add(name)),
        remove: (...names) => names.forEach(name => values.delete(name)),
        contains: name => values.has(name),
        toggle: (name, force) => {
            const next = force === undefined ? !values.has(name) : Boolean(force);
            if (next) values.add(name); else values.delete(name);
            return next;
        },
        values: () => [...values],
    };
}

function installBrowserStubs({ theme = 'Calico', snippets = [], themeSelectPresent = true } = {}) {
    const elements = new Map();
    const documentListeners = new Map();
    const windowListeners = new Map();
    const observers = [];
    const animationFrames = new Map();
    const intervals = new Map();
    const timers = new Map();
    let nextId = 0;
    let themeValue = theme;
    const themeReads = jest.fn();

    const makeClassList = classes => classListOf(classes);

    function makeStyleElement() {
        const element = {
            id: '',
            textContent: '',
            media: '',
            tagName: 'STYLE',
            remove: jest.fn(() => {
                if (element.id) elements.delete(element.id);
            }),
        };
        Object.defineProperty(element, 'sheet', {
            get() {
                return {
                    cssRules: element.textContent ? [{ cssText: element.textContent }] : [],
                };
            },
        });
        return element;
    }

    function makeElement(tag = 'div', props = {}) {
        const element = {
            tagName: String(tag).toUpperCase(),
            id: '',
            className: '',
            textContent: '',
            innerHTML: '',
            value: '',
            checked: false,
            style: {},
            dataset: {},
            classList: makeClassList(),
            children: [],
            parentElement: null,
            remove: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            querySelector: jest.fn(() => makeElement('div')),
            querySelectorAll: jest.fn(() => []),
            closest: jest.fn(() => null),
            insertBefore: jest.fn(),
            prepend: jest.fn(),
            appendChild: jest.fn(child => {
                element.children.push(child);
                child.parentElement = element;
                return child;
            }),
            append: jest.fn(),
            getClientRects: jest.fn(() => []),
            ...props,
        };
        return element;
    }

    const documentElement = makeElement('html');
    const body = makeElement('body');
    const head = makeElement('head');
    head.append = jest.fn(node => {
        if (node.id) elements.set(node.id, node);
    });
    const themeSelect = themeSelectPresent ? makeElement('select', { id: 'themes' }) : null;
    if (themeSelect) elements.set('themes', themeSelect);

    const document = {
        documentElement,
        body,
        head,
        visibilityState: 'visible',
        readyState: 'complete',
        createElement: jest.fn(tag => tag === 'style' ? makeStyleElement() : makeElement(tag)),
        getElementById: jest.fn(id => elements.get(id) ?? null),
        querySelector: jest.fn(() => null),
        querySelectorAll: jest.fn(() => []),
        addEventListener: jest.fn((name, handler) => {
            if (!documentListeners.has(name)) documentListeners.set(name, new Set());
            documentListeners.get(name).add(handler);
        }),
        removeEventListener: jest.fn((name, handler) => {
            documentListeners.get(name)?.delete(handler);
        }),
    };
    const window = {
        addEventListener: jest.fn((name, handler) => {
            if (!windowListeners.has(name)) windowListeners.set(name, new Set());
            windowListeners.get(name).add(handler);
        }),
        removeEventListener: jest.fn((name, handler) => {
            windowListeners.get(name)?.delete(handler);
        }),
    };

    class MutationObserver {
        constructor(callback) {
            this.callback = callback;
            this.observations = [];
            this.observe = jest.fn((target, options) => {
                this.observations.push({ target, options });
            });
            this.disconnect = jest.fn(() => {
                this.disconnected = true;
            });
            observers.push(this);
        }
    }

    const eventHandlers = new Map();
    const eventSource = {
        on: jest.fn((event, handler) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
            eventHandlers.get(event).add(handler);
        }),
        removeListener: jest.fn((event, handler) => {
            eventHandlers.get(event)?.delete(handler);
        }),
        emit(event, payload) {
            for (const handler of [...(eventHandlers.get(event) ?? [])]) {
                handler(payload);
            }
        },
    };
    const powerUserSettings = {};
    Object.defineProperty(powerUserSettings, 'theme', {
        configurable: true,
        enumerable: true,
        get() {
            themeReads();
            return themeValue;
        },
        set(value) {
            themeValue = value;
        },
    });
    const context = {
        extensionSettings: {
            cssSnippets: {
                watchInterval: 500,
                snippetList: snippets,
                filters: {},
                themeSnippets: {},
            },
        },
        powerUserSettings,
        characterId: 0,
        characters: [{ avatar: 'alice.png', name: 'Alice' }],
        groupId: null,
        groups: [],
        eventSource,
        eventTypes: {
            CHAT_CHANGED: 'chat_changed',
            SETTINGS_UPDATED: 'settings_updated',
            SETTINGS_LOADED_AFTER: 'settings_loaded_after',
            EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
            SETTINGS_LOADED: 'settings_loaded',
        },
        saveSettingsDebounced: jest.fn(),
        translate: text => text,
        uuidv4: () => `id-${++nextId}`,
    };
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        MutationObserver: globalThis.MutationObserver,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        SillyTavern: globalThis.SillyTavern,
    };
    globalThis.document = document;
    globalThis.window = window;
    globalThis.MutationObserver = MutationObserver;
    globalThis.requestAnimationFrame = jest.fn(callback => {
        const id = ++nextId;
        animationFrames.set(id, callback);
        return id;
    });
    globalThis.cancelAnimationFrame = jest.fn(id => animationFrames.delete(id));
    globalThis.setInterval = jest.fn((callback, delay) => {
        const id = ++nextId;
        intervals.set(id, { callback, delay });
        return id;
    });
    globalThis.clearInterval = jest.fn(id => intervals.delete(id));
    globalThis.setTimeout = jest.fn((callback, delay) => {
        const id = ++nextId;
        timers.set(id, { callback, delay });
        return id;
    });
    globalThis.clearTimeout = jest.fn(id => timers.delete(id));
    globalThis.SillyTavern = { getContext: () => context };

    return {
        context,
        document,
        window,
        body,
        themeSelect,
        eventSource,
        observers,
        intervals,
        themeReads,
        setTheme(value) {
            powerUserSettings.theme = value;
        },
        style() {
            return elements.get(STYLE_ID) ?? null;
        },
        dispatchDocument(name, event) {
            for (const handler of [...(documentListeners.get(name) ?? [])]) {
                handler(event);
            }
        },
        dispatchWindow(name, event) {
            for (const handler of [...(windowListeners.get(name) ?? [])]) {
                handler(event);
            }
        },
        flushAnimationFrames() {
            const entries = [...animationFrames.entries()];
            animationFrames.clear();
            for (const [, callback] of entries) {
                callback();
            }
        },
        runFallback() {
            for (const { callback } of intervals.values()) {
                callback();
            }
        },
        observerFor(target) {
            return observers.find(observer => observer.observations.some(item => item.target === target));
        },
        restore() {
            globalThis.document = previous.document;
            globalThis.window = previous.window;
            globalThis.MutationObserver = previous.MutationObserver;
            globalThis.requestAnimationFrame = previous.requestAnimationFrame;
            globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
            globalThis.setInterval = previous.setInterval;
            globalThis.clearInterval = previous.clearInterval;
            globalThis.setTimeout = previous.setTimeout;
            globalThis.clearTimeout = previous.clearTimeout;
            globalThis.SillyTavern = previous.SillyTavern;
        },
    };
}

const snippets = [
    { id: 'global', name: 'Global', content: 'global-marker{}', isGlobal: true },
    { id: 'calico', name: 'Calico', content: 'calico-marker{}', isGlobal: false, themeList: ['Calico'] },
    { id: 'dark', name: 'Dark', content: 'dark-marker{}', isGlobal: false, themeList: ['Calico Dark'] },
    { id: 'new-theme', name: 'New Theme', content: 'new-theme-marker{}', isGlobal: false, themeList: ['New Theme'] },
];

async function boot(options) {
    const stub = installBrowserStubs(options);
    const runtime = await import('../public/scripts/extensions/css-snippets/src/runtime.js');
    runtime.loadSettings();
    runtime.applyCss();
    runtime.startWatching();
    return { stub, runtime };
}

describe('CSS Snippets runtime watcher', () => {
    afterEach(() => {
        jest.resetModules();
    });

    test('uses events, theme controls and a visible-only fallback instead of the old 500ms poll', async () => {
        const { stub, runtime } = await boot({ snippets });
        try {
            expect(stub.eventSource.on).toHaveBeenCalledWith('chat_changed', expect.any(Function));
            expect(stub.eventSource.on).toHaveBeenCalledWith('settings_updated', expect.any(Function));
            expect(stub.eventSource.on).toHaveBeenCalledWith('settings_loaded_after', expect.any(Function));
            expect(stub.eventSource.on).toHaveBeenCalledWith('extension_settings_loaded', expect.any(Function));
            expect(stub.eventSource.on).toHaveBeenCalledWith('settings_loaded', expect.any(Function));

            const contextObserver = stub.observerFor(stub.document.documentElement);
            expect(contextObserver).toBeDefined();
            expect(contextObserver.observe).toHaveBeenCalledWith(stub.document.documentElement, expect.objectContaining({
                attributeFilter: ['style', 'class', 'data-theme', 'data-neconyan-ui-theme', 'data-neconyan-palette', 'data-neconyan-accent'],
            }));
            expect(contextObserver.observe).toHaveBeenCalledWith(stub.body, expect.objectContaining({
                attributeFilter: ['class', 'data-theme', 'data-neconyan-ui-theme', 'data-neconyan-palette', 'data-neconyan-accent'],
            }));
            const themeObserver = stub.observerFor(stub.themeSelect);
            expect(themeObserver).toBeDefined();
            expect(themeObserver.observe).toHaveBeenCalledWith(stub.themeSelect, { childList: true, subtree: true });

            expect(stub.document.addEventListener).toHaveBeenCalledWith('change', expect.any(Function), true);
            expect(stub.document.addEventListener).toHaveBeenCalledWith('input', expect.any(Function), true);
            expect(stub.document.addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
            expect(globalThis.window.addEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
            expect(globalThis.window.addEventListener).toHaveBeenCalledWith('pageshow', expect.any(Function));
            expect(globalThis.setInterval).toHaveBeenCalledWith(expect.any(Function), 5000);
            expect(stub.intervals.size).toBe(1);

            runtime.stopWatching();
            expect(contextObserver.disconnect).toHaveBeenCalled();
            expect(themeObserver.disconnect).toHaveBeenCalled();
            expect(globalThis.clearInterval).toHaveBeenCalled();
            expect(stub.eventSource.removeListener).toHaveBeenCalledWith('chat_changed', expect.any(Function));
            expect(stub.eventSource.removeListener).toHaveBeenCalledWith('settings_updated', expect.any(Function));
            expect(stub.eventSource.removeListener).toHaveBeenCalledWith('settings_loaded_after', expect.any(Function));
            expect(stub.eventSource.removeListener).toHaveBeenCalledWith('extension_settings_loaded', expect.any(Function));
            expect(stub.eventSource.removeListener).toHaveBeenCalledWith('settings_loaded', expect.any(Function));
            expect(stub.document.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function), true);
            expect(stub.document.removeEventListener).toHaveBeenCalledWith('input', expect.any(Function), true);
            expect(stub.document.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        } finally {
            runtime.stopWatching();
            stub.restore();
        }
    });

    test('reapplies theme snippets on change and input even when the theme CSS variables are identical', async () => {
        const { stub, runtime } = await boot({ snippets });
        try {
            expect(stub.style().textContent).toContain('calico-marker{}');
            expect(stub.style().textContent).not.toContain('dark-marker{}');

            stub.setTheme('Calico Dark');
            stub.dispatchDocument('change', { target: stub.themeSelect });
            expect(stub.style().textContent).not.toContain('dark-marker{}');
            stub.flushAnimationFrames();
            expect(stub.style().textContent).toContain('dark-marker{}');
            expect(stub.style().textContent).not.toContain('calico-marker{}');

            stub.setTheme('Calico');
            stub.dispatchDocument('input', { target: stub.themeSelect });
            stub.flushAnimationFrames();
            expect(stub.style().textContent).toContain('calico-marker{}');
            expect(stub.style().textContent).not.toContain('dark-marker{}');
        } finally {
            runtime.stopWatching();
            stub.restore();
        }
    });

    test('reapplies after the theme option list is replaced', async () => {
        const { stub, runtime } = await boot({ snippets });
        try {
            expect(stub.style().textContent).not.toContain('new-theme-marker{}');
            stub.setTheme('New Theme');
            stub.themeSelect.children.push({ value: 'New Theme' });
            stub.observerFor(stub.themeSelect).callback([{ type: 'childList', addedNodes: [{}], removedNodes: [] }]);
            expect(stub.style().textContent).not.toContain('new-theme-marker{}');

            stub.flushAnimationFrames();
            expect(stub.style().textContent).toContain('new-theme-marker{}');
        } finally {
            runtime.stopWatching();
            stub.restore();
        }
    });

    test('reloads extension settings at the final settings events, not only before replacement', async () => {
        const { stub, runtime } = await boot({ snippets });
        try {
            expect(stub.style().textContent).toContain('global-marker{}');

            stub.eventSource.emit('settings_loaded_after', {});
            expect(stub.style().textContent).toContain('global-marker{}');

            stub.context.extensionSettings = {
                cssSnippets: {
                    watchInterval: 500,
                    snippetList: [{ id: 'reloaded', name: 'Reloaded', content: 'reloaded-marker{}', isGlobal: true }],
                    filters: {},
                    themeSnippets: {},
                },
            };
            stub.eventSource.emit('extension_settings_loaded', {});
            expect(stub.style().textContent).toContain('reloaded-marker{}');
            expect(stub.style().textContent).not.toContain('global-marker{}');

            stub.context.extensionSettings = {
                cssSnippets: {
                    watchInterval: 500,
                    snippetList: [{ id: 'final', name: 'Final', content: 'final-marker{}', isGlobal: true }],
                    filters: {},
                    themeSnippets: {},
                },
            };
            stub.eventSource.emit('settings_loaded', {});
            expect(stub.style().textContent).toContain('final-marker{}');
            expect(stub.style().textContent).not.toContain('reloaded-marker{}');
        } finally {
            runtime.stopWatching();
            stub.restore();
        }
    });

    test('does no context work while hidden, then applies on wake and the bounded fallback', async () => {
        const { stub, runtime } = await boot({ snippets });
        try {
            stub.document.visibilityState = 'hidden';
            stub.dispatchDocument('visibilitychange', {});
            expect(stub.intervals.size).toBe(0);

            stub.themeReads.mockClear();
            stub.setTheme('Calico Dark');
            stub.runFallback();
            expect(stub.themeReads).not.toHaveBeenCalled();
            expect(stub.style().textContent).toContain('calico-marker{}');

            stub.document.visibilityState = 'visible';
            stub.dispatchDocument('visibilitychange', {});
            expect(stub.intervals.size).toBe(1);
            expect(stub.themeReads).toHaveBeenCalled();
            expect(stub.style().textContent).toContain('dark-marker{}');

            stub.setTheme('Calico');
            stub.runFallback();
            expect(stub.style().textContent).toContain('calico-marker{}');
        } finally {
            runtime.stopWatching();
            stub.restore();
        }
    });

    test('teardown removes theme and wake listeners and stops applying styles', async () => {
        const { stub, runtime } = await boot({ snippets });
        try {
            runtime.stopWatching();
            const before = stub.style().textContent;
            stub.setTheme('Calico Dark');
            stub.dispatchDocument('change', { target: stub.themeSelect });
            stub.flushAnimationFrames();
            expect(stub.style().textContent).toBe(before);
        } finally {
            stub.restore();
        }
    });
});
