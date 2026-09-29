import {
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
    getCurrentChatId,
    getRequestHeaders,
    is_send_press,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../script.js';
import {
    ModuleWorkerWrapper,
    extension_settings,
    openThirdPartyExtensionMenu,
} from '../../extensions.js';
import { registerDebugFunction } from '../../power-user.js';
import { SECRET_KEYS, secret_state } from '../../secrets.js';
import { getDataBankAttachments, getDataBankAttachmentsForSource } from '../../chats.js';
import { debounce, getStringHash as calculateHash, onlyUnique, isTrueBoolean } from '../../utils.js';
import { debounce_timeout } from '../../constants.js';
import { getSortedEntries } from '../../world-info.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from '../../slash-commands/SlashCommandEnumValue.js';
import { commonEnumProviders } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { slashCommandReturnHelper } from '../../slash-commands/SlashCommandReturnHelper.js';
import { WebLlmVectorProvider } from './webllm.js';
import { applyLegacyVectorEnabledSetting, bindVectorEnabledSettingsStore, getPersistableVectorSettings, getVectorEnabledState, normalizeVectorEnabledOptions, normalizeVectorSources, stripLegacyVectorEnabledSetting } from './settings-utils.js';
import { oai_settings } from '../../openai.js';
import { runVectorWork } from './native.js';
import { t } from '../../i18n.js';
import { renderTemplateAsync } from '../../templates.js';
import { mountVectorWorkspace } from './workspace.js';

/**
 * @typedef {object} HashedMessage
 * @property {string} text - The hashed message text
 * @property {number} hash - The hash used as the vector key
 * @property {number} index - The index of the message in the chat
 * @property {boolean} [summaryFailed] - Whether summarization failed for this message (used internally to skip messages that fail summarization)
 */

export const EXTENSION_PROMPT_TAG = '3_vectors';
export const EXTENSION_PROMPT_TAG_DB = '4_vectors_data_bank';

const settings = {
    // For both
    source: 'transformers',
    alt_endpoint_url: '',
    use_alt_endpoint: false,
    include_wi: false,
    togetherai_model: 'togethercomputer/m2-bert-80M-32k-retrieval',
    openai_model: 'text-embedding-3-small',
    electronhub_model: 'text-embedding-3-small',
    openrouter_model: 'openai/text-embedding-3-large',
    cohere_model: 'embed-english-v3.0',
    ollama_model: 'mxbai-embed-large',
    ollama_keep: false,
    vllm_model: '',
    webllm_model: '',
    google_model: 'gemini-embedding-001',
    chutes_model: 'chutes-qwen-qwen3-embedding-8b',
    nanogpt_model: 'text-embedding-3-small',
    siliconflow_model: 'Qwen/Qwen3-Embedding-0.6B',
    summarize: false,
    summarize_sent: false,
    summary_source: 'main',
    summary_prompt: 'Summarise the facts, names, events and commitments in the supplied message in 250 words or fewer. Preserve details useful for later retrieval. Return only the summary.',
    summary_retries: 2,
    summary_threshold: 200,
    force_chunk_delimiter: '',

    // For chats
    enabled_chats: false,
    keep_hidden: false,
    template: 'Past events:\n{{text}}',
    depth: 2,
    position: extension_prompt_types.IN_PROMPT,
    protect: 5,
    insert: 3,
    query: 2,
    message_chunk_size: 400,
    score_threshold: 0.25,

    // For files
    enabled_files: false,
    translate_files: false,
    size_threshold: 10,
    chunk_size: 5000,
    chunk_count: 2,
    overlap_percent: 0,
    only_custom_boundary: false,

    // For Data Bank
    size_threshold_db: 5,
    chunk_size_db: 2500,
    chunk_count_db: 5,
    overlap_percent_db: 0,
    file_template_db: 'Related information:\n{{text}}',
    file_position_db: extension_prompt_types.IN_PROMPT,
    file_depth_db: 4,
    file_depth_role_db: extension_prompt_roles.SYSTEM,

    // For World Info
    enabled_world_info: false,
    enabled_for_all: false,
    max_entries: 5,
};

const moduleWorker = new ModuleWorkerWrapper(synchronizeChat);
const webllmProvider = new WebLlmVectorProvider();
const vectorApiRequiresUrl = ['llamacpp', 'vllm', 'ollama', 'koboldcpp'];

/**
 * @typedef {object} RemoteEmbeddingEndpointConfig
 * @property {string} url - The API endpoint URL
 * @property {string} settingsKey - The key in settings for the selected model
 * @property {string} selectId - The ID of the select element (without #)
 * @property {string} [valueProperty='id'] - Property name for the option value
 * @property {string} [textProperty] - Property name for the option text. Falls back to valueProperty
 * @property {() => object} [getBody] - Function returning the request body
 * @property {(models: any[]) => any[]} [filter] - Optional post-fetch filter for models
 */

/** @type {Record<string, RemoteEmbeddingEndpointConfig>} */
const remoteEmbeddingEndpoints = {
    chutes: {
        url: '/api/openai/chutes/models/embedding',
        settingsKey: 'chutes_model',
        selectId: 'vectors_chutes_model',
        valueProperty: 'slug',
        textProperty: 'name',
    },
    nanogpt: {
        url: '/api/openai/nanogpt/models/embedding',
        settingsKey: 'nanogpt_model',
        selectId: 'vectors_nanogpt_model',
        textProperty: 'name',
    },
    electronhub: {
        url: '/api/openai/electronhub/models',
        settingsKey: 'electronhub_model',
        selectId: 'vectors_electronhub_model',
        textProperty: 'name',
        filter: models => models.filter(m => Array.isArray(m?.endpoints) && m.endpoints.includes('/v1/embeddings')),
    },
    openrouter: {
        url: '/api/openrouter/models/embedding',
        settingsKey: 'openrouter_model',
        selectId: 'vectors_openrouter_model',
        textProperty: 'name',
    },
    siliconflow: {
        url: '/api/openai/siliconflow/models/embedding',
        settingsKey: 'siliconflow_model',
        selectId: 'vectors_siliconflow_model',
        getBody: () => ({ siliconflow_endpoint: oai_settings.siliconflow_endpoint }),
    },
    workers_ai: {
        url: '/api/openai/workers-ai/models/embedding',
        settingsKey: 'workers_ai_model',
        selectId: 'vectors_workers_ai_model',
        getBody: () => ({ workers_ai_account_id: oai_settings.workers_ai_account_id }),
    },
};

/**
 * Gets the Collection ID for a file embedded in the chat.
 * @param {string} fileUrl URL of the file
 * @returns {string} Collection ID
 */
function getFileCollectionId(fileUrl) {
    return `file_${getStringHash(fileUrl)}`;
}

let syncBlocked = false;

async function synchronizeChat() {
    if (!settings.enabled_chats || !getCurrentChatId() || syncBlocked || is_send_press) return -1;
    try {
        syncBlocked = true;
        const result = await runVectorWork('sync-chat', {}, { automatic: true });
        return result.remaining;
    } catch (error) {
        toastr.error(error.message, 'Vector work retained', { preventDuplicates: true });
        return null;
    } finally {
        syncBlocked = false;
    }
}

/**
 * @type {Map<string, number>} Cache object for storing hash values
 */
const hashCache = new Map();

/**
 * Gets the hash value for a given string
 * @param {string} str Input string
 * @returns {number} Hash value
 */
function getStringHash(str) {
    // Check if the hash is already in the cache
    if (hashCache.has(str)) {
        return hashCache.get(str);
    }

    // Calculate the hash value
    const hash = calculateHash(str);

    // Store the hash in the cache
    hashCache.set(str, hash);

    return hash;
}

/**
 * Ensures that data bank attachments are ingested and inserted into the vector index.
 * @param {string} [source] Optional source filter for data bank attachments.
 * @returns {Promise<string[]>} Collection IDs
 */
async function ingestDataBankAttachments(source) {
    const dataBank = source ? getDataBankAttachmentsForSource(source, false) : getDataBankAttachments(false);
    const result = await runVectorWork('sync-files', { urls: dataBank.map(file => file.url), ...(source ? { scope: source } : {}) });
    return result.collections.map(collection => collection.collectionId);
}

/**
 * Removes the most relevant messages from the chat and displays them in the extension prompt
 * @param {ChatMessage[]} chat Array of chat messages
 * @param {number} _contextSize Context size (unused)
 * @param {function} _abort Abort function (unused)
 * @param {string} type Generation type
 */
async function rearrangeChat(chat, _contextSize, _abort, type) {
    if (type === 'quiet' || !getCurrentChatId() || !isVectorStorageEnabled('any')) return;
    const before = JSON.stringify(chat);
    const result = await runVectorWork('prompt', {}, { automatic: true });
    if (JSON.stringify(chat) !== before) throw new Error('The prompt changed while vector work was running. Its saved result has been kept.');
    const projection = result.projection;
    const find = target => chat.find(row => row.name === target.name && row.mes === target.original);
    const removals = projection.removed.map(find);
    const files = projection.files.map(item => ({ row: find(item), item }));
    if (removals.some(row => !row) || files.some(item => !item.row)) throw new Error('A saved vector target is no longer in this prompt.');
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, settings.include_wi);
    setExtensionPrompt(EXTENSION_PROMPT_TAG_DB, '', settings.file_position_db, settings.file_depth_db, settings.include_wi, settings.file_depth_role_db);
    for (const extension of projection.extensions) setExtensionPrompt(extension.key, extension.value, extension.position, extension.depth, extension.scan, extension.role);
    for (const { row, item } of files) row.mes = item.text;
    for (const row of removals) chat.splice(chat.indexOf(row), 1);
    if (projection.worldInfo.length) {
        const entries = await getSortedEntries();
        const matched = entries.filter(entry => projection.worldInfo.some(item => item.world === entry.world
            && String(item.uid) === String(entry.uid) && item.hash === getStringHash(entry.content)));
        await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, matched);
    }
}

