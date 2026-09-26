/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const appendConversationMessage = jest.fn();
const addConversationReminder = jest.fn();
const generateConversationImage = jest.fn();
const updateConversationThreadMessage = jest.fn();
const runtimeStatusOverrides = new Map();
const threadMessages = [{ id: 'user-1', role: 'user', name: 'User', mes: 'hello', extra: {} }];
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'alice' }));
const requestConversationBinding = jest.fn();
const waitForNativeConversationJob = jest.fn();
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/bindings.js', () => ({
    preflightConversationBinding: jest.fn(async () => ({ participants: {}, acknowledgement: null })), requestConversationBinding,
}));
await jest.unstable_mockModule('../public/lib.js', () => ({ sha256: value => `hash:${value}` }));

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ avatar: 'char.png', name: 'Aster' }],
    generateRaw: jest.fn(),
    getMaxPromptTokens: () => 8192,
}));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/llm-utils.js', () => ({
    extractProfileResponseText: value => String(value || ''),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-a.png' : value || ''),
    getConversationThreadStore: () => ({ activeBranchId: 'main', branches: { main: { createdAt: 111 } } }),
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/media.js', () => ({
    buildCharacterImagePrompt: value => value,
    generateConversationImage,
    getCharacterForAvatar: avatar => ({ avatar, name: avatar === 'char.png' ? 'Aster' : 'Partner' }),
    getCharacterImageDetails: () => '',
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/message-writer.js', () => ({ appendConversationMessage }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/partners.js', () => ({
    stripSpeakerPrefix: value => String(value || '').trim(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({ getConnectionProfiles: () => [] }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/prompt.js', () => ({
    buildConversationPromptMessages: jest.fn(),
    buildConversationSystemPrompt: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/shared-helpers.js', () => ({
    formatPromptText: value => String(value || ''),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/schedule.js', () => ({
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    getConversationReplyMaxTokens: () => 100,
    getConversationRuntimeStatusKey: (avatar, personaId) => `${personaId}\u001f${avatar}`,
    parseDurationToMs: () => 60_000,
}));
const conversationState = { imageGenerationActive: false, imageGenerationAbortController: null };
const cancelNativeConversationJob = jest.fn(async () => {});
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ runtimeStatusOverrides, conversationState }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/native-jobs.js', () => ({ cancelNativeConversationJob, waitForNativeConversationJob }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-scheduler.js', () => ({ scheduleTimelineRender: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store.js', () => ({
    addConversationReminder,
    buildConversationMessageReplyReference: message => message ? { messageId: message.id, name: message.name, role: message.role, text: message.mes } : null,
    getConversationThread: () => threadMessages,
    getImageCooldownRemainingSeconds: () => 0,
    hasConversationMessageContent: message => Boolean(message?.id && message?.mes),
    markImageGenerated: jest.fn(),
    updateConversationThreadMessage,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/typing.js', () => ({
    splitChatroomMessages: value => String(value || '').split(/\n\s*\n+/).map(part => part.trim()).filter(Boolean),
    waitForReplyDelay: jest.fn(),
    withTypingParticipant: (_participant, task) => task(),
}));

const {
    editConversationMessage,
    requestConversationSelfie,
} = await import('../public/scripts/neconyan-conversation/generation.js');

