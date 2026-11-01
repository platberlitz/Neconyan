import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    escapeRegex: value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
}));

const {
    CHAT_LABEL_TITLE_LIMIT,
    createChatAutoNamer,
    extractGeneratedChatLabel,
    getChatAutoNameProgress,
    isChatReadyForAutoName,
    normalizeChatAutoNameThreshold,
    normalizeGeneratedChatLabel,
} = await import('../public/scripts/chat-label.js');

describe('chat auto-label parser', () => {
    test('accepts valid structured and plain labels', () => {
        const cases = [
            ['{"title":"Moonlit Escape"}', 'Moonlit Escape'],
            ['{"label":"A Pact at Dawn"}', 'A Pact at Dawn'],
            ['{"name":"The Hidden Observatory"}', 'The Hidden Observatory'],
            ['"Letters from the North"', 'Letters from the North'],
            ['"[Letters] from {the North}"', 'Letters from the North'],
            ['{"title":null,"label":"The Silver Compass"}', 'The Silver Compass'],
            ['```json\n{"title":"A Dance in Winter"}\n```', 'A Dance in Winter'],
            ['<think>This needs a concise title.</think>\n{"title":"The Last Lantern"}', 'The Last Lantern'],
            ['A Quiet Morning', 'A Quiet Morning'],
            ['Chat title: Rowan - Midnight / Escape?', 'Midnight Escape'],
            ['**Label:** The {Moonlit} [Garden]', 'The Moonlit Garden'],
            ['I considered several options.\nTitle: The Clockwork Masquerade\nThis one is concise.', 'The Clockwork Masquerade'],
        ];

        for (const [response, expected] of cases) {
            expect(extractGeneratedChatLabel(response, 'Rowan')).toBe(expected);
        }
    });

    test('preserves title length and generic-label behavior', () => {
        expect(extractGeneratedChatLabel('Conversation')).toBe('');
        expect(extractGeneratedChatLabel('A'.repeat(CHAT_LABEL_TITLE_LIMIT + 20))).toBe('A'.repeat(CHAT_LABEL_TITLE_LIMIT));
    });

    test('rejects non-string input', () => {
        const cases = [
            null,
            undefined,
            42,
            true,
            ['Moonlit Escape'],
            { title: 'Moonlit Escape' },
            new String('Moonlit Escape'),
        ];

        for (const response of cases) {
            expect(extractGeneratedChatLabel(response)).toBe('');
        }
    });

    test('rejects unsupported JSON values and wrappers', () => {
        const cases = [
            '{}',
            '[]',
            '["Moonlit Escape"]',
            '{"content":"Moonlit Escape"}',
            '{"result":{"title":"Moonlit Escape"}}',
            '{"title":{"text":"Moonlit Escape"}}',
            '{"title":["Moonlit Escape"]}',
            '{"title":42}',
            '{"title":"Moonlit Escape","metadata":{"source":"model"}}',
            '[object Object]',
            'Title: [object Object]',
            'Title: ["Moonlit Escape"]',
            'Content: Moonlit Escape',
            'null',
            'true',
            '42',
        ];

        for (const response of cases) {
            expect(extractGeneratedChatLabel(response)).toBe('');
        }
    });

    test('fails closed for malformed machine-shaped output', () => {
        const cases = [
            '{"title":"Moonlit Escape"',
            'Here is the JSON: {"title":"Moonlit Escape"}',
            '```json\n{"title":"Moonlit Escape"\n```',
            '"title": "Moonlit Escape"',
            'Title: ["Moonlit Escape"',
            'Here is the object: {"result":"Moonlit Escape"}',
            '<content>Moonlit Escape</content>',
        ];

        for (const response of cases) {
            expect(extractGeneratedChatLabel(response)).toBe('');
        }
    });

    test('does not use multiline explanations as a label', () => {
        expect(extractGeneratedChatLabel('Moonlit Escape\nA concise title for the conversation.')).toBe('');
        expect(extractGeneratedChatLabel('Title: Moonlit Escape\nLabel: A Different Choice')).toBe('');
    });

    test('normalization strips filename punctuation and rejects arbitrary values', () => {
        expect(normalizeGeneratedChatLabel('Name: A {Map} [Beyond] / Time?')).toBe('A Map Beyond Time');
        expect(normalizeGeneratedChatLabel({ title: 'Moonlit Escape' })).toBe('');
    });
});

const greeting = { name: 'Rowan', is_user: false, mes: 'Hello there.' };
const said = (mes, is_user = true) => ({ name: is_user ? 'User' : 'Rowan', is_user, mes });

