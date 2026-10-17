/* global globalThis */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { assembleLocaleData } from '../public/scripts/locale-assembly.js';
import { promptMediaError } from '../public/scripts/prompt-media-policy.js';
import { localizeString } from '../public/scripts/ui-localization.js';

const appendConversationMessage = jest.fn();
const addConversationReminder = jest.fn();
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
    getCharacterForAvatar: avatar => ({ avatar, name: avatar === 'char.png' ? 'Aster' : 'Partner' }),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/message-writer.js', () => ({ appendConversationMessage }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/partners.js', () => ({
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
    hasConversationMessageContent: message => Boolean(message?.id && message?.mes),
    updateConversationThreadMessage,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/typing.js', () => ({
    splitChatroomMessages: value => String(value || '').split(/\n\s*\n+/).map(part => part.trim()).filter(Boolean),
    withTypingParticipant: (_participant, task) => task(),
}));

// Behaves like the real t over a test dictionary (exact keys only), and like localizeMessage for a whole message.
const dictionary = new Map();
let localizer = text => dictionary.get(text) ?? text;
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => {
        const key = strings.reduce((text, part, index) => text + part + (index < values.length ? `\${${index}}` : ''), '');
        return (dictionary.get(key) ?? key).replace(/\$\{(\d+)\}/g, (_, index) => values[index]);
    },
    localizeMessage: text => localizer(text),
}));

const {
    editConversationMessage,
    getConversationErrorDetail,
    reportConversationGenerationError,
    requestConversationSelfie,
} = await import('../public/scripts/neconyan-conversation/generation.js');

