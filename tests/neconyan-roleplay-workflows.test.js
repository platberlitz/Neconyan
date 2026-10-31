/* global globalThis */
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { event_types, eventSource } from '../public/scripts/events.js';
import { MacroRegistry } from '../public/scripts/macros/engine/MacroRegistry.js';
import { getBrowserStoreKey } from '../public/scripts/extensions/third-party/MacroEnhanced/src/custom/browser-store.js';

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));

const callGenericPopup = jest.fn(async () => null);
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    callGenericPopup, POPUP_TYPE: { CONFIRM: 2 },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 1001 },
}));


let account = 'alice';
const chat = [];
let currentChatId = 'roleplay';
let currentAvatar = 'nova.png';
let nativeEligible = true;
let accountStamp = { accountId: 'a-1', dataEpoch: 1 };
let settingsRevision = 4;
let submitHandler = null;
let receiptHandler = null;
let chatSaveHandler = null;
let reloadHandler = null;
const requests = [];
const observers = new Map();
const previews = new Map();
const saved = [];
const reloads = [];
const readingAnchors = [];
const activations = [];
const jobControls = jest.fn();
const addOneMessage = jest.fn();
const updateMessageBlock = jest.fn(async () => {});
let settingsPending = false;
let generating = false;
let chatSaving = false;
const saveSettings = jest.fn(async () => {
    settingsPending = false;
    settingsRevision += 1;
    return true;
});
const listJobs = jest.fn(async () => []);
const cancelJob = jest.fn(async () => ({}));
const serviceVectorBrowserWork = jest.fn(async () => {});
const extensionPrompts = {};
const chatMetadata = {};
const extensionSettings = {};
const interceptors = [];
const restoreDisplay = jest.fn();
const beginRoleplayReplacement = jest.fn(() => restoreDisplay);
jest.unstable_mockModule('../public/scripts/neconyan-conversation/roleplay-replacement.js', () => ({ beginRoleplayReplacement }));

const globalEvents = new EventTarget();
globalThis.addEventListener = globalEvents.addEventListener.bind(globalEvents);
globalThis.removeEventListener = globalEvents.removeEventListener.bind(globalEvents);
globalThis.dispatchEvent = jest.fn(event => globalEvents.dispatchEvent(event));
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
jest.unstable_mockModule('../public/scripts/events.js', () => ({ event_types, eventSource }));

const extensionNames = [];
const extensionStates = new Map();
const extensionManifests = new Map();
jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    activeGenerationInterceptors: () => interceptors,
    extension_settings: extensionSettings,
    extensionNames,
    findExtension: name => extensionStates.get(name) ?? null,
    getExtensionManifest: name => extensionManifests.get(name) ?? null,
}));

// The loaded extension's own resolver; the capture must call exactly this.
let dialogueColorsInstruction = 'Colour the dialogue in teal.';
const dialogueColorsResolver = jest.fn(() => dialogueColorsInstruction);
jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/main.js',
    () => ({ resolveDialogueColorsMacro: dialogueColorsResolver }));

jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
jest.unstable_mockModule('../public/scripts/extensions/vectors/native.js', () => ({ serviceVectorBrowserWork }));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
jest.unstable_mockModule('../public/scripts/chats.js', () => ({ hasPendingFileAttachment: () => false }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/roleplay-preview.js', () => ({
    observeRoleplayPreview: (id, options) => {
        const stop = jest.fn();
        previews.set(id, { ...options, stop });
        return stop;
    },
}));
jest.unstable_mockModule('../public/scripts/jobs.js', () => ({
    cancelJob,
    listJobs,
    observeJob: (id, options) => {
        observers.set(id, options);
        let stopped = false;
        return (reason = 'stopped') => {
            if (stopped) return;
            stopped = true;
            return options.onStop(reason);
        };
    },
    TERMINAL: new Set(['completed', 'cancelled', 'failed', 'interrupted', 'conflict']),
}));
jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({
    roleplayAccountStamp: () => {
        if (!accountStamp) throw new Error('ROLEPLAY_ACCOUNT_CHANGED');
        return { account: accountStamp };
    },
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({ getCurrentCharAvatar: () => currentAvatar }));
jest.unstable_mockModule('../public/script.js', () => ({
    chat,
    chat_metadata: chatMetadata,
    extension_prompts: extensionPrompts,
    substituteParams: value => String(value).replaceAll('{{user}}', 'Alice'),
    getCurrentChatId: () => currentChatId,
    getRequestHeaders: () => ({ 'X-Csrf-Token': 'token' }),
    getActiveGenerationAcknowledgement: () => {
        if (settingsPending) throw new Error('Save the active connection settings before generating a reply.');
        return { account, settingsRevision };
    },
    saveChatConditional: async options => { saved.push(options); await chatSaveHandler?.(); return true; },
    saveSettings,
    keepChatReadingPositionOnNextLoad: anchor => { readingAnchors.push(anchor); },
    refreshCurrentChatFromSaved: async options => { reloads.push(chat.length); await reloadHandler?.(options); },
    isGenerating: () => generating,
    get isChatSaving() { return chatSaving; },
    deactivateSendButtons: () => activations.push('busy'),
    activateSendButtons: () => activations.push('idle'),
    setRoleplayJobControls: jobControls,
    willRunNativeRoleplayWorkflow: (type, options = {}) => nativeEligible && !options.skipNativeRoleplay,
    addOneMessage,
    getThumbnailUrl: (type, file) => `/thumbnail?type=${type}&file=${file}`,
    refreshSwipeButtons: () => {},
    syncMesToSwipe: () => false,
    updateMessageBlock,
}));

globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body, method: options.method || 'GET', signal: options.signal ?? null });
    if (url.endsWith('/workflow/submit') || url.endsWith('/group/submit') || url.endsWith('/agent/submit')) return submitHandler(body, requests.length);
    if (url.includes('/workflow/receipt')) return receiptHandler(requests.length, options);
    throw new Error(`unexpected fetch ${url}`);
};

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const workflows = await import('../public/scripts/neconyan-conversation/roleplay-workflows.js');

beforeEach(() => {
    callGenericPopup.mockReset().mockResolvedValue(null);
    restoreDisplay.mockClear();
    jobControls.mockClear();
    beginRoleplayReplacement.mockClear();
    account = 'alice';
    // The module holds this array, so the fixture edits it in place.
    chat.length = 0;
    chat.push(
        { name: 'User', is_user: true, mes: 'Original' },
        { name: 'Nova', mes: 'Answer', swipes: ['Answer', 'Other'], swipe_id: 0 },
    );
    nativeEligible = true;
    currentChatId = 'roleplay';
    currentAvatar = 'nova.png';
    accountStamp = { accountId: 'a-1', dataEpoch: 1 };
    settingsRevision = 4;
    settingsPending = false;
    chatSaveHandler = null;
    reloadHandler = null;
    generating = false;
    chatSaving = false;
    globalThis.document.visibilityState = 'visible';
    for (const key of Object.keys(extensionPrompts)) delete extensionPrompts[key];
    for (const key of Object.keys(chatMetadata)) delete chatMetadata[key];
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    extensionNames.length = 0;
    extensionStates.clear();
    extensionManifests.clear();
    interceptors.length = 0;
    delete globalThis.DialogueColorsInterceptor;
    delete globalThis.__dialogueColorsRuntime_v1;
    dialogueColorsInstruction = 'Colour the dialogue in teal.';
    dialogueColorsResolver.mockReset().mockImplementation(() => dialogueColorsInstruction);
    requests.length = 0;
    saved.length = 0;
    reloads.length = 0;
    readingAnchors.length = 0;
    activations.length = 0;
    observers.clear();
    previews.clear();
    globalThis.toastr = { error: jest.fn() };
    listJobs.mockClear();
    cancelJob.mockClear();
    serviceVectorBrowserWork.mockClear();
    saveSettings.mockClear();
    submitHandler = async () => response(202, { key: 'k', jobId: 'job-1', created: true });
    receiptHandler = () => response(200, { key: 'k', accepted: true, state: 'closed', jobId: 'job-1', result: { named: { appended: true } } });
});

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('stored browser macros are refused by name even without runtime registration', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const data = new Map([
        [getBrowserStoreKey('alice'), JSON.stringify({ version: 1, macros: [
            { id: 'one', name: 'MisoHello', template: 'SECRET PRIVATE TEMPLATE' },
            { id: 'two', name: 'disabled', template: 'disabled', enabled: false },
        ] })],
        [getBrowserStoreKey('bob'), JSON.stringify({ version: 1, macros: [{ id: 'other', name: 'bobOnly', template: 'private' }] })],
    ]);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => data.get(key) ?? null } });
    try {
        expect(workflows.captureBrowserMacros()).toEqual(['misohello', 'me-misohello']);
        const pending = workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await settle();
        const submit = requests.find(entry => entry.url.endsWith('/workflow/submit'));
        expect(submit.body.browserMacros).toEqual(['misohello', 'me-misohello']);
        expect(JSON.stringify(submit.body.browserMacros)).not.toContain('SECRET');
        await observers.get('job-1').onStop('done');
        await pending;
        account = 'bob';
        expect(workflows.captureBrowserMacros()).toEqual(['bobonly', 'me-bobonly']);
    } finally {
        if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
        else delete globalThis.localStorage;
    }
});

test('browser-local custom macro names travel as names only, with their me alias', async () => {
    MacroRegistry.registerMacro('browserLocalProbe', { category: 'enhanced-custom', description: 'A private template.',
        handler: () => 'SECRET TEMPLATE OUTPUT' });
    MacroRegistry.registerMacroAlias('browserLocalProbe', 'me-browserLocalProbe', { visible: false });
    try {
        expect(workflows.captureBrowserMacros()).toEqual(['browserlocalprobe', 'me-browserlocalprobe']);
        const pending = workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await settle();
        const submit = requests.find(entry => entry.url.endsWith('/workflow/submit'));
        expect(submit.body.browserMacros).toEqual(['browserlocalprobe', 'me-browserlocalprobe']);
        expect(JSON.stringify(submit.body.browserMacros)).not.toContain('SECRET');
        await observers.get('job-1').onStop('done');
        await pending;
    } finally {
        MacroRegistry.unregisterMacro('browserLocalProbe');
        MacroRegistry.unregisterMacro('me-browserLocalProbe');
    }
});

test('a group turn submits browser-local custom macro names only', async () => {
    MacroRegistry.registerMacro('groupBrowserProbe', { category: 'enhanced-custom', description: 'A private template.',
        handler: () => 'SECRET TEMPLATE OUTPUT' });
    try {
        const pending = workflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 'turn-3' })
            .catch(error => error);
        await settle();
        const submit = requests.filter(entry => entry.url.endsWith('/group/submit')).at(-1);
        expect(submit.body.browserMacros).toEqual(['groupbrowserprobe']);
        expect(JSON.stringify(submit.body.browserMacros)).not.toContain('SECRET');
        await observers.get('job-1').onStop('done');
        expect(await pending).toMatchObject({ accepted: true, state: 'closed' });
    } finally {
        MacroRegistry.unregisterMacro('groupBrowserProbe');
    }
});

test.each(['roleplay.swipe', 'roleplay.correct', 'guided.swipe', 'guided.regenerate', 'guided.correction'])('%s clears the display before saving and restores it after cancellation', async name => {
    const pending = workflows.submitRoleplayWorkflow({ name });
    expect(beginRoleplayReplacement).toHaveBeenCalledWith(name, 1, expect.any(Function));
    expect(saved).toHaveLength(0);
    expect(chat[1].mes).toBe('Answer');
    const accepted = await pending;
    expect(restoreDisplay).not.toHaveBeenCalled();
    await observers.get(accepted.jobId).onSnapshot({ state: 'cancelled' });
    await accepted.finished;
    await settle();
    expect(restoreDisplay).toHaveBeenCalled();
});

