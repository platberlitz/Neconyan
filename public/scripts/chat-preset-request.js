import { settingsToUpdate } from './chat-preset-mapping.js';
import { migrateNanoGptProviderSettings } from './openai-preset-utils.js';

export function coerceRequestBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalised = value.trim().toLowerCase();
        if (['true', 'on', '1'].includes(normalised)) return true;
        if (['false', 'off', '0'].includes(normalised)) return false;
    }
    return Boolean(value);
}

export function normalizeChatCompletionBooleanFields(payload) {
    if (!payload || typeof payload !== 'object') return;
    for (const field of ['include_reasoning', 'enable_web_search', 'request_images']) {
        if (payload[field] !== undefined) payload[field] = coerceRequestBoolean(payload[field]);
    }
}

export function createChatRequestData({ stream = false, ...custom }) {
    const payload = { stream, use_sysprompt: true, ...custom };
    normalizeChatCompletionBooleanFields(payload);
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    return payload;
}

/** Resolve request-local settings without changing the host's active connection. */
export async function buildChatPresetPayload(activeSettings, preset, overridePreset, overridePayload, generate) {
    if (!preset || typeof preset !== 'object') throw new Error('Invalid preset: must be an object');
    preset = { ...preset };
    migrateNanoGptProviderSettings(preset);
    overridePreset = { ...overridePreset };
    migrateNanoGptProviderSettings(overridePreset, { partial: true });
    preset = { ...preset, ...overridePreset };
    overridePayload = { ...overridePayload };
    migrateNanoGptProviderSettings(overridePayload, { partial: true });
    preset.bias_preset_selected = preset.bias_presets !== undefined ? preset.bias_preset_selected : undefined;
    const settings = structuredClone(activeSettings);
    settings.nanogpt_service_tier = preset.nanogpt_service_tier ?? '';
    settings.openrouter_service_tier = preset.openrouter_service_tier ?? '';
    for (const [key, value] of Object.entries(preset)) {
        const mapping = settingsToUpdate[key];
        if (mapping) settings[mapping[1]] = value;
    }
    const sourceToUrlField = {
        custom: 'custom_url', vertexai: 'vertexai_region', zai: 'zai_endpoint',
        siliconflow: 'siliconflow_endpoint', minimax: 'minimax_endpoint', linkapi: 'linkapi_endpoint',
    };
    if (overridePayload.chat_completion_source) {
        const field = sourceToUrlField[overridePayload.chat_completion_source];
        if (field && !overridePayload[field]) overridePayload[field] = overridePayload[field] || settings[field] || activeSettings[field];
    } else {
        for (const field of ['custom_url', 'vertexai_region', 'zai_endpoint', 'siliconflow_endpoint', 'linkapi_endpoint']) {
            overridePayload[field] = overridePayload[field] || settings[field] || activeSettings[field];
        }
    }
    if (overridePayload.chat_completion_source) settings.chat_completion_source = overridePayload.chat_completion_source;
    if (overridePayload.model) settings.openai_model = overridePayload.model;
    const outputLimit = overridePayload.max_completion_tokens ?? overridePayload.max_tokens;
    if (outputLimit !== undefined) settings.openai_max_tokens = outputLimit;
    if (Number.isFinite(overridePayload.temperature)) settings.temp_openai = overridePayload.temperature;
    if (overridePayload.service_tier !== undefined && ['nanogpt', 'openrouter'].includes(settings.chat_completion_source)) {
        settings[`${settings.chat_completion_source}_service_tier`] = overridePayload.service_tier;
    }
    for (const field of ['nanogpt_provider', 'nanogpt_allowed_providers', 'nanogpt_ignored_providers', 'nanogpt_payg_override']) {
        if (Object.hasOwn(overridePayload, field)) settings[field] = overridePayload[field];
    }
    for (const field of [
        'reverse_proxy', 'proxy_password', 'custom_url', 'vertexai_region', 'zai_endpoint', 'siliconflow_endpoint',
        'minimax_endpoint', 'linkapi_endpoint', 'custom_include_body', 'custom_exclude_body', 'custom_include_headers',
        'reasoning_effort', 'verbosity', 'request_image_resolution', 'request_image_aspect_ratio',
        'custom_reasoning_param_name', 'custom_reasoning_param_format', 'custom_reasoning_enabled_value', 'custom_reasoning_disabled_value',
    ]) {
        if (overridePayload[field] !== undefined) settings[field] = overridePayload[field];
    }
    normalizeChatCompletionBooleanFields(overridePayload);
    if (overridePayload.include_reasoning !== undefined) {
        settings.show_thoughts = overridePayload.include_reasoning;
        if (!settings.show_thoughts) settings.auto_append_reasoning_tags = false;
    }
    for (const field of ['enable_web_search', 'request_images']) {
        if (overridePayload[field] !== undefined) settings[field] = overridePayload[field];
    }
    const { generate_data: payload } = await generate(settings, overridePayload.model, 'quiet', overridePayload.messages);
    const profileFields = Array.isArray(overridePayload.__connectionProfileRequestFields) ? overridePayload.__connectionProfileRequestFields : [];
    for (const field of ['include_reasoning', 'reasoning_effort', 'verbosity', 'service_tier']) {
        if (profileFields.includes(field)) overridePayload[field] = payload[field];
    }
    delete overridePayload.__connectionProfileRequestFields;
    delete overridePayload.modelOverride;
    if (outputLimit !== undefined) {
        delete overridePayload.max_tokens;
        delete overridePayload.max_completion_tokens;
    }
    if (Number.isFinite(overridePayload.temperature)) delete overridePayload.temperature;
    return { ...payload, ...overridePayload };
}
