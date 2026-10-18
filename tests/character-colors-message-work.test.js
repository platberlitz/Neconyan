import { describe, expect, jest, test } from '@jest/globals';

import { bindMessageWorkLifecycle, createMessageWorkController } from '../public/scripts/extensions/third-party/sillytavern-character-colors/src/message-work-controller.js';

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

function createController(overrides = {}) {
    const scheduler = createScheduler();
    const chat = [];
    const syncCounts = jest.fn(() => false);
    const refreshList = jest.fn();
    const controller = createMessageWorkController({
        processDelay: 600,
        countDelay: 100,
        setTimer: scheduler.setTimer,
        clearTimer: scheduler.clearTimer,
        syncCounts,
        refreshList,
        getChat: () => chat,
        ...overrides,
    });
    return { controller, scheduler, chat, syncCounts, refreshList };
}

describe('Character Colors message work controller', () => {
    test('chat switch, new chat, deletion and disabling cancel pending work', () => {
        const handlers = new Map();
        const eventSource = { on: jest.fn((name, handler) => handlers.set(name, handler)) };
        const cancel = jest.fn();
        let enabled = true;
        bindMessageWorkLifecycle({
            eventSource,
            eventTypes: {
                CHAT_CHANGED: 'chat_changed',
                CHAT_CREATED: 'chat_created',
                MESSAGE_DELETED: 'message_deleted',
                SETTINGS_UPDATED: 'settings_updated',
            },
            isEnabled: () => enabled,
            cancel,
        });

        handlers.get('chat_changed')();
        handlers.get('chat_created')();
        handlers.get('message_deleted')();
        expect(cancel).toHaveBeenCalledTimes(3);

        handlers.get('settings_updated')();
        expect(cancel).toHaveBeenCalledTimes(3);
        enabled = false;
        handlers.get('settings_updated')();
        expect(cancel).toHaveBeenCalledTimes(4);
    });

    test('cancel drops queued jobs and pending recounts', async () => {
        const { controller, scheduler, chat, syncCounts, refreshList } = createController();
        const ran = jest.fn();

        controller.schedule(ran);
        controller.scheduleCounts(chat, { refreshCharList: true });
        controller.cancel();
        await scheduler.advance(600);

        expect(ran).not.toHaveBeenCalled();
        expect(syncCounts).not.toHaveBeenCalled();
        expect(refreshList).not.toHaveBeenCalled();
    });

    test('jobs run one at a time and a cancel during an async job stops the rest', async () => {
        const { controller, scheduler } = createController();
        const order = [];
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const token = controller.capture();
        controller.schedule(async () => {
            order.push('first-start');
            await gate;
            if (controller.isCurrent(token)) order.push('first-resumed');
            order.push('first-end');
        });
        controller.schedule(() => {
            order.push('second');
        });

        const advance = scheduler.advance(600);
        await Promise.resolve();
        expect(order).toEqual(['first-start']);

        controller.cancel();
        release();
        await advance;
        expect(order).toEqual(['first-start', 'first-end']);
    });

    test('a recount scheduled after a reset applies only the new generation', async () => {
        const { controller, scheduler, chat, syncCounts, refreshList } = createController();
        controller.scheduleCounts(chat, { refreshCharList: true });
        controller.cancel();
        controller.scheduleCounts(chat, { refreshCharList: true });

        await scheduler.advance(100);

        expect(syncCounts).toHaveBeenCalledTimes(1);
        expect(syncCounts).toHaveBeenCalledWith(chat);
        expect(refreshList).toHaveBeenCalledTimes(1);
    });

    test('a recount is skipped when the chat changed or the feature was disabled', async () => {
        const first = createController();
        first.controller.scheduleCounts(first.chat, { refreshCharList: true });
        first.chat.length = 1;
        const otherChat = [];
        first.controller.scheduleCounts(otherChat, { refreshCharList: true });
        await first.scheduler.advance(100);
        expect(first.syncCounts).not.toHaveBeenCalled();
        expect(first.refreshList).not.toHaveBeenCalled();

        const disabled = createController({ isEnabled: () => false });
        disabled.controller.scheduleCounts(disabled.chat, { refreshCharList: true });
        await disabled.scheduler.advance(100);
        expect(disabled.syncCounts).not.toHaveBeenCalled();
        expect(disabled.refreshList).not.toHaveBeenCalled();
    });

    test('a completed recount refreshes the list after the count is applied', async () => {
        const sequence = [];
        const { controller, scheduler, chat } = createController({
            syncCounts: () => {
                sequence.push('count');
                return true;
            },
            refreshList: () => sequence.push('list'),
        });
        controller.scheduleCounts(chat);
        await scheduler.advance(100);
        expect(sequence).toEqual(['count', 'list']);
    });
});
