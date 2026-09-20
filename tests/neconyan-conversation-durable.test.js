/* global globalThis */
import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

// Swapping properties on globalThis leaks into other Jest files in this
// project, so remember the originals and put them back when this suite ends.
const nativeGlobals = {
    fetch: globalThis.fetch,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    document: globalThis.document,
    toastr: globalThis.toastr,
};

afterAll(() => {
    for (const [key, value] of Object.entries(nativeGlobals)) {
        if (value === undefined) {
            delete globalThis[key];
        } else {
            globalThis[key] = value;
        }
    }
});


const sequence = [];
const observeNativeConversationJob = jest.fn();
const refreshConversationStore = jest.fn(async () => null);
let flushResult = true;
const flushConversationStore = jest.fn(async () => { sequence.push('flush'); return flushResult; });
const scheduleInterfaceRefresh = jest.fn();
const clearConversationReplyTarget = jest.fn();
let activeReplyTarget = null;
let branchMessages = [];
let branchCreatedAt = 111;
let submitResponse = { ok: true, body: { job: { id: 'job-1' }, inputDurable: true } };
let fetchCalls = [];
let account = 'alice';

const INPUT_ID = 'sb_conversation_input';

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (body === null ? '' : JSON.stringify(body)),
    };
}

class FakeTextArea {
    constructor() { this.value = ''; this.disabled = false; }
    dispatchEvent() { return true; }
    focus() {}
}

function makeGlobals() {
    const input = new FakeTextArea();
    globalThis.HTMLTextAreaElement = FakeTextArea;
    globalThis.HTMLInputElement = class {};
    globalThis.HTMLElement = class {};
    globalThis.Event = class { constructor(type) { this.type = type; } };
    globalThis.document = {
        getElementById: id => (id === INPUT_ID ? input : null),
    };
    globalThis.toastr = { warning: jest.fn(), error: jest.fn(), info: jest.fn() };
    globalThis.fetch = jest.fn(async (url, options = {}) => {
        fetchCalls.push({ url, options });
        sequence.push('fetch');
        return jsonResponse(submitResponse.body, submitResponse.ok ? 200 : submitResponse.status || 500);
    });
    return input;
}