globalThis.vectors_rearrangeChat = rearrangeChat;

function ensureVectorSettingsStore() {
    if (!extension_settings.vectors || typeof extension_settings.vectors !== 'object') {
        extension_settings.vectors = {};
    }

    return extension_settings.vectors;
}

function syncVectorEnabledControls() {
    const controls = {
        '#vectors_enabled_chats': settings.enabled_chats,
        '#vectors_enabled_files': settings.enabled_files,
        '#vectors_enabled_world_info': settings.enabled_world_info,
    };

    let hasControl = false;
    for (const [selector, value] of Object.entries(controls)) {
        const control = $(selector);
        if (!control.length) {
            continue;
        }

        control.prop('checked', !!value);
        hasControl = true;
    }

    if (hasControl) {
        toggleSettings();
    }
}

function bindVectorSettingsStore() {
    const store = ensureVectorSettingsStore();
    return bindVectorEnabledSettingsStore(settings, store, syncVectorEnabledControls);
}

function persistVectorSettings({ save = true, updateUi = true } = {}) {
    const store = ensureVectorSettingsStore();
    Object.assign(store, getPersistableVectorSettings(settings));
    bindVectorSettingsStore();

    if (updateUi) {
        syncVectorEnabledControls();
    }

    if (save) {
        saveSettingsDebounced();
    }
}