describe('a reply the server did not save stays in the chat', () => {
    const shown = (text, extra) => ({ name: 'Nova', avatar: 'nova.png', text, send_date: '2026-10-27T10:00:00.000Z',
        gen_started: '2026-10-27T10:00:00.000Z', gen_finished: '2026-10-27T10:00:05.000Z', extra: { model: 'model-a', ...extra } });

    async function stopWith(name, state, text, error = null, extra = {}) {
        const accepted = await workflows.submitRoleplayWorkflow({ name });
        await waitFor(() => previews.has(accepted.jobId));
        previews.get(accepted.jobId).stop.reply = () => (text === null ? null : shown(text, extra));
        const savesBefore = saved.length;
        await observers.get(accepted.jobId).onSnapshot({ state, ...(error ? { error } : {}) });
        expect(await accepted.finished).toBeNull();
        return saved.length - savesBefore;
    }

    beforeEach(() => {
        addOneMessage.mockClear();
        updateMessageBlock.mockClear();
    });

    test('a stopped reply is added as a new message and saved', async () => {
        chat.push({ name: 'User', is_user: true, mes: 'Next' });
        expect(await stopWith('roleplay.reply', 'cancelled', 'Half a reply')).toBe(1);
        expect(chat).toHaveLength(4);
        expect(chat[3]).toMatchObject({ name: 'Nova', is_user: false, mes: 'Half a reply', extra: { model: 'model-a' } });
        expect(chat[3].force_avatar).toBeUndefined();
        expect(addOneMessage).toHaveBeenCalledWith(chat[3]);
        expect(reloads.length).toBeGreaterThan(0);
    });

    test('a swipe refused because the chat changed keeps the original and adds the reply as a swipe', async () => {
        const changes = await stopWith('roleplay.swipe', 'failed', 'New answer',
            { code: 'ROLEPLAY_SOURCE_CHANGED', message: 'The chat was saved by another change (an edit, a new message, or an extension rewriting messages) after this was requested, so it was stopped instead of saving over that change. Try again.' });
        expect(changes).toBe(1);
        expect(chat).toHaveLength(2);
        expect(chat[1]).toMatchObject({ mes: 'New answer', swipes: ['Answer', 'Other', 'New answer'], swipe_id: 2 });
        expect(chat[1].swipe_info).toHaveLength(3);
        expect(updateMessageBlock).toHaveBeenCalledWith(1, chat[1]);
    });

    test('a stopped continuation extends its message', async () => {
        chat[1].extra = { inChatAgents: { activeAgentIds: ['previous'] }, other: 'retained' };
        expect(await stopWith('roleplay.continue', 'cancelled', ' and more')).toBe(1);
        expect(chat).toHaveLength(2);
        expect(chat[1].mes).toBe('Answer and more');
        expect(chat[1].extra).toEqual({ inChatAgents: { activeAgentIds: ['previous'] }, other: 'retained' });
    });

    test.each([
        ['roleplay.reply', undefined, undefined],
        ['roleplay.swipe', undefined, { activeAgentIds: ['previous'] }],
        ['roleplay.continue', 'retained', undefined],
    ])('%s keeps its regex snapshot after a failed save', async (name, retainedExtra, originalSwipeSnapshot) => {
        const inChatAgents = { activeAgentIds: ['mood'], regexScriptRefs: [{ agentId: 'mood', scriptId: 'display', revision: 'accepted' }],
            nativeRegexScripts: [{ agentId: 'mood', script: { id: 'display', replaceString: '<em>$1</em>' } }] };
        chat[1].extra = { other: 'retained', display_text: 'Outdated display', inChatAgents: { activeAgentIds: ['previous'] } };
        if (name === 'roleplay.reply') chat.push({ name: 'User', is_user: true, mes: 'Next' });
        expect(await stopWith(name, 'failed', ' [MOOD|Calm]', { code: 'ROLEPLAY_SOURCE_CHANGED' }, { inChatAgents })).toBe(1);
        const recovered = chat.at(-1);
        expect(recovered.extra.inChatAgents).toEqual(inChatAgents);
        expect(recovered.extra.inChatAgents).not.toBe(inChatAgents);
        expect(recovered.swipe_info?.[0]?.extra.inChatAgents).toEqual(originalSwipeSnapshot);
        expect(recovered.extra.other).toBe(retainedExtra);
        expect(recovered.extra.display_text).toBeUndefined();
        const savedSnapshot = recovered.swipe_info?.at(-1)?.extra.inChatAgents ?? recovered.extra.inChatAgents;
        expect(savedSnapshot).toEqual(inChatAgents);
    });

    test('a reply the saved chat already holds is not added twice', async () => {
        reloadHandler = () => { chat.push({ name: 'Nova', mes: 'Saved already' }); };
        expect(await stopWith('roleplay.reply', 'interrupted', 'Saved already')).toBe(0);
        expect(chat.filter(message => message.mes === 'Saved already')).toHaveLength(1);
        expect(addOneMessage).not.toHaveBeenCalled();
    });

    test('nothing is added when no reply text was shown', async () => {
        expect(await stopWith('roleplay.reply', 'cancelled', null)).toBe(0);
        expect(chat).toHaveLength(2);
    });

    test('a server kept reply is reloaded and the page never saves its stale preview', async () => {
        const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has(accepted.jobId));
        const stop = previews.get(accepted.jobId).stop;
        stop.reply = jest.fn(() => shown('Half a reply'));
        receiptHandler = () => response(200, { key: 'k', accepted: true, state: 'accepted', jobId: accepted.jobId,
            result: null, capabilities: { keptReply: 1 }, keptReply: { state: 'done', messageIndex: 3, reason: 'stopped' } });
        const savesBefore = saved.length;
        const reloadsBefore = reloads.length;
        await observers.get(accepted.jobId).onSnapshot({ state: 'cancelled', error: { message: 'The reply was stopped.' } });
        await waitFor(() => reloads.length > reloadsBefore);
        expect(await accepted.finished).toBeNull();
        expect(stop.reply).not.toHaveBeenCalled();
        expect(saved).toHaveLength(savesBefore);
        expect(addOneMessage).not.toHaveBeenCalled();
        expect(reloads.length).toBeGreaterThan(reloadsBefore);
    });

    test('a keeper still writing is awaited before the page decides the reply is lost', async () => {
        const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has(accepted.jobId));
        const stop = previews.get(accepted.jobId).stop;
        stop.reply = jest.fn(() => shown('Half a reply'));
        let calls = 0;
        receiptHandler = () => {
            calls += 1;
            return response(200, { key: 'k', accepted: true, state: 'accepted', jobId: accepted.jobId, result: null,
                capabilities: { keptReply: 1 },
                keptReply: calls === 1 ? null : { state: 'done', messageIndex: 3, reason: 'stopped' },
                keptReplyPending: calls === 1 });
        };
        const savesBefore = saved.length;
        const reloadsBefore = reloads.length;
        await observers.get(accepted.jobId).onSnapshot({ state: 'cancelled', error: { message: 'The reply was stopped.' } });
        await waitFor(() => reloads.length > reloadsBefore);
        expect(calls).toBeGreaterThanOrEqual(2);
        expect(stop.reply).not.toHaveBeenCalled();
        expect(saved).toHaveLength(savesBefore);
        expect(reloads.length).toBeGreaterThan(reloadsBefore);
    });

    test('a submission that advertised the keeper never saves its preview when the receipt read fails', async () => {
        submitHandler = async body => response(202, { key: body.key, jobId: 'job-keeper', created: true,
            capabilities: { keptReply: 1 } });
        const pending = workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has('job-keeper'));
        const stop = previews.get('job-keeper').stop;
        stop.reply = jest.fn(() => shown('Half a reply'));
        stop.hasText = () => true;
        receiptHandler = () => response(503, { error: 'Receipt temporarily unavailable.' });
        const savesBefore = saved.length;
        const reloadsBefore = reloads.length;
        await observers.get('job-keeper').onSnapshot({ state: 'cancelled', error: { message: 'The reply was stopped.' } });
        await waitFor(() => reloads.length > reloadsBefore, 6000);
        await pending;
        expect(stop.reply).not.toHaveBeenCalled();
        expect(saved).toHaveLength(savesBefore);
        expect(reloads.length).toBeGreaterThan(reloadsBefore);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });

    test('a kept failed reply still shows the real reason and says the text was saved', async () => {
        const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has(accepted.jobId));
        const stop = previews.get(accepted.jobId).stop;
        stop.reply = jest.fn(() => shown('Half a reply'));
        receiptHandler = () => response(200, { key: 'k', accepted: true, state: 'accepted', jobId: accepted.jobId,
            result: null, capabilities: { keptReply: 1 }, keptReply: { state: 'done', messageIndex: 3, reason: 'failed' } });
        const savesBefore = saved.length;
        await observers.get(accepted.jobId).onSnapshot({ state: 'failed',
            error: { message: 'The connection to your model provider closed.' } });
        await waitFor(() => globalThis.toastr.error.mock.calls.length > 0);
        expect(stop.reply).not.toHaveBeenCalled();
        expect(saved).toHaveLength(savesBefore);
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        const [message, title] = globalThis.toastr.error.mock.calls[0];
        expect(title).toBe('Reply failed');
        expect(message).toContain('The connection to your model provider closed.');
        expect(message).toContain('saved in this chat');
    });

    test('a kept cancellation stays quiet', async () => {
        const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has(accepted.jobId));
        const stop = previews.get(accepted.jobId).stop;
        stop.reply = jest.fn(() => shown('Half a reply'));
        receiptHandler = () => response(200, { key: 'k', accepted: true, state: 'accepted', jobId: accepted.jobId,
            result: null, capabilities: { keptReply: 1 }, keptReply: { state: 'done', messageIndex: 3, reason: 'stopped' } });
        await observers.get(accepted.jobId).onSnapshot({ state: 'cancelled', error: { message: 'The reply was stopped.' } });
        await waitFor(() => reloads.length > 0);
        expect(stop.reply).not.toHaveBeenCalled();
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });

    test('a restart interruption keeps the page preview only when no publication or keeper text exists', async () => {
        const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has(accepted.jobId));
        const stop = previews.get(accepted.jobId).stop;
        stop.reply = jest.fn(() => shown('Half a reply'));
        receiptHandler = () => response(200, { key: 'k', accepted: true, state: 'accepted', jobId: accepted.jobId,
            result: null, publication: 'none', capabilities: { keptReply: 1 }, keptReply: null, keptReplyPending: false });
        const savesBefore = saved.length;
        await observers.get(accepted.jobId).onSnapshot({ state: 'interrupted',
            error: { message: 'The server stopped before this reply finished.' } });
        await waitFor(() => saved.length > savesBefore);
        expect(chat.at(-1).mes).toBe('Half a reply');
    });

    test('a restart interruption with a normal publication never saves the page preview', async () => {
        const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has(accepted.jobId));
        const stop = previews.get(accepted.jobId).stop;
        stop.reply = jest.fn(() => shown('Half a reply'));
        receiptHandler = () => response(200, { key: 'k', accepted: true, state: 'accepted', jobId: accepted.jobId,
            result: null, publication: 'done', capabilities: { keptReply: 1 }, keptReply: null, keptReplyPending: false });
        const savesBefore = saved.length;
        await observers.get(accepted.jobId).onSnapshot({ state: 'interrupted',
            error: { message: 'The server stopped before this reply finished.' } });
        await waitFor(() => reloads.length > 0);
        expect(stop.reply).not.toHaveBeenCalled();
        expect(saved).toHaveLength(savesBefore);
    });

    test('a kept reply whose reload was deferred while hidden is shown on return', async () => {
        const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has(accepted.jobId));
        const stop = previews.get(accepted.jobId).stop;
        stop.reply = jest.fn(() => shown('Half a reply'));
        receiptHandler = () => response(200, { key: 'k', accepted: true, state: 'accepted', jobId: accepted.jobId,
            result: null, capabilities: { keptReply: 1 }, keptReply: { state: 'done', messageIndex: 3, reason: 'stopped' } });
        const reloadsBefore = reloads.length;
        globalThis.document.visibilityState = 'hidden';
        await observers.get(accepted.jobId).onSnapshot({ state: 'cancelled', error: null });
        await settle();
        expect(reloads).toHaveLength(reloadsBefore);
        globalThis.document.visibilityState = 'visible';
        await workflows.resumeNativeRoleplayWorkflowObservation({ attachOnly: true });
        await waitFor(() => reloads.length > reloadsBefore);
        expect(stop.reply).not.toHaveBeenCalled();
    });

    test('a kept failure while hidden shows exactly one notice on return', async () => {
        const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has(accepted.jobId));
        const stop = previews.get(accepted.jobId).stop;
        stop.reply = jest.fn(() => shown('Half a reply'));
        receiptHandler = () => response(200, { key: 'k', accepted: true, state: 'accepted', jobId: accepted.jobId,
            result: null, capabilities: { keptReply: 1 }, keptReply: { state: 'done', messageIndex: 3, reason: 'failed' } });
        globalThis.document.visibilityState = 'hidden';
        await observers.get(accepted.jobId).onSnapshot({ state: 'failed',
            error: { message: 'The connection to your model provider closed.' } });
        await settle();
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        globalThis.document.visibilityState = 'visible';
        await workflows.resumeNativeRoleplayWorkflowObservation({ attachOnly: true });
        await waitFor(() => globalThis.toastr.error.mock.calls.length === 1);
        expect(globalThis.toastr.error.mock.calls[0][0]).toContain('saved in this chat');
        await settle();
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
    });

    test('a stop before the first token does not reload or lock the chat', async () => {
        const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has(accepted.jobId));
        const stop = previews.get(accepted.jobId).stop;
        stop.hasText = () => false;
        receiptHandler = () => response(200, { key: 'k', accepted: true, state: 'accepted', jobId: accepted.jobId,
            result: null, capabilities: { keptReply: 1 }, keptReply: null, keptReplyPending: false });
        const reloadsBefore = reloads.length;
        const savesBefore = saved.length;
        await observers.get(accepted.jobId).onSnapshot({ state: 'cancelled', error: null });
        await accepted.finished;
        expect(reloads).toHaveLength(reloadsBefore);
        expect(saved).toHaveLength(savesBefore);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });

    test('a reattached preview subscribes before its capability probe returns', async () => {
        listJobs.mockResolvedValue([{ id: 'probing', type: 'media.roleplay-workflow', state: 'running',
            intent: { media: { operationKey: 'key-probing' }, source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
                request: { named: { name: 'roleplay.reply' } } } }]);
        let release;
        receiptHandler = () => new Promise(resolve => { release = () => resolve(response(200, {
            accepted: true, state: 'accepted', jobId: 'probing', result: null, capabilities: { keptReply: 1 } })); });
        const resumed = workflows.resumeNativeRoleplayWorkflowObservation();
        await waitFor(() => observers.has('probing'));
        expect(observers.has('probing')).toBe(true);
        release();
        await resumed;
        await settle();
    });

    test('a reattached observer learns the keeper capability before a failed receipt read', async () => {
        listJobs.mockResolvedValue([{ id: 'reattached', type: 'media.roleplay-workflow', state: 'running',
            intent: { media: { operationKey: 'key-reattached' }, source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
                request: { named: { name: 'roleplay.reply' } } } }]);
        let receiptCalls = 0;
        let releaseProbe;
        receiptHandler = () => {
            receiptCalls += 1;
            if (receiptCalls === 1) return new Promise(resolve => { releaseProbe = () => resolve(response(200, {
                accepted: true, state: 'accepted', jobId: 'reattached', result: null, capabilities: { keptReply: 1 } })); });
            return response(503, { error: 'Receipt temporarily unavailable.' });
        };
        await workflows.resumeNativeRoleplayWorkflowObservation();
        expect(observers.has('reattached')).toBe(true);
        await waitFor(() => previews.has('reattached'));
        const display = previews.get('reattached');
        display.stop.reply = jest.fn(() => ({ name: 'Nova', avatar: 'nova.png', text: 'Half a reply',
            send_date: '2026-10-27T10:00:00.000Z', gen_started: '2026-10-27T10:00:00.000Z',
            gen_finished: '2026-10-27T10:00:05.000Z', extra: {} }));
        display.hasText = () => true;
        const savesBefore = saved.length;
        const terminal = observers.get('reattached').onSnapshot({ state: 'failed',
            error: { message: 'The connection to your model provider closed.' } });
        await settle();
        expect(releaseProbe).toBeDefined();
        releaseProbe();
        await terminal;
        await waitFor(() => reloads.length > 0, 6000);
        expect(display.stop.reply).not.toHaveBeenCalled();
        expect(saved).toHaveLength(savesBefore);
    });

    test('a keeper failure is reported without saving the preview', async () => {
        const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has(accepted.jobId));
        const stop = previews.get(accepted.jobId).stop;
        stop.reply = jest.fn(() => shown('Half a reply'));
        receiptHandler = () => response(200, { key: 'k', accepted: true, state: 'accepted', jobId: accepted.jobId,
            result: null, capabilities: { keptReply: 1 },
            keptReply: { state: 'failed', messageIndex: null, reason: 'stopped', error: { code: 'ROLEPLAY_STORE_FULL', message: 'The saved store is full.' } } });
        const savesBefore = saved.length;
        await observers.get(accepted.jobId).onSnapshot({ state: 'failed', error: { message: 'The reply failed.' } });
        await waitFor(() => globalThis.toastr.error.mock.calls.some(([, title]) => title === 'Reply failed'));
        expect(stop.reply).not.toHaveBeenCalled();
        expect(saved).toHaveLength(savesBefore);
        expect(globalThis.toastr.error).toHaveBeenCalledWith(expect.stringContaining('Neconyan still has the text saved'), 'Reply failed');
    });

    test('a saved longer server tail is never duplicated by a stale preview', async () => {
        const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has(accepted.jobId));
        const stop = previews.get(accepted.jobId).stop;
        stop.reply = () => shown('Half a reply');
        reloadHandler = () => { chat.push({ name: 'Nova', is_user: false, mes: 'Half a reply, complete',
            gen_started: '2026-10-27T10:00:00.000Z', extra: { model: 'model-a' } }); };
        const savesBefore = saved.length;
        await observers.get(accepted.jobId).onSnapshot({ state: 'cancelled', error: { message: 'The reply was stopped.' } });
        await waitFor(() => chat.length === 3);
        expect(await accepted.finished).toBeNull();
        expect(chat.filter(message => String(message.mes).startsWith('Half a reply'))).toHaveLength(1);
        expect(chat[2].mes).toBe('Half a reply, complete');
        expect(saved).toHaveLength(savesBefore);
    });

    test('a different generation with similar opening text is not treated as the same reply', async () => {
        const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
        await waitFor(() => previews.has(accepted.jobId));
        const stop = previews.get(accepted.jobId).stop;
        stop.reply = () => shown('Half a reply');
        reloadHandler = () => { chat.push({ name: 'Nova', is_user: false, mes: 'Half a reply, complete',
            gen_started: '2026-10-27T09:00:00.000Z', extra: { model: 'model-a' } }); };
        await observers.get(accepted.jobId).onSnapshot({ state: 'cancelled', error: { message: 'The reply was stopped.' } });
        await waitFor(() => chat.length === 4);
        expect(chat[3].mes).toBe('Half a reply');
    });
});

