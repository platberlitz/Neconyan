/* global globalThis */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { setConfigFilePath } from '../src/util.js';
import { imageInputFields, promptMediaError } from '../public/scripts/prompt-media-policy.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

// A server-run Conversation request that is refused for an image (code ROLEPLAY_IMAGE_INPUT) keeps its words, code and imageIssue all the way
// to the page, which raises the one notice (D11). The real Conversation router answers, the real page code asks and reports; only the
// functions that would build a prompt and accept a job are stand-ins, and they throw the real error the prompt policy raises.
// Every other failure keeps exactly the reply and the toast it had.
// The composer (attachments.js) is a second page reader of /reply/submit: a send or a forced reply that the server refuses for an image
// raises the same notice, and not its own 'Reply not sent' toast, whether the server refuses it at the preflight that comes first or when it
// accepts the request.
// The Polish control (Rewrite reply with AI, interface.js) and a reply job that fails after the server accepted the send are two more readers: an
// image refusal raises the same one notice and not their own 'Could not rewrite the reply' toast (the reply job is in neconyan-conversation-native-jobs.test.js).

const accept = { submission: jest.fn(), summary: jest.fn(), rewrite: jest.fn(), selfie: jest.fn(), preflight: jest.fn() };
await jest.unstable_mockModule('../src/endpoints/settings.js', () => ({ triggerAutoSave: jest.fn() }));
const jobsModule = await import('../src/generation/conversation-jobs.js');
const maintenanceModule = await import('../src/generation/conversation-maintenance.js');
const rewriteModule = await import('../src/generation/conversation-rewrite.js');
const selfieModule = await import('../src/generation/conversation-selfie.js');
await jest.unstable_mockModule('../src/generation/conversation-jobs.js', () => ({ ...jobsModule,
    acceptConversationSubmission: (...args) => accept.submission(...args), preflightConversationBindings: (...args) => accept.preflight(...args) }));
await jest.unstable_mockModule('../src/generation/conversation-maintenance.js', () => ({ ...maintenanceModule,
    acceptConversationSummary: (...args) => accept.summary(...args) }));
await jest.unstable_mockModule('../src/generation/conversation-rewrite.js', () => ({ ...rewriteModule,
    acceptConversationRewrite: (...args) => accept.rewrite(...args) }));
await jest.unstable_mockModule('../src/generation/conversation-selfie.js', () => ({ ...selfieModule,
    acceptConversationSelfie: (...args) => accept.selfie(...args) }));

// The page side: real generation.js, attachments.js (the composer) and bindings.js, with the app around them stood in.
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'alice' }));
await jest.unstable_mockModule('../public/scripts/prompt-media-client.js', () => ({ promptAttachmentHash: value => `hash:${JSON.stringify(value)}` }));
await jest.unstable_mockModule('../public/lib.js', () => ({ sha256: value => `hash:${value}` }));
await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ avatar: 'char.png', name: 'Aster' }], generateRaw: jest.fn(), getMaxPromptTokens: () => 8192,
    getRequestHeaders: () => ({}), getActiveGenerationAcknowledgement: () => null, saveSettings: jest.fn(async () => true), is_send_press: false,
    online_status: 'no_connection',
}));
const refreshConversationStore = jest.fn(async () => null);
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({
    assertConversationAccount: () => {}, flushConversationStore: async () => true, refreshConversationStore,
}));
// The character that is open, and each character's thread: a test moves the open character while a request is in flight.
let openAvatar = 'char.png';
const threadStores = {
    'char.png': { activeBranchId: 'main', branches: { main: { createdAt: 111, lifetimeSeed: 'seed-a' } } },
    'other.png': { activeBranchId: 'side', branches: { side: { createdAt: 222, lifetimeSeed: 'seed-b' } } },
};
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getConversationGroupById: () => null, getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-a.png' : value || ''),
    getConversationThreadStore: avatar => threadStores[avatar] ?? threadStores['char.png'],
    getCurrentCharAvatar: () => openAvatar, getCurrentCharName: () => 'Aster',
    // What the Polish control's page (interface.js) reads besides.
    getConversationBranches: () => [], getCurrentCharacter: () => ({ avatar: 'char.png', name: 'Aster' }), getIdleActionFromSettings: () => 'disabled',
    parsePositiveInt: value => Number(value) || 0, saveGroupConversationSettings: jest.fn(),
}));
// The messages of the open thread; the Polish control looks its message up here.
let threadMessages = [];
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store.js', () => ({
    getConversationThread: () => threadMessages, updateConversationThreadMessage: jest.fn(), isConversationPreviewValue: () => false,
    getConversationAttachmentSummary: () => '', getConversationFileAttachments: () => [], getConversationMediaAttachments: () => [],
}));
const waitForNativeConversationJob = jest.fn();
const observeNativeConversationJob = jest.fn();
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/native-jobs.js', () => ({
    cancelNativeConversationJob: jest.fn(async () => {}), waitForNativeConversationJob, observeNativeConversationJob,
}));
const scheduleInterfaceRefresh = jest.fn();
const scheduleTimelineRender = jest.fn();
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-scheduler.js', () => ({
    scheduleTimelineRender, scheduleInterfaceRefresh, registerConversationRenderer: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({
    runtimeStatusOverrides: new Map(), conversationState: { imageGenerationActive: false, imageGenerationAbortController: null },
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/timeline-window.js', () => ({
    syncConversationHistoryButtonsForEditState: jest.fn(), moveConversationTimelineWindowToLatest: jest.fn(),
}));
// The rest of what the composer imports; none of it is reached by a refused send.
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({
    getConversationPersonaName: () => 'You', getAvailabilityCopy: () => ({ detail: '', label: 'Online' }), getConnectionProfiles: () => [],
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/prompt.js', () => ({ formatConversationFileSize: () => '' }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({ getSettings: () => ({ enabled: true }), saveSettings: jest.fn() }));
const clearConversationReplyTarget = jest.fn();
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/timeline-render.js', () => ({
    clearConversationReplyTarget, getActiveConversationReplyTarget: () => null,
    renderConversationTimeline: jest.fn(), updateConversationNotificationSettingsVisibility: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/timeline-slash-commands.js', () => ({ handleConversationSlashAction: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/typing.js', () => ({
    splitChatroomMessages: text => [String(text)], getActiveTypingParticipants: () => [], getLastConversationPreview: () => '',
    isLastConversationPreviewValue: () => false, updateLastPreviewFromConversation: jest.fn(),
}));
// The rest of what interface.js (the Polish control) imports; none of it is reached by a refused polish.
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/chrome.js', () => ({ setConversationInterfaceActive: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/presentation.js', () => ({ markConversationBranchRead: jest.fn(), presentPendingConversationClaims: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/media.js', () => ({
    getConversationDisplayLabel: () => ({ text: 'Aster', source: 'participants', isValue: true }), getConversationParticipants: () => [],
    getEffectiveConversationStatus: () => 'online', renderConversationParticipantStack: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/notifications.js', () => ({
    clearUnreadCount: jest.fn(), getBadgeLabel: value => String(value || ''), getUnreadCount: () => 0,
    isConversationActiveThread: () => true, updateConversationNotificationIndicators: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/pals-rail.js', () => ({ getConversationRailItems: () => [] }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/pickers.js', () => ({
    readChimingPartnersFromList: () => '', readWeeklyScheduleFromEditor: () => '[]', updateUserFooter: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/schedule.js', () => ({
    clamp: value => value, getConversationReplyMaxTokens: () => 100, getCurrentActivityFromSchedule: () => null, getStoredSchedule: () => null,
}));
// Behaves like the real t over an empty dictionary, and like localizeMessage for a whole message that no entry knows.
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), ''),
    localizeMessage: text => text, translate: text => text,
}));

