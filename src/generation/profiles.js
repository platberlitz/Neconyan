import path from 'node:path';
import sanitize from 'sanitize-filename';
import { CHAT_COMPLETION_SOURCES } from '../constants.js';
import { readSecret, secretIdExists, SecretManager, SECRET_KEYS } from '../endpoints/secrets.js';
import { getSettingsRevision } from '../settings-version.js';
import { applyGenerationRequestControls } from '../../public/scripts/generation-request-controls.js';
import { fail, hash } from '../mewmory/core.js';
import { readJson } from '../mewmory/store.js';
import { buildChatPresetPayload, createChatRequestData } from '../../public/scripts/chat-preset-request.js';
import { resolveProfileProxy, resolveProfileRequestOverrides, resolveProfileServiceTier } from '../../public/scripts/connection-profile-request.js';
import { textgen_types } from '../../public/scripts/text-provider-parameters.js';
import { mergeTextPresetSettings, TEXT_PROVIDER_URLS } from '../../public/scripts/text-preset-request.js';

const sources = new Set(Object.values(CHAT_COMPLETION_SOURCES));
const aliases = { oai: 'openai', google: 'makersuite' };
const textSources = new Set(Object.values(textgen_types));

function readPreset(directory, name, label) {
    if (!name) return undefined;
    if (typeof name !== 'string' || sanitize(name) !== name || !directory) fail(`The profile has an invalid ${label}.`, 409);
    const preset = readJson(path.join(directory, name + '.json'), null);
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) fail(`The profile's ${label} no longer exists.`, 409);
    return preset;
}

function profileValue(profile, field) {
    return profile.exclude?.includes(field) ? undefined : profile[field];
}

/** Validate literal lists before acceptance and macro-expanded lists during preparation. */
export function parseTextTokenIds(value) {
    let ids;
    try { ids = JSON.parse(value); } catch { fail('The saved token list is invalid.', 409); }
    if (!Array.isArray(ids) || !ids.every(Number.isInteger)) fail('The saved token list is invalid.', 409);
    return ids;
}

