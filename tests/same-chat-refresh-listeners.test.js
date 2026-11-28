import fs from 'node:fs';
import vm from 'node:vm';
import { parseExpressionAt } from 'acorn';
import { describe, expect, jest, test } from '@jest/globals';

// A server reply that finishes brings the open chat up to date with its saved copy and then emits
// CHAT_CHANGED (with { sameChat: true }) and CHAT_LOADED (with detail.sameChat). These listeners react
// to opening another chat, so they must not treat that refresh as one.

const read = file => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const SAME_CHAT = Object.freeze({ sameChat: true });

/** The first expression starting at `start` in `source` that contains `marker`. */
function expressionAt(source, start, marker) {
    let index = source.indexOf(start);
    while (index >= 0) {
        const node = parseExpressionAt(source, index, { ecmaVersion: 'latest', sourceType: 'module' });
        const text = source.slice(node.start, node.end);
        if (!marker || text.includes(marker)) return text;
        index = source.indexOf(start, index + 1);
    }
    throw new Error(`No expression at ${start} containing ${marker}`);
}

/** Registers one eventSource listener from the source and returns it. */
function listenerFrom(file, event, marker, globals = {}, self = undefined) {
    const handlers = [];
    const context = vm.createContext({
        ...globals,
        event_types: { CHAT_CHANGED: 'chat_id_changed', CHAT_LOADED: 'chatLoaded' },
        eventSource: { on: (_name, handler) => handlers.push(handler) },
        __self: self,
    });
    const call = expressionAt(read(file), `eventSource.on(event_types.${event},`, marker);
    vm.runInContext(`(function () { ${call}; }).call(__self);`, context);
    expect(handlers).toHaveLength(1);
    return handlers[0];
}

/** Loads one function (declaration or arrow) from the source into a context with stubs. */
function functionFrom(file, start, globals) {
    const context = vm.createContext({ ...globals });
    const source = read(file);
    const at = source.indexOf(start);
    expect(at).toBeGreaterThanOrEqual(0);
    const fn = expressionAt(source.slice(at).replace(/^const \w+ = /, ''), start.replace(/^const \w+ = /, ''));
    vm.runInContext(`globalThis.__fn = (${fn});`, context);
    return { fn: context.__fn, context };
}

