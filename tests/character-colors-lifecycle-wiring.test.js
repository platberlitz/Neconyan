/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const cancelPendingNewMessageWork = jest.fn();
let eventHandlers;
let lifecycleState;

function mockModule(path, exports) {
    return jest.unstable_mockModule(path, () => exports);
}

beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    eventHandlers = new Map();
    lifecycleState = {
        settings: {
            enabled: true,
            autoScanNewMessages: true,
            autoScanOnLoad: true,
            clearUnpinnedOnNewChat: false,
            themeMode: 'auto',
        },
        runtimeState: {
            eventsRegistered: false,
            eventHandlers: null,
            chatChangedRafId: null,
            chatChangedSettleTimer: null,
            dialogueRecountTimer: null,
            chatRootObserver: null,
            chatRootObserverTimer: null,
            keyboardSetup: false,
        },
        characterColors: {},
        groupProfiles: {},
        expandedCharacterRows: new Map(),
        selectedCharacterKeys: new Set(),
        pendingAttributionVerifications: [],
        attributionChatGeneration: 1,
        lastCharKey: 'character',
        lastProcessedMessageSignature: '',
        swapMode: null,
        autoSyncPendingRecord: null,
    };
    globalThis.document = {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        getElementById: jest.fn(() => null),
    };

    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/attribution.js', {
        clearDomCache: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/animation-controller.js', {
        destroyGradientAnimationController: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/color-blocks.js', {
        scanAllMessages: jest.fn(),
        stripColorBlocksFromDisplay: jest.fn(),
        syncDialogueCounts: jest.fn(() => false),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/character-operations.js', {
        deleteCharacterKeys: jest.fn(() => ({ removedKeys: [] })),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/context-menu.js', {
        setupContextMenu: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/dom-engine.js', {
        DOM_RETRY_REFRESH_DELAYS: [],
        POST_MUTATION_DOM_REPAIR_DELAY_MS: 700,
        clearDecoratedWatchers: jest.fn(),
        clearDialogueCountCache: jest.fn(),
        clearSessionAttributionVerifications: jest.fn(),
        decorateAllMessages: jest.fn(),
        reconcileMessageQuoteOverridesAfterDeletion: jest.fn(),
        scheduleDomRefreshSeries: jest.fn(),
        scheduleDomSettleRefresh: jest.fn(),
        scheduleMessageDomRepair: jest.fn(),
        setupChatObserver: jest.fn(),
        setupChatRootObserver: jest.fn(),
        startDomHealthCheck: jest.fn(),
        stopDomHealthCheck: jest.fn(),
        undecorateAllMessages: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/fonts.js', {
        scheduleCustomFontRefresh: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/history.js', {
        redo: jest.fn(),
        undo: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/live-colors.js', {
        applyHtmlBreakingSpanRepair: jest.fn(async () => {}),
        applyOverreachingSpanRepair: jest.fn(async () => {}),
        applyToolCallMessageRepair: jest.fn(async () => {}),
        cancelPendingNewMessageWork,
        commit: jest.fn(),
        onNewMessage: jest.fn(),
        repaintDomAfterCharacterDataChange: jest.fn(),
        resumePendingChatSave: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/llm.js', {
        consumeMainAiQuietGenerationEnd: jest.fn(() => false),
        populateProfileDropdown: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/palettes.js', {
        detectTheme: jest.fn(() => 'calico'),
        getReadableSurfaceSignature: jest.fn(() => 'surface'),
        hasMessageSurface: jest.fn(() => true),
        invalidateThemeCache: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/prompts.js', {
        buildMinimalPromptInstruction: jest.fn(() => ''),
        flushPromptInjection: jest.fn(),
        getEffectivePromptMode: jest.fn(() => 'local'),
        injectPrompt: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/st-api.js', {
        eventSource: {
            on: jest.fn((name, handler) => {
                if (!eventHandlers.has(name)) eventHandlers.set(name, []);
                eventHandlers.get(name).push(handler);
            }),
            removeListener: jest.fn(),
        },
        event_types: {
            GENERATION_STARTED: 'generation_started',
            GENERATION_AFTER_COMMANDS: 'generation_after_commands',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            USER_MESSAGE_RENDERED: 'user_message_rendered',
            MESSAGE_UPDATED: 'message_updated',
            MESSAGE_SWIPED: 'message_swiped',
            MESSAGE_DELETED: 'message_deleted',
            STREAM_TOKEN_RECEIVED: 'stream_token_received',
            SMOOTH_STREAM_TOKEN_RECEIVED: 'smooth_stream_token_received',
            GENERATION_ENDED: 'generation_ended',
            GENERATION_STOPPED: 'generation_stopped',
            GENERATION_ERROR: 'generation_error',
            GENERATION_FAILED: 'generation_failed',
            CHAT_RESET: 'chat_reset',
            CHAT_CREATED: 'chat_created',
            GROUP_CHAT_CREATED: 'group_chat_created',
            CHAT_CHANGED: 'chat_changed',
            CHAT_RENAMED: 'chat_renamed',
            CHARACTER_RENAMED: 'character_renamed',
            PERSONA_CHANGED: 'persona_changed',
            PERSONA_UPDATED: 'persona_updated',
            PERSONA_RENAMED: 'persona_renamed',
            SETTINGS_UPDATED: 'settings_updated',
            APP_READY: 'app_ready',
            MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
        },
        getContext: jest.fn(() => ({ chat: [], chatId: 'chat-1', registerMacro: jest.fn() })),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/state.js', {
        attributionChatGeneration: lifecycleState.attributionChatGeneration,
        autoSyncPendingRecord: lifecycleState.autoSyncPendingRecord,
        characterColors: lifecycleState.characterColors,
        expandedCharacterRows: lifecycleState.expandedCharacterRows,
        groupProfiles: lifecycleState.groupProfiles,
        isDomEngine: jest.fn(() => true),
        isStreamingGenerationActive: false,
        lastCharKey: lifecycleState.lastCharKey,
        lastProcessedMessageSignature: lifecycleState.lastProcessedMessageSignature,
        pendingAttributionVerifications: lifecycleState.pendingAttributionVerifications,
        runtimeState: lifecycleState.runtimeState,
        selectedCharacterKeys: lifecycleState.selectedCharacterKeys,
        setAttributionChatGeneration: jest.fn(),
        setEnabledLifecycleSynchronizer: jest.fn(),
        setIsStreamingGenerationActive: jest.fn(),
        setLastCharKey: jest.fn(),
        setLastProcessedMessageSignature: jest.fn(),
        setPendingAttributionVerifications: jest.fn(),
        setSwapMode: jest.fn(),
        settings: lifecycleState.settings,
        swapMode: lifecycleState.swapMode,
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/streaming-paint.js', {
        beginStreamingPaint: jest.fn(),
        endStreamingPaint: jest.fn(),
        paintPreviewMessage: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/storage.js', {
        confirmAutoSyncRecord: jest.fn(),
        doAutoSyncMarkersMatch: jest.fn(() => true),
        ensureRegexScript: jest.fn(),
        getAutoSyncRecord: jest.fn(() => null),
        getCharKey: jest.fn(() => 'character'),
        getStorageKey: jest.fn(() => 'storage'),
        initAutoSync: jest.fn(),
        loadData: jest.fn(),
        markCurrentPersonaKept: jest.fn(() => false),
        migrateLegacyLocalStorageIfNeeded: jest.fn(),
        migrateRenamedCharacterStorage: jest.fn(async () => ({ ok: true })),
        migrateRenamedChatStorage: jest.fn(async () => ({ ok: true })),
        persistLocalEnabledState: jest.fn(),
        saveData: jest.fn(),
        stopAutoSyncPolling: jest.fn(),
        syncAutoSyncPolling: jest.fn(),
        tryLoadFromCard: jest.fn(),
        updateAutoSyncUI: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/ui.js', {
        applyRestoredPersonaColor: jest.fn(),
        applyThemeOrBrightnessChange: jest.fn(),
        clearAutoColorizeIndicators: jest.fn(),
        createUI: jest.fn(),
        ensurePersonaCharacter: jest.fn(),
        mountWandMenuItem: jest.fn(),
        renamePersonaCharacter: jest.fn(),
        syncUIWithSettings: jest.fn(),
        updateCharList: jest.fn(),
        updateLegend: jest.fn(),
    });
    await mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/verify.js', {
        cancelStreamingAttributionVerification: jest.fn(),
        captureLoadedAttributionMessageBaseline: jest.fn(),
        clearAutoAttributionVerificationQueue: jest.fn(),
        queueAutoAttributionVerificationForRenderedMessages: jest.fn(),
        scheduleStreamingAttributionVerification: jest.fn(),
    });
});