const { router } = await import('../src/endpoints/neconyan-conversation.js');
const { requestConversationSelfie, reportConversationGenerationError, submitConversationRewrite } = await import('../public/scripts/neconyan-conversation/generation.js');
const { submitAcceptedReply, submitConversationInput } = await import('../public/scripts/neconyan-conversation/attachments.js');
const { handleCharacterMessagePolish } = await import('../public/scripts/neconyan-conversation/interface.js');
const { conversationState } = await import('../public/scripts/neconyan-conversation/state.js');

const refusal = () => promptMediaError('invalid-policy', -1, -1,
    'This branch\'s saved setting for sending images is damaged. Turn \'Don\'t send this branch\'s images to the model\' off and on again in Review chat images.');
// Where a request for the thread of char.png came from, as the refusal event carries it.
const originA = { workspace: 'conversation', account: 'alice', avatar: 'char.png', groupId: '', personaId: 'persona-a.png', branchId: 'main', lifetimeSeed: 'seed-a', createdAt: '111' };
const ordinary = (status, extra = {}) => Object.assign(new Error('The store is locked by C:\\secret\\path.'), { status, ...extra });

let calls = 0;
/** Sends one request through the real Conversation router, as the app would after its own checks, and returns what it replied. */
function respond(path, body = {}) {
    return new Promise((resolve, reject) => {
        const request = { method: 'POST', url: path, originalUrl: path, baseUrl: '', headers: {}, body, socket: { remoteAddress: '127.0.0.1' },
            // A fresh account each time keeps the send limiter out of the way.
            user: { profile: { handle: `reader-${++calls}` }, directories: { root: 'unused' } }, get: () => undefined };
        const response = { statusCode: 200, headersSent: false, destroyed: false,
            status(code) { this.statusCode = code; return this; },
            send(payload) { this.headersSent = true; resolve({ status: this.statusCode, body: payload }); return this; } };
        router.handle(request, response, error => (error ? reject(error) : resolve({ status: 404, body: null })));
    });
}

