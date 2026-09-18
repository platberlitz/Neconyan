import { getRequestHeaders, saveSettings, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { uuidv4 } from '../../utils.js';
import { isAgentSetupId, mergeAgentSetupRecord, normalizeAgentSetupPreset } from './setup-presets.js';
import {
    AGENT_REGEX_PLACEMENT,
    AGENT_REGEX_SUBSTITUTE,
    normalizeRegexScript,
} from './regex-scripts.js';
import {
    cacheAgentRegexScripts,
    clearCachedAgentRegexScripts,
    deleteCachedAgentRegexScripts,
} from './regex-snapshot-store.js';

/**
 * @typedef {object} AgentInjection
 * @property {number} position - 0=IN_PROMPT, 1=IN_CHAT, 2=BEFORE_PROMPT
 * @property {number} depth - 0-99, depth in chat history
 * @property {number} role - 0=SYSTEM, 1=USER, 2=ASSISTANT
 * @property {number} order - Ordering at same depth
 * @property {boolean} scan - Scan for World Info keywords
 */

/**
 * @typedef {object} AgentCompanionFeedback
 * @property {boolean} enabled
 * @property {number} depth
 */

/**
 * @typedef {object} AgentCompanionConfig
 * @property {'auto'|'manual'} trigger
 * @property {'card'|'panel'|'hidden'} displayMode
 * @property {'markdown'|'html'|'text'} format
 * @property {number} contextMessages
 * @property {boolean} includeCharacterCard
 * @property {boolean} includePersona
 * @property {boolean} includeWorldInfo
 * @property {boolean} includeHistory
 * @property {boolean} includeInChatHistory
 * @property {number} chatHistoryDepth
 * @property {boolean} includeAllChatHistory
 * @property {boolean} keepInChatHistoryWhenHostHidden
 * @property {number} historyDepth
 * @property {AgentCompanionFeedback} feedback
 * @property {boolean} batch
 * @property {string[]} batchAgentIds
 * @property {boolean} sendContextToCompanions - Send this companion's latest output to selected companions before they generate
 * @property {string[]} contextRecipientAgentIds - Companion agent IDs that should receive this companion's latest output as context
 * @property {string[]} dependencies - Companion agent IDs that should re-run when this agent produces new output
 * @property {boolean} waitForDependencies - Delay this companion when selected dependencies are running in the same pass
 * @property {number} maxTokens
 */

/**
 * @typedef {object} AgentPreProcess
 * @property {'inject'|'intercept'} mode - Inject is the existing setExtensionPrompt flow; intercept rewrites the assembled outgoing context.
 * @property {'pre-generation'|'post-main-generation'} interceptTiming - When intercept mode runs.
 * @property {'replace'|'wrap'|'patch'} applyMode
 * @property {'before'|'after'} wrapPosition
 * @property {string} wrapPrefix
 * @property {string} wrapSuffix
 * @property {string} patchStartTag
 * @property {string} patchEndTag
 * @property {number} maxTokens
 */

/**
 * @typedef {object} AgentPostProcess
 * @property {boolean} enabled
 * @property {'regex'|'append'|'extract'} type
 * @property {string} regexFind
 * @property {string} regexReplace
 * @property {string} regexFlags
 * @property {string} appendText
 * @property {string} extractPattern
 * @property {string} extractVariable
 * @property {boolean} promptTransformEnabled
 * @property {boolean} promptTransformShowNotifications
 * @property {'rewrite'|'append'} promptTransformMode
 * @property {number} promptTransformMaxTokens
 */

/**
 * @typedef {object} AgentConditions
 * @property {string[]} triggerKeywords
 * @property {number} triggerProbability - 0-100
 * @property {string[]} generationTypes
 * @property {boolean} runOnImpersonate - Allows this agent's post passes (prompt pass + agent regex) to rewrite generated impersonation text
 * @property {boolean} runOnCompanionOutputs - Allows this agent's post passes (prompt pass + agent regex) to rewrite companion agent outputs
 * @property {string[]} companionOutputTargetAgentIds - Companion agent/template ids to target; empty targets all companions
 */

/**
 * @typedef {import('../../char-data.js').RegexScriptData} AgentRegexScript
 */

/**
 * @typedef {object} AgentToolDef
 * @property {string} name - Unique ToolManager name (e.g., 'Pathfinder_Search')
 * @property {string} displayName - Human-readable label
 * @property {string} description - LLM-facing instruction text
 * @property {object} parameters - OpenAI JSON Schema for tool parameters
 * @property {string} actionKey - Key resolved from ToolActionRegistry at runtime
 * @property {string} [formatMessageKey] - Key for display text formatter
 * @property {boolean} [shouldRegister=true] - Whether to include in LLM tool list
 * @property {boolean} [stealth=false] - If true, result hidden from chat
 * @property {boolean} [enabled=true] - Per-tool toggle within the agent
 */

/**
 * @typedef {object} InChatAgent
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} icon
 * @property {'content'|'tracker'|'randomizer'|'custom'|'tool'|'companion'} category
 * @property {'inline'|'companion'} execution
 * @property {string[]} tags
 * @property {number} version
 * @property {string} author
 * @property {string} prompt
 * @property {'pre'|'post'|'both'} phase
 * @property {AgentInjection} injection
 * @property {AgentCompanionConfig} companion
 * @property {AgentPreProcess} preProcess
 * @property {AgentPostProcess} postProcess
 * @property {AgentRegexScript[]} regexScripts
 * @property {string} connectionProfile
 * @property {string} modelOverride - Optional model name to use instead of profile default
 * @property {string} sourceTemplateId
 * @property {boolean} enabled
 * @property {boolean} favorite
 * @property {AgentConditions} conditions
 * @property {AgentToolDef[]} tools - Tool definitions for 'tool' category agents
 * @property {object} settings - Per-agent settings object for tool agents
 * @property {boolean} phaseLocked - Prevent bundled-template migrations from overriding user customizations
 */

/** @type {InChatAgent[]} */
let agents = [];

/** @type {Map<string, (agent: InChatAgent) => boolean>} */
const runtimeAgentFilters = new Map();

/** @type {AgentGroup[]} */
let builtinGroups = [];

/** @type {AgentGroup[]} */
let customGroups = [];

export const AGENT_CHAT_SCOPES = Object.freeze({
    INDIVIDUAL: 'individual',
    GROUP: 'group',
});

const AGENT_CHAT_SCOPE_KEYS = Object.values(AGENT_CHAT_SCOPES);

function createDefaultScopedEnabledAgentIds() {
    return {
        [AGENT_CHAT_SCOPES.INDIVIDUAL]: [],
        [AGENT_CHAT_SCOPES.GROUP]: [],
    };
}

/** Global settings for the In-Chat Agents extension. */
const defaultGlobalSettings = {
    enabled: true,
    pathfinderEnabled: true,
    separateRecentChats: false,
    enabledAgentIdsByChatType: createDefaultScopedEnabledAgentIds(),
    scopedEnabledAgentIdsInitialized: false,
    connectionProfile: '',
    companionConnectionProfile: '',
    promptTransformShowNotifications: true,
    postMainInterceptShowMessageFirst: true,
    appendAgentsExecutionMode: 'parallel',
    companionExecutionMode: 'parallel',
    companionConcurrentWithPostGen: false,
    helperPrefillMessages: '',
    hiddenCompanionAgentIds: [],
};
let globalSettings = structuredClone(defaultGlobalSettings);

/** @type {Array<{id: string, name: string, version: number, agents: object[], globalSettings: object}>} */
let agentSetupPresets = [];

/**
 * Returns the global settings.
 * @returns {{ enabled: boolean, pathfinderEnabled: boolean, separateRecentChats: boolean, enabledAgentIdsByChatType: Record<string, string[]>, scopedEnabledAgentIdsInitialized: boolean, connectionProfile: string, promptTransformShowNotifications: boolean, postMainInterceptShowMessageFirst: boolean, appendAgentsExecutionMode: 'parallel'|'sequential', helperPrefillMessages: string, hiddenCompanionAgentIds: string[] }}
 */
export function getGlobalSettings() {
    return globalSettings;
}

export function getAgentSetupPresets() {
    return agentSetupPresets.map(preset => structuredClone(preset));
}

export function getAgentSetupPresetById(id) {
    const normalizedId = String(id ?? '').trim();
    const preset = agentSetupPresets.find(item => item.id === normalizedId);
    return preset ? structuredClone(preset) : null;
}

export function createAgentSetupSnapshot() {
    if (!areAgentsLoaded()) throw new Error('Wait for the agent library to finish loading.');
    return {
        version: 1,
        agents: getAgents().map(agent => structuredClone(agent)),
        globalSettings: structuredClone(globalSettings),
    };
}

/**
 * Startup migrations record their progress in the global settings (keys ending in
 * `Version` or `Applied`). A setup saved before a migration must not roll those markers
 * back, or the migration would run again over the restored library.
 * @param {object} previous
 * @param {object} next
 * @returns {object}
 */
function keepMigrationMarkersForward(previous, next) {
    const result = { ...next };
    for (const [key, value] of Object.entries(previous ?? {})) {
        if (!/(Version|Applied)$/.test(key)) continue;
        if (typeof value === 'number' && (typeof result[key] !== 'number' || result[key] < value)) result[key] = value;
        if (value === true && result[key] !== true) result[key] = true;
    }
    return result;
}

/**
 * The exact global settings that applying `preset` would produce, so the "current setup"
 * check and the apply path cannot disagree.
 * @param {{ globalSettings: object }} preset
 * @returns {object}
 */
function buildAppliedGlobalSettings(preset) {
    return keepMigrationMarkersForward(
        globalSettings,
        mergeAgentSetupRecord({ ...globalSettings, ...defaultGlobalSettings }, preset.globalSettings),
    );
}

export function isAgentSetupCurrent(preset) {
    if (!preset) return false;
    const included = new Set(preset.agents.map(agent => agent.id));
    const matches = (current, saved) => current && JSON.stringify(current) === JSON.stringify(mergeAgentSetupRecord(current, saved));
    const applied = buildAppliedGlobalSettings(preset);
    return preset.agents.every(agent => matches(getAgentById(agent.id), agent))
        && getAgents().every(agent => included.has(agent.id) || !isAgentEnabledForAnyScope(agent))
        && JSON.stringify(globalSettings) === JSON.stringify(normalizeGlobalSettingsRecord(structuredClone(applied), applied));
}

export async function loadAgentSetupPresets({ canPersist = () => true } = {}) {
    if (!canPersist()) throw new Error('The active account changed.');
    const response = await fetch('/api/in-chat-agents/presets/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error('Failed to load agent setups.');

    const data = await response.json();
    if (!canPersist()) throw new Error('The active account changed.');
    if (!Array.isArray(data)) throw new Error('The server returned an invalid setup list.');
    agentSetupPresets = data.map(normalizeAgentSetupPreset).filter(Boolean);
    return getAgentSetupPresets();
}

export async function saveAgentSetupPreset(name, { id = uuidv4(), snapshot, canPersist = () => true } = {}) {
    if (!snapshot) await agentSaveChain;
    if (!canPersist()) throw new Error('The active account changed.');
    const preset = normalizeAgentSetupPreset({
        ...(snapshot ?? createAgentSetupSnapshot()),
        id,
        name,
    });
    if (!preset) throw new Error('Give the agent setup a valid name.');

    const response = await fetch('/api/in-chat-agents/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(preset),
    });
    if (!response.ok) throw new Error('Agent setup could not be saved.');

    const saved = normalizeAgentSetupPreset(await response.json());
    if (!saved) throw new Error('The server returned an invalid agent setup.');
    if (!canPersist()) throw new Error('The active account changed.');
    const index = agentSetupPresets.findIndex(item => item.id === saved.id);
    if (index >= 0) agentSetupPresets[index] = saved;
    else agentSetupPresets.push(saved);
    return structuredClone(saved);
}

export async function deleteAgentSetupPreset(id, { canPersist = () => true } = {}) {
    const normalizedId = id;
    if (!isAgentSetupId(normalizedId)) throw new Error('Invalid agent setup.');
    if (!canPersist()) throw new Error('The active account changed.');

    const response = await fetch('/api/in-chat-agents/presets/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: normalizedId }),
    });
    if (!response.ok) throw new Error('Agent setup could not be deleted.');
    if (!canPersist()) throw new Error('The active account changed.');

    agentSetupPresets = agentSetupPresets.filter(item => item.id !== normalizedId);
    return true;
}