function readTextProfile(directories, profile, settings, source, activeBinding = false) {
    if (!textSources.has(source)) fail('This text-completion provider is not supported.', 409);
    const saved = settings.textgenerationwebui_settings;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) fail('The saved Text Completion settings are missing.', 409);
    const preset = readPreset(directories.textGen_Settings, profileValue(profile, 'preset'), 'completion preset');
    const template = readPreset(directories.instruct, profileValue(profile, 'instruct'), 'instruct preset');
    const context = readPreset(directories.context, profileValue(profile, 'context'), 'context template') ?? settings.power_user?.context ?? {};
    const active = activeBinding ? structuredClone(saved) : mergeTextPresetSettings(saved, preset, { api_type: source });
    active.api_server = activeBinding ? profile['api-url'] : profileValue(profile, 'api-url') || TEXT_PROVIDER_URLS[source];
    if (source === 'openrouter' && !activeBinding) active.openrouter_service_tier = resolveProfileServiceTier(profile, source, preset) ?? '';
    let url;
    try { url = new URL(active.api_server); } catch { fail('Save a server URL in this connection profile.', 409); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Use an HTTP server URL without embedded credentials.', 409);
    const power = structuredClone(settings.power_user || {});
    const instruct = structuredClone(template ?? power.instruct ?? {});
    const state = profileValue(profile, 'instruct-state');
    instruct.enabled = state === undefined ? Boolean(activeBinding ? instruct.enabled : template || (profile.exclude?.includes('instruct') && instruct.enabled))
        : ['true', 'on', '1'].includes(String(state).toLowerCase());
    if (profileValue(profile, 'stop-strings') !== undefined) power.custom_stopping_strings = profileValue(profile, 'stop-strings');
    if (profileValue(profile, 'tokenizer') !== undefined) power.tokenizer = profileValue(profile, 'tokenizer');
    for (const [key, value] of Object.entries(instruct)) {
        if ((key.endsWith('_sequence') || key.endsWith('_suffix') || ['name', 'activation_regex'].includes(key)) && typeof value !== 'string') fail('The saved instruct sequences must be text.', 409);
    }
    for (const key of ['chat_start', 'example_separator', 'story_string', 'story_string_prefix', 'story_string_suffix']) {
        if (context[key] !== undefined && typeof context[key] !== 'string') fail('The saved context template fields must be text.', 409);
    }
    if (state !== undefined && ![true, false, 'true', 'false', 'on', 'off', '1', '0', 1, 0].includes(state)) fail('The saved instruct state is invalid.', 409);
    let stops;
    try { stops = power.custom_stopping_strings ? JSON.parse(power.custom_stopping_strings) : []; } catch { fail('The saved stopping strings are invalid JSON.', 409); }
    if (!Array.isArray(stops) || !stops.every(value => typeof value === 'string')) fail('The saved stopping strings must be a list of text.', 409);
    if (active.logit_bias !== undefined && (!Array.isArray(active.logit_bias) || !active.logit_bias.every(entry => entry && typeof entry.text === 'string' && Number.isFinite(entry.value)))) fail('The saved token bias is invalid.', 409);
    for (const key of ['banned_tokens', 'global_banned_tokens', 'dry_sequence_breakers', 'negative_prompt']) {
        if (active[key] !== undefined && typeof active[key] !== 'string') fail('The saved text controls contain an invalid text field.', 409);
    }
    for (const entry of active.logit_bias || []) {
        const value = entry.text.trim();
        if (value.startsWith('[') && value.endsWith(']')) parseTextTokenIds(value);
    }
    const lists = active.send_banned_tokens ? `${active.banned_tokens || ''}\n${active.global_banned_tokens || ''}`.split('\n') : [];
    for (const value of lists) {
        if (value.startsWith('[') && value.endsWith(']') && !value.includes('{{')) parseTextTokenIds(value);
    }
    if (source === 'ollama' && (typeof profile.model !== 'string' || !profile.model.trim())) fail('Select an Ollama model before generating a reply.', 409);
    const secretType = SECRET_KEYS[source === 'ooba' ? 'OOBA' : source.toUpperCase()];
    const secretId = profile['secret-id'] || null;
    if (secretId && (!secretType || !readSecret(directories, secretType, secretId))) fail('The saved API key for this profile is unavailable.', 409);
    if (!secretId && ['mancer', 'togetherai', 'infermaticai', 'dreamgen', 'openrouter', 'featherless', 'huggingface'].includes(source)) fail('Select a saved API key in this connection profile.', 409);
    const contextLimit = Number(preset?.max_length ?? preset?.max_context ?? settings.max_context);
    if (!Number.isSafeInteger(contextLimit) || contextLimit < 1) fail('Save a valid context limit for this text connection.', 409);
    const fingerprint = hash({ profile, active, preset, instruct, context, contextLimit, secretId,
        requestControls: { custom_stopping_strings: power.custom_stopping_strings, custom_stopping_strings_macro: power.custom_stopping_strings_macro,
            tokenizer: power.tokenizer, request_token_probabilities: power.request_token_probabilities } });
    return { backend: 'text', profile, source, active, preset, instruct, context, power, contextLimit, secretId, fingerprint };
}