describe('Conversation core generated reply regressions', () => {
    beforeEach(() => {
        requestConversationBinding.mockReset();
        waitForNativeConversationJob.mockReset();
        appendConversationMessage.mockReset().mockImplementation(async (text, options) => ({ id: `message-${appendConversationMessage.mock.calls.length}`, mes: text, ...options }));
        addConversationReminder.mockClear();
        generateConversationImage.mockClear();
        updateConversationThreadMessage.mockClear();
        runtimeStatusOverrides.clear();
        delete globalThis.document;
        delete globalThis.confirm;
    });

    test('a manual selfie is submitted to the server with its source message and never written in the page', async () => {
        requestConversationBinding.mockResolvedValueOnce({ job: { id: 'selfie-job' } });
        waitForNativeConversationJob.mockResolvedValueOnce({ id: 'selfie-job', state: 'completed' });
        await expect(requestConversationSelfie({ avatar: 'char.png', speakerAvatar: 'partner.png', branchId: 'main', groupId: '',
            personaId: 'persona-a.png', context: ' at my desk ', sourceMessageId: 'message-9' })).resolves.toBe(true);

        const [path, payload, account] = requestConversationBinding.mock.calls[0];
        expect(path).toBe('selfie/submit');
        expect(account).toBe('alice');
        expect(payload).toMatchObject({ context: 'at my desk', sourceMessageId: 'message-9', speakerAvatar: 'partner.png',
            target: { avatar: 'char.png', personaId: 'persona-a.png', branchId: 'main' }, branchCreatedAt: '111' });
        expect(payload.submissionKey).toEqual(expect.any(String));
        expect(appendConversationMessage).not.toHaveBeenCalled();
        expect(conversationState.imageGenerationActive).toBe(false);
    });

    test('the pending image bubble stops the server job and a cancelled selfie is not reported as a failure', async () => {
        const toastr = { info: jest.fn(), warning: jest.fn() };
        globalThis.toastr = toastr;
        let finish;
        requestConversationBinding.mockResolvedValueOnce({ job: { id: 'stop-job' } });
        waitForNativeConversationJob.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const run = requestConversationSelfie({ avatar: 'char.png' });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(conversationState.imageGenerationActive).toBe(true);
        conversationState.imageGenerationAbortController.abort();
        expect(cancelNativeConversationJob).toHaveBeenCalledWith('stop-job');
        finish({ id: 'stop-job', state: 'cancelled' });
        await expect(run).resolves.toBe(true);
        expect(conversationState.imageGenerationActive).toBe(false);
        expect(toastr.warning).not.toHaveBeenCalled();
        delete globalThis.toastr;
    });

    test('a refused selfie is reported and a stopped watch says the server is still working', async () => {
        const toastr = { info: jest.fn(), warning: jest.fn() };
        globalThis.toastr = toastr;
        requestConversationBinding.mockResolvedValueOnce({ job: { id: 'failed-job' } });
        waitForNativeConversationJob.mockResolvedValueOnce({ id: 'failed-job', state: 'failed', error: { message: 'The selfie speaker is no longer available in this group.' } });
        await expect(requestConversationSelfie({ avatar: 'char.png' })).resolves.toBe(false);
        expect(toastr.warning.mock.calls[0][0]).toContain('no longer available');

        requestConversationBinding.mockResolvedValueOnce({ job: { id: 'watched-job' } });
        waitForNativeConversationJob.mockResolvedValueOnce(null);
        await expect(requestConversationSelfie({ avatar: 'char.png' })).resolves.toBe(true);
        expect(toastr.info.mock.calls[0][0]).toContain('still being made on the server');
        delete globalThis.toastr;
    });

    test('saves only changed content and closes the editor in all cases', () => {
        const originalTextElement = {};
        const textElement = {
            append: jest.fn(),
            cloneNode: jest.fn(() => originalTextElement),
            isConnected: true,
            querySelector: jest.fn(() => null),
            replaceWith: jest.fn(),
            textContent: 'hello',
        };
        const actionBar = { classList: { remove: jest.fn() } };
        const messageElement = {
            classList: { add: jest.fn(), remove: jest.fn() },
            dataset: {
                messageId: '42',
                sbConversationMessageFingerprint: 'fingerprint',
            },
            querySelector: jest.fn(selector => selector === '.sb-conversation-message-actions' ? actionBar : textElement),
        };
        const createdElements = [];
        globalThis.document = {
            createElement: jest.fn(() => {
                const element = {
                    append: jest.fn(),
                    children: [],
                    classList: { add: jest.fn(), remove: jest.fn() },
                    closest: jest.fn(() => null),
                    dataset: {},
                    focus: jest.fn(),
                    setAttribute: jest.fn(),
                    value: '',
                };
                element.append.mockImplementation((...children) => element.children.push(...children));
                createdElements.push(element);
                return element;
            }),
            querySelectorAll: jest.fn(() => [messageElement]),
        };
        threadMessages.splice(0, threadMessages.length, { id: 42, role: 'user', name: 'User', mes: 'hello', extra: {} });

        editConversationMessage('42');

        const [textarea, buttonContainer] = createdElements;
        const [saveButton, cancelButton] = buttonContainer.children;
        cancelButton.onclick();
        expect(textElement.replaceWith).toHaveBeenCalledWith(originalTextElement);
        expect(messageElement.classList.remove).toHaveBeenCalledWith('is-editing');

        saveButton.onclick();
        expect(updateConversationThreadMessage).not.toHaveBeenCalled();

        textarea.value = 'updated';
        saveButton.onclick();
        expect(updateConversationThreadMessage).toHaveBeenCalledWith('char.png', 42, 'updated', null, {
            groupId: '',
            personaId: 'persona-a.png',
        });
    });

    test('cancels an existing editor before opening another', () => {
        const restoredText = {};
        const originalText = {
            append: jest.fn(),
            cloneNode: jest.fn(() => restoredText),
            isConnected: true,
            querySelector: jest.fn(() => null),
            replaceWith: jest.fn(),
            textContent: 'first',
        };
        const originalActions = { classList: { remove: jest.fn() } };
        const previousMessageElement = {
            classList: { add: jest.fn(), remove: jest.fn() },
            dataset: { messageId: '42', sbConversationMessageFingerprint: 'previous-fingerprint' },
            querySelector: jest.fn(selector => selector === '.sb-conversation-message-actions' ? originalActions : originalText),
        };
        const nextText = {
            append: jest.fn(),
            cloneNode: jest.fn(() => ({})),
            querySelector: jest.fn(() => null),
            textContent: 'hello',
        };
        const nextActions = { classList: { remove: jest.fn() } };
        const nextMessageElement = {
            classList: { add: jest.fn(), remove: jest.fn() },
            dataset: { messageId: '43' },
            querySelector: jest.fn(selector => selector === '.sb-conversation-message-actions' ? nextActions : nextText),
        };
        globalThis.document = {
            createElement: jest.fn(() => ({
                append: jest.fn(),
                classList: { add: jest.fn(), remove: jest.fn() },
                dataset: {},
                focus: jest.fn(),
                setAttribute: jest.fn(),
                value: '',
            })),
            querySelectorAll: jest.fn(() => [previousMessageElement]),
        };
        threadMessages.splice(0, threadMessages.length,
            { id: 42, role: 'user', name: 'User', mes: 'first', extra: {} },
            { id: 43, role: 'user', name: 'User', mes: 'hello', extra: {} },
        );

        editConversationMessage('42');
        globalThis.document.querySelectorAll.mockReturnValue([nextMessageElement]);
        editConversationMessage('43');

        expect(previousMessageElement.classList.remove).toHaveBeenCalledWith('is-editing');
        expect(originalText.replaceWith).toHaveBeenCalledWith(restoredText);
        expect(originalActions.classList.remove).toHaveBeenCalledWith('open');
    });

    test('does not persist a blanked message so deletion stays explicit', () => {
        const textElement = {
            append: jest.fn(),
            cloneNode: jest.fn(() => ({})),
            isConnected: true,
            querySelector: jest.fn(() => null),
            replaceWith: jest.fn(),
            textContent: 'hello',
        };
        const actionBar = { classList: { remove: jest.fn() } };
        const messageElement = {
            classList: { add: jest.fn(), remove: jest.fn() },
            dataset: { messageId: '42' },
            querySelector: jest.fn(selector => selector === '.sb-conversation-message-actions' ? actionBar : textElement),
        };
        const createdElements = [];
        globalThis.document = {
            createElement: jest.fn(() => {
                const element = {
                    append: jest.fn(),
                    children: [],
                    classList: { add: jest.fn(), remove: jest.fn() },
                    dataset: {},
                    focus: jest.fn(),
                    setAttribute: jest.fn(),
                    value: '',
                };
                element.append.mockImplementation((...children) => element.children.push(...children));
                createdElements.push(element);
                return element;
            }),
            querySelectorAll: jest.fn(() => [messageElement]),
        };
        threadMessages.splice(0, threadMessages.length, { id: 42, role: 'user', name: 'User', mes: 'hello', extra: {} });

        editConversationMessage('42');

        const [textarea, buttonContainer] = createdElements;
        const [saveButton] = buttonContainer.children;
        textarea.value = '   ';
        saveButton.onclick();

        expect(updateConversationThreadMessage).not.toHaveBeenCalled();
        expect(messageElement.classList.remove).toHaveBeenCalledWith('is-editing');
    });

    test('keeps the open editor when discarding unsaved changes is declined', () => {
        const originalText = {
            append: jest.fn(),
            cloneNode: jest.fn(() => ({})),
            isConnected: true,
            querySelector: jest.fn(() => null),
            replaceWith: jest.fn(),
            textContent: 'first',
        };
        const previousMessageElement = {
            classList: { add: jest.fn(), remove: jest.fn() },
            dataset: { messageId: '42' },
            querySelector: jest.fn(selector => selector === '.sb-conversation-message-actions'
                ? { classList: { remove: jest.fn() } }
                : originalText),
        };
        const nextText = {
            append: jest.fn(),
            cloneNode: jest.fn(() => ({})),
            querySelector: jest.fn(() => null),
            textContent: 'hello',
        };
        const nextMessageElement = {
            classList: { add: jest.fn() },
            dataset: { messageId: '43' },
            querySelector: jest.fn(selector => selector === '.sb-conversation-message-actions'
                ? { classList: { remove: jest.fn() } }
                : nextText),
        };
        const createdElements = [];
        globalThis.document = {
            createElement: jest.fn(() => {
                const element = {
                    append: jest.fn(),
                    classList: { add: jest.fn(), remove: jest.fn() },
                    dataset: {},
                    focus: jest.fn(),
                    setAttribute: jest.fn(),
                    value: '',
                };
                createdElements.push(element);
                return element;
            }),
            querySelectorAll: jest.fn(() => [previousMessageElement]),
        };
        globalThis.confirm = jest.fn(() => false);
        threadMessages.splice(0, threadMessages.length,
            { id: 42, role: 'user', name: 'User', mes: 'first', extra: {} },
            { id: 43, role: 'user', name: 'User', mes: 'hello', extra: {} },
        );

        editConversationMessage('42');
        const [textarea] = createdElements;
        textarea.value = 'edited but unsaved';
        globalThis.document.querySelectorAll.mockReturnValue([nextMessageElement]);
        editConversationMessage('43');

        expect(globalThis.confirm).toHaveBeenCalled();
        expect(originalText.replaceWith).not.toHaveBeenCalled();
        expect(nextMessageElement.classList.add).not.toHaveBeenCalled();
    });
});
