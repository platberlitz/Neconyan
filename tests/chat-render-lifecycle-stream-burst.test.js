import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as generationOutcome from '../public/scripts/generation-outcome.js';
import { createStreamWriteBuffer } from '../public/scripts/chat-render-lifecycle/stream-buffer.js';
import { parse } from 'acorn';

// Runs the real StreamingProcessor, the real stream write buffer and the real
// applyStreamingVisibleWrite together, so the burst behaviour below is the shipped
// path and not a stub of either side.
const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const classSource = source.slice(source.indexOf('class StreamingProcessor {'), source.indexOf('\n/**', source.indexOf('\n}\n', source.indexOf('class StreamingProcessor {'))));
const applyWriteSource = source.match(/^function applyStreamingVisibleWrite\([\s\S]*?^}$/m)[0];

function replacement() {
    return { mes: 'different chat', name: 'Other', extra: {}, swipe_id: 0, swipes: ['untouched'], swipe_info: [{ extra: { keep: true } }] };
}

// Loads named top-level declarations from a real source file into the VM context, so the class calls the actual helpers.
function loadDeclarations(context, file, names) {
    const fileSource = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    const ast = parse(fileSource, { ecmaVersion: 'latest', sourceType: 'module' });
    for (const name of names) {
        const node = ast.body.map(item => item.declaration ?? item)
            .find(item => item.id?.name === name || item.declarations?.some(declaration => declaration.id.name === name));
        if (!node) throw new Error(`Missing declaration: ${name}`);
        vm.runInContext(fileSource.slice(node.start, node.end), context);
    }
}

function createManualScheduler() {
    let callback = null;
    return {
        requestCount: 0,
        cancelCount: 0,
        get pending() {
            return typeof callback === 'function';
        },
        request(cb) {
            this.requestCount += 1;
            callback = cb;
        },
        cancel() {
            this.cancelCount += 1;
            callback = null;
        },
        flush() {
            const run = callback;
            callback = null;
            run?.();
        },
    };
}

class Element {
    isConnected = true;
    mesid = '0';
    innerHTML = '';
    textContent = '';
    title = '';
    classList = { toggle() {} };
    querySelector() { return this; }
    getAttribute(name) { return name === 'mesid' ? this.mesid : null; }
}

async function stream() {
    const elements = new Map();
    const scheduler = createManualScheduler();
    const context = vm.createContext({
        ...generationOutcome,
        console, AbortController, structuredClone,
        StreamingThinkingIndicator: class { update = jest.fn(); clear = jest.fn(); },
        chat: [], chat_metadata: {}, chatId: 'original', chatGeneration: 1, activeGenerationRun: {}, streamingProcessor: null,
        saveChatConditional: jest.fn(async () => true),
        document: {
            querySelector: selector => {
                const mesid = /mesid="(\d+)"/.exec(selector ?? '')?.[1] ?? '0';
                if (!elements.has(mesid)) {
                    const element = new Element();
                    element.mesid = mesid;
                    elements.set(mesid, element);
                }
                return elements.get(mesid);
            },
        },
        HTMLElement: Element,
        power_user: { streaming_fps: 30, stream_fade_in: false, android_streaming_basic_markdown: false },
        main_api: 'openai', scrollLock: false, scrollLockImmunityUntil: 0,
        IN_CHAT_AGENT_TRANSFORM_HISTORY_KEY: 'history', IN_CHAT_AGENT_PRE_GENERATION_INTERCEPT_HISTORY_KEY: 'intercept',
        ReasoningHandler: class {
            reasoning = '';
            process = async () => {};
            updateDom() {}
            updateReasoning() {}
            hasReasoningContent() { return false; }
            getDuration() { return 0; }
        },
        event_types: {}, eventSource: { emit: jest.fn(async () => {}) },
        delay: async () => {}, Stopwatch: class { async tick(callback) { await callback(); } },
        getStoppingStrings: () => [], getStreamingUpdateInterval: () => 1,
        cleanUpMessage: ({ getMessage }) => getMessage,
        shouldReduceStreamingDomWork: () => false, shouldGuardMobileChatScroll: () => false,
        shouldPinMobileChatToBottom: () => false, isMobileChatManualScrollSuppressionActive: () => false,
        isAndroidStreamingPlatform: () => false, shouldUsePlainTextStreamingPreview: () => false,
        getPositiveTokenCount: value => Number(value) || 0,
        updateMessageTokenAccounting: jest.fn(async () => ({ outputTokens: 1, reasoningTokens: 0 })),
        balanceStreamingMarkdown: value => value,
        messageFormatting: jest.fn(text => `<p>${text}</p>`),
        formatGenerationTimer: jest.fn(() => ({ timerValue: '1.0s', timerTitle: '1 second' })),
        deactivateSendButtons() {}, hideSwipeButtons() {}, unblockGeneration() {},
        scrollStartedStreamingMessageThroughLifecycle() {}, scrollChatToBottom: jest.fn(),
        CHAT_RENDER_LIFECYCLE_ROUTE: { STREAM_PROGRESS: 'stream' },
        isChatRenderLifecycleRolloutEnabled: () => true,
        updateMessageMetaBadges: jest.fn(),
        setCardScriptMessageStreaming: jest.fn(),
        scheduleCardScriptReconcile: jest.fn(),
        applyStreamFadeIn: jest.fn((element, text) => { element.innerHTML = text; }),
    });
    context.getCurrentChatId = () => context.chatId;
    context.saveReply = async () => { context.chat.push({ ...replacement(), mes: 'original', name: 'Alice', swipes: ['original'] }); };
    loadDeclarations(context, 'scripts/stream-completion.js', ['completedMessages', 'markStreamCompleted', 'unmarkStreamCompleted', 'isStreamCompleted', 'setContinuationEmptyMarker', 'setGenerationToolTurnMarker', 'setFreshReasoningMarker']);
    loadDeclarations(context, 'scripts/reasoning.js', ['setReasoningUnclosedMarker']);
    loadDeclarations(context, 'script.js', ['setGenerationFinishMarker']);
    // The real visible-write applier, loaded like the host loads it.
    vm.runInContext(applyWriteSource, context);
    // The buffer is the real one; its scheduler is manual so the test controls the frame.
    const buffer = createStreamWriteBuffer({
        scheduler,
        applyWrite: (messageId, write, options) => context.applyStreamingVisibleWrite(messageId, write, options),
    });
    context.getStreamingVisibleWriteBuffer = () => buffer;
    vm.runInContext(`${classSource}\nthis.StreamingProcessor = StreamingProcessor;`, context);
    const processor = new context.StreamingProcessor('normal', false, new Date(), '', { prefixReasoning: '', removePrefix: text => text });
    context.streamingProcessor = processor;
    processor.messageId = await processor.onStartStreaming('original');
    return { context, processor, scheduler, messageTextDom: processor.messageTextDom };
}