async function loadAttachments() {
    await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
    await jest.unstable_mockModule('../public/script.js', () => ({
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf' }),
        is_send_press: false,
    }));
    await jest.unstable_mockModule('../public/scripts/constants.js', () => ({ MEDIA_DISPLAY: { LIST: 'list' } }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/constants.js', () => ({
        CHROME_IDS: { input: INPUT_ID, send: 'sb_conversation_send', fileInput: 'sb_conversation_file_input', attachmentPreview: 'sb_conversation_attachment_preview' },
        CONVERSATION_ATTACHMENT_ALLOWED_EXTENSIONS: ['.txt'],
        CONVERSATION_ATTACHMENT_MAX_BYTES: 1024,
        CONVERSATION_ATTACHMENT_MAX_FILES: 3,
        SAFE_TOAST_OPTIONS: {},
    }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
        getConversationGroupIdForAvatar: () => '',
        getConversationPersonaId: () => 'persona-a.png',
        getConversationThreadStore: () => ({ activeBranchId: 'b1', branches: { b1: { id: 'b1', createdAt: branchCreatedAt, messages: branchMessages } } }),
        getCurrentCharAvatar: () => 'char.png',
    }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/native-jobs.js', () => ({ observeNativeConversationJob }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({ getConversationPersonaName: () => 'You' }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/prompt.js', () => ({ formatConversationFileSize: () => '' }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-scheduler.js', () => ({ scheduleInterfaceRefresh }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-utils.js', () => ({ escapeHtmlText: value => String(value) }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({ getSettings: () => ({ enabled: true }), saveSettings: jest.fn() }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/shared-helpers.js', () => ({ formatPromptText: value => String(value || '') }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState: { conversationUploadActive: false, conversationReplyTarget: null } }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({ assertConversationAccount: () => {}, flushConversationStore, refreshConversationStore }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store.js', () => ({
        getConversationAttachmentSummary: () => '',
        getConversationFileAttachments: () => [],
        getConversationMediaAttachments: () => [],
        getConversationThread: () => branchMessages,
    }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/timeline-render.js', () => ({
        clearConversationReplyTarget,
        getActiveConversationReplyTarget: () => activeReplyTarget,
    }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/timeline-slash-commands.js', () => ({ handleConversationSlashAction: jest.fn() }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/typing.js', () => ({ splitChatroomMessages: text => String(text).split(/\n\s*\n/).map(part => part.trim()).filter(Boolean) }));
    return import('../public/scripts/neconyan-conversation/attachments.js');
}

function sentPayloads() {
    return fetchCalls.map(call => JSON.parse(call.options.body));
}

describe('durable Conversation composer', () => {
    let input;

    beforeEach(() => {
        jest.resetModules();
        sequence.length = 0;
        fetchCalls = [];
        account = 'alice';
        observeNativeConversationJob.mockClear();
        refreshConversationStore.mockClear();
        scheduleInterfaceRefresh.mockClear();
        clearConversationReplyTarget.mockClear();
        flushResult = true;
        activeReplyTarget = null;
        branchMessages = [{ id: 'u0', role: 'user', mes: 'earlier' }];
        branchCreatedAt = 111;
        submitResponse = { ok: true, body: { job: { id: 'job-1' }, inputDurable: true } };
        input = makeGlobals();
    });

    test('a composer send is flushed to the server before acceptance and never appends locally', async () => {
        const { submitConversationInput } = await loadAttachments();
        input.value = 'Hello there';
        await submitConversationInput();

        const payloads = sentPayloads();
        expect(payloads).toHaveLength(1);
        expect(payloads[0].mode).toBe('send');
        expect(payloads[0].messages).toEqual([{ mes: 'Hello there', extra: { conversation_mode_user: true } }]);
        expect(payloads[0].branchCreatedAt).toBe('111');
        expect(typeof payloads[0].submissionKey).toBe('string');
        // The store reaches the server before the submission does.
        expect(sequence.indexOf('flush')).toBeLessThan(sequence.indexOf('fetch'));
        // The submitted draft is cleared, the job is observed, and the timeline refreshes.
        expect(input.value).toBe('');
        expect(observeNativeConversationJob).toHaveBeenCalledWith('job-1', 'alice');
        expect(fetchCalls[0].options.headers['X-Neconyan-Account']).toBe('alice');
        expect(refreshConversationStore).toHaveBeenCalled();
    });

    test('a rejected flush keeps the draft and sends nothing', async () => {
        flushResult = false;
        const { submitConversationInput } = await loadAttachments();
        input.value = 'Do not lose me';
        await submitConversationInput();

        expect(fetchCalls).toHaveLength(0);
        expect(input.value).toBe('Do not lose me');
        expect(observeNativeConversationJob).not.toHaveBeenCalled();
    });

    test('a changed account during the flush keeps the draft without submitting or observing', async () => {
        const { submitConversationInput } = await loadAttachments();
        flushConversationStore.mockImplementationOnce(async captured => {
            expect(captured).toBe('alice');
            account = 'bob';
            return true;
        });
        input.value = 'Private draft';
        await submitConversationInput();
        expect(input.value).toBe('Private draft');
        expect(fetchCalls).toHaveLength(0);
        expect(observeNativeConversationJob).not.toHaveBeenCalled();
    });

    test('a lost acceptance response reuses the key so a retry cannot duplicate the send', async () => {
        const { submitConversationInput } = await loadAttachments();
        submitResponse = { ok: false, status: 500, body: { error: 'network' } };
        globalThis.fetch = jest.fn(async (url, options = {}) => {
            fetchCalls.push({ url, options });
            sequence.push('fetch');
            if (fetchCalls.length === 1) throw new Error('connection reset');
            return jsonResponse({ job: { id: 'job-9' }, inputDurable: true });
        });
        input.value = 'Try again';
        await submitConversationInput();
        expect(input.value).toBe('Try again');
        input.value = 'Try again';
        await submitConversationInput();

        const payloads = sentPayloads();
        expect(payloads).toHaveLength(2);
        expect(payloads[0].submissionKey).toBe(payloads[1].submissionKey);
        expect(input.value).toBe('');
    });

    test('a forced reply posts a reply submission with the last user message anchor', async () => {
        const { submitConversationInput } = await loadAttachments();
        input.value = '';
        await submitConversationInput();

        const payloads = sentPayloads();
        expect(payloads).toHaveLength(1);
        expect(payloads[0].mode).toBe('reply');
        expect(payloads[0].force).toBe(true);
        expect(payloads[0].triggers.map(trigger => trigger.messageId)).toEqual(['u0']);
    });
});