async function importMain() {
    return import('../public/scripts/extensions/third-party/sillytavern-character-colors/src/main.js');
}

describe('Character Colors central lifecycle cancellation', () => {
    test('direct stop, reset, chat switch and deletion cancel queued work', async () => {
        const main = await importMain();

        lifecycleState.settings.enabled = false;
        main.syncAutomaticRuntime();
        expect(cancelPendingNewMessageWork).toHaveBeenCalledTimes(1);

        cancelPendingNewMessageWork.mockClear();
        lifecycleState.settings.enabled = true;
        main.resetDialogueCountsForNewChat();
        expect(cancelPendingNewMessageWork).toHaveBeenCalledTimes(1);

        cancelPendingNewMessageWork.mockClear();
        main.handleChatChanged();
        expect(cancelPendingNewMessageWork).toHaveBeenCalledTimes(1);

        cancelPendingNewMessageWork.mockClear();
        main.handleMessageDeleted();
        expect(cancelPendingNewMessageWork).toHaveBeenCalledTimes(1);
    });

    test('registered group/create/reset/generation interruption events cancel queued work', async () => {
        const main = await importMain();
        main.registerEventHandlers();

        for (const eventName of ['group_chat_created', 'chat_reset', 'generation_stopped', 'generation_error', 'generation_failed']) {
            cancelPendingNewMessageWork.mockClear();
            const handlers = eventHandlers.get(eventName) || [];
            expect(handlers.length).toBeGreaterThan(0);
            handlers[0]();
            expect(cancelPendingNewMessageWork).toHaveBeenCalledTimes(1);
        }
    });

});
