import { describe, expect, jest, test } from '@jest/globals';

import { createPendingNavigationQueue } from '../public/scripts/extensions/third-party/Neconyan-Deep-Swipe/pending-navigation-queue.js';

function createScheduler() {
    let now = 0;
    let nextId = 0;
    const tasks = [];
    return {
        setTimer(callback, delay) {
            const task = { id: ++nextId, at: now + delay, callback, cancelled: false, done: false };
            tasks.push(task);
            return task.id;
        },
        clearTimer(id) {
            const task = tasks.find(item => item.id === id);
            if (task) task.cancelled = true;
        },
        async advance(ms) {
            now += ms;
            for (;;) {
                const task = tasks.find(item => !item.cancelled && !item.done && item.at <= now);
                if (!task) return;
                task.done = true;
                await task.callback();
            }
        },
    };
}

function setup({ enabled = true, swipeNavigation = true, afterFlush } = {}) {
    const scheduler = createScheduler();
    const context = { chat: [] };
    const settings = { enabled, swipeNavigation };
    const elements = new Map();
    const addNavigation = jest.fn();
    const queue = createPendingNavigationQueue({
        delay: 100,
        setTimer: scheduler.setTimer,
        clearTimer: scheduler.clearTimer,
        getContext: () => context,
        getSettings: () => settings,
        findElement: id => elements.get(id) ?? null,
        addNavigation,
        afterFlush,
    });
    return { scheduler, context, settings, elements, addNavigation, queue };
}

function element(id) {
    return { id, isConnected: true };
}

describe('Deep Swipe pending navigation queue', () => {
    test('adds a normal queued message with its captured chat and element', async () => {
        const { scheduler, context, elements, addNavigation, queue } = setup();
        const messageElement = element(3);
        context.chat = [{}, {}, {}, {}];
        elements.set(3, messageElement);
        queue.schedule(3, messageElement);
        await scheduler.advance(100);
        expect(addNavigation).toHaveBeenCalledWith(3, { chat: context.chat, element: messageElement });
    });

    test('later mutations share the first deadline rather than postponing controls', async () => {
        const { scheduler, context, elements, addNavigation, queue } = setup();
        context.chat = [{}, {}];
        const first = element(0);
        const second = element(1);
        elements.set(0, first);
        elements.set(1, second);
        queue.schedule(0, first);
        await scheduler.advance(50);
        queue.schedule(0, first);
        queue.schedule(1, second);
        await scheduler.advance(49);
        expect(addNavigation).not.toHaveBeenCalled();
        await scheduler.advance(1);
        expect(addNavigation.mock.calls).toEqual([
            [0, { chat: context.chat, element: first }],
            [1, { chat: context.chat, element: second }],
        ]);
        expect(queue.size()).toBe(0);

        addNavigation.mockClear();
        queue.schedule(1, second);
        await scheduler.advance(99);
        expect(addNavigation).not.toHaveBeenCalled();
        await scheduler.advance(1);
        expect(addNavigation).toHaveBeenCalledTimes(1);
    });

    test('a same-id replacement before the flush is not styled as the old message', async () => {
        const { scheduler, context, elements, addNavigation, queue } = setup();
        const first = element(3);
        const replacement = element(3);
        context.chat = [{}, {}, {}, {}];
        elements.set(3, first);
        queue.schedule(3, first);
        elements.set(3, replacement);

        await scheduler.advance(100);
        expect(addNavigation).not.toHaveBeenCalled();

        queue.schedule(3, replacement);
        await scheduler.advance(100);
        expect(addNavigation).toHaveBeenCalledWith(3, { chat: context.chat, element: replacement });
    });

    test('a chat switch drops queued ids before they can hit the new chat', async () => {
        const { scheduler, context, elements, addNavigation, queue } = setup();
        const messageElement = element(3);
        context.chat = [{}, {}, {}, {}];
        context.chatId = 'first';
        elements.set(3, messageElement);
        queue.schedule(3, messageElement);

        context.chat = [{}, {}, {}, {}];
        context.chatId = 'second';
        await scheduler.advance(100);
        expect(addNavigation).not.toHaveBeenCalled();
    });

    test('a reused chat array with a new chat id also drops queued ids', async () => {
        const { scheduler, context, elements, addNavigation, queue } = setup();
        const messageElement = element(2);
        context.chat = [{}, {}, {}];
        context.chatId = 'first';
        elements.set(2, messageElement);
        queue.schedule(2, messageElement);

        context.chatId = 'second';
        await scheduler.advance(100);
        expect(addNavigation).not.toHaveBeenCalled();
    });

    test('disabling the extension or navigation before the flush adds nothing', async () => {
        const extension = setup();
        extension.context.chat = [{}];
        extension.elements.set(0, element(0));
        extension.queue.schedule(0, extension.elements.get(0));
        extension.settings.enabled = false;
        await extension.scheduler.advance(100);
        expect(extension.addNavigation).not.toHaveBeenCalled();

        const navigation = setup();
        navigation.context.chat = [{}];
        navigation.elements.set(0, element(0));
        navigation.queue.schedule(0, navigation.elements.get(0));
        navigation.settings.swipeNavigation = false;
        await navigation.scheduler.advance(100);
        expect(navigation.addNavigation).not.toHaveBeenCalled();
    });

    test('restores the held reading position once after all queued insertions', async () => {
        const afterFlush = jest.fn();
        const { scheduler, context, elements, addNavigation, queue } = setup({ afterFlush });
        context.chat = [{}, {}];
        elements.set(0, element(0));
        elements.set(1, element(1));
        queue.schedule(0, elements.get(0));
        queue.schedule(1, elements.get(1));

        await scheduler.advance(100);

        expect(afterFlush).toHaveBeenCalledTimes(1);
        expect(addNavigation).toHaveBeenCalledTimes(2);
        expect(afterFlush.mock.invocationCallOrder[0])
            .toBeGreaterThan(addNavigation.mock.invocationCallOrder.at(-1));
    });

    test('cancel clears the queue and its timer', async () => {
        const { scheduler, context, elements, addNavigation, queue } = setup();
        context.chat = [{}];
        elements.set(0, element(0));
        queue.schedule(0, elements.get(0));
        queue.cancel();
        await scheduler.advance(100);
        expect(addNavigation).not.toHaveBeenCalled();
        expect(queue.size()).toBe(0);
    });
});