function readProfile(directories, profileId) {
    if (typeof profileId !== 'string' || !profileId || profileId.length > 256) fail('Choose a saved connection profile.', 400);
    const settings = readJson(path.join(directories.root, 'settings.json'), {});
    if (settings.extension_settings?.disabledExtensions?.includes('connection-manager')) fail('Connection Manager is disabled.', 409);
    const profiles = settings.extension_settings?.connectionManager?.profiles;
    let profile = profiles?.find(item => item.id === profileId);
    if (!profile) {
        // Conversation settings save a profile name, while jobs capture its id.
        const named = (profiles || []).filter(item => item.name === profileId);
        if (named.length > 1) fail('More than one saved connection profile has this name.', 409);
        profile = named[0];
    }
    if (!profile) fail('The saved connection profile no longer exists.', 409);
    if (profile.mode === 'tc' || profile.api === 'openrouter-text' || (profile.api !== 'openrouter' && textSources.has(profile.api)) || profile.api === 'kcpp') {
        const source = { 'openrouter-text': 'openrouter', kcpp: 'koboldcpp' }[profile.api] || profile.api;
        return readTextProfile(directories, profile, settings, source);
    }
    const source = aliases[profile.api] || profile.api;
    return readChatProfile(directories, profile, settings, source);
}

function readChatProfile(directories, profile, settings, source, activeBinding = false) {
    if (!sources.has(source)) fail('This operation requires a Chat Completion connection profile.', 409);
    const websiteDefault = activeBinding && source === 'openrouter' && profile.model === null && settings.oai_settings?.openrouter_model === 'OR_Website';
    if (!websiteDefault && (typeof profile.model !== 'string' || !profile.model.trim())) fail('Save a model in this connection profile.', 409);
    const active = settings.oai_settings;
    if (!active || typeof active !== 'object' || Array.isArray(active)) fail('The saved Chat Completion settings are missing.', 409);
    let preset;
    if (profile.preset) {
        if (typeof profile.preset !== 'string' || sanitize(profile.preset) !== profile.preset || !directories.openAI_Settings) fail('The profile has an invalid completion preset.', 409);
        preset = readJson(path.join(directories.openAI_Settings, profile.preset + '.json'), null);
        if (!preset || typeof preset !== 'object' || Array.isArray(preset)) fail('The profile’s completion preset no longer exists.', 409);
    }
    const proxy = activeBinding ? { reverse_proxy: active.reverse_proxy || '', proxy_password: active.proxy_password || '' }
        : resolveProfileProxy(profile, source, settings.proxies || [], active);
    if (activeBinding) {
        if (source === 'azure_openai' && ['azure_base_url', 'azure_deployment_name', 'azure_api_version'].some(key => typeof active[key] !== 'string' || !active[key].trim())) fail('Save the Azure URL, deployment name and API version before generating a reply.', 409);
        for (const address of [proxy.reverse_proxy, source === 'custom' ? active.custom_url : '', source === 'azure_openai' ? active.azure_base_url : '']) {
            if (!address) continue;
            let url;
            try { url = new URL(address); } catch { fail('The saved active connection URL is invalid.', 409); }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Use an HTTP URL without embedded credentials for the active connection.', 409);
        }
        if (source === 'custom' && !active.custom_url) fail('Save the active Custom server URL before generating a reply.', 409);
    }
    // Credential values are resolved again at execution, not copied to a job record.
    const fingerprint = hash({ profile, active: { ...active, proxy_password: undefined }, preset: preset && { ...preset, proxy_password: undefined }, proxy: proxy.reverse_proxy,
        requestControls: {
            custom_stopping_strings: settings.power_user?.custom_stopping_strings,
            custom_stopping_strings_macro: settings.power_user?.custom_stopping_strings_macro,
            request_token_probabilities: settings.power_user?.request_token_probabilities,
            console_log_prompts: settings.power_user?.console_log_prompts,
        } });
    return { profile, source, active, preset, proxy, fingerprint };
}

