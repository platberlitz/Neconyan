import path from 'node:path';
import sanitize from 'sanitize-filename';
import { CHAT_COMPLETION_SOURCES } from '../constants.js';
import { readSecret, SECRET_KEYS } from '../endpoints/secrets.js';
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

function readTextProfile(directories, profile, settings, source) {
    if (!textSources.has(source)) fail('This text-completion provider is not supported.', 409);
    const saved = settings.textgenerationwebui_settings;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) fail('The saved Text Completion settings are missing.', 409);
    const preset = readPreset(directories.textGen_Settings, profileValue(profile, 'preset'), 'completion preset');
    const template = readPreset(directories.instruct, profileValue(profile, 'instruct'), 'instruct preset');
    const context = readPreset(directories.context, profileValue(profile, 'context'), 'context template') ?? settings.power_user?.context ?? {};
    const active = mergeTextPresetSettings(saved, preset, { api_type: source });
    active.api_server = profileValue(profile, 'api-url') || TEXT_PROVIDER_URLS[source];
    if (source === 'openrouter') active.openrouter_service_tier = resolveProfileServiceTier(profile, source, preset) ?? '';
    let url;
    try { url = new URL(active.api_server); } catch { fail('Save a server URL in this connection profile.', 409); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Use an HTTP server URL without embedded credentials.', 409);
    const power = structuredClone(settings.power_user || {});
    const instruct = structuredClone(template ?? power.instruct ?? {});
    const state = profileValue(profile, 'instruct-state');
    instruct.enabled = state === undefined ? Boolean(template || (profile.exclude?.includes('instruct') && instruct.enabled))
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
    if (!sources.has(source)) fail('This operation requires a Chat Completion connection profile.', 409);
    if (typeof profile.model !== 'string' || !profile.model.trim()) fail('Save a model in this connection profile.', 409);
    const active = settings.oai_settings;
    if (!active || typeof active !== 'object' || Array.isArray(active)) fail('The saved Chat Completion settings are missing.', 409);
    let preset;
    if (profile.preset) {
        if (typeof profile.preset !== 'string' || sanitize(profile.preset) !== profile.preset || !directories.openAI_Settings) fail('The profile has an invalid completion preset.', 409);
        preset = readJson(path.join(directories.openAI_Settings, profile.preset + '.json'), null);
        if (!preset || typeof preset !== 'object' || Array.isArray(preset)) fail('The profile’s completion preset no longer exists.', 409);
    }
    const proxy = resolveProfileProxy(profile, source, settings.proxies || [], active);
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

/** Persist only this binding. Changed saved controls require an explicit new acceptance. */
export function captureChatProfile(directories, profileId) {
    const { profile, fingerprint, backend } = readProfile(directories, profileId);
    return { profileId: profile.id, fingerprint, ...(backend === 'text' ? { backend } : {}) };
}

/** Read current controls only when they still match the accepted reference. */
export function resolveGenerationProfile(directories, binding) {
    const material = readProfile(directories, binding?.profileId);
    if (!binding?.fingerprint || material.fingerprint !== binding.fingerprint) fail('The saved connection settings changed after this operation was accepted. Retry with the current settings.', 409);
    return material;
}

/**
 * The completion preset's context window for a saved binding, or null when the
 * preset does not declare one. Used to size assistant knowledge; never falls
 * back to the active browser profile.
 */
export function getChatProfileContextLimit(directories, binding) {
    const { preset, contextLimit } = resolveGenerationProfile(directories, binding);
    if (contextLimit) return contextLimit;
    for (const key of ['openai_max_context', 'max_context']) {
        const value = Number(preset?.[key]);
        if (Number.isFinite(value) && value > 0) return Math.floor(value);
    }
    return null;
}

/** Resolve controls through the same preset/profile builders used by the browser. */
export async function buildChatProfileRequest(directories, binding, messages, maxTokens, generate, { modelOverride = '', overridePayload = {} } = {}) {
    const material = resolveGenerationProfile(directories, binding);
    if (material.backend === 'text') fail('Use the text request builder for this profile.', 400);
    if (!Array.isArray(messages) || !Number.isSafeInteger(maxTokens) || maxTokens < 1) fail('The generation input is invalid.', 400);
    const { profile, source, active, preset, proxy } = material;
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
