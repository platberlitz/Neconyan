import {
    chat,
    chat_metadata,
    ensureSwipes,
    extension_prompt_roles,
    extension_prompt_types,
    extension_prompts,
    setExtensionPrompt,
    setAgentGenerationContextProvider,
    substituteParams,
    substituteParamsExtended,
    getCurrentChatId,
    itemizedPrompts,
    normalizeContentText,
    saveChatDebounced,
    stopGeneration,
    streamingProcessor,
    syncMesToSwipe,
    updateMessageTokenAccounting,
} from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { eventSource, event_types } from '../../events.js';
import { is_group_generating } from '../../group-chats.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from '../../popup.js';
import { ToolManager } from '../../tool-calling.js';
import {
    areAgentsGloballyEnabled,
    getAgentById,
    getAgents,
    getAgentRegexScripts,
    getEnabledAgents,
    getEnabledToolAgents,
    getGlobalSettings,
    getPromptTransformMode,
    isAgentRuntimeAllowed,
    isCompanionAgent,
    isTrackerFixAgent,
    isPathfinderSubmoduleEnabled,
    saveAgent,
    isToolAgent,
    normalizePreProcessMaxTokens,
    normalizePromptTransformMaxTokens,
    resolveCompanionConnectionProfile,
    resolveConnectionProfile,
} from './agent-store.js';
import { regexFromString, uuidv4 } from '../../utils.js';
import { resetChatBackupSequence } from '../../chat-backup-sequence.js';
import { isKimiK3Model } from '../../openai-model-capabilities.js';
import { isGenerationLengthFinish } from '../../generation-request-controls.js';
import { resolveExpressionsAgentProfile } from '../expressions/expressions-agent-utils.js';
import { buildFallbackPromptText, extractProfileResponseText } from './llm-utils.js';
import { getConnectionProfileDisplayName, getConnectionProfileModelName } from './profile-utils.js';
import {
    appendHelperPrefillMessages,
    parseHelperPrefillMessages,
} from '../helper-prefill.js';
import {
    getToolAction,
    getToolFormatter,
} from './tool-action-registry.js';
import {
    getSettings as getPathfinderRuntimeSettings,
    replaceSettings as replacePathfinderRuntimeSettings,
    isPathfinderSelfWrite,
} from './pathfinder/tree-store.js';
import { onPathfinderWorldInfoUpdated, onPathfinderWorldInfoRenamed, onPathfinderWorldInfoDeleted } from './pathfinder/entry-manager.js';
import { initializePromptStore, setPromptStorePersistHook } from './pathfinder/prompts/prompt-store.js';
import { getDefaultPrompts, getDefaultPipelines } from './pathfinder/prompts/default-prompts.js';
import { getPathfinderToolDefinitions } from './pathfinder/tool-definitions.js';
import { getContextualLorebooks, getForcedToolChoice, prepareToolCall } from './pathfinder/pathfinder-tool-bridge.js';
import { confirmToolCall, shouldConfirmToolCall } from './pathfinder/tool-confirmation.js';
import { injectPathfinderRetrieval, PATHFINDER_RETRIEVAL_PROMPT_KEYS, runSidecarRetrieval } from './pathfinder/sidecar-retrieval.js';
import { resetAutoSummaryCount, shouldAutoSummarize } from './pathfinder/auto-summary.js';
import { buildRegexScriptRefsForAgent, cacheAgentRegexScripts, migrateLegacyRegexSnapshotsInMessages } from './regex-snapshot-store.js';
import { AGENT_REGEX_PLACEMENT, applyRegexScriptList } from './regex-scripts.js';
import { getCompanionReferenceIds, stripEmptyOutputSentinelLines } from './companion/companion-shared.js';
import {
    getTrackerMetadataKey,
    getTrackerRepairPayload,
    inspectTrackerState,
    mergeTrackerRepairPayload,
    TRACKER_REPAIR_INSTRUCTION,
    writeTrackerMetadataValue,
} from './tracker-state.js';

const PROMPT_KEY_PREFIX = 'inchat_agent_';
const PATHFINDER_AUTO_SUMMARY_PROMPT_KEY = 'pathfinder_zz_auto_summary';
const MESSAGE_EXTRA_KEY = 'inChatAgents';
const POST_PROCESSING_RUNS_EXTRA_KEY = 'inChatAgentPostRuns';
const PATHFINDER_RETRIEVAL_CACHE_EXTRA_KEY = 'pathfinderRetrievalCache';
export const PROMPT_RUNS_EXTRA_KEY = 'inChatAgentPromptRuns';
export const PROMPT_TRANSFORM_HISTORY_KEY = 'inChatAgentTransformHistory';
const PROMPT_TRANSFORM_REDO_KEY = 'inChatAgentTransformRedo';
export const PRE_GENERATION_INTERCEPT_HISTORY_KEY = 'inChatAgentPreGenerationInterceptHistory';
const MAX_TRANSFORM_HISTORY = 10;
const MAX_PATHFINDER_RETRIEVAL_CACHE = 6;
const PATHFINDER_RETRIEVAL_CONTEXT_MESSAGE_LIMIT = 10;
const pendingRefreshTimeouts = new Map();
const pendingRegexSnapshotSaves = new WeakSet();
const migratedLegacyRegexSnapshotChatIds = new Set();
const GREETING_GENERATION_TYPE = 'first_message';
const IMPERSONATE_GENERATION_TYPE = 'impersonate';
export const COMPANION_OUTPUT_GENERATION_TYPE = 'companion_output';
const PREPEND_PROMPT_TRANSFORM_TEMPLATE_IDS = new Set([
    'tpl-scene-tracker',
    'tpl-time-tracker',
]);
const IMPERSONATE_PROMPT_TRANSFORM_TEMPLATE_IDS = new Set([
    'tpl-prose-polisher',
]);
const PREPEND_PROMPT_TRANSFORM_TAG_RE = /\[(?:SCENE|TIME)\|/;
const ASSISTANT_RESPONSE_WRAPPER_RE = /^\s*<assistant_response>\s*([\s\S]*?)\s*<\/assistant_response>\s*$/i;
const CONTEXT_INTERCEPT_OUTPUT_RE = /^\s*<context>\s*([\s\S]*?)\s*<\/context>\s*$/i;
const BODY_GENERATING_FLAG_GRACE_MS = 1500;
const DEFERRED_POST_PROCESSING_RETRY_MS = 50;
const LATEST_ASSISTANT_POST_PROCESSING_FALLBACK_WINDOW_MS = 30000;
const MISSED_GENERATION_END_RECOVERY_MS = 200;
const PATHFINDER_SUMMARIZE_TOOL_NAME = 'Pathfinder_Summarize';
const PRE_GENERATION_INTERCEPT_TIMING = 'pre-generation';
const POST_MAIN_GENERATION_INTERCEPT_TIMING = 'post-main-generation';

/** @type {{ generationType: string, activeAgentIds: string[], chatId: string } | null} */
let pendingGenerationSnapshot = null;
let internalPromptTransformDepth = 0;
let isGenerationInProgress = false;
let generationStopRequested = false;
const deferredPostProcessingQueue = new Map();
let deferredPostProcessingTimeout = null;
let latestAssistantPostProcessingFallbackTimeout = null;
let latestAssistantPostProcessingFallbackDeadline = 0;
let postGenerationRecoveryTimeout = null;
let missedGenerationEndRecoveryTimeout = null;
let agentRunnerInitialized = false;
let postGenerationRecoveryHooksInitialized = false;
let postGenerationRecoveryObserver = null;
const activePromptTransformToasts = new Set();
const agentGenerationStateListeners = new Set();
const manualAgentRunQueue = [];
let manualAgentRunQueueProcessing = false;
let manualAgentRunCancelRequested = false;
let activeManualAgentRun = null;
let parallelManualRunCount = 0;
let agentGenerationCancelRevision = 0;
const promptTransformIdleResolvers = new Set();
const pendingGenerationRecords = new Map();
let generationStartChatId = '';
let postProcessingInvalidatedByChatChange = false;
let generationStartChatLength = 0;
let generationStartLastAssistantIndex = -1;
let generationStartLastAssistantMessage = null;
let generationStartLastAssistantRevision = '';
let generationStartedAt = 0;
let lastMainGenerationEndedAt = 0;
let currentMainGenerationType = 'normal';
let postProcessingGenerationRunId = 0;
let swipeNavigationPending = false;
const activeAgentRequestAbortControllers = new Set();
const activePathfinderRetrievalAbortControllers = new Set();
const activeToolApprovals = new Map();
const pathfinderRetrievalCacheSession = uuidv4();
// ponytail: invalidate all retrieval caches on book changes; use per-book revisions only if this becomes costly.
let pathfinderRetrievalCacheRevision = 0;
let pathfinderToolRevision = 0;
let pathfinderRetrievalRun = null;
let pathfinderChatSyncRevision = 0;
let activePathfinderRetrievalToast = null;
let activeInitialGenerationToast = null;
let companionRuntime = null;

export function registerCompanionRuntime(runtime = null) {
    companionRuntime = runtime && typeof runtime === 'object' ? runtime : null;
}

export function getAgentGenerationCancelRevision() {
    return agentGenerationCancelRevision;
}

export function isAgentGenerationStopped() {
    return generationStopRequested;
}

export function getAgentGenerationContext() {
    return {
        chatId: getCurrentSnapshotChatId(),
        runId: postProcessingGenerationRunId,
        cancelRevision: agentGenerationCancelRevision,
    };
}

function shouldDeferAgentRegularBackup() {
    return Boolean(isGenerationInProgress || internalPromptTransformDepth > 0 || isMainGenerationStillActive());
}

function getLatestUserMessageText() {
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (message?.is_user) {
            return String(message.mes ?? '');
        }
    }

    return '';
}

function isRegexLiteral(value = '') {
    return /^\/[\s\S]+\/[a-z]*$/i.test(String(value ?? '').trim());
}

function companionTriggerMatches(keyword, messageText) {
    const normalizedKeyword = String(keyword ?? '').trim();
    if (!normalizedKeyword) {
        return false;
    }

    if (isRegexLiteral(normalizedKeyword)) {
        try {
            const regex = regexFromString(normalizedKeyword);
            if (regex instanceof RegExp) {
                return regex.test(messageText);
            }
        } catch (error) {
            console.warn('[InChatAgents] Invalid Companion trigger regex:', normalizedKeyword, error);
        }
    }

    return messageText.toLowerCase().includes(normalizedKeyword.toLowerCase());
}

function saveChatDebouncedForAgent({ deferBackup = shouldDeferAgentRegularBackup() } = {}) {
    saveChatDebounced({ deferBackup: Boolean(deferBackup), completeDeferredBackup: !deferBackup });
}

/**
 * Saves the chat through the host and reports whether the host accepted the save.
 * The host returns `true` on success and `false` (or throws) when the save was declined.
 * @returns {Promise<boolean>}
 */
async function saveChatForAgent(context, { deferBackup = shouldDeferAgentRegularBackup() } = {}) {
    if (typeof context?.saveChat !== 'function') {
        return false;
    }

    try {
        const saved = await context.saveChat({ deferBackup: Boolean(deferBackup), completeDeferredBackup: !deferBackup });
        // Legacy hosts resolve undefined on success; only an explicit false means declined.
        return saved !== false;
    } catch (error) {
        console.error('[In-Chat Agents] Chat save failed.', error);
        return false;
    }
}

function migrateLegacyRegexSnapshotsForCurrentChat(chatId = getCurrentChatId()) {
    const migrationKey = String(chatId ?? '');
    if (!migrationKey || migratedLegacyRegexSnapshotChatIds.has(migrationKey) || chat.length === 0) {
        return;
    }

    migratedLegacyRegexSnapshotChatIds.add(migrationKey);
    const migrated = migrateLegacyRegexSnapshotsInMessages(chat, MESSAGE_EXTRA_KEY);
    if (migrated > 0) {
        saveChatDebounced();
    }
}

/** Track which tool names were registered by the agent system so we can cleanly unregister only our own. */
const agentRegisteredToolNames = new Set();

/** Guard to prevent re-registration during generation when WORLDINFO_UPDATED fires. */
let toolSyncDuringGeneration = false;
let pendingToolSync = false;

/** Recursion depth tracker for tool-call passes. */
let toolRecursionDepth = 0;

/** Tracks automatic post-processing per generated message revision so fallback events cannot double-apply agents. */
const processedPostProcessingRuns = new WeakMap();
const processedPostProcessingRunsByIndex = new Map();
const postProcessingInFlightKeys = new Set();
const postProcessingTargets = new WeakMap();
const messageEditRevisions = new WeakMap();
const postProcessingInterruptionWarned = new WeakSet();
let chatLoadRevision = 0;

export function getAgentPostProcessingTarget(message) {
    return postProcessingTargets.get(message);
}

function setPostProcessingText(message, text, target = null) {
    if (target && (!target.valid || target.text !== message.mes || !isMessageTargetCurrent(message, target.state))) {
        target.valid = false;
        return false;
    }
    message.mes = text;
    if (target) {
        target.text = text;
        target.state.mes = text;
    }
    return true;
}

// A request outlives the state it was built from. Capture the text and swipe the agent
// read, and refuse to apply its output once the user (or another run) moved on.
export function captureMessageTargetState(message, messageIndex = chat.indexOf(message)) {
    return {
        mes: message?.mes,
        swipeId: message?.swipe_id ?? 0,
        messageIndex,
        chatId: getCurrentSnapshotChatId(),
        chatLoadRevision,
        editRevision: messageEditRevisions.get(message) ?? 0,
    };
}

export function isMessageTargetCurrent(message, captured, messageIndex = null, { text = true, revision = true } = {}) {
    if (!message || !captured) {
        return false;
    }
    if ((text && message.mes !== captured.mes) || (message.swipe_id ?? 0) !== captured.swipeId
        || captured.chatId !== getCurrentSnapshotChatId() || captured.chatLoadRevision !== chatLoadRevision
        || (revision && captured.editRevision !== (messageEditRevisions.get(message) ?? 0))) {
        return false;
    }
    const numericIndex = messageIndex === null || messageIndex === undefined ? captured.messageIndex : Number(messageIndex);
    if (Number.isInteger(numericIndex) && numericIndex >= 0 && chat[numericIndex] !== message) {
        return false;
    }
    return true;
}

function invalidateMessageTarget(message) {
    if (!message) return;
    messageEditRevisions.set(message, (messageEditRevisions.get(message) ?? 0) + 1);
    const target = postProcessingTargets.get(message);
    if (target) target.valid = false;
}

// A silent stop is indistinguishable from "the agents did nothing", which is what makes an
// interrupted pipeline feel random. Tell the user once per reply when their reply is untouched.
function warnPostProcessingInterrupted(message, detail = '') {
    if (!message || postProcessingInterruptionWarned.has(message)) {
        return;
    }
    postProcessingInterruptionWarned.add(message);
    const suffix = detail ? ` (${String(detail).slice(0, 160)})` : '';
    try {
        toastr.warning(`Agent work was interrupted before it finished${suffix}. Your reply is unchanged; run the agents again.`, 'In-Chat Agents', {
            timeOut: 10000,
            extendedTimeOut: 12000,
        });
    } catch {
        // A toast failure must not mask the original problem.
    }
}
const stoppedStreamingMessageIndexes = new Set();
let stoppedGenerationRunId = -1;

function escapeToastHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function isAgentGenerationActive() {
    return internalPromptTransformDepth > 0 || manualAgentRunQueueProcessing || manualAgentRunQueue.length > 0 || parallelManualRunCount > 0 || activePathfinderRetrievalAbortControllers.size > 0;
}

export function onAgentGenerationStateChanged(listener) {
    if (typeof listener !== 'function') {
        return () => {};
    }

    agentGenerationStateListeners.add(listener);
    return () => agentGenerationStateListeners.delete(listener);
}

function notifyAgentGenerationStateChanged() {
    const active = isAgentGenerationActive();

    for (const listener of agentGenerationStateListeners) {
        try {
            listener(active);
        } catch (error) {
            console.warn('[InChatAgents] Agent generation state listener failed:', error);
        }
    }
}

function notifyPromptTransformIdle() {
    if (internalPromptTransformDepth > 0) {
        return;
    }

    const resolvers = [...promptTransformIdleResolvers];
    promptTransformIdleResolvers.clear();

    for (const resolve of resolvers) {
        resolve();
    }

    scheduleDeferredPostProcessingFlush(0);
}

function waitForPromptTransformIdle() {
    if (internalPromptTransformDepth === 0) {
        return Promise.resolve();
    }

    return new Promise(resolve => promptTransformIdleResolvers.add(resolve));
}

function clearManualAgentRunQueue() {
    const queuedRuns = manualAgentRunQueue.splice(0);

    for (const queuedRun of queuedRuns) {
        queuedRun.resolve(null);
    }

    return queuedRuns.length;
}

export function cancelAgentGeneration() {
    const wasActive = isAgentGenerationActive();
    const queuedCount = clearManualAgentRunQueue();
    manualAgentRunCancelRequested = true;
    agentGenerationCancelRevision++;

    generationStopRequested = true;
    invalidateToolApprovals();
    releaseToolAgentRegistrations();

    clearLatestAssistantPostProcessingFallback();
    clearDeferredPostProcessing();
    clearMissedGenerationEndRecoveryCheck();
    clearAllPromptTransformRunningToasts();
    clearInitialGenerationToast();
    clearPathfinderRetrievalToast();
    abortActiveAgentRequests('Agent generation cancelled by user.');
    abortActivePathfinderRetrieval('Pawthfinder retrieval cancelled by user.');
    clearPathfinderExtensionPrompts();

    const stopped = wasActive || activeManualAgentRun ? stopGeneration() : false;
    notifyAgentGenerationStateChanged();

    if (stopped || wasActive || queuedCount > 0) {
        toastr.info(queuedCount > 0 ? `Stopping agent generation and clearing ${queuedCount} queued run${queuedCount === 1 ? '' : 's'}...` : 'Stopping agent generation...');
        return true;
    }

    toastr.info('No agent generation is currently running.');
    return false;
}

function abortActiveAgentRequests(reason = 'Agent generation cancelled.') {
    const error = reason instanceof Error ? reason : new Error(String(reason));

    for (const controller of activeAgentRequestAbortControllers) {
        controller.abort(error);
    }

    activeAgentRequestAbortControllers.clear();
}

function isAbortSignalTriggered(error, signal = null) {
    return Boolean(signal?.aborted || error?.name === 'AbortError');
}

function abortActivePathfinderRetrieval(reason = 'Pawthfinder retrieval cancelled.') {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    pathfinderRetrievalRun?.controller.abort(error);
    pathfinderRetrievalRun = null;

    for (const controller of activePathfinderRetrievalAbortControllers) {
        controller.abort(error);
    }

    activePathfinderRetrievalAbortControllers.clear();
    notifyAgentGenerationStateChanged();
}

function invalidateToolApprovals(force = false) {
    for (const [controller, isCurrent] of activeToolApprovals) {
        if (force || !isCurrent()) controller.abort();
    }
}

function releaseToolAgentRegistrations() {
    toolSyncDuringGeneration = false;
    if (pendingToolSync) syncToolAgentRegistrations();
}

function showPathfinderRetrievalToast() {
    if (activePathfinderRetrievalToast) {
        return;
    }

    activePathfinderRetrievalToast = toastr.info('Pawthfinder is processing lore for this reply...', 'Please wait', { timeOut: 0, extendedTimeOut: 0 });
}

function clearPathfinderRetrievalToast() {
    if (!activePathfinderRetrievalToast) {
        return;
    }

    toastr.clear(activePathfinderRetrievalToast);
    activePathfinderRetrievalToast = null;
}

function showInitialGenerationToast() {
    if (activeInitialGenerationToast) {
        return;
    }

    activeInitialGenerationToast = toastr.info('Generating initial message', 'In-Chat Agents', { timeOut: 0, extendedTimeOut: 0 });
}

function clearInitialGenerationToast() {
    if (!activeInitialGenerationToast) {
        return;
    }

    toastr.clear(activeInitialGenerationToast);
    activeInitialGenerationToast = null;
}

function shouldShowPathfinderRetrievalToast(pathfinderAgent) {
    const settings = pathfinderAgent?.settings ?? {};
    return Boolean(settings.pipelineEnabled || settings.sidecarEnabled);
}

async function processManualAgentRunQueue() {
    if (manualAgentRunQueueProcessing) {
        return;
    }

    manualAgentRunQueueProcessing = true;
    notifyAgentGenerationStateChanged();

    try {
        while (manualAgentRunQueue.length > 0) {
            if (manualAgentRunCancelRequested) {
                break;
            }

            await waitForPromptTransformIdle();

            if (manualAgentRunCancelRequested) {
                break;
            }

            const queuedRun = manualAgentRunQueue.shift();
            if (!queuedRun) {
                continue;
            }

            activeManualAgentRun = queuedRun;
            notifyAgentGenerationStateChanged();

            try {
                const result = await executeManualAgentRun(queuedRun.agentId, queuedRun.target, queuedRun.cancelRevision);
                queuedRun.resolve(result);
            } catch (error) {
                queuedRun.reject(error);
            } finally {
                activeManualAgentRun = null;
                notifyAgentGenerationStateChanged();
            }
        }
    } finally {
        clearManualAgentRunQueue();
        manualAgentRunCancelRequested = false;
        manualAgentRunQueueProcessing = false;
        activeManualAgentRun = null;
        notifyAgentGenerationStateChanged();
    }
}

/**
 * Normalizes a manual-run target. Plain numbers/strings keep the historical
 * "run on this chat message" meaning; objects can address the composer text box
 * or a companion result on a message.
 * @param {number|string|{ kind?: string, messageIndex?: number, companionAgentId?: string }} target
 * @returns {{ kind: 'message'|'composer'|'companion', messageIndex: number, companionAgentId: string }}
 */
function normalizeManualRunTarget(target) {
    if (typeof target === 'number' || typeof target === 'string') {
        return { kind: 'message', messageIndex: Number(target), companionAgentId: '' };
    }

    const kind = ['message', 'composer', 'companion'].includes(String(target?.kind ?? '').trim())
        ? String(target.kind).trim()
        : 'message';

    return {
        kind,
        messageIndex: Number(target?.messageIndex ?? -1),
        companionAgentId: String(target?.companionAgentId ?? '').trim(),
    };
}

function enqueueManualAgentRun(agentId, target) {
    const submitted = target;
    target = normalizeManualRunTarget(target);
    target.message = submitted?.message ?? chat[target.messageIndex];
    target.state = submitted?.state ?? captureMessageTargetState(target.message);
    target.composer = submitted?.composer ?? (target.kind === 'composer' ? document.querySelector('#send_textarea') : null);
    target.composerText = submitted?.composerText ?? target.composer?.value;
    target.isCurrent = typeof submitted?.isCurrent === 'function' ? submitted.isCurrent : () => true;
    const wasAlreadyActive = isAgentGenerationActive();
    manualAgentRunCancelRequested = false;
    if (!isGenerationInProgress) {
        generationStopRequested = false;
    }

    const executionMode = getGlobalSettings().appendAgentsExecutionMode === 'sequential' ? 'sequential' : 'parallel';
    const cancelRevision = agentGenerationCancelRevision;

    if (executionMode === 'parallel') {
        if (wasAlreadyActive) {
            toastr.info('Running agent in parallel.');
        }

        parallelManualRunCount++;
        notifyAgentGenerationStateChanged();

        return (async () => {
            try {
                return await executeManualAgentRun(agentId, target, cancelRevision);
            } finally {
                parallelManualRunCount = Math.max(0, parallelManualRunCount - 1);
                notifyAgentGenerationStateChanged();
            }
        })();
    }

    return new Promise((resolve, reject) => {
        manualAgentRunQueue.push({
            agentId,
            target,
            cancelRevision,
            resolve,
            reject,
        });

        if (wasAlreadyActive) {
            toastr.info('Queued agent run.');
        }

        notifyAgentGenerationStateChanged();
        void processManualAgentRunQueue();
    });
}

function isPathfinderToolAgent(agent) {
    return agent?.sourceTemplateId === 'tpl-pathfinder' ||
        agent?.name === 'Pawthfinder' ||
        agent?.name === 'Pathfinder' ||
        (agent?.category === 'tool' && agent?.tools?.some(tool => tool.name?.startsWith('Pathfinder_')));
}

export function getPathfinderRuntimeAgent(agents = getEnabledToolAgents()) {
    if (!isPathfinderSubmoduleEnabled()) {
        return null;
    }

    const owner = getEnabledToolAgents().filter(agent => isPathfinderToolAgent(agent) && isAgentRuntimeAllowed(agent))
        .sort((a, b) => (Number(a.injection?.order) || 0) - (Number(b.injection?.order) || 0) || String(a.id).localeCompare(String(b.id)))[0];
    return agents.find(agent => agent.id === owner?.id) ?? null;
}

function getAgentToolByName(agent, toolName) {
    return Array.isArray(agent?.tools)
        ? agent.tools.find(tool => tool?.name === toolName)
        : null;
}

export function isPathfinderToolEnabledForAgent(agent, toolName) {
    const states = agent?.settings?.toolStates;
    if (states && typeof states === 'object' && Object.prototype.hasOwnProperty.call(states, toolName)) {
        return states[toolName] !== false;
    }

    const savedTool = getAgentToolByName(agent, toolName);
    return savedTool?.enabled !== false;
}

function getPathfinderToolStateMap(agent) {
    return Object.fromEntries(
        getPathfinderToolDefinitions().map(tool => [tool.name, isPathfinderToolEnabledForAgent(agent, tool.name)]),
    );
}

let pathfinderPromptStoreAgentId = null;

function syncPathfinderRuntimeSettings(agent = getPathfinderRuntimeAgent()) {
    const currentRuntimeSettings = getPathfinderRuntimeSettings();
    // Adopt each newly active agent's persisted prompt store and rebuild the
    // cache. For repeated syncs of the same agent, the cache remains the
    // source of truth so unsaved in-memory edits are not overwritten.
    const agentId = agent?.id ?? null;
    const hydratePrompts = Boolean(agent?.settings) && agentId !== pathfinderPromptStoreAgentId;
    const pipelinePrompts = hydratePrompts ? (agent.settings.pipelinePrompts ?? {}) : currentRuntimeSettings.pipelinePrompts;
    const pipelines = hydratePrompts ? (agent.settings.pipelines ?? {}) : currentRuntimeSettings.pipelines;

    // Replace, not merge: merging can never clear a key, so switching
    // Pawthfinder agents would inherit the previous agent's lorebooks
    // and permissions.
    const nextRuntimeSettings = agent?.settings
        ? {
            ...agent.settings,
            toolStates: getPathfinderToolStateMap(agent),
            pipelinePrompts,
            pipelines,
        }
        : {
            pipelinePrompts,
            pipelines,
        };

    replacePathfinderRuntimeSettings(nextRuntimeSettings);

    if (hydratePrompts) {
        pathfinderPromptStoreAgentId = agentId;
        initializePromptStore(getDefaultPrompts(), getDefaultPipelines());
    }
}

function getRegisterableAgentTools(agent) {
    if (isPathfinderToolAgent(agent)) {
        if (!isPathfinderSubmoduleEnabled()) {
            return [];
        }

        const enabledTools = getPathfinderToolDefinitions()
            .filter(tool => isPathfinderToolEnabledForAgent(agent, tool.name));

        if (agent?.settings?.sidecarEnabled) {
            return enabledTools;
        }

        return enabledTools.filter(tool => tool.name === PATHFINDER_SUMMARIZE_TOOL_NAME);
    }

    return (agent.tools ?? []).filter(tool => tool.enabled !== false && tool.shouldRegister !== false);
}

