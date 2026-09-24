/* eslint-disable playwright/no-duplicate-hooks */
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

let summarizeChatInterceptChange;
let warnSpy;

beforeAll(async () => {
    jest.resetModules();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
        extension_settings: {},
        renderExtensionTemplateAsync: jest.fn(async () => ''),
        getContext: jest.fn(() => ({})),
    }));

    await jest.unstable_mockModule('../public/lib.js', () => ({
        DiffMatchPatch: class DiffMatchPatch {
            diff_main(beforeText, afterText) {
                return [[0, beforeText], [1, afterText]];
            }

            diff_cleanupSemantic() {}
        },
    }));

    await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
        Popup: class Popup {
            async show() {
                return null;
            }
        },
        POPUP_TYPE: { CONFIRM: 'confirm', TEXT: 'text' },
        POPUP_RESULT: { AFFIRMATIVE: 'affirmative' },
    }));

    await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
        download: jest.fn(),
        escapeHtml: jest.fn(value => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')),
        escapeRegex: jest.fn(value => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        getSortableDelay: jest.fn(() => 0),
        uuidv4: jest.fn(() => 'test-uuid'),
    }));

    await jest.unstable_mockModule('../public/script.js', () => ({
        CLIENT_VERSION: 'test',
        activateSendButtons: jest.fn(),
        chat: [],
        deactivateSendButtons: jest.fn(),
        getCurrentChatId: jest.fn(() => 'chat-a'),
        getChatGeneration: jest.fn(() => 1),
        getRequestHeaders: jest.fn(() => ({})),
        generateQuietPrompt: jest.fn(),
        is_send_press: false,
        normalizeContentText: jest.fn(value => String(value ?? '')),
        saveChatDebounced: jest.fn(),
        saveSettingsDebounced: jest.fn(),
        saveSettings: jest.fn(async () => true),
        substituteParams: jest.fn(value => String(value ?? '')),
    }));

    await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
        is_group_generating: false,
    }));

    await jest.unstable_mockModule('../public/scripts/user.js', () => ({
        getCurrentUserHandle: jest.fn(() => 'test'),
    }));

    await jest.unstable_mockModule('../public/scripts/events.js', () => ({
        eventSource: { on: jest.fn() },
        event_types: {},
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
        AGENT_CATEGORIES: {},
        AGENT_SUBCATEGORIES: {},
        DEFAULT_AGENT_MAX_TOKENS: 8192,
        MAX_AGENT_MAX_TOKENS: 64000,
        LEGACY_AGENT_MAX_TOKENS: 2048,
        areAgentsGloballyEnabled: jest.fn(() => true),
        areAgentsLoaded: jest.fn(() => true),
        getAgentLibraryErrors: jest.fn(() => []),
        hasPendingAgentRecovery: jest.fn(() => false),
        persistAgentIdentityRepairs: jest.fn(async () => {}),
        bindAgentStorageAccount: jest.fn(),
        getAgents: jest.fn(() => []),
        getEnabledAgents: jest.fn(() => []),
        getAgentById: jest.fn(() => null),
        getAgentRegexScripts: jest.fn(() => []),
        getCompanionConfig: jest.fn(() => ({
            trigger: 'auto',
            displayMode: 'card',
            format: 'markdown',
            contextMessages: 10,
            includeCharacterCard: false,
            includePersona: false,
            includeWorldInfo: false,
            includeHistory: false,
            historyDepth: 3,
            feedback: { enabled: false, depth: 1 },
            batch: false,
            maxTokens: 2048,
        })),
        loadAgents: jest.fn(),
        reorderAgentsIntoOrderSlots: jest.fn(async () => false),
        normalizeStringIdList: jest.fn((value = []) => (Array.isArray(value) ? value : [])),
        saveAgent: jest.fn(async () => {}),
        saveAgentBatch: jest.fn(async () => {}),
        saveAgentEnabledState: jest.fn(async () => {}),
        deleteAgentBatch: jest.fn(async () => {}),
        captureAgentSaveGuard: jest.fn(() => () => true),
        installAgentGroup: jest.fn(async () => []),
        getUnresolvedAgentReferences: jest.fn(() => []),
        buildLatestBundledAgentSnapshot: jest.fn(agent => agent),
        deleteAgent: jest.fn(async () => {}),
        createDefaultAgent: jest.fn(() => ({
            id: 'agent-id',
            name: 'Agent',
            prompt: '',
            injection: {},
            preProcess: {},
            postProcess: {},
            conditions: {},
        })),
        importAgents: jest.fn(() => []),
        exportAllAgents: jest.fn(() => []),
        exportAgent: jest.fn(() => null),
        getGlobalSettings: jest.fn(() => ({})),
        getAgentSetupPresets: jest.fn(() => []),
        getAgentSetupPresetById: jest.fn(() => null),
        isAgentSetupCurrent: jest.fn(() => false),
        loadAgentSetupPresets: jest.fn(async () => []),
        saveAgentSetupPreset: jest.fn(),
        deleteAgentSetupPreset: jest.fn(),
        applyAgentSetupPreset: jest.fn(),
        initializeScopedAgentEnableState: jest.fn(() => false),
        isAgentEnabledForCurrentScope: jest.fn(() => false),
        normalizeAgentCategory: jest.fn(value => value),
        getAgentChatScopeLabel: jest.fn(() => 'Individual chat'),
        getPromptTransformMode: jest.fn(() => 'rewrite'),
        isTrackerFixAgent: jest.fn(() => false),
        agentMatchesListTab: jest.fn(() => true),
        applyCompanionContextAccessDefaults: jest.fn(() => false),
        applyCompanionPanelDisplayDefault: jest.fn(() => false),
        applyTrackerCompanionAutoLoopDefaults: jest.fn(() => false),
        convertAgentExecution: jest.fn(() => false),
        resolveCompanionConnectionProfile: jest.fn(value => value ?? ''),
        isCompanionAgent: jest.fn(agent => agent?.execution === 'companion' || agent?.category === 'companion'),
        isToolAgent: jest.fn(agent => agent?.category === 'tool'),
        isPathfinderSubmoduleEnabled: jest.fn(() => false),
        findTemplateForAgentSnapshot: jest.fn(() => null),
        getBundledAgentLatestTemplatePlan: jest.fn(() => ({ updates: [], redundantIds: [] })),
        getRedundantBundledAgentDuplicateIds: jest.fn(() => []),
        reconcileScopedEnabledAgentIdsFromLegacyFlags: jest.fn(() => false),
        resolveConnectionProfile: jest.fn(value => value ?? ''),
        setAgentEnabledForCurrentScope: jest.fn(),
        setGlobalSettings: jest.fn(),
        setPathfinderSubmoduleEnabled: jest.fn(),
        getGroups: jest.fn(() => []),
        getCustomGroups: jest.fn(() => []),
        loadBuiltinGroups: jest.fn(),
        loadCustomGroups: jest.fn(),
        saveGroup: jest.fn(async () => {}),
        deleteGroup: jest.fn(async () => {}),
        createDefaultGroup: jest.fn(() => ({ id: 'group-id', name: 'Group' })),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-runner.js', () => ({
        captureMessageTargetState: jest.fn(() => ({})),
        isMessageTargetCurrent: jest.fn(() => true),
        getPathfinderRuntimeAgent: jest.fn(() => null),
        cancelAgentGeneration: jest.fn(),
        buildPromptDynamicMacros: jest.fn(() => ({})),
        deactivatePathfinderRuntime: jest.fn(),
        initAgentRunner: jest.fn(),
        getAgentGenerationCancelRevision: jest.fn(() => 0),
        requestPromptTransform: jest.fn(async () => ({ output: 'Refined instructions' })),
        isAgentGenerationActive: jest.fn(() => false),
        onAgentGenerationStateChanged: jest.fn(),
        getPreGenerationInterceptHistoryForMessage: jest.fn(() => []),
        getPromptTransformHistoryForMessage: jest.fn(() => []),
        refreshRegexSnapshotsForAgent: jest.fn(() => 0),
        runAgentOnMessage: jest.fn(),
        runAgentOnTarget: jest.fn(),
        runTrackerFixOnMessage: jest.fn(),
        syncToolAgentRegistrations: jest.fn(),
        undoPromptTransform: jest.fn(async () => false),
        redoPromptTransform: jest.fn(async () => false),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/regex-scripts.js', () => ({
        AGENT_REGEX_PLACEMENT: {
            AI_OUTPUT: 'ai-output',
            USER_INPUT: 'user-input',
            SLASH_COMMAND: 'slash-command',
            WORLD_INFO: 'world-info',
            REASONING: 'reasoning',
        },
        AGENT_REGEX_SUBSTITUTE: {
            RAW: 'raw',
            ESCAPED: 'escaped',
        },
        createDefaultRegexScript: jest.fn(() => ({})),
        applyRegexScriptList: jest.fn(value => value),
        normalizeRegexScript: jest.fn(value => value),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder-init.js', () => ({
        initPathfinder: jest.fn(),
        teardownPathfinder: jest.fn(),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder-settings-ui.js', () => ({
        openPathfinderSettings: jest.fn(),
        closePathfinderSettings: jest.fn(),
        canClosePathfinderSettings: jest.fn(async () => true),
        cancelPathfinderSummary: jest.fn(),
        refreshPathfinderSettings: jest.fn(),
        isPathfinderAgent: jest.fn(() => false),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tool-definitions.js', () => ({
        getPathfinderToolDefinitions: jest.fn(() => []),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', () => ({
        captureCompanionResultTarget: jest.fn(() => () => true),
        agentHasConnectedCompanionDependencies: jest.fn(() => false),
        collectRecentCompanionResults: jest.fn(() => []),
        getCompanionResults: jest.fn(() => ({})),
        getLatestValidCompanionMessageIndex: jest.fn(() => -1),
        hasConnectedCompanionAgentCandidates: jest.fn(() => false),
        hasConnectedCompanionAgents: jest.fn(() => false),
        initCompanionRunner: jest.fn(),
        runConnectedCompanionsOnMessage: jest.fn(async () => []),
        runTrackerCompanionsOnMessage: jest.fn(async () => []),
        syncCompanionChatHistoryConfig: jest.fn(() => 0),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-ui.js', () => ({
        initCompanionCardUi: jest.fn(),
        sanitizeCompanionHtml: jest.fn(value => value),
        updateCompanionButtonVisibility: jest.fn(),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-dashboard.js', () => ({
        configureCompanionDashboard: jest.fn(),
        initCompanionWandMenuItem: jest.fn(),
        openCompanionDashboard: jest.fn(),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-panel.js', () => ({
        configureCompanionPanel: jest.fn(),
        getCompanionPanelLauncher: jest.fn(() => 'handle'),
        initCompanionPanel: jest.fn(),
        openCompanionPanel: jest.fn(),
        refreshCompanionPanel: jest.fn(),
        setCompanionPanelLauncher: jest.fn(value => value),
        updateCompanionPanelHandleVisibility: jest.fn(),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/llm-utils.js', () => ({
        buildFallbackPromptText: jest.fn(() => ''),
        extractProfileResponseText: jest.fn(() => ''),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/profile-utils.js', () => ({
        buildConnectionProfileNameMap: jest.fn(() => new Map()),
        getConnectionManagerRequestService: jest.fn(() => null),
        populateConnectionProfileSelect: jest.fn(),
    }));

    ({ summarizeChatInterceptChange } = await import('../public/scripts/extensions/in-chat-agents/index.js'));
});