describe('automatic chat naming thresholds', () => {
    test('normalises the saved message count, defaulting to six', () => {
        expect(normalizeChatAutoNameThreshold(undefined)).toBe(6);
        expect(normalizeChatAutoNameThreshold('')).toBe(6);
        expect(normalizeChatAutoNameThreshold('abc')).toBe(6);
        expect(normalizeChatAutoNameThreshold(0)).toBe(1);
        expect(normalizeChatAutoNameThreshold('-3')).toBe(1);
        expect(normalizeChatAutoNameThreshold('7.4')).toBe(7);
        expect(normalizeChatAutoNameThreshold(500)).toBe(100);
    });

    test('counts readable messages, the greeting included, but not hidden or empty ones', () => {
        const messages = [
            greeting,
            said('First question.'),
            { ...said('', false), extra: { display_text: '<b>Shown text</b>' } },
            { ...said('Hidden by Mewmory.'), is_system: true },
            said('<img src="x">', false),
            null,
        ];
        expect(getChatAutoNameProgress(messages)).toEqual({ count: 3, hasUserMessage: true });
        expect(isChatReadyForAutoName(messages, 3)).toBe(true);
        expect(isChatReadyForAutoName(messages, 4)).toBe(false);
    });

    test('never names a chat that only holds its greeting, even with a threshold of one', () => {
        expect(isChatReadyForAutoName([greeting], 1)).toBe(false);
        expect(isChatReadyForAutoName([greeting, said('Hi.')], 1)).toBe(true);
    });
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
    const timers = [];
    const state = {
        enabled: true, threshold: 6, idle: true, connection: true, agentPending: false, manual: false,
        fileName: 'Rowan - 2026-10-02@09h08m07s006ms', key: 'rowan-chat', generation: 1,
        messages: [greeting, said('One.'), said('Two.', false), said('Three.'), said('Four.', false)],
    };
    const calls = [];
    const answers = [];
    const agentWaits = [];
    const errors = [];
    const namer = createChatAutoNamer({
        isEnabled: () => state.enabled,
        getThreshold: () => state.threshold,
        getTarget: () => state.key ? { key: state.key, fileName: state.fileName, displayName: 'Rowan', isGroup: false,
            generation: state.generation, messages: state.messages, manual: state.manual } : null,
        isDatedName: name => /\d{4}-\d{2}-\d{2}/.test(name),
        isIdle: () => state.idle,
        hasConnection: () => state.connection,
        isAgentWorkPending: () => state.agentPending,
        waitForAgentWorkIdle: ({ isCancelled }) => {
            const wait = deferred();
            agentWaits.push({ ...wait, isCancelled });
            return wait.promise.then(() => !isCancelled());
        },
        // Mirrors autoLabelChatFile: ask the model, then check the chat is unchanged right before renaming.
        rename: async (target, { signal, canCommit }) => {
            const answer = deferred();
            calls.push({ target, signal, canCommit });
            answers.push(answer);
            await answer.promise;
            if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
            if (!canCommit()) throw new DOMException('changed', 'AbortError');
            state.committingDuringRename = namer.isCommitting();
            namer.cancel(); // The rename's own CHAT_RENAMED / CHAT_CHANGED events arrive while committing.
            state.fileName = 'Rowan - Moonlit Escape';
            return { status: 'renamed' };
        },
        setTimer: (callback) => timers.push(callback) - 1,
        clearTimer: (id) => { timers[id] = null; },
        onError: error => errors.push(error),
        ...overrides,
    });
    const flush = async () => {
        for (let round = 0; round < 10; round++) {
            const pending = timers.splice(0).filter(Boolean);
            for (const callback of pending) callback();
            await new Promise(resolve => setImmediate(resolve));
        }
    };
    const answer = async (index = answers.length - 1) => {
        answers[index].resolve();
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
    };
    return { namer, state, calls, answers, agentWaits, errors, flush, answer };
}

describe('automatic chat naming scheduler', () => {
    test('waits for the threshold, then names the chat once', async () => {
        const harness = createHarness();
        const { namer, state, calls, flush, answer } = harness;
        namer.schedule();
        await flush();
        expect(calls).toHaveLength(0);

        state.messages = [...state.messages, said('Five.')];
        namer.schedule();
        await flush();
        expect(calls).toHaveLength(1);
        await answer();
        expect(state.fileName).toBe('Rowan - Moonlit Escape');
        expect(namer.isFinished('rowan-chat')).toBe(true);

        state.fileName = 'Rowan - 2026-10-02@09h08m07s006ms';
        namer.schedule();
        await flush();
        expect(calls).toHaveLength(1);
    });

    test('a custom message count, a disabled setting, a manual name and a custom title are respected', async () => {
        const harness = createHarness();
        const { namer, state, calls, flush } = harness;
        state.threshold = 10;
        namer.schedule();
        await flush();
        state.threshold = 2;
        state.enabled = false;
        namer.schedule();
        await flush();
        state.enabled = true;
        state.manual = true;
        namer.schedule();
        await flush();
        state.manual = false;
        state.fileName = 'Moonlit Escape';
        namer.schedule();
        await flush();
        expect(calls).toHaveLength(0);

        state.fileName = 'Rowan - 2026-10-02 09-08-07';
        namer.schedule();
        await flush();
        expect(calls).toHaveLength(1);
    });

    test('never asks the model while a reply is being written, and tries again once things are idle', async () => {
        const harness = createHarness();
        const { namer, state, calls, flush, answer } = harness;
        state.messages = [...state.messages, said('The sixth message is mine.')];
        state.idle = false;
        namer.schedule();
        await flush();
        expect(calls).toHaveLength(0);

        state.idle = true;
        await flush();
        expect(calls).toHaveLength(1);
        await answer();
        expect(namer.isFinished('rowan-chat')).toBe(true);
    });

    test('waits for after-reply Agents before naming, and gives up if the chat moves on', async () => {
        const harness = createHarness();
        const { namer, state, calls, agentWaits, flush } = harness;
        state.messages = [...state.messages, said('Five.')];
        state.agentPending = true;
        namer.schedule();
        await flush();
        expect(agentWaits).toHaveLength(1);
        expect(calls).toHaveLength(0);

        namer.cancel();
        state.agentPending = false;
        agentWaits[0].resolve();
        await flush();
        expect(calls).toHaveLength(0);

        state.agentPending = true;
        namer.schedule();
        await flush();
        state.agentPending = false;
        agentWaits[1].resolve();
        await flush();
        expect(calls).toHaveLength(1);
    });

    test('a new message or reply during the request cancels it without using up the attempt', async () => {
        const harness = createHarness();
        const { namer, state, calls, flush, answer } = harness;
        state.messages = [...state.messages, said('Five.')];
        namer.schedule();
        await flush();
        expect(calls).toHaveLength(1);

        namer.cancel();
        expect(calls[0].signal.aborted).toBe(true);
        await answer(0);
        expect(namer.isFinished('rowan-chat')).toBe(false);
        expect(namer.isRunning()).toBe(false);
        expect(state.fileName).toMatch(/2026/);

        namer.schedule();
        await flush();
        expect(calls).toHaveLength(2);
        await answer(1);
        expect(state.fileName).toBe('Rowan - Moonlit Escape');
    });

    test('a chat that changed while the model answered is not renamed until it settles again', async () => {
        const harness = createHarness();
        const { namer, state, flush, answer } = harness;
        state.messages = [...state.messages, said('Five.')];
        namer.schedule();
        await flush();
        state.messages = [...state.messages, said('Six, sent while the title was being written.')];
        await answer(0);
        expect(state.fileName).toMatch(/2026/);
        expect(namer.isFinished('rowan-chat')).toBe(false);

        // The chat switched, or a reply started, between the answer and the rename.
        namer.schedule();
        await flush();
        state.key = 'another-chat';
        await answer(1);
        expect(state.fileName).toMatch(/2026/);
        expect(namer.isFinished('rowan-chat')).toBe(false);
    });

    test('keeps a scheduled retry when the abandoned request finishes after the next quiet moment', async () => {
        const { namer, state, calls, flush, answer } = createHarness();
        state.threshold = 2;
        namer.schedule();
        await flush();
        namer.cancel();
        namer.schedule();
        await flush();
        expect(calls).toHaveLength(1);
        await answer(0);
        await flush();
        expect(calls).toHaveLength(2);
        await answer(1);
        expect(state.fileName).toBe('Rowan - Moonlit Escape');
    });

    test('rechecks the message count setting before committing a title', async () => {
        const { namer, state, flush, answer } = createHarness();
        state.threshold = 2;
        namer.schedule();
        await flush();
        state.threshold = 20;
        await answer();
        expect(state.fileName).toMatch(/2026/);
        expect(namer.isFinished('rowan-chat')).toBe(false);
    });

    test('its own rename events do not cancel it, and it reports when it is committing', async () => {
        const harness = createHarness();
        const { namer, state, calls, flush, answer } = harness;
        state.messages = [...state.messages, said('Five.')];
        namer.schedule();
        await flush();
        expect(namer.isCommitting()).toBe(false);
        await answer(0);
        expect(state.committingDuringRename).toBe(true);
        expect(namer.isFinished('rowan-chat')).toBe(true);
        expect(calls[0].signal.aborted).toBe(false);
        expect(namer.isCommitting()).toBe(false);
    });

    test('a failed or unusable answer is not retried in a loop, but a missing connection is', async () => {
        const failing = createHarness({ rename: async () => { throw new Error('model refused'); } });
        failing.state.messages = [...failing.state.messages, said('Five.')];
        failing.state.connection = false;
        failing.namer.schedule();
        await failing.flush();
        expect(failing.namer.isFinished('rowan-chat')).toBe(false);

        failing.state.connection = true;
        failing.namer.schedule();
        await failing.flush();
        expect(failing.errors.map(error => error.message)).toEqual(['model refused']);
        expect(failing.namer.isFinished('rowan-chat')).toBe(true);
        failing.namer.schedule();
        await failing.flush();
        expect(failing.errors).toHaveLength(1);
    });

    test('schedules collapse into one look and never run twice at once', async () => {
        const harness = createHarness();
        const { namer, state, calls, flush } = harness;
        state.messages = [...state.messages, said('Five.')];
        namer.schedule();
        namer.schedule();
        namer.schedule();
        await flush();
        namer.schedule();
        await flush();
        expect(calls).toHaveLength(1);
        expect(namer.isRunning()).toBe(true);
    });
});
