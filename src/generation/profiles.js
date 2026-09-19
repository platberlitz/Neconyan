import path from 'node:path';
import sanitize from 'sanitize-filename';
import { CHAT_COMPLETION_SOURCES } from '../constants.js';
import { readSecret, SECRET_KEYS } from '../endpoints/secrets.js';
import { fail, hash } from '../mewmory/core.js';
import { readJson } from '../mewmory/store.js';
import { buildChatPresetPayload, createChatRequestData } from '../../public/scripts/chat-preset-request.js';
import { resolveProfileProxy, resolveProfileRequestOverrides, resolveProfileServiceTier } from '../../public/scripts/connection-profile-request.js';

const sources = new Set(Object.values(CHAT_COMPLETION_SOURCES));
const aliases = { oai: 'openai', google: 'makersuite' };

function readProfile(directories, profileId) {
    if (typeof profileId !== 'string' || !profileId || profileId.length > 256) fail('Choose a saved connection profile.', 400);
    const settings = readJson(path.join(directories.root, 'settings.json'), {});
    if (settings.extension_settings?.disabledExtensions?.includes('connection-manager')) fail('Connection Manager is disabled.', 409);
    const profile = settings.extension_settings?.connectionManager?.profiles?.find(item => item.id === profileId);
    if (!profile) fail('The saved connection profile no longer exists.', 409);
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
    const { fingerprint } = readProfile(directories, profileId);
    return { profileId, fingerprint };
}

/** Resolve controls through the same preset/profile builders used by the browser. */
export async function buildChatProfileRequest(directories, binding, messages, maxTokens, generate, { modelOverride = '', overridePayload = {} } = {}) {
    const material = readProfile(directories, binding?.profileId);
    if (!binding?.fingerprint || material.fingerprint !== binding.fingerprint) fail('The saved connection settings changed after this operation was accepted. Retry with the current settings.', 409);
    if (!Array.isArray(messages) || !Number.isSafeInteger(maxTokens) || maxTokens < 1) fail('The generation input is invalid.', 400);
    const { profile, source, active, preset, proxy } = material;
    const { overrides, profileFieldNames } = resolveProfileRequestOverrides(profile, overridePayload, preset);
    const payload = {
        stream: false, messages, max_tokens: maxTokens, model: modelOverride.trim() || profile.model,
        chat_completion_source: source, secret_id: profile['secret-id'], ...proxy,
        custom_prompt_post_processing: profile['post-processing'],
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
