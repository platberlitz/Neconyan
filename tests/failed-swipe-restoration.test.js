import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const swipe = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(row => row.declaration ?? row).find(row => row.id?.name === 'swipe');
const endSwipe = swipe.body.body.find(row => row.type === 'FunctionDeclaration' && row.id.name === 'endSwipe');

function setup({ followBottom = false, succeeded = false } = {}) {
    const calls = [];
    const message = { mes: succeeded ? 'New reply' : '...', swipes: succeeded ? ['Existing reply', 'New reply'] : ['Existing reply'], swipe_id: 1 };
    const viewport = { scrollWithAddOneMessage: followBottom };
    const counter = { animate() { return this; }, promise: () => Promise.resolve() };
    const runtime = vm.createContext({
        console: { warn: jest.fn() }, document: { body: { dataset: {} } },
        chat: [message], mesId: 0, originalSwipeId: 0, source: undefined,
        generation: Promise.resolve(), swipeState: 'swiping', swipeRange: 700, animation_duration: 0,
        SWIPE_STATE: { NONE: 'none' }, SWIPE_SOURCE: { BACK: 'back', DELETE: 'delete' },
        clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
        thisMesDiv: { find: () => counter }, shakeElement: jest.fn(), createTimeout: () => Promise.resolve(),
        updateSwipeCounter: jest.fn(), showSwipeButtons: jest.fn(() => calls.push('controls')),
        getSwipeReplacementViewportUpdate: jest.fn(() => { calls.push('measure'); return viewport; }),
        loadFromSwipeId: jest.fn(async (_index, swipeId) => { message.mes = message.swipes[swipeId]; calls.push('restore'); }),
        redisplayChat: jest.fn(async () => { expect(message.mes).toBe('Existing reply'); calls.push('redraw'); }),
        scrollChatToBottom: jest.fn(() => calls.push('bottom')),
        applySwipeReplacementViewportUpdate: jest.fn(async () => calls.push('position')),
        saveChatConditional: jest.fn(async () => { calls.push('save'); return true; }),
        saveChatDebounced: jest.fn(),
    });
    vm.runInContext(source.slice(endSwipe.start, endSwipe.end), runtime);
    return { runtime, message, viewport, calls };
}

test.each([false, true])('restoring a failed swipe retains its viewport policy and saved reply, follow bottom: %s', async followBottom => {
    const { runtime, message, viewport, calls } = setup({ followBottom });
    await runtime.endSwipe();

    expect(message).toEqual({ mes: 'Existing reply', swipes: ['Existing reply'], swipe_id: 0 });
    expect(runtime.getSwipeReplacementViewportUpdate).toHaveBeenCalledWith({ isLastMessageSwipe: true, useLifecycleRoute: true });
    expect(runtime.redisplayChat).toHaveBeenCalledWith({ startIndex: 0, atomic: true });
    expect(runtime.applySwipeReplacementViewportUpdate).toHaveBeenCalledWith(viewport);
    expect(runtime.scrollChatToBottom).toHaveBeenCalledTimes(followBottom ? 1 : 0);
    expect(calls).toEqual(['measure', 'restore', 'redraw', 'controls', ...(followBottom ? ['bottom'] : []), 'position', 'save']);
    expect(runtime.saveChatDebounced).not.toHaveBeenCalled();
    expect(runtime.swipeState).toBe('none');
    expect(runtime.document.body.dataset.swiping).toBeUndefined();
    expect(runtime.showSwipeButtons).toHaveBeenCalledTimes(1);
});

test('a successful swipe keeps its normal debounced save without restoring the previous reply', async () => {
    const { runtime, message } = setup({ succeeded: true });
    await runtime.endSwipe();
    expect(message.mes).toBe('New reply');
    expect(runtime.redisplayChat).not.toHaveBeenCalled();
    expect(runtime.saveChatConditional).not.toHaveBeenCalled();
    expect(runtime.saveChatDebounced).toHaveBeenCalledTimes(1);
});

test('a rejected generation still restores and saves the existing reply', async () => {
    const { runtime, message } = setup();
    runtime.generation = Promise.reject(new Error('Request failed'));
    await runtime.endSwipe();
    expect(runtime.console.warn).toHaveBeenCalledWith(expect.stringContaining('Request failed'));
    expect(message.mes).toBe('Existing reply');
    expect(runtime.saveChatConditional).toHaveBeenCalledTimes(1);
    expect(runtime.showSwipeButtons).toHaveBeenCalledTimes(1);
});