/**
 * Tools whose action exists in the registry. Tools without a callable action
 * must not enter the desired set, otherwise a stale registration survives sync.
 */
function getCallableAgentTools(agent) {
    return getRegisterableAgentTools(agent).filter(tool => {
        if (getToolAction(tool.actionKey)) {
            return true;
        }
        console.warn(`[InChatAgents] Tool "${tool.name}" has actionKey "${tool.actionKey}" with no registered action. Skipping.`);
        return false;
    });
}

function isPathfinderSummarizeToolEnabled(agent) {
    return isPathfinderToolEnabledForAgent(agent, PATHFINDER_SUMMARIZE_TOOL_NAME);
}

export function getToolRecursionState() {
    return {
        depth: toolRecursionDepth,
        limit: ToolManager.RECURSE_LIMIT ?? 5,
        registeredToolNames: [...agentRegisteredToolNames],
    };
}

export async function syncPathfinderAgentLorebooksForCurrentChat(agent = getPathfinderRuntimeAgent(), { persist = false } = {}) {
    if (!isPathfinderSubmoduleEnabled()) {
        return false;
    }

    if (!agent || !isPathfinderToolAgent(agent) || !isAgentRuntimeAllowed(agent)) {
        return false;
    }

    const chatId = getCurrentSnapshotChatId();
    const revision = pathfinderChatSyncRevision;
    const books = [...new Set(getContextualLorebooks().filter(Boolean))];
    const isCurrent = () => revision === pathfinderChatSyncRevision && chatId === getCurrentSnapshotChatId()
        && getPathfinderRuntimeAgent()?.id === agent.id;
    const update = current => {
        if (!current || !isCurrent() || current.settings?.autoSyncLorebooksOnChatChange === false) return null;
        const settings = current.settings ?? {};
        const contextualBooks = books.filter(book => settings.bookPermissions?.[book]?.enabled !== false);
        const selectedLorebook = contextualBooks[0] ?? '';
        const currentBooks = settings.enabledLorebooks ?? [];
        if (currentBooks.length === contextualBooks.length && currentBooks.every((book, index) => book === contextualBooks[index])
            && (settings.selectedLorebook ?? '') === selectedLorebook) return null;
        return { ...current, settings: { ...settings, enabledLorebooks: contextualBooks, selectedLorebook } };
    };
    let saved;
    if (persist) {
        saved = await saveAgent(agent.id, { update });
    } else {
        const current = getAgentById(agent.id) ?? agent;
        saved = update(current);
        if (saved) current.settings = saved.settings;
    }
    if (!saved || !isCurrent()) return false;
    syncToolAgentRegistrations();
    notifyAgentGenerationStateChanged();

    console.info('[Pawthfinder] Synced enabled lorebooks to the current chat context.', {
        lorebooks: saved.settings.enabledLorebooks,
    });
    return true;
}

/**
 * Syncs tool registrations for all enabled tool-category agents.
 * Unregisters tools from disabled agents, registers tools from enabled ones.
 */
export function syncToolAgentRegistrations() {
    invalidateToolApprovals();
    if (pathfinderRetrievalRun && !pathfinderRetrievalRun.isCurrent()) {
        abortActivePathfinderRetrieval();
        clearPathfinderRetrievalToast();
        clearPathfinderExtensionPrompts();
    }
    if (toolSyncDuringGeneration) {
        pendingToolSync = true;
        return;
    }
    pendingToolSync = false;

    const desiredTools = new Set();
    const allEnabledToolAgents = areAgentsGloballyEnabled() ? getEnabledToolAgents() : [];
    const pathfinderAgent = getPathfinderRuntimeAgent(allEnabledToolAgents);
    const enabledToolAgents = allEnabledToolAgents.filter(agent => !isPathfinderToolAgent(agent) || agent.id === pathfinderAgent?.id);
    syncPathfinderRuntimeSettings(pathfinderAgent);

    for (const agent of enabledToolAgents) {
        for (const tool of getCallableAgentTools(agent)) {
            desiredTools.add(tool.name);
        }
    }

    for (const name of agentRegisteredToolNames) {
        if (!desiredTools.has(name)) {
            ToolManager.unregisterFunctionTool(name);
            agentRegisteredToolNames.delete(name);
        }
    }

    for (const agent of enabledToolAgents) {
        for (const toolDef of getCallableAgentTools(agent)) {
            const action = getToolAction(toolDef.actionKey);
            const formatMessage = getToolFormatter(toolDef.formatMessageKey) ?? (async () => `Calling ${toolDef.displayName}...`);

            ToolManager.registerFunctionTool({
                name: toolDef.name,
                displayName: toolDef.displayName,
                description: toolDef.description,
                parameters: toolDef.parameters,
                action: async (args, callerContext = {}) => {
                    if (!isAgentRuntimeAllowed(agent)) return '';
                    const { cancelRevision, runId, chatId } = getAgentGenerationContext();
                    const lorebookRevision = pathfinderToolRevision;
                    const controller = new AbortController();
                    const callerSignal = callerContext?.signal ?? null;
                    const callerIsCurrent = typeof callerContext?.isCurrent === 'function' ? callerContext.isCurrent : () => true;
                    const abortFromCaller = () => controller.abort();
                    if (callerSignal?.aborted) return 'The user declined this tool call. Continue the response without it and do not retry.';
                    const isCurrent = () => {
                        const liveAgent = getEnabledToolAgents().find(item => item.id === agent.id);
                        return !controller.signal.aborted && !callerSignal?.aborted && callerIsCurrent()
                            && !generationStopRequested && areAgentsGloballyEnabled()
                            && cancelRevision === agentGenerationCancelRevision && runId === postProcessingGenerationRunId
                            && lorebookRevision === pathfinderToolRevision
                            && chatId === getCurrentSnapshotChatId() && liveAgent && isAgentRuntimeAllowed(liveAgent)
                            && (!isPathfinderToolAgent(liveAgent) || getPathfinderRuntimeAgent()?.id === agent.id)
                            && getRegisterableAgentTools(liveAgent).some(tool => tool.name === toolDef.name && tool.actionKey === toolDef.actionKey)
                            && getToolAction(toolDef.actionKey) === action;
                    };
                    const declined = 'The user declined this tool call. Continue the response without it and do not retry.';
                    if (!isCurrent()) return declined;

                    activeToolApprovals.set(controller, isCurrent);
                    try {
                        callerSignal?.addEventListener?.('abort', abortFromCaller, { once: true });
                        let prepared = { args, options: { signal: controller.signal, isCurrent } };
                        if (shouldConfirmToolCall(toolDef.name, getEnabledToolAgents().find(item => item.id === agent.id)?.settings)) {
                            prepared = await prepareToolCall(toolDef, args, prepared.options);
                            if (!isCurrent()) return declined;
                            const approved = await confirmToolCall(toolDef.displayName ?? toolDef.name, prepared.args, controller.signal);
                            if (!approved) return declined;
                        }
                        if (!isAgentRuntimeAllowed(agent)) return '';
                        if (!isCurrent()) return declined;
                        return await action(prepared.args, prepared.options);
                    } finally {
                        callerSignal?.removeEventListener?.('abort', abortFromCaller);
                        activeToolApprovals.delete(controller);
                    }
                },
                formatMessage,
                shouldRegister: async () => isAgentRuntimeAllowed(agent),
                stealth: toolDef.stealth ?? false,
            });

            agentRegisteredToolNames.add(toolDef.name);
        }
    }
}

/**
 * Unregisters all agent-owned tools from ToolManager.
 */
export function unregisterAllAgentTools() {
    for (const name of agentRegisteredToolNames) {
        ToolManager.unregisterFunctionTool(name);
    }
    agentRegisteredToolNames.clear();
}

function normalizeGenerationType(generationType) {
    switch (String(generationType ?? '').trim().toLowerCase()) {
        case 'continue':
        case GREETING_GENERATION_TYPE:
        case 'impersonate':
        case 'quiet':
        case COMPANION_OUTPUT_GENERATION_TYPE:
            return String(generationType).trim().toLowerCase();
        default:
            return 'normal';
    }
}

function isGreetingGenerationType(generationType) {
    return String(generationType ?? '').trim().toLowerCase() === GREETING_GENERATION_TYPE;
}

function isImpersonateGenerationType(generationType) {
    return normalizeGenerationType(generationType) === IMPERSONATE_GENERATION_TYPE;
}

function getUserMessageName() {
    try {
        const context = getContext();
        const userName = String(context?.name1 ?? '').trim();

        return userName || 'User';
    } catch {
        return 'User';
    }
}

function getStreamingTarget(messageIndex) {
    if (!Number.isInteger(Number(messageIndex))) {
        return null;
    }

    const liveStreamingProcessor = streamingProcessor;
    if (!liveStreamingProcessor || Number(liveStreamingProcessor.messageId) !== Number(messageIndex)) {
        return null;
    }

    return liveStreamingProcessor;
}

function isStreamingMessageStillActive(messageIndex) {
    const liveStreamingProcessor = getStreamingTarget(messageIndex);
    if (!liveStreamingProcessor) {
        return false;
    }

    return Boolean(
        !liveStreamingProcessor.isFinished ||
        isGenerationInProgress ||
        isBodyGenerationFlagBlocking(),
    );
}

function isBodyGenerationFlagBlocking() {
    if (document.body?.dataset?.generating !== 'true') {
        return false;
    }

    if (isGenerationInProgress) {
        return true;
    }

    if (!lastMainGenerationEndedAt) {
        return false;
    }

    return Date.now() - lastMainGenerationEndedAt < BODY_GENERATING_FLAG_GRACE_MS;
}

function isMainGenerationStillActive() {
    return Boolean(
        isGenerationInProgress ||
        isBodyGenerationFlagBlocking(),
    );
}

function wasStreamingMessageStopped(messageIndex) {
    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex)) {
        return false;
    }

    if (stoppedStreamingMessageIndexes.has(numericMessageIndex)) {
        return true;
    }

    const liveStreamingProcessor = getStreamingTarget(messageIndex);
    if (!liveStreamingProcessor) {
        return false;
    }

    const isStopped = Boolean(
        generationStopRequested ||
        liveStreamingProcessor.isStopped ||
        liveStreamingProcessor.abortController?.signal?.aborted,
    );

    if (isStopped) {
        stoppedStreamingMessageIndexes.add(numericMessageIndex);
    }

    return isStopped;
}

function clearDeferredPostProcessing(messageIndex = null) {
    if (messageIndex !== null && messageIndex !== undefined) {
        const numericMessageIndex = Number(messageIndex);
        if (Number.isInteger(numericMessageIndex)) {
            deferredPostProcessingQueue.delete(numericMessageIndex);
        }
    } else {
        deferredPostProcessingQueue.clear();
    }

    if (deferredPostProcessingQueue.size === 0 && deferredPostProcessingTimeout) {
        clearTimeout(deferredPostProcessingTimeout);
        deferredPostProcessingTimeout = null;
    }
}

function clearLatestAssistantPostProcessingFallback() {
    if (!latestAssistantPostProcessingFallbackTimeout) {
        latestAssistantPostProcessingFallbackDeadline = 0;
        return;
    }

    clearTimeout(latestAssistantPostProcessingFallbackTimeout);
    latestAssistantPostProcessingFallbackTimeout = null;
    latestAssistantPostProcessingFallbackDeadline = 0;
}

function clearPostGenerationRecoveryCheck() {
    if (!postGenerationRecoveryTimeout) {
        return;
    }

    clearTimeout(postGenerationRecoveryTimeout);
    postGenerationRecoveryTimeout = null;
}

function clearMissedGenerationEndRecoveryCheck() {
    if (!missedGenerationEndRecoveryTimeout) {
        return;
    }

    clearTimeout(missedGenerationEndRecoveryTimeout);
    missedGenerationEndRecoveryTimeout = null;
}

function clearPostGenerationStateAfterCompletion() {
    if (
        isGenerationInProgress ||
        internalPromptTransformDepth > 0 ||
        postProcessingInFlightKeys.size > 0 ||
        deferredPostProcessingQueue.size > 0 ||
        generationStopRequested ||
        postProcessingInvalidatedByChatChange
    ) {
        return;
    }

    pendingGenerationSnapshot = null;
    clearLatestAssistantPostProcessingFallback();
    clearPostGenerationRecoveryCheck();
    clearMissedGenerationEndRecoveryCheck();
}

function normalizeSnapshotChatId(chatId) {
    return chatId === null || chatId === undefined ? '' : String(chatId);
}

function getCurrentSnapshotChatId() {
    try {
        return normalizeSnapshotChatId(getCurrentChatId());
    } catch {
        return '';
    }
}

function isActivationSnapshotForCurrentChat(snapshot) {
    if (!snapshot) {
        return false;
    }

    return normalizeSnapshotChatId(snapshot.chatId) === getCurrentSnapshotChatId();
}

function isCurrentGenerationChatStale() {
    return generationStartChatId && generationStartChatId !== getCurrentSnapshotChatId();
}

function clearPendingPostProcessingForChatChange() {
    if (isGenerationInProgress || pendingGenerationSnapshot || deferredPostProcessingQueue.size > 0) {
        postProcessingInvalidatedByChatChange = true;
    }

    isGenerationInProgress = false;
    agentGenerationCancelRevision++;
    invalidateToolApprovals();
    abortActiveAgentRequests();
    abortActivePathfinderRetrieval();
    clearPathfinderRetrievalToast();
    clearInChatAgentExtensionPrompts();
    releaseToolAgentRegistrations();
    generationStopRequested = false;
    generationStartChatId = getCurrentSnapshotChatId();
    pendingGenerationSnapshot = null;
    processedPostProcessingRunsByIndex.clear();
    clearDeferredPostProcessing();
    clearLatestAssistantPostProcessingFallback();
    clearPostGenerationRecoveryCheck();
    clearMissedGenerationEndRecoveryCheck();
    notifyAgentGenerationStateChanged();
}

function clearStalePendingGenerationSnapshot() {
    if (!pendingGenerationSnapshot || isActivationSnapshotForCurrentChat(pendingGenerationSnapshot)) {
        return false;
    }

    clearPendingPostProcessingForChatChange();
    return true;
}

function cloneActivationSnapshot(snapshot, generationType) {
    const normalizedGenerationType = normalizeGenerationType(snapshot?.generationType ?? generationType);
    const snapshotChatId = snapshot && Object.hasOwn(snapshot, 'chatId')
        ? snapshot.chatId
        : getCurrentSnapshotChatId();

    return {
        generationType: normalizedGenerationType,
        activeAgentIds: Array.isArray(snapshot?.activeAgentIds)
            ? [...snapshot.activeAgentIds]
            : [],
        chatId: normalizeSnapshotChatId(snapshotChatId),
    };
}

function normalizeMessageRunValue(value) {
    if (value instanceof Date) {
        return value.toISOString();
    }

    if (value === null || value === undefined) {
        return '';
    }

    return String(value);
}

function getActiveSwipeInfo(message, { create = false } = {}) {
    if (!message || message.is_user) {
        return null;
    }

    if (create) {
        ensureSwipes(message);
    }

    if (typeof message.swipe_id !== 'number' || !Array.isArray(message.swipe_info)) {
        return null;
    }

    const swipeInfo = message.swipe_info[message.swipe_id];
    if (!swipeInfo || typeof swipeInfo !== 'object') {
        return null;
    }

    if (create && (!swipeInfo.extra || typeof swipeInfo.extra !== 'object')) {
        swipeInfo.extra = {};
    }

    return swipeInfo;
}

function cloneAgentExtraValue(value) {
    return value === undefined ? undefined : structuredClone(value);
}

export function getAgentExtraValue(message, key) {
    const swipeInfo = getActiveSwipeInfo(message);
    if (swipeInfo?.extra && key in swipeInfo.extra) {
        return swipeInfo.extra[key];
    }

    // Messages saved before swipe_info existed get a backfilled empty swipe extra; the
    // history still lives on message.extra, so fall back to it rather than losing it.
    return message?.extra?.[key];
}

export function setAgentExtraValue(message, key, value) {
    if (!message) {
        return;
    }

    message.extra ??= {};
    message.extra[key] = value;

    const swipeInfo = getActiveSwipeInfo(message, { create: true });
    if (swipeInfo?.extra) {
        swipeInfo.extra[key] = cloneAgentExtraValue(value);
    }
}

export function deleteAgentExtraValue(message, key) {
    if (!message) {
        return;
    }

    if (message.extra && Object.hasOwn(message.extra, key)) {
        delete message.extra[key];
    }

    const swipeInfo = getActiveSwipeInfo(message);
    if (swipeInfo?.extra && Object.hasOwn(swipeInfo.extra, key)) {
        delete swipeInfo.extra[key];
    }
}

function hasAgentExtraValue(message, key) {
    const swipeInfo = getActiveSwipeInfo(message);
    if (swipeInfo?.extra) {
        return Object.hasOwn(swipeInfo.extra, key);
    }

    return Boolean(
        (message?.extra && Object.hasOwn(message.extra, key)),
    );
}

function syncAssistantMessageTextToSwipe(message) {
    if (!message || message.is_user || message.is_system) {
        return;
    }

    ensureSwipes(message);

    if (typeof message.swipe_id === 'number' && Array.isArray(message.swipes) && typeof message.swipes[message.swipe_id] === 'string') {
        message.swipes[message.swipe_id] = message.mes;
    }
}

function getPostProcessingRunKey(message, generationType, activationSnapshot = null) {
    const snapshotAgentIds = Array.isArray(activationSnapshot?.activeAgentIds)
        ? activationSnapshot.activeAgentIds.join(',')
        : '';
    const swipeInfo = getActiveSwipeInfo(message);

    return [
        normalizeGenerationType(activationSnapshot?.generationType ?? generationType),
        normalizeMessageRunValue(swipeInfo?.gen_started ?? message?.gen_started),
        normalizeMessageRunValue(swipeInfo?.gen_finished ?? message?.gen_finished),
        normalizeMessageRunValue(swipeInfo?.send_date ?? message?.send_date),
        normalizeMessageRunValue(message?.swipe_id),
        snapshotAgentIds,
    ].join('|');
}

function getPostProcessingIndexRunKey(message, messageIndex, generationType, activationSnapshot = null) {
    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex)) {
        return '';
    }

    const snapshotAgentIds = Array.isArray(activationSnapshot?.activeAgentIds)
        ? activationSnapshot.activeAgentIds.join(',')
        : '';

    return [
        postProcessingGenerationRunId,
        numericMessageIndex,
        Number.isInteger(Number(message?.swipe_id)) ? Number(message.swipe_id) : 0,
        normalizeGenerationType(activationSnapshot?.generationType ?? generationType),
        snapshotAgentIds,
    ].join('|');
}

function getStoredPostProcessingRuns(message) {
    const storedRuns = getAgentExtraValue(message, POST_PROCESSING_RUNS_EXTRA_KEY);
    return Array.isArray(storedRuns)
        ? storedRuns
        : [];
}

function getMessageRevisionKey(message) {
    const swipeInfo = getActiveSwipeInfo(message);

    return [
        normalizeMessageRunValue(swipeInfo?.gen_started ?? message?.gen_started),
        normalizeMessageRunValue(swipeInfo?.gen_finished ?? message?.gen_finished),
        normalizeMessageRunValue(swipeInfo?.send_date ?? message?.send_date),
        normalizeMessageRunValue(message?.swipe_id),
    ].join('|');
}

function getPathfinderRetrievalCacheTarget(generationType) {
    if (normalizeGenerationType(generationType) !== 'normal') {
        return null;
    }

    if (generationStartLastAssistantIndex < 0 || generationStartLastAssistantIndex !== chat.length - 1) {
        return null;
    }

    const message = chat[generationStartLastAssistantIndex];
    if (!message || message !== generationStartLastAssistantMessage || message.is_user || message.is_system) {
        return null;
    }

    return {
        message,
        messageIndex: generationStartLastAssistantIndex,
    };
}

function getPathfinderCacheMessageRole(message) {
    if (message?.is_system) {
        return 'system';
    }

    return message?.is_user ? 'user' : 'assistant';
}

function getPathfinderRetrievalContextSnapshot(targetMessageIndex) {
    const endIndex = Math.max(0, Number(targetMessageIndex));
    const startIndex = Math.max(0, endIndex - PATHFINDER_RETRIEVAL_CONTEXT_MESSAGE_LIMIT);

    return chat.slice(startIndex, endIndex).map((message, offset) => ({
        index: startIndex + offset,
        role: getPathfinderCacheMessageRole(message),
        name: normalizeMessageRunValue(message?.name),
        mes: normalizeMessageRunValue(message?.mes),
        swipeId: normalizeMessageRunValue(message?.swipe_id),
        sendDate: normalizeMessageRunValue(message?.send_date),
        genStarted: normalizeMessageRunValue(message?.gen_started),
        genFinished: normalizeMessageRunValue(message?.gen_finished),
    }));
}

function normalizePathfinderCacheValue(value, seen = new WeakSet()) {
    if (value instanceof Date) {
        return value.toISOString();
    }

    if (Array.isArray(value)) {
        return value.map(item => normalizePathfinderCacheValue(item, seen));
    }

    if (value && typeof value === 'object') {
        if (seen.has(value)) {
            return '[Circular]';
        }

        seen.add(value);
        const normalized = {};
        for (const key of Object.keys(value).sort()) {
            const item = value[key];
            if (typeof item === 'function' || item === undefined) {
                continue;
            }

            normalized[key] = normalizePathfinderCacheValue(item, seen);
        }
        seen.delete(value);
        return normalized;
    }

    if (typeof value === 'bigint') {
        return String(value);
    }

    return value ?? null;
}

function getPathfinderRetrievalSettingsSnapshot(pathfinderAgent) {
    let runtimeSettings = {};
    try {
        runtimeSettings = getPathfinderRuntimeSettings() ?? {};
    } catch {
        runtimeSettings = {};
    }

    return normalizePathfinderCacheValue({
        agentId: pathfinderAgent?.id ?? '',
        settings: pathfinderAgent?.settings ?? {},
        runtimeSettings,
    });
}

function buildPathfinderRetrievalCacheSignature(pathfinderAgent, activationSnapshot, generationType, cacheTarget) {
    if (!cacheTarget) {
        return '';
    }

    const signaturePayload = normalizePathfinderCacheValue({
        version: 2,
        cacheSession: pathfinderRetrievalCacheSession,
        lorebookRevision: pathfinderRetrievalCacheRevision,
        chatId: normalizeSnapshotChatId(activationSnapshot?.chatId ?? getCurrentSnapshotChatId()),
        generationType: normalizeGenerationType(generationType),
        targetMessageIndex: cacheTarget.messageIndex,
        promptKeys: PATHFINDER_RETRIEVAL_PROMPT_KEYS,
        context: getPathfinderRetrievalContextSnapshot(cacheTarget.messageIndex),
        pathfinder: getPathfinderRetrievalSettingsSnapshot(pathfinderAgent),
    });

    try {
        return JSON.stringify(signaturePayload);
    } catch {
        return '';
    }
}

function isPathfinderRetrievalCacheEntry(value) {
    return Boolean(
        value &&
        typeof value === 'object' &&
        typeof value.signature === 'string' &&
        Array.isArray(value.prompts),
    );
}

function appendPathfinderRetrievalCaches(target, value) {
    if (Array.isArray(value)) {
        target.push(...value.filter(isPathfinderRetrievalCacheEntry));
    }
}

function getStoredPathfinderRetrievalCaches(message) {
    const caches = [];
    appendPathfinderRetrievalCaches(caches, message?.extra?.[PATHFINDER_RETRIEVAL_CACHE_EXTRA_KEY]);

    if (Array.isArray(message?.swipe_info)) {
        for (const swipeInfo of message.swipe_info) {
            appendPathfinderRetrievalCaches(caches, swipeInfo?.extra?.[PATHFINDER_RETRIEVAL_CACHE_EXTRA_KEY]);
        }
    }

    const deduped = new Map();
    for (const cache of caches) {
        deduped.set(cache.signature, cache);
    }

    return [...deduped.values()];
}

function findPathfinderRetrievalCache(message, signature) {
    if (!signature) {
        return null;
    }

    return getStoredPathfinderRetrievalCaches(message).find(cache => cache.signature === signature) ?? null;
}

function getPathfinderPromptValue(key) {
    const prompt = extension_prompts[key];
    if (!prompt || prompt.value === undefined || prompt.value === null) {
        return '';
    }

    return String(prompt.value);
}

function capturePathfinderRetrievalPromptSnapshot() {
    return PATHFINDER_RETRIEVAL_PROMPT_KEYS
        .map(key => ({ key, value: getPathfinderPromptValue(key) }))
        .filter(prompt => prompt.value.trim());
}

function restorePathfinderRetrievalPromptSnapshot(cache) {
    if (!isPathfinderRetrievalCacheEntry(cache)) {
        return false;
    }

    for (const prompt of cache.prompts) {
        if (!PATHFINDER_RETRIEVAL_PROMPT_KEYS.includes(prompt?.key) || typeof prompt.value !== 'string' || !prompt.value.trim()) {
            continue;
        }

        setExtensionPrompt(
            prompt.key,
            prompt.value,
            extension_prompt_types.IN_PROMPT,
            4,
            false,
            extension_prompt_roles.SYSTEM,
        );
    }

    return true;
}

function storePathfinderRetrievalCache(message, signature, retrieval) {
    if (!message || !signature) {
        return;
    }

    const cacheEntry = {
        signature,
        prompts: capturePathfinderRetrievalPromptSnapshot(),
        retrieval: { ...retrieval, stageResults: [], metadata: {} },
        savedAt: Date.now(),
    };
    const caches = getStoredPathfinderRetrievalCaches(message).filter(cache => cache.signature !== signature);
    caches.push(cacheEntry);

    setAgentExtraValue(message, PATHFINDER_RETRIEVAL_CACHE_EXTRA_KEY, caches.slice(-MAX_PATHFINDER_RETRIEVAL_CACHE));
    saveChatDebouncedForAgent();
}

function hasProcessedPostProcessingRun(message, runKey, messageIndex = null, indexRunKey = '') {
    const numericMessageIndex = Number(messageIndex);
    const indexRuns = Number.isInteger(numericMessageIndex)
        ? processedPostProcessingRunsByIndex.get(numericMessageIndex)
        : null;

    return Boolean(
        runKey &&
        (
            processedPostProcessingRuns.get(message)?.has(runKey) ||
            getStoredPostProcessingRuns(message).includes(runKey) ||
            indexRuns?.includes(runKey) ||
            (indexRunKey && indexRuns?.includes(indexRunKey))
        ),
    );
}

function markPostProcessingRunProcessed(message, runKey, messageIndex = null, indexRunKey = '') {
    if (!message || !runKey) {
        return false;
    }

    let processedRuns = processedPostProcessingRuns.get(message);
    if (!processedRuns) {
        processedRuns = new Set();
        processedPostProcessingRuns.set(message, processedRuns);
    }

    processedRuns.add(runKey);
    const storedRuns = getStoredPostProcessingRuns(message).filter(value => value !== runKey);
    storedRuns.push(runKey);
    setAgentExtraValue(message, POST_PROCESSING_RUNS_EXTRA_KEY, storedRuns.slice(-MAX_TRANSFORM_HISTORY));

    const numericMessageIndex = Number(messageIndex);
    if (Number.isInteger(numericMessageIndex)) {
        const indexRuns = (processedPostProcessingRunsByIndex.get(numericMessageIndex) ?? [])
            .filter(value => value !== runKey && value !== indexRunKey);
        indexRuns.push(runKey);
        if (indexRunKey) {
            indexRuns.push(indexRunKey);
        }
        processedPostProcessingRunsByIndex.set(numericMessageIndex, indexRuns.slice(-MAX_TRANSFORM_HISTORY));
    }

    return true;
}