test('a refused replacement restores the same display without changing the saved source', async () => {
    submitHandler = async () => response(400, { error: 'Refused' });
    const pending = workflows.submitRoleplayWorkflow({ name: 'roleplay.swipe' });
    expect(restoreDisplay).not.toHaveBeenCalled();
    await expect(pending).rejects.toThrow();
    expect(restoreDisplay).toHaveBeenCalled();
    expect(chat[1].mes).toBe('Answer');
});

async function waitFor(predicate, timeoutMs = 3000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the condition.');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

test.each(['failed', 'interrupted', 'conflict', 'cancelled'].flatMap(state => [
    [state, 'poll'], [state, 'preview'],
]))('a %s reply releases Send when the %s finishes first, without waiting for a write', async (state, first) => {
    const pending = workflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 1 });
    await waitFor(() => previews.has('job-1'));
    const message = state === 'cancelled' ? null : 'The connection to your model provider closed.';
    const snapshot = { state, error: message ? { message } : null };
    const preview = { state, error: message };
    const observation = observers.get('job-1');
    const display = previews.get('job-1');
    if (first === 'poll') {
        await observation.onSnapshot(snapshot);
        display.onTerminal(preview);
    } else {
        display.onTerminal(preview);
        await observation.onSnapshot(snapshot);
    }
    await expect(pending).resolves.toBeNull();
    expect(requests.filter(entry => entry.url.includes('/workflow/receipt'))).toHaveLength(1);
    expect(display.stop).toHaveBeenCalledTimes(1);
    expect(globalThis.toastr.error).toHaveBeenCalledTimes(message ? 1 : 0);
    expect(reloads).toHaveLength(0);
});

test('a named continuation anchors the last block, saves the chat first and resolves from the receipt', async () => {
    const pending = workflows.runNativeRoleplayGeneration('continue', { maxOutputTokens: 240 });
    await settle();
    expect(saved).toHaveLength(1);
    const submit = requests.find(entry => entry.url.endsWith('/workflow/submit'));
    expect(submit.body).toMatchObject({
        name: 'roleplay.continue', intent: {},
        source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
        anchor: { messageIndex: 1, chosen: false },
        maxTokens: 240,
        // Settings are saved once before submitting, so the proof names that save.
        acknowledgement: { account: 'alice', settingsRevision: 5 },
    });
    expect(saveSettings).toHaveBeenCalledTimes(1);
    // The write is not durable yet, so the call is still waiting.
    expect(activations).toEqual(['busy']);
    await observers.get('job-1').onStop('done');
    const outcome = await pending;
    expect(outcome).toMatchObject({ native: true, name: 'roleplay.continue', jobId: 'job-1', state: 'closed' });
    expect(callGenericPopup).not.toHaveBeenCalled();
    expect(reloads).toEqual([2]);
    expect(activations).toEqual(['busy', 'idle']);
});

test('a finished reply hands the reader\'s place to the reload and clears it afterwards', async () => {
    let anchorsDuringReload = null;
    reloadHandler = () => { anchorsDuringReload = [...readingAnchors]; };
    const pending = workflows.runNativeRoleplayGeneration('continue', { maxOutputTokens: 240 });
    await settle();
    await observers.get('job-1').onStop('done');
    await pending;
    // Without a page there is no live reply to hold, so the reload keeps its usual landing.
    expect(anchorsDuringReload).toEqual([null]);
    expect(readingAnchors).toEqual([null, null]);
    expect(reloads).toEqual([2]);
});

test.each([null, 2])('a finished reply anchors its own text, using the kept message index when supplied: %s', keptIndex => {
    const previewText = { getBoundingClientRect: () => ({ top: 360, bottom: 520 }) };
    const preview = {
        getBoundingClientRect: () => ({ top: 320, bottom: 640 }),
        querySelector: selector => selector === '.mes_text' ? previewText : null,
        previousElementSibling: null,
    };
    const above = {
        matches: selector => selector === '.mes[mesid]',
        getAttribute: () => '0',
        getBoundingClientRect: () => ({ top: 180, bottom: 300 }),
        previousElementSibling: null,
    };
    const marker = {
        matches: () => false,
        dataset: { roleplayReplacement: '1' },
        previousElementSibling: above,
    };
    preview.previousElementSibling = marker;
    const chatNode = {
        getBoundingClientRect: () => ({ top: 100 }),
        querySelector: selector => selector === '#neconyan-roleplay-preview' ? preview
            : selector === '[data-roleplay-replacement]' ? marker : null,
    };
    const original = globalThis.document.querySelector;
    globalThis.document.querySelector = selector => selector === '#chat' ? chatNode : null;
    try {
        expect(workflows.finishedReplyReadingAnchor(keptIndex === null ? null : { keptReply: { messageIndex: keptIndex } })).toEqual({
            messageId: keptIndex ?? 1,
            offsetTop: 260,
            part: '.mes_text',
            fallback: { messageId: '0', offsetTop: 80 },
        });
    } finally {
        globalThis.document.querySelector = original;
    }
});

function installFinishedReplyDom({ previewChild = 'last-speaker-child', withFallback = true } = {}) {
    const previewText = { getBoundingClientRect: () => ({ top: 360, bottom: 520 }) };
    const above = withFallback ? {
        matches: selector => selector === '.mes[mesid]',
        getAttribute: () => '0',
        getBoundingClientRect: () => ({ top: 180, bottom: 300 }),
        previousElementSibling: null,
    } : null;
    const preview = {
        dataset: previewChild ? { roleplayChild: previewChild } : {},
        getBoundingClientRect: () => ({ top: 320, bottom: 640 }),
        querySelector: selector => selector === '.mes_text' ? previewText : null,
        previousElementSibling: above,
    };
    const chatNode = {
        getBoundingClientRect: () => ({ top: 100 }),
        querySelector: selector => selector === '#neconyan-roleplay-preview' ? preview : null,
    };
    const original = globalThis.document.querySelector;
    globalThis.document.querySelector = selector => selector === '#chat' ? chatNode : null;
    return {
        preview,
        restore() { globalThis.document.querySelector = original; },
    };
}

const twoSpeakerReceipt = { result: { childJobId: 'last-speaker-child', speakers: [{}, {}] } };
const precedingFallback = { messageId: '0', offsetTop: 80, part: null, fallback: null };

test('a finished group reply anchors its final saved speaker when the preview child matches', () => {
    const dom = installFinishedReplyDom();
    try {
        expect(workflows.finishedReplyReadingAnchor(twoSpeakerReceipt)).toEqual({
            messageId: 3,
            offsetTop: 260,
            part: '.mes_text',
            fallback: { messageId: '0', offsetTop: 80 },
        });
    } finally {
        dom.restore();
    }
});

test('a group preview and saved child mismatch falls back to the preceding row', () => {
    const dom = installFinishedReplyDom();
    try {
        dom.preview.dataset.roleplayChild = 'unsaved-partial-child';
        expect(workflows.finishedReplyReadingAnchor(twoSpeakerReceipt)).toEqual(precedingFallback);
    } finally {
        dom.restore();
    }
});

test('a group handover with a missing child identity falls back to the preceding row', () => {
    const dom = installFinishedReplyDom();
    try {
        delete dom.preview.dataset.roleplayChild;
        expect(workflows.finishedReplyReadingAnchor(twoSpeakerReceipt)).toEqual(precedingFallback);

        dom.preview.dataset.roleplayChild = 'last-speaker-child';
        expect(workflows.finishedReplyReadingAnchor({ result: { speakers: [{}, {}] } })).toEqual(precedingFallback);
    } finally {
        dom.restore();
    }
});

test('a mismatched group handover with no preceding row has no anchor', () => {
    const dom = installFinishedReplyDom({ previewChild: 'unsaved-partial-child', withFallback: false });
    try {
        expect(workflows.finishedReplyReadingAnchor(twoSpeakerReceipt)).toBeNull();
    } finally {
        dom.restore();
    }
});