function readActiveConnection(directories) {
    const settings = readJson(path.join(directories.root, 'settings.json'), {});
    const selection = settings.active_generation;
    if (!selection || selection.api !== settings.main_api) fail('Save the active connection settings before generating a reply.', 409);
    const text = settings.main_api === 'textgenerationwebui';
    if (!text && settings.main_api !== 'openai') fail('This active connection cannot run on the server. Choose a saved Chat or Text Completion connection.', 409);
    const controls = text ? settings.textgenerationwebui_settings : settings.oai_settings;
    const source = text ? controls?.type : controls?.chat_completion_source;
    if (selection.source !== source) fail('Save the current active provider before generating a reply.', 409);
    const keyType = source === 'openai_responses' ? SECRET_KEYS.OPENAI
        : source === 'vertexai' && controls?.vertexai_auth_mode === 'full' ? SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT : SECRET_KEYS[source?.toUpperCase()];
    const secretId = !text && source === 'custom' && settings.selected_custom_endpoint_preset?.secretId
        ? settings.selected_custom_endpoint_preset.secretId
        : new SecretManager(directories).getSecretState()[keyType]?.find(secret => secret.active)?.id || null;
    if (secretId && !secretIdExists(directories, keyType, secretId)) fail('The saved API key for the active connection is unavailable.', 409);
    const profile = { id: 'active', api: source, model: selection.model, 'secret-id': secretId };
    if (text) profile['api-url'] = selection.serverUrl;
    else {
        const field = { custom: 'custom_url', vertexai: 'vertexai_region', zai: 'zai_endpoint', siliconflow: 'siliconflow_endpoint', minimax: 'minimax_endpoint' }[source];
        if (field) profile['api-url'] = controls[field];
    }
    const material = text ? readTextProfile(directories, profile, settings, source, true) : readChatProfile(directories, profile, settings, source, true);
    if (!text && !material.proxy.reverse_proxy && source !== 'custom' && (!secretId || !readSecret(directories, keyType, secretId))) {
        fail('Select a saved API key for the active connection.', 409);
    }
    const extensions = settings.extension_settings || {};
    const regexPolicy = {
        disabled: extensions.disabledExtensions?.includes('regex') || false,
        global: extensions.regex || [],
        characterAllowed: extensions.character_allowed_regex || [],
        presetAllowed: extensions.preset_allowed_regex || {},
        preset: selection.regexPreset,
        presetScripts: controls?.extensions?.regex_scripts || [],
    };
    return { ...material, kind: 'active', power: structuredClone(settings.power_user || {}), regexPolicy,
        fingerprint: hash({ kind: 'active', material: material.fingerprint, selection,
            power: settings.power_user, regexPolicy }),
        settingsRevision: getSettingsRevision(settings) };
}

/** Capture a deliberate saved selection; an empty profile is never a fallback. */
export function captureGenerationBinding(directories, selection, acknowledgement) {
    if (selection?.kind === 'profile') return { kind: 'profile', ...captureChatProfile(directories, selection.profileId) };
    if (selection?.kind !== 'active') fail('Choose a saved profile or the acknowledged active connection.', 400);
    const material = readActiveConnection(directories);
    if (!Number.isSafeInteger(acknowledgement?.settingsRevision) || acknowledgement.settingsRevision !== material.settingsRevision) {
        fail('The active connection settings are not acknowledged. Save them before generating a reply.', 409);
    }
    return { kind: 'active', backend: material.backend || 'chat', fingerprint: material.fingerprint };
}

/** Persist only this binding. Changed saved controls require an explicit new acceptance. */
export function captureChatProfile(directories, profileId) {
    const { profile, fingerprint, backend } = readProfile(directories, profileId);
    return { profileId: profile.id, fingerprint, ...(backend === 'text' ? { backend } : {}) };
}

/** Read current controls only when they still match the accepted reference. */
export function resolveGenerationProfile(directories, binding) {
    const material = binding?.kind === 'active' ? readActiveConnection(directories) : readProfile(directories, binding?.profileId);
    if (!binding?.fingerprint || material.fingerprint !== binding.fingerprint) fail('The saved connection settings changed after this operation was accepted. Retry with the current settings.', 409);
    return material;
}

/**
 * The completion preset's context window for a saved binding, or null when the
 * preset does not declare one. Used to size assistant knowledge; never falls
 * back to the active browser profile.
 */