afterAll(() => {
    warnSpy?.mockRestore();
});

describe('summarizeChatInterceptChange', () => {
    test('reports a wrapped system message as an added change', () => {
        const before = JSON.stringify([{ role: 'user', content: 'Original prompt' }], null, 2);
        const after = JSON.stringify([
            { role: 'user', content: 'Original prompt' },
            { role: 'system', content: 'Follow the extra instruction.' },
        ], null, 2);

        const result = summarizeChatInterceptChange(before, after);

        expect(result).toEqual({
            ok: true,
            changes: [expect.objectContaining({
                changeKind: 'added',
                role: 'system',
                beforeIndex: null,
                afterIndex: 1,
                afterContent: 'Follow the extra instruction.',
            })],
        });
    });

    test('reports an in-place replacement as a modified change', () => {
        const before = JSON.stringify([
            { role: 'system', content: 'Keep tone warm.' },
            { role: 'user', content: 'Original prompt' },
        ], null, 2);
        const after = JSON.stringify([
            { role: 'system', content: 'Keep tone warm.' },
            { role: 'user', content: 'Rewritten prompt' },
        ], null, 2);

        const result = summarizeChatInterceptChange(before, after);

        expect(result).toEqual({
            ok: true,
            changes: [expect.objectContaining({
                changeKind: 'modified',
                role: 'user',
                beforeIndex: 1,
                afterIndex: 1,
                beforeContent: 'Original prompt',
                afterContent: 'Rewritten prompt',
            })],
        });
    });

    test('reports malformed JSON as a parse error', () => {
        expect(summarizeChatInterceptChange('{not-json', '[]')).toEqual({
            ok: false,
            reason: 'parse-error',
        });
    });

    test('uses the complete difference when messages are reordered', () => {
        const messages = [{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Second' }];
        expect(summarizeChatInterceptChange(JSON.stringify(messages), JSON.stringify([...messages].reverse())))
            .toEqual({ ok: false, reason: 'message-order' });
    });

    test('does not hide changes to speaker names or tool metadata', () => {
        const before = JSON.stringify([{ role: 'user', content: 'Same text', name: 'Alice' }]);
        const after = JSON.stringify([{ role: 'user', content: 'Same text', name: 'Bob' }]);
        expect(summarizeChatInterceptChange(before, after).ok).toBe(false);
        expect(summarizeChatInterceptChange('[]', JSON.stringify([{ role: 'assistant', content: '', tool_calls: [] }])).ok).toBe(false);
    });

    test('repeated messages still expose changed ordering', () => {
        const one = { role: 'user', content: 'Repeated' };
        const two = { role: 'assistant', content: 'Middle' };
        expect(summarizeChatInterceptChange(JSON.stringify([one, two, one]), JSON.stringify([one, one, two])).ok).toBe(false);
    });
});