test('a solo reply keeps the reply anchor without group speakers', () => {
    const dom = installFinishedReplyDom({ previewChild: '' });
    try {
        expect(workflows.finishedReplyReadingAnchor({ result: { childJobId: 'single-child' } })).toEqual({
            messageId: 2,
            offsetTop: 260,
            part: '.mes_text',
            fallback: { messageId: '0', offsetTop: 80 },
        });
        expect(workflows.finishedReplyReadingAnchor()).toEqual({
            messageId: 2,
            offsetTop: 260,
            part: '.mes_text',
            fallback: { messageId: '0', offsetTop: 80 },
        });
    } finally {
        dom.restore();
    }
});

test('a reply anchors the whole chat, so the user message just written is the one the server answers', async () => {
    chat.push({ name: 'User', is_user: true, mes: 'Where are you?' });
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    expect(requests.find(entry => entry.url.endsWith('/workflow/submit')).body).toMatchObject({
        name: 'roleplay.reply', anchor: { messageIndex: 2, chosen: false },
    });
    await observers.get('job-1').onStop('done');
    await pending;
});

test('a story passage carries the Story prompt the page is using, with its macros resolved', async () => {
    // Story Mode writes its rules as page extension prompts, not as saved chat injects.
    extensionPrompts.sbstory_rules = { value: 'Write one paragraph with {{user}}.', position: 1, depth: 1, scan: false, role: 0 };
    extensionPrompts.sbstory_direction = { value: 'Let the storm break.', position: 1, depth: 0, scan: false, role: 0 };
    const pending = workflows.runNativeRoleplayGeneration('continue');
    await settle();
    const submit = requests.find(entry => entry.url.endsWith('/workflow/submit'));
    expect(submit.body.name).toBe('story.passage');
    // The Story prompts travel once, as the named prompt, and not again as page prompts.
    expect(submit.body.intent).toEqual({ prompt: { rules: 'Write one paragraph with Alice.', rulesDepth: 1,
        direction: 'Let the storm break.', directionDepth: 0 } });
    await observers.get('job-1').onStop('done');
    await pending;
});

test('page-only prompt additions travel resolved and sorted, and server-built prompts stay behind', async () => {
    globalThis.__dialogueColorsRuntime_v1 = { initialized: true };
    interceptors.push({ name: 'third-party/sillytavern-character-colors', key: 'DialogueColorsInterceptor' });
    globalThis.DialogueColorsInterceptor = jest.fn(async () => {
        extensionPrompts['dialogue-colors'] = { value: 'Colour {{user}} in teal.', position: 1, depth: 1, scan: false, role: 0 };
    });
    extensionPrompts['2_floating_prompt'] = { value: 'Author note the server rebuilds.', position: 1, depth: 4, scan: false, role: 0 };
    extensionPrompts.customDepthWI_2_0 = { value: 'Lore the server rebuilds.', position: 1, depth: 2, scan: false, role: 0 };
    extensionPrompts['1_memory'] = { value: 'Summary so far.', position: 0, depth: 0, scan: false, role: 0 };
    extensionPrompts.script_inject_note = { value: 'Hidden note.', position: 1, depth: 3, scan: false, role: 1, filter: async () => false };
    extensionPrompts.script_inject_off = { value: 'Unused.', position: -1, depth: 0, scan: false, role: 0 };
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    expect(globalThis.DialogueColorsInterceptor).toHaveBeenCalled();
    const submit = requests.find(entry => entry.url.endsWith('/workflow/submit'));
    expect(submit.body.intent).toEqual({ page: [
        { key: '1_memory', content: 'Summary so far.', position: 0, depth: 0, role: 'system' },
        { key: 'dialogue-colors', content: 'Colour Alice in teal.', position: 1, depth: 1, role: 'system' },
    ] });
    // The loaded extension's macro text travels top-level, captured exactly once.
    expect(submit.body.bundledMacros).toEqual({ dialoguecolors: 'Colour the dialogue in teal.' });
    expect(dialogueColorsResolver).toHaveBeenCalledTimes(1);
    await observers.get('job-1').onStop('done');
    await pending;
});

test('a host-disabled Dialogue Colors extension supplies an explicit empty capture without resolving', async () => {
    globalThis.DialogueColorsInterceptor = jest.fn();
    extensionSettings.disabledExtensions = ['third-party/sillytavern-character-colors'];
    const pending = workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
    await settle();
    const submit = requests.find(entry => entry.url.endsWith('/workflow/submit'));
    expect(submit.body.bundledMacros).toEqual({ dialoguecolors: '' });
    expect(dialogueColorsResolver).not.toHaveBeenCalled();
    await observers.get('job-1').onStop('done');
    await pending;
});

test('a page with no loaded Dialogue Colors extension supplies an explicit empty capture', async () => {
    delete globalThis.__dialogueColorsRuntime_v1;
    const pending = workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
    await settle();
    const submit = requests.find(entry => entry.url.endsWith('/workflow/submit'));
    expect(submit.body.bundledMacros).toEqual({ dialoguecolors: '' });
    expect(dialogueColorsResolver).not.toHaveBeenCalled();
    await observers.get('job-1').onStop('done');
    await pending;
});

test('capture waits for saved extension settings instead of using startup defaults', async () => {
    let ready;
    const runtime = { initialized: false, ready: new Promise(resolve => { ready = resolve; }) };
    globalThis.__dialogueColorsRuntime_v1 = runtime;
    const capture = workflows.captureBundledMacros();
    await settle();
    expect(dialogueColorsResolver).not.toHaveBeenCalled();
    dialogueColorsInstruction = '';
    runtime.initialized = true;
    ready();
    await expect(capture).resolves.toEqual({ dialoguecolors: '' });
    expect(dialogueColorsResolver).toHaveBeenCalledTimes(1);
});

