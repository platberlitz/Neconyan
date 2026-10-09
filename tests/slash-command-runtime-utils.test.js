import { jest } from '@jest/globals';
import { delayWithAbort, isSlashCommandText } from '../public/scripts/slash-commands/SlashCommandRuntimeUtils.js';
import { SlashCommandAbortController } from '../public/scripts/slash-commands/SlashCommandAbortController.js';

afterEach(() => jest.useRealTimers());

test('stopping a script cancels its long wait and releases the listener', async () => {
    jest.useFakeTimers();
    const controller = new SlashCommandAbortController();
    const waiting = delayWithAbort(60000, controller);
    controller.abort();
    await waiting;
    expect(jest.getTimerCount()).toBe(0);
    expect(controller.listeners.abort).toHaveLength(0);
});

test('an already stopped script never starts another timer', async () => {
    jest.useFakeTimers();
    const controller = new SlashCommandAbortController();
    controller.abort();
    await delayWithAbort(60000, controller);
    expect(jest.getTimerCount()).toBe(0);
});

test('all waits are cancelled even when another abort listener removes itself', async () => {
    jest.useFakeTimers();
    const controller = new SlashCommandAbortController();
    const cleanup = () => controller.removeEventListener('abort', cleanup);
    controller.addEventListener('abort', cleanup);
    const first = delayWithAbort(60000, controller);
    const second = delayWithAbort(60000, controller);
    controller.abort();
    expect(jest.getTimerCount()).toBe(0);
    await Promise.all([first, second]);
    expect(controller.listeners.abort).toHaveLength(0);
});

test('a completed delay releases its cancellation listener', async () => {
    jest.useFakeTimers();
    const controller = new SlashCommandAbortController();
    const waiting = delayWithAbort(100, controller);
    await jest.advanceTimersByTimeAsync(100);
    await waiting;
    expect(controller.listeners.abort).toHaveLength(0);
});

test.each([
    ['/echo hello', true], [' \n/stop', true], ['hello /echo', false], ['', false], [null, false],
])('recognises composer command input %j', (text, expected) => {
    expect(isSlashCommandText(text)).toBe(expected);
});