describe('Conversation core generated reply regressions', () => {
    beforeEach(() => {
        requestConversationBinding.mockReset();
        waitForNativeConversationJob.mockReset();
        appendConversationMessage.mockReset().mockImplementation(async (text, options) => ({ id: `message-${appendConversationMessage.mock.calls.length}`, mes: text, ...options }));
        addConversationReminder.mockClear();
        updateConversationThreadMessage.mockClear();
        runtimeStatusOverrides.clear();
        dictionary.clear();
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

    describe('failure toasts are built whole for the translator', () => {
        const longWording = 'Server-side text rules for AI replies must use plain find-and-replace. Macros (placeholders such as {{user}}) and capture groups only work in the browser, so remove them or use a rule that only changes the prompt.';
        const toastr = { warning: jest.fn(), error: jest.fn() };
        let warn;
        let error;

        beforeEach(() => {
            toastr.warning.mockClear();
            toastr.error.mockClear();
            globalThis.toastr = toastr;
            warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            error = jest.spyOn(console, 'error').mockImplementation(() => {});
        });

        afterEach(() => {
            warn.mockRestore();
            error.mockRestore();
            delete globalThis.toastr;
        });

        test('a refused selfie shows the translated frame around the translated detail', () => {
            dictionary.set('Conversation selfie failed: ${0}', 'Selfie da conversa falhou: ${0}');
            dictionary.set('The selfie speaker is no longer available in this group.', 'O falante do selfie não está mais disponível neste grupo.');

            reportConversationGenerationError('selfie', new Error('The selfie speaker is no longer available in this group.'), { level: 'warning' });

            expect(toastr.warning).toHaveBeenCalledWith('Selfie da conversa falhou: O falante do selfie não está mais disponível neste grupo.', '', { escapeHtml: true });
            expect(warn).toHaveBeenCalledWith('Conversation selfie failed: The selfie speaker is no longer available in this group.', expect.any(Error));
        });

        test('with no dictionary the English toast is the same as before', () => {
            reportConversationGenerationError('selfie', new Error('The selfie speaker is no longer available in this group.'), { level: 'warning' });
            expect(toastr.warning).toHaveBeenLastCalledWith('Conversation selfie failed: The selfie speaker is no longer available in this group.', '', { escapeHtml: true });

            reportConversationGenerationError('selfie', '');
            expect(toastr.error).toHaveBeenLastCalledWith('Conversation selfie failed. Check the browser console for details.', '', { escapeHtml: true });

            reportConversationGenerationError('regenerate', { code: 5 }, { level: 'warning' });
            expect(toastr.warning).toHaveBeenLastCalledWith('Conversation regenerate failed: {"code":5}', '', { escapeHtml: true });

            reportConversationGenerationError('regenerate', null);
            expect(toastr.error).toHaveBeenLastCalledWith('Conversation regenerate failed. Check the browser console for details.', '', { escapeHtml: true });
        });

        test('a translated frame is used when the error has no text', () => {
            dictionary.set('Conversation regenerate failed. Check the browser console for details.', 'A nova resposta da conversa falhou. Veja o console do navegador.');

            reportConversationGenerationError('regenerate', '');

            expect(toastr.error).toHaveBeenCalledWith('A nova resposta da conversa falhou. Veja o console do navegador.', '', { escapeHtml: true });
        });

        test('a detail longer than the limit is found by its whole key and shown whole', () => {
            const translation = 'No servidor, as regras de texto para respostas da IA só podem usar localizar e substituir simples. Macros (marcadores como {{user}}) e grupos de captura só funcionam no navegador, então remova-os ou use uma regra que altere apenas o prompt.';
            dictionary.set('Conversation regenerate failed: ${0}', 'A nova resposta da conversa falhou: ${0}');
            dictionary.set(longWording, translation);

            reportConversationGenerationError('regenerate', new Error(longWording), { level: 'warning' });

            expect(longWording.length).toBeGreaterThan(180);
            expect(translation.length).toBeGreaterThan(180);
            expect(toastr.warning).toHaveBeenCalledWith(`A nova resposta da conversa falhou: ${translation}`, '', { escapeHtml: true });
            expect(warn).toHaveBeenCalledWith(`Conversation regenerate failed: ${longWording.slice(0, 180)}`, expect.any(Error));
        });

        test('a detail the dictionary does not know keeps the 180-character limit', () => {
            reportConversationGenerationError('regenerate', new Error(longWording), { level: 'warning' });

            expect(toastr.warning).toHaveBeenCalledWith(`Conversation regenerate failed: ${longWording.slice(0, 180)}`, '', { escapeHtml: true });
            expect(warn).toHaveBeenCalledWith(`Conversation regenerate failed: ${longWording.slice(0, 180)}`, expect.any(Error));
        });

        test('any other context keeps its English text even when the detail has a dictionary entry', () => {
            dictionary.set('Conversation summary failed: ${0}', 'Resumo da conversa falhou: ${0}');
            dictionary.set('The summary service is busy.', 'O serviço de resumo está ocupado.');

            reportConversationGenerationError('summary', new Error('The summary service is busy.'));

            expect(toastr.error).toHaveBeenCalledWith('Conversation summary failed: The summary service is busy.', '', { escapeHtml: true });
        });
    });

    describe('an image refusal gets the one actionable notice; an error whose text is already localized is shown as given', () => {
        const marks = [];
        const toast = { find: selector => ({ attr: (name, value) => marks.push([selector, name, value]) }) };
        const toastr = { warning: jest.fn(() => toast), error: jest.fn(() => toast) };
        const realFiles = name => JSON.parse(readFileSync(new URL(`../public/locales/${name}.json`, import.meta.url), 'utf8'));
        const portuguese = assembleLocaleData({ base: realFiles('pt-pt'), supplement: realFiles('neconyan/pt-pt'), catalogue: realFiles('neconyan/en') }).dictionary;
        // The old wording of GEN-C01 starts with a pattern verb, so it is the case the dictionary would capture.
        const captured = 'Reload the page, then try again.';
        let dispatched;
        let warn;
        let error;

        beforeEach(() => {
            toastr.warning.mockClear();
            toastr.error.mockClear();
            marks.length = 0;
            globalThis.toastr = toastr;
            dispatched = jest.fn();
            globalThis.dispatchEvent = dispatched;
            warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            error = jest.spyOn(console, 'error').mockImplementation(() => {});
            localizer = text => localizeString(text, portuguese);
        });

        afterEach(() => {
            localizer = text => dictionary.get(text) ?? text;
            warn.mockRestore();
            error.mockRestore();
            delete globalThis.toastr;
            delete globalThis.dispatchEvent;
        });

        const events = () => dispatched.mock.calls.map(([event]) => event).filter(event => event.type === 'neconyan:image-input-refused');

        test('the real Portuguese dictionary does hold the pattern that captures a leading verb', () => {
            expect(portuguese['Reload ${0}']).toBeTruthy();
            expect(localizeString(captured, portuguese)).not.toBe(captured);
        });

        test('an error with the image-issue code or fields raises one event with its message and shows no toast', () => {
            const policy = promptMediaError('invalid-policy', -1, -1, 'This branch\'s saved setting for sending images is damaged. Turn \'Don\'t send this branch\'s images to the model\' off and on again in Review chat images.');
            reportConversationGenerationError('regenerate', policy, { level: 'warning' });
            expect(toastr.warning).not.toHaveBeenCalled();
            expect(toastr.error).not.toHaveBeenCalled();
            expect(events()).toHaveLength(1);
            expect(events()[0].detail).toEqual({ ...policy.imageIssue, message: policy.message });
            // The failure is still logged for the console.
            expect(warn).toHaveBeenCalledWith(`Conversation regenerate failed: ${policy.message.slice(0, 180)}`, policy);
            // A job error carries a code and a message and no imageIssue.
            reportConversationGenerationError('selfie', { message: 'An image description changed while the reply was starting. Try again.', code: 'ROLEPLAY_IMAGE_INPUT' });
            expect(events()).toHaveLength(2);
            expect(events()[1].detail).toEqual({ message: 'An image description changed while the reply was starting. Try again.' });
            expect(toastr.error).not.toHaveBeenCalled();
        });

        test('with toast: false an image refusal raises nothing, as before', () => {
            reportConversationGenerationError('roleplay aside event', promptMediaError('invalid-policy', -1, -1, 'Words.'), { toast: false });
            expect(events()).toHaveLength(0);
            expect(toastr.error).not.toHaveBeenCalled();
        });

        test('any other failure keeps its generic toast and raises no image event', () => {
            // This test is about the toast being kept; the lookup has its own tests.
            localizer = text => text;
            reportConversationGenerationError('regenerate', new Error('The provider is busy.'), { level: 'warning' });
            expect(toastr.warning).toHaveBeenLastCalledWith('Conversation regenerate failed: The provider is busy.', '', { escapeHtml: true });
            reportConversationGenerationError('selfie', Object.assign(new Error('Settings are out of date.'), { status: 409, body: { code: 'roleplay_settings_ack_required' } }), { level: 'warning' });
            expect(toastr.warning).toHaveBeenLastCalledWith('Conversation selfie failed: Settings are out of date.', '', { escapeHtml: true });
            reportConversationGenerationError('summary', new Error('The summary service is busy.'));
            expect(toastr.error).toHaveBeenLastCalledWith('Conversation summary failed: The summary service is busy.', '', { escapeHtml: true });
            reportConversationGenerationError('regenerate', { code: 5, imageIssue: null }, { level: 'warning' });
            expect(toastr.warning).toHaveBeenCalledTimes(3);
            expect(events()).toHaveLength(0);
            // An ordinary toast is not marked.
            expect(marks).toEqual([]);
        });

        test('a localized error is shown exactly as given, whole, and its toast is marked; an ordinary error still goes through the lookup', () => {
            // The same words as an ordinary error are captured by 'Reload ${0}'.
            reportConversationGenerationError('regenerate', new Error(captured), { level: 'warning' });
            const ordinary = toastr.warning.mock.calls.at(-1)[0];
            expect(ordinary).toBe(`Conversation regenerate failed: ${localizeString(captured, portuguese)}`);
            expect(ordinary).not.toContain(captured);
            expect(marks).toEqual([]);
            // Marked as already localized, they are untouched, and the toast is marked in the same task.
            reportConversationGenerationError('regenerate', Object.assign(new Error(captured), { localized: true }), { level: 'warning' });
            expect(toastr.warning).toHaveBeenLastCalledWith(`Conversation regenerate failed: ${captured}`, '', { escapeHtml: true });
            expect(marks).toEqual([['.toast-message', 'data-i18n-ignore', '']]);
            // Every context, both levels, and a text longer than the limit.
            marks.length = 0;
            const long = `${captured} ${'Detalhe longo. '.repeat(20)}`.trim();
            reportConversationGenerationError('selfie', Object.assign(new Error(long), { localized: true }), { level: 'warning' });
            expect(toastr.warning).toHaveBeenLastCalledWith(`Conversation selfie failed: ${long}`, '', { escapeHtml: true });
            reportConversationGenerationError('summary', Object.assign(new Error('Reload it, then try again.'), { localized: true }));
            expect(toastr.error).toHaveBeenLastCalledWith('Conversation summary failed: Reload it, then try again.', '', { escapeHtml: true });
            expect(marks).toHaveLength(2);
            expect(long.length).toBeGreaterThan(180);
            // The text the detail function returns is the message with its whitespace collapsed, and nothing else.
            expect(getConversationErrorDetail(Object.assign(new Error(`  ${captured}\n `), { localized: true }), { localize: true })).toBe(captured);
            expect(getConversationErrorDetail(new Error(captured), { localize: true })).toBe(localizeString(captured, portuguese));
        });
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