function getDeferredActivationSnapshot(generationType) {
    return cloneActivationSnapshot(
        pendingGenerationSnapshot ?? buildActivationSnapshot(generationType),
        generationType,
    );
}

function isAssistantPostProcessingGenerationType(generationType) {
    return !isGreetingGenerationType(generationType) && !isImpersonateGenerationType(generationType);
}

function deferPostProcessing(messageIndex, generationType, activationSnapshot = null) {
    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex)) {
        return;
    }

    const snapshot = activationSnapshot
        ? cloneActivationSnapshot(activationSnapshot, generationType)
        : getDeferredActivationSnapshot(generationType);

    deferredPostProcessingQueue.set(numericMessageIndex, {
        messageIndex: numericMessageIndex,
        generationType: snapshot.generationType,
        message: chat[numericMessageIndex] ?? null,
        activationSnapshot: snapshot,
        wasStreamingStopped: wasStreamingMessageStopped(numericMessageIndex),
    });

    if (!isGenerationInProgress) {
        scheduleDeferredPostProcessingFlush(DEFERRED_POST_PROCESSING_RETRY_MS);
        schedulePostGenerationRecoveryCheck(DEFERRED_POST_PROCESSING_RETRY_MS);
    } else {
        scheduleMissedGenerationEndRecoveryCheck();
    }
}

function isDeferredPostProcessingMessageCurrent(pendingMessage) {
    if (!isActivationSnapshotForCurrentChat(pendingMessage.activationSnapshot)) {
        return false;
    }

    const message = chat[pendingMessage.messageIndex];

    if (!message || message.is_user || message.is_system) {
        return false;
    }

    if (message === pendingMessage.message) {
        return true;
    }

    if (pendingMessage.message && getMessageRevisionKey(message) === getMessageRevisionKey(pendingMessage.message)) {
        return true;
    }

    if (pendingMessage.messageIndex >= generationStartChatLength) {
        return true;
    }

    return isGenerationAssistantCandidate(pendingMessage.messageIndex, message);
}

function scheduleDeferredPostProcessingFlush(delayMs = 0) {
    if (deferredPostProcessingTimeout) {
        clearTimeout(deferredPostProcessingTimeout);
    }

    deferredPostProcessingTimeout = setTimeout(async () => {
        deferredPostProcessingTimeout = null;

        if (deferredPostProcessingQueue.size === 0 || generationStopRequested) {
            return;
        }

        if (isGenerationInProgress) {
            return;
        }

        if (isBodyGenerationFlagBlocking()) {
            scheduleDeferredPostProcessingFlush(DEFERRED_POST_PROCESSING_RETRY_MS);
            return;
        }

        const pendingMessages = [...deferredPostProcessingQueue.values()]
            .sort((a, b) => a.messageIndex - b.messageIndex);

        for (const pendingMessage of pendingMessages) {
            if (!deferredPostProcessingQueue.has(pendingMessage.messageIndex)) {
                continue;
            }

            if (!isDeferredPostProcessingMessageCurrent(pendingMessage)) {
                deferredPostProcessingQueue.delete(pendingMessage.messageIndex);
                continue;
            }

            if (pendingMessage.wasStreamingStopped || wasStreamingMessageStopped(pendingMessage.messageIndex)) {
                deferredPostProcessingQueue.delete(pendingMessage.messageIndex);
                continue;
            }

            if (isStreamingMessageStillActive(pendingMessage.messageIndex)) {
                scheduleDeferredPostProcessingFlush(DEFERRED_POST_PROCESSING_RETRY_MS);
                return;
            }

            deferredPostProcessingQueue.delete(pendingMessage.messageIndex);
            await processReceivedMessage(pendingMessage.messageIndex, pendingMessage.generationType, pendingMessage.activationSnapshot);

            if (generationStopRequested) {
                clearDeferredPostProcessing();
                return;
            }

            if (isMainGenerationStillActive()) {
                scheduleDeferredPostProcessingFlush(DEFERRED_POST_PROCESSING_RETRY_MS);
                return;
            }
        }

        clearPostGenerationStateAfterCompletion();

        if (deferredPostProcessingQueue.size > 0) {
            scheduleDeferredPostProcessingFlush();
        }
    }, delayMs);
}

function clearLatestAssistantPostProcessingFallbackTimer() {
    if (!latestAssistantPostProcessingFallbackTimeout) {
        return;
    }

    clearTimeout(latestAssistantPostProcessingFallbackTimeout);
    latestAssistantPostProcessingFallbackTimeout = null;
}

function scheduleLatestAssistantPostProcessingFallback(delayMs = DEFERRED_POST_PROCESSING_RETRY_MS) {
    clearLatestAssistantPostProcessingFallbackTimer();

    if (clearStalePendingGenerationSnapshot()) {
        latestAssistantPostProcessingFallbackDeadline = 0;
        return;
    }

    if (!latestAssistantPostProcessingFallbackDeadline) {
        latestAssistantPostProcessingFallbackDeadline = Date.now() + LATEST_ASSISTANT_POST_PROCESSING_FALLBACK_WINDOW_MS;
    }

    latestAssistantPostProcessingFallbackTimeout = setTimeout(() => {
        latestAssistantPostProcessingFallbackTimeout = null;

        if (!pendingGenerationSnapshot || generationStopRequested || isGenerationInProgress) {
            latestAssistantPostProcessingFallbackDeadline = 0;
            return;
        }

        if (isBodyGenerationFlagBlocking()) {
            if (Date.now() < latestAssistantPostProcessingFallbackDeadline) {
                scheduleLatestAssistantPostProcessingFallback(DEFERRED_POST_PROCESSING_RETRY_MS);
            } else {
                latestAssistantPostProcessingFallbackDeadline = 0;
            }
            return;
        }

        const queueResult = queueLatestAssistantPostProcessingFromSnapshot();
        scheduleDeferredPostProcessingFlush();

        if (queueResult.retry && Date.now() < latestAssistantPostProcessingFallbackDeadline) {
            scheduleLatestAssistantPostProcessingFallback(DEFERRED_POST_PROCESSING_RETRY_MS);
        } else {
            latestAssistantPostProcessingFallbackDeadline = 0;
        }
    }, delayMs);
}

function hasPostGenerationRecoveryWork() {
    if (postProcessingInvalidatedByChatChange || isCurrentGenerationChatStale()) {
        clearPendingPostProcessingForChatChange();
        return false;
    }

    if (clearStalePendingGenerationSnapshot()) {
        return false;
    }

    return Boolean(
        !generationStopRequested &&
        (
            deferredPostProcessingQueue.size > 0 ||
            pendingGenerationSnapshot?.activeAgentIds?.length > 0
        ),
    );
}

function schedulePostGenerationRecoveryCheck(delayMs = 0) {
    if (!hasPostGenerationRecoveryWork() || isGenerationInProgress) {
        return;
    }

    if (postGenerationRecoveryTimeout) {
        clearTimeout(postGenerationRecoveryTimeout);
    }

    postGenerationRecoveryTimeout = setTimeout(() => {
        postGenerationRecoveryTimeout = null;

        if (!hasPostGenerationRecoveryWork() || isGenerationInProgress) {
            return;
        }

        queueLatestAssistantPostProcessingFromSnapshot();
        scheduleDeferredPostProcessingFlush();

        if (deferredPostProcessingQueue.size > 0 && !isBodyGenerationFlagBlocking()) {
            scheduleDeferredPostProcessingFlush();
        }
    }, delayMs);
}

function hasRecoverableAssistantPostProcessingCandidate() {
    if (postProcessingInvalidatedByChatChange || isCurrentGenerationChatStale()) {
        clearPendingPostProcessingForChatChange();
        return false;
    }

    if (clearStalePendingGenerationSnapshot() || !pendingGenerationSnapshot || generationStopRequested) {
        return false;
    }

    const activationSnapshot = cloneActivationSnapshot(pendingGenerationSnapshot, pendingGenerationSnapshot.generationType);
    if (!isAssistantPostProcessingGenerationType(activationSnapshot.generationType)) {
        return false;
    }

    if (activationSnapshot.activeAgentIds.length === 0) {
        return false;
    }

    const messageIndex = getLatestAssistantMessageIndex();
    if (messageIndex < 0) {
        return false;
    }

    const message = chat[messageIndex];
    if (!isGenerationAssistantCandidate(messageIndex, message)) {
        return false;
    }

    const runKey = getPostProcessingRunKey(message, activationSnapshot.generationType, activationSnapshot);
    const indexRunKey = getPostProcessingIndexRunKey(message, messageIndex, activationSnapshot.generationType, activationSnapshot);
    return !hasProcessedPostProcessingRun(message, runKey, messageIndex, indexRunKey);
}

function hasActiveStreamingProcessorIgnoringGenerationFlag(messageIndex) {
    const liveStreamingProcessor = getStreamingTarget(messageIndex);
    if (!liveStreamingProcessor) {
        return false;
    }

    return Boolean(
        !liveStreamingProcessor.isFinished &&
        !liveStreamingProcessor.isStopped &&
        !liveStreamingProcessor.abortController?.signal?.aborted,
    );
}

function canRecoverMissedGenerationEnd() {
    if (!isGenerationInProgress || !hasRecoverableAssistantPostProcessingCandidate()) {
        return false;
    }

    const messageIndex = getLatestAssistantMessageIndex();
    const message = chat[messageIndex];

    if (hasActiveStreamingProcessorIgnoringGenerationFlag(messageIndex)) {
        return false;
    }

    if (message?.gen_finished) {
        return true;
    }

    if (document.body?.dataset?.generating !== 'true') {
        return true;
    }

    return Date.now() - generationStartedAt > BODY_GENERATING_FLAG_GRACE_MS;
}

function recoverMissedGenerationEnd(reason = 'fallback') {
    if (clearStalePendingGenerationSnapshot() || !canRecoverMissedGenerationEnd()) {
        return false;
    }

    console.warn(`[InChatAgents] Recovering missed generation end via ${reason}; flushing queued post-processing.`);
    isGenerationInProgress = false;
    lastMainGenerationEndedAt = Date.now() - BODY_GENERATING_FLAG_GRACE_MS;
    releaseToolAgentRegistrations();
    generationStopRequested = false;
    clearMissedGenerationEndRecoveryCheck();
    clearInitialGenerationToast();
    queueLatestAssistantPostProcessingFromSnapshot();
    scheduleDeferredPostProcessingFlush();
    schedulePostGenerationRecoveryCheck();
    latestAssistantPostProcessingFallbackDeadline = Date.now() + LATEST_ASSISTANT_POST_PROCESSING_FALLBACK_WINDOW_MS;
    scheduleLatestAssistantPostProcessingFallback();
    return true;
}

function scheduleMissedGenerationEndRecoveryCheck(delayMs = MISSED_GENERATION_END_RECOVERY_MS) {
    if (!isGenerationInProgress || generationStopRequested) {
        return;
    }

    if (missedGenerationEndRecoveryTimeout) {
        clearTimeout(missedGenerationEndRecoveryTimeout);
    }

    missedGenerationEndRecoveryTimeout = setTimeout(() => {
        missedGenerationEndRecoveryTimeout = null;

        if (recoverMissedGenerationEnd('watchdog')) {
            return;
        }

        if (isGenerationInProgress && hasRecoverableAssistantPostProcessingCandidate()) {
            scheduleMissedGenerationEndRecoveryCheck();
        }
    }, delayMs);
}

function observePostGenerationRecoveryTargets() {
    if (!postGenerationRecoveryObserver) {
        return;
    }

    try {
        if (document.body) {
            postGenerationRecoveryObserver.observe(document.body, {
                attributes: true,
                attributeFilter: ['data-generating'],
            });
        }

        const chatElement = document.getElementById?.('chat') ?? document.querySelector?.('#chat');
        if (chatElement) {
            postGenerationRecoveryObserver.observe(chatElement, {
                childList: true,
                subtree: true,
            });
        }
    } catch (error) {
        console.warn('[InChatAgents] Could not start post-generation recovery observer:', error);
    }
}

function initPostGenerationRecoveryHooks() {
    if (postGenerationRecoveryHooksInitialized) {
        return;
    }

    postGenerationRecoveryHooksInitialized = true;
    const scheduleRecovery = () => {
        if (!recoverMissedGenerationEnd('event')) {
            scheduleMissedGenerationEndRecoveryCheck();
        }
        schedulePostGenerationRecoveryCheck();
    };
    const observeAndScheduleRecovery = () => {
        observePostGenerationRecoveryTargets();
        scheduleRecovery();
    };

    if (typeof MutationObserver === 'function') {
        try {
            postGenerationRecoveryObserver = new MutationObserver(scheduleRecovery);
            observePostGenerationRecoveryTargets();
        } catch (error) {
            console.warn('[InChatAgents] Could not start post-generation recovery observer:', error);
        }
    }

    if (typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', scheduleRecovery);
        document.addEventListener('DOMContentLoaded', observeAndScheduleRecovery);
    }

    const windowTarget = globalThis.window ?? globalThis;
    if (typeof windowTarget.addEventListener === 'function') {
        windowTarget.addEventListener('pageshow', scheduleRecovery);
        windowTarget.addEventListener('focus', scheduleRecovery);
    }
}

/**
 * Checks whether an agent should activate this turn.
 * @param {import('./agent-store.js').InChatAgent} agent
 * @param {string} generationType
 * @returns {boolean}
 */
function shouldActivate(agent, generationType) {
    const conditions = agent.conditions;

    if (conditions.generationTypes?.length > 0 && !conditions.generationTypes.includes(generationType)) {
        return false;
    }

    if (conditions.triggerProbability < 100 && Math.random() * 100 > conditions.triggerProbability) {
        return false;
    }

    if (conditions.triggerKeywords?.length > 0) {
        const triggerMessage = isCompanionAgent(agent)
            ? getLatestUserMessageText()
            : String(chat[chat.length - 1]?.mes ?? '');
        const lowerMessage = triggerMessage.toLowerCase();
        const hasKeyword = conditions.triggerKeywords.some(keyword => isCompanionAgent(agent)
            ? companionTriggerMatches(keyword, triggerMessage)
            : lowerMessage.includes(String(keyword ?? '').toLowerCase()));
        if (!hasKeyword) {
            return false;
        }
    }

    return true;
}

function getLatestAssistantMessageIndex() {
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (message && !message.is_user && !message.is_system) {
            return index;
        }
    }

    return -1;
}

function isGenerationAssistantCandidate(messageIndex, message) {
    if (!message || message.is_user || message.is_system) {
        return false;
    }

    if (messageIndex >= generationStartChatLength) {
        return true;
    }

    if (message === generationStartLastAssistantMessage) {
        return getMessageRevisionKey(message) !== generationStartLastAssistantRevision;
    }

    return generationStartLastAssistantIndex >= 0 &&
        messageIndex === generationStartLastAssistantIndex &&
        messageIndex === chat.length - 1;
}

function queueLatestAssistantPostProcessingFromSnapshot() {
    if (postProcessingInvalidatedByChatChange || isCurrentGenerationChatStale()) {
        clearPendingPostProcessingForChatChange();
        return { queued: false, retry: false };
    }

    if (clearStalePendingGenerationSnapshot() || !pendingGenerationSnapshot || generationStopRequested) {
        return { queued: false, retry: false };
    }

    const activationSnapshot = cloneActivationSnapshot(pendingGenerationSnapshot, pendingGenerationSnapshot.generationType);
    if (!isAssistantPostProcessingGenerationType(activationSnapshot.generationType)) {
        return { queued: false, retry: false };
    }

    if (activationSnapshot.activeAgentIds.length === 0) {
        return { queued: false, retry: false };
    }

    const messageIndex = getLatestAssistantMessageIndex();
    if (messageIndex < 0) {
        return { queued: false, retry: true };
    }

    const message = chat[messageIndex];
    if (!isGenerationAssistantCandidate(messageIndex, message)) {
        return { queued: false, retry: true };
    }

    if (wasStreamingMessageStopped(messageIndex)) {
        return { queued: false, retry: false };
    }

    const runKey = getPostProcessingRunKey(message, activationSnapshot.generationType, activationSnapshot);
    const indexRunKey = getPostProcessingIndexRunKey(message, messageIndex, activationSnapshot.generationType, activationSnapshot);

    if (hasProcessedPostProcessingRun(message, runKey, messageIndex, indexRunKey)) {
        return { queued: false, retry: false };
    }

    deferPostProcessing(messageIndex, activationSnapshot.generationType, activationSnapshot);
    return { queued: true, retry: false };
}

function buildActivationSnapshot(generationType) {
    const normalizedGenerationType = normalizeGenerationType(generationType);
    const chatId = getCurrentSnapshotChatId();
    if (!areAgentsGloballyEnabled()) {
        return {
            generationType: normalizedGenerationType,
            activeAgentIds: [],
            chatId,
        };
    }

    const activeAgents = getEnabledAgents().filter(agent => shouldActivate(agent, normalizedGenerationType));

    return {
        generationType: normalizedGenerationType,
        activeAgentIds: activeAgents.map(agent => agent.id),
        chatId,
    };
}

function getSnapshotAgents(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.activeAgentIds)) {
        return [];
    }

    return snapshot.activeAgentIds
        .map(id => getAgentById(id))
        .filter(agent => agent && isAgentRuntimeAllowed(agent));
}

function getActiveAgentsForMessage(generationType, activationSnapshot = null) {
    const snapshot = activationSnapshot ?? pendingGenerationSnapshot ?? buildActivationSnapshot(generationType);
    return getSnapshotAgents(snapshot);
}

export function buildPromptDynamicMacros(messageText = '', message = null, agent = null, generationType = 'normal') {
    const normalizedGenerationType = normalizeGenerationType(generationType);
    const assistantName = String(message?.name ?? '').trim();
    const agentName = String(agent?.name ?? '').trim();

    return {
        currentMessage: messageText,
        lastMessage: messageText,
        latestMessage: messageText,
        response: messageText,
        currentResponse: messageText,
        latestResponse: messageText,
        assistantMessage: messageText,
        assistantName,
        agentName,
        generationType: normalizedGenerationType,
    };
}

function updateMessageRegexSnapshot(message, activeAgents, generationType) {
    message.extra ??= {};
    const inlineAgents = activeAgents.filter(agent => !isCompanionAgent(agent) && isAgentRuntimeAllowed(agent));
    const regexScriptRefs = inlineAgents.flatMap(agent => {
        const scripts = getAgentRegexScripts(agent);
        cacheAgentRegexScripts(agent?.id, scripts);
        return buildRegexScriptRefsForAgent(agent?.id, scripts);
    });

    if (regexScriptRefs.length === 0) {
        if (hasAgentExtraValue(message, MESSAGE_EXTRA_KEY)) {
            deleteAgentExtraValue(message, MESSAGE_EXTRA_KEY);
            return true;
        }

        return false;
    }

    const previousSnapshot = getAgentExtraValue(message, MESSAGE_EXTRA_KEY);
    const nextSnapshot = {
        activeAgentIds: inlineAgents.map(agent => agent.id),
        generationType: normalizeGenerationType(generationType),
        regexScriptRefs,
        edited: Boolean(previousSnapshot?.edited),
    };

    const previousComparable = previousSnapshot
        ? {
            activeAgentIds: previousSnapshot.activeAgentIds,
            generationType: previousSnapshot.generationType,
            regexScriptRefs: previousSnapshot.regexScriptRefs,
            edited: Boolean(previousSnapshot.edited),
        }
        : null;

    if (JSON.stringify(previousComparable) === JSON.stringify(nextSnapshot)) {
        return false;
    }

    setAgentExtraValue(message, MESSAGE_EXTRA_KEY, nextSnapshot);
    return true;
}

function ensureMessageRegexSnapshot(messageIndex, generationType, activationSnapshot = null, options = {}) {
    const { refresh = true, save = true } = options;
    if (!isAssistantPostProcessingGenerationType(activationSnapshot?.generationType ?? generationType)) {
        return false;
    }

    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex)) {
        return false;
    }

    const message = chat[numericMessageIndex];
    if (!message || message.is_user || message.is_system) {
        return false;
    }

    const resolvedActivationSnapshot = activationSnapshot
        ? cloneActivationSnapshot(activationSnapshot, generationType)
        : getDeferredActivationSnapshot(generationType);
    const activeAgents = getActiveAgentsForMessage(generationType, resolvedActivationSnapshot);

    if (!updateMessageRegexSnapshot(message, activeAgents, generationType)) {
        if (save && pendingRegexSnapshotSaves.has(message)) {
            pendingRegexSnapshotSaves.delete(message);
            saveChatDebouncedForAgent();
        }

        return false;
    }

    if (save) {
        pendingRegexSnapshotSaves.delete(message);
        saveChatDebouncedForAgent();
    } else {
        pendingRegexSnapshotSaves.add(message);
    }

    if (refresh) {
        scheduleMessageRefresh(numericMessageIndex, message, { deferBackup: shouldDeferAgentRegularBackup(), skipReloadFallback: true });
    }

    return true;
}

function isRegexRefreshAgentCandidate(agent, generationType, { respectGenerationTypes = true } = {}) {
    if (!agent || !isAgentRuntimeAllowed(agent) || isCompanionAgent(agent) || getAgentRegexScripts(agent).length === 0) {
        return false;
    }

    if (!respectGenerationTypes) {
        return true;
    }

    const normalizedGenerationType = normalizeGenerationType(generationType);
    const generationTypes = agent.conditions?.generationTypes;
    return !Array.isArray(generationTypes)
        || generationTypes.length === 0
        || generationTypes.includes(normalizedGenerationType);
}

function getRegexSnapshotRefreshAgents(message, agentId, generationType, { includeForcedAgent = false, respectGenerationTypes = true } = {}) {
    const enabledAgentsById = new Map(getEnabledAgents().map(agent => [agent.id, agent]));
    const previousSnapshot = getAgentExtraValue(message, MESSAGE_EXTRA_KEY);
    const agentIds = new Set(Array.isArray(previousSnapshot?.activeAgentIds) ? previousSnapshot.activeAgentIds : []);

    if (agentId) {
        agentIds.add(agentId);
    }

    const refreshAgents = [];
    for (const id of agentIds) {
        let agent = enabledAgentsById.get(id);

        if (!agent && includeForcedAgent && id === agentId) {
            agent = getAgentById(id);
        }

        if (isRegexRefreshAgentCandidate(agent, generationType, { respectGenerationTypes })) {
            refreshAgents.push(agent);
        }
    }

    return refreshAgents;
}

function refreshRegexSnapshotForAgentOnMessage(agentId, messageIndex, options = {}) {
    const {
        generationType = 'normal',
        includeForcedAgent = false,
        refresh = true,
        respectGenerationTypes = true,
        save = true,
        markPendingSave = !save,
    } = options;
    const normalizedGenerationType = normalizeGenerationType(generationType);
    if (!isAssistantPostProcessingGenerationType(normalizedGenerationType)) {
        return false;
    }

    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex)) {
        return false;
    }

    const message = chat[numericMessageIndex];
    if (!message || message.is_user || message.is_system) {
        return false;
    }

    const activeAgents = getRegexSnapshotRefreshAgents(message, agentId, normalizedGenerationType, {
        includeForcedAgent,
        respectGenerationTypes,
    });

    if (!updateMessageRegexSnapshot(message, activeAgents, normalizedGenerationType)) {
        return false;
    }

    if (save) {
        pendingRegexSnapshotSaves.delete(message);
        saveChatDebouncedForAgent();
    } else if (markPendingSave) {
        pendingRegexSnapshotSaves.add(message);
    }

    if (refresh) {
        scheduleMessageRefresh(numericMessageIndex, message, { deferBackup: shouldDeferAgentRegularBackup(), skipReloadFallback: true });
    }

    return true;
}

export function refreshRegexSnapshotsForAgent(agentId, { generationType = 'normal' } = {}) {
    let refreshed = 0;
    for (let messageIndex = 0; messageIndex < chat.length; messageIndex++) {
        if (refreshRegexSnapshotForAgentOnMessage(agentId, messageIndex, {
            generationType,
            markPendingSave: false,
            save: false,
        })) {
            refreshed++;
        }
    }

    if (refreshed > 0) {
        saveChatDebouncedForAgent();
    }

    return refreshed;
}

export function resolveAgentConnectionProfile(agent) {
    const profile = getCompanionReferenceIds(agent).includes('tpl-expressions-agent')
        ? resolveExpressionsAgentProfile(agent, extension_settings)
        : agent?.connectionProfile;
    return isCompanionAgent(agent)
        ? resolveCompanionConnectionProfile(profile)
        : resolveConnectionProfile(profile);
}

function getPromptTransformAgents(activeAgents) {
    return activeAgents.filter(agent =>
        !isCompanionAgent(agent) &&
        (agent.phase === 'post' || agent.phase === 'both') &&
        agent.postProcess?.promptTransformEnabled &&
        String(agent.prompt ?? '').trim(),
    );
}

function getPromptTransformAgentsForMessage(activeAgents, generationType) {
    if (isGreetingGenerationType(generationType)) {
        // Greeting messages should remain untouched by prompt-based rewrites/appends.
        return [];
    }

    if (isImpersonateGenerationType(generationType)) {
        return [];
    }

    return getPromptTransformAgents(activeAgents);
}

function agentOptedIntoImpersonatePasses(agent) {
    if (agent?.conditions?.runOnImpersonate) {
        return true;
    }

    const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
    return IMPERSONATE_PROMPT_TRANSFORM_TEMPLATE_IDS.has(sourceTemplateId);
}

function getPromptTransformAgentsForImpersonate(activeAgents) {
    return getPromptTransformAgents(activeAgents).filter(agentOptedIntoImpersonatePasses);
}

function getRegexAgentsForImpersonate(activeAgents) {
    return activeAgents.filter(agent =>
        !isCompanionAgent(agent) &&
        !isToolAgent(agent) &&
        agentOptedIntoImpersonatePasses(agent) &&
        getAgentRegexScripts(agent).length > 0,
    );
}

/**
 * Applies the given agents' ST-style regex scripts directly to a plain text value
 * (impersonation composer text or a companion result), outside the message
 * regex-snapshot display pipeline. Runs the display-mode pass first so the common
 * markdownOnly scripts apply, then the raw-text pass for scripts with both mode
 * flags off.
 * @param {object[]} agents
 * @param {string} text
 * @param {{ characterOverride?: string, includeDisplay?: boolean, isEdit?: boolean }} [options]
 * @returns {string}
 */
function applyAgentRegexScriptsToText(agents, text, { characterOverride = '', includeDisplay = true, isEdit = false } = {}) {
    let output = String(text ?? '');
    if (!output) {
        return output;
    }

    const baseOptions = {
        characterOverride,
        isEdit,
        substituteParamsFn: substituteParams,
        substituteParamsExtendedFn: substituteParamsExtended,
    };

    for (const agent of agents) {
        if (isCompanionAgent(agent) || isToolAgent(agent) || !isAgentRuntimeAllowed(agent)) {
            continue;
        }
        const scripts = getAgentRegexScripts(agent);
        if (scripts.length === 0) {
            continue;
        }

        if (includeDisplay) output = applyRegexScriptList(output, scripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, { ...baseOptions, isMarkdown: true });
        output = applyRegexScriptList(output, scripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, baseOptions);
    }

    return output;
}