describe('a server-run Conversation request refused for an image', () => {
    const replies = [];
    let dispatched;
    let toastr;
    let consoleError;
    let consoleWarn;

    beforeEach(() => {
        openAvatar = 'char.png';
        for (const stand of Object.values(accept)) stand.mockReset();
        accept.preflight.mockResolvedValue({ participants: {}, acknowledgement: null });
        waitForNativeConversationJob.mockReset();
        replies.length = 0;
        // The app's fetch, answered by the real router.
        globalThis.fetch = jest.fn(async (url, options) => {
            const reply = await respond(String(url).replace('/api/neconyan-conversation', ''), JSON.parse(options.body));
            replies.push({ path: String(url).replace('/api/neconyan-conversation', ''), ...reply });
            return { ok: reply.status < 400, status: reply.status, json: async () => reply.body, text: async () => JSON.stringify(reply.body) };
        });
        toastr = { warning: jest.fn(), error: jest.fn(), info: jest.fn() };
        globalThis.toastr = toastr;
        dispatched = jest.fn();
        globalThis.dispatchEvent = dispatched;
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleError.mockRestore();
        consoleWarn.mockRestore();
        delete globalThis.fetch;
        delete globalThis.toastr;
        delete globalThis.dispatchEvent;
    });

    const events = () => dispatched.mock.calls.map(([event]) => event).filter(event => event.type === 'neconyan:image-input-refused');
    const lastReply = path => replies.filter(reply => reply.path === path).at(-1);

    describe('the reply the router gives', () => {
        test('a route without its own handler keeps the refusal\'s words, code and imageIssue', async () => {
            const failure = refusal();
            accept.submission.mockRejectedValueOnce(failure);
            expect(await respond('/reply/submit', {})).toEqual({ status: 409, body: { error: failure.message, code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: failure.imageIssue } });
            accept.summary.mockRejectedValueOnce(failure);
            expect(await respond('/summary/submit', {})).toEqual({ status: 409, body: { error: failure.message, code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: failure.imageIssue } });
            // It is still logged on the server.
            expect(consoleError).toHaveBeenCalledWith('Conversation REST API route failed', failure);
        });

        test('only the four issue fields travel, and a refusal without an issue sends just the code', async () => {
            accept.submission.mockRejectedValueOnce(Object.assign(refusal(), { imageIssue: { reason: 'r', index: 1, mediaIndex: 2, actions: ['review'], secret: '/private/path' } }));
            expect((await respond('/reply/submit', {})).body.imageIssue).toEqual({ reason: 'r', index: 1, mediaIndex: 2, actions: ['review'] });
            accept.submission.mockRejectedValueOnce(Object.assign(new Error('Words.'), { code: 'ROLEPLAY_IMAGE_INPUT', status: 409 }));
            expect(await respond('/reply/submit', {})).toEqual({ status: 409, body: { error: 'Words.', code: 'ROLEPLAY_IMAGE_INPUT' } });
            // A refusal that carries no status is still a conflict, not a server fault.
            accept.submission.mockRejectedValueOnce(Object.assign(new Error('Words.'), { code: 'ROLEPLAY_IMAGE_INPUT' }));
            expect((await respond('/reply/submit', {})).status).toBe(409);
        });

        test('the rewrite and selfie routes add the code and the imageIssue to the reply they already gave', async () => {
            const failure = refusal();
            const expected = { status: 409, body: { message: failure.message, code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: failure.imageIssue } };
            accept.rewrite.mockRejectedValueOnce(failure);
            expect(await respond('/rewrite/submit', {})).toEqual({ ...expected, body: { error: 'rewrite_rejected', ...expected.body } });
            accept.selfie.mockRejectedValueOnce(failure);
            expect(await respond('/selfie/submit', {})).toEqual({ ...expected, body: { error: 'selfie_rejected', ...expected.body } });
        });

        test('the preflight route says what is wrong instead of blaming the saved connection', async () => {
            const failure = refusal();
            accept.preflight.mockRejectedValueOnce(failure);
            expect(await respond('/binding/preflight', {})).toEqual({ status: 409, body: { error: failure.message, code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: failure.imageIssue } });
        });

        test('every other failure gets exactly the reply it got before', async () => {
            accept.submission.mockRejectedValueOnce(ordinary(503));
            expect(await respond('/reply/submit', {})).toEqual({ status: 503, body: { error: 'conversation_request_failed' } });
            accept.submission.mockRejectedValueOnce(ordinary(undefined));
            expect(await respond('/reply/submit', {})).toEqual({ status: 500, body: { error: 'conversation_request_failed' } });
            accept.submission.mockRejectedValueOnce(ordinary(409, { apiError: 'invalid_generation_message' }));
            expect(await respond('/reply/submit', {})).toEqual({ status: 409, body: { error: 'invalid_generation_message' } });
            // A different code, and an image issue without the image code, are not image refusals here.
            accept.submission.mockRejectedValueOnce(ordinary(409, { code: 'ROLEPLAY_INVALID', imageIssue: { reason: 'r', index: 0, mediaIndex: 0, actions: [] } }));
            expect(await respond('/reply/submit', {})).toEqual({ status: 409, body: { error: 'conversation_request_failed' } });
            accept.rewrite.mockRejectedValueOnce(ordinary(409));
            expect(await respond('/rewrite/submit', {})).toEqual({ status: 409, body: { error: 'rewrite_rejected', message: 'The store is locked by C:\\secret\\path.' } });
            accept.selfie.mockRejectedValueOnce(ordinary(400, { apiError: 'selfie_source_missing' }));
            expect(await respond('/selfie/submit', {})).toEqual({ status: 400, body: { error: 'selfie_source_missing', message: 'The store is locked by C:\\secret\\path.' } });
            accept.rewrite.mockRejectedValueOnce(ordinary(500));
            expect(await respond('/rewrite/submit', {})).toEqual({ status: 500, body: { error: 'conversation_request_failed' } });
            accept.preflight.mockRejectedValueOnce(ordinary(409));
            expect((await respond('/binding/preflight', {})).body).toEqual({ error: 'connection_binding_invalid',
                message: 'The saved connection is unavailable or has changed. Check its provider, model, presets and saved key, then try again.' });
            accept.preflight.mockRejectedValueOnce(ordinary(409, { apiError: 'active_settings_ack_required' }));
            expect((await respond('/binding/preflight', {})).body).toEqual({ error: 'active_settings_ack_required', message: 'Save the active connection settings before generating a reply.' });
        });
    });

    describe('what the page shows', () => {
        const bindingContext = { account: 'alice', scope: { target: { avatar: 'char.png', groupId: '', personaId: 'persona-a.png', branchId: 'main' } }, bindingRequest: { acknowledgement: null } };

        test('a selfie refused on the server reaches the notice with its reworded reason and no toast', async () => {
            const failure = refusal();
            accept.selfie.mockRejectedValueOnce(failure);
            await expect(requestConversationSelfie({ avatar: 'char.png', speakerAvatar: 'partner.png', branchId: 'main', personaId: 'persona-a.png' })).resolves.toBe(false);
            expect(lastReply('/selfie/submit')).toMatchObject({ status: 409, body: { code: 'ROLEPLAY_IMAGE_INPUT' } });
            expect(events()).toHaveLength(1);
            expect(events()[0].detail).toEqual({ ...failure.imageIssue, message: failure.message, origin: originA });
            expect(toastr.warning).not.toHaveBeenCalled();
            expect(toastr.error).not.toHaveBeenCalled();
            // The failure is still logged for the console.
            expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('Conversation selfie failed'), expect.any(Error));
        });

        test('a regeneration refused on the server reaches the notice, and so does a polish refused at preflight', async () => {
            const failure = refusal();
            accept.rewrite.mockRejectedValueOnce(failure);
            const regenerate = await submitConversationRewrite('regenerate', 'message-1', { prompt: [], systemPrompt: '', bindingContext }).catch(error => error);
            reportConversationGenerationError('regenerate', regenerate, { level: 'warning', origin: originA });
            accept.preflight.mockRejectedValueOnce(failure);
            const polish = await submitConversationRewrite('polish', 'message-1', { prompt: 'Polish this.' }).catch(error => error);
            reportConversationGenerationError('regenerate', polish, { level: 'warning' });
            expect(lastReply('/binding/preflight')).toMatchObject({ status: 409, body: { code: 'ROLEPLAY_IMAGE_INPUT' } });
            expect(events().map(event => event.detail)).toEqual([{ ...failure.imageIssue, message: failure.message, origin: originA }, { ...failure.imageIssue, message: failure.message }]);
            expect(toastr.warning).not.toHaveBeenCalled();
        });

        test('a request that reaches the router without its own handler reaches the notice too', async () => {
            const failure = refusal();
            accept.summary.mockRejectedValueOnce(failure);
            const { requestConversationBinding } = await import('../public/scripts/neconyan-conversation/bindings.js');
            const error = await requestConversationBinding('summary/submit', {}, 'alice').catch(thrown => thrown);
            expect(error.message).toBe(failure.message);
            reportConversationGenerationError('summary', error);
            expect(events().map(event => event.detail)).toEqual([{ ...failure.imageIssue, message: failure.message }]);
            expect(toastr.error).not.toHaveBeenCalled();
        });

        test('a job that failed with the image code keeps it, its status and its imageIssue when the page reads it back', async () => {
            const failure = refusal();
            const stored = { id: 'job-1', state: 'failed', error: { message: failure.message, code: 'ROLEPLAY_IMAGE_INPUT', status: 409, imageIssue: failure.imageIssue } };
            accept.selfie.mockResolvedValue({ created: true, job: { id: 'job-1' } });
            waitForNativeConversationJob.mockResolvedValueOnce(stored);
            await expect(requestConversationSelfie({ avatar: 'char.png', branchId: 'main', personaId: 'persona-a.png' })).resolves.toBe(false);
            expect(events().map(event => event.detail)).toEqual([{ ...failure.imageIssue, message: failure.message, origin: originA }]);
            // A job error as the runner stores it has no imageIssue; the code and the message are enough for the notice.
            accept.rewrite.mockResolvedValue({ created: true, job: { id: 'job-3' } });
            waitForNativeConversationJob.mockResolvedValueOnce({ id: 'job-2', state: 'failed', error: { message: failure.message, code: 'ROLEPLAY_IMAGE_INPUT', status: 409 } });
            await requestConversationSelfie({ avatar: 'char.png', branchId: 'main', personaId: 'persona-a.png' });
            waitForNativeConversationJob.mockResolvedValueOnce({ id: 'job-3', state: 'failed', error: { message: failure.message, code: 'ROLEPLAY_IMAGE_INPUT', status: 409 } });
            const rewrite = await submitConversationRewrite('regenerate', 'message-1', { prompt: [], systemPrompt: '', bindingContext }).catch(error => error);
            expect(rewrite).toMatchObject({ message: failure.message, code: 'ROLEPLAY_IMAGE_INPUT', status: 409 });
            expect(rewrite.imageIssue).toBeUndefined();
            expect(events().map(event => event.detail).slice(1)).toEqual([{ message: failure.message, origin: originA }]);
            expect(toastr.warning).not.toHaveBeenCalled();
        });

        test('an ordinary server failure still shows conversation_request_failed, and an ordinary failed job its own message, as today', async () => {
            accept.selfie.mockRejectedValueOnce(ordinary(500));
            await expect(requestConversationSelfie({ avatar: 'char.png', branchId: 'main', personaId: 'persona-a.png' })).resolves.toBe(false);
            expect(lastReply('/selfie/submit')).toEqual(expect.objectContaining({ status: 500, body: { error: 'conversation_request_failed' } }));
            expect(toastr.warning).toHaveBeenLastCalledWith('Conversation selfie failed: conversation_request_failed', '', { escapeHtml: true });
            accept.rewrite.mockRejectedValueOnce(ordinary(409));
            const rewrite = await submitConversationRewrite('regenerate', 'message-1', { prompt: [], systemPrompt: '', bindingContext }).catch(error => error);
            reportConversationGenerationError('regenerate', rewrite, { level: 'warning' });
            expect(toastr.warning).toHaveBeenLastCalledWith('Conversation regenerate failed: The store is locked by C:\\secret\\path.', '', { escapeHtml: true });
            accept.selfie.mockResolvedValue({ created: true, job: { id: 'job-4' } });
            waitForNativeConversationJob.mockResolvedValueOnce({ id: 'job-4', state: 'failed', error: { message: 'The provider closed the connection.', code: 'JOB_FAILED', status: 502 } });
            await requestConversationSelfie({ avatar: 'char.png', branchId: 'main', personaId: 'persona-a.png' });
            expect(toastr.warning).toHaveBeenLastCalledWith('Conversation selfie failed: The provider closed the connection.', '', { escapeHtml: true });
            // A failed job whose code is another one, even with an image issue beside it, is not an image refusal.
            accept.rewrite.mockResolvedValue({ created: true, job: { id: 'job-5' } });
            waitForNativeConversationJob.mockResolvedValueOnce({ id: 'job-4', state: 'failed', error: { message: 'Words.', code: 'ROLEPLAY_INVALID', imageIssue: { reason: 'r', index: 0, mediaIndex: 0, actions: [] } } });
            const odd = await submitConversationRewrite('regenerate', 'message-1', { prompt: [], systemPrompt: '', bindingContext }).catch(error => error);
            expect(odd.code).toBeUndefined();
            expect(odd.imageIssue).toBeUndefined();
            expect(events()).toHaveLength(0);
        });
    });

    describe('the composer send and a forced reply', () => {
        class FakeTextArea {
            constructor() { this.value = ''; }
            dispatchEvent() { return true; }
        }
        const savedGlobals = {};
        let input;

        beforeEach(() => {
            for (const name of ['document', 'HTMLTextAreaElement', 'HTMLInputElement']) savedGlobals[name] = globalThis[name];
            input = new FakeTextArea();
            globalThis.HTMLTextAreaElement = FakeTextArea;
            globalThis.HTMLInputElement = class {};
            globalThis.document = { getElementById: id => (id === 'sb_conversation_input' ? input : null) };
            for (const stand of [refreshConversationStore, observeNativeConversationJob, scheduleInterfaceRefresh]) stand.mockClear();
        });

        afterEach(() => {
            for (const [name, value] of Object.entries(savedGlobals)) {
                if (value === undefined) delete globalThis[name];
                else globalThis[name] = value;
            }
        });

        // Each send uses its own words: a failed send is kept to be replayed, and only an identical draft replays it.
        const send = async text => { input.value = text; await submitConversationInput(); };
        const forceReply = () => submitAcceptedReply({ avatar: 'char.png', branchId: 'main', groupId: '', personaId: 'persona-a.png', force: true, triggers: [] });
        const nothingAccepted = () => {
            expect(observeNativeConversationJob).not.toHaveBeenCalled();
            expect(refreshConversationStore).not.toHaveBeenCalled();
            expect(conversationState.conversationUploadActive).toBe(false);
            expect(scheduleInterfaceRefresh).toHaveBeenLastCalledWith({ syncControls: true });
        };

        test('a composer send refused on the server raises the notice with the reworded reason, and shows no Reply not sent toast', async () => {
            const failure = refusal();
            accept.submission.mockRejectedValueOnce(failure);
            await send('Image refusal from the composer');
            expect(lastReply('/reply/submit')).toEqual(expect.objectContaining({ status: 409,
                body: { error: failure.message, code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: failure.imageIssue } }));
            expect(events()).toHaveLength(1);
            expect(events()[0].detail).toEqual({ ...failure.imageIssue, message: failure.message, origin: originA });
            expect(events()[0].detail.message).toContain('Turn \'Don\'t send this branch\'s images to the model\' off and on again in Review chat images.');
            expect(toastr.error).not.toHaveBeenCalled();
            expect(toastr.warning).not.toHaveBeenCalled();
            // Nothing was accepted: the draft stays, no job is watched, and Send is released.
            expect(input.value).toBe('Image refusal from the composer');
            nothingAccepted();
        });

        test('a forced reply refused on the server raises the notice too, and a refusal with no issue still carries its words', async () => {
            const failure = refusal();
            accept.submission.mockRejectedValueOnce(failure);
            await forceReply();
            expect(events().map(event => event.detail)).toEqual([{ ...failure.imageIssue, message: failure.message, origin: originA }]);
            accept.submission.mockRejectedValueOnce(Object.assign(new Error('The saved image detail setting is invalid.'), { code: 'ROLEPLAY_IMAGE_INPUT', status: 409 }));
            await send('Image refusal with only the code');
            expect(lastReply('/reply/submit').body).toEqual({ error: 'The saved image detail setting is invalid.', code: 'ROLEPLAY_IMAGE_INPUT' });
            expect(events().map(event => event.detail).slice(1)).toEqual([{ message: 'The saved image detail setting is invalid.', origin: originA }]);
            expect(toastr.error).not.toHaveBeenCalled();
            nothingAccepted();
        });

        test('a composer send refused at the preflight raises the notice and no toast, keeps the draft and releases Send', async () => {
            const failure = refusal();
            accept.preflight.mockRejectedValueOnce(failure);
            await send('Preflight image refusal from the composer');
            expect(lastReply('/binding/preflight')).toEqual(expect.objectContaining({ status: 409,
                body: { error: failure.message, code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: failure.imageIssue } }));
            // The request never got as far as being submitted.
            expect(replies.filter(reply => reply.path === '/reply/submit')).toHaveLength(0);
            expect(events().map(event => event.detail)).toEqual([{ ...failure.imageIssue, message: failure.message, origin: originA }]);
            expect(toastr.error).not.toHaveBeenCalled();
            expect(toastr.warning).not.toHaveBeenCalled();
            expect(input.value).toBe('Preflight image refusal from the composer');
            nothingAccepted();
        });

        test('a forced reply refused at the preflight raises the notice and no toast, and releases Send', async () => {
            const failure = refusal();
            accept.preflight.mockRejectedValueOnce(failure);
            await forceReply();
            expect(lastReply('/binding/preflight')).toMatchObject({ status: 409, body: { code: 'ROLEPLAY_IMAGE_INPUT' } });
            expect(replies.filter(reply => reply.path === '/reply/submit')).toHaveLength(0);
            expect(events().map(event => event.detail)).toEqual([{ ...failure.imageIssue, message: failure.message, origin: originA }]);
            expect(toastr.error).not.toHaveBeenCalled();
            expect(toastr.warning).not.toHaveBeenCalled();
            nothingAccepted();
        });

        // The notice opens the review for the thread that was refused. The stand-in for the server moves the open character while the request is
        // in flight, so a refusal that read the open thread when it arrived would name the wrong one.
        const moveAway = failure => async () => { openAvatar = 'other.png'; throw failure; };

        test('a send names the thread it was sent from, not the one open when the server refuses it', async () => {
            accept.submission.mockImplementationOnce(moveAway(refusal()));
            await send('Sent from the first thread');
            expect(openAvatar).toBe('other.png');
            expect(events().map(event => event.detail.origin)).toEqual([originA]);
            nothingAccepted();
        });

        test('a forced reply and a refusal at the preflight name the thread they were requested for', async () => {
            accept.submission.mockImplementationOnce(moveAway(refusal()));
            await forceReply();
            openAvatar = 'char.png';
            accept.preflight.mockImplementationOnce(moveAway(refusal()));
            await send('Preflight from the first thread');
            openAvatar = 'char.png';
            accept.preflight.mockImplementationOnce(moveAway(refusal()));
            await submitAcceptedReply({ avatar: 'char.png', branchId: 'main', groupId: '', personaId: 'persona-a.png', force: true, triggers: [{ id: 'm-1' }] });
            expect(events().map(event => event.detail.origin)).toEqual([originA, originA, originA]);
        });

        test('every other failure still shows Reply not sent, with the detail it showed before, and raises no notice', async () => {
            accept.submission.mockRejectedValueOnce(ordinary(503));
            await send('Ordinary server failure');
            expect(toastr.error).toHaveBeenLastCalledWith('conversation_request_failed', 'Reply not sent');
            accept.submission.mockRejectedValueOnce(ordinary(409, { apiError: 'invalid_generation_message' }));
            await send('Ordinary named rejection');
            expect(toastr.error).toHaveBeenLastCalledWith('invalid_generation_message', 'Reply not sent');
            // Another code is not an image refusal, even with an image issue beside it: the server sends neither.
            accept.submission.mockRejectedValueOnce(ordinary(409, { code: 'ROLEPLAY_INVALID', imageIssue: { reason: 'r', index: 0, mediaIndex: 0, actions: [] } }));
            await send('Ordinary other code');
            expect(lastReply('/reply/submit').body).toEqual({ error: 'conversation_request_failed' });
            expect(toastr.error).toHaveBeenLastCalledWith('conversation_request_failed', 'Reply not sent');
            // The connection fails before any reply arrives.
            const answer = globalThis.fetch;
            globalThis.fetch = jest.fn(async (url, options) => {
                if (String(url).endsWith('/reply/submit')) throw new Error('connection reset');
                return answer(url, options);
            });
            await send('Ordinary lost connection');
            expect(toastr.error).toHaveBeenLastCalledWith('connection reset', 'Reply not sent');
            globalThis.fetch = answer;
            // A failure at the preflight keeps the words the page showed for it, for the composer send and the forced reply alike.
            const unavailable = 'The saved connection is unavailable or has changed. Check its provider, model, presets and saved key, then try again.';
            accept.preflight.mockRejectedValueOnce(ordinary(503));
            await send('Ordinary preflight failure');
            expect(lastReply('/binding/preflight')).toEqual(expect.objectContaining({ status: 503, body: { error: 'connection_binding_invalid', message: unavailable } }));
            expect(toastr.error).toHaveBeenLastCalledWith(unavailable, 'Reply not sent');
            // A different code with an image issue beside it is not an image refusal at the preflight either.
            accept.preflight.mockRejectedValueOnce(ordinary(409, { code: 'ROLEPLAY_INVALID', imageIssue: { reason: 'r', index: 0, mediaIndex: 0, actions: [] } }));
            await forceReply();
            expect(toastr.error).toHaveBeenLastCalledWith(unavailable, 'Reply not sent');
            expect(toastr.error).toHaveBeenCalledTimes(6);
            expect(events()).toHaveLength(0);
            nothingAccepted();
        });
    });

    describe('the Polish control (Rewrite reply with AI)', () => {
        const savedGlobals = {};
        const jobFailed = error => ({ id: 'job-polish', state: 'failed', error });
        const polish = () => handleCharacterMessagePolish('message-1');

        beforeEach(() => {
            savedGlobals.HTMLElement = globalThis.HTMLElement;
            globalThis.HTMLElement = class HTMLElement {};
            threadMessages = [{ id: 'message-1', role: 'character', name: 'Aster', mes: 'original', created_at: 1, extra: {} }];
            toastr.success = jest.fn();
            scheduleTimelineRender.mockClear();
        });

        afterEach(() => {
            threadMessages = [];
            if (savedGlobals.HTMLElement === undefined) delete globalThis.HTMLElement;
            else globalThis.HTMLElement = savedGlobals.HTMLElement;
        });

        test('a polish refused on the server raises the notice with the reworded reason, and shows no Could not rewrite toast', async () => {
            const failure = refusal();
            accept.rewrite.mockRejectedValueOnce(failure);
            await polish();
            expect(lastReply('/rewrite/submit')).toMatchObject({ status: 409, body: { error: 'rewrite_rejected', code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: failure.imageIssue } });
            expect(events()).toHaveLength(1);
            expect(events()[0].detail).toEqual({ ...failure.imageIssue, message: failure.message, origin: originA });
            expect(events()[0].detail.message).toContain('Turn \'Don\'t send this branch\'s images to the model\' off and on again in Review chat images.');
            expect(toastr.error).not.toHaveBeenCalled();
            expect(toastr.warning).not.toHaveBeenCalled();
            expect(toastr.success).not.toHaveBeenCalled();
            // Nothing was rewritten, the failure is still logged for the console, and the message is left as it was.
            expect(scheduleTimelineRender).not.toHaveBeenCalled();
            expect(consoleError).toHaveBeenCalledWith('Character prose polishing error:', expect.any(Error));
            expect(threadMessages[0].mes).toBe('original');
        });

        test('a polish refused at the preflight raises the notice too, and the request is never submitted', async () => {
            const failure = refusal();
            accept.preflight.mockRejectedValueOnce(failure);
            await polish();
            expect(lastReply('/binding/preflight')).toMatchObject({ status: 409, body: { code: 'ROLEPLAY_IMAGE_INPUT' } });
            expect(replies.filter(reply => reply.path === '/rewrite/submit')).toHaveLength(0);
            expect(events().map(event => event.detail)).toEqual([{ ...failure.imageIssue, message: failure.message, origin: originA }]);
            expect(toastr.error).not.toHaveBeenCalled();
            expect(toastr.success).not.toHaveBeenCalled();
        });

        test('a polish job that failed with the image code raises the notice with the job\'s message, and shows no toast', async () => {
            const failure = refusal();
            accept.rewrite.mockResolvedValue({ created: true, job: { id: 'job-polish' } });
            // A job error as the runner stores it: message, code and status, with no imageIssue.
            waitForNativeConversationJob.mockResolvedValueOnce(jobFailed({ message: failure.message, code: 'ROLEPLAY_IMAGE_INPUT', status: 409 }));
            await polish();
            expect(events().map(event => event.detail)).toEqual([{ message: failure.message, origin: originA }]);
            expect(toastr.error).not.toHaveBeenCalled();
            expect(toastr.success).not.toHaveBeenCalled();
        });

        test('every other polish failure still shows its Could not rewrite toast, with the detail it showed before, and raises no notice', async () => {
            const locked = 'The store is locked by C:\\secret\\path.';
            // The server refuses the rewrite for another reason: its message is shown.
            accept.rewrite.mockRejectedValueOnce(ordinary(409));
            await polish();
            expect(toastr.error).toHaveBeenLastCalledWith(`Could not rewrite the reply. ${locked}`);
            // The server answers without a message.
            accept.rewrite.mockRejectedValueOnce(ordinary(500));
            await polish();
            expect(toastr.error).toHaveBeenLastCalledWith('Could not rewrite the reply. conversation_request_failed');
            // Another code, even with an image issue beside it, is not an image refusal: the server sends neither.
            accept.rewrite.mockRejectedValueOnce(ordinary(409, { code: 'ROLEPLAY_INVALID', imageIssue: { reason: 'r', index: 0, mediaIndex: 0, actions: [] } }));
            await polish();
            expect(lastReply('/rewrite/submit').body).toEqual({ error: 'rewrite_rejected', message: locked });
            expect(toastr.error).toHaveBeenLastCalledWith(`Could not rewrite the reply. ${locked}`);
            // The preflight fails for another reason.
            accept.preflight.mockRejectedValueOnce(ordinary(503));
            await polish();
            expect(toastr.error).toHaveBeenLastCalledWith('Could not rewrite the reply. The saved connection is unavailable or has changed. Check its provider, model, presets and saved key, then try again.');
            // The connection fails before any reply arrives.
            const answer = globalThis.fetch;
            globalThis.fetch = jest.fn(async (url, options) => {
                if (String(url).endsWith('/rewrite/submit')) throw new Error('connection reset');
                return answer(url, options);
            });
            await polish();
            expect(toastr.error).toHaveBeenLastCalledWith('Could not rewrite the reply. connection reset');
            globalThis.fetch = answer;
            // A failed job keeps its own message, and one whose message already begins with Could not is shown as it is.
            accept.rewrite.mockResolvedValue({ created: true, job: { id: 'job-polish' } });
            waitForNativeConversationJob.mockResolvedValueOnce(jobFailed({ message: 'The provider closed the connection.', code: 'JOB_FAILED', status: 502 }));
            await polish();
            expect(toastr.error).toHaveBeenLastCalledWith('Could not rewrite the reply. The provider closed the connection.');
            waitForNativeConversationJob.mockResolvedValueOnce(jobFailed({ message: 'Could not reach the provider.', code: 'JOB_FAILED', status: 502 }));
            await polish();
            expect(toastr.error).toHaveBeenLastCalledWith('Could not reach the provider.');
            // A failed job whose code is another one, even with an image issue beside it, is not an image refusal.
            waitForNativeConversationJob.mockResolvedValueOnce(jobFailed({ message: 'Words.', code: 'ROLEPLAY_INVALID', imageIssue: { reason: 'r', index: 0, mediaIndex: 0, actions: [] } }));
            await polish();
            expect(toastr.error).toHaveBeenLastCalledWith('Could not rewrite the reply. Words.');
            expect(toastr.error).toHaveBeenCalledTimes(8);
            expect(events()).toHaveLength(0);
            expect(toastr.success).not.toHaveBeenCalled();
        });

        test('a polish that completes still says Reply rewritten, and raises no notice', async () => {
            accept.rewrite.mockResolvedValue({ created: true, job: { id: 'job-polish' } });
            waitForNativeConversationJob.mockResolvedValueOnce({ id: 'job-polish', state: 'completed' });
            await polish();
            expect(toastr.success).toHaveBeenCalledWith('Reply rewritten.');
            expect(scheduleTimelineRender).toHaveBeenCalledTimes(1);
            expect(toastr.error).not.toHaveBeenCalled();
            expect(events()).toHaveLength(0);
        });
    });

    describe('the origin the refusal carries', () => {
        const moveAway = failure => async () => { openAvatar = 'other.png'; throw failure; };
        const originB = { ...originA, avatar: 'other.png', branchId: 'side', lifetimeSeed: 'seed-b', createdAt: '222' };

        test('a selfie that names its own thread keeps it, and one that names none takes the thread open when it started', async () => {
            accept.selfie.mockImplementationOnce(moveAway(refusal()));
            await requestConversationSelfie({ avatar: 'char.png', branchId: 'main', personaId: 'persona-a.png' });
            openAvatar = 'other.png';
            accept.selfie.mockImplementationOnce(async () => { openAvatar = 'char.png'; throw refusal(); });
            await requestConversationSelfie({});
            // Another thread is open, but the selfie names this one.
            openAvatar = 'other.png';
            accept.selfie.mockRejectedValueOnce(refusal());
            await requestConversationSelfie({ avatar: 'char.png', branchId: 'main', personaId: 'persona-a.png' });
            expect(events().map(event => event.detail.origin)).toEqual([originA, originB, originA]);
        });

        test('a polish names the thread whose message it rewrites, not the one open when the server refuses it', async () => {
            const savedElement = globalThis.HTMLElement;
            globalThis.HTMLElement = class HTMLElement {};
            threadMessages = [{ id: 'message-1', role: 'character', name: 'Aster', mes: 'original', created_at: 1, extra: {} }];
            try {
                accept.rewrite.mockImplementationOnce(moveAway(refusal()));
                await handleCharacterMessagePolish('message-1');
                openAvatar = 'char.png';
                // A polish job that fails after the person moved on.
                accept.rewrite.mockResolvedValue({ created: true, job: { id: 'job-polish' } });
                waitForNativeConversationJob.mockImplementationOnce(async () => {
                    openAvatar = 'other.png';
                    return { id: 'job-polish', state: 'failed', error: { message: 'Words.', code: 'ROLEPLAY_IMAGE_INPUT', status: 409 } };
                });
                await handleCharacterMessagePolish('message-1');
            } finally {
                threadMessages = [];
                if (savedElement === undefined) delete globalThis.HTMLElement; else globalThis.HTMLElement = savedElement;
            }
            expect(events().map(event => event.detail.origin)).toEqual([originA, originA]);
        });

        test('the reporter passes the origin it is given, and an event with none carries none', () => {
            const failure = refusal();
            reportConversationGenerationError('regenerate', failure, { level: 'warning', origin: originA });
            reportConversationGenerationError('regenerate', failure, { level: 'warning' });
            expect(events().map(event => event.detail.origin)).toEqual([originA, undefined]);
            expect(events()[1].detail).not.toHaveProperty('origin');
        });

        test('an ordinary failure raises no event, so there is no origin to build', async () => {
            accept.selfie.mockRejectedValueOnce(ordinary(500));
            await requestConversationSelfie({ avatar: 'char.png', branchId: 'main', personaId: 'persona-a.png' });
            expect(events()).toHaveLength(0);
        });
    });
});

