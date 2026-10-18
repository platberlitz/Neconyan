/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

const EXTENSION_NAME = 'BunnyPresetTools';

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
    };
}

function installDom({ withPromptList = true } = {}) {
    const elements = new Map();
    const documentListeners = new Map();
    const windowListeners = new Map();
    const observers = [];
    const animationFrames = new Map();
    let nextId = 0;
    let promptList = null;

    function makeElement(tag = 'div', props = {}) {
        const element = {
            tagName: String(tag).toUpperCase(),
            id: '',
            className: '',
            textContent: '',
            innerHTML: '',
            value: '',
            checked: false,
            style: {
                setProperty: jest.fn(),
                removeProperty: jest.fn(),
            },
            dataset: {},
            classList: classListOf(),
            children: [],
            parentElement: null,
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            querySelector: jest.fn(() => makeElement('div')),
            querySelectorAll: jest.fn(() => []),
            closest: jest.fn(() => null),
            before: jest.fn(),
            remove: jest.fn(),
            prepend: jest.fn(),
            append: jest.fn(),
            appendChild: jest.fn(child => {
                element.children.push(child);
                child.parentElement = element;
                return child;
            }),
            insertBefore: jest.fn(node => {
                node.parentElement = element;
                if (node.id) elements.set(node.id, node);
            }),
            insertAdjacentElement: jest.fn(),
            getClientRects: jest.fn(() => []),
            getBoundingClientRect: jest.fn(() => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })),
            setAttribute: jest.fn(),
            getAttribute: jest.fn(() => null),
            hasAttribute: jest.fn(() => false),
            ...props,
        };
        Object.setPrototypeOf(element, HTMLElementStub.prototype);
        return element;
    }

    class HTMLElementStub extends Object {}

    function makePromptList() {
        const parent = makeElement('div');
        const list = makeElement('ul', { id: 'completion_prompt_manager_list' });
        list.parentElement = parent;
        list.closest = jest.fn(() => null);
        list.querySelectorAll = jest.fn(() => []);
        elements.set(list.id, list);
        return list;
    }

    const body = makeElement('body');
    const document = {
        body,
        readyState: 'complete',
        hidden: false,
        visibilityState: 'visible',
        createElement: jest.fn(tag => makeElement(tag)),
        getElementById: jest.fn(id => elements.get(id) ?? null),
        querySelector: jest.fn(selector => selector === '#completion_prompt_manager_list' ? promptList : null),
        querySelectorAll: jest.fn(() => []),
        addEventListener: jest.fn((name, handler) => {
            if (!documentListeners.has(name)) documentListeners.set(name, new Set());
            documentListeners.get(name).add(handler);
        }),
        removeEventListener: jest.fn((name, handler) => {
            documentListeners.get(name)?.delete(handler);
        }),
        elementsFromPoint: jest.fn(() => []),
    };
    const window = {
        location: { origin: 'http://localhost' },
        setTimeout: jest.fn((callback, delay) => {
            const id = ++nextId;
            return id;
        }),
        clearTimeout: jest.fn(),
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
            this.disconnect = jest.fn();
            observers.push(this);
        }
    }

    if (withPromptList) promptList = makePromptList();
    const promptContainer = makeElement('div', { id: 'completion_prompt_manager' });
    elements.set(promptContainer.id, promptContainer);

    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        MutationObserver: globalThis.MutationObserver,
        HTMLElement: globalThis.HTMLElement,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        navigator: globalThis.navigator,
    };
    globalThis.document = document;
    globalThis.window = window;
    globalThis.MutationObserver = MutationObserver;
    globalThis.HTMLElement = HTMLElementStub;
    globalThis.requestAnimationFrame = jest.fn(callback => {
        const id = ++nextId;
        animationFrames.set(id, callback);
        return id;
    });
    globalThis.cancelAnimationFrame = jest.fn(id => animationFrames.delete(id));
    globalThis.setTimeout = jest.fn(() => ++nextId);
    globalThis.clearTimeout = jest.fn();
    globalThis.navigator = { platform: 'Linux', maxTouchPoints: 0 };

    return {
        document,
        window,
        observers,
        get promptList() {
            return promptList;
        },
        setPromptList(list = makePromptList()) {
            promptList = list;
            return list;
        },
        makeElement,
        flushAnimationFrames() {
            const entries = [...animationFrames.entries()];
            animationFrames.clear();
            for (const [, callback] of entries) callback();
        },
        pendingAnimationFrames() {
            return animationFrames.size;
        },
        observerFor(target) {
            return observers.find(observer => observer.observations.some(item => item.target === target));
        },
        dispatchWindow(name, event) {
            for (const handler of [...(windowListeners.get(name) ?? [])]) handler(event);
        },
        restore() {
            globalThis.document = previous.document;
            globalThis.window = previous.window;
            globalThis.MutationObserver = previous.MutationObserver;
            globalThis.HTMLElement = previous.HTMLElement;
            globalThis.requestAnimationFrame = previous.requestAnimationFrame;
            globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
            globalThis.setTimeout = previous.setTimeout;
            globalThis.clearTimeout = previous.clearTimeout;
            globalThis.navigator = previous.navigator;
        },
    };
}