/**
 * Updates global settings (merge).
 * @param {Partial<typeof globalSettings>} update
 */
export function setGlobalSettings(update) {
    if (!update || typeof update !== 'object') {
        return;
    }

    for (const [key, value] of Object.entries(update)) {
        Object.defineProperty(globalSettings, key, { value, enumerable: true, writable: true, configurable: true });
    }
    normalizeGlobalSettingsRecord(globalSettings, update);
}

/**
 * Normalises a global settings record in place, the same way setGlobalSettings does, so a
 * predicted record (see isAgentSetupCurrent) matches what the store would actually hold.
 * @param {object} settings
 * @param {object} update The update that produced `settings`.
 * @returns {object}
 */
function normalizeGlobalSettingsRecord(settings, update) {
    settings.pathfinderEnabled = settings.pathfinderEnabled !== false;
    settings.postMainInterceptShowMessageFirst = settings.postMainInterceptShowMessageFirst !== false;
    settings.enabledAgentIdsByChatType = normalizeScopedEnabledAgentIds(settings.enabledAgentIdsByChatType);
    settings.helperPrefillMessages = typeof settings.helperPrefillMessages === 'string'
        ? settings.helperPrefillMessages
        : '';
    settings.hiddenCompanionAgentIds = normalizeAgentIdCollection(settings.hiddenCompanionAgentIds);

    if (!Object.hasOwn(update, 'scopedEnabledAgentIdsInitialized') && !settings.scopedEnabledAgentIdsInitialized) {
        const scopedSetting = update.enabledAgentIdsByChatType;
        settings.scopedEnabledAgentIdsInitialized = Boolean(
            scopedSetting &&
            typeof scopedSetting === 'object' &&
            AGENT_CHAT_SCOPE_KEYS.some(scope => Object.hasOwn(scopedSetting, scope)),
        );
    }
    return settings;
}

function normalizeAgentIdCollection(value = []) {
    if (!value || typeof value[Symbol.iterator] !== 'function') {
        return [];
    }

    return normalizeAgentIdList([...value]).sort();
}

function normalizeAgentIdList(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return Array.from(new Set(
        value
            .map(id => String(id ?? '').trim())
            .filter(Boolean),
    ));
}

export function getHiddenAgentIds() {
    return new Set(globalSettings.hiddenCompanionAgentIds);
}

export function setHiddenAgentIds(ids) {
    const nextHiddenIds = normalizeAgentIdCollection(ids);
    const previous = JSON.stringify(globalSettings.hiddenCompanionAgentIds);
    const next = JSON.stringify(nextHiddenIds);

    globalSettings.hiddenCompanionAgentIds = nextHiddenIds;
    if (previous !== next) {
        persistAgentGlobalSettings();
    }
}

export function isAgentHidden(agentId) {
    const normalizedAgentId = String(agentId ?? '').trim();
    return Boolean(normalizedAgentId && getHiddenAgentIds().has(normalizedAgentId));
}

function normalizeAgentChatScope(scope = AGENT_CHAT_SCOPES.INDIVIDUAL) {
    return AGENT_CHAT_SCOPE_KEYS.includes(scope) ? scope : AGENT_CHAT_SCOPES.INDIVIDUAL;
}

function normalizeScopedEnabledAgentIds(value = {}) {
    return {
        [AGENT_CHAT_SCOPES.INDIVIDUAL]: normalizeAgentIdList(value?.[AGENT_CHAT_SCOPES.INDIVIDUAL]),
        [AGENT_CHAT_SCOPES.GROUP]: normalizeAgentIdList(value?.[AGENT_CHAT_SCOPES.GROUP]),
    };
}

function ensureScopedEnabledAgentIds() {
    globalSettings.enabledAgentIdsByChatType = normalizeScopedEnabledAgentIds(globalSettings.enabledAgentIdsByChatType);
    return globalSettings.enabledAgentIdsByChatType;
}

export function getActiveAgentChatScope() {
    try {
        return getContext()?.groupId ? AGENT_CHAT_SCOPES.GROUP : AGENT_CHAT_SCOPES.INDIVIDUAL;
    } catch {
        return AGENT_CHAT_SCOPES.INDIVIDUAL;
    }
}

export function getAgentChatScopeLabel(scope = getActiveAgentChatScope()) {
    return normalizeAgentChatScope(scope) === AGENT_CHAT_SCOPES.GROUP ? 'Group chats' : 'Individual chats';
}

export function areAgentTogglesScopedByChatType() {
    return Boolean(globalSettings.separateRecentChats);
}

function getScopedEnabledAgentIdSet(scope = getActiveAgentChatScope()) {
    const scopedEnabledAgentIds = ensureScopedEnabledAgentIds();
    return new Set(scopedEnabledAgentIds[normalizeAgentChatScope(scope)]);
}

function isAgentIdEnabledInAnyScope(agentId, scopedEnabledAgentIds = ensureScopedEnabledAgentIds()) {
    const normalizedAgentId = String(agentId ?? '').trim();
    if (!normalizedAgentId) {
        return false;
    }

    return AGENT_CHAT_SCOPE_KEYS.some(scope => scopedEnabledAgentIds[scope].includes(normalizedAgentId));
}

export function isAgentEnabledForScope(agent, scope = getActiveAgentChatScope()) {
    if (!areAgentTogglesScopedByChatType() || !globalSettings.scopedEnabledAgentIdsInitialized) {
        return Boolean(agent?.enabled);
    }

    const agentId = String(agent?.id ?? '').trim();
    if (!agentId) {
        return false;
    }

    return getScopedEnabledAgentIdSet(scope).has(agentId);
}

export function isAgentEnabledForCurrentScope(agent) {
    return isAgentEnabledForScope(agent, getActiveAgentChatScope());
}

export function isAgentEnabledForAnyScope(agent) {
    if (!areAgentTogglesScopedByChatType() || !globalSettings.scopedEnabledAgentIdsInitialized) {
        return Boolean(agent?.enabled);
    }

    const agentId = String(agent?.id ?? '').trim();
    if (!agentId) {
        return false;
    }

    return isAgentIdEnabledInAnyScope(agentId);
}

export function setAgentEnabledForScope(agent, enabled, scope = getActiveAgentChatScope()) {
    if (!agent) {
        return false;
    }

    const nextEnabled = Boolean(enabled);

    if (!areAgentTogglesScopedByChatType()) {
        const changed = Boolean(agent.enabled) !== nextEnabled;
        agent.enabled = nextEnabled;
        return changed;
    }

    const agentId = String(agent.id ?? '').trim();
    if (!agentId) {
        return false;
    }

    const normalizedScope = normalizeAgentChatScope(scope);
    const scopedEnabledAgentIds = ensureScopedEnabledAgentIds();
    const enabledIds = new Set(scopedEnabledAgentIds[normalizedScope]);
    const wasEnabled = enabledIds.has(agentId);

    if (nextEnabled) {
        enabledIds.add(agentId);
    } else {
        enabledIds.delete(agentId);
    }

    scopedEnabledAgentIds[normalizedScope] = [...enabledIds];
    globalSettings.scopedEnabledAgentIdsInitialized = true;

    const previousLegacyEnabled = Boolean(agent.enabled);
    agent.enabled = isAgentEnabledForAnyScope(agent);

    return wasEnabled !== nextEnabled || previousLegacyEnabled !== Boolean(agent.enabled);
}

export function setAgentEnabledForCurrentScope(agent, enabled) {
    return setAgentEnabledForScope(agent, enabled, getActiveAgentChatScope());
}

function syncLegacyAgentEnabledFlagsFromScopes() {
    for (const agent of agents) {
        agent.enabled = isAgentEnabledForAnyScope(agent);
    }
}

export function initializeScopedAgentEnableState(scope = getActiveAgentChatScope()) {
    if (!areAgentsLoaded()) return false;
    ensureScopedEnabledAgentIds();

    if (globalSettings.scopedEnabledAgentIdsInitialized) {
        return false;
    }

    const normalizedScope = normalizeAgentChatScope(scope);
    const enabledAgentIds = agents
        .filter(agent => agent.enabled)
        .map(agent => String(agent.id ?? '').trim())
        .filter(Boolean);

    globalSettings.enabledAgentIdsByChatType = createDefaultScopedEnabledAgentIds();
    globalSettings.enabledAgentIdsByChatType[normalizedScope] = enabledAgentIds;
    globalSettings.scopedEnabledAgentIdsInitialized = true;
    syncLegacyAgentEnabledFlagsFromScopes();
    return true;
}

export function reconcileScopedEnabledAgentIdsFromLegacyFlags(scope = getActiveAgentChatScope()) {
    if (!areAgentsLoaded()) return false;
    if (!areAgentTogglesScopedByChatType() || !globalSettings.scopedEnabledAgentIdsInitialized) {
        return false;
    }

    const normalizedScope = normalizeAgentChatScope(scope);
    const scopedEnabledAgentIds = ensureScopedEnabledAgentIds();
    const enabledIds = new Set(scopedEnabledAgentIds[normalizedScope]);
    let changed = false;

    for (const agent of agents) {
        if (!agent?.enabled) {
            continue;
        }

        const agentId = String(agent.id ?? '').trim();
        if (!agentId || isAgentIdEnabledInAnyScope(agentId, scopedEnabledAgentIds)) {
            continue;
        }

        enabledIds.add(agentId);
        changed = true;
    }

    if (!changed) {
        return false;
    }

    scopedEnabledAgentIds[normalizedScope] = [...enabledIds];
    syncLegacyAgentEnabledFlagsFromScopes();
    return true;
}

