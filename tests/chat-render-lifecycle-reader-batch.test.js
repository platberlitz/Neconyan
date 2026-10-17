import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const names = ['getMessageElementList', 'markReaderPreservingResizeBlock', 'changeMessagesBelowReader', 'changeMessageBelowReader',
    'getObservedElementHeight'];
const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(row => row.declaration ?? row).filter(row => names.includes(row.id?.name))
    .map(row => source.slice(row.start, row.end)).join('\n');

function fakeBlock(height, isConnected = true) {
    return {
        height,
        isConnected,
        reads: 0,
        getBoundingClientRect() {
            this.reads += 1;
            return { height: this.height };
        },
    };
}

function runtimeFor() {
    const capture = jest.fn(() => ({ messageId: '1', offsetTop: 20 }));
    const restore = jest.fn(() => true);
    const refresh = jest.fn();
    const runtime = vm.createContext({
        captureVisibleChatMessageAnchor: capture,
        restoreVisibleChatMessageAnchor: restore,
        refreshObservedChatMessageResizeViewportStates: refresh,
        readerPreservingResizeBlocks: new WeakSet(),
        chatMessageResizeStates: new Map(),
        getMessageBlockElement: element => element.block,
    });
    vm.runInContext(functions, runtime);
    return { runtime, capture, restore, refresh };
}

test('a whole-chat note pass reads and restores once and marks only grown blocks', () => {
    const { runtime, capture, restore, refresh } = runtimeFor();
    const first = fakeBlock(100);
    const unchanged = fakeBlock(100);
    const third = fakeBlock(100);
    const rows = [first, unchanged, third].map(block => ({ block }));
    runtime.chatMessageResizeStates.set(first, { blockHeight: 100 });
    runtime.chatMessageResizeStates.set(unchanged, { blockHeight: 100 });
    runtime.chatMessageResizeStates.set(third, { blockHeight: 100 });

    const result = runtime.changeMessagesBelowReader(rows, () => {
        // Every height was read before the first write.
        expect(rows.map(row => row.block.reads)).toEqual([1, 1, 1]);
        first.height += 80;
        third.height += 40;
        return 'applied';
    });

    expect(result).toBe('applied');
    expect(capture).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(rows.map(row => row.block.reads)).toEqual([2, 2, 2]);
    expect(runtime.readerPreservingResizeBlocks.has(first)).toBe(true);
    expect(runtime.readerPreservingResizeBlocks.has(unchanged)).toBe(false);
    expect(runtime.readerPreservingResizeBlocks.has(third)).toBe(true);
    expect(runtime.chatMessageResizeStates.get(first).growthBelowReader).toBe(true);
    expect(runtime.chatMessageResizeStates.get(third).growthBelowReader).toBe(true);
    expect(runtime.chatMessageResizeStates.get(unchanged).growthBelowReader).toBeUndefined();
});

test('detached prepared rows are changed without scanning the live chat or measuring them', () => {
    const { runtime, capture, restore, refresh } = runtimeFor();
    const detached = fakeBlock(100, false);
    const mutate = jest.fn(() => {
        detached.height += 200;
    });

    runtime.changeMessagesBelowReader([{ block: detached }], mutate);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(detached.reads).toBe(0);
});

test('a mixed batch measures only the connected row', () => {
    const { runtime, capture, restore, refresh } = runtimeFor();
    const connected = fakeBlock(100);
    const detached = fakeBlock(120, false);

    runtime.changeMessagesBelowReader([{ block: connected }, { block: detached }], () => {
        connected.height += 50;
        detached.height += 50;
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(connected.reads).toBe(2);
    expect(detached.reads).toBe(0);
    expect(runtime.readerPreservingResizeBlocks.has(connected)).toBe(true);
    expect(runtime.readerPreservingResizeBlocks.has(detached)).toBe(false);
});

test('an unchanged batch refreshes no viewport baseline', () => {
    const { runtime, capture, restore, refresh } = runtimeFor();
    const block = fakeBlock(100);

    runtime.changeMessagesBelowReader([{ block }], () => {});

    expect(capture).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(runtime.readerPreservingResizeBlocks.has(block)).toBe(false);
});

test('the single-message wrapper delegates one row and still marks growth', () => {
    const { runtime, capture, restore, refresh } = runtimeFor();
    const block = fakeBlock(100);

    runtime.changeMessageBelowReader({ block }, () => {
        block.height += 20;
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(block.reads).toBe(2);
    expect(runtime.readerPreservingResizeBlocks.has(block)).toBe(true);
});