function companionOutputPassTargetsCompanion(agent, companionReferenceIdSet) {
    const targetIds = Array.isArray(agent?.conditions?.companionOutputTargetAgentIds)
        ? agent.conditions.companionOutputTargetAgentIds.map(id => String(id ?? '').trim().toLowerCase()).filter(Boolean)
        : [];

    if (targetIds.length === 0) {
        return true;
    }

    return targetIds.some(id => companionReferenceIdSet.has(id));
}

function getCompanionOutputPostPassAgents(companionAgent) {
    if (!areAgentsGloballyEnabled()) {
        return [];
    }

    const companionReferenceIdSet = new Set(getCompanionReferenceIds(companionAgent).map(id => id.toLowerCase()));

    return getEnabledAgents().filter(agent =>
        agent.id !== companionAgent?.id &&
        !isCompanionAgent(agent) &&
        !isToolAgent(agent) &&
        agent?.conditions?.runOnCompanionOutputs &&
        companionOutputPassTargetsCompanion(agent, companionReferenceIdSet),
    );
}

function getPreGenerationInterceptAgents(activeAgents) {
    return activeAgents.filter(agent =>
        !isToolAgent(agent) &&
        !isCompanionAgent(agent) &&
        (agent.phase === 'pre' || agent.phase === 'both') &&
        agent.preProcess?.mode === 'intercept' &&
        agent.preProcess?.interceptTiming !== POST_MAIN_GENERATION_INTERCEPT_TIMING &&
        String(agent.prompt ?? '').trim(),
    ).sort((a, b) => Number(a?.injection?.order ?? 100) - Number(b?.injection?.order ?? 100));
}

function getPostMainGenerationInterceptAgents(activeAgents) {
    return activeAgents.filter(agent =>
        !isToolAgent(agent) &&
        !isCompanionAgent(agent) &&
        (agent.phase === 'pre' || agent.phase === 'both') &&
        agent.preProcess?.mode === 'intercept' &&
        agent.preProcess?.interceptTiming === POST_MAIN_GENERATION_INTERCEPT_TIMING &&
        String(agent.prompt ?? '').trim(),
    ).sort((a, b) => Number(a?.injection?.order ?? 100) - Number(b?.injection?.order ?? 100));
}

function describePromptTransformMode(mode) {
    return mode === 'append' ? 'prompt append' : 'prompt rewrite';
}

function shouldShowPromptTransformNotifications(agent) {
    return Boolean(
        getGlobalSettings()?.promptTransformShowNotifications &&
        agent?.postProcess?.promptTransformEnabled &&
        agent?.postProcess?.promptTransformShowNotifications,
    );
}

function shouldShowPreInterceptNotifications(agent) {
    return Boolean(
        getGlobalSettings()?.promptTransformShowNotifications &&
        agent?.preProcess?.mode === 'intercept',
    );
}

function shouldShowPostMainInterceptMessageFirst() {
    return getGlobalSettings()?.postMainInterceptShowMessageFirst !== false;
}

function describePromptTransformTarget(profileId = '', runner = '') {
    if (runner === 'main') {
        return 'the main model';
    }

    if (profileId) {
        return `profile "${getConnectionProfileDisplayName(profileId)}"`;
    }

    return 'the main model';
}

function getPromptTransformProfileLabel(profileId = '') {
    return profileId ? getConnectionProfileDisplayName(profileId) : 'Main model';
}

function getPromptTransformModelLabel(agent, profileId = '') {
    const modelOverride = String(agent?.modelOverride ?? '').trim();
    if (modelOverride) {
        return modelOverride;
    }

    if (!profileId) {
        return getPromptTransformProfileLabel(profileId);
    }

    const modelName = getConnectionProfileModelName(profileId);
    const profileLabel = getConnectionProfileDisplayName(profileId);
    if (modelName && profileLabel) {
        return `${modelName} (${profileLabel})`;
    }

    return modelName || profileLabel || getPromptTransformProfileLabel(profileId);
}

function getPromptTransformRunMetadata(agent, profileId = '') {
    return {
        order: Number(agent?.injection?.order ?? 0),
        profileLabel: getPromptTransformProfileLabel(profileId),
        modelLabel: getPromptTransformModelLabel(agent, profileId),
    };
}

function showPromptTransformRunningToast(agent, mode, profileId = '', options = {}) {
    const agentName = agent?.name || 'In-Chat Agent';
    const modeLabel = describePromptTransformMode(mode);
    const targetLabel = describePromptTransformTarget(profileId, profileId ? 'profile' : 'main');
    const metadata = getPromptTransformRunMetadata(agent, profileId);
    const cancelButtonClass = 'ica--toast-cancel-agent';
    const kind = ['preIntercept', 'postMainIntercept'].includes(String(options?.kind))
        ? String(options.kind)
        : 'postGen';
    const applyMode = ['wrap', 'patch'].includes(String(options?.applyMode))
        ? String(options.applyMode)
        : 'replace';
    const skipChanges = Boolean(options?.skipChanges && kind === 'postMainIntercept');
    const cancelHandler = typeof options?.onCancel === 'function'
        ? options.onCancel
        : cancelAgentGeneration;
    const runningLabel = skipChanges
        ? 'Generating main output for pre-generation intercept'
        : kind === 'preIntercept'
            ? `Running pre-generation ${applyMode} intercept...`
            : kind === 'postMainIntercept'
                ? `Running post-main ${applyMode} intercept...`
                : `Running ${modeLabel} via ${targetLabel}...`;
    const cancelLabel = skipChanges ? 'Skip changes' : 'Cancel Agent';
    const messageHtml = `
        <div>${escapeToastHtml(runningLabel)}</div>
        <div>${escapeToastHtml(`Order ${metadata.order} | Model: ${metadata.modelLabel}`)}</div>
        <button type="button" class="menu_button menu_button_icon caution ${cancelButtonClass}">
            <i class="fa-solid fa-stop"></i>
            <span>${escapeToastHtml(cancelLabel)}</span>
        </button>
    `;

    const toast = toastr.info(messageHtml, escapeToastHtml(agentName), {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        escapeHtml: false,
        onShown() {
            const toastElement = this instanceof HTMLElement ? this : this?.[0];
            const cancelButton = toastElement?.querySelector?.(`.${cancelButtonClass}`);
            cancelButton?.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                cancelHandler();
            });
        },
    });

    if (toast) {
        activePromptTransformToasts.add(toast);
    }

    return toast;
}

function clearPromptTransformRunningToast(toast) {
    if (!toast) {
        return;
    }

    activePromptTransformToasts.delete(toast);
    toastr.clear(toast, { force: true });
}

function clearAllPromptTransformRunningToasts() {
    for (const toast of activePromptTransformToasts) {
        toastr.clear(toast, { force: true });
    }

    activePromptTransformToasts.clear();

    $('.toast').filter((_, element) => {
        const title = $(element).find('.toast-title').text().trim();
        const message = $(element).find('.toast-message').text().trim();
        return $(element).find('.ica--toast-cancel-agent').length > 0 ||
            (title === 'In-Chat Agent' && /^Running (?:prompt (?:rewrite|append) via |pre-generation )/u.test(message));
    }).each((_, element) => toastr.clear($(element), { force: true }));
}

async function commitOpenEditorForMessage(messageIndex) {
    if (!Number.isInteger(Number(messageIndex))) {
        return;
    }

    const editorDoneButton = $(`.mes[mesid="${Number(messageIndex)}"] .mes_edit_done:visible`).first();
    if (!editorDoneButton.length) {
        return;
    }

    editorDoneButton.trigger('click');
    await Promise.resolve();
}

function syncPromptTransformMessageState(message, messageIndex) {
    if (!message || message.is_user || message.is_system) {
        return;
    }

    if (message.extra?.display_text) {
        delete message.extra.display_text;
    }

    syncAssistantMessageTextToSwipe(message);
}

async function syncPromptTransformMessageStateAsync(message, messageIndex) {
    const target = captureMessageTargetState(message);
    if (!isMessageTargetCurrent(message, target, messageIndex)) return false;
    syncPromptTransformMessageState(message, messageIndex);

    if (!message || message.is_user || message.is_system) {
        return true;
    }

    try {
        await updateMessageTokenAccounting(message);
    } catch (error) {
        // Neconyan: token counting is bookkeeping. A tokenizer or provider hiccup here must not
        // abort the rest of post-processing, which would silently skip companion agents.
        console.warn('[InChatAgents] Token accounting failed; continuing agent work:', error);
    }
    if (!isMessageTargetCurrent(message, target, messageIndex)) return false;

    if (messageIndex === null || messageIndex === undefined || messageIndex === '') {
        return true;
    }

    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex)) {
        return true;
    }

    const messageElement = document.querySelector(`.mes[mesid="${numericMessageIndex}"]`);
    const context = getContext();
    if (messageElement && typeof context?.updateMessageMetaBadges === 'function') {
        context.updateMessageMetaBadges(messageElement, message);
    }
    return true;
}

function syncAssistantMessageStateToSwipe(message, messageIndex) {
    if (!message || message.is_user || message.is_system) {
        return;
    }

    ensureSwipes(message);

    if (typeof message.swipe_id === 'number' && Array.isArray(message.swipes) && typeof message.swipes[message.swipe_id] === 'string') {
        message.swipes[message.swipe_id] = message.mes;
    }

    syncMesToSwipe(messageIndex);
}

function showPromptTransformResultToast(agent, result) {
    const agentName = agent?.name || result?.agentName || 'In-Chat Agent';

    switch (result?.status) {
        case 'changed':
            toastr.success('', agentName, { timeOut: 3000 });
            break;
        case 'unchanged':
            toastr.info('no change', agentName, { timeOut: 2000 });
            break;
        case 'empty-response': {
            const targetLabel = describePromptTransformTarget(result?.profileId, result?.runner);
            const modeLabel = describePromptTransformMode(result?.mode);
            toastr.warning(`${modeLabel} ran via ${targetLabel} but returned an empty response.`, agentName, {
                timeOut: 7000,
                extendedTimeOut: 10000,
            });
            break;
        }
        case 'error': {
            const targetLabel = describePromptTransformTarget(result?.profileId, result?.runner);
            const modeLabel = describePromptTransformMode(result?.mode);
            toastr.error(
                result?.error
                    ? `${modeLabel} failed via ${targetLabel}: ${result.error}`
                    : `${modeLabel} failed via ${targetLabel}.`,
                agentName,
                {
                    timeOut: 10000,
                    extendedTimeOut: 12000,
                },
            );
            break;
        }
    }
}

function updatePromptTransformRuns(message, runs) {
    message.extra ??= {};

    if (!Array.isArray(runs) || runs.length === 0) {
        if (hasAgentExtraValue(message, PROMPT_RUNS_EXTRA_KEY)) {
            deleteAgentExtraValue(message, PROMPT_RUNS_EXTRA_KEY);
            return true;
        }

        return false;
    }

    setAgentExtraValue(message, PROMPT_RUNS_EXTRA_KEY, runs.map(result => sanitizePromptTransformRunForStorage(result)));
    return true;
}

function updatePromptTransformHistory(message, run) {
    if (!message || !run || !run.changed) {
        return false;
    }

    const storedHistory = getAgentExtraValue(message, PROMPT_TRANSFORM_HISTORY_KEY);
    const history = getPromptTransformHistoryForText(storedHistory, run.beforeText);
    const nextEntry = {
        agentId: run.agentId,
        agentName: run.agentName,
        mode: run.mode,
        order: run.order,
        profileLabel: run.profileLabel,
        modelLabel: run.modelLabel,
        beforeText: normalizeContentText(run.beforeText),
        afterText: normalizeContentText(run.nextMessageText),
        timestamp: run.timestamp,
    };

    history.push(nextEntry);

    const scopedHistory = getPromptTransformHistoryForText(history, run.nextMessageText);
    if (!scopedHistory.includes(nextEntry)) {
        scopedHistory.length = 0;
        scopedHistory.push(nextEntry);
    }

    while (scopedHistory.length > MAX_TRANSFORM_HISTORY) {
        scopedHistory.shift();
    }

    setAgentExtraValue(message, PROMPT_TRANSFORM_HISTORY_KEY, scopedHistory);
    deleteAgentExtraValue(message, PROMPT_TRANSFORM_REDO_KEY);
    return true;
}

function recordAppliedTransformation(message, beforeText, runs, label = 'Agent post-processing') {
    const changedRuns = runs.filter(run => run.changed);
    return updatePromptTransformHistory(message, {
        ...changedRuns.at(-1),
        agentName: changedRuns.map(run => run.agentName).join(', ') || label,
        beforeText,
        nextMessageText: message.mes,
        changed: beforeText !== message.mes,
        timestamp: new Date().toISOString(),
    });
}

function reconcileTrackerMetadata(agents = getEnabledAgents()) {
    let updates = 0;
    for (const agent of agents) {
        if (isCompanionAgent(agent) || !isAgentRuntimeAllowed(agent)
            || !agent.postProcess?.enabled || agent.postProcess.type !== 'extract') continue;
        const key = getTrackerMetadataKey(agent);
        if (!key) continue;
        let value = '';
        for (let index = chat.length - 1; index >= 0; index--) {
            const message = chat[index];
            if (!message || message.is_user || message.is_system) continue;
            value = getTrackerRepairPayload(agent, message.mes).payload;
            if (value) break;
        }
        if (writeTrackerMetadataValue(chat_metadata, key, value)) updates++;
    }
    return updates;
}

function shouldRefreshTransformHistoryUi(messageIndex, message) {
    const numericMessageIndex = Number(messageIndex);
    if (!Number.isInteger(numericMessageIndex) || !message || message.is_user || message.is_system) {
        return false;
    }

    const messageElement = document.querySelector(`.mes[mesid="${numericMessageIndex}"]`);
    return Boolean(messageElement && hasAgentDocumentHistory(message) && !messageElement.querySelector('.agent-transform-badge'));
}

function getPromptTransformHistoryForText(history, currentText) {
    const entries = Array.isArray(history) ? history : [];
    const scopedHistory = [];
    let expectedAfterText = normalizeContentText(currentText);

    // Keep only the contiguous edit chain that produced the active message text.
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry || typeof entry !== 'object') {
            continue;
        }

        const afterText = normalizeContentText(entry.afterText);
        if (afterText !== expectedAfterText) {
            continue;
        }

        scopedHistory.unshift(entry);
        expectedAfterText = normalizeContentText(entry.beforeText);
    }

    return scopedHistory;
}

export function getPromptTransformHistoryForMessage(message) {
    const storedHistory = getAgentExtraValue(message, PROMPT_TRANSFORM_HISTORY_KEY);
    return getPromptTransformHistoryForText(storedHistory, message?.mes);
}

function getPreGenerationInterceptHistoryFromValue(history) {
    return Array.isArray(history)
        ? history.filter(entry => entry && typeof entry === 'object')
        : [];
}

export function getPreGenerationInterceptHistoryForMessage(message) {
    return getPreGenerationInterceptHistoryFromValue(
        getAgentExtraValue(message, PRE_GENERATION_INTERCEPT_HISTORY_KEY),
    );
}

function hasAgentDocumentHistory(message) {
    return getPromptTransformHistoryForMessage(message).length > 0 ||
        getPreGenerationInterceptHistoryForMessage(message).length > 0;
}

function unwrapAssistantResponseWrapper(value) {
    let text = normalizeContentText(value);
    let previousText = null;
    let passCount = 0;

    while (text !== previousText && passCount < 8) {
        previousText = text;
        const match = text.match(ASSISTANT_RESPONSE_WRAPPER_RE);
        if (!match) {
            break;
        }

        text = match[1];
        passCount += 1;
    }

    return text;
}

function unwrapContextInterceptOutput(value = '') {
    let text = unwrapAssistantResponseWrapper(value);
    let previousText = null;
    let passCount = 0;

    while (text !== previousText && passCount < 8) {
        previousText = text;
        const match = text.match(CONTEXT_INTERCEPT_OUTPUT_RE);
        if (!match) {
            break;
        }

        text = match[1];
        passCount += 1;
    }

    return text;
}

function serializeChatContext(chatMessages) {
    return JSON.stringify(Array.isArray(chatMessages) ? chatMessages : [], null, 2);
}

function parseChatContext(value) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('Intercepted chat context must be a non-empty JSON array of chat messages.');
    }

    const allowedRoles = new Set(['system', 'user', 'assistant', 'tool']);
    const pendingCalls = new Set();
    const seenCalls = new Set();
    let hasUsableContent = false;
    for (const [index, message] of parsed.entries()) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            throw new Error(`Intercepted chat message at index ${index} must be an object.`);
        }

        if (!allowedRoles.has(message.role)) {
            throw new Error(`Intercepted chat message at index ${index} has an unsupported role.`);
        }

        const hasContent = typeof message.content === 'string' || (Array.isArray(message.content) && message.content.length > 0);
        const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
        if (!hasContent && !hasToolCalls) {
            throw new Error(`Intercepted chat message at index ${index} must include content or tool_calls.`);
        }
        if (Array.isArray(message.content)) {
            for (const part of message.content) {
                const validPart = part && typeof part === 'object' && !Array.isArray(part) && (
                    (part.type === 'text' && typeof part.text === 'string')
                    || (['image_url', 'video_url'].includes(part.type) && typeof part[part.type]?.url === 'string' && part[part.type].url.trim())
                    || (part.type === 'input_audio' && typeof part.input_audio?.data === 'string' && typeof part.input_audio?.format === 'string')
                    || (part.type === 'file' && (typeof part.file?.file_id === 'string' || typeof part.file?.file_data === 'string'))
                );
                if (!validPart) throw new Error(`Intercepted chat message at index ${index} has an invalid content part.`);
                hasUsableContent ||= part.type !== 'text' || Boolean(part.text.trim());
            }
        } else if (typeof message.content === 'string') {
            hasUsableContent ||= Boolean(message.content.trim());
        }
        if (message.role === 'tool') {
            if (typeof message.tool_call_id !== 'string' || !pendingCalls.delete(message.tool_call_id)) {
                throw new Error(`Intercepted chat message at index ${index} has no matching tool call.`);
            }
        } else if (pendingCalls.size) {
            throw new Error('Intercepted chat context is missing a tool result.');
        }
        if (message.tool_calls !== undefined) {
            if (message.role !== 'assistant' || !hasToolCalls) {
                throw new Error(`Intercepted chat message at index ${index} has invalid tool_calls.`);
            }
            for (const call of message.tool_calls) {
                if (!call || typeof call.id !== 'string' || !call.id.trim() || seenCalls.has(call.id)
                    || call.type !== 'function' || typeof call.function?.name !== 'string' || !call.function.name.trim()
                    || typeof call.function.arguments !== 'string') {
                    throw new Error(`Intercepted chat message at index ${index} has an invalid tool call.`);
                }
                pendingCalls.add(call.id);
                seenCalls.add(call.id);
            }
            hasUsableContent = true;
        }
    }
    if (!hasUsableContent || pendingCalls.size) throw new Error('Intercepted chat context is empty or missing a tool result.');

    return parsed;
}

function buildPatchTaggedText(text, preProcess = {}) {
    const startTag = String(preProcess.patchStartTag ?? '').trim() || '<context_patch>';
    const endTag = String(preProcess.patchEndTag ?? '').trim() || '</context_patch>';
    return `${startTag}\n${text}\n${endTag}`;
}

function applyContextInterceptText(originalText, interceptText, preProcess = {}) {
    const outputText = unwrapContextInterceptOutput(interceptText);
    const applyMode = preProcess.applyMode === 'wrap' || preProcess.applyMode === 'patch'
        ? preProcess.applyMode
        : 'replace';

    if (applyMode === 'wrap') {
        const wrappedText = `${String(preProcess.wrapPrefix ?? '')}${outputText}${String(preProcess.wrapSuffix ?? '')}`;
        if (preProcess.wrapPosition === 'before') {
            return joinPromptTransformText(wrappedText, originalText);
        }

        return joinPromptTransformText(originalText, wrappedText);
    }

    if (applyMode === 'patch') {
        return joinPromptTransformText(originalText, buildPatchTaggedText(outputText, preProcess));
    }

    return outputText;
}

function buildPromptTransformMessages(agentPrompt, messageText, assistantName, generationType, mode) {
    const isImpersonate = isImpersonateGenerationType(generationType);
    const isCompanionOutput = normalizeGenerationType(generationType) === COMPANION_OUTPUT_GENERATION_TYPE;
    const targetLabel = isImpersonate
        ? 'generated impersonation text'
        : isCompanionOutput
            ? 'companion agent note'
            : 'assistant response';
    const originalLabel = isImpersonate
        ? 'original text'
        : isCompanionOutput
            ? 'original note'
            : 'original response';
    const contentLabel = isImpersonate ? 'text' : isCompanionOutput ? 'note' : 'response';
    const actionInstruction = mode === 'append'
        ? `Generate only the new content that should be appended after the ${targetLabel} according to the instructions above. Do not repeat, rewrite, summarize, or quote the original ${targetLabel}. Return only the appended content, with no labels or commentary unless the appended content itself requires them.`
        : `Rewrite the ${targetLabel} according to the instructions above. Return only the final rewritten ${targetLabel}. If no changes are needed, return the ${originalLabel} verbatim. Do not add commentary, labels, or code fences unless the ${contentLabel} itself requires them.`;
    const currentAssistantResponse = unwrapAssistantResponseWrapper(messageText);
    const responseLabel = isImpersonate
        ? 'Current generated impersonation text'
        : isCompanionOutput
            ? 'Current companion agent note'
            : 'Current assistant response';

    return [
        {
            role: 'system',
            content: `${agentPrompt}\n\n${actionInstruction}`,
        },
        {
            role: 'user',
            content: `Assistant name: ${assistantName || 'Assistant'}\nGeneration type: ${generationType}\n\n${responseLabel}:\n<assistant_response>\n${currentAssistantResponse}\n</assistant_response>`,
        },
    ];
}

function buildContextInterceptMessages(agentPrompt, contextText, generationType, contextFormat, timing = PRE_GENERATION_INTERCEPT_TIMING) {
    if (timing === POST_MAIN_GENERATION_INTERCEPT_TIMING) {
        return [
            {
                role: 'system',
                content: `${agentPrompt}\n\nYou are modifying the assistant response after the main model generated it, before it is shown or saved. Return only the final assistant response requested by the instructions above. Do not add commentary, labels, or code fences unless they are part of the response itself. If no changes are needed, return the original response verbatim.`,
            },
            {
                role: 'user',
                content: `Generation type: ${generationType}\n\nMain model output:\n<assistant_response>\n${contextText}\n</assistant_response>`,
            },
        ];
    }

    const formatLabel = contextFormat === 'chat' ? 'JSON array of chat-completion messages' : 'plain text completion prompt';

    return [
        {
            role: 'system',
            content: `${agentPrompt}\n\nYou are modifying the complete outgoing context before the main model sees it. Return only the revised context content requested by the instructions above. Do not add commentary, labels, or code fences unless they are part of the context itself. If no changes are needed, return the original context content verbatim.`,
        },
        {
            role: 'user',
            content: `Generation type: ${generationType}\nContext format: ${formatLabel}\n\nOutgoing context:\n<context>\n${contextText}\n</context>`,
        },
    ];
}

function appendPromptTransformOutput(originalText, appendedText) {
    const baseText = unwrapAssistantResponseWrapper(originalText);
    const addition = unwrapAssistantResponseWrapper(appendedText).trim();

    if (!addition) {
        return baseText;
    }

    if (!baseText) {
        return addition;
    }

    if (baseText.endsWith('\n\n')) {
        return baseText + addition;
    }

    if (baseText.endsWith('\n')) {
        return `${baseText}\n${addition}`;
    }

    return `${baseText}\n\n${addition}`;
}

function joinPromptTransformText(leftText, rightText) {
    const left = unwrapAssistantResponseWrapper(leftText);
    const right = unwrapAssistantResponseWrapper(rightText);

    if (!left) {
        return right;
    }

    if (!right) {
        return left;
    }

    if (left.endsWith('\n\n') || right.startsWith('\n\n')) {
        return left + right;
    }

    if (left.endsWith('\n') || right.startsWith('\n')) {
        return `${left}\n${right}`;
    }

    return `${left}\n\n${right}`;
}

function shouldPrependPromptTransformOutput(agent, outputText = '') {
    const templateId = String(agent?.sourceTemplateId ?? '').trim();
    if (PREPEND_PROMPT_TRANSFORM_TEMPLATE_IDS.has(templateId)) {
        return true;
    }

    return PREPEND_PROMPT_TRANSFORM_TAG_RE.test(normalizeContentText(outputText));
}

function sanitizePromptTransformRunForStorage(result) {
    if (!result || typeof result !== 'object') {
        return result;
    }

    // Keep beforeText and nextMessageText for diff/undo — only strip raw outputText
    const storedResult = { ...result };
    delete storedResult.outputText;
    return storedResult;
}

function sanitizePreGenerationInterceptRunForStorage(result) {
    if (!result || typeof result !== 'object') {
        return result;
    }

    return {
        agentId: result.agentId,
        agentName: result.agentName,
        applyMode: result.applyMode,
        timing: result.timing === POST_MAIN_GENERATION_INTERCEPT_TIMING
            ? POST_MAIN_GENERATION_INTERCEPT_TIMING
            : PRE_GENERATION_INTERCEPT_TIMING,
        contextFormat: result.contextFormat,
        status: result.status,
        changed: Boolean(result.changed),
        beforeText: normalizeContentText(result.beforeText),
        afterText: normalizeContentText(result.afterText),
        outputText: normalizeContentText(result.outputText),
        profileId: result.profileId ?? '',
        runner: result.runner ?? '',
        role: result.role ?? '',
        timestamp: result.timestamp,
        error: result.error,
    };
}

/**
 * Intercept results belong to the generation (and chat) that produced them.
 * A result that settles after a newer generation started, or after a chat
 * change, must not be attached to whatever reply arrives next.
 * @param {{ chatId: string, runId: number, cancelRevision: number }} origin
 */
function isInterceptOriginCurrent(origin) {
    return Boolean(origin)
        && origin.runId === postProcessingGenerationRunId
        && origin.cancelRevision === agentGenerationCancelRevision
        && origin.chatId === getCurrentSnapshotChatId();
}

function getGenerationRecord(origin = getAgentGenerationContext(), create = false) {
    const key = JSON.stringify([origin.chatId, origin.runId, origin.cancelRevision]);
    if (!pendingGenerationRecords.has(key) && create) {
        pendingGenerationRecords.set(key, { key, origin, runs: [], snapshot: null });
        // Unclaimed replies from abandoned requests must not retain prompt text indefinitely.
        while (pendingGenerationRecords.size > 8) pendingGenerationRecords.delete(pendingGenerationRecords.keys().next().value);
    }
    return pendingGenerationRecords.get(key);
}

/** @type {WeakMap<object, object>} */
const claimedInterceptRunsByMessage = new WeakMap();

/**
 * Moves the pending intercept results onto the reply that just arrived, so a
 * later generation (for example the next group member) cannot clear or consume
 * them before this reply's deferred post-processing runs.
 * @param {object} message
 */