export function persistAgentGlobalSettings() {
    extension_settings.inChatAgents = {
        ...(extension_settings.inChatAgents ?? {}),
        globalSettings: structuredClone(globalSettings),
    };
    delete extension_settings.inChatAgents.groups;
    saveSettingsDebounced();
}

function removeAgentIdFromScopedEnabledAgentIds(id) {
    const agentId = String(id ?? '').trim();
    if (!agentId) {
        return false;
    }

    const scopedEnabledAgentIds = ensureScopedEnabledAgentIds();
    let changed = false;

    for (const scope of AGENT_CHAT_SCOPE_KEYS) {
        const nextIds = scopedEnabledAgentIds[scope].filter(enabledId => enabledId !== agentId);
        if (nextIds.length !== scopedEnabledAgentIds[scope].length) {
            scopedEnabledAgentIds[scope] = nextIds;
            changed = true;
        }
    }

    return changed;
}

function normalizeConnectionProfileId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function getLiveConnectionManagerProfile() {
    const connectionProfilesSelect = document.getElementById('connection_profiles');

    if (!(connectionProfilesSelect instanceof HTMLSelectElement)) {
        return '';
    }

    return normalizeConnectionProfileId(connectionProfilesSelect.value);
}

export function getActiveConnectionProfile() {
    const globalProfileId = normalizeConnectionProfileId(globalSettings.connectionProfile);
    if (globalProfileId) {
        return globalProfileId;
    }

    const liveConnectionManagerProfile = getLiveConnectionManagerProfile();
    if (liveConnectionManagerProfile) {
        return liveConnectionManagerProfile;
    }

    const selectedConnectionManagerProfile = normalizeConnectionProfileId(
        extension_settings?.connectionManager?.selectedProfile,
    );
    return selectedConnectionManagerProfile || '';
}

export function getDefaultConnectionProfile() {
    return getActiveConnectionProfile();
}

export function resolveConnectionProfile(profileId = '') {
    const explicitProfileId = normalizeConnectionProfileId(profileId);
    if (explicitProfileId) {
        return explicitProfileId;
    }

    return getActiveConnectionProfile();
}

/**
 * Resolves the connection profile for a Companion run: the agent's own override wins,
 * then the dedicated companion default, then the regular extension default chain.
 * Keeps cheap auxiliary models separate from the post-generation default.
 * @param {string} profileId Agent-level profile override
 * @returns {string}
 */
export function resolveCompanionConnectionProfile(profileId = '') {
    const explicitProfileId = normalizeConnectionProfileId(profileId);
    if (explicitProfileId) {
        return explicitProfileId;
    }

    const companionProfileId = normalizeConnectionProfileId(globalSettings.companionConnectionProfile);
    if (companionProfileId) {
        return companionProfileId;
    }

    return getActiveConnectionProfile();
}

/**
 * Checks whether an agent belongs on the given agent-list tab.
 * @param {InChatAgent} agent
 * @param {'all'|'pre'|'post'|'companion'|string} tab
 * @returns {boolean}
 */
export function agentMatchesListTab(agent, tab) {
    switch (tab) {
        case 'pre':
            return !isCompanionAgent(agent) && ['pre', 'both'].includes(agent?.phase);
        case 'post':
            return !isCompanionAgent(agent) && ['post', 'both'].includes(agent?.phase);
        case 'companion':
            return isCompanionAgent(agent);
        default:
            return true;
    }
}

export const LEGACY_AGENT_MAX_TOKENS = 2000;
export const DEFAULT_AGENT_MAX_TOKENS = 8192;
export const MAX_AGENT_MAX_TOKENS = 64000;
export const PATHFINDER_TEMPLATE_ID = 'tpl-pathfinder';

export function areAgentsGloballyEnabled() {
    return globalSettings.enabled !== false && !agentSetupApplying;
}

export function isPathfinderSubmoduleEnabled() {
    return globalSettings.pathfinderEnabled !== false;
}

export function setPathfinderSubmoduleEnabled(enabled) {
    setGlobalSettings({ pathfinderEnabled: enabled !== false });
}

function getAgentTemplateName(value) {
    return String(value ?? '').trim().toLowerCase();
}

function isLikelyBundledAgentTemplateMatch(agent, template) {
    const agentName = getAgentTemplateName(agent?.name);
    const templateName = getAgentTemplateName(template?.name);
    if (!agentName || agentName !== templateName) {
        return false;
    }

    const agentAuthor = String(agent?.author ?? '').trim().toLowerCase();
    const templateAuthor = String(template?.author ?? '').trim().toLowerCase();
    if (!agentAuthor || !templateAuthor || agentAuthor !== templateAuthor) {
        return false;
    }

    const agentCategory = normalizeAgentCategory(agent?.category, agent?.sourceTemplateId, agent?.name);
    const templateCategory = normalizeAgentCategory(template?.category, template?.id, template?.name);
    return agentCategory === templateCategory;
}

export function findTemplateForAgentSnapshot(agent, templates = []) {
    const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
    if (sourceTemplateId) {
        return templates.find(template => String(template?.id ?? '').trim() === sourceTemplateId) ?? null;
    }

    const agentName = getAgentTemplateName(agent?.name);
    const agentPrompt = String(agent?.prompt ?? '').trim();
    if (!agentName) {
        return null;
    }

    const exactTemplate = templates.find(template =>
        getAgentTemplateName(template?.name) === agentName &&
        String(template?.prompt ?? '').trim() === agentPrompt,
    );
    if (exactTemplate) {
        return exactTemplate;
    }

    const likelyTemplates = templates.filter(template => isLikelyBundledAgentTemplateMatch(agent, template));
    return likelyTemplates.length === 1 ? likelyTemplates[0] : null;
}

function hasPathfinderToolMetadata(agent) {
    return Array.isArray(agent?.tools) && agent.tools.some(tool => String(tool?.name ?? '').startsWith('Pathfinder_'));
}

export function isBundledPathfinderAgentSnapshot(agent, templates = []) {
    const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
    if (sourceTemplateId === PATHFINDER_TEMPLATE_ID) {
        return true;
    }

    const template = findTemplateForAgentSnapshot(agent, templates);
    if (String(template?.id ?? '').trim() === PATHFINDER_TEMPLATE_ID) {
        return true;
    }

    const agentName = String(agent?.name ?? '').trim().toLowerCase();
    const agentPrompt = String(agent?.prompt ?? '').trim();
    const agentAuthor = String(agent?.author ?? '').trim().toLowerCase();
    const category = normalizeAgentCategory(agent?.category, agent?.sourceTemplateId, agent?.name);
    return agentName === 'pathfinder' &&
        category === 'tool' &&
        agentPrompt === '' &&
        (agentAuthor === 'sillybunny' || hasPathfinderToolMetadata(agent));
}

function getBundledAgentDuplicateKey(agent, templates = []) {
    if (isBundledPathfinderAgentSnapshot(agent, templates)) {
        return `template\u0000${PATHFINDER_TEMPLATE_ID}`;
    }

    const agentName = String(agent?.name ?? '').trim().toLowerCase();
    const agentPrompt = String(agent?.prompt ?? '').trim();
    if (!agentName || !agentPrompt) {
        return '';
    }

    return `${agentName}\u0000${agentPrompt}`;
}

function getPathfinderKeepRank(agent) {
    const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
    if (sourceTemplateId === PATHFINDER_TEMPLATE_ID && !agent?.phaseLocked) {
        return 0;
    }
    if (sourceTemplateId === PATHFINDER_TEMPLATE_ID) {
        return 1;
    }
    if (!agent?.phaseLocked) {
        return 2;
    }
    return 3;
}

function choosePathfinderAgentToKeep(agents) {
    return [...agents].sort((a, b) => getPathfinderKeepRank(a) - getPathfinderKeepRank(b))[0] ?? null;
}

function chooseSameTemplateAgentToKeep(agents, template) {
    const templatePrompt = template ? String(template?.prompt ?? '').trim() : null;
    if (templatePrompt !== null) {
        const currentTemplatePromptAgent = agents.find(agent => String(agent?.prompt ?? '').trim() === templatePrompt);
        if (currentTemplatePromptAgent) {
            return currentTemplatePromptAgent;
        }
    }

    return agents.find(agent => agent?.enabled) ?? agents[0] ?? null;
}

function chooseBundledTemplateAgentToKeep(agents, template) {
    const templateId = String(template?.id ?? '').trim();
    const templatePrompt = String(template?.prompt ?? '').trim();
    const withCurrentPrompt = agents.find(agent =>
        String(agent?.sourceTemplateId ?? '').trim() === templateId &&
        String(agent?.prompt ?? '').trim() === templatePrompt,
    );
    if (withCurrentPrompt) {
        return withCurrentPrompt;
    }

    const currentPromptAgent = agents.find(agent => String(agent?.prompt ?? '').trim() === templatePrompt);
    if (currentPromptAgent) {
        return currentPromptAgent;
    }

    const sourceBackedEnabled = agents.find(agent => String(agent?.sourceTemplateId ?? '').trim() === templateId && agent?.enabled);
    if (sourceBackedEnabled) {
        return sourceBackedEnabled;
    }

    return agents.find(agent => String(agent?.sourceTemplateId ?? '').trim() === templateId)
        ?? agents.find(agent => agent?.enabled)
        ?? agents[0]
        ?? null;
}

/**
 * Automatic cleanup may only delete copies that are demonstrably leftovers of an
 * automatic seed or migration: paused everywhere, not locked, not favourited, and
 * either carrying the current template prompt (a fresh seed) or identical in name
 * and prompt to the copy being kept. Anything else may be a deliberate 'Add another'.
 */
function isAutomaticDuplicateCopy(agent, keepAgent, template = null, templates = []) {
    if (!agent?.id || agent.phaseLocked || agent.favorite) {
        return false;
    }
    if (Boolean(agent.enabled) || isAgentEnabledForAnyScope(agent)) {
        return false;
    }

    const agentPrompt = String(agent?.prompt ?? '').trim();
    const templatePrompt = template ? String(template?.prompt ?? '').trim() : null;
    if (templatePrompt !== null && agentPrompt === templatePrompt) {
        return true;
    }

    const agentKey = getBundledAgentDuplicateKey(agent, templates);
    return Boolean(agentKey) && agentKey === getBundledAgentDuplicateKey(keepAgent, templates);
}

function cloneSettings(settings = {}) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return {};
    }

    return structuredClone(settings);
}

