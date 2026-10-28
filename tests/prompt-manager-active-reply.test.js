import { expect, jest, test } from '@jest/globals';
import { setImmediate } from 'node:timers/promises';
import { loadIsolated } from './pinned-prompt-test-support.js';
import * as lifecycle from '../public/scripts/prompt-manager-lifecycle/index.js';

async function fixture({ visible = true } = {}) {
    let finishReply;
    let reveal;
    const reply = new Promise(resolve => { finishReply = resolve; });
    const { PromptManager } = await loadIsolated('scripts/PromptManager.js', {
        '../script.js': { main_api: 'openai', is_send_press: true, eventSource: { emit: jest.fn() }, event_types: {} },
        './group-chats.js': { is_group_generating: false },
        './utils.js': { debounce: fn => fn, waitUntilCondition: () => reply },
        './prompt-manager-lifecycle/index.js': lifecycle,
    }, {
        document: { getElementById: () => null },
        IntersectionObserver: class {
            constructor(callback) { reveal = () => { visible = true; callback([{ isIntersecting: true }]); }; }
            observe() {}
            disconnect() {}
        },
    });
    const manager = new PromptManager();
    manager.activeCharacter = { id: 1 };
    manager.containerElement = { isConnected: true, checkVisibility: () => visible };
    manager.isDesktopSplitLayout = () => false;
    manager.profileStart = jest.fn();
    manager.profileEnd = jest.fn();
    manager.populateSourcePromptTokenCounts = jest.fn(async () => {});
    manager.renderPromptManager = jest.fn(async () => true);
    manager.renderPromptManagerListItems = jest.fn(async () => true);
    manager.makeDraggable = jest.fn();
    manager.tryGenerate = jest.fn(async () => {});
    return { manager, finishReply, reveal: () => reveal() };
}

test('first opening during a reply shows controls without starting a dry run', async () => {
    const { manager, finishReply, reveal } = await fixture({ visible: false });
    manager.render();
    await setImmediate();
    expect(manager.renderPromptManager).not.toHaveBeenCalled();
    expect(manager.populateSourcePromptTokenCounts).not.toHaveBeenCalled();
    expect(manager.tryGenerate).not.toHaveBeenCalled();

    reveal();
    await setImmediate();
    expect(manager.renderPromptManagerListItems).toHaveBeenCalledTimes(1);
    expect(manager.tryGenerate).not.toHaveBeenCalled();

    finishReply();
    await setImmediate();
    expect(manager.tryGenerate).toHaveBeenCalledTimes(1);
    expect(manager.renderPromptManagerListItems).toHaveBeenCalledTimes(2);
});

test('a newer render replaces the pending post-reply refresh', async () => {
    const { manager, finishReply } = await fixture();
    manager.render();
    await setImmediate();
    manager.render();
    await setImmediate();
    expect(manager.renderPromptManagerListItems).toHaveBeenCalledTimes(2);
    expect(manager.tryGenerate).not.toHaveBeenCalled();

    finishReply();
    await setImmediate();
    expect(manager.tryGenerate).toHaveBeenCalledTimes(1);
    expect(manager.renderPromptManagerListItems).toHaveBeenCalledTimes(3);
});