test('failed extension loading refuses before any submission rather than sending empty instructions', async () => {
    globalThis.__dialogueColorsRuntime_v1 = { initialized: false, ready: Promise.resolve() };
    await expect(workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' })).rejects.toThrow('did not finish loading');
    expect(requests).toHaveLength(0);
    expect(dialogueColorsResolver).not.toHaveBeenCalled();
});

test('a failed loaded resolver is not silently converted to a disabled capture', async () => {
    globalThis.__dialogueColorsRuntime_v1 = { initialized: true };
    dialogueColorsResolver.mockImplementationOnce(() => { throw new Error('Saved palette could not be read'); });
    await expect(workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' })).rejects.toThrow('Saved palette could not be read');
    expect(requests).toHaveLength(0);
});

test('a lost response reuses the same key and capture even when the extension changes or fails', async () => {
    globalThis.__dialogueColorsRuntime_v1 = { initialized: true };
    submitHandler = async () => { throw new Error('Lost response'); };
    await expect(workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' })).rejects.toThrow('Lost response');
    const first = requests.at(-1).body;
    dialogueColorsInstruction = 'Different palette after submission.';
    dialogueColorsResolver.mockImplementation(() => { throw new Error('Extension unavailable during retry'); });
    submitHandler = async body => response(202, { key: body.key, jobId: 'same-job', created: false });
    const accepted = await workflows.submitRoleplayWorkflow({ name: 'roleplay.reply' });
    expect(requests.at(-1).body).toEqual(first);
    expect(dialogueColorsResolver).toHaveBeenCalledTimes(1);
    await observers.get(accepted.jobId).onStop('done');
    await accepted.finished;
});

test('the settings-proof retry replays the captured instruction instead of recalculating it', async () => {
    globalThis.__dialogueColorsRuntime_v1 = { initialized: true };
    globalThis.DialogueColorsInterceptor = jest.fn();
    let attempts = 0;
    submitHandler = async body => {
        attempts += 1;
        if (attempts === 1) {
            dialogueColorsInstruction = 'A changed page instruction.';
            return response(409, { error: 'Save first.', code: 'roleplay_settings_ack_required' });
        }
        return response(202, { key: body.key, jobId: 'job-2', created: true });
    };
    receiptHandler = () => response(200, { accepted: true, state: 'closed', jobId: 'job-2', result: {} });
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    const submits = requests.filter(entry => entry.url.endsWith('/workflow/submit'));
    expect(submits).toHaveLength(2);
    expect(submits.every(entry => entry.body.bundledMacros.dialoguecolors === 'Colour the dialogue in teal.')).toBe(true);
    expect(dialogueColorsResolver).toHaveBeenCalledTimes(1);
    await observers.get('job-2').onStop('done');
    await pending;
});

test.each([
    ['an Agent prompt the server policy owns', () => { extensionPrompts.inchat_agent_scribe = { value: 'Agent text.', position: 1, depth: 0, scan: false, role: 0 }; }],
    ['a prompt that must be scanned for lore', () => { extensionPrompts.script_inject_scan = { value: 'Scan me.', position: 1, depth: 0, scan: true, role: 0 }; }],
    ['a macro the page cannot resolve', () => { extensionPrompts.script_inject_macro = { value: 'Roll {{roll:d6}}.', position: 1, depth: 0, scan: false, role: 0 }; }],
    ['a key the server cannot name', () => { extensionPrompts['script_inject_a b'] = { value: 'Spaced.', position: 1, depth: 0, scan: false, role: 0 }; }],
    ['an unknown generation interceptor', () => { interceptors.push({ name: 'third-party/other', key: 'otherInterceptor' }); }],
])('%s keeps the browser path instead of generating without it', async (_label, arrange) => {
    arrange();
    expect(await workflows.capturePagePrompts('roleplay.reply')).toBeNull();
    expect(await workflows.runNativeRoleplayGeneration('normal')).toBeNull();
    // A replacement the host already kept undeleted is refused, never sent without it.
    expect(await workflows.runNativeRoleplayGeneration('swipe', { committed: true }))
        .toMatchObject({ state: 'refused', refused: true });
    expect(requests).toHaveLength(0);
});

test('an active Doom suite keeps ordinary replies on the browser path', async () => {
    const name = 'third-party/Dooms-Enhancement-Suite';
    extensionNames.push(name);
    extensionStates.set(name, { name, enabled: true });
    extensionManifests.set(name, { display_name: 'Doom\'s Enhancement Suite', homePage: 'https://github.com/DangerDaza/Dooms-Enhancement-Suite' });
    extensionSettings[name] = { enabled: true };
    expect(workflows.activeDoomsEnhancementSuite()).toBe(name);
    expect(await workflows.capturePagePrompts('roleplay.reply')).toBeNull();
    expect(await workflows.runNativeRoleplayGeneration('normal')).toBeNull();
    expect(await workflows.groupPagePromptsBlocked()).toBe(true);
    expect(requests).toHaveLength(0);
});

test('a renamed Doom install is identified by its manifest, not its folder', async () => {
    const name = 'third-party/Dooms-Renamed';
    extensionNames.push(name);
    extensionStates.set(name, { name, enabled: true });
    extensionManifests.set(name, { display_name: 'Renamed Tracker', homepage: 'https://github.com/DangerDaza/Dooms-Enhancement-Suite/' });
    extensionSettings[name] = { enabled: true };
    expect(workflows.activeDoomsEnhancementSuite()).toBe(name);
    expect(await workflows.capturePagePrompts('roleplay.reply')).toBeNull();
});

test('a disabled Doom suite leaves the native path eligible', async () => {
    const name = 'third-party/Dooms-Enhancement-Suite';
    extensionNames.push(name);
    extensionManifests.set(name, { homePage: 'https://github.com/DangerDaza/Dooms-Enhancement-Suite' });
    extensionStates.set(name, { name, enabled: false });
    extensionSettings[name] = { enabled: true };
    expect(workflows.activeDoomsEnhancementSuite()).toBeNull();
    expect(await workflows.capturePagePrompts('roleplay.reply')).toEqual([]);
});

test('a Doom suite switched off inside its own settings leaves the native path eligible', async () => {
    const name = 'third-party/Dooms-Enhancement-Suite';
    extensionNames.push(name);
    extensionStates.set(name, { name, enabled: true });
    extensionManifests.set(name, { homePage: 'https://github.com/DangerDaza/Dooms-Enhancement-Suite' });
    extensionSettings[name] = { enabled: false };
    expect(workflows.activeDoomsEnhancementSuite()).toBeNull();
    expect(await workflows.capturePagePrompts('roleplay.reply')).toEqual([]);
});

test('stale Doom settings after an uninstall do not keep the browser path', async () => {
    extensionSettings['third-party/Dooms-Enhancement-Suite'] = { enabled: true };
    expect(workflows.activeDoomsEnhancementSuite()).toBeNull();
    expect(await workflows.capturePagePrompts('roleplay.reply')).toEqual([]);
});

test('kept-note blocks left by a browser prompt preview do not disable server-owned replies', async () => {
    extensionPrompts.inchat_agent_companion_history_keeper = {
        value: '[Keeper - kept notes]\nA previous preview.', position: 1, depth: 0, scan: true, role: 0,
    };
    expect(await workflows.capturePagePrompts('roleplay.reply')).toEqual([]);
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    expect(requests.find(entry => entry.url.endsWith('/workflow/submit')).body.intent).toEqual({});
    await observers.get('job-1').onStop('done');
    await pending;
});

test('group page additions keep the browser because the group payload cannot carry them', async () => {
    expect(await workflows.groupPagePromptsBlocked()).toBe(false);

    // A saved /inject is caught even before the page materializes it.
    chatMetadata.script_injects = { note: { value: 'Always answer in French.', position: 1, depth: 0, scan: false, role: 0 } };
    expect(await workflows.groupPagePromptsBlocked()).toBe(true);

    // Once materialized, the ordinary capture sees the same instruction.
    extensionPrompts.script_inject_note = { value: 'Always answer in French.', position: 1, depth: 0, scan: false, role: 0 };
    expect(await workflows.groupPagePromptsBlocked()).toBe(true);
    delete extensionPrompts.script_inject_note;

    // An injection hidden from the prompt does not travel either way.
    chatMetadata.script_injects = { hidden: { value: 'Hidden note.', position: -1, depth: 0, scan: false, role: 0 } };
    expect(await workflows.groupPagePromptsBlocked()).toBe(false);

    extensionPrompts['dialogue-colors'] = { value: 'Colour the dialogue.', position: 1, depth: 1, scan: false, role: 0 };
    expect(await workflows.groupPagePromptsBlocked()).toBe(true);

    interceptors.push({ name: 'third-party/other', key: 'otherInterceptor' });
    expect(await workflows.groupPagePromptsBlocked()).toBe(true);
});

test('the dice result travels to server replies as a page prompt', async () => {
    interceptors.push({ name: 'dice-roller', key: 'necoDiceRollerInterceptor' });
    const types = [];
    globalThis.necoDiceRollerInterceptor = jest.fn(async (chat, _size, _abort, type) => {
        types.push({ chat, type });
        extensionPrompts.neco_dice_roller = { value: '[Dice result for Alice]\nPick the lock: SUCCESS.', position: 1, depth: 0, scan: false, role: 0 };
    });
    try {
        expect(await workflows.capturePagePrompts('roleplay.reply')).toEqual([
            { key: 'neco_dice_roller', content: '[Dice result for Alice]\nPick the lock: SUCCESS.', position: 1, depth: 0, role: 'system' },
        ]);
        await workflows.capturePagePrompts('roleplay.swipe');
        await workflows.capturePagePrompts('story.passage');
        await workflows.capturePagePrompts('unknown.workflow');
        expect(types).toEqual([
            { chat: null, type: 'normal' }, { chat: null, type: 'swipe' },
            { chat: null, type: 'continue' }, { chat: null, type: 'quiet' },
        ]);
    } finally {
        delete globalThis.necoDiceRollerInterceptor;
    }
});

test('page text a control hands over resolves its macros or keeps the browser path', () => {
    expect(workflows.resolvePageText(' Rewrite {{user}}\'s reply. ')).toBe('Rewrite Alice\'s reply.');
    expect(workflows.resolvePageText('Roll {{roll:d6}}')).toBeNull();
});

test('native vector retrieval ignores page copies and services only an owned WebLLM descendant', async () => {
    interceptors.push({ name: 'vectors', key: 'vectors_rearrangeChat' });
    extensionSettings.vectors = { enabled_chats: true };
    extensionPrompts['3_vectors'] = { value: 'Stale browser retrieval.', position: 0, depth: 0, scan: true, role: 0 };
    extensionPrompts['4_vectors_data_bank'] = { value: 'Stale file retrieval.', position: 0, depth: 0, scan: true, role: 0 };
    expect(await workflows.capturePagePrompts('roleplay.reply')).toEqual([]);
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    expect(requests.find(entry => entry.url.endsWith('/workflow/submit')).body.intent).toEqual({});
    const child = { id: 'vector-child', parentId: 'reply-child', owner: 'alice', type: 'operations.vectors',
        state: 'waiting', resume: { browserId: 'local-work' } };
    listJobs.mockResolvedValueOnce([
        { id: 'reply-child', parentId: 'job-1', owner: 'alice', children: ['vector-child', 'foreign'] }, child,
        { ...child, id: 'foreign', owner: 'bob' },
    ]);
    await observers.get('job-1').onSnapshot({ id: 'job-1', state: 'waiting', children: ['reply-child'] });
    expect(serviceVectorBrowserWork).toHaveBeenCalledTimes(1);
    expect(serviceVectorBrowserWork).toHaveBeenCalledWith(child);
    await observers.get('job-1').onStop('done');
    await pending;
});

test('a refused submission never falls through to a browser generation', async () => {
    submitHandler = async () => response(409, { error: 'The anchored message changed.', code: 'roleplay_workflow_anchor' });
    const outcome = await workflows.runNativeRoleplayGeneration('regenerate');
    expect(outcome).toMatchObject({ native: true, state: 'refused', refused: true, key: null, jobId: null });
    expect(reloads).toEqual([]);
});

test('a stale settings proof is saved again and the same key is replayed', async () => {
    let attempts = 0;
    submitHandler = async (body) => {
        attempts += 1;
        if (attempts === 1) return response(409, { error: 'Save first.', code: 'roleplay_settings_ack_required' });
        return response(202, { key: body.key, jobId: 'job-2', created: true });
    };
    receiptHandler = () => response(200, { accepted: true, state: 'closed', jobId: 'job-2', result: { named: { index: 2, count: 3 } } });
    const pending = workflows.runNativeRoleplayGeneration('swipe');
    await settle();
    expect(saveSettings).toHaveBeenCalledTimes(2);
    const submits = requests.filter(entry => entry.url.endsWith('/workflow/submit'));
    expect(submits).toHaveLength(2);
    expect(submits[1].body.key).toBe(submits[0].body.key);
    expect(submits[1].body.acknowledgement.settingsRevision).toBe(6);
    await observers.get('job-2').onStop('done');
    expect((await pending).result).toEqual({ named: { index: 2, count: 3 } });
});

test('a settings save still queued in the page is finished before the workflow is submitted', async () => {
    settingsPending = true;
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    expect(saveSettings).toHaveBeenCalledTimes(1);
    const submits = requests.filter(entry => entry.url.endsWith('/workflow/submit'));
    expect(submits).toHaveLength(1);
    expect(submits[0].body.acknowledgement).toEqual({ account: 'alice', settingsRevision: 5 });
    await observers.get('job-1').onStop('done');
    expect((await pending).state).toBe('closed');
});

test('a group turn saves its settings proof after chat-save listeners finish', async () => {
    chatSaveHandler = async () => { settingsRevision += 1; };
    submitHandler = async body => body.acknowledgement.settingsRevision === settingsRevision
        ? response(202, { key: body.key, jobId: 'group-after-save', created: true })
        : response(409, { code: 'roleplay_settings_ack_required', error: 'Save first.' });
    const pending = workflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 'turn-1' }).catch(error => error);
    await settle();
    const submits = requests.filter(entry => entry.url.endsWith('/group/submit'));
    expect(submits).toHaveLength(1);
    expect(submits[0].body.acknowledgement.settingsRevision).toBe(settingsRevision);
    // The group turn carries the page capture too; with no loaded extension it is explicit empty text.
    expect(submits[0].body.bundledMacros).toEqual({ dialoguecolors: '' });
    await observers.get('group-after-save').onStop('done');
    expect(await pending).toMatchObject({ accepted: true, state: 'closed' });
});

test('a group turn refreshes a definitively refused proof using the same turn key', async () => {
    let attempts = 0;
    submitHandler = async body => ++attempts === 1
        ? response(409, { code: 'roleplay_settings_ack_required', error: 'Save first.' })
        : response(202, { key: body.key, jobId: 'group-refreshed', created: true });
    const pending = workflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 'turn-2' }).catch(error => error);
    await settle();
    const submits = requests.filter(entry => entry.url.endsWith('/group/submit'));
    expect(submits).toHaveLength(2);
    expect(submits[1].body).toEqual({ ...submits[0].body, acknowledgement: { account: 'alice', settingsRevision: 6 } });
    await observers.get('group-refreshed').onStop('done');
    expect(await pending).toMatchObject({ accepted: true, state: 'closed' });
});

test.each([
    [503, 'response_unknown'],
    [409, 'roleplay_workflow_anchor'],
])('a group turn does not repeat a %s %s outcome', async (status, code) => {
    submitHandler = async () => response(status, { code, error: 'Do not repeat this turn.' });
    await expect(workflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 'turn-3' }))
        .rejects.toThrow('Do not repeat this turn.');
    expect(requests.filter(entry => entry.url.endsWith('/group/submit'))).toHaveLength(1);
    expect(saveSettings).toHaveBeenCalledTimes(1);
});