export function getVectorStorageState() {
    return getVectorEnabledState(settings);
}

export function isVectorStorageEnabled(scope = 'chats') {
    switch (scope) {
        case 'files':
        case 'file':
        case 'attachments':
            return !!settings.enabled_files;
        case 'worldInfo':
        case 'world_info':
        case 'world':
        case 'wi':
            return !!settings.enabled_world_info;
        case 'any':
            return !!(settings.enabled_chats || settings.enabled_files || settings.enabled_world_info);
        case 'chats':
        case 'chat':
        case 'messages':
        default:
            return !!settings.enabled_chats;
    }
}

export function setVectorStorageEnabled(options = true, config = {}) {
    const updates = normalizeVectorEnabledOptions(options);

    for (const [key, value] of Object.entries(updates)) {
        settings[key] = value;
    }

    persistVectorSettings(config);
    return getVectorStorageState();
}

export function enableVectorStorage(options = {}, config = {}) {
    const updates = normalizeVectorEnabledOptions(options);

    if (!Object.hasOwn(updates, 'enabled_chats')) {
        updates.enabled_chats = true;
    }

    return setVectorStorageEnabled(updates, config);
}

function exposeVectorStorageApi() {
    globalThis.SillyTavern ??= {};
    const api = globalThis.SillyTavern.vectors && typeof globalThis.SillyTavern.vectors === 'object'
        ? globalThis.SillyTavern.vectors
        : {};

    Object.assign(api, {
        getSettings: () => ({ ...settings }),
        getState: getVectorStorageState,
        isEnabled: isVectorStorageEnabled,
        setEnabled: setVectorStorageEnabled,
        enable: enableVectorStorage,
    });

    globalThis.SillyTavern.vectors = api;
    globalThis.SillyTavern.rag = api;
    globalThis.VectorStorage = api;
    globalThis.vectors_setEnabled = setVectorStorageEnabled;
    globalThis.vectors_enable = enableVectorStorage;
}

exposeVectorStorageApi();

const onChatEvent = debounce(async () => await moduleWorker.update(), debounce_timeout.relaxed);

/**
 * Purges the vector index for a file.
 * @param {string} fileUrl File URL to purge
 */
async function purgeFileVectorIndex(fileUrl) {
    try {
        console.log(`Vectors: Purging file vector index for ${fileUrl}`);
        const collectionId = getFileCollectionId(fileUrl);

        await runVectorWork('purge', { collectionIds: [collectionId] });

        console.log(`Vectors: Purged vector index for collection ${collectionId}`);
    } catch (error) {
        console.error('Vectors: Failed to purge file', error);
    }
}

/**
 * Purges the vector index for a collection.
 * @param {string} collectionId Collection ID to purge
 * @returns <Promise<boolean>> True if deleted, false if not
 */
async function purgeVectorIndex(collectionId) {
    try {
        await runVectorWork('purge', { collectionIds: [collectionId] });

        console.log(`Vectors: Purged vector index for collection ${collectionId}`);
        return true;
    } catch (error) {
        console.error('Vectors: Failed to purge', error);
        return false;
    }
}

/**
 * Purges all vector indexes.
 */