export function buildLatestBundledAgentSnapshot(agent, template) {
    const latest = normalizeAgent({
        ...createDefaultAgent(),
        ...structuredClone(template ?? {}),
        id: typeof agent?.id === 'string' && agent.id.trim() ? agent.id.trim() : uuidv4(),
        sourceTemplateId: String(template?.id ?? agent?.sourceTemplateId ?? '').trim(),
        enabled: Boolean(agent?.enabled),
        favorite: Boolean(agent?.favorite),
        connectionProfile: typeof agent?.connectionProfile === 'string' ? agent.connectionProfile : '',
        modelOverride: typeof agent?.modelOverride === 'string' ? agent.modelOverride : '',
        settings: cloneSettings(agent?.settings),
        phaseLocked: false,
    });

    latest.injection = {
        ...latest.injection,
        order: Number.isFinite(Number(agent?.injection?.order))
            ? Number(agent.injection.order)
            : latest.injection.order,
    };

    // Preserve the stored agent's companion config so user customizations
    // (trigger, displayMode, context toggles, format, etc.) survive template
    // refreshes. Template companion config changes should be propagated via
    // targeted version migrations in index.js instead.
    if (agent?.companion && typeof agent.companion === 'object' && !Array.isArray(agent.companion)) {
        latest.companion = normalizeCompanionConfig(agent.companion);
    }

    return latest;
}

function normalizedAgentJson(agent) {
    return JSON.stringify(normalizeAgent(agent ?? {}));
}

export function getBundledAgentLatestTemplatePlan(agentList = [], templateList = []) {
    const groupsByTemplateId = new Map();
    const templatesById = new Map();

    for (const agent of agentList) {
        if (!agent || agent.phaseLocked) {
            continue;
        }

        const template = findTemplateForAgentSnapshot(agent, templateList);
        const templateId = String(template?.id ?? '').trim();
        if (!templateId) {
            continue;
        }

        templatesById.set(templateId, template);
        if (!groupsByTemplateId.has(templateId)) {
            groupsByTemplateId.set(templateId, []);
        }
        groupsByTemplateId.get(templateId).push(agent);
    }

    const redundantIds = new Set(getRedundantBundledAgentDuplicateIds(agentList, templateList));
    const updates = [];

    for (const [templateId, grouped] of groupsByTemplateId.entries()) {
        const template = templatesById.get(templateId);
        const keepAgent = chooseBundledTemplateAgentToKeep(grouped, template);
        if (!keepAgent?.id) {
            continue;
        }

        for (const agent of grouped) {
            if (agent?.id && agent.id !== keepAgent.id && isAutomaticDuplicateCopy(agent, keepAgent, template, templateList)) {
                redundantIds.add(agent.id);
            }
        }

        const keepAgentVersion = Number(keepAgent?.version ?? 1);
        const templateVersion = Number(template?.version ?? 1);
        if (
            (Number.isFinite(keepAgentVersion) ? keepAgentVersion : 1) >=
            (Number.isFinite(templateVersion) ? templateVersion : 1)
        ) {
            continue;
        }

        const latestAgent = buildLatestBundledAgentSnapshot(keepAgent, template);
        if (normalizedAgentJson(latestAgent) !== normalizedAgentJson(keepAgent)) {
            updates.push({
                agentId: keepAgent.id,
                templateId,
                agent: latestAgent,
            });
        }
    }

    return {
        updates,
        redundantIds: [...redundantIds].filter(id => !updates.some(update => update.agentId === id)),
    };
}

export function getRedundantBundledAgentDuplicateIds(agentList = [], templateList = []) {
    const groupedAgents = new Map();

    for (const agent of agentList) {
        const key = getBundledAgentDuplicateKey(agent, templateList);
        if (!key) {
            continue;
        }

        if (!groupedAgents.has(key)) {
            groupedAgents.set(key, []);
        }

        groupedAgents.get(key).push(agent);
    }

    const redundantIds = new Set();

    for (const grouped of groupedAgents.values()) {
        if (grouped.length < 2) {
            continue;
        }

        const pathfinderAgents = grouped.filter(agent => isBundledPathfinderAgentSnapshot(agent, templateList));
        if (pathfinderAgents.length > 1) {
            const keepAgent = choosePathfinderAgentToKeep(pathfinderAgents);
            for (const agent of pathfinderAgents) {
                if (agent?.id && agent.id !== keepAgent?.id && !agent.phaseLocked) {
                    redundantIds.add(agent.id);
                }
            }
            continue;
        }

        const templateBacked = grouped.filter(agent => String(agent?.sourceTemplateId ?? '').trim());
        const unsourced = grouped.filter(agent => !String(agent?.sourceTemplateId ?? '').trim());

        if (templateBacked.length !== 1 || unsourced.length === 0) {
            continue;
        }

        const template = findTemplateForAgentSnapshot(templateBacked[0], templateList);
        if (!template) {
            continue;
        }

        for (const agent of unsourced) {
            if (isAutomaticDuplicateCopy(agent, templateBacked[0], template, templateList)) {
                redundantIds.add(agent.id);
            }
        }
    }

    const agentsByTemplateId = new Map();
    for (const agent of agentList) {
        const sourceTemplateId = String(agent?.sourceTemplateId ?? '').trim();
        if (!sourceTemplateId) {
            continue;
        }

        if (!agentsByTemplateId.has(sourceTemplateId)) {
            agentsByTemplateId.set(sourceTemplateId, []);
        }

        agentsByTemplateId.get(sourceTemplateId).push(agent);
    }

    for (const grouped of agentsByTemplateId.values()) {
        if (grouped.length < 2) {
            continue;
        }

        const template = findTemplateForAgentSnapshot(grouped[0], templateList);
        const keepAgent = chooseSameTemplateAgentToKeep(grouped, template);
        for (const agent of grouped) {
            if (agent?.id && agent.id !== keepAgent?.id && isAutomaticDuplicateCopy(agent, keepAgent, template, templateList)) {
                redundantIds.add(agent.id);
            }
        }
    }

    return [...redundantIds];
}

export function getPromptTransformMode(agent) {
    return agent?.postProcess?.promptTransformMode === 'append' ? 'append' : 'rewrite';
}

export function normalizePromptTransformMaxTokens(value) {
    if (!Number.isFinite(Number(value))) {
        return DEFAULT_AGENT_MAX_TOKENS;
    }

    return Math.max(16, Math.min(MAX_AGENT_MAX_TOKENS, Number(value)));
}

export function normalizePreProcessMaxTokens(value) {
    if (!Number.isFinite(Number(value))) {
        return DEFAULT_AGENT_MAX_TOKENS;
    }

    return Math.max(16, Math.min(MAX_AGENT_MAX_TOKENS, Number(value)));
}

function clampNumber(value, fallback, min, max) {
    if (!Number.isFinite(Number(value))) {
        return fallback;
    }

    return Math.max(min, Math.min(max, Number(value)));
}

/**
 * Normalises a list of agent IDs used by Companion links.
 * IDs are compared exactly (agent lookup is case-sensitive) and never truncated,
 * because a shortened or case-folded ID would point at nothing after reload.
 * @param {string[]|string} value
 * @param {number} limit
 * @returns {string[]}
 */
export function normalizeStringIdList(value = [], limit = 500) {
    const rawValues = Array.isArray(value)
        ? value
        : String(value ?? '').split(/[\n,]/);
    const seenIds = new Set();
    const ids = [];

    for (const rawValue of rawValues) {
        const id = String(rawValue ?? '').trim();
        if (!id || seenIds.has(id)) continue;

        seenIds.add(id);
        ids.push(id);
        if (ids.length >= limit) break;
    }

    return ids;
}

/**
 * Creates the default Companion execution config.
 * @returns {AgentCompanionConfig}
 */
export function createDefaultCompanionConfig() {
    return {
        trigger: 'auto',
        // Companions live in the slide-out panel by default; in-chat cards are an opt-in.
        displayMode: 'panel',
        format: 'markdown',
        rawPrompt: false,
        inlinePhase: '',
        minContextTokens: 0,
        contextMessages: 10,
        includeCharacterCard: true,
        includePersona: true,
        includeWorldInfo: true,
        includeAuthorsNote: true,
        includeSystemPrompt: true,
        includeHistory: true,
        includeInChatHistory: false,
        chatHistoryDepth: 1,
        includeAllChatHistory: true,
        keepInChatHistoryWhenHostHidden: false,
        historyDepth: 3,
        feedback: {
            enabled: false,
            depth: 1,
        },
        batch: false,
        batchAgentIds: [],
        sendContextToCompanions: false,
        contextRecipientAgentIds: [],
        dependencies: [],
        waitForDependencies: false,
        maxTokens: MAX_AGENT_MAX_TOKENS,
    };
}

/**
 * Normalizes Companion execution settings loaded from disk or import.
 * @param {Partial<AgentCompanionConfig>} raw
 * @returns {AgentCompanionConfig}
 */
export function normalizeCompanionConfig(raw = {}) {
    const defaults = createDefaultCompanionConfig();
    const rawConfig = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const rawFeedback = rawConfig.feedback && typeof rawConfig.feedback === 'object' && !Array.isArray(rawConfig.feedback)
        ? rawConfig.feedback
        : {};

    return {
        ...defaults,
        ...rawConfig,
        trigger: ['auto', 'manual'].includes(String(rawConfig.trigger))
            ? String(rawConfig.trigger)
            : defaults.trigger,
        displayMode: ['card', 'panel', 'hidden'].includes(String(rawConfig.displayMode))
            ? String(rawConfig.displayMode)
            : defaults.displayMode,
        format: ['markdown', 'html', 'text'].includes(String(rawConfig.format))
            ? String(rawConfig.format)
            : defaults.format,
        rawPrompt: Boolean(rawConfig.rawPrompt),
        inlinePhase: ['pre', 'post', 'both'].includes(String(rawConfig.inlinePhase)) ? String(rawConfig.inlinePhase) : '',
        minContextTokens: clampNumber(rawConfig.minContextTokens, defaults.minContextTokens, 0, 200000),
        // Neconyan: no upper bound. These are "how far back to look" dials, and a hard ceiling
        // silently rewrote whatever the user saved (200 came back as 50) with no way to tell.
        contextMessages: clampNumber(rawConfig.contextMessages, defaults.contextMessages, 1, Infinity),
        includeCharacterCard: rawConfig.includeCharacterCard === undefined ? defaults.includeCharacterCard : Boolean(rawConfig.includeCharacterCard),
        includePersona: rawConfig.includePersona === undefined ? defaults.includePersona : Boolean(rawConfig.includePersona),
        includeWorldInfo: rawConfig.includeWorldInfo === undefined ? defaults.includeWorldInfo : Boolean(rawConfig.includeWorldInfo),
        includeAuthorsNote: rawConfig.includeAuthorsNote === undefined ? defaults.includeAuthorsNote : Boolean(rawConfig.includeAuthorsNote),
        includeSystemPrompt: rawConfig.includeSystemPrompt === undefined ? defaults.includeSystemPrompt : Boolean(rawConfig.includeSystemPrompt),
        includeHistory: rawConfig.includeHistory === undefined ? defaults.includeHistory : Boolean(rawConfig.includeHistory),
        includeInChatHistory: Boolean(rawConfig.includeInChatHistory),
        chatHistoryDepth: clampNumber(rawConfig.chatHistoryDepth, defaults.chatHistoryDepth, 1, Infinity),
        includeAllChatHistory: rawConfig.includeAllChatHistory === undefined ? defaults.includeAllChatHistory : Boolean(rawConfig.includeAllChatHistory),
        keepInChatHistoryWhenHostHidden: Boolean(rawConfig.keepInChatHistoryWhenHostHidden),
        historyDepth: clampNumber(rawConfig.historyDepth, defaults.historyDepth, 1, 10),
        feedback: {
            ...rawFeedback,
            enabled: Boolean(rawFeedback.enabled),
            depth: clampNumber(rawFeedback.depth, defaults.feedback.depth, 1, 10),
        },
        batch: Boolean(rawConfig.batch),
        batchAgentIds: normalizeStringIdList(rawConfig.batchAgentIds),
        sendContextToCompanions: Boolean(rawConfig.sendContextToCompanions),
        contextRecipientAgentIds: normalizeStringIdList(rawConfig.contextRecipientAgentIds),
        dependencies: normalizeStringIdList(rawConfig.dependencies),
        waitForDependencies: Boolean(rawConfig.waitForDependencies),
        maxTokens: clampNumber(rawConfig.maxTokens, defaults.maxTokens, 16, MAX_AGENT_MAX_TOKENS),
    };
}