async function loadContent(dom) {
    const eventHandlers = new Map();
    const eventSource = {
        on: jest.fn((event, handler) => {
            if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
            eventHandlers.get(event).add(handler);
        }),
        removeListener: jest.fn((event, handler) => eventHandlers.get(event)?.delete(handler)),
        emit(event, payload) {
            for (const handler of [...(eventHandlers.get(event) ?? [])]) handler(payload);
        },
    };
    const extensionSettings = {
        [EXTENSION_NAME]: {
            enablePromptSections: true,
            dividerRegexPattern: '',
            promptSectionStates: {},
            promptSectionLocks: {},
            openSectionStates: {},
        },
    };
    const promptManager = {
        configuration: { containerIdentifier: 'completion_prompt_manager' },
        getPromptById: jest.fn(() => null),
        activeCharacter: null,
    };
    const backgroundSettings = {};
    const powerUser = {};
    const eventTypes = {
        APP_READY: 'app_ready',
        CHAT_CHANGED: 'chat_changed',
        SETTINGS_LOADED_AFTER: 'settings_loaded_after',
        EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
        SETTINGS_LOADED: 'settings_loaded',
    };

    await jest.unstable_mockModule('../public/script.js', () => ({
        chat_metadata: {},
        eventSource,
        event_types: eventTypes,
        getCurrentChatId: () => null,
        saveSettingsDebounced: jest.fn(),
    }));
    await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
        extension_settings: extensionSettings,
        saveMetadataDebounced: jest.fn(),
    }));
    await jest.unstable_mockModule('../public/scripts/backgrounds.js', () => ({
        background_settings: backgroundSettings,
    }));
    await jest.unstable_mockModule('../public/scripts/openai.js', () => ({
        promptManager,
    }));
    await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
        power_user: powerUser,
    }));

    const content = await import('../public/scripts/extensions/third-party/Neconyan-Preset-Tools/content.js');
    return { content, eventSource, eventTypes, extensionSettings, promptManager, dom };
}

