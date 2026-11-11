/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const originalDocument = globalThis.document;
const listeners = new Map();
const fakeDocument = {
    hidden: false,
    addEventListener: jest.fn((type, handler) => {
        const list = listeners.get(type) ?? [];
        list.push(handler);
        listeners.set(type, list);
    }),
    removeEventListener: jest.fn((type, handler) => {
        const list = listeners.get(type);
        if (!list) return;
        const index = list.indexOf(handler);
        if (index !== -1) list.splice(index, 1);
    }),
    dispatchVisibilityChange() {
        for (const handler of [...(listeners.get('visibilitychange') ?? [])]) {
            handler();
        }
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    body: {
        classList: {
            add: jest.fn(),
            remove: jest.fn(),
        },
    },
};

globalThis.document = fakeDocument;
const { TabManager } = await import('../public/scripts/extensions/third-party/ChatCompletionTabs/components/tab-manager.js');

function createManager(onCheck) {
    return new TabManager({
        containerSelector: '#openai_settings',
        insertAfterSelector: '#range_block_openai',
        tabs: { parameters: { label: 'Parameters', icon: 'fa-solid fa-sliders', contentSelectors: [] } },
        checkCondition: onCheck,
    });
}

describe('ChatCompletionTabs polling visibility lifecycle', () => {
    let manager = null;

    beforeEach(() => {
        jest.useFakeTimers();
        fakeDocument.hidden = false;
        fakeDocument.addEventListener.mockClear();
        fakeDocument.removeEventListener.mockClear();
        listeners.clear();
        globalThis.document = fakeDocument;
    });

    afterEach(() => {
        manager?.destroy();
        manager?.setEnabled(false);
        manager = null;
        jest.clearAllTimers();
        jest.useRealTimers();
        globalThis.document = originalDocument;
    });

    test('pauses polling while hidden, checks once on return, and stays silent when disabled', () => {
        let checks = 0;
        manager = createManager(() => {
            checks += 1;
            return false;
        });

        jest.advanceTimersByTime(300);
        expect(checks).toBe(1);

        jest.advanceTimersByTime(1700);
        expect(checks).toBe(2);
        jest.advanceTimersByTime(2000);
        expect(checks).toBe(3);

        fakeDocument.hidden = true;
        fakeDocument.dispatchVisibilityChange();
        jest.advanceTimersByTime(20000);
        expect(checks).toBe(3);

        fakeDocument.hidden = false;
        fakeDocument.dispatchVisibilityChange();
        expect(checks).toBe(4);

        jest.advanceTimersByTime(2000);
        expect(checks).toBe(5);
        jest.advanceTimersByTime(2000);
        expect(checks).toBe(6);

        manager.setEnabled(false);
        fakeDocument.hidden = true;
        fakeDocument.dispatchVisibilityChange();
        fakeDocument.hidden = false;
        fakeDocument.dispatchVisibilityChange();
        jest.advanceTimersByTime(20000);
        expect(checks).toBe(6);
    });

    test('calling init() twice keeps a single listener, start-up check, and poll rhythm', () => {
        let checks = 0;
        manager = createManager(() => {
            checks += 1;
            return false;
        });
        manager.init();

        const visibilityAdds = fakeDocument.addEventListener.mock.calls.filter(([type]) => type === 'visibilitychange');
        expect(visibilityAdds).toHaveLength(1);
        expect(listeners.get('visibilitychange')).toHaveLength(1);

        jest.advanceTimersByTime(300);
        expect(checks).toBe(1);

        fakeDocument.hidden = true;
        fakeDocument.dispatchVisibilityChange();
        fakeDocument.hidden = false;
        fakeDocument.dispatchVisibilityChange();
        expect(checks).toBe(2);

        jest.advanceTimersByTime(2000);
        expect(checks).toBe(3);
        jest.advanceTimersByTime(2000);
        expect(checks).toBe(4);
    });

    test('destroy() removes the exact visibility listener and never resumes polling on hide and show', () => {
        let checks = 0;
        manager = createManager(() => {
            checks += 1;
            return false;
        });

        const visibilityAdds = fakeDocument.addEventListener.mock.calls.filter(([type]) => type === 'visibilitychange');
        expect(visibilityAdds).toHaveLength(1);
        const registeredHandler = visibilityAdds[0][1];

        jest.advanceTimersByTime(300);
        expect(checks).toBe(1);

        manager.destroy();

        const visibilityRemoves = fakeDocument.removeEventListener.mock.calls.filter(([type]) => type === 'visibilitychange');
        expect(visibilityRemoves).toHaveLength(1);
        expect(visibilityRemoves[0][1]).toBe(registeredHandler);
        expect(listeners.get('visibilitychange')).toEqual([]);

        fakeDocument.hidden = true;
        fakeDocument.dispatchVisibilityChange();
        fakeDocument.hidden = false;
        fakeDocument.dispatchVisibilityChange();
        registeredHandler();
        jest.advanceTimersByTime(20000);
        expect(checks).toBe(1);
    });

    test('destroy() before the 300 ms start-up timeout fires cancels the start-up check', () => {
        let checks = 0;
        manager = createManager(() => {
            checks += 1;
            return false;
        });

        manager.destroy();
        jest.advanceTimersByTime(20000);
        expect(checks).toBe(0);
    });
});