export function getChatProfileContextLimit(directories, binding) {
    const { preset, contextLimit, kind, active } = resolveGenerationProfile(directories, binding);
    if (contextLimit) return contextLimit;
    if (kind === 'active') return Number.isSafeInteger(active.openai_max_context) && active.openai_max_context > 0 ? active.openai_max_context : null;
    for (const key of ['openai_max_context', 'max_context']) {
        const value = Number(preset?.[key]);
        if (Number.isFinite(value) && value > 0) return Math.floor(value);
    }
    return null;
}

/** Resolve controls through the same preset/profile builders used by the browser. */
export async function buildChatProfileRequest(directories, binding, messages, maxTokens, generate, { modelOverride = '', overridePayload = {}, rawOptions = {} } = {}) {
    const material = resolveGenerationProfile(directories, binding);
    if (material.backend === 'text') fail('Use the text request builder for this profile.', 400);
    if (!Array.isArray(messages) || !Number.isSafeInteger(maxTokens) || maxTokens < 1) fail('The generation input is invalid.', 400);
    const { profile, source, active, preset, proxy } = material;
    if (material.kind === 'active') {
        const model = modelOverride.trim() || profile.model;
        const settings = { ...active, openai_max_tokens: rawOptions.preserveReasoningBudget ? active.openai_max_tokens : maxTokens };
        if (Number.isFinite(rawOptions.temperature)) settings.temp_openai = rawOptions.temperature;
        const { generate_data: generated } = await generate(settings, model, 'quiet', messages);
        const payload = createChatRequestData({ ...generated, ...overridePayload,
            stream: false, messages, model, chat_completion_source: source, secret_id: profile['secret-id'], active_connection: true, ...proxy });
        const secretType = source === 'openai_responses' ? SECRET_KEYS.OPENAI
            : source === 'vertexai' && payload.vertexai_auth_mode === 'full' ? SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT : SECRET_KEYS[source.toUpperCase()];
        const hasKey = payload.secret_id && (source === 'custom'
            ? secretIdExists(directories, secretType, payload.secret_id) : Boolean(readSecret(directories, secretType, payload.secret_id)));
        if (!payload.reverse_proxy && (payload.secret_id || source !== 'custom') && !hasKey) {
            fail('Select a saved API key for the active connection.', 409);
        }
        const requestControls = { responseLength: maxTokens, preserveReasoningBudget: Boolean(rawOptions.preserveReasoningBudget) };
        return source === 'custom' ? { ...payload, request_controls: requestControls } : applyGenerationRequestControls(payload, requestControls);
    }
    const { overrides, profileFieldNames } = resolveProfileRequestOverrides(profile, overridePayload, preset);
    const payload = {
        stream: false, messages, max_tokens: maxTokens, model: modelOverride.trim() || profile.model,
        chat_completion_source: source, secret_id: profile['secret-id'], ...proxy,
        custom_prompt_post_processing: profile['prompt-post-processing'],
        service_tier: resolveProfileServiceTier(profile, source, preset), ...overrides, ...overridePayload,
        __connectionProfileRequestFields: profileFieldNames,
    };
    const urlField = { custom: 'custom_url', vertexai: 'vertexai_region', zai: 'zai_endpoint', siliconflow: 'siliconflow_endpoint', minimax: 'minimax_endpoint' }[source];
    if (urlField) payload[urlField] = profile['api-url'];
    const result = createChatRequestData(preset ? await buildChatPresetPayload(active, preset, undefined, payload, generate) : payload);
    delete result.__connectionProfileRequestFields;
    delete result.modelOverride;
    if (result.service_tier === '') delete result.service_tier;
    const secretType = source === 'openai_responses' ? SECRET_KEYS.OPENAI
        : source === 'vertexai' && result.vertexai_auth_mode === 'full' ? SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT : SECRET_KEYS[source.toUpperCase()];
    if (!result.reverse_proxy && (result.secret_id || source !== 'custom') && (!result.secret_id || !readSecret(directories, secretType, result.secret_id))) {
        fail('Select a saved API key in this connection profile.', 409);
    }
    return result;
}
