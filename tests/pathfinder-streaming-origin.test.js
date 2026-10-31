/* eslint-disable playwright/no-standalone-expect */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as generationOutcome from '../public/scripts/generation-outcome.js';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const classSource = source.slice(source.indexOf('class StreamingProcessor {'), source.indexOf('\n/**', source.indexOf('\n}\n', source.indexOf('class StreamingProcessor {'))));

function replacement() {
    return { mes: 'different chat', name: 'Other', extra: {}, swipe_id: 0, swipes: ['untouched'], swipe_info: [{ extra: { keep: true } }] };
}

async function stream(type = 'normal') {
    const writes = [];
    const reasoningDomWrite = jest.fn();
    const thinking = { update: jest.fn(), clear: jest.fn() };
    class Element {
        isConnected = true;
        classList = { toggle() {} };
        querySelector() { return this; }
        getAttribute() { return '0'; }
    }
    const element = new Element();
    const context = vm.createContext({
        ...generationOutcome,
        console, AbortController, structuredClone,
        StreamingThinkingIndicator: class { constructor() { return thinking; } },
        chat: [], chat_metadata: { tainted: true }, chatId: 'original', chatGeneration: 1, activeGenerationRun: {}, streamingProcessor: null,
        saveChatConditional: jest.fn(async () => true),
        document: { querySelector: () => element }, HTMLElement: Element,
        power_user: { streaming_fps: 30 }, main_api: 'openai', scrollLock: false, scrollLockImmunityUntil: 0,
        IN_CHAT_AGENT_TRANSFORM_HISTORY_KEY: 'history', IN_CHAT_AGENT_PRE_GENERATION_INTERCEPT_HISTORY_KEY: 'intercept',
        ReasoningHandler: class {
            reasoning = '';
            process = async () => {};
            updateDom = reasoningDomWrite;
            updateReasoning() {}
            hasReasoningContent() { return false; }
            getDuration() { return 0; }
        },
        event_types: { STREAM_TOKEN_RECEIVED: 'token' }, eventSource: { emit: jest.fn(async () => {}) },
        delay: async () => {}, Stopwatch: class { async tick(callback) { await callback(); } },
        getStoppingStrings: () => [], getStreamingUpdateInterval: () => 1,
        cleanUpMessage: ({ getMessage }) => getMessage,
        shouldReduceStreamingDomWork: () => false, shouldGuardMobileChatScroll: () => false,
        shouldPinMobileChatToBottom: () => false, isMobileChatManualScrollSuppressionActive: () => false,
        isAndroidStreamingPlatform: () => false, shouldUsePlainTextStreamingPreview: () => false,
        getPositiveTokenCount: value => Number(value) || 0,
        updateMessageTokenAccounting: jest.fn(async () => ({ outputTokens: 1, reasoningTokens: 0 })),
        balanceStreamingMarkdown: value => value, messageFormatting: value => value,
        formatGenerationTimer: () => ({}), deactivateSendButtons() {}, hideSwipeButtons() {}, unblockGeneration() {},
        scrollStartedStreamingMessageThroughLifecycle() {}, scrollChatToBottom: jest.fn(),
        CHAT_RENDER_LIFECYCLE_ROUTE: { STREAM_PROGRESS: 'stream' },
        isChatRenderLifecycleRolloutEnabled: () => true,
        getStreamingVisibleWriteBuffer: () => ({ queue: (...args) => writes.push(args) }),
        updateMessageMetaBadges: jest.fn(),
        setCardScriptMessageStreaming: jest.fn(),
        scheduleCardScriptReconcile: jest.fn(),
    });
    context.getCurrentChatId = () => context.chatId;
    context.saveReply = async () => { context.chat.push({ ...replacement(), mes: 'original', swipes: ['original'] }); };
    vm.runInContext(classSource + '\nthis.StreamingProcessor = StreamingProcessor;', context);
    const syncSwipe = source.match(/^export function syncMesToSwipe\([\s\S]*?^}$/m)[0].replace(/^export /, '');
    vm.runInContext(syncSwipe, context);
    const apply = source.match(/^function applyStreamingVisibleWrite\([\s\S]*?^}$/m)[0];
    vm.runInContext(apply, context);
    const processor = new context.StreamingProcessor(type, false, new Date(), '', { prefixReasoning: '', removePrefix: text => text });
    context.streamingProcessor = processor;
    processor.messageId = await processor.onStartStreaming('original');
    processor.generator = async function* () { yield { text: 'stale output', swipes: [], toolCalls: [], state: {} }; };
    return { context, processor, writes, reasoningDomWrite, thinking };
}