async function purgeAllVectorIndexes() {
    try {
        await runVectorWork('purge');

        console.log('Vectors: Purged all vector indexes');
        toastr.success('All vector indexes purged', 'Purge successful');
    } catch (error) {
        console.error('Vectors: Failed to purge all', error);
        toastr.error('Failed to purge all vector indexes', 'Purge failed');
    }
}

let workspace;
let lastModelSource;
const loadedModelSources = new Set();
const pendingModelSources = new Set();
const modelStatuses = new Map();

function toggleSettings() {
    workspace?.updateState();
    $('#together_vectorsModel').toggle(settings.source === 'togetherai');
    $('#openai_vectorsModel').toggle(settings.source === 'openai');
    $('#electronhub_vectorsModel').toggle(settings.source === 'electronhub');
    $('#chutes_vectorsModel').toggle(settings.source === 'chutes');
    $('#nanogpt_vectorsModel').toggle(settings.source === 'nanogpt');
    $('#openrouter_vectorsModel').toggle(settings.source === 'openrouter');
    $('#cohere_vectorsModel').toggle(settings.source === 'cohere');
    $('#ollama_vectorsModel').toggle(settings.source === 'ollama');
    $('#llamacpp_vectorsModel').toggle(settings.source === 'llamacpp');
    $('#vllm_vectorsModel').toggle(settings.source === 'vllm');
    $('#nomicai_apiKey').toggle(settings.source === 'nomicai');
    $('#webllm_vectorsModel').toggle(settings.source === 'webllm');
    $('#koboldcpp_vectorsModel').toggle(settings.source === 'koboldcpp');
    $('#google_vectorsModel').toggle(settings.source === 'palm' || settings.source === 'vertexai');
    if (['palm', 'vertexai'].includes(settings.source) && lastModelSource !== settings.source) {
        const models = settings.source === 'palm' ? ['gemini-embedding-2', 'gemini-embedding-001']
            : ['gemini-embedding-001', 'text-embedding-005', 'text-multilingual-embedding-002', 'text-embedding-004'];
        const select = $('#vectors_google_model').empty();
        if (!models.includes(settings.google_model)) select.append(new Option(t`${settings.google_model} (saved selection)`, settings.google_model));
        for (const model of models) select.append(new Option(model, model));
        select.val(settings.google_model);
    }
    $('#siliconflow_vectorsModel').toggle(settings.source === 'siliconflow');
    $('#workers_ai_vectorsModel').toggle(settings.source === 'workers_ai');
    $('#vector_altEndpointUrl').toggle(vectorApiRequiresUrl.includes(settings.source));
    const remote = settings.source in remoteEmbeddingEndpoints;
    $('#vectors_refresh_models').toggle(remote);
    $('#vectors_models_status').toggle(remote);
    if (remote) $('#vectors_models_status').text(modelStatuses.get(settings.source) || '');
    const help = settings.source === 'transformers'
        ? t`Runs on the Neconyan server. The first use may download its configured embedding model. No API key is needed.`
        : vectorApiRequiresUrl.includes(settings.source) ? t`Uses the server URL in Connections unless you choose a separate embedding server below.`
            : settings.source === 'webllm' ? t`Runs on this device through WebLLM.` : t`Set the provider credentials in Connections. Indexing and searches use this provider, independently of the chat model.`;
    $('[data-vectors-provider-help]').text(help);
    if (settings.source === 'webllm' && lastModelSource !== settings.source) {
        loadWebLlmModels();
    } else if (remote) {
        loadRemoteEmbeddingModels(settings.source);
    }
    lastModelSource = settings.source;
}

/**
 * Loads models from a remote embedding endpoint and populates the corresponding select element.
 * @param {string} source - The source key matching a remoteEmbeddingEndpoints entry
 */
async function loadRemoteEmbeddingModels(source, refresh = false) {
    const config = remoteEmbeddingEndpoints[source];
    if (!config || pendingModelSources.has(source) || !refresh && loadedModelSources.has(source)) {
        return;
    }
    loadedModelSources.add(source);
    pendingModelSources.add(source);

    const { url, settingsKey, selectId, getBody, filter } = config;
    const valueProperty = config.valueProperty || 'id';
    const textProperty = config.textProperty;
    const report = message => {
        modelStatuses.set(source, message);
        if (source === settings.source) $('#vectors_models_status').text(message);
    };

    /**
     * Populates the select element with the given models.
     * @param {any[]} models - Array of model objects
     */
    function populateSelect(models) {
        const select = $(`#${selectId}`);
        select.empty();
        const saved = settings[settingsKey];
        if (saved && !models.some(model => model[valueProperty] === saved)) {
            select.append(new Option(t`${saved} (saved selection)`, saved));
        }
        for (const m of models) {
            const option = document.createElement('option');
            option.value = m[valueProperty];
            option.text = textProperty ? (m[textProperty] || m[valueProperty]) : m[valueProperty];
            select.append(option);
        }
        if (!settings[settingsKey] && models.length) {
            settings[settingsKey] = models[0][valueProperty];
            Object.assign(extension_settings.vectors, settings);
            saveSettingsDebounced();
        }
        select.val(settings[settingsKey]);
    }

    try {
        report(t`Loading available embedding models…`);
        const body = typeof getBody === 'function' ? getBody() : {};

        /** @type {RequestInit} */
        const fetchOptions = {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body || {}),
        };

        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        /** @type {Array<any>} */
        const data = await response.json();
        let models = Array.isArray(data) ? data : [];
        if (filter) {
            models = filter(models);
        }

        populateSelect(models);
        report(t`${models.length} models listed. Your saved selection is preserved.`);
    } catch (err) {
        console.warn(`${source} models fetch failed`, err);
        if (!$(`#${selectId} option`).length) populateSelect([]);
        report(t`Could not load models. Check the provider key in Connections, then refresh. Your saved model is still selected.`);
    } finally { pendingModelSources.delete(source); }
}

