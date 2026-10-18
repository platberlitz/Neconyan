/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

function installBrowserStubs() {
    const listeners = new Map();
    const eventSource = {
        on: jest.fn(),
        removeListener: jest.fn(),
    };
    const context = {
        extensionSettings: {},
        powerUserSettings: { theme: 'Calico' },
        characterId: 0,
        characters: [{ avatar: 'alice.png', name: 'Alice' }],
        groupId: null,
        groups: [],
        eventSource,
        eventTypes: {
            CHAT_CHANGED: 'chat_changed',
            SETTINGS_UPDATED: 'settings_updated',
        },
    };
    const documentElement = { nodeName: 'HTML' };
    const body = { nodeName: 'BODY' };
    const document = {
        documentElement,
        body,
        visibilityState: 'visible',
        addEventListener: jest.fn((name, handler) => listeners.set(name, handler)),
        removeEventListener: jest.fn((name) => listeners.delete(name)),
        createElement: jest.fn(() => ({ textContent: '', id: '', remove: jest.fn() })),
        getElementById: jest.fn(() => null),
        head: { append: jest.fn() },
    };
    const window = {
        addEventListener: jest.fn((name, handler) => listeners.set(`window:${name}`, handler)),
        removeEventListener: jest.fn((name) => listeners.delete(`window:${name}`)),
    };
    const observers = [];
    class MutationObserver {
        constructor(callback) {
            this.callback = callback;
            this.observe = jest.fn();
            this.disconnect = jest.fn();
            observers.push(this);
        }
    }
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        MutationObserver: globalThis.MutationObserver,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
        SillyTavern: globalThis.SillyTavern,
    };
    globalThis.document = document;
    globalThis.window = window;
    globalThis.MutationObserver = MutationObserver;
    globalThis.requestAnimationFrame = jest.fn(() => 1);
    globalThis.cancelAnimationFrame = jest.fn();
    globalThis.SillyTavern = { getContext: () => context };
    return {
        context,
        document,
        eventSource,
        listeners,
        observers,
        restore() {
            globalThis.document = previous.document;
            globalThis.window = previous.window;
            globalThis.MutationObserver = previous.MutationObserver;
            globalThis.requestAnimationFrame = previous.requestAnimationFrame;
            globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
            globalThis.SillyTavern = previous.SillyTavern;
        },
    };
}

describe('CSS Snippets runtime watcher', () => {
    afterEach(() => {
        jest.resetModules();
    });

    test('uses events and theme attributes instead of a permanent interval', async () => {
        const stub = installBrowserStubs();
        const setIntervalSpy = jest.fn();
        const originalSetInterval = globalThis.setInterval;
        globalThis.setInterval = setIntervalSpy;
        try {
            const runtime = await import('../public/scripts/extensions/css-snippets/src/runtime.js');
            runtime.startWatching();

            expect(setIntervalSpy).not.toHaveBeenCalled();
            expect(stub.eventSource.on).toHaveBeenCalledWith('chat_changed', expect.any(Function));
            expect(stub.eventSource.on).toHaveBeenCalledWith('settings_updated', expect.any(Function));
            expect(stub.observers).toHaveLength(1);
            expect(stub.observers[0].observe).toHaveBeenCalledWith(stub.document.documentElement, expect.objectContaining({
                attributeFilter: ['style', 'class', 'data-theme', 'data-neconyan-ui-theme', 'data-neconyan-palette', 'data-neconyan-accent'],
            }));
            expect(stub.observers[0].observe).toHaveBeenCalledWith(stub.document.body, expect.objectContaining({
                attributeFilter: ['class', 'data-theme', 'data-neconyan-ui-theme', 'data-neconyan-palette', 'data-neconyan-accent'],
            }));
            expect(stub.document.addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
            expect(globalThis.window.addEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
            expect(globalThis.window.addEventListener).toHaveBeenCalledWith('pageshow', expect.any(Function));

            runtime.stopWatching();
            expect(stub.observers[0].disconnect).toHaveBeenCalled();
            expect(stub.eventSource.removeListener).toHaveBeenCalledWith('chat_changed', expect.any(Function));
            expect(stub.eventSource.removeListener).toHaveBeenCalledWith('settings_updated', expect.any(Function));
            expect(stub.document.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        } finally {
            globalThis.setInterval = originalSetInterval;
            stub.restore();
        }
    });
});
