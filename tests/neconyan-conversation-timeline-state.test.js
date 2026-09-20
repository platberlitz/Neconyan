/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'tester' }));

let currentAvatar = 'char.png';
let currentPersonaId = 'persona-a.png';
const stores = new Map();
const extractCharacterReplyCommands = jest.fn(rawText => ({ text: String(rawText || '').trim(), selfieRequests: [] }));
const generateConversationRaw = jest.fn();
const captureConversationTextBinding = jest.fn(async () => ({}));
const buildConversationPromptMessages = jest.fn(async () => []);
const saveConversationThread = jest.fn();
const commitCharacterReplyCommands = jest.fn();

function storeKey(personaId, avatar, groupId = '') {
    return [personaId, avatar, groupId].join('|');
}

function getStore(avatar, groupId, personaId) {
    return stores.get(storeKey(personaId, avatar, groupId)) || null;
}

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ avatar: 'char.png', name: 'Aster' }],
    default_user_avatar: 'default.png',
    getThumbnailUrl: () => '',
    messageFormatting: value => value,
    name1: 'User',
}));
await jest.unstable_mockModule('../public/scripts/utils.js', () => ({ timestampToMoment: () => ({ isValid: () => false }) }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'persona-a.png' }));
await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({ world_names: [] }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    createConversationBranch: (name, id = 'new-branch') => ({ id, name, messages: [] }),
    getActiveConversationBranch: (avatar, options = {}) => {
        const store = getStore(avatar, options.groupId || '', options.personaId || currentPersonaId);
        return store?.branches?.[options.branchId || store.activeBranchId] || null;
    },
    getConversationBranches: avatar => Object.values(getStore(avatar, '', currentPersonaId)?.branches || {}),
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? currentPersonaId : value || ''),
    getConversationThreadStore: (avatar, options = {}) => getStore(avatar, options.groupId || '', options.personaId || currentPersonaId),
    getCurrentCharAvatar: () => currentAvatar,
    getCurrentCharName: () => 'Aster',
    persistConversationStore: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/generation.js', () => ({
    captureConversationTextBinding,
    commitCharacterReplyCommands,
    extractCharacterReplyCommands,
    generateConversationRaw,
    generateSelfieFromContext: jest.fn(),
    getCharacterReplyCommandMetadata: parts => parts?.selfieRequests?.length ? { selfieRequests: parts.selfieRequests } : null,
    normalizeConversationOutputText: value => String(value || '').trim(),
    reportConversationGenerationError: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/media.js', () => ({
    getCharacterForAvatar: avatar => ({ avatar, name: 'Aster' }),
    getConversationParticipants: () => [],
    getEffectiveConversationStatus: () => 'online',
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/pals-rail.js', () => ({
    getConversationMessageAvatar: () => '',
    getConversationMessageReceipt: () => '',
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/partners.js', () => ({
    escapeRegExp: value => value,
    getCharacterMentionHandles: () => [],
    parseAvatarList: () => [],
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({ getConnectionProfiles: () => [] }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/prompt.js', () => ({
    buildConversationPromptMessages,
    buildConversationSystemPrompt: () => '',
    renderConversationAttachments: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-scheduler.js', () => ({
    registerConversationRenderer: jest.fn(),
    scheduleInterfaceRefresh: jest.fn(),
    schedulePalsRailRender: jest.fn(),
    scheduleTimelineRender: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-utils.js', () => ({
    escapeHtmlAttribute: value => value,
    escapeHtmlText: value => value,
    getConversationMessageExtraFingerprint: () => '',
    hashConversationRenderFingerprint: value => value,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/schedule.js', () => ({ getConversationReplyMaxTokens: () => 100 }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({ getSettings: () => ({}) }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({
    assertConversationAccount: () => {},
    captureConversationStore: jest.fn(),
    flushConversationStore: jest.fn(async () => true),
    getConversationSavedSnapshot: jest.fn(() => null),
    getConversationSavedVersion: jest.fn(() => 0),
    getConversationSyncState: jest.fn(() => ({})),
    initConversationStoreSync: jest.fn(),
    persistConversationStoreDebounced: jest.fn(),
    persistConversationStoreNow: jest.fn(async () => true),
    refreshConversationStore: jest.fn(async () => null),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/timeline-search.js', () => ({ getConversationTimelineMessages: messages => messages }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/timeline-slash-commands.js', () => ({
    appendConversationOocNote: jest.fn(),
    handleConversationSlashAction: jest.fn(),
    parseConversationReminderArgs: jest.fn(),
    parseConversationSlashCommand: jest.fn(),
    quickConversationSummarize: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/tts.js', () => ({ narrateConversationMessage: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store.js', () => ({
    addConversationReminder: jest.fn(),
    buildConversationMessageReplyReference: message => ({
        messageId: message.id,
        name: message.name,
        role: message.role,
        text: message.mes,
    }),
    getConversationAttachmentSummary: () => '',
    getConversationMessagePreviewText: message => message?.mes || '',
    getConversationSeenAt: () => 0,
    getConversationThread: (avatar, options = {}) => {
        const store = getStore(avatar, options.groupId || '', options.personaId || currentPersonaId);
        return store?.branches?.[options.branchId || store.activeBranchId]?.messages || [];
    },
    saveConversationThread,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/typing.js', () => ({
    getActiveTypingParticipants: () => [],
    getPrimaryTypingParticipant: () => null,
    updateLastPreviewFromConversation: jest.fn(),
    withTypingParticipant: (_participant, task) => task(),
}));

const stateModule = await import('../public/scripts/neconyan-conversation/state.js');
const {
    getActiveConversationReplyTarget,
    regenerateConversationMessage,
    renderConversationTimeline,
} = await import('../public/scripts/neconyan-conversation/timeline-render.js');

function makeMessage(id, mes = `message ${id}`) {
    return {
        id,
        role: 'character',
        name: 'Aster',
        mes,
        created_at: 1,
        extra: {},
    };
}

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('conversation timeline operation identity', () => {
    beforeEach(() => {
        currentAvatar = 'char.png';
        currentPersonaId = 'persona-a.png';
        stores.clear();
        stores.set(storeKey('persona-a.png', 'char.png'), {
            activeBranchId: 'branch-a',
            branches: {
                'branch-a': { id: 'branch-a', messages: [makeMessage('message-1'), makeMessage('message-2')] },
                'branch-b': { id: 'branch-b', messages: [makeMessage('branch-b-message')] },
            },
        });
        stores.set(storeKey('persona-b.png', 'char.png'), {
            activeBranchId: 'branch-b',
            branches: { 'branch-b': { id: 'branch-b', messages: [makeMessage('persona-b-message')] } },
        });
        generateConversationRaw.mockReset();
        captureConversationTextBinding.mockReset().mockResolvedValue({});
        buildConversationPromptMessages.mockClear();
        extractCharacterReplyCommands.mockReset().mockImplementation(rawText => ({ text: String(rawText || '').trim(), selfieRequests: [] }));
        saveConversationThread.mockClear();
        commitCharacterReplyCommands.mockClear();
        stateModule.regenerationBusyKeys.clear();
        stateModule.activeConversationGenerationOperations.clear();
        stateModule.activeConversationReplyOperations.clear();
        stateModule.conversationState.externalGenerationActive = false;
        stateModule.conversationState.conversationReplyBusy = false;
        stateModule.conversationState.generationActive = false;
        stateModule.conversationState.conversationReplyTarget = null;
        globalThis.toastr = { success: jest.fn(), warning: jest.fn() };
    });

    test('isolates and clears reply targets when persona or branch changes', () => {
        stateModule.conversationState.conversationReplyTarget = {
            avatar: 'char.png',
            branchId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
            messageId: 'message-1',
            text: 'message 1',
        };
        expect(getActiveConversationReplyTarget()).not.toBeNull();

        stores.get(storeKey('persona-a.png', 'char.png')).activeBranchId = 'branch-b';
        expect(getActiveConversationReplyTarget()).toBeNull();
        expect(stateModule.conversationState.conversationReplyTarget).toBeNull();

        stateModule.conversationState.conversationReplyTarget = {
            avatar: 'char.png',
            branchId: 'branch-b',
            groupId: '',
            personaId: 'persona-a.png',
            messageId: 'branch-b-message',
            text: 'branch message',
        };
        currentPersonaId = 'persona-b.png';
        expect(getActiveConversationReplyTarget()).toBeNull();
    });

    test('guards duplicate regeneration and keeps busy state until all operations finish', async () => {
        const first = deferred();
        const second = deferred();
        const started = deferred();
        generateConversationRaw
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => { started.resolve(); return second.promise; });

        const firstRun = regenerateConversationMessage('message-1');
        const duplicateRun = regenerateConversationMessage('message-1');
        const secondRun = regenerateConversationMessage('message-2');
        await started.promise;
        expect(generateConversationRaw).toHaveBeenCalledTimes(2);
        expect(captureConversationTextBinding.mock.invocationCallOrder[0]).toBeLessThan(buildConversationPromptMessages.mock.invocationCallOrder[0]);
        expect(stateModule.conversationState.conversationReplyBusy).toBe(true);

        first.resolve('first replacement');
        await firstRun;
        await duplicateRun;
        expect(stateModule.conversationState.conversationReplyBusy).toBe(true);

        second.resolve('second replacement');
        await secondRun;
        expect(stateModule.conversationState.conversationReplyBusy).toBe(false);
    });

    test('a rejected capture prevents prompt preparation, generation and replacement', async () => {
        const before = structuredClone(stores.get(storeKey('persona-a.png', 'char.png')));
        captureConversationTextBinding.mockRejectedValueOnce(new Error('Connection changed'));
        await regenerateConversationMessage('message-1');
        expect(buildConversationPromptMessages).not.toHaveBeenCalled();
        expect(generateConversationRaw).not.toHaveBeenCalled();
        expect(saveConversationThread).not.toHaveBeenCalled();
        expect(stores.get(storeKey('persona-a.png', 'char.png'))).toEqual(before);
    });

    test('applies completion only to its captured persona and branch', async () => {
        const generation = deferred();
        generateConversationRaw.mockImplementationOnce(() => generation.promise);
        const oldMessage = stores.get(storeKey('persona-a.png', 'char.png')).branches['branch-a'].messages[0];
        const newPersonaMessage = stores.get(storeKey('persona-b.png', 'char.png')).branches['branch-b'].messages[0];

        const run = regenerateConversationMessage('message-1');
        currentPersonaId = 'persona-b.png';
        generation.resolve('captured replacement');
        await run;

        expect(oldMessage.mes).toBe('captured replacement');
        expect(newPersonaMessage.mes).toBe('message persona-b-message');
    });

    test('drops a stale regeneration completion after the source message is revised', async () => {
        const generation = deferred();
        generateConversationRaw.mockImplementationOnce(() => generation.promise);
        const message = stores.get(storeKey('persona-a.png', 'char.png')).branches['branch-a'].messages[0];

        const run = regenerateConversationMessage('message-1');
        message.mes = 'edited while generating';
        generation.resolve('stale replacement');
        await run;

        expect(message.mes).toBe('edited while generating');
        expect(saveConversationThread).not.toHaveBeenCalled();
    });

    test('drops a regeneration completion after preceding prompt context changes', async () => {
        const generation = deferred();
        generateConversationRaw.mockImplementationOnce(() => generation.promise);
        const messages = stores.get(storeKey('persona-a.png', 'char.png')).branches['branch-a'].messages;

        const run = regenerateConversationMessage('message-2');
        messages[0].mes = 'preceding context edited';
        generation.resolve('stale replacement');
        await run;

        expect(messages[1].mes).toBe('message message-2');
        expect(saveConversationThread).not.toHaveBeenCalled();
        expect(extractCharacterReplyCommands).not.toHaveBeenCalled();
    });

    test('parses regeneration commands once and replaces stale command metadata', async () => {
        extractCharacterReplyCommands.mockReturnValueOnce({
            text: 'clean replacement',
            selfieRequests: ['at the park'],
        });
        generateConversationRaw.mockResolvedValueOnce('clean replacement [selfie: context="at the park"]');
        const message = stores.get(storeKey('persona-a.png', 'char.png')).branches['branch-a'].messages[0];
        message.extra.conversation_commands = { selfieRequests: ['stale request'], stale: true };

        await regenerateConversationMessage('message-1');

        expect(extractCharacterReplyCommands).toHaveBeenCalledTimes(1);
        expect(message.mes).toBe('clean replacement');
        expect(message.extra.conversation_commands).toEqual({ selfieRequests: ['at the park'] });
    });

    test('removes stale command metadata when regenerated output has no commands', async () => {
        generateConversationRaw.mockResolvedValueOnce('plain replacement');
        const message = stores.get(storeKey('persona-a.png', 'char.png')).branches['branch-a'].messages[0];
        message.extra.conversation_commands = { selfieRequests: ['stale request'] };

        await regenerateConversationMessage('message-1');

        expect(message.extra.conversation_commands).toBeUndefined();
    });

    test('changes the rendered thread identity when only the persona changes', () => {
        class FakeElement extends EventTarget {
            constructor() {
                super();
                this.children = [];
                this.clientHeight = 400;
                this.dataset = {};
                this.innerHTML = '';
                this.isConnected = false;
                this.scrollHeight = 400;
                this.scrollTop = 0;
                this.textContent = '';
            }

            appendChild(child) {
                this.children.push(child);
                return child;
            }

            querySelectorAll() {
                return [];
            }
        }

        globalThis.HTMLElement = FakeElement;
        globalThis.HTMLInputElement = class HTMLInputElement extends FakeElement {};
        const timeline = new FakeElement();
        const elements = new Map([['sb_conversation_timeline', timeline]]);
        globalThis.document = {
            createElement: () => new FakeElement(),
            getElementById: id => elements.get(id),
        };
        stores.get(storeKey('persona-a.png', 'char.png')).branches['branch-a'].messages = [];
        stores.get(storeKey('persona-b.png', 'char.png')).branches['branch-b'].messages = [];
        stateModule.conversationState.lastRenderedThreadKey = '';
        stateModule.conversationState.lastRenderedMessageCount = 0;
        stateModule.conversationState.lastTimelineFingerprint = '';

        renderConversationTimeline();
        const personaAThreadKey = stateModule.conversationState.lastRenderedThreadKey;
        currentPersonaId = 'persona-b.png';
        renderConversationTimeline();

        expect(personaAThreadKey).toContain('persona-a.png');
        expect(stateModule.conversationState.lastRenderedThreadKey).toContain('persona-b.png');
        expect(stateModule.conversationState.lastRenderedThreadKey).not.toBe(personaAThreadKey);
    });
});