/**
 * Executes a function with WebLLM error handling.
 * @param {function(): Promise<T>} func Function to execute
 * @returns {Promise<T>}
 * @template T
 */
async function executeWithWebLlmErrorHandling(func) {
    try {
        return await func();
    } catch (error) {
        console.log('Vectors: Failed to load WebLLM models', error);
        if (!(error instanceof Error)) {
            return;
        }
        switch (error.cause) {
            case 'webllm-not-available':
                toastr.warning('WebLLM is not available. Please install the extension.', 'WebLLM not installed');
                break;
            case 'webllm-not-updated':
                toastr.warning('The installed extension version does not support embeddings.', 'WebLLM update required');
                break;
        }
    }
}

/**
 * Loads and displays WebLLM models in the settings.
 * @returns {Promise<void>}
 */
function loadWebLlmModels() {
    return executeWithWebLlmErrorHandling(() => {
        const models = webllmProvider.getModels();
        $('#vectors_webllm_model').empty();
        for (const model of models) {
            $('#vectors_webllm_model').append($('<option>', { value: model.id, text: model.toString() }));
        }
        if (!settings.webllm_model || !models.some(x => x.id === settings.webllm_model)) {
            if (models.length) {
                settings.webllm_model = models[0].id;
            }
        }
        $('#vectors_webllm_model').val(settings.webllm_model);
        return Promise.resolve();
    });
}