const TRACKER_CATEGORY_TEMPLATE_IDS = new Set([
    'tpl-achievements-tracker',
    'tpl-cyoa-choices',
    'tpl-direction-menu',
    'tpl-event-tracker',
    'tpl-item-tracker',
    'tpl-parallel-tracker',
    'tpl-relationship-tracker',
    'tpl-reputation-tracker',
    'tpl-scene-tracker',
    'tpl-secrets-tracker',
    'tpl-status-tracker',
    'tpl-time-tracker',
    'tpl-world-detail',
]);

const TRACKER_CATEGORY_NAMES = new Set([
    'achievements tracker',
    'cyoa choices',
    'direction menu',
    'event tracker',
    'item tracker',
    'parallel off-screen',
    'relationship tracker',
    'reputation tracker',
    'scene tracker',
    'secrets tracker',
    'status tracker',
    'time tracker',
    'world detail',
]);

export function normalizeAgentCategory(category = '', sourceTemplateId = '', name = '') {
    const normalizedTemplateId = typeof sourceTemplateId === 'string' ? sourceTemplateId.trim() : '';
    if (TRACKER_CATEGORY_TEMPLATE_IDS.has(normalizedTemplateId)) {
        return 'tracker';
    }

    const normalizedName = typeof name === 'string' ? name.trim().toLowerCase() : '';
    if (TRACKER_CATEGORY_NAMES.has(normalizedName)) {
        return 'tracker';
    }

    const normalizedCategory = typeof category === 'string' ? category.trim().toLowerCase() : '';
    if (['content', 'tracker', 'randomizer', 'custom', 'tool', 'companion'].includes(normalizedCategory)) {
        return normalizedCategory;
    }

    return 'custom';
}

/**
 * Category display order and labels.
 */
export const AGENT_CATEGORIES = {
    tracker: { label: 'Tracker', icon: 'fa-chart-line' },
    randomizer: { label: 'Randomizer', icon: 'fa-dice' },
    content: { label: 'Content', icon: 'fa-film' },
    tool: { label: 'Tool', icon: 'fa-screwdriver-wrench' },
    companion: { label: 'Companion', icon: 'fa-user-astronaut' },
    custom: { label: 'Custom', icon: 'fa-puzzle-piece' },
};

/**
 * Modal-only template subgroup labels.
 */
export const AGENT_SUBCATEGORIES = {
    world: { category: 'tracker', label: 'World & Scene', icon: 'fa-map' },
    characters: { category: 'tracker', label: 'Character State', icon: 'fa-users' },
    progress: { category: 'tracker', label: 'Player Progress', icon: 'fa-trophy' },
    'player-choices': { category: 'tracker', label: 'Player Choices', icon: 'fa-list-check' },
    'prose-quality': { category: 'content', label: 'Prose Quality', icon: 'fa-feather' },
    pov: { category: 'content', label: 'Point of View', icon: 'fa-user-pen' },
    behaviour: { category: 'content', label: 'Behaviour & Tone', icon: 'fa-masks-theater' },
};

function escapeRegexLiteral(value) {
    return String(value ?? '').replaceAll('/', '\\/');
}

/**
 * Converts a legacy single regex post-process block into an ST-style regex script.
 * @param {Partial<InChatAgent>} rawAgent
 * @returns {AgentRegexScript|null}
 */
export function getLegacyRegexScript(rawAgent = {}) {
    const postProcess = rawAgent.postProcess;

    if (!postProcess?.enabled || postProcess.type !== 'regex' || !postProcess.regexFind) {
        return null;
    }

    const flags = String(postProcess.regexFlags ?? 'g').trim() || 'g';
    return normalizeRegexScript({
        id: `legacy-${String(rawAgent.id ?? uuidv4())}`,
        scriptName: `${String(rawAgent.name ?? '').trim() || 'Agent'} legacy regex`,
        findRegex: `/${escapeRegexLiteral(postProcess.regexFind)}/${flags}`,
        replaceString: String(postProcess.regexReplace ?? ''),
        trimStrings: [],
        placement: [AGENT_REGEX_PLACEMENT.AI_OUTPUT],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: AGENT_REGEX_SUBSTITUTE.NONE,
        minDepth: null,
        maxDepth: null,
    });
}

/**
 * Returns the usable regex scripts for an agent, including legacy regex-only agents.
 * @param {Partial<InChatAgent>} rawAgent
 * @returns {AgentRegexScript[]}
 */
export function getAgentRegexScripts(rawAgent = {}) {
    const explicitScripts = Array.isArray(rawAgent.regexScripts)
        ? rawAgent.regexScripts.map(script => normalizeRegexScript(script ?? {}))
        : [];

    if (explicitScripts.length > 0) {
        return explicitScripts;
    }

    const legacyScript = getLegacyRegexScript(rawAgent);
    return legacyScript ? [legacyScript] : [];
}

export function isTrackerFixAgent(agent = {}) {
    if (agent?.category !== 'tracker') {
        return false;
    }

    if (agent.phase === 'post' || agent.phase === 'both') {
        return true;
    }

    return agent.phase === 'pre' && (
        (agent.postProcess?.enabled && agent.postProcess.type === 'extract') ||
        getAgentRegexScripts(agent).length > 0
    );
}

function cacheAgentRegexScriptsForAgent(agent) {
    cacheAgentRegexScripts(agent?.id, getAgentRegexScripts(agent));
}

function refreshAgentRegexScriptCache() {
    clearCachedAgentRegexScripts();
    for (const agent of agents) {
        cacheAgentRegexScriptsForAgent(agent);
    }
}

/**
 * Creates a new agent with default values.
 * @returns {InChatAgent}
 */
export function createDefaultAgent() {
    return {
        id: uuidv4(),
        name: '',
        description: '',
        icon: '',
        category: 'custom',
        execution: 'inline',
        tags: [],
        version: 1,
        author: '',
        prompt: '',
        phase: 'pre',
        connectionProfile: '',
        modelOverride: '',
        sourceTemplateId: '',
        injection: {
            position: 1,
            depth: 1,
            role: 0,
            order: 100,
            scan: false,
        },
        companion: createDefaultCompanionConfig(),
        preProcess: {
            mode: 'inject',
            interceptTiming: 'pre-generation',
            applyMode: 'replace',
            wrapPosition: 'after',
            wrapPrefix: '',
            wrapSuffix: '',
            patchStartTag: '<context_patch>',
            patchEndTag: '</context_patch>',
            maxTokens: DEFAULT_AGENT_MAX_TOKENS,
        },
        postProcess: {
            enabled: false,
            type: 'regex',
            regexFind: '',
            regexReplace: '',
            regexFlags: 'g',
            appendText: '',
            extractPattern: '',
            extractVariable: '',
            promptTransformEnabled: false,
            promptTransformShowNotifications: true,
            promptTransformMode: 'rewrite',
            promptTransformMaxTokens: DEFAULT_AGENT_MAX_TOKENS,
        },
        regexScripts: [],
        enabled: false,
        favorite: false,
        phaseLocked: false,
        conditions: {
            triggerKeywords: [],
            triggerProbability: 100,
            generationTypes: ['normal', 'continue', 'impersonate'],
            runOnImpersonate: false,
            runOnCompanionOutputs: false,
            companionOutputTargetAgentIds: [],
        },
        tools: [],
        settings: {},
    };
}

/**
 * Normalizes a single tool definition loaded from disk or import.
 * @param {Partial<AgentToolDef>} raw
 * @returns {AgentToolDef}
 */
export function normalizeToolDef(raw = {}) {
    return {
        ...raw,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '',
        displayName: typeof raw.displayName === 'string' ? raw.displayName : (raw.name ?? ''),
        description: typeof raw.description === 'string' ? raw.description : '',
        parameters: raw.parameters && typeof raw.parameters === 'object' ? raw.parameters : { type: 'object', properties: {} },
        actionKey: typeof raw.actionKey === 'string' ? raw.actionKey.trim() : '',
        formatMessageKey: typeof raw.formatMessageKey === 'string' ? raw.formatMessageKey.trim() : '',
        shouldRegister: typeof raw.shouldRegister === 'boolean' ? raw.shouldRegister : true,
        stealth: typeof raw.stealth === 'boolean' ? raw.stealth : false,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    };
}

/**
 * Normalizes an agent loaded from disk or import.
 * @param {Partial<InChatAgent>} rawAgent
 * @returns {InChatAgent}
 */