test('a stopped group turn is not revived after a stale-proof refusal', async () => {
    const controller = new AbortController();
    submitHandler = async () => {
        controller.abort();
        return response(409, { code: 'roleplay_settings_ack_required', error: 'Save first.' });
    };
    await expect(workflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 'turn-4', signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
    expect(requests.filter(entry => entry.url.endsWith('/group/submit'))).toHaveLength(1);
    expect(saveSettings).toHaveBeenCalledTimes(1);
});

test('a settings save the page cannot finish yet is tried again before the workflow is submitted', async () => {
    saveSettings.mockImplementationOnce(async () => false);
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await waitFor(() => requests.some(entry => entry.url.endsWith('/workflow/submit')));
    expect(saveSettings).toHaveBeenCalledTimes(2);
    const submits = requests.filter(entry => entry.url.endsWith('/workflow/submit'));
    expect(submits).toHaveLength(1);
    await observers.get('job-1').onStop('done');
    expect((await pending).state).toBe('closed');
});

test('an accepted job the page never sees is read back from its receipt after a reopen', async () => {
    listJobs.mockResolvedValue([
        { id: 'other', type: 'conversation.reply', state: 'running' },
        { id: 'done', type: 'media.roleplay-workflow', state: 'completed',
            intent: { media: { operationKey: 'key-7' }, source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
                request: { named: { name: 'story.passage' } } } },
    ]);
    receiptHandler = () => response(200, { accepted: true, state: 'closed', jobId: 'done', result: { named: { cut: 8, length: 24 } } });
    await workflows.resumeNativeRoleplayWorkflowObservation();
    expect(reloads).toEqual([2]);
    expect(requests.filter(entry => entry.url.includes('/workflow/receipt'))[0].url).toContain('key=key-7');
    await Promise.all([workflows.resumeNativeRoleplayWorkflowObservation(), workflows.resumeNativeRoleplayWorkflowObservation()]);
    expect(reloads).toEqual([2]);
});

test('concurrent tab resumes adopt a completed reply once and leave later generation alone', async () => {
    listJobs.mockResolvedValue([{ id: 'done-resume', type: 'media.roleplay-workflow', state: 'completed',
        intent: { media: { operationKey: 'key-resume' }, source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
            request: { named: { name: 'roleplay.reply' } } } }]);
    receiptHandler = async () => {
        await settle();
        return response(200, { accepted: true, state: 'closed', jobId: 'done-resume', result: {} });
    };
    generating = true;
    await workflows.resumeNativeRoleplayWorkflowObservation();
    expect(reloads).toEqual([]);
    generating = false;
    await Promise.all([workflows.resumeNativeRoleplayWorkflowObservation(), workflows.resumeNativeRoleplayWorkflowObservation()]);
    expect(reloads).toEqual([2]);
});

test('an active completion joins a pending tab read without being suppressed as background work', async () => {
    const locator = { chat: 'roleplay', avatar: 'nova.png', group: false };
    listJobs.mockResolvedValue([{ id: 'joined', type: 'media.roleplay-workflow', state: 'completed',
        intent: { media: { operationKey: 'key-joined' }, source: { locator }, request: { named: { name: 'roleplay.reply' } } } }]);
    let release;
    receiptHandler = () => new Promise(resolve => { release = () => resolve(response(200, { accepted: true, state: 'closed', jobId: 'joined', result: {} })); });
    const passive = workflows.resumeNativeRoleplayWorkflowObservation();
    await waitFor(() => release);
    generating = true;
    workflows.observeRoleplayWorkflowJob('joined', { key: 'key-joined', name: 'roleplay.reply', locator, account });
    const active = observers.get('joined').onStop('done');
    release();
    await Promise.all([active, passive]);
    expect(reloads).toEqual([2]);
});

test('a busy native lane keeps the browser path unless the host already committed the change', async () => {
    const first = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    // Nothing destructive was skipped for a plain send, so the browser path stays
    // available for a second intent.
    expect(await workflows.runNativeRoleplayGeneration('swipe', { committed: false })).toBeNull();
    // A swipe the host kept undeleted must never fall back to a second paid call.
    expect(await workflows.runNativeRoleplayGeneration('swipe', { committed: true }))
        .toMatchObject({ state: 'refused', refused: true });
    await observers.get('job-1').onStop('done');
    await first;
});

test('opening another chat detaches the page without cancelling the running workflow', async () => {
    submitHandler = async body => response(202, { key: body.key, jobId: 'job-detached', created: true });
    const pending = workflows.runNativeRoleplayGeneration('normal', { committed: true });
    await waitFor(() => requests.some(entry => entry.url.endsWith('/workflow/submit')));
    currentChatId = 'another-chat';
    await eventSource.emit(event_types.CHAT_CHANGED, 'another-chat');
    await expect(pending).resolves.toMatchObject({ native: true, state: 'detached', detached: true });
    expect(cancelJob).not.toHaveBeenCalled();
    await observers.get('job-detached').onStop('done');
});

test('stopping the host generation cancels the accepted workflow instead of leaving it running', async () => {
    const controller = new AbortController();
    const pending = workflows.runNativeRoleplayGeneration('regenerate', { committed: true, signal: controller.signal });
    await settle();
    controller.abort();
    expect(cancelJob).toHaveBeenCalledWith('job-1', { reason: 'user_cancelled' });
    await observers.get('job-1').onStop('cancelled');
    await pending;
});

test('a call site the host will not serve keeps the browser path', async () => {
    nativeEligible = false;
    expect(await workflows.runNativeRoleplayGeneration('normal')).toBeNull();
    nativeEligible = true;
    accountStamp = null;
    expect(await workflows.runNativeRoleplayGeneration('normal')).toBeNull();
    expect(requests).toHaveLength(0);
});

test('chat-open discovery after idempotent init attaches to a running workflow, skips completed jobs and empty chats, and ignores own completion reloads', async () => {
    workflows.initNativeRoleplayWorkflows();
    workflows.initNativeRoleplayWorkflows();
    await settle();
    expect(listJobs).toHaveBeenCalledTimes(1);

    currentChatId = '';
    await eventSource.emit(event_types.CHAT_CHANGED);
    await settle();
    expect(listJobs).toHaveBeenCalledTimes(1);

    currentChatId = 'later-chat';
    listJobs.mockResolvedValueOnce([
        {
            id: 'running-on-open', type: 'media.roleplay-workflow', state: 'running',
            intent: {
                media: { operationKey: 'key-open-chat' },
                source: { locator: { chat: 'later-chat', avatar: 'nova.png', group: false }, message: { index: 1 } },
                request: { named: { name: 'roleplay.reply' } },
            },
        },
        {
            id: 'completed-on-open', type: 'media.roleplay-workflow', state: 'completed',
            intent: {
                media: { operationKey: 'key-already-completed' },
                source: { locator: { chat: 'later-chat', avatar: 'nova.png', group: false } },
                request: { named: { name: 'roleplay.reply' } },
            },
        },
    ]);
    await eventSource.emit(event_types.CHAT_CHANGED);
    await waitFor(() => observers.has('running-on-open'));
    expect(jobControls).toHaveBeenLastCalledWith('running-on-open', expect.any(Function), { background: false });
    // Companions run after the reply is shown, so their stage hands Stop to the Agents stop.
    previews.get('running-on-open').onStage('agents');
    expect(jobControls).toHaveBeenLastCalledWith('running-on-open', expect.any(Function), { background: false });
    previews.get('running-on-open').onStage('companions');
    expect(jobControls).toHaveBeenLastCalledWith('running-on-open', expect.any(Function), { background: true });
    previews.get('running-on-open').onStage('saving');
    expect(jobControls).toHaveBeenLastCalledWith('running-on-open', expect.any(Function), { background: false });
    jobControls.mock.calls.at(-1)[1]();
    expect(cancelJob).toHaveBeenCalledWith('running-on-open', { account: 'alice', reason: 'user_cancelled' });
    expect(listJobs).toHaveBeenCalledTimes(2);
    expect(requests.filter(entry => entry.url.includes('/workflow/receipt'))).toHaveLength(1);
    expect(reloads).toEqual([]);

    // The completion reload emits CHAT_CHANGED itself; discovery must not run redundantly during that reload.
    receiptHandler = () => response(200, { key: 'key-open-chat', accepted: true, state: 'closed', jobId: 'running-on-open', result: {} });
    reloadHandler = async () => {
        await eventSource.emit(event_types.CHAT_CHANGED);
    };
    await observers.get('running-on-open').onStop('done');
    expect(jobControls).toHaveBeenLastCalledWith(null, null, { background: false });
    expect(reloads).toEqual([2]);
    expect(listJobs).toHaveBeenCalledTimes(2);

    // An account change while listJobs is in flight stops discovery before attaching or reading back.
    listJobs.mockImplementationOnce(async () => {
        account = 'bob';
        return [{
            id: 'stale-account-job', type: 'media.roleplay-workflow', state: 'running',
            intent: {
                media: { operationKey: 'key-stale-account' },
                source: { locator: { chat: 'later-chat', avatar: 'nova.png', group: false } },
                request: { named: { name: 'roleplay.reply' } },
            },
        }];
    });
    await workflows.resumeNativeRoleplayWorkflowObservation();
    expect(observers.has('stale-account-job')).toBe(false);
});

test('a hanging receipt honours its abort signal on return and resolves the original generation without resubmitting', async () => {
    workflows.initNativeRoleplayWorkflows();
    await settle();
    listJobs.mockClear();

    let firstSignal = null;
    let receiptCalls = 0;
    receiptHandler = (_count, options) => {
        receiptCalls += 1;
        if (receiptCalls === 1) {
            firstSignal = options.signal;
            return new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
            });
        }
        return response(200, { key: 'k', accepted: true, state: 'closed', jobId: 'job-1', result: { named: { appended: true } } });
    };

    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    const donePromise = observers.get('job-1').onStop('done');
    await waitFor(() => firstSignal !== null);
    expect(firstSignal.aborted).toBe(false);
    expect(activations).toEqual(['busy']);

    // Passive chat-open or plain discovery does not abort an in-flight receipt read.
    await workflows.resumeNativeRoleplayWorkflowObservation();
    expect(firstSignal.aborted).toBe(false);
    expect(receiptCalls).toBe(1);

    // Returning to the page aborts only the hanging receipt connection and retries it.
    globalThis.document.dispatchEvent(new Event('visibilitychange'));
    await donePromise;
    const outcome = await pending;
    expect(firstSignal.aborted).toBe(true);
    expect(receiptCalls).toBe(2);
    expect(outcome).toMatchObject({ native: true, name: 'roleplay.reply', jobId: 'job-1', state: 'closed' });
    expect(requests.filter(entry => entry.url.endsWith('/workflow/submit'))).toHaveLength(1);
    expect(cancelJob).not.toHaveBeenCalled();
    expect(reloads).toEqual([2]);
    expect(activations).toEqual(['busy', 'idle']);
});

test('concurrent return events and late receipt responses reload the chat once', async () => {
    workflows.initNativeRoleplayWorkflows();
    await settle();
    listJobs.mockClear();

    let resolveLateFirst = null;
    let resolveSecond = null;
    const signals = [];
    receiptHandler = (_count, options) => {
        signals.push(options.signal);
        if (signals.length === 1) {
            // Simulates a socket whose promise resolves late even after abort.
            return new Promise(resolve => {
                resolveLateFirst = () => resolve(response(200, { key: 'k', accepted: true, state: 'closed', jobId: 'job-1', result: { named: { attempt: 1 } } }));
            });
        }
        return new Promise(resolve => {
            resolveSecond = () => resolve(response(200, { key: 'k', accepted: true, state: 'closed', jobId: 'job-1', result: { named: { attempt: 2 } } }));
        });
    };

    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    const donePromise = observers.get('job-1').onStop('done');
    await waitFor(() => signals.length === 1);

    // A non-persisted pageshow is ignored; persisted pageshow, visibilitychange and online coalesce into one reconnect.
    globalThis.dispatchEvent(new Event('pageshow'));
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    globalThis.document.dispatchEvent(new Event('visibilitychange'));
    globalThis.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    globalThis.dispatchEvent(new Event('online'));
    await waitFor(() => signals.length === 2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(listJobs).toHaveBeenCalledTimes(1);

    resolveLateFirst();
    resolveSecond();
    await donePromise;
    const outcome = await pending;
    expect(outcome.result).toEqual({ named: { attempt: 2 } });
    expect(reloads).toEqual([2]);
    expect(cancelJob).not.toHaveBeenCalled();
});

test('a failed saved reply read retries before completing and concurrent returns wait for its display', async () => {
    let release;
    reloadHandler = async () => {
        if (reloads.length === 1) throw new Error('The saved chat is not ready to display.');
        await new Promise(resolve => { release = resolve; });
    };
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    const done = observers.get('job-1').onStop('done');
    await waitFor(() => release);
    expect(activations).toEqual(['busy']);
    expect(previews.get('job-1').stop).not.toHaveBeenCalled();
    listJobs.mockResolvedValueOnce([{
        id: 'job-1', type: 'media.roleplay-workflow', state: 'completed',
        intent: { media: { operationKey: 'k' }, source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
            request: { named: { name: 'roleplay.reply' } } },
    }]);
    const resumed = workflows.resumeNativeRoleplayWorkflowObservation();
    await settle();
    expect(activations).toEqual(['busy']);
    release();
    await Promise.all([done, pending, resumed]);
    expect(reloads).toEqual([2, 2]);
    expect(activations).toEqual(['busy', 'idle']);
    expect(requests.filter(entry => entry.url.endsWith('/workflow/submit'))).toHaveLength(1);
});

test('returning aborts a suspended saved chat read and retries without resubmitting the reply', async () => {
    let signal;
    reloadHandler = async options => {
        if (reloads.length !== 1) return;
        signal = options.signal;
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    const done = observers.get('job-1').onStop('done');
    await waitFor(() => signal);
    await workflows.resumeNativeRoleplayWorkflowObservation({ reconnect: true });
    await done;
    expect((await pending).state).toBe('closed');
    expect(signal.aborted).toBe(true);
    expect(reloads).toEqual([2, 2]);
    expect(requests.filter(entry => entry.url.endsWith('/workflow/submit'))).toHaveLength(1);
    expect(cancelJob).not.toHaveBeenCalled();
});

test('explicit Stop still cancels the running workflow once after a return event', async () => {
    workflows.initNativeRoleplayWorkflows();
    await settle();
    const controller = new AbortController();
    const pending = workflows.runNativeRoleplayGeneration('normal', { signal: controller.signal });
    await settle();

    globalThis.dispatchEvent(new Event('online'));
    await settle();
    expect(cancelJob).not.toHaveBeenCalled();

    controller.abort();
    controller.abort();
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob).toHaveBeenCalledWith('job-1', { reason: 'user_cancelled' });
    await observers.get('job-1').onStop('cancelled');
    await pending;
});

test('passive readback respects pending saves and unrelated generation across reconnects', async () => {
    listJobs.mockResolvedValue([{
        id: 'done-save-guard', type: 'media.roleplay-workflow', state: 'completed',
        intent: {
            media: { operationKey: 'key-save-guard' },
            source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
            request: { named: { name: 'roleplay.reply' } },
        },
    }]);
    let calls = 0;
    receiptHandler = () => {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        return response(200, { key: 'key-save-guard', accepted: true, state: 'closed', jobId: 'done-save-guard', result: {} });
    };

    const initial = workflows.resumeNativeRoleplayWorkflowObservation();
    await waitFor(() => calls === 1);
    generating = true;
    await workflows.resumeNativeRoleplayWorkflowObservation({ reconnect: true });
    await initial;
    expect(calls).toBe(2);
    expect(reloads).toEqual([]);

    generating = false;
    await workflows.resumeNativeRoleplayWorkflowObservation();
    expect(reloads).toEqual([2]);

    jest.resetModules();
    chatSaving = true;
    const savingWorkflows = await import('../public/scripts/neconyan-conversation/roleplay-workflows.js');
    await savingWorkflows.resumeNativeRoleplayWorkflowObservation({ reconnect: true });
    expect(reloads).toEqual([2]);
});

function groupWrapperHarness({
    routing = { prefersServerReplies: () => false, requiresServerReply: async () => false },
    workflowModule = {},
    roleplayAccountStamp = () => ({ account: accountStamp }),
    browserPath = () => { throw new Error('browser path reached'); },
    overrides = {},
} = {}) {
    // rAF never resolves here, so a regression that awaits a frame before submit fails by timing out.
    const groupSource = fs.readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
    const ast = parse(groupSource, { ecmaVersion: 'latest', sourceType: 'module' });
    const node = ast.body.map(row => row.declaration ?? row).find(row => row.id?.name === 'generateGroupWrapper');
    const wrapperCode = groupSource.slice(node.start, node.end)
        .replace('await import(\'./browser-reply-routing.js\')', '__routingModule')
        .replace('await import(\'./neconyan-conversation/roleplay-workflows.js\')', '__workflowsModule')
        .replace('await import(\'./roleplay-save-chain.js\')', '__saveChainModule');
    const rAF = jest.fn(() => 0);
    const sendMessageAsUser = jest.fn(async () => {});
    const submitRoleplayGroupTurn = workflowModule.submitRoleplayGroupTurn
        ?? jest.fn(async () => ({ accepted: true, state: 'closed' }));
    const workflows = {
        capturePagePrompts: jest.fn(async () => []),
        groupPagePromptsBlocked: jest.fn(async () => false),
        ...workflowModule,
        submitRoleplayGroupTurn,
    };
    const textarea = { dispatchEvent: jest.fn() };
    const runtime = vm.createContext({
        AbortSignal, Event, Promise, Map, Error, Date, console,
        requestAnimationFrame: rAF,
        online_status: 'connected',
        is_group_generating: false,
        menu_type: 'group_edit',
        selected_group: 'group-1',
        groups: [{ id: 'group-1', members: ['nova.png'], activation_strategy: 0 }],
        characters: [{ name: 'Nova', avatar: 'nova.png' }],
        chat: [{ name: 'User', is_user: true, mes: 'Hi' }],
        chat_metadata: {},
        group_generation_id: 0,
        group_activation_strategy: { NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3 },
        system_message_types: { EMPTY: 'empty', GENERIC: 'generic' },
        power_user: { show_group_chat_queue: false },
        hideSwipeButtons: () => {},
        showSwipeButtons: () => {},
        setSendButtonState: () => {},
        setCharacterName: () => {},
        setCharacterId: () => {},
        getGroupEnabledMembers: () => ['nova.png'],
        getSelectedGroupSpeakerChid: () => 0,
        findDirectlyAddressedMember: () => -1,
        isAddressedToEntireGroup: () => false,
        limitGroupSpeakersForControl: members => members,
        getBiasStrings: () => ({ messageBias: '' }),
        sendMessageAsUser,
        getCurrentChatId: () => 'roleplay',
        deactivateSendButtons: () => {},
        activateSendButtons: () => {},
        setGroupTypingIndicator: () => {},
        usesGroupSceneVisibility: () => false, getGroupMemberRole: () => 'character',
        beginGroupTurnAudience: () => () => {}, getGroupMessageAudience: () => null,
        activeGroupTalkBurst: null,
        clearSelectedGroupSpeaker: () => {},
        event_types: { GROUP_WRAPPER_STARTED: 'group_wrapper_started' },
        eventSource: { emit: async () => {} },
        $: () => ({ 0: textarea, val: () => ({ 0: textarea, toString: () => 'Hello group' }) }),
        unshallowGroupMembers: browserPath,
        __routingModule: routing,
        __workflowsModule: workflows,
        __saveChainModule: { roleplayAccountStamp },
        ...overrides,
    });
    vm.runInContext(wrapperCode, runtime);
    return { runtime, rAF, sendMessageAsUser, submitRoleplayGroupTurn, workflows, routing };
}

test('group send submits without awaiting requestAnimationFrame in a hidden tab', async () => {
    const { runtime, rAF, sendMessageAsUser, submitRoleplayGroupTurn } = groupWrapperHarness();
    const result = await runtime.generateGroupWrapper(false, 'normal', { skipNativeRoleplay: false });
    expect(rAF).not.toHaveBeenCalled();
    expect(sendMessageAsUser).toHaveBeenCalledTimes(1);
    expect(submitRoleplayGroupTurn).toHaveBeenCalledWith(expect.objectContaining({
        groupId: 'group-1',
        forcedAvatars: ['nova.png'],
    }));
    expect(result).toEqual({ accepted: true, state: 'closed' });
});

test('an explicit group background request keeps its server path without a page capture', async () => {
    const groupPagePromptsBlocked = jest.fn(async () => true);
    const { runtime, submitRoleplayGroupTurn } = groupWrapperHarness({ workflowModule: { groupPagePromptsBlocked } });
    await runtime.generateGroupWrapper(false, 'normal', { skipNativeRoleplay: false });
    expect(groupPagePromptsBlocked).not.toHaveBeenCalled();
    expect(submitRoleplayGroupTurn).toHaveBeenCalledTimes(1);
});

test('server preference sends a supported group turn to the server without probing Notebook context', async () => {
    const routing = { prefersServerReplies: () => true, requiresServerReply: jest.fn(async () => false) };
    const { runtime, sendMessageAsUser, submitRoleplayGroupTurn, workflows } = groupWrapperHarness({ routing });
    const result = await runtime.generateGroupWrapper(false, 'normal', {});
    expect(workflows.groupPagePromptsBlocked).toHaveBeenCalledTimes(1);
    expect(submitRoleplayGroupTurn).toHaveBeenCalledWith(expect.objectContaining({
        groupId: 'group-1',
        forcedAvatars: ['nova.png'],
    }));
    expect(routing.requiresServerReply).not.toHaveBeenCalled();
    expect(sendMessageAsUser).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ accepted: true, state: 'closed' });
});