describe('Preset Tools prompt-section watcher', () => {
    afterEach(() => {
        jest.resetModules();
    });

    test('watches final settings events and reconciles settings on the same prompt list node', async () => {
        const dom = installDom();
        try {
            const state = await loadContent(dom);
            expect(state.eventSource.on).toHaveBeenCalledWith('app_ready', expect.any(Function));
            expect(state.eventSource.on).toHaveBeenCalledWith('settings_loaded_after', expect.any(Function));
            expect(state.eventSource.on).toHaveBeenCalledWith('extension_settings_loaded', expect.any(Function));
            expect(state.eventSource.on).toHaveBeenCalledWith('settings_loaded', expect.any(Function));
            dom.flushAnimationFrames();
            expect(dom.pendingAnimationFrames()).toBe(0);

            state.extensionSettings[EXTENSION_NAME] = {
                enablePromptSections: false,
                dividerRegexPattern: 'CUSTOM',
                promptSectionStates: { saved: false },
                promptSectionLocks: {},
                openSectionStates: {},
            };
            state.eventSource.emit('extension_settings_loaded', {});
            expect(dom.pendingAnimationFrames()).toBe(1);
            expect(state.extensionSettings[EXTENSION_NAME].enablePromptSections).toBe(false);
            expect(state.extensionSettings[EXTENSION_NAME].dividerRegexPattern).toBe('CUSTOM');
            expect(state.extensionSettings[EXTENSION_NAME].promptSectionStates.saved).toBe(false);

            dom.flushAnimationFrames();
            state.extensionSettings[EXTENSION_NAME] = {
                enablePromptSections: true,
                dividerRegexPattern: 'FINAL',
                promptSectionStates: {},
                promptSectionLocks: {},
                openSectionStates: {},
            };
            state.eventSource.emit('settings_loaded', {});
            expect(dom.pendingAnimationFrames()).toBe(1);
            expect(state.extensionSettings[EXTENSION_NAME].dividerRegexPattern).toBe('FINAL');
        } finally {
            dom.restore();
        }
    });

    test('reconciles enablePromptSections and saved section state on the same prompt list node', async () => {
        const dom = installDom();
        try {
            const state = await loadContent(dom);
            dom.flushAnimationFrames();
            state.promptManager.getPromptById.mockImplementation(identifier => identifier === 'divider'
                ? { name: '=== Section ===', content: '' }
                : { name: 'Prompt one', content: 'hello' });
            const divider = dom.makeElement('li');
            divider.dataset.pmIdentifier = 'divider';
            const prompt = dom.makeElement('li');
            prompt.dataset.pmIdentifier = 'prompt-1';
            dom.promptList.querySelectorAll = jest.fn(selector => (
                selector.startsWith(':scope > li.completion_prompt_manager_prompt') ? [divider, prompt] : []
            ));

            state.extensionSettings[EXTENSION_NAME] = {
                enablePromptSections: true,
                dividerRegexPattern: '',
                promptSectionStates: { divider: false },
                promptSectionLocks: {},
                openSectionStates: { '=== Section ===': false },
            };
            state.eventSource.emit('extension_settings_loaded', {});
            dom.flushAnimationFrames();
            expect(prompt.style.display).toBe('none');

            state.extensionSettings[EXTENSION_NAME] = {
                enablePromptSections: false,
                dividerRegexPattern: '',
                promptSectionStates: { divider: false },
                promptSectionLocks: {},
                openSectionStates: { '=== Section ===': false },
            };
            state.eventSource.emit('settings_loaded', {});
            dom.flushAnimationFrames();
            expect(prompt.style.display).toBe('');
        } finally {
            dom.restore();
        }
    });

    test('refreshes for prompt toggle class changes and ignores unrelated class mutations', async () => {
        const dom = installDom();
        try {
            await loadContent(dom);
            dom.flushAnimationFrames();
            const promptList = dom.promptList;
            const observer = dom.observerFor(promptList);
            expect(observer).toBeDefined();
            expect(observer.observations.at(-1).options).toEqual(expect.objectContaining({
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class'],
            }));

            const toggle = dom.makeElement('i');
            toggle.classList.add('prompt-manager-toggle-action', 'fa-toggle-on');
            observer.callback([{ type: 'attributes', attributeName: 'class', target: toggle, addedNodes: [], removedNodes: [] }]);
            expect(dom.pendingAnimationFrames()).toBe(1);
            dom.flushAnimationFrames();

            const unrelated = dom.makeElement('li');
            unrelated.classList.add('completion_prompt_manager_prompt');
            observer.callback([{ type: 'attributes', attributeName: 'class', target: unrelated, addedNodes: [], removedNodes: [] }]);
            expect(dom.pendingAnimationFrames()).toBe(0);
        } finally {
            dom.restore();
        }
    });

    test('discovers the prompt list after the initial load', async () => {
        const dom = installDom({ withPromptList: false });
        try {
            const state = await loadContent(dom);
            dom.flushAnimationFrames();
            expect(dom.promptList).toBeNull();
            expect(dom.observerFor(dom.document.querySelector('#completion_prompt_manager_list'))).toBeUndefined();

            const list = dom.setPromptList();
            state.eventSource.emit('app_ready', {});
            expect(dom.observerFor(list)).toBeDefined();
            expect(dom.pendingAnimationFrames()).toBe(1);
            dom.flushAnimationFrames();
        } finally {
            dom.restore();
        }
    });
});