function claimPendingInterceptRunsForMessage(message, origin = getAgentGenerationContext()) {
    const existing = claimedInterceptRunsByMessage.get(message);
    if (existing?.origin.runId === origin.runId && existing.origin.cancelRevision === origin.cancelRevision && existing.origin.chatId === origin.chatId && existing.swipeId === (message.swipe_id ?? 0)) return existing;
    const record = getGenerationRecord(origin, true);
    const claimed = { ...record, swipeId: message.swipe_id ?? 0 };
    claimedInterceptRunsByMessage.set(message, claimed);
    return claimed;
}

function takeInterceptRunsForMessage(message) {
    const claimed = claimedInterceptRunsByMessage.get(message);
    if (!claimed || claimed.swipeId !== (message.swipe_id ?? 0)) return [];
    pendingGenerationRecords.delete(claimed.key);
    return claimed.runs.splice(0);
}

function storePreGenerationInterceptHistory(message, runs) {
    if (!message || !Array.isArray(runs) || runs.length === 0) {
        return false;
    }

    const storedRuns = runs
        .map(result => sanitizePreGenerationInterceptRunForStorage(result))
        .filter(result => result && typeof result === 'object' && result.status !== 'skipped-empty-prompt');

    if (storedRuns.length === 0) {
        return false;
    }

    setAgentExtraValue(message, PRE_GENERATION_INTERCEPT_HISTORY_KEY, storedRuns.slice(-MAX_TRANSFORM_HISTORY));
    return true;
}

function consolidateAppendPromptTransformOutputs(baseText, agents, results) {
    const prependSegments = [];
    const appendSegments = [];
    const seenSegments = new Set();
    const agentMap = new Map((Array.isArray(agents) ? agents : []).map(agent => [agent.id, agent]));
    const normalizedBaseText = unwrapAssistantResponseWrapper(baseText);

    for (const result of Array.isArray(results) ? results : []) {
        const outputText = unwrapAssistantResponseWrapper(result?.outputText).trim();
        if (!outputText) {
            continue;
        }

        const agent = agentMap.get(result.agentId);
        if (!isAgentRuntimeAllowed(agent)) {
            continue;
        }
        const shouldPrepend = shouldPrependPromptTransformOutput(agent, outputText);
        const dedupeKey = `${shouldPrepend ? 'prepend' : 'append'}:${outputText}`;
        if (seenSegments.has(dedupeKey)) {
            continue;
        }

        seenSegments.add(dedupeKey);
        (shouldPrepend ? prependSegments : appendSegments).push(outputText);
    }

    let mergedText = normalizedBaseText;
    if (prependSegments.length > 0) {
        mergedText = joinPromptTransformText(prependSegments.join('\n\n'), mergedText);
    }
    if (appendSegments.length > 0) {
        mergedText = joinPromptTransformText(mergedText, appendSegments.join('\n\n'));
    }

    return {
        text: mergedText,
        changed: mergedText !== normalizedBaseText,
        beforeText: normalizedBaseText,
    };
}

function getConfiguredHelperPrefillText() {
    return getGlobalSettings()?.helperPrefillMessages ?? '';
}

function appendConfiguredHelperPrefillMessages(promptMessages) {
    const helperPrefillText = getConfiguredHelperPrefillText();
    const helperPrefillMessages = parseHelperPrefillMessages(helperPrefillText);
    if (helperPrefillMessages.length === 0) {
        return {
            promptMessages,
            allowAssistantPrefillTail: false,
        };
    }

    return {
        promptMessages: appendHelperPrefillMessages(promptMessages, helperPrefillText),
        allowAssistantPrefillTail: helperPrefillMessages.at(-1)?.role === 'assistant',
    };
}

function getUserFinalPromptTransformMessages(promptMessages, options = {}) {
    const messages = (Array.isArray(promptMessages) ? promptMessages : [])
        .filter(message => message && typeof message === 'object')
        .map(message => ({
            ...message,
            role: String(message.role ?? 'user').trim().toLowerCase() || 'user',
        }));

    if (messages.length === 0) {
        return [{ role: 'user', content: 'Return only the requested transformed text.' }];
    }

    const hasToolCallContext = messages.some(message => message.role === 'tool' || Array.isArray(message.tool_calls));
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role === 'user' || hasToolCallContext) {
        return messages;
    }

    if (options.allowAssistantPrefillTail && lastMessage.role === 'assistant') {
        return messages;
    }

    // Prompt-transform helper prompts are synthetic requests, not real chat/tool-call tails.
    // Keep providers that reject assistant-prefill tails happy by appending a tiny user turn
    // instead of role-flipping any existing assistant content.
    return [
        ...messages,
        { role: 'user', content: 'Return only the requested transformed text.' },
    ];
}

async function requestMainModelPromptTransform(context, promptMessages, maxTokens, options = {}, signal = null) {
    const generate = context?.generateRawData ?? context?.generateRaw;
    if (typeof generate !== 'function') {
        throw new Error('The main connection does not support isolated agent requests. Choose a saved connection profile.');
    }
    const response = await generate({
        prompt: structuredClone(getUserFinalPromptTransformMessages(promptMessages, options)),
        api: context.mainApi,
        instructOverride: context.mainApi === 'openai',
        responseLength: maxTokens,
        trimNames: false,
        signal,
        cacheScope: 'auxiliary',
    });

    return {
        output: extractProfileResponseText(response),
        runner: 'main',
        profileId: '',
        lengthLimited: isGenerationLengthFinish(response),
    };
}

const PERMANENT_REQUEST_STATUSES = new Set([400, 401, 402, 403, 404, 413, 422, 429]);

/**
 * Reads the HTTP status carried by a request failure, looking through wrapped causes.
 * @param {unknown} error
 * @returns {number|null}
 */
function getRequestErrorStatus(error) {
    let current = error;
    for (let depth = 0; current && depth < 5; depth++) {
        if (Number.isInteger(current.status)) {
            return current.status;
        }
        current = current.cause;
    }
    return null;
}

/**
 * Builds a human-readable error message that keeps the useful wrapped cause.
 * @param {unknown} error
 * @returns {string}
 */
function describeAgentError(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const parts = [error.message];
    let cause = error.cause;
    for (let depth = 0; cause && depth < 5; depth++) {
        const text = cause instanceof Error ? cause.message : String(cause);
        if (text && !parts.includes(text)) {
            parts.push(text);
        }
        cause = cause?.cause;
    }
    return parts.filter(Boolean).join(': ');
}

async function requestProfilePromptTransform(isRuntimeAllowed, CMRS, profileId, promptMessages, maxTokens, modelOverride = '', signal = null) {
    const requestOptions = {
        extractData: true,
        includePreset: true,
        includeInstruct: true,
        stream: false,
        signal,
    };

    if (modelOverride && modelOverride.trim()) {
        requestOptions.modelOverride = modelOverride.trim();
    }

    let primaryError = null;
    let primaryResponse;
    try {
        primaryResponse = await CMRS.sendRequest(profileId, promptMessages, maxTokens, requestOptions);
        const primaryOutput = extractProfileResponseText(primaryResponse);
        if (primaryOutput.trim()) {
            return {
                output: primaryOutput,
                runner: 'profile',
                profileId,
                lengthLimited: primaryResponse?.lengthLimited === true,
            };
        }
    } catch (error) {
        if (isAbortSignalTriggered(error, signal)) {
            throw error;
        }

        if (PERMANENT_REQUEST_STATUSES.has(getRequestErrorStatus(error))) {
            // Authentication, quota and validation failures repeat identically; do not resend.
            throw error;
        }

        primaryError = error;
    }

    let fallbackPrompt = '';
    if (typeof CMRS.constructPrompt === 'function') {
        try {
            fallbackPrompt = CMRS.constructPrompt(promptMessages, profileId) ?? '';
        } catch (error) {
            console.warn(`[InChatAgents] Failed to construct fallback prompt for ${describePromptTransformTarget(profileId, 'profile')}.`, error);
        }
    }

    if (Array.isArray(fallbackPrompt)) {
        // Chat-completion profiles return the same message array, so a retry would be identical.
        if (primaryError) throw primaryError;
        return {
            output: extractProfileResponseText(primaryResponse),
            runner: 'profile',
            profileId,
            lengthLimited: primaryResponse?.lengthLimited === true,
        };
    }
    if (primaryError) {
        console.warn(`[InChatAgents] Primary prompt transform request via ${describePromptTransformTarget(profileId, 'profile')} failed, retrying with fallback prompt formatting.`, primaryError);
    }

    const fallbackRequestPrompt = Array.isArray(fallbackPrompt)
        ? fallbackPrompt
        : (normalizeContentText(fallbackPrompt).trim() ? normalizeContentText(fallbackPrompt) : buildFallbackPromptText(promptMessages));

    const fallbackOptions = {
        extractData: true,
        includePreset: true,
        includeInstruct: false,
        stream: false,
        signal,
    };

    if (modelOverride && modelOverride.trim()) {
        fallbackOptions.modelOverride = modelOverride.trim();
    }

    if (!isRuntimeAllowed()) {
        throw new DOMException('', 'AbortError');
    }
    const fallbackResponse = await CMRS.sendRequest(profileId, fallbackRequestPrompt, maxTokens, fallbackOptions);

    return {
        output: extractProfileResponseText(fallbackResponse),
        runner: 'profile',
        profileId,
        lengthLimited: fallbackResponse?.lengthLimited === true,
    };
}

export async function runAsInternalPromptTransform(requestFn, signal = null) {
    signal?.throwIfAborted();
    internalPromptTransformDepth++;
    notifyAgentGenerationStateChanged();
    let active = true;
    const finish = () => {
        if (!active) return;
        active = false;
        internalPromptTransformDepth = Math.max(0, internalPromptTransformDepth - 1);
        notifyPromptTransformIdle();
        notifyAgentGenerationStateChanged();
    };
    signal?.addEventListener('abort', finish, { once: true });
    try {
        return await requestFn();
    } finally {
        signal?.removeEventListener('abort', finish);
        finish();
    }
}

export async function requestPromptTransform(agent, promptMessages, maxTokens, options = {}) {
    const isRequestCurrent = () => !options.signal?.aborted
        && (!options.isCurrent || options.isCurrent())
        && (options.cancelRevision === undefined || options.cancelRevision === agentGenerationCancelRevision);
    const isRuntimeAllowed = () => isRequestCurrent()
        && isAgentRuntimeAllowed(agent) && (options.runtimeAgents ?? []).every(isAgentRuntimeAllowed);
    if (!isRuntimeAllowed()) {
        throw new DOMException('', 'AbortError');
    }
    const profileId = resolveAgentConnectionProfile(agent);
    const modelOverride = typeof agent.modelOverride === 'string' ? agent.modelOverride.trim() : '';
    const context = getContext();
    const CMRS = context?.ConnectionManagerRequestService;
    const requestAbortController = new AbortController();
    const abortFromCaller = () => requestAbortController.abort();
    const runAllowedRequest = requestFn => runAsInternalPromptTransform(() => {
        if (!isRuntimeAllowed()) throw new DOMException('', 'AbortError');
        return requestFn();
    }, requestAbortController.signal);
    activeAgentRequestAbortControllers.add(requestAbortController);
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });

    try {
        let response;
        if (profileId) {
            if (!CMRS || typeof CMRS.sendRequest !== 'function') {
                throw new Error(`${describePromptTransformTarget(profileId, 'profile')} is set, but Connection Manager is unavailable.`);
            }

            response = await runAllowedRequest(
                () => requestProfilePromptTransform(isRuntimeAllowed, CMRS, profileId, promptMessages, maxTokens, modelOverride, requestAbortController.signal),
            );
        } else {
            response = await runAllowedRequest(
                () => requestMainModelPromptTransform(context, promptMessages, maxTokens, options, requestAbortController.signal),
            );
        }
        // A combined response can still serve its remaining allowed members. Each caller
        // checks eligibility before applying its part; ownership cancellation rejects all.
        if (!isRequestCurrent() || requestAbortController.signal.aborted) throw new DOMException('', 'AbortError');
        return response;
    } finally {
        options.signal?.removeEventListener('abort', abortFromCaller);
        activeAgentRequestAbortControllers.delete(requestAbortController);
    }
}

function getProtectedKimiPartialPrefill(message, messageIndex, messageText) {
    if (message?.is_user !== false || message?.is_system !== false || !Number.isInteger(messageIndex)) {
        return '';
    }

    const api = String(message.extra?.api ?? '').trim().toLowerCase();
    if (!['custom', 'moonshot', 'nanogpt', 'openrouter'].includes(api) || !isKimiK3Model(message.extra?.model)) {
        return '';
    }

    const promptBias = itemizedPrompts.find(item => Number(item?.mesId) === messageIndex)?.promptBias;
    return typeof promptBias === 'string' && promptBias && messageText.startsWith(promptBias) ? promptBias : '';
}

async function runPromptTransformAgent(agent, message, generationType, messageTextOverride = null, messageIndex = null, options = {}) {
    const applyToMessage = options.applyToMessage !== false;
    const cancelRevision = Number.isInteger(options.cancelRevision) ? options.cancelRevision : agentGenerationCancelRevision;
    const targetState = captureMessageTargetState(message);
    const currentMessageText = unwrapAssistantResponseWrapper(
        messageTextOverride !== null ? messageTextOverride : message?.mes,
    );
    const protectedPartialPrefill = getProtectedKimiPartialPrefill(message, messageIndex, currentMessageText);
    const transformMessageText = currentMessageText.slice(protectedPartialPrefill.length);
    const normalizedGenerationType = normalizeGenerationType(generationType);
    const promptTransformMode = getPromptTransformMode(agent);
    const profileId = resolveAgentConnectionProfile(agent);
    const runMetadata = getPromptTransformRunMetadata(agent, profileId);
    const showNotifications = shouldShowPromptTransformNotifications(agent);

    const isRuntimeAllowed = () => isAgentRuntimeAllowed(agent) && (options.runtimeAgents ?? []).every(isAgentRuntimeAllowed);
    const runtimeAllowed = isRuntimeAllowed();
    if (cancelRevision !== agentGenerationCancelRevision || !runtimeAllowed || !transformMessageText.trim()) {
        const result = {
            agentId: agent.id,
            agentName: agent.name,
            changed: false,
            status: cancelRevision !== agentGenerationCancelRevision ? 'cancelled' : runtimeAllowed ? 'skipped-empty-message' : 'skipped-runtime-filter',
            mode: promptTransformMode,
            profileId,
            ...runMetadata,
            runner: 'none',
            timestamp: new Date().toISOString(),
            outputText: '',
            nextMessageText: currentMessageText,
            beforeText: currentMessageText,
        };

        return result;
    }

    const expandedPrompt = substituteParams(agent.prompt, {
        name2Override: String(message?.name ?? '').trim(),
        original: transformMessageText,
        dynamicMacros: buildPromptDynamicMacros(transformMessageText, message, agent, normalizedGenerationType),
    }).trim();

    if (!expandedPrompt) {
        const result = {
            agentId: agent.id,
            agentName: agent.name,
            changed: false,
            status: 'skipped-empty-prompt',
            mode: promptTransformMode,
            profileId,
            ...runMetadata,
            runner: 'none',
            timestamp: new Date().toISOString(),
            outputText: '',
            nextMessageText: currentMessageText,
            beforeText: currentMessageText,
        };

        return result;
    }

    const helperRequest = appendConfiguredHelperPrefillMessages(buildPromptTransformMessages(
        expandedPrompt,
        transformMessageText,
        String(message?.name ?? '').trim(),
        normalizedGenerationType,
        promptTransformMode,
    ));
    const runningToast = showNotifications
        ? showPromptTransformRunningToast(agent, promptTransformMode, profileId)
        : null;

    try {
        const maxTokens = normalizePromptTransformMaxTokens(agent.postProcess?.promptTransformMaxTokens);
        const response = await requestPromptTransform(
            agent,
            helperRequest.promptMessages,
            maxTokens,
            { allowAssistantPrefillTail: helperRequest.allowAssistantPrefillTail, runtimeAgents: options.runtimeAgents },
        );
        const promptOutputText = unwrapAssistantResponseWrapper(response.output).trim();

        if (!promptOutputText) {
            console.warn(`[InChatAgents] ${describePromptTransformMode(promptTransformMode)} agent "${agent.name}" returned an empty response.`);
            const result = {
                agentId: agent.id,
                agentName: agent.name,
                changed: false,
                status: 'empty-response',
                mode: promptTransformMode,
                profileId: response.profileId,
                ...getPromptTransformRunMetadata(agent, response.profileId),
                runner: response.runner,
                timestamp: new Date().toISOString(),
                outputText: '',
                nextMessageText: currentMessageText,
                beforeText: currentMessageText,
            };

            if (showNotifications) {
                showPromptTransformResultToast(agent, result);
            }

            return result;
        }

        const transformedMessageText = promptTransformMode === 'append'
            ? appendPromptTransformOutput(transformMessageText, promptOutputText)
            : promptOutputText;
        const nextMessageText = protectedPartialPrefill + transformedMessageText;
        const staleTarget = !isMessageTargetCurrent(message, targetState, messageIndex);
        // A rewrite the provider cut short at its output limit must not replace the complete original.
        const truncatedRewrite = response.lengthLimited === true;
        if (staleTarget || truncatedRewrite || agentGenerationCancelRevision !== cancelRevision || !isRuntimeAllowed()) {
            if (staleTarget) {
                console.info(`[InChatAgents] ${describePromptTransformMode(promptTransformMode)} agent "${agent.name}" finished after the message changed; result discarded.`);
            } else if (truncatedRewrite) {
                console.warn(`[InChatAgents] ${describePromptTransformMode(promptTransformMode)} agent "${agent.name}" hit its output limit; the original text was kept.`);
                if (showNotifications) {
                    toastr.warning(`${escapeToastHtml(agent.name)} ran out of output room, so the original text was kept. Raise its max tokens and try again.`);
                }
            }
            return {
                agentId: agent.id,
                agentName: agent.name,
                changed: false,
                status: staleTarget ? 'stale-target' : truncatedRewrite ? 'truncated' : agentGenerationCancelRevision !== cancelRevision ? 'cancelled' : 'skipped-runtime-filter',
                mode: promptTransformMode,
                profileId: response.profileId,
                ...getPromptTransformRunMetadata(agent, response.profileId),
                runner: response.runner,
                timestamp: new Date().toISOString(),
                outputText: '',
                nextMessageText: currentMessageText,
                beforeText: currentMessageText,
            };
        }

        const changed = nextMessageText !== currentMessageText;
        if (changed && applyToMessage) {
            setPostProcessingText(message, nextMessageText, options.postProcessingTarget);
            await syncPromptTransformMessageStateAsync(message, messageIndex);
        }

        console.info(`[InChatAgents] ${describePromptTransformMode(promptTransformMode)} agent "${agent.name}" ran via ${describePromptTransformTarget(response.profileId, response.runner)}${changed ? ' and changed the message.' : ' with no text change.'}`);

        const result = {
            agentId: agent.id,
            agentName: agent.name,
            changed,
            status: changed ? 'changed' : 'unchanged',
            mode: promptTransformMode,
            profileId: response.profileId,
            ...getPromptTransformRunMetadata(agent, response.profileId),
            runner: response.runner,
            timestamp: new Date().toISOString(),
            outputText: promptOutputText,
            nextMessageText,
            beforeText: currentMessageText,
        };

        if (showNotifications) {
            showPromptTransformResultToast(agent, result);
        }

        return result;
    } catch (error) {
        if (agentGenerationCancelRevision !== cancelRevision || generationStopRequested || isAbortSignalTriggered(error)) {
            return {
                agentId: agent.id,
                agentName: agent.name,
                changed: false,
                status: 'cancelled',
                mode: promptTransformMode,
                profileId,
                ...runMetadata,
                runner: 'cancelled',
                timestamp: new Date().toISOString(),
                outputText: '',
                nextMessageText: currentMessageText,
                beforeText: currentMessageText,
            };
        }

        console.warn(`[InChatAgents] ${describePromptTransformMode(promptTransformMode)} failed in agent "${agent.name}":`, error);
        const result = {
            agentId: agent.id,
            agentName: agent.name,
            changed: false,
            status: 'error',
            mode: promptTransformMode,
            error: describeAgentError(error),
            profileId,
            ...runMetadata,
            runner: 'error',
            timestamp: new Date().toISOString(),
            outputText: '',
            nextMessageText: currentMessageText,
            beforeText: currentMessageText,
        };

        if (showNotifications) {
            showPromptTransformResultToast(agent, result);
        }

        return result;
    } finally {
        clearPromptTransformRunningToast(runningToast);
    }
}

async function runPromptTransformAppendBatch(agents, message, generationType, messageTextOverride = null, messageIndex = null, { applyToMessage = true, cancelRevision = null, runtimeAgents = [], postProcessingTarget = null } = {}) {
    const targetState = captureMessageTargetState(message);
    const currentMessageText = unwrapAssistantResponseWrapper(
        messageTextOverride !== null ? messageTextOverride : message?.mes,
    );
    const isCancelled = () => (cancelRevision !== null && agentGenerationCancelRevision !== cancelRevision) || !runtimeAgents.every(isAgentRuntimeAllowed);
    const globalSettings = getGlobalSettings();
    const executionMode = globalSettings.appendAgentsExecutionMode === 'sequential' ? 'sequential' : 'parallel';

    let results = [];

    if (isCancelled()) {
        return {
            results,
            changed: false,
            nextMessageText: currentMessageText,
            beforeText: currentMessageText,
            cancelled: true,
        };
    }

    if (executionMode === 'sequential') {
        for (const agent of agents) {
            if (isCancelled()) {
                break;
            }

            try {
                const result = await runPromptTransformAgent(agent, message, generationType, currentMessageText, messageIndex, {
                    applyToMessage: false,
                    runtimeAgents,
                    cancelRevision,
                });
                results.push(result);
                if (isCancelled() || result.status === 'cancelled') {
                    break;
                }
            } catch (error) {
                results.push({
                    agentId: agent.id,
                    agentName: agent.name,
                    changed: false,
                    status: 'error',
                    mode: getPromptTransformMode(agent),
                    error: describeAgentError(error),
                    runner: 'error',
                    timestamp: new Date().toISOString(),
                    outputText: '',
                    nextMessageText: currentMessageText,
                    beforeText: currentMessageText,
                });
            }
        }
    } else {
        results = await Promise.all(
            agents.map(async (agent) => {
                try {
                    return await runPromptTransformAgent(agent, message, generationType, currentMessageText, messageIndex, {
                        applyToMessage: false,
                        runtimeAgents,
                        cancelRevision,
                    });
                } catch (error) {
                    return {
                        agentId: agent.id,
                        agentName: agent.name,
                        changed: false,
                        status: 'error',
                        mode: getPromptTransformMode(agent),
                        error: describeAgentError(error),
                        runner: 'error',
                        timestamp: new Date().toISOString(),
                        outputText: '',
                        nextMessageText: currentMessageText,
                        beforeText: currentMessageText,
                    };
                }
            }),
        );
    }

    if (isCancelled() || results.some(result => result?.status === 'cancelled')) {
        return {
            results,
            changed: false,
            nextMessageText: currentMessageText,
            beforeText: currentMessageText,
            cancelled: true,
        };
    }

    if (!isMessageTargetCurrent(message, targetState, messageIndex) || results.some(result => result?.status === 'stale-target')) {
        return {
            results,
            changed: false,
            nextMessageText: currentMessageText,
            beforeText: currentMessageText,
            staleTarget: true,
        };
    }

    const consolidated = consolidateAppendPromptTransformOutputs(currentMessageText, agents, results);
    if (consolidated.changed && applyToMessage) {
        setPostProcessingText(message, consolidated.text, postProcessingTarget);
        await syncPromptTransformMessageStateAsync(message, messageIndex);
    }

    return {
        results,
        changed: consolidated.changed,
        nextMessageText: consolidated.text,
        beforeText: currentMessageText,
    };
}

async function refreshMessageAfterMutation(messageIndex, message, { deferBackup = false, skipReloadFallback = false } = {}) {
    const target = captureMessageTargetState(message);
    if (!isMessageTargetCurrent(message, target, messageIndex)) return;
    const context = getContext();
    const messageElement = document.querySelector(`.mes[mesid="${messageIndex}"]`);

    if (messageElement && typeof context?.updateMessageBlock === 'function') {
        // Await the repaint so MESSAGE_UPDATED fires only after the DOM is actually
        // re-rendered. On the deferred mobile path updateMessageBlock resolves after the
        // rAF flush; otherwise it resolves synchronously. This lets DOM-mutating
        // listeners (e.g. Dialogue Colors) re-decorate against the final DOM instead of
        // racing the deferred render.
        await context.updateMessageBlock(messageIndex, message);
        if (!isMessageTargetCurrent(message, target, messageIndex)) return;

        if (typeof eventSource?.emit === 'function' && event_types?.MESSAGE_UPDATED) {
            await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
        }

        return;
    }

    // Off-screen messages read their current data when rendered. A whole-chat reload
    // can discard edits made during saving, so notify readers without reloading.
    if (skipReloadFallback) {
        return;
    }

    const saved = await saveChatForAgent(context, { deferBackup });
    if (!saved) console.warn('[In-Chat Agents] The message change has not been saved.');
    if (!isMessageTargetCurrent(message, target, messageIndex)) return;

    if (typeof eventSource?.emit === 'function' && event_types?.MESSAGE_UPDATED) {
        await eventSource.emit(event_types.MESSAGE_UPDATED, messageIndex);
    }
}

function scheduleMessageRefresh(messageIndex, expectedMessage, { deferBackup = false, skipReloadFallback = false } = {}) {
    const target = captureMessageTargetState(expectedMessage);
    const existingRefresh = pendingRefreshTimeouts.get(messageIndex);
    if (existingRefresh) {
        clearTimeout(existingRefresh.timeoutId);
    }

    // When a pending refresh for the same message is replaced, a full-fallback request must never be
    // downgraded to a bookkeeping-only one, or a genuine text mutation could miss its refresh.
    const mergedSkipReloadFallback = existingRefresh
        ? (existingRefresh.skipReloadFallback && skipReloadFallback)
        : skipReloadFallback;

    const timeoutId = setTimeout(async () => {
        pendingRefreshTimeouts.delete(messageIndex);

        const liveMessage = chat[messageIndex];
        if (!isMessageTargetCurrent(liveMessage, target, messageIndex, { text: false, revision: false }) || liveMessage !== expectedMessage) {
            return;
        }

        await refreshMessageAfterMutation(messageIndex, liveMessage, { deferBackup, skipReloadFallback: mergedSkipReloadFallback });
    }, 0);

    pendingRefreshTimeouts.set(messageIndex, { timeoutId, skipReloadFallback: mergedSkipReloadFallback });
}

function clearInChatAgentExtensionPrompts() {
    for (const key of Object.keys(extension_prompts)) {
        if (key.startsWith(PROMPT_KEY_PREFIX)) {
            delete extension_prompts[key];
        }
    }
    clearPathfinderExtensionPrompts();
}

function clearPathfinderExtensionPrompts() {
    for (const key of Object.keys(extension_prompts)) {
        if (PATHFINDER_RETRIEVAL_PROMPT_KEYS.includes(key) || key === PATHFINDER_AUTO_SUMMARY_PROMPT_KEY) {
            delete extension_prompts[key];
        }
    }
}