describe('listeners that react to opening another chat', () => {
    test('held-reply recovery does not run again for a chat that caught up with its saved copy', () => {
        const scheduleHeldGenerationRecovery = jest.fn();
        const listener = listenerFrom('script.js', 'CHAT_CHANGED', 'scheduleHeldGenerationRecovery', { scheduleHeldGenerationRecovery });
        listener('Nova - 1', SAME_CHAT);
        expect(scheduleHeldGenerationRecovery).not.toHaveBeenCalled();
        listener('Nova - 2');
        expect(scheduleHeldGenerationRecovery).toHaveBeenCalledTimes(1);
    });

    test('pending Companion cards are not marked interrupted under the job that saved them', () => {
        const recoverInterruptedCompanionRuns = jest.fn();
        const listener = listenerFrom('scripts/extensions/in-chat-agents/companion/companion-runner.js', 'CHAT_CHANGED',
            'recoverInterruptedCompanionRuns', { recoverInterruptedCompanionRuns });
        listener('Nova - 1', SAME_CHAT);
        expect(recoverInterruptedCompanionRuns).not.toHaveBeenCalled();
        listener('Nova - 2');
        expect(recoverInterruptedCompanionRuns).toHaveBeenCalledTimes(1);
    });

    test('quick replies set to run on chat change run when a chat opens, not when it catches up', async () => {
        const autoExec = { handleChatChanged: jest.fn(async () => undefined) };
        const manager = { rerender: jest.fn() };
        const buttons = { refresh: jest.fn() };
        const { fn: onChatChanged } = functionFrom('scripts/extensions/quick-reply/index.js', 'const onChatChanged = async (', {
            log: () => undefined,
            handleCharChange: jest.fn(),
            chat_metadata: {},
            QuickReplyConfig: { from: () => ({}) },
            settings: { save: jest.fn() },
            manager,
            buttons,
            autoExec,
        });
        await onChatChanged('Nova - 1', SAME_CHAT);
        expect(manager.rerender).toHaveBeenCalledTimes(1);
        expect(buttons.refresh).toHaveBeenCalledTimes(1);
        expect(autoExec.handleChatChanged).not.toHaveBeenCalled();
        await onChatChanged('Nova - 2');
        expect(autoExec.handleChatChanged).toHaveBeenCalledTimes(1);
    });

    test('text to speech keeps reading when the chat only caught up', async () => {
        const stubs = {
            onGenerationEnded: jest.fn(async () => undefined),
            resetTtsPlayback: jest.fn(),
            initVoiceMap: jest.fn(async () => undefined),
            delay: async () => undefined,
            debounce_timeout: { relaxed: 1000 },
            lastMessage: 'last narrated',
        };
        const { fn: onChatChanged, context } = functionFrom('scripts/extensions/tts/index.js', 'async function onChatChanged(', stubs);
        await onChatChanged('Nova - 1', SAME_CHAT);
        expect(stubs.resetTtsPlayback).not.toHaveBeenCalled();
        expect(context.lastMessage).toBe('last narrated');
        await onChatChanged('Nova - 2');
        expect(stubs.resetTtsPlayback).toHaveBeenCalledTimes(1);
        expect(context.lastMessage).toBeNull();
    });

    test('Quick Image Gen keeps its running image and cadence, and only redraws its controls', () => {
        const stubs = {
            isGenerating: true,
            requestGenerationCancel: jest.fn(),
            closePalettePresetMenu: jest.fn(),
            scheduleRefreshMessageGenerateActions: jest.fn(),
            resetAutoGenerateCadence: jest.fn(),
            cancelContextMediaWork: jest.fn(),
            clearRegenerationReferenceState: jest.fn(),
            _injectProcessingCount: 0,
            _processedInjectIndices: new Set([3]),
            loadCharSettings: jest.fn(async () => undefined),
            renderContextualFilters: jest.fn(),
            renderContextMediaSummary: jest.fn(),
        };
        const { fn: handleHostChatChanged } = functionFrom('scripts/extensions/quick-image-gen/index.js', 'function handleHostChatChanged(', stubs);
        handleHostChatChanged('Nova - 1', SAME_CHAT);
        expect(stubs.requestGenerationCancel).not.toHaveBeenCalled();
        expect(stubs.resetAutoGenerateCadence).not.toHaveBeenCalled();
        expect(stubs.cancelContextMediaWork).not.toHaveBeenCalled();
        expect(stubs._processedInjectIndices.size).toBe(1);
        expect(stubs.scheduleRefreshMessageGenerateActions).toHaveBeenCalledTimes(1);
        expect(stubs.renderContextMediaSummary).toHaveBeenCalledTimes(1);
        handleHostChatChanged('Nova - 2');
        expect(stubs.requestGenerationCancel).toHaveBeenCalledWith('Chat changed during generation', { force: true });
        expect(stubs.cancelContextMediaWork).toHaveBeenCalledWith({ resetCadence: true });
        expect(stubs._processedInjectIndices.size).toBe(0);
    });

    test('the prompt manager does not save settings each time the chat catches up', async () => {
        const manager = {
            handleCharacterSelected: jest.fn(),
            saveServiceSettings: jest.fn(async () => undefined),
            renderDebounced: jest.fn(),
        };
        const listener = listenerFrom('scripts/PromptManager.js', 'CHAT_LOADED', 'handleCharacterSelected', {}, manager);
        listener({ detail: { id: 0, character: { avatar: 'nova.png' }, sameChat: true } });
        expect(manager.handleCharacterSelected).not.toHaveBeenCalled();
        expect(manager.saveServiceSettings).not.toHaveBeenCalled();
        expect(manager.renderDebounced).toHaveBeenCalledTimes(1);
        listener({ detail: { id: 1, character: { avatar: 'orion.png' } } });
        await Promise.resolve();
        expect(manager.handleCharacterSelected).toHaveBeenCalledTimes(1);
        expect(manager.saveServiceSettings).toHaveBeenCalledTimes(1);
    });
});