test('server preference keeps a group turn in the browser when a page instruction cannot travel', async () => {
    const routing = { prefersServerReplies: () => true, requiresServerReply: jest.fn(async () => false) };
    const { runtime, sendMessageAsUser, submitRoleplayGroupTurn } = groupWrapperHarness({
        routing,
        workflowModule: { groupPagePromptsBlocked: jest.fn(async () => true) },
    });
    await expect(runtime.generateGroupWrapper(false, 'normal', {})).rejects.toThrow('browser path reached');
    expect(submitRoleplayGroupTurn).not.toHaveBeenCalled();
    expect(routing.requiresServerReply).toHaveBeenCalledTimes(1);
    expect(sendMessageAsUser).toHaveBeenCalledTimes(1);
});

test('a missing account stamp keeps a server-preferred group turn in the browser when no Notebook context requires the server', async () => {
    const routing = { prefersServerReplies: () => true, requiresServerReply: jest.fn(async () => false) };
    const { runtime, sendMessageAsUser, submitRoleplayGroupTurn, workflows } = groupWrapperHarness({
        routing,
        roleplayAccountStamp: () => { throw new Error('ROLEPLAY_ACCOUNT_CHANGED'); },
    });
    await expect(runtime.generateGroupWrapper(false, 'normal', {})).rejects.toThrow('browser path reached');
    expect(sendMessageAsUser).toHaveBeenCalledTimes(1);
    expect(submitRoleplayGroupTurn).not.toHaveBeenCalled();
    expect(workflows.groupPagePromptsBlocked).not.toHaveBeenCalled();
    expect(routing.requiresServerReply).toHaveBeenCalledTimes(1);
});

test('a missing account stamp fails closed when Notebook context requires the server', async () => {
    const routing = { prefersServerReplies: () => true, requiresServerReply: jest.fn(async () => true) };
    const { runtime, sendMessageAsUser, submitRoleplayGroupTurn, workflows } = groupWrapperHarness({
        routing,
        roleplayAccountStamp: () => { throw new Error('ROLEPLAY_ACCOUNT_CHANGED'); },
    });
    await expect(runtime.generateGroupWrapper(false, 'normal', {}))
        .rejects.toThrow('The selected Notebook context needs a server reply. Please reload and try again.');
    expect(sendMessageAsUser).toHaveBeenCalledTimes(1);
    expect(submitRoleplayGroupTurn).not.toHaveBeenCalled();
    expect(workflows.groupPagePromptsBlocked).not.toHaveBeenCalled();
    expect(routing.requiresServerReply).toHaveBeenCalledTimes(1);
});

test('a required Notebook context fails closed when group page instructions cannot travel', async () => {
    const routing = { prefersServerReplies: () => false, requiresServerReply: jest.fn(async () => true) };
    const { runtime, submitRoleplayGroupTurn } = groupWrapperHarness({
        routing,
        workflowModule: { groupPagePromptsBlocked: jest.fn(async () => true) },
    });
    await expect(runtime.generateGroupWrapper(false, 'normal', {}))
        .rejects.toThrow('Notebook context cannot be combined with these page prompts');
    expect(submitRoleplayGroupTurn).not.toHaveBeenCalled();
});

test.each([
    ['group-1', true],
    ['another-group', false],
    [null, false],
])('a completed group reply reloads only its selected group (%s), even with a speaker avatar', async (selectedGroup, shouldReload) => {
    jest.resetModules();
    jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: selectedGroup }));
    const groupWorkflows = await import('../public/scripts/neconyan-conversation/roleplay-workflows.js');
    // The avatar mock remains Nova, just as group sending temporarily selects its speaker.
    const pending = groupWorkflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 'readback-turn' });
    await settle();
    expect(requests.find(entry => entry.url.endsWith('/group/submit')).body.source.locator)
        .toEqual({ chat: 'roleplay', group: true, groupId: 'group-1' });
    await observers.get('job-1').onStop('done');
    expect(await pending).toMatchObject({ accepted: true, state: 'closed' });
    expect(reloads).toEqual(shouldReload ? [2] : []);
});

test.each([
    ['group-1', true],
    ['another-group', false],
    [null, false],
])('group workflow discovery matches chat and groupId (%s) on chat switch and return', async (selectedGroup, shouldMatch) => {
    jest.resetModules();
    jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: selectedGroup }));
    const groupWorkflows = await import('../public/scripts/neconyan-conversation/roleplay-workflows.js');

    const groupJobs = [
        {
            id: 'group-running', type: 'media.roleplay-workflow', state: 'running',
            intent: {
                media: { operationKey: 'key-group-running' },
                source: { locator: { chat: 'roleplay', avatar: '', group: true }, groupId: 'group-1' },
                request: {},
            },
        },
        {
            id: 'group-done', type: 'media.roleplay-workflow', state: 'completed',
            intent: {
                media: { operationKey: 'key-group-done' },
                source: { locator: { chat: 'roleplay', avatar: '', group: true }, groupId: 'group-1' },
                request: {},
            },
        },
    ];
    listJobs.mockResolvedValue(groupJobs);
    receiptHandler = () => response(200, { key: 'key-group-done', accepted: true, state: 'closed', jobId: 'group-done', result: { status: 'completed' } });

    // Chat switch attaches only to the running group job and skips finished-job readback.
    await groupWorkflows.resumeNativeRoleplayWorkflowObservation({ attachOnly: true });
    expect(observers.has('group-running')).toBe(shouldMatch);
    // One capability probe accompanies a new attachment; it never reads back a result.
    expect(requests.filter(entry => entry.url.includes('/workflow/receipt'))).toHaveLength(shouldMatch ? 1 : 0);
    expect(reloads).toEqual([]);

    // Visible/return discovery reads back the finished group job for the matching group.
    await groupWorkflows.resumeNativeRoleplayWorkflowObservation({ reconnect: true });
    expect(reloads).toEqual(shouldMatch ? [2] : []);
});

test('reconnect discovery settles an already-observed workflow whose job finished while hidden', async () => {
    workflows.initNativeRoleplayWorkflows();
    await settle();
    listJobs.mockClear();

    const pending = workflows.runNativeRoleplayGeneration('normal');
    await settle();
    expect(observers.has('job-1')).toBe(true);
    expect(activations).toEqual(['busy']);

    listJobs.mockResolvedValueOnce([{
        id: 'job-1', type: 'media.roleplay-workflow', state: 'completed',
        intent: {
            media: { operationKey: 'k' },
            source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false } },
            request: { named: { name: 'roleplay.reply' } },
        },
    }]);
    receiptHandler = () => response(200, { key: 'k', accepted: true, state: 'closed', jobId: 'job-1', result: { named: { appended: true } } });

    await workflows.resumeNativeRoleplayWorkflowObservation({ reconnect: true });
    const outcome = await pending;
    expect(outcome).toMatchObject({ native: true, name: 'roleplay.reply', jobId: 'job-1', state: 'closed' });
    expect(reloads).toEqual([2]);
    expect(activations).toEqual(['busy', 'idle']);
});

test('returning replaces a suspended discovery request even when it ignores cancellation', async () => {
    let signal;
    let releaseStale;
    listJobs.mockImplementationOnce(options => {
        signal = options.signal;
        return new Promise(resolve => { releaseStale = resolve; });
    }).mockResolvedValueOnce([]);
    const first = workflows.resumeNativeRoleplayWorkflowObservation();
    await waitFor(() => releaseStale);
    const resumed = workflows.resumeNativeRoleplayWorkflowObservation({ reconnect: true });
    await Promise.all([first, resumed]);
    expect(signal.aborted).toBe(true);
    expect(listJobs).toHaveBeenCalledTimes(2);
    releaseStale([{ id: 'stale', type: 'media.roleplay-workflow', state: 'running' }]);
    await settle();
    expect(observers.has('stale')).toBe(false);
});