export function normalizeAgent(rawAgent = {}) {
    const defaults = createDefaultAgent();
    const rawAgentWithoutModalMetadata = { ...rawAgent };
    delete rawAgentWithoutModalMetadata.subcategory;

    const rawPreProcess = rawAgent.preProcess && typeof rawAgent.preProcess === 'object' ? rawAgent.preProcess : {};
    const rawPostProcess = rawAgent.postProcess && typeof rawAgent.postProcess === 'object' ? rawAgent.postProcess : {};
    const conditions = rawAgent.conditions && typeof rawAgent.conditions === 'object' ? rawAgent.conditions : {};
    const normalizedCategory = normalizeAgentCategory(rawAgent.category, rawAgent.sourceTemplateId, rawAgent.name);
    const execution = rawAgent.execution === 'companion' || normalizedCategory === 'companion'
        ? 'companion'
        : defaults.execution;

    return {
        ...defaults,
        ...rawAgentWithoutModalMetadata,
        id: typeof rawAgent.id === 'string' && rawAgent.id.trim() ? rawAgent.id.trim() : defaults.id,
        name: typeof rawAgent.name === 'string' ? rawAgent.name : defaults.name,
        description: typeof rawAgent.description === 'string' ? rawAgent.description : defaults.description,
        icon: typeof rawAgent.icon === 'string' ? rawAgent.icon : defaults.icon,
        category: normalizedCategory,
        execution,
        tags: Array.isArray(rawAgent.tags)
            ? rawAgent.tags.map(tag => String(tag ?? '').trim()).filter(Boolean)
            : defaults.tags,
        version: Number.isFinite(Number(rawAgent.version)) ? Number(rawAgent.version) : defaults.version,
        author: typeof rawAgent.author === 'string' ? rawAgent.author : defaults.author,
        prompt: typeof rawAgent.prompt === 'string' ? rawAgent.prompt : defaults.prompt,
        phase: ['pre', 'post', 'both'].includes(rawAgent.phase) ? rawAgent.phase : defaults.phase,
        connectionProfile: typeof rawAgent.connectionProfile === 'string' ? rawAgent.connectionProfile : defaults.connectionProfile,
        modelOverride: typeof rawAgent.modelOverride === 'string' ? rawAgent.modelOverride : defaults.modelOverride,
        sourceTemplateId: typeof rawAgent.sourceTemplateId === 'string' ? rawAgent.sourceTemplateId : defaults.sourceTemplateId,
        injection: {
            ...defaults.injection,
            ...(rawAgent.injection ?? {}),
        },
        companion: normalizeCompanionConfig(rawAgent.companion),
        preProcess: {
            ...defaults.preProcess,
            ...rawPreProcess,
            mode: ['inject', 'intercept'].includes(String(rawPreProcess.mode))
                ? String(rawPreProcess.mode)
                : defaults.preProcess.mode,
            interceptTiming: ['pre-generation', 'post-main-generation'].includes(String(rawPreProcess.interceptTiming))
                ? String(rawPreProcess.interceptTiming)
                : defaults.preProcess.interceptTiming,
            applyMode: ['replace', 'wrap', 'patch'].includes(String(rawPreProcess.applyMode))
                ? String(rawPreProcess.applyMode)
                : defaults.preProcess.applyMode,
            wrapPosition: ['before', 'after'].includes(String(rawPreProcess.wrapPosition))
                ? String(rawPreProcess.wrapPosition)
                : defaults.preProcess.wrapPosition,
            wrapPrefix: typeof rawPreProcess.wrapPrefix === 'string' ? rawPreProcess.wrapPrefix : defaults.preProcess.wrapPrefix,
            wrapSuffix: typeof rawPreProcess.wrapSuffix === 'string' ? rawPreProcess.wrapSuffix : defaults.preProcess.wrapSuffix,
            patchStartTag: typeof rawPreProcess.patchStartTag === 'string' && rawPreProcess.patchStartTag.trim()
                ? rawPreProcess.patchStartTag
                : defaults.preProcess.patchStartTag,
            patchEndTag: typeof rawPreProcess.patchEndTag === 'string' && rawPreProcess.patchEndTag.trim()
                ? rawPreProcess.patchEndTag
                : defaults.preProcess.patchEndTag,
            maxTokens: normalizePreProcessMaxTokens(rawPreProcess.maxTokens),
        },
        postProcess: {
            ...defaults.postProcess,
            ...rawPostProcess,
            enabled: Boolean(rawPostProcess.enabled),
            type: ['regex', 'append', 'extract'].includes(String(rawPostProcess.type))
                ? String(rawPostProcess.type)
                : defaults.postProcess.type,
            regexFind: typeof rawPostProcess.regexFind === 'string' ? rawPostProcess.regexFind : defaults.postProcess.regexFind,
            regexReplace: typeof rawPostProcess.regexReplace === 'string' ? rawPostProcess.regexReplace : defaults.postProcess.regexReplace,
            regexFlags: typeof rawPostProcess.regexFlags === 'string' ? rawPostProcess.regexFlags : defaults.postProcess.regexFlags,
            appendText: typeof rawPostProcess.appendText === 'string' ? rawPostProcess.appendText : defaults.postProcess.appendText,
            extractPattern: typeof rawPostProcess.extractPattern === 'string' ? rawPostProcess.extractPattern : defaults.postProcess.extractPattern,
            extractVariable: typeof rawPostProcess.extractVariable === 'string' ? rawPostProcess.extractVariable : defaults.postProcess.extractVariable,
            promptTransformEnabled: Boolean(rawPostProcess.promptTransformEnabled),
            promptTransformShowNotifications: Object.hasOwn(rawPostProcess, 'promptTransformShowNotifications')
                ? Boolean(rawPostProcess.promptTransformShowNotifications)
                : defaults.postProcess.promptTransformShowNotifications,
            promptTransformMode: ['rewrite', 'append'].includes(String(rawPostProcess.promptTransformMode))
                ? String(rawPostProcess.promptTransformMode)
                : defaults.postProcess.promptTransformMode,
            promptTransformMaxTokens: Number.isFinite(Number(rawPostProcess.promptTransformMaxTokens))
                ? Math.max(16, Math.min(MAX_AGENT_MAX_TOKENS, Number(rawPostProcess.promptTransformMaxTokens)))
                : defaults.postProcess.promptTransformMaxTokens,
        },
        regexScripts: Array.isArray(rawAgent.regexScripts)
            ? rawAgent.regexScripts.map(script => normalizeRegexScript(script ?? {}))
            : defaults.regexScripts,
        enabled: Boolean(rawAgent.enabled),
        favorite: Boolean(rawAgent.favorite),
        phaseLocked: Boolean(rawAgent.phaseLocked),
        conditions: {
            ...defaults.conditions,
            ...conditions,
            triggerKeywords: Array.isArray(conditions.triggerKeywords)
                ? conditions.triggerKeywords.map(keyword => String(keyword ?? '').trim()).filter(Boolean)
                : defaults.conditions.triggerKeywords,
            triggerProbability: Number.isFinite(Number(conditions.triggerProbability))
                ? Math.max(0, Math.min(100, Number(conditions.triggerProbability)))
                : defaults.conditions.triggerProbability,
            generationTypes: Array.isArray(conditions.generationTypes)
                ? conditions.generationTypes.map(type => String(type ?? '').trim()).filter(Boolean)
                : defaults.conditions.generationTypes,
            runOnImpersonate: Object.hasOwn(conditions, 'runOnImpersonate')
                ? Boolean(conditions.runOnImpersonate)
                : defaults.conditions.runOnImpersonate,
            runOnCompanionOutputs: Object.hasOwn(conditions, 'runOnCompanionOutputs')
                ? Boolean(conditions.runOnCompanionOutputs)
                : defaults.conditions.runOnCompanionOutputs,
            companionOutputTargetAgentIds: Array.isArray(conditions.companionOutputTargetAgentIds)
                ? conditions.companionOutputTargetAgentIds.map(id => String(id ?? '').trim()).filter(Boolean)
                : defaults.conditions.companionOutputTargetAgentIds,
        },
        tools: Array.isArray(rawAgent.tools)
            ? rawAgent.tools.map(tool => normalizeToolDef(tool))
            : defaults.tools,
        settings: rawAgent.settings && typeof rawAgent.settings === 'object' && !Array.isArray(rawAgent.settings)
            ? { ...rawAgent.settings }
            : { ...defaults.settings },
    };
}

/**
 * Returns a shallow copy of the agents array.
 * @returns {InChatAgent[]}
 */
export function getAgents() {
    return [...agents];
}

export function setRuntimeAgentFilter(owner, predicateOrNull) {
    if (typeof owner !== 'string' || !owner.trim()) {
        throw new TypeError('Runtime agent filter owner must be a non-empty string.');
    }
    if (predicateOrNull !== null && typeof predicateOrNull !== 'function') {
        throw new TypeError('Runtime agent filter must be a function or null.');
    }

    if (predicateOrNull === null) {
        runtimeAgentFilters.delete(owner);
    } else {
        runtimeAgentFilters.set(owner, predicateOrNull);
    }
}

export function isAgentRuntimeAllowed(agent) {
    if (runtimeAgentFilters.size === 0) {
        return true;
    }

    // Saves replace agent objects; queued runs must evaluate the current record.
    const currentAgent = getAgentById(agent?.id);
    if (!currentAgent) {
        return false;
    }
    for (const predicate of runtimeAgentFilters.values()) {
        try {
            if (predicate(currentAgent) !== true) {
                return false;
            }
        } catch {
            // Fail closed without flooding the console from automatic retries.
            return false;
        }
    }
    return true;
}

/**
 * Returns enabled agents, sorted by injection order.
 * @returns {InChatAgent[]}
 */
export function getEnabledAgents() {
    if (globalSettings.enabled === false) {
        return [];
    }

    const activeScope = getActiveAgentChatScope();

    return agents
        .filter(agent => isAgentEnabledForScope(agent, activeScope) && isAgentRuntimeAllowed(agent))
        .sort((a, b) => a.injection.order - b.injection.order);
}

/**
 * Finds an agent by ID.
 * @param {string} id
 * @returns {InChatAgent|undefined}
 */
export function getAgentById(id) {
    return agents.find(agent => agent.id === id);
}

/**
 * Returns all tool-category agents.
 * @returns {InChatAgent[]}
 */
export function getToolAgents() {
    return agents.filter(agent => agent.category === 'tool');
}

/**
 * Returns enabled tool agents.
 * @returns {InChatAgent[]}
 */
export function getEnabledToolAgents() {
    if (globalSettings.enabled === false) {
        return [];
    }

    const activeScope = getActiveAgentChatScope();
    return agents.filter(agent => isAgentEnabledForScope(agent, activeScope) && agent.category === 'tool' && isAgentRuntimeAllowed(agent));
}

/**
 * Checks if an agent is a tool-category agent.
 * @param {InChatAgent} agent
 * @returns {boolean}
 */
export function isToolAgent(agent) {
    return agent?.category === 'tool';
}

/**
 * Checks if an agent should run through Companion execution.
 * @param {InChatAgent} agent
 * @returns {boolean}
 */
export function isCompanionAgent(agent) {
    return agent?.execution === 'companion' || agent?.category === 'companion';
}

/**
 * Returns a normalized Companion config for an agent.
 * @param {Partial<InChatAgent>} agent
 * @returns {AgentCompanionConfig}
 */
export function getCompanionConfig(agent = {}) {
    return normalizeCompanionConfig(agent?.companion);
}

function buildCompanionContextAccessDefaults() {
    return {
        includeCharacterCard: true,
        includePersona: true,
        includeWorldInfo: true,
        includeAuthorsNote: true,
        includeSystemPrompt: true,
        // Companions evolve their own previous states instead of re-deriving them each turn.
        includeHistory: true,
    };
}

/**
 * Moves a card-mode companion into the slide-out panel. Used by the one-time migration;
 * the editor can still opt back into in-chat cards afterwards.
 * @param {InChatAgent} agent
 * @returns {boolean} Whether the agent changed.
 */
export function applyCompanionPanelDisplayDefault(agent) {
    if (!agent || !isCompanionAgent(agent) || agent.phaseLocked) {
        return false;
    }

    const companion = normalizeCompanionConfig(agent.companion);
    agent.companion = companion;
    if (companion.displayMode !== 'card') {
        return false;
    }

    companion.displayMode = 'panel';
    return true;
}