describe('streaming burst coalescing through the real buffer', () => {
    test('chunks arriving within one frame format once, with the latest text', async () => {
        const { context, processor, scheduler, messageTextDom } = await stream();

        await processor.onProgressStreaming(0, 'chunk one', false);
        await processor.onProgressStreaming(0, 'chunk two', false);
        await processor.onProgressStreaming(0, 'chunk three', false);

        // Nothing formats eagerly: the two earlier chunks were overwritten unread.
        expect(context.messageFormatting).not.toHaveBeenCalled();
        expect(messageTextDom.innerHTML).toBe('');
        // One scheduled frame serves the whole burst.
        expect(scheduler.requestCount).toBe(1);
        expect(scheduler.pending).toBe(true);

        scheduler.flush();

        expect(context.messageFormatting).toHaveBeenCalledTimes(1);
        expect(context.messageFormatting.mock.calls[0][0]).toBe('chunk three');
        expect(messageTextDom.innerHTML).toBe('<p>chunk three</p>');
        expect(scheduler.pending).toBe(false);
    });

    test('the final chunk flushes synchronously, so the DOM is final before the call resolves', async () => {
        const { context, processor, scheduler, messageTextDom } = await stream();

        await processor.onProgressStreaming(0, 'draft text', false);
        expect(messageTextDom.innerHTML).toBe('');
        expect(scheduler.pending).toBe(true);

        await processor.onProgressStreaming(0, 'final words', true);

        expect(context.messageFormatting).toHaveBeenCalledTimes(1);
        expect(context.messageFormatting.mock.calls[0][0]).toBe('final words');
        expect(messageTextDom.innerHTML).toBe('<p>final words</p>');
        expect(scheduler.pending).toBe(false);
        expect(scheduler.cancelCount).toBeGreaterThanOrEqual(1);
    });

    test('deferred timer formatting keeps the tick state captured at queue time', async () => {
        const { context, processor, scheduler } = await stream();
        const generationStart = processor.timeStarted;
        processor.timeToFirstToken = 123;
        processor.reasoningHandler.getDuration = () => 5000;

        await processor.onProgressStreaming(0, 'some prose', false);
        // The clocks keep running while the write waits for its frame.
        processor.reasoningHandler.getDuration = () => 99999;
        processor.timeStarted = new Date(0);
        processor.timeToFirstToken = 456;

        scheduler.flush();

        expect(context.formatGenerationTimer).toHaveBeenCalledTimes(1);
        const [start, , , capturedDuration, capturedTimeToFirstToken] = context.formatGenerationTimer.mock.calls[0];
        expect(capturedDuration).toBe(5000);
        expect(capturedTimeToFirstToken).toBe(123);
        expect(start).toBe(generationStart);
    });

    test('a generation that went stale before its frame is dropped without formatting', async () => {
        const { context, processor, scheduler, messageTextDom } = await stream();

        await processor.onProgressStreaming(0, 'stale text', false);
        context.chat = [replacement()];
        context.chatGeneration += 1;

        scheduler.flush();

        expect(context.messageFormatting).not.toHaveBeenCalled();
        expect(messageTextDom.innerHTML).toBe('');
    });
});