describe('streaming message origin', () => {
    test('records a provider length stop without turning an ordinary reply into a local prose limit', async () => {
        const { processor } = await stream();
        processor.generator = async function* () {
            yield { text: '', swipes: [], toolCalls: [], state: { reasoning: 'Still thinking', finishReason: 'length' } };
        };
        await processor.generate();
        expect(processor.providerLengthStop).toBe(true);
        expect(processor.finishReason).toBeNull();
    });

    test('shows a waiting indicator before output and clears it on the first prose', async () => {
        const { processor, thinking } = await stream();
        expect(thinking.update).toHaveBeenLastCalledWith(processor.messageDom, true);
        await processor.onProgressStreaming(0, 'First words', false);
        expect(thinking.update).toHaveBeenLastCalledWith(processor.messageDom, false);
    });

    test('keeps waiting through empty chunks and defers to actual reasoning', async () => {
        const { processor, thinking } = await stream();
        await processor.onProgressStreaming(0, '  ', false);
        expect(thinking.update).toHaveBeenLastCalledWith(processor.messageDom, true);
        processor.reasoningHandler.reasoning = 'Considering the question';
        await processor.onProgressStreaming(0, '', false);
        expect(thinking.update).toHaveBeenLastCalledWith(processor.messageDom, false);
    });

    test.each(['stop', 'error', 'abort', 'empty completion', 'chat switch'])('clears the owned waiting indicator on %s', async action => {
        const { context, processor, thinking } = await stream();
        if (action === 'stop') processor.onStopStreaming();
        if (action === 'error') await processor.onErrorStreaming();
        if (action === 'abort') processor.abortController.abort();
        if (action === 'empty completion') {
            processor.generator = async function* () {};
            await processor.generate();
        }
        if (action === 'chat switch') {
            context.eventSource.emit.mockImplementationOnce(async () => { context.chat = [replacement()]; context.chatGeneration++; });
            await processor.generate();
        }
        expect(thinking.clear).toHaveBeenCalled();
    });

    test('saves the owned error outcome on its current swipe before finishing', async () => {
        const { context, processor } = await stream();
        await processor.onErrorStreaming();
        expect(context.chat[0].swipe_info[0].extra.generation_outcome.status).toBe('error');
        expect(context.saveChatConditional).toHaveBeenCalledTimes(1);
    });

    test('a connection that could not be resumed keeps the text, marks it as cut short and shows the notice', async () => {
        const { context, processor } = await stream();
        context.renderGenerationOutcome = jest.fn();
        context.chatElement = { find: jest.fn(() => 'message element') };
        context.generationBlockedNotice = jest.fn(() => 'the notice');
        context.toastr = { warning: jest.fn() };
        await processor.onErrorStreaming(Object.assign(new Error('lost'), { code: 'GENERATION_CONNECTION_LOST' }));
        expect(context.chat[0].swipe_info[0].extra.generation_outcome).toEqual({ version: 1, status: 'truncated', reason: 'connection_lost' });
        expect(context.renderGenerationOutcome).toHaveBeenCalledWith('message element', context.chat[0]);
        // The same sentence also shows once as the warning toast that a cut-short reply shows in Build B.
        expect(context.generationBlockedNotice).toHaveBeenCalledWith(true, { version: 1, status: 'truncated', reason: 'connection_lost' });
        expect(context.toastr.warning).toHaveBeenCalledTimes(1);
        expect(context.toastr.warning).toHaveBeenCalledWith('the notice');
        expect(context.saveChatConditional).toHaveBeenCalledTimes(1);
    });

    test('continues updating the original message and swipe through normal stream completion', async () => {
        const { context, processor } = await stream();
        await processor.generate();
        await processor.onProgressStreaming(0, 'final output', true);
        expect(context.chat[0].mes).toBe('final output');
        expect(context.chat[0].swipes[0]).toBe('final output');
    });

    test.each(['chat switch', 'Stop'])('rechecks after token listeners before progress writes on %s', async reason => {
        const { context, processor } = await stream();
        context.eventSource.emit.mockImplementationOnce(async () => {
            if (reason === 'Stop') processor.onStopStreaming();
            else { context.chat = [replacement()]; context.chatGeneration++; }
        });
        const before = reason === 'Stop' ? structuredClone(context.chat[0]) : replacement();
        await processor.generate();
        expect(context.chat[0]).toEqual(before);
    });

    test('does not write through a reused index after the DOM lookup await', async () => {
        const { context, processor } = await stream();
        const pending = processor.onProgressStreaming(0, 'stale output', false);
        context.chat = [replacement()];
        context.chatGeneration++;
        await pending;
        expect(context.chat[0]).toEqual(replacement());
    });

    test('honours the originating host run guard before updating an otherwise unchanged message', async () => {
        const { context, processor } = await stream();
        const before = structuredClone(context.chat[0]);
        processor.isCurrentGeneration = () => false;
        await processor.onProgressStreaming(0, 'cancelled output', false);
        expect(context.chat[0]).toEqual(before);
    });

    test('does not update replacement swipe metadata after token accounting', async () => {
        const { context, processor } = await stream('continue');
        let release;
        let started;
        const accounting = new Promise(resolve => { started = resolve; });
        context.updateMessageTokenAccounting.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }); });
        const pending = processor.onProgressStreaming(0, 'stale output', true);
        await accounting;
        context.chat[0] = replacement();
        release({ outputTokens: 1, reasoningTokens: 0 });
        await pending;
        expect(context.chat[0]).toEqual(replacement());
    });

    test('does not let cancellation cleanup change a different message', async () => {
        const { context, processor } = await stream();
        context.chat[0] = replacement();
        processor.onStopStreaming();
        processor.setFirstSwipe(0);
        expect(context.chat[0]).toEqual(replacement());
    });

    test('guards the real initial saveReply after its token-count await', async () => {
        const { context } = await stream();
        context.chat = [];
        Object.assign(context, {
            name2: 'Assistant', generation_started: new Date(), selected_group: null,
            getMessageTimeStamp: () => 'now', getGeneratingApi: () => 'openai', getGeneratingModel: () => 'model', getCurrentReasoningEffort: () => null,
            processImageAttachment: async () => {}, addOneMessage: jest.fn(), statMesProcess() {},
        });
        vm.runInContext(source.match(/^export (async function saveReply\([\s\S]*?^})/m)[1], context);
        const processor = new context.StreamingProcessor('normal', false, new Date(), '', {});
        context.streamingProcessor = processor;
        let release;
        let started;
        const counting = new Promise(resolve => { started = resolve; });
        context.updateMessageTokenAccounting.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }); });
        const pending = processor.onStartStreaming('initial');
        await counting;
        context.chat = [replacement()];
        context.chatGeneration++;
        release({ outputTokens: 1, reasoningTokens: 0 });
        await pending;
        expect(context.chat[0]).toEqual(replacement());
        expect(context.addOneMessage).not.toHaveBeenCalled();
    });

    test('does not let delayed reasoning completion repaint a different chat', async () => {
        const { context, processor, reasoningDomWrite } = await stream();
        let release;
        let started;
        const processing = new Promise(resolve => { started = resolve; });
        processor.reasoningHandler.process = async () => {
            started();
            await new Promise(resolve => { release = resolve; });
            processor.reasoningHandler.updateDom(0);
        };
        const pending = processor.onProgressStreaming(0, 'valid output', false);
        await processing;
        context.chat = [replacement()];
        context.chatGeneration++;
        release();
        await pending;
        expect(context.chat[0]).toEqual(replacement());
        expect(reasoningDomWrite).not.toHaveBeenCalled();
    });

    test('rejects a queued DOM write after a chat switch', async () => {
        const { context, processor, writes } = await stream();
        await processor.onProgressStreaming(0, 'valid output', false);
        expect(writes).toHaveLength(1);
        context.chat = [replacement()];
        context.chatGeneration++;
        context.applyStreamingVisibleWrite(...writes[0]);
        expect(context.updateMessageMetaBadges).not.toHaveBeenCalled();
    });

    test('rejects a queued write when the renderer reused its DOM node for a different message', async () => {
        const { context, processor, writes } = await stream();
        await processor.onProgressStreaming(0, 'valid output', false);
        writes[0][1].messageDom.getAttribute = () => 'another-message';
        context.applyStreamingVisibleWrite(...writes[0]);
        expect(context.updateMessageMetaBadges).not.toHaveBeenCalled();
    });
});
