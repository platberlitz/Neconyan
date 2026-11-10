/* global globalThis */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { buildRegexScriptRefsForAgent, resolveRegexScriptsForSnapshot } from '../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js';
import { applyRegexScriptList } from '../public/scripts/extensions/in-chat-agents/regex-scripts.js';

const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const chat = [];
const updateMessageElement = jest.fn();
const updatePreviewMessageText = jest.fn(() => true);
const scrollChatToBottom = jest.fn();
const isChatScrollInMotion = jest.fn(() => false);
const refreshChatViewportBaseline = jest.fn();
const changeMessageTextForReader = jest.fn((getTextElement, mutate) => ({ result: mutate(), kept: true }));
const renderedEvents = [];
const thinking = { update: jest.fn(), clear: jest.fn() };

jest.unstable_mockModule('../public/scripts/streaming-thinking.js', () => ({
    StreamingThinkingIndicator: class { constructor() { return thinking; } },
}));

jest.unstable_mockModule('../public/script.js', () => ({
    chat,
    formatGenerationTimer: () => ({ timerValue: '1.0s', timerTitle: '1 second' }),
    getRequestHeaders: () => ({}),
    getThumbnailUrl: () => '/thumbnails/nova.png',
    changeMessageTextForReader,
    isChatScrollInMotion,
    refreshChatViewportBaseline,
    scrollChatToBottom,
    updateMessageElement,
    updatePreviewMessageText,
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/roleplay-replacement.js', () => ({
    beginRoleplayReplacement: () => () => {},
    commitRoleplayReplacement: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/abort.js', () => ({
    withAbortSignal: (promise, signal) => new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('Aborted'));
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener?.('abort', onAbort, { once: true });
        promise.then(value => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve(value);
        }, error => {
            signal?.removeEventListener?.('abort', onAbort);
            reject(error);
        });
    }),
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: {
        streaming_fps: 60,
        ios_webkit_conservative_streaming: false,
        android_conservative_streaming: false,
    },
}));
jest.unstable_mockModule('../public/scripts/mobile-streaming.js', () => ({
    getStreamingUpdateInterval: interval => interval,
}));

const mutationObservers = new Set();

function notifyMutation(element) {
    for (const observer of mutationObservers) {
        if (observer.target !== element) continue;
        queueMicrotask(() => {
            if (observer.target === element) observer.callback([{ type: 'childList', target: element }]);
        });
    }
}

class FakeMutationObserver {
    constructor(callback) {
        this.callback = callback;
        this.target = null;
    }

    observe(target) {
        this.target = target;
        mutationObservers.add(this);
    }

    disconnect() {
        mutationObservers.delete(this);
        this.target = null;
    }

    takeRecords() {
        return [];
    }
}

class FakeElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.dataset = {};
        this.style = { flexShrink: '', setProperty: jest.fn() };
        this.isConnected = false;
        this.nameText = null;
        this.timer = null;
        this.classList = { contains: () => false, toggle: jest.fn() };
    }

    get nextElementSibling() {
        if (!this.parentElement) return null;
        return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] ?? null;
    }

    get previousElementSibling() {
        if (!this.parentElement) return null;
        return this.parentElement.children[this.parentElement.children.indexOf(this) - 1] ?? null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    append(child) {
        const previousParent = child.parentElement;
        if (previousParent) {
            const previousIndex = previousParent.children.indexOf(child);
            if (previousIndex >= 0) previousParent.children.splice(previousIndex, 1);
        }
        this.children.push(child);
        child.parentElement = this;
        child.isConnected = this.isConnected;
        notifyMutation(this);
    }

    insertBefore(child, reference) {
        if (reference === null || reference === undefined) {
            this.append(child);
            return;
        }
        const index = this.children.indexOf(reference);
        if (index < 0) throw new Error('The reference element is not a child.');
        const previousParent = child.parentElement;
        if (previousParent) {
            const previousIndex = previousParent.children.indexOf(child);
            if (previousIndex >= 0) previousParent.children.splice(previousIndex, 1);
        }
        this.children.splice(this.children.indexOf(reference), 0, child);
        child.parentElement = this;
        child.isConnected = this.isConnected;
        notifyMutation(this);
    }

    before(reference) {
        this.parentElement?.insertBefore(reference, this);
    }

    remove() {
        const parent = this.parentElement;
        if (parent) parent.children = parent.children.filter(child => child !== this);
        this.parentElement = null;
        this.isConnected = false;
    }

    querySelector(selector) {
        if (selector === '.name_text') return this.nameText;
        if (selector === '[role="status"]') {
            return this.nameText?.parentElement?.children.find(child => child.attributes.get('role') === 'status') ?? null;
        }
        if (selector === '.mes_reasoning_details') return null;
        if (selector === '.mes_timer') return this.timer;
        return null;
    }

    querySelectorAll(selector) {
        if (selector === '.mes[mesid]') return this.children.filter(child => child.attributes.has('mesid'));
        return [];
    }
}

