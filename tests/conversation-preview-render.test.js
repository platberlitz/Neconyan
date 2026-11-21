import { readFileSync } from 'node:fs';
import { beforeEach, expect, jest, test } from '@jest/globals';

const timeline = jest.fn();
const interfaceRefresh = jest.fn();

jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({}) }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'alice' }));
jest.unstable_mockModule('../public/scripts/abort.js', () => ({ withAbortSignal: promise => promise }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-scheduler.js', () => ({
    scheduleInterfaceRefresh: interfaceRefresh,
    scheduleTimelineRender: timeline,
}));

const listeners = new Map();
globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
};
globalThis.window = {
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
};

const { observeNativeConversationPreview } = await import('../public/scripts/neconyan-conversation/native-preview.js');

let controller;
let stop;
const settle = async () => {
    for (let step = 0; step < 12; step++) await new Promise(resolve => setTimeout(resolve, 0));
};
const send = async participants => {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ preview: { participants } })}\n\n`));
    await settle();
};

beforeEach(() => {
    jest.clearAllMocks();
    globalThis.fetch = jest.fn(async () => new Response(new ReadableStream({ start(stream) { controller = stream; } }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    }));
});

test('a streamed preview redraws only the timeline until the speakers change', async () => {
    stop = observeNativeConversationPreview('job', 'alice');
    await settle();

    await send([{ avatar: 'one.png', name: 'One', text: 'A' }]);
    expect(interfaceRefresh).toHaveBeenCalledTimes(1);
    expect(timeline).not.toHaveBeenCalled();

    await send([{ avatar: 'one.png', name: 'One', text: 'A longer line' }]);
    expect(interfaceRefresh).toHaveBeenCalledTimes(1);
    expect(timeline).toHaveBeenCalledTimes(1);

    await send([{ avatar: 'one.png', name: 'One', text: 'A longer line' }, { avatar: 'two.png', name: 'Two', text: '' }]);
    expect(interfaceRefresh).toHaveBeenCalledTimes(2);
    expect(timeline).toHaveBeenCalledTimes(1);

    stop();
    stop = null;
    controller.close();
    await settle();
});

test('the timeline paints streamed text in place while the message list is unchanged', () => {
    const source = readFileSync(new URL('../public/scripts/neconyan-conversation/timeline-render.js', import.meta.url), 'utf8');
    expect(source).toContain('return { stableFingerprint, typingFingerprint };');
    expect(source).toContain('const renderedFingerprintMatches = !contextChanged');
    expect(source).toContain('if (renderedFingerprintMatches && typingFingerprint !== conversationState.lastTimelineTypingFingerprint) {');
    expect(source).toContain('conversationState.lastTimelineTypingFingerprint = typingFingerprint;');
});