export function deactivatePathfinderRuntime() {
    invalidateToolApprovals();
    clearPathfinderRetrievalToast();
    abortActivePathfinderRetrieval('Pawthfinder disabled.');
    clearPathfinderExtensionPrompts();
    toolRecursionDepth = 0;
    pendingToolSync = true;
    releaseToolAgentRegistrations();
    notifyAgentGenerationStateChanged();
}

function injectPreGenerationAgentPrompts(activeAgents, generationType) {
    const promptAgents = activeAgents.filter(agent =>
        isAgentRuntimeAllowed(agent) &&
        !isCompanionAgent(agent) &&
        (agent.phase === 'pre' || agent.phase === 'both') &&
        agent.preProcess?.mode !== 'intercept',
    );

    for (const agent of promptAgents) {
        if (isToolAgent(agent)) {
            continue;
        }

        const expandedPrompt = substituteParams(agent.prompt, {
            dynamicMacros: buildPromptDynamicMacros('', null, agent, generationType),
        });
        if (!expandedPrompt.trim()) {
            continue;
        }

        const key = PROMPT_KEY_PREFIX + agent.id;
        setExtensionPrompt(
            key,
            expandedPrompt,
            agent.injection.position,
            agent.injection.depth,
            agent.injection.scan,
            agent.injection.role,
            null,
            agent.name,
        );
    }
}

/**
 * Cleans up all in-chat agent extension prompts before a new generation.
 */
function onGenerationStarted(generationType, options, dryRun) {
    swipeNavigationPending = false;

    if (dryRun || options?.isAuxiliaryGeneration || normalizeGenerationType(generationType) === 'quiet') {
        return;
    }

    // Generate dispatches a group wrapper before any member has started.
    if (getContext()?.groupId && !is_group_generating) return;

    abortActivePathfinderRetrieval();
    releaseToolAgentRegistrations();

    currentMainGenerationType = normalizeGenerationType(generationType);
    resetChatBackupSequence();
    isGenerationInProgress = true;
    generationStartChatId = getCurrentSnapshotChatId();
    postProcessingInvalidatedByChatChange = false;
    toolSyncDuringGeneration = true;
    generationStopRequested = false;
    generationStartedAt = Date.now();
    lastMainGenerationEndedAt = 0;
    postProcessingGenerationRunId++;
    invalidateToolApprovals();
    stoppedGenerationRunId = -1;
    stoppedStreamingMessageIndexes.clear();
    clearLatestAssistantPostProcessingFallback();
    clearPostGenerationRecoveryCheck();
    clearMissedGenerationEndRecoveryCheck();
    clearAllPromptTransformRunningToasts();
    clearInitialGenerationToast();
    getGenerationRecord(getAgentGenerationContext(), true);
    pendingGenerationSnapshot = null;
    generationStartChatLength = chat.length;
    const latestAssistantMessageIndex = getLatestAssistantMessageIndex();
    generationStartLastAssistantIndex = latestAssistantMessageIndex;
    generationStartLastAssistantMessage = latestAssistantMessageIndex >= 0 ? chat[latestAssistantMessageIndex] : null;
    generationStartLastAssistantRevision = getMessageRevisionKey(generationStartLastAssistantMessage);
    processedPostProcessingRunsByIndex.clear();

    toolRecursionDepth = Number.isInteger(options?.depth) ? Math.max(0, options.depth) : 0;

    clearInChatAgentExtensionPrompts();
}

function onGenerationEnded(_chatLength, generationContext) {
    if (generationContext && (generationContext.runId !== postProcessingGenerationRunId
        || generationContext.chatId !== getCurrentSnapshotChatId()
        || generationContext.cancelRevision !== agentGenerationCancelRevision)) {
        return;
    }
    clearInitialGenerationToast();
    invalidateToolApprovals(true);
    abortActivePathfinderRetrieval();
    clearPathfinderRetrievalToast();
    releaseToolAgentRegistrations();

    if (stoppedGenerationRunId === postProcessingGenerationRunId) {
        isGenerationInProgress = false;
        lastMainGenerationEndedAt = Date.now();
        clearLatestAssistantPostProcessingFallback();
        clearPostGenerationRecoveryCheck();
        clearMissedGenerationEndRecoveryCheck();
        clearDeferredPostProcessing();
        return;
    }

    if (postProcessingInvalidatedByChatChange || isCurrentGenerationChatStale()) {
        isGenerationInProgress = false;
        generationStopRequested = false;
        clearPendingPostProcessingForChatChange();
        return;
    }

    pendingGenerationSnapshot ??= buildActivationSnapshot(currentMainGenerationType);
    isGenerationInProgress = false;
    lastMainGenerationEndedAt = Date.now();
    generationStopRequested = false;
    clearMissedGenerationEndRecoveryCheck();
    // Neconyan: generation end must not clear running agent toasts. A helper or a
    // post-processing run can still be waiting on its own request, and its own
    // finally (or an explicit Stop / next generation start) clears the toast.
    queueLatestAssistantPostProcessingFromSnapshot();
    scheduleDeferredPostProcessingFlush();
    schedulePostGenerationRecoveryCheck();
    latestAssistantPostProcessingFallbackDeadline = Date.now() + LATEST_ASSISTANT_POST_PROCESSING_FALLBACK_WINDOW_MS;
    scheduleLatestAssistantPostProcessingFallback();
}

function onGenerationStopped(generationContext) {
    if (generationContext && (generationContext.runId !== postProcessingGenerationRunId
        || generationContext.chatId !== getCurrentSnapshotChatId()
        || generationContext.cancelRevision !== agentGenerationCancelRevision)) {
        return;
    }

    resetChatBackupSequence();

    generationStopRequested = true;
    agentGenerationCancelRevision++;
    invalidateToolApprovals();
    abortActiveAgentRequests();
    releaseToolAgentRegistrations();
    stoppedGenerationRunId = postProcessingGenerationRunId;
    const stoppedMessageIndex = Number(streamingProcessor?.messageId);
    if (Number.isInteger(stoppedMessageIndex) && stoppedMessageIndex >= 0) {
        stoppedStreamingMessageIndexes.add(stoppedMessageIndex);
    }
    isGenerationInProgress = false;
    lastMainGenerationEndedAt = Date.now();
    clearLatestAssistantPostProcessingFallback();
    clearPostGenerationRecoveryCheck();
    clearMissedGenerationEndRecoveryCheck();
    clearDeferredPostProcessing();
    clearAllPromptTransformRunningToasts();
    clearPathfinderRetrievalToast();
    clearInitialGenerationToast();
    pendingGenerationRecords.clear();
    abortActivePathfinderRetrieval('Pawthfinder retrieval cancelled because generation stopped.');
    clearPathfinderExtensionPrompts();
    notifyAgentGenerationStateChanged();
}

/**
 * Injects pre-generation agent prompts.
 * @param {string} generationType
 * @param {object} options
 * @param {boolean} dryRun
 */
async function onGenerationAfterCommands(generationType, options, dryRun) {
    if (options?.isAuxiliaryGeneration || normalizeGenerationType(generationType) === 'quiet') {
        return;
    }

    if (!dryRun && getContext()?.groupId && !is_group_generating) return;

    const normalizedGenerationType = normalizeGenerationType(generationType);

    if (dryRun && isGenerationInProgress) {
        return;
    }

    if (dryRun) {
        clearInChatAgentExtensionPrompts();
    }

    if (!areAgentsGloballyEnabled()) {
        return;
    }

    // Decide once, after the submitted user message exists. Every later stage
    // reuses this snapshot, including its probability decision.
    const activationSnapshot = dryRun
        ? buildActivationSnapshot(normalizedGenerationType)
        : pendingGenerationSnapshot?.generationType === normalizedGenerationType
            ? cloneActivationSnapshot(pendingGenerationSnapshot, normalizedGenerationType)
            : buildActivationSnapshot(normalizedGenerationType);

    if (!dryRun) {
        pendingGenerationSnapshot = activationSnapshot;
        getGenerationRecord(getAgentGenerationContext(), true).snapshot = activationSnapshot;
    }

    const activeAgents = getSnapshotAgents(activationSnapshot);
    const pathfinderAgent = getPathfinderRuntimeAgent(activeAgents);

    if (!dryRun && pathfinderAgent) {
        abortActivePathfinderRetrieval();
        const run = {
            controller: new AbortController(),
            ...getAgentGenerationContext(),
            cacheRevision: pathfinderRetrievalCacheRevision,
            result: null,
            nativeApplied: false,
            skipWIAN: options?.skipWIAN,
        };
        run.isCurrent = () => pathfinderRetrievalRun === run && !run.controller.signal.aborted && !options?.signal?.aborted
            && !generationStopRequested && run.cancelRevision === agentGenerationCancelRevision
            && run.runId === postProcessingGenerationRunId && run.chatId === getCurrentSnapshotChatId()
            && run.cacheRevision === pathfinderRetrievalCacheRevision && areAgentsGloballyEnabled()
            && getPathfinderRuntimeAgent(getEnabledAgents())?.id === pathfinderAgent.id
            && JSON.stringify(getPathfinderRetrievalSettingsSnapshot(getAgentById(pathfinderAgent.id))) === run.settingsSignature;
        run.writePrompt = (...args) => run.isCurrent() ? setExtensionPrompt(...args) : false;
        pathfinderRetrievalRun = run;
        syncPathfinderRuntimeSettings(pathfinderAgent);
        run.settingsSignature = JSON.stringify(getPathfinderRetrievalSettingsSnapshot(pathfinderAgent));
        const retrievalCacheTarget = getPathfinderRetrievalCacheTarget(normalizedGenerationType);
        const retrievalCacheSignature = buildPathfinderRetrievalCacheSignature(pathfinderAgent, activationSnapshot, normalizedGenerationType, retrievalCacheTarget);
        const cachedRetrieval = findPathfinderRetrievalCache(retrievalCacheTarget?.message, retrievalCacheSignature);

        if (cachedRetrieval) {
            if (!run.isCurrent()) return;
            run.result = cachedRetrieval.retrieval;
            restorePathfinderRetrievalPromptSnapshot(cachedRetrieval);
        } else {
            const onAbort = () => run.controller.abort(options.signal.reason);
            options?.signal?.addEventListener('abort', onAbort, { once: true });
            if (options?.signal?.aborted) onAbort();
            activePathfinderRetrievalAbortControllers.add(run.controller);
            notifyAgentGenerationStateChanged();

            try {
                if (shouldShowPathfinderRetrievalToast(pathfinderAgent)) {
                    showPathfinderRetrievalToast();
                }
                run.result = await runSidecarRetrieval(run.writePrompt, extension_prompt_types, extension_prompt_roles, run.controller.signal, {
                    chatMessages: getPathfinderRetrievalContextSnapshot(retrievalCacheTarget?.messageIndex ?? chat.length),
                });
            } finally {
                if (pathfinderRetrievalRun === run) clearPathfinderRetrievalToast();
                activePathfinderRetrievalAbortControllers.delete(run.controller);
                options?.signal?.removeEventListener('abort', onAbort);
                notifyAgentGenerationStateChanged();
            }

            if (run.isCurrent() && run.result?.success && run.result.cacheable !== false && isAgentRuntimeAllowed(pathfinderAgent)) {
                storePathfinderRetrievalCache(retrievalCacheTarget?.message, retrievalCacheSignature, run.result);
            }
        }

        if (run.controller.signal.aborted || pathfinderRetrievalRun !== run || (!run.isCurrent() && isAgentRuntimeAllowed(pathfinderAgent))
            || generationStopRequested || options?.signal?.aborted || run.cancelRevision !== agentGenerationCancelRevision
            || run.runId !== postProcessingGenerationRunId || run.chatId !== getCurrentSnapshotChatId()) {
            return;
        }

        // A runtime exclusion must not suppress other agents belonging to this response.
        if (!isAgentRuntimeAllowed(pathfinderAgent)) {
            clearPathfinderExtensionPrompts();
        } else if (shouldAutoSummarize() && isPathfinderSummarizeToolEnabled(pathfinderAgent)) {
            setExtensionPrompt(
                PATHFINDER_AUTO_SUMMARY_PROMPT_KEY,
                'Pawthfinder memory summary is due. If the recent conversation contains a meaningful scene, event, state change, or resolved arc, call Pathfinder_Summarize with a concise title, useful content, significance, and arc when applicable. If nothing important happened, do not call it.',
                extension_prompt_types.IN_PROMPT,
                4,
                false,
                extension_prompt_roles.SYSTEM,
            );
            // Neconyan: do NOT reset the counter here. The counter is reset
            // only after the Pathfinder_Summarize tool actually writes a summary.
            // Resetting at injection time caused the interval to be consumed even
            // when the model skipped or failed the tool call, preventing future
            // summaries from triggering. (#530)
        }
    }

    injectPreGenerationAgentPrompts(activeAgents, generationType);
    companionRuntime?.injectCompanionFeedbackPrompts?.(activeAgents.filter(isAgentRuntimeAllowed), {
        excludeMessage: options?.companionHistoryTarget ?? null,
    });

    if (!dryRun) {
        syncToolAgentRegistrations();
    }
}

/**
 * Runs post-generation utilities on the received message and snapshots active regex scripts.
 * @param {number} messageIndex
 * @param {string} generationType
 * @param {{ generationType: string, activeAgentIds: string[], chatId: string } | null} activationSnapshot
 */
async function processReceivedMessage(messageIndex, generationType, activationSnapshot = null) {
    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        return;
    }

    if (!isAssistantPostProcessingGenerationType(activationSnapshot?.generationType ?? generationType)) {
        return;
    }

    const swipeId = Number(message?.swipe_id);
    const inFlightKey = `${messageIndex}:${Number.isInteger(swipeId) ? swipeId : 0}`;
    if (postProcessingInFlightKeys.has(inFlightKey)) {
        return;
    }

    postProcessingInFlightKeys.add(inFlightKey);
    const initialText = message.mes;
    const postProcessingTarget = { text: initialText, valid: true, state: captureMessageTargetState(message) };
    const operationCancelRevision = agentGenerationCancelRevision;
    const isOperationCurrent = () => agentGenerationCancelRevision === operationCancelRevision
        && postProcessingTarget.valid && isMessageTargetCurrent(message, postProcessingTarget.state, messageIndex);
    postProcessingTargets.set(message, postProcessingTarget);
    let pipelineCompleted = false;
    try {
        syncAssistantMessageTextToSwipe(message);

        const resolvedActivationSnapshot = activationSnapshot
            ? cloneActivationSnapshot(activationSnapshot, generationType)
            : cloneActivationSnapshot(pendingGenerationSnapshot ?? buildActivationSnapshot(generationType), generationType);
        const runKey = getPostProcessingRunKey(message, generationType, resolvedActivationSnapshot);
        const indexRunKey = getPostProcessingIndexRunKey(message, messageIndex, generationType, resolvedActivationSnapshot);
        if (hasProcessedPostProcessingRun(message, runKey, messageIndex, indexRunKey)) {
            return;
        }

        const activeAgents = getActiveAgentsForMessage(generationType, resolvedActivationSnapshot);
        let chatStateChanged = false;
        let messageDisplayChanged = false;

        const cleanedAuxiliaryEchoes = companionRuntime?.stripAuxiliaryTrackerEchoes?.(message.mes, undefined, activeAgents);
        let currentPromptTransformText = unwrapAssistantResponseWrapper(
            typeof cleanedAuxiliaryEchoes === 'string' ? cleanedAuxiliaryEchoes : message.mes,
        );

        // Neconyan: the tracker sentinel is agent bookkeeping, so it must not survive in the stored
        // chain-of-thought either. The thinking block is shown in the reply, so a lone sentinel line
        // there looks exactly like a failed tracker.
        if (typeof message.extra?.reasoning === 'string') {
            const cleanedReasoning = stripEmptyOutputSentinelLines(message.extra.reasoning);
            if (cleanedReasoning !== message.extra.reasoning) {
                message.extra.reasoning = cleanedReasoning;
                chatStateChanged = true;
                messageDisplayChanged = true;
            }
        }
        const activeSwipeReasoningExtra = message.swipe_info?.[message.swipe_id]?.extra;
        if (activeSwipeReasoningExtra && typeof activeSwipeReasoningExtra.reasoning === 'string') {
            const cleanedSwipeReasoning = stripEmptyOutputSentinelLines(activeSwipeReasoningExtra.reasoning);
            if (cleanedSwipeReasoning !== activeSwipeReasoningExtra.reasoning) {
                activeSwipeReasoningExtra.reasoning = cleanedSwipeReasoning;
                chatStateChanged = true;
                messageDisplayChanged = true;
            }
        }

        // The history baseline is the visible starting text (after the sentinel strip), so Undo never
        // restores a sentinel and a strip-only reply is not recorded as an agent transformation.
        const historyBaselineText = currentPromptTransformText;

        // Neconyan: the sentinel strip is bookkeeping cleanup, not an agent edit, so publish it
        // before the agents run. If a later stage is interrupted, the reply must not keep the
        // sentinel in the chat.
        if (currentPromptTransformText !== message.mes
            && setPostProcessingText(message, currentPromptTransformText, postProcessingTarget)) {
            chatStateChanged = true;
            messageDisplayChanged = true;
        }

        // Companions normally run last so they see the post-transform reply; the concurrent
        // option trades that for speed and runs them against the current reply alongside the passes.
        const companionStageArgs = { messageIndex, message, generationType };
        const concurrentCompanionStage = getGlobalSettings().companionConcurrentWithPostGen && companionRuntime?.runCompanionStage
            ? companionRuntime.runCompanionStage({ ...companionStageArgs, activeAgents: activeAgents.filter(isAgentRuntimeAllowed) }).catch(error => {
                console.warn('[InChatAgents] Companion stage failed:', error);
            })
            : null;
        const promptTransformAgents = getPromptTransformAgentsForMessage(activeAgents, generationType);
        const utilityAgents = isImpersonateGenerationType(generationType)
            ? []
            : activeAgents.filter(agent =>
                !isCompanionAgent(agent) &&
                agent.postProcess?.enabled &&
                agent.postProcess.type !== 'regex' &&
                (
                    agent.phase === 'post' ||
                    agent.phase === 'both' ||
                    agent.postProcess.type === 'extract'
                ),
            );

        const interceptRuns = takeInterceptRunsForMessage(message);
        const promptRuns = [];
        let appendBatch = [];
        let staleTarget = false;
        const flushAppendBatch = async () => {
            if (appendBatch.length === 0 || staleTarget || !isOperationCurrent()) {
                appendBatch = [];
                return;
            }

            const batchAgents = appendBatch;
            appendBatch = [];

            const batchResult = await runPromptTransformAppendBatch(
                batchAgents,
                message,
                generationType,
                currentPromptTransformText,
                messageIndex,
                { applyToMessage: false, cancelRevision: operationCancelRevision },
            );
            promptRuns.push(...batchResult.results);
            currentPromptTransformText = batchResult.nextMessageText;
            staleTarget = staleTarget || batchResult.staleTarget === true;

            if (batchResult.changed) {
                chatStateChanged = true;
                messageDisplayChanged = true;
            }
        };

        for (const agent of promptTransformAgents) {
            if (staleTarget || !isOperationCurrent()) {
                break;
            }

            if (getPromptTransformMode(agent) === 'append') {
                appendBatch.push(agent);
                continue;
            }

            await flushAppendBatch();
            if (staleTarget || !isOperationCurrent()) {
                break;
            }

            try {
                const result = await runPromptTransformAgent(agent, message, generationType, currentPromptTransformText, messageIndex, {
                    applyToMessage: false,
                    cancelRevision: operationCancelRevision,
                });
                promptRuns.push(result);
                currentPromptTransformText = result.nextMessageText;
                if (result.status === 'stale-target') {
                    staleTarget = true;
                    break;
                }
                if (result.status === 'cancelled') {
                    break;
                }

                if (result.changed) {
                    chatStateChanged = true;
                    messageDisplayChanged = true;
                }
            } catch (error) {
                promptRuns.push({
                    agentId: agent.id,
                    agentName: agent.name,
                    changed: false,
                    status: 'error',
                    mode: getPromptTransformMode(agent),
                    error: describeAgentError(error),
                    runner: 'error',
                    timestamp: new Date().toISOString(),
                });
            }
        }

        await flushAppendBatch();
        if (staleTarget || !isOperationCurrent()) return;

        for (const agent of utilityAgents) {
            if (!isAgentRuntimeAllowed(agent)) {
                continue;
            }
            const postProcess = agent.postProcess;

            switch (postProcess.type) {
                case 'append': {
                    if (!postProcess.appendText) {
                        break;
                    }

                    const appendedText = substituteParams(postProcess.appendText);
                    if (appendedText.trim()) {
                        currentPromptTransformText += appendedText;
                    }
                    break;
                }
            }
        }

        currentPromptTransformText = applyAgentRegexScriptsToText(activeAgents, currentPromptTransformText, {
            characterOverride: message.name,
            includeDisplay: false,
        });
        if (!isOperationCurrent()) return;

        // Commit the actual combined edit once. Per-agent outputs remain diagnostics,
        // while Undo records the text that was really applied (including raw regex and utilities).
        const agentTextChanged = currentPromptTransformText !== historyBaselineText;
        const textNeedsCommit = currentPromptTransformText !== message.mes;
        if (textNeedsCommit) {
            if (!setPostProcessingText(message, currentPromptTransformText, postProcessingTarget)) return;
            if (agentTextChanged) recordAppliedTransformation(message, historyBaselineText, promptRuns);
            chatStateChanged = true;
            messageDisplayChanged = true;
        }
        if (storePreGenerationInterceptHistory(message, interceptRuns)) {
            chatStateChanged = true;
            messageDisplayChanged = true;
        }
        const runsChanged = updatePromptTransformRuns(message, promptRuns);
        if (reconcileTrackerMetadata(activeAgents) || runsChanged) {
            chatStateChanged = true;
        }
        if (updateMessageRegexSnapshot(message, activeAgents, generationType)) {
            chatStateChanged = true;
            messageDisplayChanged = true;
        }

        if (textNeedsCommit && !await syncPromptTransformMessageStateAsync(message, messageIndex)) return;
        if (!isOperationCurrent()) return;
        if (chatStateChanged) {
            syncAssistantMessageStateToSwipe(message, messageIndex);
            saveChatDebouncedForAgent({ deferBackup: false });
        }

        if (messageDisplayChanged) {
            scheduleMessageRefresh(messageIndex, message, { deferBackup: true });
        }

        if (concurrentCompanionStage) {
            await concurrentCompanionStage;
        } else if (companionRuntime?.runCompanionStage) {
            try {
                await companionRuntime.runCompanionStage({ ...companionStageArgs, activeAgents: activeAgents.filter(isAgentRuntimeAllowed) });
            } catch (error) {
                console.warn('[InChatAgents] Companion stage failed:', error);
            }
        }

        // Neconyan: only mark the run as processed once the pipeline is done. Marking it up front
        // turned any interrupted or failed stage into a permanently skipped reply, with no retry
        // and no feedback for the user.
        markPostProcessingRunProcessed(message, runKey, messageIndex, indexRunKey);
        pipelineCompleted = true;
    } catch (error) {
        console.error('[InChatAgents] Agent post-processing failed:', error);
        warnPostProcessingInterrupted(message, describeAgentError(error));
    } finally {
        if (!pipelineCompleted && agentGenerationCancelRevision === operationCancelRevision
            && !generationStopRequested && postProcessingTarget.valid && chat[messageIndex] === message) {
            warnPostProcessingInterrupted(message);
        }
        if (postProcessingTargets.get(message) === postProcessingTarget) postProcessingTargets.delete(message);
        postProcessingInFlightKeys.delete(inFlightKey);
    }
}

async function onMessageReceived(messageIndex, generationType, generationContext = null) {
    if (!areAgentsGloballyEnabled()) {
        return;
    }

    if (isGreetingGenerationType(generationType)) {
        swipeNavigationPending = false;
        clearDeferredPostProcessing(Number(messageIndex));
        return;
    }

    if (postProcessingInvalidatedByChatChange || isCurrentGenerationChatStale()) {
        clearPendingPostProcessingForChatChange();
        return;
    }

    if (!isAssistantPostProcessingGenerationType(generationType)) {
        return;
    }

    const numericMessageIndex = Number(messageIndex);
    const message = chat[numericMessageIndex];
    if (!message || message.is_user || message.is_system) {
        return;
    }

    if (generationContext && (generationContext.chatId !== getCurrentSnapshotChatId() || generationContext.cancelRevision !== agentGenerationCancelRevision)) return;
    const record = claimPendingInterceptRunsForMessage(message, generationContext ?? getAgentGenerationContext());
    const activationSnapshot = record.snapshot;

    ensureMessageRegexSnapshot(numericMessageIndex, generationType, activationSnapshot);

    if (generationStopRequested || wasStreamingMessageStopped(numericMessageIndex)) {
        clearDeferredPostProcessing(numericMessageIndex);
        return;
    }

    if (isStreamingMessageStillActive(numericMessageIndex)) {
        deferPostProcessing(numericMessageIndex, generationType, activationSnapshot);
        return;
    }

    if (isMainGenerationStillActive()) {
        deferPostProcessing(numericMessageIndex, generationType, activationSnapshot);
        return;
    }

    clearDeferredPostProcessing(numericMessageIndex);

    await processReceivedMessage(numericMessageIndex, generationType, activationSnapshot);
    clearPostGenerationStateAfterCompletion();
}

function onStreamTokenReceived() {
    if (!areAgentsGloballyEnabled()) {
        return;
    }

    const liveStreamingProcessor = streamingProcessor;
    if (!liveStreamingProcessor || liveStreamingProcessor.type === 'impersonate') {
        return;
    }

    const numericMessageIndex = Number(liveStreamingProcessor.messageId);
    if (!Number.isInteger(numericMessageIndex) || numericMessageIndex < 0) {
        return;
    }

    const generationType = pendingGenerationSnapshot?.generationType
        ?? currentMainGenerationType
        ?? liveStreamingProcessor.type;

    ensureMessageRegexSnapshot(
        numericMessageIndex,
        generationType,
        pendingGenerationSnapshot,
        { refresh: false, save: false },
    );
}

async function onCharacterMessageRendered(messageIndex, generationType, generationContext = null) {
    const numericMessageIndex = Number(messageIndex);
    const message = chat[numericMessageIndex];

    if (isGreetingGenerationType(generationType)) {
        swipeNavigationPending = false;
        if (shouldRefreshTransformHistoryUi(numericMessageIndex, message)) {
            scheduleMessageRefresh(numericMessageIndex, message);
        }
        return;
    }

    if (swipeNavigationPending) {
        swipeNavigationPending = false;
        if (shouldRefreshTransformHistoryUi(numericMessageIndex, message)) {
            scheduleMessageRefresh(numericMessageIndex, message);
        }
        return;
    }

    if (shouldRefreshTransformHistoryUi(numericMessageIndex, message)) {
        scheduleMessageRefresh(numericMessageIndex, message);
    }

    const claimed = message && claimedInterceptRunsByMessage.get(message);
    await onMessageReceived(messageIndex, generationType, generationContext ?? claimed?.origin);
}