function createPreviewNode() {
    const node = new FakeElement('div');
    const block = new FakeElement('div');
    const nameRow = new FakeElement('div');
    const nameText = new FakeElement('span');
    node.nameText = nameText;
    nameText.parentElement = nameRow;
    nameRow.parentElement = block;
    block.parentElement = node;
    node.children.push(block);
    block.children.push(nameRow);
    nameRow.children.push(nameText);
    node.timer = new FakeElement('div');
    return node;
}

function createChat(replacementId = '1') {
    const root = new FakeElement('div');
    root.isConnected = true;
    root.scrollHeight = 1000;
    root.scrollTop = 900;
    root.clientHeight = 100;
    let replacement = null;
    if (replacementId !== null) {
        replacement = new FakeElement('div');
        replacement.dataset.roleplayReplacement = replacementId;
        root.children.push(replacement);
        replacement.parentElement = root;
        replacement.isConnected = true;
    }
    root.querySelector = selector => selector === '[data-roleplay-replacement]' ? replacement : null;
    return { root, replacement };
}

function appendSavedMessage(root, id, text) {
    const row = new FakeElement('div');
    row.setAttribute('mesid', String(id));
    row.textContent = text;
    root.append(row);
    return row;
}

let drawFrame = 0;
const queuedFrames = new Map();
const realSetTimeout = globalThis.setTimeout;

function installDom() {
    const document = new EventTarget();
    document.visibilityState = 'visible';
    document.createElement = tagName => new FakeElement(tagName);
    globalThis.document = document;
    document.addEventListener('neconyan:roleplay-preview-rendered', event => renderedEvents.push(event.detail));
    mutationObservers.clear();
    globalThis.MutationObserver = FakeMutationObserver;
    globalThis.requestAnimationFrame = callback => {
        const id = ++drawFrame;
        queuedFrames.set(id, realSetTimeout(() => {
            queuedFrames.delete(id);
            callback();
        }, 0));
        return id;
    };
    globalThis.cancelAnimationFrame = id => {
        const timer = queuedFrames.get(id);
        if (timer !== undefined) clearTimeout(timer);
        queuedFrames.delete(id);
    };
    globalThis.jQuery = element => [element];
    globalThis.addEventListener = jest.fn();
    globalThis.removeEventListener = jest.fn();
    return document;
}

function createStreamResponse() {
    let controller = null;
    const body = new ReadableStream({
        start(streamController) {
            controller = streamController;
        },
    });
    return {
        response: { status: 200, ok: true, body },
        send: value => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)),
    };
}

async function waitFor(predicate, timeoutMs = 2000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the preview draw.');
        await new Promise(resolve => realSetTimeout(resolve, 5));
    }
}