// An image refusal raises one event, which prompt-media-ui.js turns into the one actionable notice; the generic toast is not shown too.
describe('an image refusal on the solo and group routes', () => {
    const refusalEvents = () => globalThis.dispatchEvent.mock.calls.map(([event]) => event).filter(event => event.type === 'neconyan:image-input-refused');
    // Where each refusal came from: the chat the request or job was for and the account it ran under (never the chat open when it arrives).
    const soloOrigin = { workspace: 'roleplay', account: 'alice', locator: { group: false, chat: 'roleplay', avatar: 'nova.png' } };
    const groupOrigin = { workspace: 'roleplay', account: 'alice', locator: { group: true, chat: 'roleplay' } };
    // A refusal at submission is a saved image the server cannot read (world-info.js adds the issue to an error of any code).
    // GEN-S01 is not one of these: it is raised inside the reply job, which keeps only its message, code and status (see the job test below).
    const issue = { reason: 'unsupported-image', index: 1, mediaIndex: 0, actions: ['review', 'display-only', 'caption', 'replace'] };
    const words = 'The saved Roleplay image location is invalid.';
    const connectionWords = 'This chat\'s connection cannot receive images. Set them to Show only or Use a description, or switch to a connection that accepts images.';
    beforeEach(() => { globalThis.dispatchEvent.mockClear(); });

    test('a solo refusal with an imageIssue dispatches once, with the message, and shows no generic toast', async () => {
        submitHandler = async () => response(409, { error: words, code: 'ROLEPLAY_INVALID', imageIssue: issue });
        expect(await workflows.runNativeRoleplayGeneration('normal')).toMatchObject({ native: true, state: 'refused', refused: true });
        expect(refusalEvents()).toHaveLength(1);
        expect(refusalEvents()[0].detail).toEqual({ ...issue, message: words, origin: soloOrigin });
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });

    test('a solo refusal with the code alone is an image issue too', async () => {
        submitHandler = async () => response(409, { error: 'An image description changed while the reply was starting. Try again.', code: 'ROLEPLAY_IMAGE_INPUT' });
        await workflows.runNativeRoleplayGeneration('normal');
        expect(refusalEvents().map(event => event.detail)).toEqual([{ message: 'An image description changed while the reply was starting. Try again.', origin: soloOrigin }]);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });

    test('any other solo refusal keeps its generic toast and raises no image event', async () => {
        for (const body of [{ error: 'Refused' }, { error: 'Busy', code: 'ROLEPLAY_INVALID' }, { error: 'Odd', imageIssue: null, code: null }]) {
            globalThis.toastr.error.mockClear();
            submitHandler = async () => response(400, body);
            expect(await workflows.runNativeRoleplayGeneration('normal')).toMatchObject({ state: 'refused', refused: true });
            expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
            expect(globalThis.toastr.error).toHaveBeenCalledWith(body.error, 'Nothing was generated');
        }
        expect(refusalEvents()).toHaveLength(0);
        // A refusal that sends no JSON at all still says something.
        globalThis.toastr.error.mockClear();
        submitHandler = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
        await workflows.runNativeRoleplayGeneration('normal');
        expect(globalThis.toastr.error).toHaveBeenCalledWith(expect.stringContaining('refused (502)'), 'Nothing was generated');
        expect(refusalEvents()).toHaveLength(0);
    });

    test('a group turn refused for an image dispatches once through the same function, and the error still carries the reply for the caller', async () => {
        submitHandler = async () => response(409, { error: words, code: 'ROLEPLAY_INVALID', imageIssue: issue });
        const failure = await workflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 1 }).catch(error => error);
        expect(failure).toBeInstanceOf(Error);
        expect(failure.message).toBe(words);
        expect(failure.body.imageIssue).toEqual(issue);
        expect(refusalEvents()).toHaveLength(1);
        expect(refusalEvents()[0].detail).toEqual({ ...issue, message: words, origin: groupOrigin });
        expect(requests.at(-1).url.endsWith('/group/submit')).toBe(true);
    });

    test('a group turn refused for any other reason raises no image event', async () => {
        submitHandler = async () => response(400, { error: 'Refused' });
        const failure = await workflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 1 }).catch(error => error);
        expect(failure.message).toBe('Refused');
        expect(refusalEvents()).toHaveLength(0);
    });

    test('a reply job that fails for an image raises the one event instead of the Reply failed toast; other failures keep it', async () => {
        const pending = workflows.runNativeRoleplayGeneration('normal');
        await settle();
        await observers.get('job-1').onSnapshot({ state: 'failed', error: { message: 'An image description changed while the reply was starting. Try again.', code: 'ROLEPLAY_IMAGE_INPUT', status: 409 } });
        await pending;
        expect(refusalEvents().map(event => event.detail)).toEqual([{ message: 'An image description changed while the reply was starting. Try again.', origin: soloOrigin }]);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        observers.clear();
        const second = workflows.runNativeRoleplayGeneration('normal');
        await settle();
        await observers.get('job-1').onSnapshot({ state: 'failed', error: { message: 'The connection to your model provider closed.', code: 'JOB_FAILED', status: 500 } });
        await second;
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error).toHaveBeenCalledWith('The connection to your model provider closed.', 'Reply failed');
        expect(refusalEvents()).toHaveLength(1);
    });

    // GEN-S01 fails inside the reply job. The job keeps { message, code, status }; tests/roleplay-world-info.node.js asserts that this
    // exact shape is what the runner stores for it (code ROLEPLAY_IMAGE_INPUT), and for an ordinary invalid reply (code ROLEPLAY_INVALID).
    test('a reply job that fails with GEN-S01 raises the notice with its reason, and another ROLEPLAY_INVALID failure still shows Reply failed', async () => {
        const pending = workflows.runNativeRoleplayGeneration('normal');
        await settle();
        await observers.get('job-1').onSnapshot({ state: 'failed', error: { message: connectionWords, code: 'ROLEPLAY_IMAGE_INPUT', status: 409 } });
        await pending;
        expect(refusalEvents().map(event => event.detail)).toEqual([{ message: connectionWords, origin: soloOrigin }]);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
        observers.clear();
        const second = workflows.runNativeRoleplayGeneration('normal');
        await settle();
        await observers.get('job-1').onSnapshot({ state: 'failed', error: { message: 'The saved image detail setting is invalid.', code: 'ROLEPLAY_INVALID', status: 409 } });
        await second;
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error).toHaveBeenCalledWith('The saved image detail setting is invalid.', 'Reply failed');
        expect(refusalEvents()).toHaveLength(1);
    });

    test('saved-data errors read as plain advice with a title for what happened, and the original wording goes to the console', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const cases = [
            [{ state: 'failed', error: { message: 'Protected Roleplay evidence has no room for another transaction.', code: 'ROLEPLAY_STORE_FULL', status: 413 } },
                'Neconyan has no room left to record new replies for this account, so this reply was not started. Your chat was not changed.', 'Reply failed'],
            [{ state: 'conflict', error: { message: 'An earlier Roleplay transaction must be reconciled first.', code: 'ROLEPLAY_RECOVERY_REQUIRED', status: 409 } },
                'Neconyan was still finishing an earlier save, so this reply was not saved. Wait a moment, then try again. If it keeps happening, reload the page.', 'Reply not saved'],
            [{ state: 'failed', error: { message: 'A protected Roleplay resource changed.', code: 'ROLEPLAY_SOURCE_CHANGED', status: 409 } },
                'The chat changed while the reply was being written, so the reply was not saved. Try again.', 'Reply failed'],
            [{ state: 'interrupted', error: { message: 'The candidate is not owned by this accepted workflow.', code: 'SOMETHING_NEW', status: 409 } },
                'The reply could not be finished, and nothing in your chat was changed. Try again.', 'Reply interrupted'],
            // Plain server wording is kept as it is.
            [{ state: 'failed', error: { message: 'The chat has moved on since this reply was requested, so the reply was not saved.', code: 'ROLEPLAY_SOURCE_CHANGED', status: 409 } },
                'The chat has moved on since this reply was requested, so the reply was not saved.', 'Reply failed'],
        ];
        for (const [snapshot, message, title] of cases) {
            globalThis.toastr.error.mockClear();
            observers.clear();
            const pending = workflows.runNativeRoleplayGeneration('normal');
            await settle();
            await observers.get('job-1').onSnapshot(snapshot);
            await pending;
            expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
            expect(globalThis.toastr.error).toHaveBeenCalledWith(message, title);
        }
        expect(warn).toHaveBeenCalledWith('[Roleplay] Reply ended:', { state: 'failed', code: 'ROLEPLAY_STORE_FULL', message: 'Protected Roleplay evidence has no room for another transaction.' });
        // A refused request uses the same wording.
        globalThis.toastr.error.mockClear();
        submitHandler = async () => response(413, { error: 'Protected Roleplay evidence is full.', code: 'ROLEPLAY_STORE_FULL' });
        await workflows.runNativeRoleplayGeneration('normal');
        expect(globalThis.toastr.error).toHaveBeenCalledWith(expect.stringContaining('no room left to record new replies'), 'Nothing was generated');
        warn.mockRestore();
    });
});

// The notice opens the review for the chat that was refused, so every refusal carries the chat of its own request or job, never the chat that is
// open when the refusal arrives. Each test moves the open chat after the request started (a slow send, a job still running, a job found on load).
describe('the origin an image refusal carries', () => {
    const refusalEvents = () => globalThis.dispatchEvent.mock.calls.map(([event]) => event).filter(event => event.type === 'neconyan:image-input-refused');
    const words = 'The saved Roleplay image location is invalid.';
    const imageFailure = { message: words, code: 'ROLEPLAY_IMAGE_INPUT', status: 409 };
    const soloOrigin = { workspace: 'roleplay', account: 'alice', locator: { group: false, chat: 'roleplay', avatar: 'nova.png' } };
    const openAnotherChat = () => { currentChatId = 'another-chat'; currentAvatar = 'other.png'; };
    beforeEach(() => { globalThis.dispatchEvent.mockClear(); });

    test('a solo refusal at submission carries the chat the request was made for, not the chat open when the answer arrives', async () => {
        submitHandler = async () => { openAnotherChat(); return response(409, { error: words, code: 'ROLEPLAY_IMAGE_INPUT' }); };
        await workflows.runNativeRoleplayGeneration('normal');
        expect(requests.at(-1).body.source.locator).toEqual({ chat: 'roleplay', avatar: 'nova.png', group: false });
        expect(refusalEvents().map(event => event.detail)).toEqual([{ message: words, origin: soloOrigin }]);
    });

    test('a group refusal at submission carries the group chat, with the locator the review takes and no group id', async () => {
        submitHandler = async () => { openAnotherChat(); return response(409, { error: words, code: 'ROLEPLAY_IMAGE_INPUT' }); };
        await workflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 1 }).catch(() => {});
        expect(requests.at(-1).body.source.locator).toEqual({ chat: 'roleplay', group: true, groupId: 'group-1' });
        expect(refusalEvents().map(event => event.detail.origin)).toEqual([{ workspace: 'roleplay', account: 'alice', locator: { group: true, chat: 'roleplay' } }]);
    });

    test('a reply job that fails for an image after the person moved to another chat carries the chat it was for', async () => {
        const pending = workflows.runNativeRoleplayGeneration('normal');
        await settle();
        openAnotherChat();
        await observers.get('job-1').onSnapshot({ state: 'failed', error: imageFailure });
        await pending;
        expect(refusalEvents().map(event => event.detail)).toEqual([{ message: words, origin: soloOrigin }]);
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });

    test('a group job that fails for an image carries its group chat', async () => {
        const pending = workflows.submitRoleplayGroupTurn({ groupId: 'group-1', forcedAvatars: ['nova.png'], generationId: 2 }).catch(error => error);
        await settle();
        openAnotherChat();
        await observers.get('job-1').onSnapshot({ state: 'failed', error: imageFailure });
        await pending;
        expect(refusalEvents().map(event => event.detail.origin)).toEqual([{ workspace: 'roleplay', account: 'alice', locator: { group: true, chat: 'roleplay' } }]);
    });

    test('a job found when the page loaded carries the chat its record names', async () => {
        listJobs.mockResolvedValueOnce([{
            id: 'found-on-load', type: 'media.roleplay-workflow', state: 'running',
            intent: { media: { operationKey: 'key-found' }, source: { locator: { chat: 'roleplay', avatar: 'nova.png', group: false }, message: { index: 1 } },
                request: { named: { name: 'roleplay.reply' } } },
        }]);
        await workflows.resumeNativeRoleplayWorkflowObservation();
        expect(observers.has('found-on-load')).toBe(true);
        openAnotherChat();
        await observers.get('found-on-load').onSnapshot({ state: 'failed', error: imageFailure });
        expect(refusalEvents().map(event => event.detail)).toEqual([{ message: words, origin: soloOrigin }]);
    });

    test('the account in the origin is the one the request ran under', async () => {
        submitHandler = async () => response(409, { error: words, code: 'ROLEPLAY_IMAGE_INPUT' });
        await workflows.runNativeRoleplayGeneration('normal');
        expect(refusalEvents()[0].detail.origin.account).toBe('alice');
    });
});

describe('a manual Agent action the server cannot hold', () => {
    const run = () => workflows.runRoleplayAgentAction({ mode: 'companions', agentIds: ['a', 'b', 'c', 'd', 'e'], messageIndex: 1 });
    const agentSubmissions = () => requests.filter(request => request.url.endsWith('/agent/submit'));

    test('too many Companions for one server run go back to the page instead of failing', async () => {
        submitHandler = async () => response(507, { error: 'The selected Companions cannot fit their saved results within this account workflow.', code: 'ROLEPLAY_COMPANION_CAPACITY' });
        await expect(run()).resolves.toBeNull();
        expect(agentSubmissions()).toHaveLength(1);
        expect(agentSubmissions()[0].body).toMatchObject({ mode: 'companions', agentIds: ['a', 'b', 'c', 'd', 'e'], messageIndex: 1 });
    });

    test('any other server failure is still reported, because the run may already have started there', async () => {
        for (const [status, body] of [[507, { error: 'Storage is full.', code: 'ROLEPLAY_STORAGE_FULL' }], [500, { error: 'Broken' }], [503, { error: 'Busy' }]]) {
            submitHandler = async () => response(status, body);
            await expect(run()).rejects.toThrow(body.error);
        }
    });
});