async function onMessageEdited(messageIndex) {
    const message = chat[messageIndex];
    if (!message) return;
    invalidateMessageTarget(message);
    deleteAgentExtraValue(message, PROMPT_TRANSFORM_REDO_KEY);
    if (!areAgentsGloballyEnabled()) return;

    const snapshot = getAgentExtraValue(message, MESSAGE_EXTRA_KEY);
    let changed = false;
    if (snapshot) {
        const agents = (snapshot.activeAgentIds ?? []).map(getAgentById).filter(Boolean);
        const text = applyAgentRegexScriptsToText(agents, message.mes, { characterOverride: message.name, isEdit: true, includeDisplay: false });
        changed = text !== message.mes;
        message.mes = text;
        snapshot.edited = true;
        setAgentExtraValue(message, MESSAGE_EXTRA_KEY, snapshot);
    }
    const metadataChanged = reconcileTrackerMetadata();
    if (changed && !await syncPromptTransformMessageStateAsync(message, messageIndex)) return;
    if (snapshot || metadataChanged) saveChatDebouncedForAgent();
    if (changed) scheduleMessageRefresh(messageIndex, message);
}

async function runPromptTransformAgentsForText(promptTransformAgents, initialText, generationType, { messageContext = {}, cancelRevision = null, stopOnFailure = false, runtimeAgents = [] } = {}) {
    const message = {
        mes: initialText,
        name: getUserMessageName(),
        is_user: true,
        is_system: false,
        extra: {},
        ...messageContext,
    };
    const promptRuns = [];
    const initialPromptTransformText = unwrapAssistantResponseWrapper(initialText);
    const isCancelled = () => (cancelRevision !== null && agentGenerationCancelRevision !== cancelRevision) || !runtimeAgents.every(isAgentRuntimeAllowed);
    const cancelledResult = () => ({
        promptRuns,
        text: initialPromptTransformText,
        changed: false,
        cancelled: true,
    });
    const failedResult = () => ({
        promptRuns,
        text: initialPromptTransformText,
        changed: false,
        failed: true,
    });
    let currentPromptTransformText = initialPromptTransformText;
    let appendBatch = [];

    const flushAppendBatch = async () => {
        if (appendBatch.length === 0) {
            return null;
        }

        if (isCancelled()) {
            return { cancelled: true };
        }

        const batchAgents = appendBatch;
        appendBatch = [];

        const batchResult = await runPromptTransformAppendBatch(
            batchAgents,
            message,
            generationType,
            currentPromptTransformText,
            null,
            { cancelRevision, runtimeAgents },
        );
        promptRuns.push(...batchResult.results);

        if (batchResult.cancelled || isCancelled() || batchResult.results.some(result => result?.status === 'cancelled')) {
            return { cancelled: true };
        }

        if (stopOnFailure && batchResult.results.some(result => result?.status === 'error')) {
            return { failed: true };
        }

        currentPromptTransformText = batchResult.nextMessageText;
        return null;
    };

    for (const agent of promptTransformAgents) {
        if (isCancelled()) {
            return cancelledResult();
        }

        if (getPromptTransformMode(agent) === 'append') {
            appendBatch.push(agent);
            continue;
        }

        const appendResult = await flushAppendBatch();
        if (appendResult?.cancelled) {
            return cancelledResult();
        }
        if (appendResult?.failed) {
            return failedResult();
        }

        try {
            const result = await runPromptTransformAgent(agent, message, generationType, currentPromptTransformText, null, {
                applyToMessage: false,
                runtimeAgents,
                ...(cancelRevision !== null ? { cancelRevision } : {}),
            });
            promptRuns.push(result);

            if (isCancelled() || result.status === 'cancelled') {
                return cancelledResult();
            }
            if (stopOnFailure && result.status === 'error') {
                return failedResult();
            }

            currentPromptTransformText = result.nextMessageText;
        } catch (error) {
            if (isCancelled()) {
                return cancelledResult();
            }

            promptRuns.push({
                agentId: agent.id,
                agentName: agent.name,
                changed: false,
                status: 'error',
                mode: getPromptTransformMode(agent),
                error: describeAgentError(error),
                runner: 'error',
                timestamp: new Date().toISOString(),
            });

            if (stopOnFailure) {
                return failedResult();
            }
        }
    }

    const appendResult = await flushAppendBatch();
    if (appendResult?.cancelled) {
        return cancelledResult();
    }
    if (appendResult?.failed) {
        return failedResult();
    }

    return {
        promptRuns,
        text: currentPromptTransformText,
        changed: currentPromptTransformText !== unwrapAssistantResponseWrapper(initialText),
    };
}

/**
 * Runs the post passes of every enabled inline agent that opted into companion-output
 * targeting (prompt pass first, agent regex second) against a completed companion result.
 * The caller stores the returned text back into the companion result so downstream
 * consumers (panel display, feedback injection, dependent companions) all see it.
 * @param {object} companionAgent The companion whose output is being transformed
 * @param {string} initialText The companion result content
 * @param {{ messageIndex?: number, cancelRevision?: number }} [options]
 * @returns {Promise<{ text: string, changed: boolean, cancelled?: boolean }>}
 */
export async function runCompanionOutputPostPasses(companionAgent, initialText, { messageIndex = -1, cancelRevision = getAgentGenerationCancelRevision() } = {}) {
    const baseText = String(initialText ?? '');
    if (!baseText.trim()) {
        return { text: baseText, changed: false };
    }

    const isCancelled = () => agentGenerationCancelRevision !== cancelRevision || !isAgentRuntimeAllowed(companionAgent);
    if (isCancelled()) {
        return { text: baseText, changed: false, cancelled: true };
    }

    const transformers = getCompanionOutputPostPassAgents(companionAgent);
    if (transformers.length === 0) {
        return { text: baseText, changed: false };
    }

    const sourceMessage = chat[Number(messageIndex)] ?? null;
    const characterName = String(sourceMessage?.name ?? '').trim();
    let currentText = baseText;
    let changed = false;

    const promptAgents = getPromptTransformAgents(transformers);
    if (promptAgents.length > 0) {
        const promptResult = await runPromptTransformAgentsForText(
            promptAgents,
            currentText,
            COMPANION_OUTPUT_GENERATION_TYPE,
            {
                messageContext: characterName ? { name: characterName } : {},
                cancelRevision,
                stopOnFailure: true,
                runtimeAgents: [companionAgent],
            },
        );
        if (promptResult.cancelled || isCancelled()) {
            return { text: baseText, changed: false, cancelled: true };
        }
        if (promptResult.failed) {
            const failure = promptResult.promptRuns.find(run => run?.status === 'error');
            throw new Error(failure?.error || 'Companion output prompt transform failed.');
        }

        currentText = promptResult.text;
        changed = changed || promptResult.changed;
    }

    if (isCancelled()) {
        return { text: baseText, changed: false, cancelled: true };
    }

    const regexAgents = transformers.filter(agent => getAgentRegexScripts(agent).length > 0);
    if (regexAgents.length > 0) {
        const regexText = applyAgentRegexScriptsToText(regexAgents, currentText, { characterOverride: characterName });
        if (regexText !== currentText) {
            currentText = regexText;
            changed = true;
        }
    }

    return { text: currentText, changed };
}

async function runContextInterceptAgent(agent, currentContextText, generationType, contextFormat, options = {}) {
    const timing = options.timing === POST_MAIN_GENERATION_INTERCEPT_TIMING
        ? POST_MAIN_GENERATION_INTERCEPT_TIMING
        : PRE_GENERATION_INTERCEPT_TIMING;
    const beforeText = normalizeContentText(currentContextText);
    const applyMode = ['wrap', 'patch'].includes(String(agent?.preProcess?.applyMode))
        ? String(agent.preProcess.applyMode)
        : 'replace';
    const profileId = resolveAgentConnectionProfile(agent);
    const baseResult = {
        agentId: agent.id,
        agentName: agent.name,
        applyMode,
        timing,
        contextFormat,
        changed: false,
        beforeText,
        afterText: beforeText,
        outputText: '',
        profileId: '',
        runner: 'none',
        timestamp: new Date().toISOString(),
    };
    const expandedPrompt = substituteParams(agent.prompt, {
        original: currentContextText,
        dynamicMacros: buildPromptDynamicMacros(currentContextText, null, agent, generationType),
    }).trim();

    const runtimeAllowed = isAgentRuntimeAllowed(agent);
    if (!runtimeAllowed || !expandedPrompt || !currentContextText.trim()) {
        return {
            ...baseResult,
            status: runtimeAllowed ? 'skipped-empty-prompt' : 'skipped-runtime-filter',
        };
    }

    const helperRequest = appendConfiguredHelperPrefillMessages(
        buildContextInterceptMessages(expandedPrompt, currentContextText, generationType, contextFormat, timing),
    );
    const cancelRevision = agentGenerationCancelRevision;
    const skipChanges = timing === POST_MAIN_GENERATION_INTERCEPT_TIMING && Boolean(options?.skipChanges);
    const showRunningToast = skipChanges || shouldShowPreInterceptNotifications(agent);
    const runningToast = showRunningToast
        ? showPromptTransformRunningToast(agent, applyMode, profileId, {
            kind: timing === POST_MAIN_GENERATION_INTERCEPT_TIMING ? 'postMainIntercept' : 'preIntercept',
            applyMode,
            skipChanges,
            onCancel: skipChanges ? options?.onCancel : null,
        })
        : null;

    try {
        const response = await requestPromptTransform(
            agent,
            helperRequest.promptMessages,
            normalizePreProcessMaxTokens(agent.preProcess?.maxTokens),
            { allowAssistantPrefillTail: helperRequest.allowAssistantPrefillTail },
        );

        if (agentGenerationCancelRevision !== cancelRevision || !isAgentRuntimeAllowed(agent)) {
            return {
                ...baseResult,
                status: agentGenerationCancelRevision !== cancelRevision ? 'cancelled' : 'skipped-runtime-filter',
                profileId: response.profileId,
                runner: response.runner,
            };
        }

        if (response.lengthLimited) {
            return { ...baseResult, status: 'truncated', profileId: response.profileId, runner: response.runner };
        }

        const outputText = unwrapContextInterceptOutput(response.output).trim();

        if (!outputText) {
            console.warn(`[InChatAgents] pre-generation intercept agent "${agent.name}" returned an empty response.`);
            return {
                ...baseResult,
                status: 'empty-response',
                profileId: response.profileId,
                runner: response.runner,
            };
        }

        return {
            ...baseResult,
            status: 'changed',
            changed: true,
            outputText,
            profileId: response.profileId,
            runner: response.runner,
        };
    } catch (error) {
        if (agentGenerationCancelRevision !== cancelRevision || generationStopRequested || isAbortSignalTriggered(error)) {
            return {
                ...baseResult,
                status: 'cancelled',
                profileId,
                runner: 'cancelled',
            };
        }

        throw error;
    } finally {
        clearPromptTransformRunningToast(runningToast);
    }
}

function getGenerationContextSnapshot(generationType = null) {
    const normalizedGenerationType = normalizeGenerationType(generationType ?? currentMainGenerationType);

    if (pendingGenerationSnapshot?.generationType === normalizedGenerationType) {
        return cloneActivationSnapshot(pendingGenerationSnapshot, normalizedGenerationType);
    }

    return buildActivationSnapshot(normalizedGenerationType);
}

async function runPreGenerationInterceptorsOnText(initialContextText, generationType, contextFormat) {
    if (!areAgentsGloballyEnabled()) {
        return { text: initialContextText, runs: [] };
    }

    let currentContextText = String(initialContextText ?? '');
    if (!currentContextText.trim()) {
        return { text: currentContextText, runs: [] };
    }

    const activationSnapshot = getGenerationContextSnapshot(generationType);
    const interceptAgents = getPreGenerationInterceptAgents(getSnapshotAgents(activationSnapshot));
    if (interceptAgents.length === 0) {
        return { text: currentContextText, runs: [] };
    }

    const runs = [];
    for (const agent of interceptAgents) {
        if (generationStopRequested) {
            break;
        }

        try {
            const result = await runContextInterceptAgent(agent, currentContextText, activationSnapshot.generationType, contextFormat);
            if (result.status !== 'changed') {
                runs.push(result);
                if (result.status === 'cancelled') {
                    break;
                }
                continue;
            }

            currentContextText = applyContextInterceptText(currentContextText, result.outputText, agent.preProcess);
            result.afterText = currentContextText;
            result.changed = result.afterText !== result.beforeText;
            result.status = result.changed ? 'changed' : 'unchanged';
            runs.push(result);
        } catch (error) {
            console.warn(`[InChatAgents] Pre-generation intercept agent "${agent.name}" failed. Leaving context unchanged for this agent.`, error);
            runs.push({
                agentId: agent.id,
                agentName: agent.name,
                applyMode: ['wrap', 'patch'].includes(String(agent?.preProcess?.applyMode)) ? String(agent.preProcess.applyMode) : 'replace',
                timing: PRE_GENERATION_INTERCEPT_TIMING,
                contextFormat,
                changed: false,
                status: 'error',
                error: describeAgentError(error),
                beforeText: currentContextText,
                afterText: currentContextText,
                outputText: '',
                profileId: '',
                runner: 'error',
                timestamp: new Date().toISOString(),
            });
        }
    }

    return { text: currentContextText, runs };
}

function getContextInterceptChatRole(agent) {
    switch (Number(agent?.injection?.role)) {
        case extension_prompt_roles.USER:
            return 'user';
        case extension_prompt_roles.ASSISTANT:
            return 'assistant';
        default:
            return 'system';
    }
}

function insertContextInterceptChatMessage(chatMessages, content, agent) {
    const message = {
        role: getContextInterceptChatRole(agent),
        content,
    };

    if (agent?.preProcess?.wrapPosition === 'before') {
        chatMessages.unshift(message);
    } else {
        chatMessages.push(message);
    }
}

async function runPreGenerationInterceptorsOnChat(initialChatMessages, generationType) {
    if (!areAgentsGloballyEnabled()) {
        return { chat: initialChatMessages, runs: [] };
    }

    let currentChatMessages = Array.isArray(initialChatMessages) ? [...initialChatMessages] : [];
    if (currentChatMessages.length === 0) {
        return { chat: currentChatMessages, runs: [] };
    }

    const activationSnapshot = getGenerationContextSnapshot(generationType);
    const interceptAgents = getPreGenerationInterceptAgents(getSnapshotAgents(activationSnapshot));
    if (interceptAgents.length === 0) {
        return { chat: currentChatMessages, runs: [] };
    }

    const runs = [];
    for (const agent of interceptAgents) {
        if (generationStopRequested) {
            break;
        }

        const contextText = serializeChatContext(currentChatMessages);
        let result = null;

        try {
            result = await runContextInterceptAgent(agent, contextText, activationSnapshot.generationType, 'chat');
            if (result.status !== 'changed') {
                runs.push(result);
                if (result.status === 'cancelled') {
                    break;
                }
                continue;
            }

            if (agent.preProcess?.applyMode === 'wrap') {
                insertContextInterceptChatMessage(
                    currentChatMessages,
                    `${String(agent.preProcess?.wrapPrefix ?? '')}${result.outputText}${String(agent.preProcess?.wrapSuffix ?? '')}`,
                    agent,
                );
                result.afterText = serializeChatContext(currentChatMessages);
                result.changed = result.afterText !== result.beforeText;
                result.status = result.changed ? 'changed' : 'unchanged';
                result.role = getContextInterceptChatRole(agent);
                runs.push(result);
                continue;
            }

            if (agent.preProcess?.applyMode === 'patch') {
                insertContextInterceptChatMessage(currentChatMessages, buildPatchTaggedText(result.outputText, agent.preProcess), agent);
                result.afterText = serializeChatContext(currentChatMessages);
                result.changed = result.afterText !== result.beforeText;
                result.status = result.changed ? 'changed' : 'unchanged';
                result.role = getContextInterceptChatRole(agent);
                runs.push(result);
                continue;
            }

            currentChatMessages = parseChatContext(result.outputText);
            result.afterText = serializeChatContext(currentChatMessages);
            result.changed = result.afterText !== result.beforeText;
            result.status = result.changed ? 'changed' : 'unchanged';
            runs.push(result);
        } catch (error) {
            console.warn(`[InChatAgents] Pre-generation intercept agent "${agent.name}" failed. Leaving chat context unchanged for this agent.`, error);
            runs.push({
                agentId: agent.id,
                agentName: agent.name,
                applyMode: ['wrap', 'patch'].includes(String(agent?.preProcess?.applyMode)) ? String(agent.preProcess.applyMode) : 'replace',
                timing: PRE_GENERATION_INTERCEPT_TIMING,
                contextFormat: 'chat',
                changed: false,
                status: 'error',
                error: describeAgentError(error),
                beforeText: contextText,
                afterText: contextText,
                outputText: normalizeContentText(result?.outputText),
                profileId: result?.profileId ?? '',
                runner: result?.runner ?? 'error',
                timestamp: result?.timestamp ?? new Date().toISOString(),
            });
        }
    }

    return { chat: currentChatMessages, runs };
}

async function runPostMainGenerationInterceptorsOnText(initialOutputText, generationType, options = {}) {
    if (!areAgentsGloballyEnabled()) {
        return { text: initialOutputText, runs: [], cancelled: false };
    }

    let currentOutputText = String(initialOutputText ?? '');
    if (!currentOutputText.trim()) {
        return { text: currentOutputText, runs: [], cancelled: false };
    }

    if (generationStopRequested) {
        return { text: currentOutputText, runs: [], cancelled: true };
    }

    const activationSnapshot = options?.activationSnapshot
        ? cloneActivationSnapshot(options.activationSnapshot, generationType)
        : getGenerationContextSnapshot(generationType);
    const interceptAgents = getPostMainGenerationInterceptAgents(getSnapshotAgents(activationSnapshot));
    if (interceptAgents.length === 0) {
        return { text: currentOutputText, runs: [], cancelled: false };
    }

    const runs = [];
    for (const agent of interceptAgents) {
        if (generationStopRequested) {
            return { text: currentOutputText, runs, cancelled: true };
        }

        try {
            const result = await runContextInterceptAgent(
                agent,
                currentOutputText,
                activationSnapshot.generationType,
                'text',
                {
                    timing: POST_MAIN_GENERATION_INTERCEPT_TIMING,
                    skipChanges: Boolean(options?.skipChanges),
                    onCancel: options?.onCancel,
                },
            );

            if (generationStopRequested || result.status === 'cancelled') {
                runs.push({ ...result, status: 'cancelled', changed: false, afterText: currentOutputText });
                return { text: currentOutputText, runs, cancelled: true };
            }

            if (result.status !== 'changed') {
                runs.push(result);
                continue;
            }

            currentOutputText = applyContextInterceptText(currentOutputText, result.outputText, agent.preProcess);
            result.afterText = currentOutputText;
            result.changed = result.afterText !== result.beforeText;
            result.status = result.changed ? 'changed' : 'unchanged';
            runs.push(result);
        } catch (error) {
            console.warn(`[InChatAgents] Post-main intercept agent "${agent.name}" failed. Leaving generated output unchanged for this agent.`, error);
            runs.push({
                agentId: agent.id,
                agentName: agent.name,
                applyMode: ['wrap', 'patch'].includes(String(agent?.preProcess?.applyMode)) ? String(agent.preProcess.applyMode) : 'replace',
                timing: POST_MAIN_GENERATION_INTERCEPT_TIMING,
                contextFormat: 'text',
                changed: false,
                status: 'error',
                error: describeAgentError(error),
                beforeText: currentOutputText,
                afterText: currentOutputText,
                outputText: '',
                profileId: '',
                runner: 'error',
                timestamp: new Date().toISOString(),
            });

            if (generationStopRequested) {
                return { text: currentOutputText, runs, cancelled: true };
            }
        }
    }

    return { text: currentOutputText, runs, cancelled: false };
}

function buildPostMainInterceptReviewPopupContent(text) {
    return `
        <div class="ica--post-main-intercept-review">
            <p>Review the main output before it is shown in chat.</p>
            <pre class="ica--post-main-intercept-review-output"><code>${escapeToastHtml(text)}</code></pre>
        </div>
    `;
}

async function showPostMainInterceptReviewPopup(text) {
    const popupContent = buildPostMainInterceptReviewPopupContent(text);
    const result = await callGenericPopup(popupContent, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: false,
        customButtons: [
            {
                text: 'Skip intercept',
                result: POPUP_RESULT.CUSTOM1,
                classes: ['menu_button_primary'],
            },
            {
                text: 'Continue intercept',
                result: POPUP_RESULT.CUSTOM2,
                classes: ['menu_button_primary'],
            },
        ],
    });

    return result === POPUP_RESULT.CUSTOM2;
}

function getPostMainGenerationInterceptorsForGeneration(generationType) {
    if (!areAgentsGloballyEnabled()) {
        return [];
    }

    const activationSnapshot = getGenerationContextSnapshot(generationType);
    return getPostMainGenerationInterceptAgents(getSnapshotAgents(activationSnapshot));
}

function isAuxiliaryOrStaleRequest(eventData) {
    return eventData?.isAuxiliaryGeneration || eventData?.type === 'quiet'
        || (eventData?.generationContext && !isInterceptOriginCurrent(eventData.generationContext));
}

async function onGenerateAfterCombinePrompts(eventData) {
    if (eventData?.dryRun || isAuxiliaryOrStaleRequest(eventData) || !isGenerationInProgress) {
        return;
    }

    if (!eventData || typeof eventData.prompt !== 'string') {
        return;
    }

    const origin = getAgentGenerationContext();
    const result = await runPreGenerationInterceptorsOnText(
        eventData.prompt,
        currentMainGenerationType,
        'text',
    );
    if (!isInterceptOriginCurrent(origin)) {
        return;
    }

    eventData.prompt = result.text;
    getGenerationRecord(origin, true).runs.push(...result.runs);
}

async function onChatCompletionPromptReady(eventData) {
    if (eventData?.dryRun || isAuxiliaryOrStaleRequest(eventData) || !isGenerationInProgress) {
        return;
    }

    if (!eventData || !Array.isArray(eventData.chat)) {
        return;
    }

    const originalChat = eventData.chat;
    const origin = getAgentGenerationContext();
    const result = await runPreGenerationInterceptorsOnChat(originalChat, currentMainGenerationType);
    if (!isInterceptOriginCurrent(origin)) {
        return;
    }

    const nextChat = result.chat;
    getGenerationRecord(origin, true).runs.push(...result.runs);
    if (nextChat === originalChat || !result.runs.some(run => run.changed)) {
        return;
    }

    originalChat.splice(0, originalChat.length, ...nextChat);
    eventData.chat = originalChat;
    eventData.chatChanged = true;
}

async function onGenerationOutputBufferingDecision(eventData) {
    if (!eventData || eventData.dryRun || isAuxiliaryOrStaleRequest(eventData) || !isGenerationInProgress) {
        return;
    }

    const interceptAgents = getPostMainGenerationInterceptorsForGeneration(eventData.type ?? currentMainGenerationType);
    if (interceptAgents.length > 0) {
        eventData.hasPostMainInterceptors = true;
        if (interceptAgents.some(shouldShowPreInterceptNotifications) || shouldShowPostMainInterceptMessageFirst()) {
            showInitialGenerationToast();
        }
    }
}

async function onMainGenerationOutputReady(eventData) {
    if (!eventData || eventData.dryRun || isAuxiliaryOrStaleRequest(eventData)) {
        return;
    }

    clearInitialGenerationToast();

    if (generationStopRequested) {
        eventData.cancelled = true;
        return;
    }

    if (!isGenerationInProgress || typeof eventData.text !== 'string') {
        return;
    }

    const generationType = eventData.type ?? currentMainGenerationType;
    const activationSnapshot = getGenerationContextSnapshot(generationType);
    const interceptAgents = getPostMainGenerationInterceptAgents(getSnapshotAgents(activationSnapshot));
    if (interceptAgents.length === 0) {
        return;
    }

    const origin = getAgentGenerationContext();
    const shouldShowMessageFirst = shouldShowPostMainInterceptMessageFirst();
    if (shouldShowMessageFirst) {
        const runPostMainIntercepts = await showPostMainInterceptReviewPopup(eventData.text);
        if (generationStopRequested || !isInterceptOriginCurrent(origin)) {
            eventData.cancelled = true;
            return;
        }

        if (!runPostMainIntercepts) {
            return;
        }
    }

    const result = await runPostMainGenerationInterceptorsOnText(eventData.text, generationType, {
        activationSnapshot,
        skipChanges: false,
    });
    if (!isInterceptOriginCurrent(origin)) {
        eventData.cancelled = true;
        return;
    }

    getGenerationRecord(origin, true).runs.push(...result.runs);

    if (result.cancelled || generationStopRequested) {
        eventData.cancelled = true;
        return;
    }

    eventData.text = result.text;
}