/**
 * Raw (pre-normalisation) companion object, so a migration can tell "the user never chose"
 * (key absent) from "the user chose false" (key present) before normalisation fills defaults.
 * @param {InChatAgent} agent
 * @returns {Record<string, unknown>}
 */
function getRawCompanionConfig(agent) {
    const raw = agent?.companion;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/**
 * Grants a companion the default context access (persona, character card, world info,
 * author's note, system prompt). Used by the one-time migration for existing companions.
 * Only fills choices the user never made: a stored false stays false, and locked agents
 * are left alone.
 * @param {InChatAgent} agent
 * @returns {boolean} Whether the agent changed.
 */
export function applyCompanionContextAccessDefaults(agent) {
    if (!agent || !isCompanionAgent(agent) || agent.phaseLocked) {
        return false;
    }

    const raw = getRawCompanionConfig(agent);
    const companion = normalizeCompanionConfig(raw);
    const next = { ...companion };
    for (const [key, value] of Object.entries(buildCompanionContextAccessDefaults())) {
        if (raw[key] === undefined) {
            next[key] = value;
        }
    }

    if (JSON.stringify(next) === JSON.stringify(companion)) {
        agent.companion = companion;
        return false;
    }

    agent.companion = next;
    return true;
}

/**
 * Applies the tracker auto-loop defaults to a companion-execution tracker: run automatically
 * after each reply with the agent prompt sent as-is, feed the latest state back into the next
 * main generation, and show state in the slide-out tracker panel instead of chat cards.
 * Without `force` (the startup migration) only choices the user never made are filled and
 * locked agents are skipped; with `force` (a deliberate conversion) the loop is applied fully.
 * The editor can override any of it.
 * @param {InChatAgent} agent
 * @param {{ force?: boolean }} [options]
 * @returns {boolean} Whether the agent changed.
 */
export function applyTrackerCompanionAutoLoopDefaults(agent, { force = false } = {}) {
    if (!agent || !isCompanionAgent(agent) || agent.category !== 'tracker') {
        return false;
    }
    if (agent.phaseLocked && !force) {
        return false;
    }

    const raw = getRawCompanionConfig(agent);
    const rawFeedback = raw.feedback && typeof raw.feedback === 'object' && !Array.isArray(raw.feedback) ? raw.feedback : {};
    const companion = normalizeCompanionConfig(raw);
    const loopDefaults = {
        ...buildCompanionContextAccessDefaults(),
        trigger: 'auto',
        displayMode: 'panel',
        rawPrompt: true,
    };
    const next = { ...companion, feedback: { ...companion.feedback } };
    for (const [key, value] of Object.entries(loopDefaults)) {
        if (force || raw[key] === undefined) {
            next[key] = value;
        }
    }
    if (force || rawFeedback.enabled === undefined) {
        next.feedback.enabled = true;
    }

    if (JSON.stringify(next) === JSON.stringify(companion)) {
        agent.companion = companion;
        return false;
    }

    agent.companion = next;
    return true;
}

/**
 * Switches an agent between inline and companion execution in place.
 * Keeps prompt, regex scripts, injection, and conditions so the agent can round-trip.
 * @param {InChatAgent} agent
 * @param {'companion'|'inline'} targetExecution
 * @returns {boolean} Whether the agent changed.
 */
export function convertAgentExecution(agent, targetExecution) {
    const wantsCompanion = targetExecution === 'companion';
    if (!agent || isToolAgent(agent) || isCompanionAgent(agent) === wantsCompanion) {
        return false;
    }

    if (wantsCompanion) {
        agent.execution = 'companion';
        agent.companion = normalizeCompanionConfig(agent.companion);
        // Remember the inline phase so converting back restores it instead of leaving 'post'.
        agent.companion.inlinePhase = ['pre', 'post', 'both'].includes(agent.phase) ? agent.phase : '';
        // A deliberate conversion by the user gets the full tracker loop, unlike the startup migration.
        applyTrackerCompanionAutoLoopDefaults(agent, { force: true });
        agent.phase = 'post';
        return true;
    }

    agent.execution = 'inline';
    if (agent.companion?.inlinePhase) {
        agent.phase = agent.companion.inlinePhase;
    }
    // normalizeAgent re-derives execution from the category, so a companion-category
    // agent has to move to custom or it would normalize back to a companion on save.
    if (agent.category === 'companion') {
        agent.category = 'custom';
    }
    return true;
}

/**
 * Loads agents from the server settings response.
 * @param {object[]} data - Array of agent objects from settings
 */
export function loadAgents(data) {
    if (Array.isArray(data)) {
        agents = data.map(normalizeAgent);
        refreshAgentRegexScriptCache();
        agentsLoaded = true;
    }
}

let agentsLoaded = false;

export function areAgentsLoaded() {
    return agentsLoaded;
}

let agentSaveChain = Promise.resolve();
let agentSetupApplying = false;

async function writeAgentSnapshot(agent) {
    const response = await fetch('/api/in-chat-agents/save', {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(agent),
    });
    if (!response.ok) throw new Error(`Failed to save agent ${agent.name || agent.id}.`);
}

async function deleteAgentFile(id) {
    const response = await fetch('/api/in-chat-agents/delete', {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id }),
    });
    if (!response.ok) throw new Error('Failed to delete agent');
}

/** The server stores the exact JSON it received, so a re-read equal to our write means nobody else touched it. */
function isSameStoredAgentRecord(current, written) {
    try {
        return JSON.stringify(normalizeAgent(structuredClone(current))) === JSON.stringify(normalizeAgent(structuredClone(written)));
    } catch {
        return false;
    }
}

/** All setup writes share the agent queue; a restore point exists before the first write. */
export function applyAgentSetupPreset(rawPreset, { isCurrent = () => true, canPersist = () => true, confirmExtras = async () => true } = {}) {
    const preset = normalizeAgentSetupPreset(rawPreset);
    if (!preset) return Promise.reject(new Error('Invalid agent setup.'));
    const operation = agentSaveChain.then(async () => {
        const assertCurrent = () => {
            if (!canPersist() || !isCurrent()) throw new Error('The active workspace changed. Load the setup again when it is ready.');
        };
        assertCurrent();
        if (!areAgentsLoaded()) throw new Error('Wait for the agent library to finish loading.');
        agentSetupApplying = true;
        let recovery;
        let previousAgents;
        let previousGlobals;
        let appliedGlobals;
        const written = [];
        const nextAgentsById = new Map();
        try {
            if (await saveSettings(0, { returnResult: true }) !== true) throw new Error('Save the current settings before loading a setup.');
            assertCurrent();
            const response = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
            if (!response.ok) throw new Error('The current agent library could not be read.');
            const data = await response.json();
            assertCurrent();
            if (!Array.isArray(data.inChatAgents)) throw new Error('The server returned an invalid agent library.');
            previousAgents = structuredClone(data.inChatAgents);
            previousGlobals = structuredClone(globalSettings);
            const previousById = new Map(previousAgents.map(agent => [agent.id, agent]));
            const included = new Set(preset.agents.map(agent => agent.id));
            const extras = previousAgents.filter(agent => !included.has(agent.id));
            if (!await confirmExtras(extras.filter(isAgentEnabledForAnyScope))) return false;
            assertCurrent();
            const nextAgents = [
                ...preset.agents.map(agent => normalizeAgent(mergeAgentSetupRecord(previousById.get(agent.id) ?? {}, agent))),
                ...extras.map(agent => ({ ...structuredClone(agent), enabled: false })),
            ];
            recovery = await saveAgentSetupPreset(`Recovery before ${preset.name}`.slice(0, 120), {
                snapshot: { agents: previousAgents, globalSettings: previousGlobals, recoveryFor: preset.id },
                canPersist,
            });
            assertCurrent();
            for (const agent of nextAgents) {
                assertCurrent();
                // Include attempted writes: a lost response may follow a committed server write.
                written.push(agent.id);
                nextAgentsById.set(agent.id, agent);
                await writeAgentSnapshot(agent);
            }
            assertCurrent();
            if (JSON.stringify(globalSettings) !== JSON.stringify(previousGlobals)) throw new Error('Agent settings changed during the load; the setup was not applied.');
            setGlobalSettings(buildAppliedGlobalSettings(preset));
            appliedGlobals = structuredClone(globalSettings);
            persistAgentGlobalSettings();
            if (await saveSettings(0, { returnResult: true }) !== true) throw new Error('The setup settings could not be saved.');
            assertCurrent();
            loadAgents(nextAgents);
        } catch (error) {
            const rollbackErrors = [];
            if (recovery && canPersist()) {
                const previousById = new Map(previousAgents.map(agent => [agent.id, agent]));
                const writtenById = new Map(nextAgentsById);
                // Re-read the server library so rollback only touches records that still hold this operation's write.
                let currentById = null;
                try {
                    const currentResponse = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
                    const currentData = currentResponse.ok ? await currentResponse.json() : null;
                    if (Array.isArray(currentData?.inChatAgents)) {
                        currentById = new Map(currentData.inChatAgents.map(agent => [agent.id, agent]));
                    }
                } catch { /* Fall through: an unreadable library blocks the blind restore below. */ }
                if (!currentById) rollbackErrors.push(new Error('The current agent library could not be read, so nothing was restored.'));
                for (const id of written.reverse()) {
                    if (!currentById) break;
                    if (!canPersist()) {
                        rollbackErrors.push(new Error('The active account changed during recovery.'));
                        break;
                    }
                    const current = currentById.get(id);
                    const ours = writtenById.get(id);
                    if (current && ours && !isSameStoredAgentRecord(current, ours)) {
                        rollbackErrors.push(new Error(`Agent ${current.name || id} was edited elsewhere and was preserved.`));
                        continue;
                    }
                    try {
                        const previous = previousById.get(id);
                        if (previous) await writeAgentSnapshot(previous);
                        else await deleteAgentFile(id);
                    } catch (rollbackError) {
                        rollbackErrors.push(rollbackError);
                    }
                }
                if (appliedGlobals && canPersist()) {
                    if (JSON.stringify(globalSettings) !== JSON.stringify(appliedGlobals)) {
                        rollbackErrors.push(new Error('Concurrent global settings were preserved.'));
                    } else {
                        globalSettings = structuredClone(previousGlobals);
                        persistAgentGlobalSettings();
                        try {
                            if (await saveSettings(0, { returnResult: true }) !== true) throw new Error('Settings recovery failed.');
                        } catch (rollbackError) {
                            rollbackErrors.push(rollbackError);
                        }
                    }
                }
                if (!rollbackErrors.length && canPersist()) loadAgents(previousAgents);
            } else if (recovery) {
                rollbackErrors.push(new Error('Return to the original account to recover its setup.'));
            }
            if (recovery && !rollbackErrors.length) {
                try { await deleteAgentSetupPreset(recovery.id, { canPersist }); } catch { /* The restore point is still usable. */ }
            }
            if (recovery && rollbackErrors.length) {
                error.recoveryPreset = recovery;
                error.message += ` Recovery needs attention. The saved setup “${recovery.name}” retains the previous configuration.`;
            }
            throw error;
        } finally {
            agentSetupApplying = false;
        }
        // Cleanup cannot turn a committed setup into a reported failure.
        try { await deleteAgentSetupPreset(recovery.id, { canPersist }); } catch { /* Keep the extra restore point. */ }
        return true;
    });
    agentSaveChain = operation.catch(() => {});
    return operation;
}