describe('Roleplay preview rendering', () => {
    let document;
    let chatFixture;
    let stream;
    let observeRoleplayPreview;
    let hasSamePreviewStructure;
    let activeStop = null;

    beforeEach(async () => {
        jest.resetModules();
        updateMessageElement.mockReset();
        updatePreviewMessageText.mockClear();
        scrollChatToBottom.mockClear();
        isChatScrollInMotion.mockReturnValue(false);
        refreshChatViewportBaseline.mockClear();
        changeMessageTextForReader.mockClear();
        thinking.update.mockClear();
        thinking.clear.mockClear();
        renderedEvents.length = 0;
        chat.length = 0;
        document = installDom();
        chatFixture = createChat();
        document.querySelector = selector => selector === '#chat' ? chatFixture.root : null;
        stream = createStreamResponse();
        globalThis.fetch = jest.fn(async () => stream.response);
        updateMessageElement.mockImplementation((message, options = {}) => {
            if (options.messageElement) return options.messageElement;
            return [createPreviewNode()];
        });

        ({ observeRoleplayPreview, hasSamePreviewStructure } = await import('../public/scripts/neconyan-conversation/roleplay-preview.js'));
    });

    afterEach(() => {
        activeStop?.();
        activeStop = null;
        globalThis.fetch = undefined;
    });

    function startPreview() {
        const stop = observeRoleplayPreview('preview-job', {
            account: 'test',
            isCurrent: () => true,
            onTerminal: () => {},
            name: 'Nova',
            messageIndex: 1,
        });
        activeStop = stop;
        return stop;
    }

    async function waitForFirstDraw() {
        await waitFor(() => updateMessageElement.mock.calls.length >= 1);
    }

    test('an Agent rewrite waits while the reader scrolls, then lands with the reader kept in place', async () => {
        startPreview();
        stream.send({ preview: { childId: 'reply', stage: 'generating', text: 'First line. Second line.' } });
        await waitForFirstDraw();
        const drawn = renderedEvents.length;
        chatFixture.root.scrollTop = 0;
        scrollChatToBottom.mockClear();
        isChatScrollInMotion.mockReturnValue(true);
        stream.send({ preview: { childId: 'reply', stage: 'agents', text: 'Second line.' } });
        await new Promise(resolve => realSetTimeout(resolve, 150));
        expect(renderedEvents).toHaveLength(drawn);
        expect(changeMessageTextForReader).not.toHaveBeenCalled();

        isChatScrollInMotion.mockReturnValue(false);
        await waitFor(() => renderedEvents.length > drawn);
        expect(renderedEvents.at(-1).message.mes).toBe('Second line.');
        expect(changeMessageTextForReader).toHaveBeenCalledTimes(1);
        expect(scrollChatToBottom).not.toHaveBeenCalledWith({ isNearBottom: true });
    });

    test('freezing the preview draws a waiting Agent rewrite at once', async () => {
        const stop = startPreview();
        stream.send({ preview: { childId: 'reply', stage: 'generating', text: 'First line. Second line.' } });
        await waitForFirstDraw();
        isChatScrollInMotion.mockReturnValue(true);
        stream.send({ preview: { childId: 'reply', stage: 'agents', text: 'Second line.' } });
        await new Promise(resolve => realSetTimeout(resolve, 150));
        stop.freeze();
        expect(renderedEvents.at(-1).message.mes).toBe('Second line.');
    });

    test('Agent frames render without following an active reader, then resume at rest', async () => {
        isChatScrollInMotion.mockReturnValue(true);
        startPreview();
        stream.send({ preview: { childId: 'reply', stage: 'agents', text: 'First Agent output' } });
        await waitForFirstDraw();
        expect(scrollChatToBottom).not.toHaveBeenCalled();
        expect(refreshChatViewportBaseline).toHaveBeenCalled();
        expect(renderedEvents.at(-1).message.mes).toBe('First Agent output');
        isChatScrollInMotion.mockReturnValue(false);
        stream.send({ delta: { text: '. Next output' } });
        await waitFor(() => renderedEvents.length >= 2);
        expect(scrollChatToBottom).toHaveBeenCalledWith({ isNearBottom: true });
    });

    test.each(['medium', undefined])('preview and recovery retain the accepted reasoning effort: %s', async effort => {
        const stop = startPreview();
        stream.send({ preview: { childId: 'reply', stage: 'generating', text: 'Hello.',
            generation: { source: 'custom', model: 'reasoning-model', reasoning_effort: effort } } });
        await waitForFirstDraw();
        expect(updateMessageElement.mock.calls[0][0].extra.reasoning_effort).toBe(effort);
        expect(stop.reply().extra.reasoning_effort).toBe(effort);
    });

    test('recovery keeps the accepted display and prompt regex rules without changing the reply text', async () => {
        const scripts = [
            { id: 'display', findRegex: '/\\[MOOD\\|([^\\]]+)\\]/g', replaceString: '<em>$1</em>', placement: [2], markdownOnly: true },
            { id: 'prompt', findRegex: '/\\[MOOD\\|([^\\]]+)\\]/g', replaceString: 'Mood: $1', placement: [2], promptOnly: true },
        ];
        const inChatAgents = { activeAgentIds: ['mood'], generationType: 'normal', edited: false,
            regexScriptRefs: buildRegexScriptRefsForAgent('mood', scripts),
            nativeRegexScripts: scripts.map(script => ({ agentId: 'mood', script })) };
        const stop = startPreview();
        stream.send({ preview: { childId: 'reply', stage: 'generating', text: '[MOOD|Calm] Hello.', inChatAgents } });
        await waitForFirstDraw();
        const reply = stop.reply();
        expect(reply.text).toBe('[MOOD|Calm] Hello.');
        expect(reply.extra.inChatAgents).toEqual(inChatAgents);
        const recoveredScripts = resolveRegexScriptsForSnapshot(reply.extra.inChatAgents);
        expect(applyRegexScriptList(reply.text, recoveredScripts, 2, { isMarkdown: true })).toBe('<em>Calm</em> Hello.');
        expect(applyRegexScriptList(reply.text, recoveredScripts, 2, { isPrompt: true })).toBe('Mood: Calm Hello.');
        reply.extra.inChatAgents.nativeRegexScripts[0].script.replaceString = 'Changed after recovery';
        expect(stop.reply().extra.inChatAgents).toEqual(inChatAgents);
    });

    test.each(['prose', 'reasoning', 'companions'])('waiting clears on %s without saving synthetic reasoning', async end => {
        const stop = startPreview();
        stream.send({ preview: { childId: 'reply', stage: 'generating', text: '' } });
        await waitForFirstDraw();
        const node = renderedEvents.at(-1).element;
        expect(thinking.update).toHaveBeenLastCalledWith(node, true);
        const patch = end === 'prose' ? { text: 'First words' }
            : end === 'reasoning' ? { reasoning: 'Considering' } : { stage: 'companions' };
        stream.send({ preview: { childId: 'reply', stage: 'generating', text: '', ...patch } });
        await waitFor(() => thinking.update.mock.calls.length > 1);
        expect(thinking.update).toHaveBeenLastCalledWith(node, false);
        expect(chat).toEqual([]);
        stop();
    });

    test.each(['freeze', 'terminal'])('waiting clears on %s and cannot reappear from a queued draw', async end => {
        const stop = startPreview();
        stream.send({ preview: { childId: 'reply', stage: 'generating', text: '' } });
        await waitForFirstDraw();
        thinking.clear.mockClear();
        stream.send({ delta: { text: '', set: { updatedAt: 10 } } });
        if (end === 'freeze') stop.freeze();
        else stream.send({ state: 'failed' });
        await waitFor(() => thinking.clear.mock.calls.length > 0);
        const draws = thinking.update.mock.calls.length;
        await new Promise(resolve => realSetTimeout(resolve, 25));
        expect(thinking.update).toHaveBeenCalledTimes(draws);
        expect(chat).toEqual([]);
    });

    test('the in-place updater uses preview formatting and only adds code controls when code exists', () => {
        const start = scriptSource.indexOf('export function updatePreviewMessageText');
        const end = scriptSource.indexOf('const firstMessageTokenCounts');
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const updater = scriptSource.slice(start, end);
        expect(updater).toContain('updateGreeting: false');
        expect(updater).toContain('messageContext: message');
        expect(updater).toContain('isPreview: true');
        expect(updater).toContain('applyStreamDomPatch(textElement, messageHTML);');
        expect(updater).toContain('textElement.querySelector(\'pre code\')');
        expect(updater.indexOf('textElement.querySelector(\'pre code\')')).toBeLessThan(updater.indexOf('addCopyToCodeBlocks(element);'));
        expect(updater).toContain('updateMessageMetaBadges(element, message);');
        expect(updater).not.toContain('updateMessageElement(');

        const codeStart = scriptSource.indexOf('export function addCopyToCodeBlocks');
        const codeEnd = scriptSource.indexOf('function updateMessageItemizedPromptButton');
        expect(scriptSource.slice(codeStart, codeEnd)).toContain('if (codeBlocks.get(i).querySelector(\'.code-copy\')) {');
    });

    test('structure comparison ignores text and counters but notices every structural reference', () => {
        const agents = { tracker: { id: 'tracker' } };
        const companions = {};
        const generation = { source: 'openai', model: 'gpt-5' };
        const base = { childId: 'reply-1', stage: 'generating', name: 'Nova', avatar: 'nova.png',
            gen_started: '2026-01-01T00:00:00.000Z', gen_finished: undefined, reasoning: '',
            reasoning_finished: true, reasoning_duration: 20, inChatAgents: agents,
            inChatAgentCompanionResults: companions, generation };
        expect(hasSamePreviewStructure(base, { ...base, text: 'grew', token_count: 42, updatedAt: 9 })).toBe(true);
        expect(hasSamePreviewStructure(base, { ...base, childId: 'reply-2' })).toBe(false);
        expect(hasSamePreviewStructure(base, { ...base, stage: 'agents' })).toBe(false);
        expect(hasSamePreviewStructure(base, { ...base, name: 'Miso' })).toBe(false);
        expect(hasSamePreviewStructure(base, { ...base, avatar: 'miso.png' })).toBe(false);
        expect(hasSamePreviewStructure(base, { ...base, gen_finished: '2026-01-01T00:00:05.000Z' })).toBe(false);
        expect(hasSamePreviewStructure(base, { ...base, reasoning: 'Thought' })).toBe(false);
        expect(hasSamePreviewStructure(base, { ...base, reasoning_finished: false })).toBe(false);
        expect(hasSamePreviewStructure(base, { ...base, reasoning_duration: 21 })).toBe(false);
        expect(hasSamePreviewStructure(base, { ...base, inChatAgents: { ...agents } })).toBe(false);
        expect(hasSamePreviewStructure(base, { ...base, inChatAgentCompanionResults: { ...companions } })).toBe(false);
        expect(hasSamePreviewStructure(base, { ...base, generation: { ...generation } })).toBe(false);
        expect(hasSamePreviewStructure(null, base)).toBe(false);
    });

    test('streaming text updates in place, while stage, name, model and Companion changes rebuild', async () => {
        const stop = startPreview();
        const base = {
            childId: 'reply-1',
            stage: 'generating',
            name: 'Nova',
            avatar: 'nova.png',
            reasoning: '',
            gen_started: new Date().toISOString(),
            text: 'Hello',
        };
        stream.send({ preview: base });
        await waitForFirstDraw();
        expect(updatePreviewMessageText).not.toHaveBeenCalled();
        const node = renderedEvents.at(-1).element;
        const status = node.querySelector('[role="status"]');
        let statusText = status.textContent;
        const writeStatus = jest.fn(value => { statusText = value; });
        Object.defineProperty(status, 'textContent', { get: () => statusText, set: writeStatus });
        let child = node.dataset.roleplayChild;
        const writeChild = jest.fn(value => { child = value; });
        Object.defineProperty(node.dataset, 'roleplayChild', { get: () => child, set: writeChild });

        stream.send({ delta: { text: ' world', set: { updatedAt: 2 } } });
        await waitFor(() => updatePreviewMessageText.mock.calls.length >= 1);
        expect(updateMessageElement).toHaveBeenCalledTimes(1);
        expect(updatePreviewMessageText.mock.calls[0][1]).toMatchObject({ mes: 'Hello world' });
        expect(updatePreviewMessageText.mock.calls[0][2]).toMatchObject({ updateText: true, messageId: 1 });
        expect(renderedEvents.at(-1).message.mes).toBe('Hello world');
        expect(renderedEvents.at(-1).element.id).toBe('neconyan-roleplay-preview');
        expect(scrollChatToBottom).toHaveBeenCalledTimes(2);

        // A count-only frame repaints the badges without reformatting the body.
        stream.send({ delta: { set: { token_count: 7 } } });
        await waitFor(() => updatePreviewMessageText.mock.calls.length >= 2);
        expect(updateMessageElement).toHaveBeenCalledTimes(1);
        expect(updatePreviewMessageText.mock.calls[1][2]).toMatchObject({ updateText: false });
        expect(writeStatus).not.toHaveBeenCalled();
        expect(writeChild).not.toHaveBeenCalled();

        stream.send({ delta: { text: ' again', set: { stage: 'companions' } } });
        await waitFor(() => updateMessageElement.mock.calls.length >= 2);
        expect(updatePreviewMessageText).toHaveBeenCalledTimes(2);
        expect(writeStatus).toHaveBeenCalledTimes(1);
        expect(status.textContent).toBe('Running Companions…');
        expect(writeChild).not.toHaveBeenCalled();

        stream.send({ delta: { set: { name: 'Miso' } } });
        await waitFor(() => updateMessageElement.mock.calls.length >= 3);
        expect(updatePreviewMessageText).toHaveBeenCalledTimes(2);

        stream.send({ delta: { set: { inChatAgentCompanionResults: { tracker: { status: 'done', content: 'State' } } } } });
        await waitFor(() => updateMessageElement.mock.calls.length >= 4);
        expect(updatePreviewMessageText).toHaveBeenCalledTimes(2);

        stream.send({ delta: { set: { generation: { source: 'openai', model: 'gpt-5' } } } });
        await waitFor(() => updateMessageElement.mock.calls.length >= 5);
        expect(updatePreviewMessageText).toHaveBeenCalledTimes(2);

        expect(chat).toEqual([]);
        stop();
    });

    test('unfinished reasoning rebuilds until it finishes, then text streams in place', async () => {
        const stop = startPreview();

        stream.send({ preview: {
            childId: 'reply-1',
            stage: 'generating',
            name: 'Nova',
            avatar: 'nova.png',
            reasoning: 'Think',
            reasoning_finished: false,
            text: '',
        } });
        await waitForFirstDraw();

        stream.send({ delta: { reasoning: 'ing', set: {} } });
        await waitFor(() => updateMessageElement.mock.calls.length >= 2);
        expect(updatePreviewMessageText).not.toHaveBeenCalled();

        stream.send({ delta: { set: { reasoning_finished: true } } });
        await waitFor(() => updateMessageElement.mock.calls.length >= 3);
        expect(updatePreviewMessageText).not.toHaveBeenCalled();

        stream.send({ delta: { text: ' Answer' } });
        await waitFor(() => updatePreviewMessageText.mock.calls.length >= 1);
        expect(updateMessageElement).toHaveBeenCalledTimes(3);
        expect(updatePreviewMessageText.mock.calls[0][1]).toMatchObject({ mes: ' Answer' });

        stop();
    });

    test('a preview that arrives before saved messages render stays after them', async () => {
        chatFixture = createChat(null);
        document.querySelector = selector => selector === '#chat' ? chatFixture.root : null;
        const stop = startPreview();
        stream.send({ preview: {
            childId: 'reply-1',
            stage: 'generating',
            name: 'Nova',
            avatar: 'nova.png',
            reasoning: '',
            text: 'Live reply.',
        } });
        await waitForFirstDraw();
        const preview = renderedEvents.at(-1).element;
        expect(chatFixture.root.children).toContain(preview);

        // A reopened page writes the saved greeting and question while the preview
        // is already on screen. They must stay first, with the draft below them.
        const greeting = appendSavedMessage(chatFixture.root, 0, 'Retained answer.');
        const question = appendSavedMessage(chatFixture.root, 1, 'Retained question.');
        await waitFor(() => chatFixture.root.children.indexOf(preview) > chatFixture.root.children.indexOf(question));

        expect(chatFixture.root.children[0]).toBe(greeting);
        expect(chatFixture.root.children[1]).toBe(question);
        expect(preview.previousElementSibling).toBe(question);
        expect(preview.isConnected).toBe(true);
        stop();
    });

    test('freezing keeps the last drawn reply and never writes the draft into chat', async () => {
        const stop = startPreview();

        stream.send({ preview: {
            childId: 'reply-1',
            stage: 'generating',
            name: 'Nova',
            avatar: 'nova.png',
            reasoning: '',
            text: 'Saved soon',
        } });
        await waitForFirstDraw();

        const fullCalls = updateMessageElement.mock.calls.length;
        const fastCalls = updatePreviewMessageText.mock.calls.length;
        const drawnNode = renderedEvents.at(-1).element;
        stop.freeze();

        await new Promise(resolve => realSetTimeout(resolve, 25));
        expect(updateMessageElement).toHaveBeenCalledTimes(fullCalls);
        expect(updatePreviewMessageText).toHaveBeenCalledTimes(fastCalls);
        expect(drawnNode.isConnected).toBe(true);
        expect(chat).toEqual([]);

        stop();
        expect(drawnNode.isConnected).toBe(false);
        expect(chat).toEqual([]);
    });
});