async function onImpersonateReady(text = '', eventData = {}) {
    if (isAuxiliaryOrStaleRequest(eventData) || !areAgentsGloballyEnabled()) {
        return;
    }

    const textarea = document.querySelector('#send_textarea');
    if (!textarea) {
        return;
    }

    const textareaTextAtStart = normalizeContentText(textarea.value);
    const eventText = normalizeContentText(text);
    const initialText = textareaTextAtStart || eventText;
    if (!initialText.trim()) {
        return;
    }

    const activationSnapshot = pendingGenerationSnapshot?.generationType === IMPERSONATE_GENERATION_TYPE
        ? cloneActivationSnapshot(pendingGenerationSnapshot, IMPERSONATE_GENERATION_TYPE)
        : buildActivationSnapshot(IMPERSONATE_GENERATION_TYPE);
    const activeAgents = getSnapshotAgents(activationSnapshot);
    const promptTransformAgents = getPromptTransformAgentsForImpersonate(activeAgents);
    const regexAgents = getRegexAgentsForImpersonate(activeAgents);
    if (promptTransformAgents.length === 0 && regexAgents.length === 0) {
        return;
    }

    // Impersonate produces user-side text; rewrite only the composer value, never the last assistant swipe.
    let transformedText = initialText;
    let changed = false;
    const cancelRevision = agentGenerationCancelRevision;
    const origin = getAgentGenerationContext();

    if (promptTransformAgents.length > 0) {
        const result = await runPromptTransformAgentsForText(promptTransformAgents, transformedText, IMPERSONATE_GENERATION_TYPE, { cancelRevision });
        if (result.cancelled || !isInterceptOriginCurrent(origin)) {
            return;
        }
        transformedText = result.text;
        changed = changed || result.changed;
    }

    if (regexAgents.length > 0) {
        const regexText = applyAgentRegexScriptsToText(regexAgents, transformedText, { characterOverride: getUserMessageName() });
        if (regexText !== transformedText) {
            transformedText = regexText;
            changed = true;
        }
    }

    if (!changed) {
        return;
    }

    if (normalizeContentText(textarea.value) !== textareaTextAtStart) {
        toastr.warning('Skipped applying the impersonation post passes because the input changed while they were running.', 'In-Chat Agents');
        return;
    }

    textarea.value = transformedText;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

async function onMessageSwiped(data) {
    // `MESSAGE_SWIPED` fires during swipe navigation before any overswipe generation starts.
    // Re-running prompt-transform / append agents here mutates the current swipe again,
    // which makes prompt-transform agents fire just from browsing swipes.
    // Real swipe generations are handled later by `MESSAGE_RECEIVED`.
    swipeNavigationPending = true;
    invalidateMessageTarget(chat[Number(data)]);
    if (reconcileTrackerMetadata()) saveChatDebouncedForAgent();
}

function onMessageSwipeDeleted(data) {
    invalidateMessageTarget(chat[Number(data?.messageId)]);
    pendingGenerationSnapshot = null;
    clearLatestAssistantPostProcessingFallback();
    clearPostGenerationRecoveryCheck();
    clearDeferredPostProcessing(Number(data?.messageId));
    if (reconcileTrackerMetadata()) saveChatDebouncedForAgent();
}

/**
 * Handles CHAT_COMPLETION_SETTINGS_READY for tool-category agents.
 * Strips tools on the final recursion pass to force narrative output.
 * Tools must stay in OpenAI format here: the server backends convert
 * per-provider themselves (e.g. sendClaudeRequest filters on
 * tool.type === 'function'), so any client-side format conversion would
 * make the server drop every tool.
 * @param {object} data Generation data being prepared for the API call
 */
function onChatCompletionSettingsReady(data, request = {}) {
    if (isAuxiliaryOrStaleRequest(request) || !areAgentsGloballyEnabled() || agentRegisteredToolNames.size === 0) {
        return;
    }

    const recurseLimit = ToolManager.RECURSE_LIMIT ?? 5;
    if (toolRecursionDepth >= recurseLimit - 1) {
        delete data.tools;
        delete data.tool_choice;
        return;
    }

    // "Require tool use on every response": force only the first pass of a
    // turn. Forcing recursive passes too would make every turn consume the
    // whole recursion budget before the model may write its reply.
    if (toolRecursionDepth === 0 && getPathfinderRuntimeAgent()) {
        const forcedToolChoice = getForcedToolChoice(data.chat_completion_source, data.model);
        if (forcedToolChoice) {
            data.tool_choice = forcedToolChoice;
        }
    }
}

/**
 * Handles WORLDINFO_ENTRIES_LOADED for tool-category agents.
 * Pawthfinder now leaves native World Info activation intact and de-dupes its
 * own injected retrieval context against naturally activated entries instead.
 * @param {object} data World info data with globalLore, characterLore, etc.
 */
function onWorldInfoEntriesLoaded(data) {
    void data;
}

async function onWorldInfoActivated(entries, generationContext) {
    const run = pathfinderRetrievalRun;
    // Native activation is emitted after retrieval, before either prompt builder
    // reads extension prompts. Untagged events cannot identify overlapping scans.
    if (!isGenerationInProgress || !run?.isCurrent()
        || !run.result?.success || run.nativeApplied || run.skipWIAN || !Array.isArray(entries)
        || generationContext?.runId !== run.runId || generationContext?.chatId !== run.chatId
        || generationContext?.cancelRevision !== run.cancelRevision) {
        return;
    }
    run.nativeApplied = true;
    await injectPathfinderRetrieval(run.result, run.writePrompt, extension_prompt_types, extension_prompt_roles, entries);
}

let _onChatChangedToolSync = false;

function onChatChangedToolSync() {
    pendingGenerationRecords.clear();
    chatLoadRevision++;
    pathfinderChatSyncRevision++;
    clearPendingPostProcessingForChatChange();
    resetAutoSummaryCount();
    if (reconcileTrackerMetadata()) saveChatDebouncedForAgent();

    if (!areAgentsGloballyEnabled()) {
        syncToolAgentRegistrations();
        return;
    }

    if (_onChatChangedToolSync) {
        return;
    }
    _onChatChangedToolSync = true;

    requestAnimationFrame(() => {
        _onChatChangedToolSync = false;
        toolRecursionDepth = 0;
        const revision = pathfinderChatSyncRevision;
        void (async () => {
            try {
                const pathfinderAgent = getPathfinderRuntimeAgent();
                if (pathfinderAgent) {
                    await syncPathfinderAgentLorebooksForCurrentChat(pathfinderAgent, { persist: true });
                }
            } catch (error) {
                console.warn('[Pawthfinder] Failed to save agent', error);
            } finally {
                if (revision === pathfinderChatSyncRevision) syncToolAgentRegistrations();
            }
        })();
    });
}

function invalidatePathfinderRetrieval() {
    pathfinderRetrievalCacheRevision++;
    abortActivePathfinderRetrieval();
    clearPathfinderRetrievalToast();
    clearPathfinderExtensionPrompts();
}

function onWorldInfoUpdatedToolSync(name, data, options) {
    if (typeof name === 'string' && name) {
        // Other queued tools remain valid when a sibling tool commits its save.
        if (options?.replaced || !isPathfinderSelfWrite(name)) pathfinderToolRevision++;
        onPathfinderWorldInfoUpdated(name, data, options);
        invalidatePathfinderRetrieval();
    }
    syncToolAgentRegistrations();
}

async function onWorldInfoRenamedOrDeleted(oldName, newName = '') {
    if (typeof oldName !== 'string' || !oldName) return;
    pathfinderToolRevision++;
    if (newName) onPathfinderWorldInfoRenamed(oldName, newName);
    else onPathfinderWorldInfoDeleted(oldName);
    invalidatePathfinderRetrieval();

    const retarget = settings => {
        if (!settings || !(settings.enabledLorebooks?.includes(oldName) || settings.selectedLorebook === oldName
            || Object.hasOwn(settings.bookPermissions ?? {}, oldName))) return null;
        const enabledLorebooks = [...new Set((settings.enabledLorebooks ?? []).map(name => name === oldName ? newName : name).filter(Boolean))];
        const bookPermissions = { ...(settings.bookPermissions ?? {}) };
        if (newName && Object.hasOwn(bookPermissions, oldName)) {
            bookPermissions[newName] ??= bookPermissions[oldName];
        }
        delete bookPermissions[oldName];
        return {
            ...settings,
            enabledLorebooks,
            selectedLorebook: settings.selectedLorebook === oldName ? (newName || enabledLorebooks[0] || '') : settings.selectedLorebook,
            bookPermissions,
        };
    };

    for (const agent of getAgents().filter(isPathfinderToolAgent)) {
        const saved = await saveAgent(agent.id, { update: current => {
            const settings = retarget(current?.settings);
            return settings ? { ...current, settings } : null;
        } });
        if (!saved) continue;
        syncToolAgentRegistrations();
        notifyAgentGenerationStateChanged();
    }
    syncToolAgentRegistrations();
}

export async function undoPromptTransform(messageIndex) {
    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        return false;
    }

    const history = getPromptTransformHistoryForMessage(message);

    if (history.length === 0) {
        return false;
    }

    const lastEntry = history[history.length - 1];
    invalidateMessageTarget(message);
    const redo = getAgentExtraValue(message, PROMPT_TRANSFORM_REDO_KEY) ?? [];
    setAgentExtraValue(message, PROMPT_TRANSFORM_REDO_KEY, [...redo, lastEntry].slice(-MAX_TRANSFORM_HISTORY));
    message.mes = lastEntry.beforeText;
    reconcileTrackerMetadata();
    if (!await syncPromptTransformMessageStateAsync(message, messageIndex)) return false;
    saveChatDebouncedForAgent();
    scheduleMessageRefresh(messageIndex, message);
    return true;
}

export async function redoPromptTransform(messageIndex) {
    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        return false;
    }

    const redo = getAgentExtraValue(message, PROMPT_TRANSFORM_REDO_KEY);
    const redoEntry = Array.isArray(redo) ? redo.at(-1) : null;

    if (!redoEntry || normalizeContentText(redoEntry.beforeText) !== normalizeContentText(message.mes)) {
        return false;
    }

    invalidateMessageTarget(message);
    setAgentExtraValue(message, PROMPT_TRANSFORM_REDO_KEY, redo.slice(0, -1));
    message.mes = redoEntry.afterText;
    reconcileTrackerMetadata();
    if (!await syncPromptTransformMessageStateAsync(message, messageIndex)) return false;
    saveChatDebouncedForAgent();
    scheduleMessageRefresh(messageIndex, message);
    return true;
}

/**
 * Registers all event listeners for the agent runner.
 */
async function persistPathfinderRuntimeSettingsToAgent() {
    const agent = getPathfinderRuntimeAgent();
    if (!agent) {
        return;
    }

    const { pipelinePrompts, pipelines } = structuredClone(getPathfinderRuntimeSettings());
    await saveAgent(agent.id, { update: current => current
        ? { ...current, settings: { ...current.settings, pipelinePrompts, pipelines } }
        : null });
}

export function initAgentRunner() {
    if (agentRunnerInitialized) {
        return;
    }

    agentRunnerInitialized = true;
    setAgentGenerationContextProvider(getAgentGenerationContext);
    initPostGenerationRecoveryHooks();
    setPromptStorePersistHook(() => { void persistPathfinderRuntimeSettingsToAgent(); });

    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, () => {
            if (reconcileTrackerMetadata()) saveChatDebouncedForAgent();
        });
    }

    if (event_types.STREAM_TOKEN_RECEIVED) {
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
    }

    if (event_types.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    }

    if (event_types.IMPERSONATE_READY) {
        eventSource.on(event_types.IMPERSONATE_READY, onImpersonateReady);
    }

    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    }

    if (event_types.MESSAGE_SWIPE_DELETED) {
        eventSource.on(event_types.MESSAGE_SWIPE_DELETED, onMessageSwipeDeleted);
    }

    if (event_types.CHAT_COMPLETION_SETTINGS_READY) {
        eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
    }

    if (event_types.GENERATE_AFTER_COMBINE_PROMPTS) {
        eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onGenerateAfterCombinePrompts);
    }

    if (event_types.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    }

    if (event_types.GENERATION_OUTPUT_BUFFERING_DECISION) {
        eventSource.on(event_types.GENERATION_OUTPUT_BUFFERING_DECISION, onGenerationOutputBufferingDecision);
    }

    if (event_types.MAIN_GENERATION_OUTPUT_READY) {
        eventSource.on(event_types.MAIN_GENERATION_OUTPUT_READY, onMainGenerationOutputReady);
    }

    if (event_types.WORLDINFO_ENTRIES_LOADED) {
        eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, onWorldInfoEntriesLoaded);
    }

    if (event_types.WORLD_INFO_ACTIVATED) {
        eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    }

    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, migrateLegacyRegexSnapshotsForCurrentChat);
        eventSource.on(event_types.CHAT_CHANGED, onChatChangedToolSync);
    }

    if (event_types.WORLDINFO_UPDATED) {
        eventSource.on(event_types.WORLDINFO_UPDATED, onWorldInfoUpdatedToolSync);
    }

    if (event_types.WORLDINFO_RENAMED) {
        eventSource.on(event_types.WORLDINFO_RENAMED, onWorldInfoRenamedOrDeleted);
    }
    if (event_types.WORLDINFO_DELETED) {
        eventSource.on(event_types.WORLDINFO_DELETED, name => onWorldInfoRenamedOrDeleted(name));
    }

    migrateLegacyRegexSnapshotsForCurrentChat();
}

/**
 * Runs a single inline agent's post passes (forced prompt pass, then agent regex)
 * on a plain text value that is not a chat message.
 * @param {object} agent
 * @param {string} text
 * @param {string} generationType Labeling context for the prompt pass
 * @param {{ characterOverride?: string, messageContext?: object }} [options]
 * @returns {Promise<{ text: string, changed: boolean, promptRuns: object[] }>}
 */
export async function runSingleAgentPostPassesOnText(agent, text, generationType, { characterOverride = '', messageContext = {}, runtimeAgents = [], cancelRevision = agentGenerationCancelRevision } = {}) {
    let currentText = String(text ?? '');
    let changed = false;
    let promptRuns = [];

    if (String(agent?.prompt ?? '').trim()) {
        const promptResult = await runPromptTransformAgentsForText([agent], currentText, generationType, { messageContext, runtimeAgents, cancelRevision });
        promptRuns = promptResult.promptRuns ?? [];
        currentText = promptResult.text;
        changed = changed || promptResult.changed;
    }

    if (agentGenerationCancelRevision !== cancelRevision || !isAgentRuntimeAllowed(agent) || !runtimeAgents.every(isAgentRuntimeAllowed)) {
        return { text: String(text ?? ''), changed: false, promptRuns };
    }
    if (getAgentRegexScripts(agent).length > 0) {
        const regexText = applyAgentRegexScriptsToText([agent], currentText, { characterOverride });
        if (regexText !== currentText) {
            currentText = regexText;
            changed = true;
        }
    }

    return { text: currentText, changed, promptRuns };
}

async function executeManualComposerAgentRun(agent, cancelRevision, target) {
    if (isCompanionAgent(agent)) {
        toastr.warning('Companion agents attach notes to messages and cannot rewrite the composer text.');
        return null;
    }

    const textarea = document.querySelector('#send_textarea');
    if (!textarea) {
        toastr.error('Composer text box not found.');
        return null;
    }

    const initialText = normalizeContentText(textarea.value);
    if (!initialText.trim()) {
        toastr.warning('The composer text box is empty.');
        return null;
    }

    const result = await runSingleAgentPostPassesOnText(agent, initialText, IMPERSONATE_GENERATION_TYPE, {
        characterOverride: getUserMessageName(),
        cancelRevision,
    });

    if (agentGenerationCancelRevision !== cancelRevision || target.state.chatId !== getCurrentSnapshotChatId()
        || target.state.chatLoadRevision !== chatLoadRevision || document.querySelector('#send_textarea') !== textarea) {
        return null;
    }

    if (!result.changed) {
        toastr.info(`"${agent.name}" made no changes to the composer text.`, 'In-Chat Agents');
        return result;
    }

    if (normalizeContentText(textarea.value) !== initialText) {
        toastr.warning('Skipped applying the agent because the composer text changed while it was running.', 'In-Chat Agents');
        return null;
    }

    textarea.value = result.text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return result;
}

async function executeManualAgentRun(agentId, target, cancelRevision = agentGenerationCancelRevision) {
    const runTarget = normalizeManualRunTarget(target);
    const agent = getAgentById(agentId);
    if (!agent) {
        toastr.error('Agent not found.');
        return null;
    }
    if (!isAgentRuntimeAllowed(agent) || agentGenerationCancelRevision !== cancelRevision || !target.isCurrent()) {
        return null;
    }

    if (runTarget.kind === 'composer') {
        if (target.state.chatId !== getCurrentSnapshotChatId() || target.state.chatLoadRevision !== chatLoadRevision
            || document.querySelector('#send_textarea') !== target.composer || target.composer?.value !== target.composerText) return null;
        return await executeManualComposerAgentRun(agent, cancelRevision, target);
    }

    if (!isMessageTargetCurrent(target.message, target.state, runTarget.messageIndex, { text: false })) return null;

    if (runTarget.kind === 'companion') {
        if (isCompanionAgent(agent)) {
            toastr.warning('Companion agents cannot post-process other companion notes.');
            return null;
        }

        if (!companionRuntime?.applyAgentPostPassesToCompanionResult) {
            toastr.error('Companion runtime is unavailable.');
            return null;
        }

        return await companionRuntime.applyAgentPostPassesToCompanionResult(agent.id, runTarget.messageIndex, runTarget.companionAgentId, { cancelRevision });
    }

    const messageIndex = runTarget.messageIndex;
    await commitOpenEditorForMessage(messageIndex);

    // A queued run whose Stop arrived while it waited must not send a request.
    if (!isAgentRuntimeAllowed(agent) || agentGenerationCancelRevision !== cancelRevision
        || !isMessageTargetCurrent(target.message, target.state, messageIndex, { text: false, revision: false })) {
        return null;
    }
    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        return null;
    }

    if (isCompanionAgent(agent)) {
        if (!companionRuntime?.runCompanionAgentOnMessage) {
            toastr.error('Companion runtime is unavailable.');
            return null;
        }

        return await companionRuntime.runCompanionAgentOnMessage(agent.id, messageIndex, { cancelRevision });
    }

    const generationType = 'normal';
    const beforeText = message.mes;
    const messageTarget = captureMessageTargetState(message);
    const regexSnapshotChanged = refreshRegexSnapshotForAgentOnMessage(agent.id, messageIndex, {
        generationType,
        includeForcedAgent: true,
        markPendingSave: false,
        respectGenerationTypes: false,
        save: false,
    });
    const result = await runPromptTransformAgent(agent, message, generationType, null, messageIndex, {
        applyToMessage: false,
        cancelRevision,
    });
    if (result.status === 'stale-target') {
        toastr.warning('The message changed while the agent was running, so its result was discarded.');
        return null;
    }
    if (result.status === 'cancelled' || agentGenerationCancelRevision !== cancelRevision || !isMessageTargetCurrent(message, messageTarget, messageIndex)) {
        return null;
    }

    if (result.status !== 'truncated') {
        result.nextMessageText = applyAgentRegexScriptsToText([agent], result.nextMessageText, { characterOverride: message.name, includeDisplay: false });
        result.changed = result.nextMessageText !== beforeText;
    }
    if (result.changed) {
        message.mes = result.nextMessageText;
        recordAppliedTransformation(message, beforeText, [result]);
        reconcileTrackerMetadata();
        if (!await syncPromptTransformMessageStateAsync(message, messageIndex)) return null;
    }

    const promptTransformRunsChanged = updatePromptTransformRuns(message, [result]);
    if (regexSnapshotChanged || promptTransformRunsChanged) {
        saveChatDebouncedForAgent();
    }

    const historyChanged = result.changed;
    if (historyChanged) {
        syncAssistantMessageStateToSwipe(message, messageIndex);
        saveChatDebouncedForAgent();
    }

    if (result.changed || regexSnapshotChanged) {
        scheduleMessageRefresh(messageIndex, message);
    }

    return result;
}

/**
 * Manually runs a single agent on a specific message (on-demand, not triggered by generation).
 * Requests are queued so repeated manual runs apply one at a time.
 * @param {string} agentId
 * @param {number} messageIndex
 * @returns {Promise<import('./agent-store.js').InChatAgent | null>}
 */
export async function runAgentOnMessage(agentId, messageIndex) {
    return await runAgentOnTarget(agentId, { kind: 'message', messageIndex: Number(messageIndex) });
}

/**
 * Manually runs a single agent on a chosen target: a chat message, the composer
 * text box, or a companion result on a message. Queued like other manual runs.
 * @param {string} agentId
 * @param {number|{ kind: 'message'|'composer'|'companion', messageIndex?: number, companionAgentId?: string }} target
 */
export async function runAgentOnTarget(agentId, target) {
    if (!areAgentsGloballyEnabled()) {
        toastr.warning('In-Chat Agents are disabled.');
        return null;
    }

    return await enqueueManualAgentRun(agentId, target);
}

export async function runTrackerFixOnMessage(messageIndex, { cancelRevision = agentGenerationCancelRevision } = {}) {
    resetChatBackupSequence();
    if (!areAgentsGloballyEnabled()) {
        toastr.warning('In-Chat Agents are disabled.');
        return;
    }

    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        return;
    }
    const submittedTarget = captureMessageTargetState(message);
    if (agentGenerationCancelRevision !== cancelRevision) return;
    await commitOpenEditorForMessage(messageIndex);
    if (!isMessageTargetCurrent(message, submittedTarget, messageIndex, { text: false, revision: false })) return;

    const generationType = 'normal';
    const beforeText = message.mes;
    const target = captureMessageTargetState(message);
    const fixCancelRevision = cancelRevision;
    const isFixCancelled = () => agentGenerationCancelRevision !== fixCancelRevision;
    const isFixTargetCurrent = () => !isFixCancelled() && isMessageTargetCurrent(message, target, messageIndex);
    if (!isFixTargetCurrent()) return;
    const enabledAgents = getEnabledAgents();
    const trackerAgents = enabledAgents.filter(agent => !isCompanionAgent(agent) && isTrackerFixAgent(agent));

    if (trackerAgents.length === 0) {
        toastr.info('No enabled tracker agents found.');
        return;
    }

    const trackerExtractAgents = trackerAgents.filter(agent =>
        agent.postProcess?.enabled &&
        agent.postProcess.type === 'extract' &&
        agent.postProcess.extractVariable,
    );
    const trackerTransformAgents = trackerAgents.filter(agent =>
        !trackerExtractAgents.includes(agent) &&
        (agent.phase === 'post' || agent.phase === 'both') &&
        agent.postProcess?.promptTransformEnabled &&
        String(agent.prompt ?? '').trim(),
    );

    let regexSnapshotChanged = false;
    for (const agent of trackerAgents) {
        const changed = refreshRegexSnapshotForAgentOnMessage(agent.id, messageIndex, {
            generationType,
            includeForcedAgent: true,
            markPendingSave: false,
            respectGenerationTypes: false,
            save: false,
        });
        regexSnapshotChanged = regexSnapshotChanged || changed;
    }

    let chatStateChanged = false;
    let messageDisplayChanged = false;
    const promptRuns = [];
    let trackerRepairs = 0;
    let trackerRepairErrors = 0;
    let currentPromptTransformText = unwrapAssistantResponseWrapper(message.mes);

    let appendBatch = [];
    let fixStaleTarget = false;
    const flushAppendBatch = async () => {
        if (appendBatch.length === 0 || !isFixTargetCurrent() || fixStaleTarget) {
            appendBatch = [];
            return;
        }

        const batchAgents = appendBatch;
        appendBatch = [];

        const batchResult = await runPromptTransformAppendBatch(
            batchAgents,
            message,
            generationType,
            currentPromptTransformText,
            messageIndex,
            { applyToMessage: false, cancelRevision: fixCancelRevision },
        );
        if (!isFixTargetCurrent()) return;
        fixStaleTarget = fixStaleTarget || batchResult.staleTarget === true;
        promptRuns.push(...batchResult.results);
        currentPromptTransformText = batchResult.nextMessageText;

        if (batchResult.changed) {
            chatStateChanged = true;
            messageDisplayChanged = true;
        }
    };

    for (const agent of trackerTransformAgents) {
        if (!isFixTargetCurrent() || fixStaleTarget) break;

        if (getPromptTransformMode(agent) === 'append') {
            appendBatch.push(agent);
            continue;
        }

        await flushAppendBatch();
        if (!isFixTargetCurrent() || fixStaleTarget) return;

        try {
            const result = await runPromptTransformAgent(agent, message, generationType, currentPromptTransformText, messageIndex, {
                applyToMessage: false,
                cancelRevision: fixCancelRevision,
            });
            if (!isFixTargetCurrent() || result.status === 'stale-target') return;
            promptRuns.push(result);
            currentPromptTransformText = result.nextMessageText;

            if (result.changed) {
                chatStateChanged = true;
                messageDisplayChanged = true;
            }
        } catch (error) {
            promptRuns.push({
                agentId: agent.id,
                agentName: agent.name,
                changed: false,
                status: 'error',
                mode: getPromptTransformMode(agent),
                error: describeAgentError(error),
                runner: 'error',
                timestamp: new Date().toISOString(),
            });
        }
    }

    await flushAppendBatch();
    if (!isFixTargetCurrent() || fixStaleTarget) return;

    // Neconyan divergence: Fix Trackers repairs the raw tracker block and then
    // derives metadata from that validated text instead of discarding model output.
    for (const agent of trackerExtractAgents) {
        if (!isFixTargetCurrent()) return;
        if (!isAgentRuntimeAllowed(agent)) continue;

        const inspection = inspectTrackerState(agent, currentPromptTransformText);
        if (inspection.status === 'valid') {
            continue;
        }

        if (!String(agent.prompt ?? '').trim()) {
            trackerRepairErrors++;
            continue;
        }

        try {
            const repairAgent = {
                ...agent,
                prompt: `${String(agent.prompt).trim()}\n\n${TRACKER_REPAIR_INSTRUCTION}`,
                postProcess: {
                    ...agent.postProcess,
                    promptTransformMode: 'append',
                },
            };
            const result = await runPromptTransformAgent(repairAgent, message, generationType, currentPromptTransformText, messageIndex, {
                applyToMessage: false,
                cancelRevision: fixCancelRevision,
            });
            if (!isFixTargetCurrent() || result.status === 'stale-target') return;
            if (!String(result.outputText ?? '').trim() || result.status === 'error' || result.status === 'cancelled') {
                trackerRepairErrors++;
                continue;
            }

            const merged = mergeTrackerRepairPayload(agent, currentPromptTransformText, result.outputText, {
                prepend: shouldPrependPromptTransformOutput(agent, result.outputText),
            });
            if (!merged.changed) {
                trackerRepairErrors++;
                continue;
            }

            currentPromptTransformText = merged.text;
            chatStateChanged = true;
            messageDisplayChanged = true;
            trackerRepairs++;
        } catch (error) {
            trackerRepairErrors++;
            console.warn(`[InChatAgents] Tracker repair failed in agent "${agent.name}":`, error);
        }
    }

    if (!isFixTargetCurrent()) {
        return;
    }

    const utilityAgents = trackerAgents.filter(agent =>
        isAgentRuntimeAllowed(agent) &&
        agent.postProcess?.enabled &&
        agent.postProcess.type !== 'regex' &&
        agent.postProcess.type !== 'extract',
    );

    for (const agent of utilityAgents) {
        const postProcess = agent.postProcess;

        switch (postProcess.type) {
            case 'append': {
                if (!postProcess.appendText) {
                    break;
                }

                const appendedText = substituteParams(postProcess.appendText);
                if (appendedText.trim()) {
                    currentPromptTransformText += appendedText;
                    chatStateChanged = true;
                    messageDisplayChanged = true;
                }
                break;
            }
        }
    }

    currentPromptTransformText = applyAgentRegexScriptsToText(trackerAgents, currentPromptTransformText, {
        characterOverride: message.name, includeDisplay: false,
    });
    if (!isFixTargetCurrent()) return;
    const textChanged = currentPromptTransformText !== message.mes;
    message.mes = currentPromptTransformText;
    target.mes = currentPromptTransformText;
    const trackerMetadataUpdates = reconcileTrackerMetadata(trackerExtractAgents);
    if (trackerMetadataUpdates) chatStateChanged = true;
    if (promptRuns.length > 0 && updatePromptTransformRuns(message, promptRuns)) {
        chatStateChanged = true;
    }

    if (recordAppliedTransformation(message, beforeText, promptRuns, 'Tracker repair')) {
        chatStateChanged = true;
        messageDisplayChanged = true;
    }

    if (textChanged && !await syncPromptTransformMessageStateAsync(message, messageIndex)) return;
    if (!isFixTargetCurrent()) {
        return;
    }

    if (chatStateChanged || regexSnapshotChanged) {
        syncAssistantMessageStateToSwipe(message, messageIndex);
        saveChatDebouncedForAgent({ deferBackup: false });
    }

    if (messageDisplayChanged) {
        scheduleMessageRefresh(messageIndex, message, { deferBackup: true });
    }

    const changedRuns = promptRuns.filter(r => r.changed);
    const failedRuns = promptRuns.filter(r => r.status === 'error');
    const postProcessRuns = utilityAgents.length + trackerMetadataUpdates;
    const errorRuns = failedRuns.length + trackerRepairErrors;
    const parts = [];
    if (trackerRepairs > 0) parts.push(`${trackerRepairs} tracker${trackerRepairs > 1 ? 's' : ''} regenerated`);
    if (changedRuns.length > 0) parts.push(`${changedRuns.length} prompt transform${changedRuns.length > 1 ? 's' : ''} applied`);
    if (postProcessRuns > 0) parts.push(`${postProcessRuns} post-process${postProcessRuns > 1 ? 'es' : ''} run`);
    if (regexSnapshotChanged) parts.push('regex snapshot updated');
    if (errorRuns > 0) parts.push(`${errorRuns} error${errorRuns > 1 ? 's' : ''}`);

    if (parts.length > 0) {
        toastr.success(parts.join(', '), 'Trackers fixed');
    } else {
        toastr.info('No changes made.', 'Trackers fixed');
    }
}