export async function init() {
    const savedVectorSettings = ensureVectorSettingsStore();
    Object.assign(settings, savedVectorSettings);
    applyLegacyVectorEnabledSetting(settings, savedVectorSettings);

    // Migrate from old settings
    if (settings.enabled) {
        settings.enabled_chats = true;
    }
    stripLegacyVectorEnabledSetting(settings);

    const template = await renderTemplateAsync('/scripts/extensions/vectors/settings.html?v=20260929-vectors1', {}, true, true, true);
    $('#vectors_container').append(template);
    const migratedSources = normalizeVectorSources(settings, Array.from(document.querySelectorAll('#vectors_source option'), option => option.value));
    stripLegacyVectorEnabledSetting(savedVectorSettings);
    Object.assign(savedVectorSettings, getPersistableVectorSettings(settings));
    bindVectorSettingsStore();
    if (migratedSources) saveSettingsDebounced();
    $('#vectors_enabled_chats').prop('checked', settings.enabled_chats).on('input', () => {
        settings.enabled_chats = $('#vectors_enabled_chats').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
        toggleSettings();
    });
    $('#vectors_keep_hidden').prop('checked', settings.keep_hidden).on('input', () => {
        settings.keep_hidden = !!$('#vectors_keep_hidden').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_enabled_files').prop('checked', settings.enabled_files).on('input', () => {
        settings.enabled_files = $('#vectors_enabled_files').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
        toggleSettings();
    });
    $('#vectors_source').val(settings.source).on('change', () => {
        settings.source = String($('#vectors_source').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
        toggleSettings();
    });
    $('#vector_altEndpointUrl_enabled').prop('checked', settings.use_alt_endpoint).on('input', () => {
        settings.use_alt_endpoint = $('#vector_altEndpointUrl_enabled').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vector_altEndpoint_address').val(settings.alt_endpoint_url).on('change', () => {
        settings.alt_endpoint_url = String($('#vector_altEndpoint_address').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_togetherai_model').val(settings.togetherai_model).on('change', () => {
        settings.togetherai_model = String($('#vectors_togetherai_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_openai_model').val(settings.openai_model).on('change', () => {
        settings.openai_model = String($('#vectors_openai_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_electronhub_model').val(settings.electronhub_model).on('change', () => {
        settings.electronhub_model = String($('#vectors_electronhub_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_chutes_model').val(settings.chutes_model).on('change', () => {
        settings.chutes_model = String($('#vectors_chutes_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_nanogpt_model').val(settings.nanogpt_model).on('change', () => {
        settings.nanogpt_model = String($('#vectors_nanogpt_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_siliconflow_model').val(settings.siliconflow_model).on('change', () => {
        settings.siliconflow_model = String($('#vectors_siliconflow_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_workers_ai_model').val(settings.workers_ai_model).on('change', () => {
        settings.workers_ai_model = String($('#vectors_workers_ai_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_openrouter_model').val(settings.openrouter_model).on('change', () => {
        settings.openrouter_model = String($('#vectors_openrouter_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_cohere_model').val(settings.cohere_model).on('change', () => {
        settings.cohere_model = String($('#vectors_cohere_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_ollama_model').val(settings.ollama_model).on('input', () => {
        settings.ollama_model = String($('#vectors_ollama_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_vllm_model').val(settings.vllm_model).on('input', () => {
        settings.vllm_model = String($('#vectors_vllm_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_ollama_keep').prop('checked', settings.ollama_keep).on('input', () => {
        settings.ollama_keep = $('#vectors_ollama_keep').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_template').val(settings.template).on('input', () => {
        settings.template = String($('#vectors_template').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_depth').val(settings.depth).on('input', () => {
        settings.depth = Number($('#vectors_depth').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_protect').val(settings.protect).on('input', () => {
        settings.protect = Number($('#vectors_protect').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_insert').val(settings.insert).on('input', () => {
        settings.insert = Number($('#vectors_insert').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_query').val(settings.query).on('input', () => {
        settings.query = Number($('#vectors_query').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $(`input[name="vectors_position"][value="${settings.position}"]`).prop('checked', true);
    $('input[name="vectors_position"]').on('change', () => {
        settings.position = Number($('input[name="vectors_position"]:checked').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });
    $('#vectors_refresh_models').on('click', () => loadRemoteEmbeddingModels(settings.source, true));

    $('#vectors_size_threshold').val(settings.size_threshold).on('input', () => {
        settings.size_threshold = Number($('#vectors_size_threshold').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_chunk_size').val(settings.chunk_size).on('input', () => {
        settings.chunk_size = Number($('#vectors_chunk_size').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_chunk_count').val(settings.chunk_count).on('input', () => {
        settings.chunk_count = Number($('#vectors_chunk_count').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_include_wi').prop('checked', settings.include_wi).on('input', () => {
        settings.include_wi = !!$('#vectors_include_wi').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_summarize').prop('checked', settings.summarize).on('input', () => {
        settings.summarize = !!$('#vectors_summarize').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_summarize_user').prop('checked', settings.summarize_sent).on('input', () => {
        settings.summarize_sent = !!$('#vectors_summarize_user').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_summary_source').val(settings.summary_source).on('change', () => {
        settings.summary_source = String($('#vectors_summary_source').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_summary_prompt').val(settings.summary_prompt).on('input', () => {
        settings.summary_prompt = String($('#vectors_summary_prompt').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_summary_retries').val(settings.summary_retries).on('input', () => {
        const parsed = Number($('#vectors_summary_retries').val());
        settings.summary_retries = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_summary_threshold').val(settings.summary_threshold).on('input', () => {
        const parsed = Number($('#vectors_summary_threshold').val());
        settings.summary_threshold = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_message_chunk_size').val(settings.message_chunk_size).on('input', () => {
        settings.message_chunk_size = Number($('#vectors_message_chunk_size').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_size_threshold_db').val(settings.size_threshold_db).on('input', () => {
        settings.size_threshold_db = Number($('#vectors_size_threshold_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_chunk_size_db').val(settings.chunk_size_db).on('input', () => {
        settings.chunk_size_db = Number($('#vectors_chunk_size_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_chunk_count_db').val(settings.chunk_count_db).on('input', () => {
        settings.chunk_count_db = Number($('#vectors_chunk_count_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_overlap_percent').val(settings.overlap_percent).on('input', () => {
        settings.overlap_percent = Number($('#vectors_overlap_percent').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_overlap_percent_db').val(settings.overlap_percent_db).on('input', () => {
        settings.overlap_percent_db = Number($('#vectors_overlap_percent_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_file_template_db').val(settings.file_template_db).on('input', () => {
        settings.file_template_db = String($('#vectors_file_template_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $(`input[name="vectors_file_position_db"][value="${settings.file_position_db}"]`).prop('checked', true);
    $('input[name="vectors_file_position_db"]').on('change', () => {
        settings.file_position_db = Number($('input[name="vectors_file_position_db"]:checked').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_file_depth_db').val(settings.file_depth_db).on('input', () => {
        settings.file_depth_db = Number($('#vectors_file_depth_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_file_depth_role_db').val(settings.file_depth_role_db).on('input', () => {
        settings.file_depth_role_db = Number($('#vectors_file_depth_role_db').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_translate_files').prop('checked', settings.translate_files).on('input', () => {
        settings.translate_files = !!$('#vectors_translate_files').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_enabled_world_info').prop('checked', settings.enabled_world_info).on('input', () => {
        settings.enabled_world_info = !!$('#vectors_enabled_world_info').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
        toggleSettings();
    });

    $('#vectors_enabled_for_all').prop('checked', settings.enabled_for_all).on('input', () => {
        settings.enabled_for_all = !!$('#vectors_enabled_for_all').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_max_entries').val(settings.max_entries).on('input', () => {
        settings.max_entries = Number($('#vectors_max_entries').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_score_threshold').val(settings.score_threshold).on('input', () => {
        settings.score_threshold = Number($('#vectors_score_threshold').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_force_chunk_delimiter').val(settings.force_chunk_delimiter).on('input', () => {
        settings.force_chunk_delimiter = String($('#vectors_force_chunk_delimiter').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_only_custom_boundary').prop('checked', settings.only_custom_boundary).on('input', () => {
        settings.only_custom_boundary = !!$('#vectors_only_custom_boundary').prop('checked');
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_ollama_pull').on('click', (e) => {
        const presetModel = extension_settings.vectors.ollama_model || '';
        e.preventDefault();
        $('#ollama_download_model').trigger('click');
        $('#dialogue_popup_input').val(presetModel);
    });

    $('#vectors_webllm_install').on('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (Object.hasOwn(SillyTavern, 'llm')) {
            toastr.info('WebLLM is already installed');
            return;
        }

        openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-WebLLM');
    });

    $('#vectors_webllm_model').on('input', () => {
        settings.webllm_model = String($('#vectors_webllm_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#vectors_webllm_load').on('click', async () => {
        if (!settings.webllm_model) return;
        await webllmProvider.loadModel(settings.webllm_model);
        toastr.success('WebLLM model loaded');
    });

    $('#vectors_google_model').val(settings.google_model).on('input', () => {
        settings.google_model = String($('#vectors_google_model').val());
        Object.assign(extension_settings.vectors, settings);
        saveSettingsDebounced();
    });

    $('#api_key_nomicai').toggleClass('success', !!secret_state[SECRET_KEYS.NOMICAI]);
    [event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_ROTATED].forEach(event => {
        eventSource.on(event, (/** @type {string} */ key) => {
            if (key !== SECRET_KEYS.NOMICAI) return;
            $('#api_key_nomicai').toggleClass('success', !!secret_state[SECRET_KEYS.NOMICAI]);
        });
    });

    workspace = mountVectorWorkspace(settings);
    toggleSettings();
    eventSource.on(event_types.MESSAGE_DELETED, onChatEvent);
    eventSource.on(event_types.MESSAGE_EDITED, onChatEvent);
    eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onChatEvent);
    eventSource.on(event_types.MESSAGE_SWIPED, onChatEvent);
    eventSource.on(event_types.CHAT_DELETED, purgeVectorIndex);
    eventSource.on(event_types.GROUP_CHAT_DELETED, purgeVectorIndex);
    eventSource.on(event_types.FILE_ATTACHMENT_DELETED, purgeFileVectorIndex);
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, async (manifest) => {
        if (settings.source === 'webllm' && manifest?.display_name === 'WebLLM') {
            await loadWebLlmModels();
        }
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'db-ingest',
        callback: async () => {
            await ingestDataBankAttachments();
            return '';
        },
        aliases: ['databank-ingest', 'data-bank-ingest'],
        helpString: 'Force the ingestion of all Data Bank attachments.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'db-purge',
        callback: async () => {
            const dataBank = getDataBankAttachments();

            await runVectorWork('purge', { collectionIds: dataBank.map(file => getFileCollectionId(file.url)).filter(onlyUnique) });

            return '';
        },
        aliases: ['databank-purge', 'data-bank-purge'],
        helpString: 'Purge the vector index for all Data Bank attachments.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'db-search',
        callback: async (args, query) => {
            const clamp = (v) => Number.isNaN(v) ? null : Math.min(1, Math.max(0, v));
            const threshold = clamp(Number(args?.threshold ?? settings.score_threshold));
            const validateCount = (v) => Number.isNaN(v) || !Number.isInteger(v) || v < 1 ? null : v;
            const count = validateCount(Number(args?.count)) ?? settings.chunk_count_db;
            const source = String(args?.source ?? '');
            const attachments = source ? getDataBankAttachmentsForSource(source, false) : getDataBankAttachments(false);
            const result = await runVectorWork('sync-files', { urls: attachments.map(file => file.url),
                ...(source ? { scope: source } : {}), query: String(query), topK: count, threshold });
            const queryResults = result.query || {};

            // Get URLs
            const urls = Object
                .keys(queryResults)
                .map(x => attachments.find(y => getFileCollectionId(y.url) === x))
                .filter(x => x)
                .map(x => x.url);

            // Gets the actual text content of chunks
            const getChunksText = () => {
                let textResult = '';
                for (const collectionId in queryResults) {
                    const metadata = queryResults[collectionId].metadata?.filter(x => x.text)?.sort((a, b) => a.index - b.index)?.map(x => x.text)?.filter(onlyUnique) || [];
                    textResult += metadata.join('\n') + '\n\n';
                }
                return textResult;
            };
            if (args.return === 'chunks') {
                return getChunksText();
            }

            // @ts-ignore
            return slashCommandReturnHelper.doReturn(args.return ?? 'object', urls, { objectToStringFunc: list => list.join('\n') });
        },
        aliases: ['databank-search', 'data-bank-search'],
        helpString: 'Search the Data Bank for a specific query using vector similarity. Returns a list of file URLs with the most relevant content.',
        namedArgumentList: [
            new SlashCommandNamedArgument('threshold', 'Threshold for the similarity score in the [0, 1] range. Uses the global config value if not set.', ARGUMENT_TYPE.NUMBER, false, false, ''),
            new SlashCommandNamedArgument('count', 'Maximum number of query results to return.', ARGUMENT_TYPE.NUMBER, false, false, ''),
            new SlashCommandNamedArgument('source', 'Optional filter for the attachments by source.', ARGUMENT_TYPE.STRING, false, false, '', ['global', 'character', 'chat']),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: 'How you want the return value to be provided',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'object',
                enumList: [
                    new SlashCommandEnumValue('chunks', 'Return the actual content chunks', enumTypes.enum, '{}'),
                    ...slashCommandReturnHelper.enumList({ allowObject: true }),
                ],
                forceEnum: true,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('Query to search by.', ARGUMENT_TYPE.STRING, true, false),
        ],
        returns: ARGUMENT_TYPE.LIST,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vector-threshold',
        helpString: 'Set the vector score threshold or return the current threshold if no argument is provided.',
        returns: 'score threshold value',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Score threshold (number).',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        callback: async (_args, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) {
                return String(settings.score_threshold);
            }

            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
                toastr.warning('Score threshold must be a number between 0 and 1.');
                return '';
            }

            $('#vectors_score_threshold')
                .val(parsed)
                .trigger('input');

            return String(settings.score_threshold);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vector-query',
        helpString: 'Set the vector query messages or returns the current query messages count if no argument is provided',
        returns: 'the query messages value',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Query messages (number > 0).',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        callback: async (_args, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) {
                return String(settings.query);
            }

            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                toastr.warning('Query messages must be a number greater than 0.');
                return '';
            }

            $('#vectors_query')
                .val(parsed)
                .trigger('input');

            return String(settings.query);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vector-max-entries',
        helpString: 'Set the vector world info max entries or returns the current max entries if no argument is provided',
        returns: 'world info max entries',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Max entries (number > 0).',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        callback: async (_args, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) {
                return String(settings.max_entries);
            }

            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                toastr.warning('Max entries must be a number greater than 0.');
                return '';
            }

            $('#vectors_max_entries')
                .val(parsed)
                .trigger('input');

            return String(settings.max_entries);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vector-chats-state',
        helpString: 'Set whether chat vectorization is enabled or return the current boolean if no argument is provided',
        returns: 'boolean for if chat vectorization is enabled',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'boolean to set whether chat vectorization is enabled',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        callback: async (_args, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) {
                return String(settings.enabled_chats);
            }

            const parsed = isTrueBoolean(raw);
            $('#vectors_enabled_chats')
                .prop('checked', parsed)
                .trigger('input');

            return String(settings.enabled_chats);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vector-files-state',
        helpString: 'Set whether file vectorization is enabled or return the current boolean if no argument is provided',
        returns: 'boolean for if file vectorization is enabled',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'boolean to set whether file vectorization is enabled',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        callback: async (_args, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) {
                return String(settings.enabled_files);
            }

            const parsed = isTrueBoolean(raw) ;
            $('#vectors_enabled_files')
                .prop('checked', parsed)
                .trigger('input');

            return String(settings.enabled_files);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vector-worldinfo-state',
        helpString: 'Set whether world info vectorization is enabled or return the current boolean if no argument is provided',
        returns: 'boolean for if world info vectorization is enabled',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'boolean to set whether world info vectorization is enabled',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        callback: async (_args, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) {
                return String(settings.enabled_world_info);
            }

            const parsed = isTrueBoolean(raw);
            $('#vectors_enabled_world_info')
                .prop('checked', parsed)
                .trigger('input');

            return String(settings.enabled_world_info);
        },
    }));

    registerDebugFunction('purge-everything', 'Purge all vector indices', 'Obliterate all stored vectors for all sources. No mercy.', async () => {
        if (!confirm('Are you sure?')) {
            return;
        }
        await purgeAllVectorIndexes();
    });
}