/**
 * Saves an agent to the server. Updates local array.
 * @param {InChatAgent|string} agent Agent snapshot, or ID when updating the latest saved state
 * @param {{update?: function}} options A synchronous updater; null skips an obsolete save
 */
export async function saveAgent(agent, { update = null, isCurrent = () => true } = {}) {
    const id = typeof agent === 'string' ? agent : agent.id;
    const snapshot = update ? null : normalizeAgent(structuredClone(agent));
    // Panel and background updates must merge only after earlier saves have committed.
    const save = agentSaveChain.then(async () => {
        if (!isCurrent()) throw new DOMException('The agent edit is no longer current.', 'AbortError');
        const next = update ? update(structuredClone(getAgentById(id))) : snapshot;
        if (!next) return null;
        const normalizedAgent = update ? normalizeAgent(next) : next;
        await writeAgentSnapshot(normalizedAgent);
        if (!isCurrent()) return normalizedAgent;

        // Publish the saved snapshot only after the server accepts it.
        const index = agents.findIndex(existingAgent => existingAgent.id === normalizedAgent.id);
        if (index >= 0) {
            agents[index] = normalizedAgent;
        } else {
            agents.push(normalizedAgent);
        }
        cacheAgentRegexScriptsForAgent(normalizedAgent);
        return normalizedAgent;
    });
    agentSaveChain = save.catch(() => {});
    return save;
}

/**
 * Applies a new visual order to a subset of agents. Subset members are dealt back into the
 * order-sorted slots the subset already occupies (agents outside the subset keep their relative
 * position), then every slot is renumbered to `index * 10` so drag-and-drop always produces
 * clean, collision-free order values.
 * @param {string[]} orderedSubsetIds Agent ids in their new visual order.
 * @returns {Promise<boolean>} Whether any agent's order value changed.
 */
export async function reorderAgentsIntoOrderSlots(orderedSubsetIds) {
    const subsetIds = Array.from(new Set(
        (Array.isArray(orderedSubsetIds) ? orderedSubsetIds : [])
            .map(id => String(id ?? '').trim())
            .filter(id => id && getAgentById(id)),
    ));

    if (subsetIds.length === 0) {
        return false;
    }

    const subsetIdSet = new Set(subsetIds);
    let subsetIndex = 0;
    const finalOrderIds = getAgents()
        .sort((a, b) => Number(a?.injection?.order ?? 0) - Number(b?.injection?.order ?? 0))
        .map(agent => {
            if (!subsetIdSet.has(agent.id)) {
                return agent.id;
            }

            const nextId = subsetIds[subsetIndex];
            subsetIndex += 1;
            return nextId;
        });

    let changed = false;
    for (let i = 0; i < finalOrderIds.length; i++) {
        const agent = getAgentById(finalOrderIds[i]);
        if (!agent) {
            continue;
        }

        const desiredOrder = i * 10;
        if (Number(agent?.injection?.order ?? 0) === desiredOrder) {
            continue;
        }

        // Stage the new order on a copy; the live record only changes once the server accepts it.
        await saveAgent(agent.id, {
            update: draft => {
                if (!draft) return null;
                draft.injection = { ...(draft.injection ?? {}), order: desiredOrder };
                return draft;
            },
        });
        changed = true;
    }

    return changed;
}

/**
 * Deletes an agent from the server and local array.
 * @param {string} id
 */
export async function deleteAgent(id) {
    const deletion = agentSaveChain.then(async () => {
        await deleteAgentFile(id);
        agents = agents.filter(agent => agent.id !== id);
        deleteCachedAgentRegexScripts(id);
        const scopedStateChanged = removeAgentIdFromScopedEnabledAgentIds(id);

        if (scopedStateChanged) {
            persistAgentGlobalSettings();
        }
    });
    agentSaveChain = deletion.catch(() => {});
    return deletion;
}

/**
 * Imports agents from a JSON object (single or pack).
 * @param {object} data - Agent or agent pack
 * @returns {InChatAgent[]} - Imported agents
 */
export async function importAgents(data) {
    let agentsToImport = [];

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Unrecognized agent format');
    }

    if (data.format === 'sillybunny-inchat-agents' && Array.isArray(data.agents)) {
        if (data.version !== undefined && Number(data.version) !== 1) {
            throw new Error(`Unsupported agent pack version: ${String(data.version)}`);
        }
        agentsToImport = data.agents;
    } else if (data.id && data.prompt !== undefined) {
        agentsToImport = [data];
    } else {
        throw new Error('Unrecognized agent format');
    }

    // Validate and normalise the whole pack before the first write so a broken later entry
    // cannot leave an undisclosed partial import behind.
    const idMap = new Map();
    const prepared = agentsToImport.map((rawAgent, index) => {
        if (!rawAgent || typeof rawAgent !== 'object' || Array.isArray(rawAgent)) {
            throw new Error(`Agent ${index + 1} in the pack is not an object`);
        }
        const newId = uuidv4();
        const oldId = String(rawAgent.id ?? '').trim();
        if (oldId) idMap.set(oldId, newId);
        // Imported agents start paused so they can be reviewed before they run.
        return normalizeAgent({ ...createDefaultAgent(), ...rawAgent, id: newId, enabled: false });
    });

    const remap = ids => (Array.isArray(ids) ? ids.map(id => idMap.get(id) ?? id) : ids);
    for (const agent of prepared) {
        if (agent.companion) {
            agent.companion.batchAgentIds = remap(agent.companion.batchAgentIds);
            agent.companion.contextRecipientAgentIds = remap(agent.companion.contextRecipientAgentIds);
            agent.companion.dependencies = remap(agent.companion.dependencies);
        }
        if (agent.conditions) {
            agent.conditions.companionOutputTargetAgentIds = remap(agent.conditions.companionOutputTargetAgentIds);
        }
    }

    const imported = [];
    for (const agent of prepared) {
        await saveAgent(agent);
        imported.push(agent);
    }

    return imported;
}

/**
 * Exports all agents as an agent pack.
 * @returns {object}
 */
export function exportAllAgents() {
    return {
        format: 'sillybunny-inchat-agents',
        version: 1,
        agents,
    };
}

/**
 * Exports a single agent.
 * @param {string} id
 * @returns {InChatAgent|null}
 */
export function exportAgent(id) {
    return agents.find(agent => agent.id === id) || null;
}

// ===================== Agent Groups =====================

/**
 * @typedef {object} AgentGroup
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string[]} agentTemplateIds - Template IDs (tpl-*) included in this group
 * @property {Partial<InChatAgent>[]} customAgents - Custom agent snapshots included in this group
 * @property {boolean} builtin - Whether this is a pre-made group
 */

/**
 * Creates a default empty group.
 * @returns {AgentGroup}
 */
export function createDefaultGroup() {
    return {
        id: uuidv4(),
        name: '',
        description: '',
        agentTemplateIds: [],
        customAgents: [],
        builtin: false,
    };
}

/**
 * Normalizes an agent snapshot used inside custom groups.
 * @param {Partial<InChatAgent>} rawAgent
 * @returns {Partial<InChatAgent>}
 */
function normalizeGroupAgentSnapshot(rawAgent = {}) {
    const normalizedAgent = normalizeAgent(rawAgent);
    delete normalizedAgent.id;
    normalizedAgent.enabled = false;
    return normalizedAgent;
}

/**
 * Normalizes a group payload.
 * @param {Partial<AgentGroup>} rawGroup
 * @param {object} [options]
 * @param {boolean} [options.builtin]
 * @returns {AgentGroup}
 */
function normalizeGroup(rawGroup = {}, { builtin = false } = {}) {
    const defaults = createDefaultGroup();

    return {
        ...defaults,
        ...rawGroup,
        id: typeof rawGroup.id === 'string' && rawGroup.id.trim() ? rawGroup.id.trim() : defaults.id,
        name: String(rawGroup.name ?? '').trim(),
        description: String(rawGroup.description ?? '').trim(),
        agentTemplateIds: Array.isArray(rawGroup.agentTemplateIds)
            ? rawGroup.agentTemplateIds.map(id => String(id ?? '').trim()).filter(Boolean)
            : [],
        customAgents: Array.isArray(rawGroup.customAgents)
            ? rawGroup.customAgents.map(agent => normalizeGroupAgentSnapshot(agent ?? {}))
            : [],
        builtin: builtin || Boolean(rawGroup.builtin),
    };
}

/**
 * Returns all groups (builtin + custom).
 * @returns {AgentGroup[]}
 */
export function getGroups() {
    return [...builtinGroups, ...customGroups];
}

/**
 * Returns custom groups only.
 * @returns {AgentGroup[]}
 */
export function getCustomGroups() {
    return [...customGroups];
}

/**
 * Loads builtin groups from extension templates.
 * @param {AgentGroup[]} data
 */
export function loadBuiltinGroups(data) {
    builtinGroups = Array.isArray(data)
        ? data.map(group => normalizeGroup(group, { builtin: true }))
        : [];
}

/**
 * Loads custom groups from backend storage.
 * @param {AgentGroup[]} data
 */
export function loadCustomGroups(data) {
    customGroups = Array.isArray(data)
        ? data.map(group => normalizeGroup(group, { builtin: false }))
        : [];
}

/**
 * Saves a custom group to the backend and local state.
 * @param {AgentGroup} group
 * @returns {Promise<AgentGroup>}
 */
export async function saveGroup(group) {
    const normalizedGroup = normalizeGroup(group, { builtin: false });
    // Kit writes share the agent save queue and publish only after the server accepts them,
    // so a failed or out-of-order save cannot leave a kit that looks saved but is not.
    const save = agentSaveChain.then(async () => {
        const response = await fetch('/api/in-chat-agents/groups/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(normalizedGroup),
        });

        if (!response.ok) {
            throw new Error('Failed to save group');
        }

        const index = customGroups.findIndex(existingGroup => existingGroup.id === normalizedGroup.id);
        if (index >= 0) {
            customGroups[index] = normalizedGroup;
        } else {
            customGroups.push(normalizedGroup);
        }

        return normalizedGroup;
    });
    agentSaveChain = save.catch(() => {});
    return save;
}

/**
 * Deletes a custom group by ID.
 * @param {string} id
 */
export async function deleteGroup(id) {
    const deletion = agentSaveChain.then(async () => {
        const response = await fetch('/api/in-chat-agents/groups/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ id }),
        });

        if (!response.ok) {
            throw new Error('Failed to delete group');
        }

        customGroups = customGroups.filter(group => group.id !== id);
    });
    agentSaveChain = deletion.catch(() => {});
    return deletion;
}