describe('what a reply or a stored job error keeps of an image refusal', () => {
    test('the image code and the four issue fields, and nothing for any other error', () => {
        const failure = refusal();
        expect(imageInputFields(failure)).toEqual({ code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: failure.imageIssue });
        expect(imageInputFields(Object.assign(new Error('x'), { code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: { reason: 'r', index: 1, mediaIndex: 2, actions: [], path: '/p' } })))
            .toEqual({ code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: { reason: 'r', index: 1, mediaIndex: 2, actions: [] } });
        expect(imageInputFields(Object.assign(new Error('x'), { code: 'ROLEPLAY_IMAGE_INPUT' }))).toEqual({ code: 'ROLEPLAY_IMAGE_INPUT' });
        for (const other of [null, undefined, 'text', 7, new Error('x'), { code: 'ROLEPLAY_INVALID', imageIssue: { reason: 'r' } }, { imageIssue: { reason: 'r' } }, { code: 'roleplay_image_input' }]) {
            expect(imageInputFields(other)).toEqual({});
        }
    });

    test('the rewrite and selfie jobs write it into the error of a request that could not be prepared', () => {
        for (const file of ['src/generation/conversation-rewrite.js', 'src/generation/conversation-selfie.js']) {
            const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
            expect(source).toContain('import { imageInputFields } from \'../../public/scripts/prompt-media-policy.js\';');
            expect(source.match(/\.\.\.imageInputFields\(error\) \},\n\s+recoverability: 'needs-retry'/g)).toHaveLength(1);
        }
    });
});
