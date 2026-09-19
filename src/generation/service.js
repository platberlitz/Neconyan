import path from 'node:path';
import {
    buildGenerationRequestBody,
    extractGeneratedText,
    normalizeGenerationBackend,
    runBackendGeneration,
    runBackendRequest,
} from '../endpoints/conversation-generation.js';
import { handleChatCompletionsBias, handleChatCompletionsStatus } from '../endpoints/backends/chat-completions.js';
import { readJson } from '../mewmory/store.js';
import { fail, hash } from '../mewmory/core.js';
import { providerStep } from '../jobs/artifacts.js';
import { buildChatProfileRequest, captureChatProfile } from './profiles.js';
import { createChatGenerationParameters } from '../../public/scripts/chat-provider-parameters.js';
import { REVERSE_PROXY_SUPPORTED_SOURCES, resolveChatReasoningEffort, resolveCustomStoppingStrings } from '../../public/scripts/chat-request-controls.js';
import { buildChatCompletionSamplerMetadata } from '../../public/scripts/openai-model-capabilities.js';
import { getNanoGptServiceTiers, isNanoGptPayg } from '../../public/scripts/service-tiers.js';

/**
 * Run one non-streaming provider request on behalf of a job. This is the same
 * server transport the Conversation API uses. Callers supply an already-built
 * request; saved chat profiles use runChatProfile below.
 */
export async function runTextGeneration({ context, backend, payload, signal, anonymousCustom = false, fetch: fetchImpl } = {}) {
    if (!context?.directories) throw Object.assign(new Error('A generation context is required.'), { status: 400, code: 'GENERATION_CONTEXT_MISSING' });
    if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
        throw Object.assign(new Error('A generation payload is required.'), { status: 400, code: 'GENERATION_PAYLOAD_MISSING' });
    }
    const resolvedBackend = normalizeGenerationBackend(backend);
    const request = {
        user: { profile: { handle: context.owner }, directories: context.directories },
        headers: {},
    };
    const response = await runBackendGeneration(request, resolvedBackend, payload, { signal, fetch: fetchImpl, anonymousCustom });
    return { response, text: extractGeneratedText(response) };
}

export { buildGenerationRequestBody, extractGeneratedText, normalizeGenerationBackend };

/** Execute a bound Chat Completion profile without browser globals or credential persistence. */
export async function runChatProfile({ context, binding, messages, maxTokens, macroEnvironment,
    ephemeralStops = [], userName = 'User', characterName = 'Character', groupNames = [],
    signal, fetch: fetchImpl, jobContext, modelOverride = '', overridePayload = {},
} = {}) {
    if (!context?.directories) fail('A generation context is required.', 400);
    signal ||= jobContext?.signal;
    signal?.throwIfAborted();
    const saved = readJson(path.join(context.directories.root, 'settings.json'), {});
    const power = saved.power_user || {};
    if (power.custom_stopping_strings_macro && !macroEnvironment?.evaluate) fail('This profile requires the captured chat macro context.', 400);
    const request = { user: { profile: { handle: context.owner }, directories: context.directories }, headers: {} };
    const catalogs = new Map();
    const getCatalog = async (source) => {
        if (catalogs.has(source)) return catalogs.get(source);
        const profile = saved.extension_settings?.connectionManager?.profiles?.find(item => item.id === binding.profileId);
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(() => controller.abort(), 10000);
        timeout.unref();
        let status;
        try {
            if (signal?.aborted) abort();
            status = await runBackendRequest(request, handleChatCompletionsStatus, {
                chat_completion_source: source, secret_id: profile?.['secret-id'],
            }, { signal: controller.signal, fetch: fetchImpl });
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
        }
        if (!Array.isArray(status?.data)) fail('The profile’s model catalogue is unavailable.', 502);
        catalogs.set(source, status.data);
        return status.data;
    };
    const serviceTier = (settings, model, catalog) => {
        const tier = settings.nanogpt_service_tier;
        if (!tier || !['flex', 'priority'].includes(tier)) return tier || undefined;
        const record = catalog?.find(item => item.id === model);
        if (!record) fail('The selected model is absent from the profile’s model catalogue.', 409);
        if (!isNanoGptPayg(record, settings)) return undefined;
        if (!getNanoGptServiceTiers(record, settings).includes(tier)) fail('The selected model does not support this service tier.', 409);
        return tier;
    };
    const generate = async (settings, model, type, input) => {
        const source = settings.chat_completion_source;
        const needsCatalog = source === 'electronhub' || (source === 'nanogpt' && ['flex', 'priority'].includes(settings.nanogpt_service_tier));
        const catalog = needsCatalog ? await getCatalog(source) : undefined;
        const record = catalog?.find(item => item.id === model);
        const metadata = settings.model_sampler_metadata || (record ? buildChatCompletionSamplerMetadata(source, model, record) : undefined);
        return createChatGenerationParameters(settings, model, type, input, {
            appendReasoning: value => value, // Quiet requests never append the main-chat reasoning instruction.
            logPrompts: power.console_log_prompts, requestTokenProbabilities: power.request_token_probabilities,
            userName, characterName, getGroupNames: () => groupNames,
            getLogitBias: () => runBackendRequest({ ...request, query: { model } }, handleChatCompletionsBias,
                settings.bias_presets[settings.bias_preset_selected], { signal }),
            getStoppingStrings: limit => resolveCustomStoppingStrings(power, text => macroEnvironment.evaluate(text), ephemeralStops, limit),
            getIncludeReasoning: () => Boolean(settings.show_thoughts || settings.auto_append_reasoning_tags),
            getReasoningEffort: () => resolveChatReasoningEffort(settings, model, catalog),
            getVerbosity: () => settings.verbosity === 'auto' ? undefined : settings.verbosity,
            canPerformToolCalls: () => false, registerTools: async () => {},
            reverseProxySources: REVERSE_PROXY_SUPPORTED_SOURCES,
            validateReverseProxy: () => {
                let url;
                try { url = new URL(settings.reverse_proxy); } catch { fail('The profile proxy URL is invalid.', 400); }
                if (!['http:', 'https:'].includes(url.protocol)) fail('The profile proxy URL is invalid.', 400);
            },
            getAssistantPrefill: () => '', // Quiet requests do not send assistant prefill.
            getServiceTier: () => serviceTier(settings, model, catalog),
            getSamplerMetadata: () => metadata,
        });
    };
    const payload = await buildChatProfileRequest(context.directories, binding, structuredClone(messages), maxTokens, generate, { modelOverride, overridePayload });
    if (payload.chat_completion_source === 'nanogpt' && ['flex', 'priority'].includes(payload.service_tier)) {
        payload.service_tier = serviceTier({ ...payload, nanogpt_service_tier: payload.service_tier }, payload.model, await getCatalog('nanogpt'));
    }
    if (captureChatProfile(context.directories, binding.profileId).fingerprint !== binding.fingerprint) fail('The saved connection settings changed while preparing this request.', 409);
    const call = () => runTextGeneration({ context, backend: 'chat', payload, signal, fetch: fetchImpl,
        anonymousCustom: payload.chat_completion_source === 'custom' && !payload.secret_id && !payload.reverse_proxy });
    return jobContext ? providerStep(jobContext, hash({ binding, payload: { ...payload, proxy_password: undefined } }), call) : call();
}
