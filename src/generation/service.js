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
import { providerStep, readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { buildChatProfileRequest, resolveGenerationProfile } from './profiles.js';
import { buildTextProfileRequest } from './text-request.js';
import { prepareActiveRegex, applyActiveRegex } from './active-regex.js';
import { cleanGeneratedText, cleanScopedTextResponse, createRawPrompt, extractMessageFromData, extractJsonFromData, normalizeContentText, removePartialStops } from '../../public/scripts/generation-format.js';
import { createChatGenerationParameters } from '../../public/scripts/chat-provider-parameters.js';
import { REVERSE_PROXY_SUPPORTED_SOURCES, resolveChatReasoningEffort, resolveCustomStoppingStrings } from '../../public/scripts/chat-request-controls.js';
import { buildChatCompletionSamplerMetadata } from '../../public/scripts/openai-model-capabilities.js';
import { getNanoGptServiceTiers, isNanoGptPayg } from '../../public/scripts/service-tiers.js';
import { createMacroEnvironment } from '../macros/index.js';
import { runLegacyProfile } from './legacy-request.js';

/**
 * Run one provider request on behalf of a job. This is the same
 * server transport the Conversation API uses. Callers supply an already-built
 * request; saved chat profiles use runChatProfile below.
 */
export async function runTextGeneration({ context, backend, payload, signal, anonymousCustom = false, boundProfile = false, fetch: fetchImpl } = {}) {
    if (!context?.directories) throw Object.assign(new Error('A generation context is required.'), { status: 400, code: 'GENERATION_CONTEXT_MISSING' });
    if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
        throw Object.assign(new Error('A generation payload is required.'), { status: 400, code: 'GENERATION_PAYLOAD_MISSING' });
    }
    const resolvedBackend = normalizeGenerationBackend(backend);
    const request = {
        user: { profile: { handle: context.owner }, directories: context.directories },
        headers: {},
    };
    const response = await runBackendGeneration(request, resolvedBackend, payload, { signal, fetch: fetchImpl, anonymousCustom, boundProfile });
    const text = resolvedBackend === 'text'
        ? normalizeContentText(typeof response === 'string' ? response : response?.choices?.[0]?.text ?? response?.choices?.[0]?.message?.content ?? response?.content ?? response?.response ?? response?.[0]?.content ?? '', { excludeReasoning: true })
        : extractMessageFromData(response, 'openai', { excludeReasoning: true })
            || normalizeContentText(response?.content ?? response?.response, { excludeReasoning: true });
    return { response, text };
}

export { buildGenerationRequestBody, extractGeneratedText, normalizeGenerationBackend };

/** Check browser-only requirements before accepting input or uploading its files. */
export async function validateActiveGenerationContext(material, macroEnvironment, messages = [], rawOptions = {}, { maxTokens = 1, groupNames = [], ephemeralStops = [] } = {}) {
    if (material.kind !== 'active') return;
    const isolated = macroEnvironment?.fork ? macroEnvironment.fork() : createMacroEnvironment(macroEnvironment || {});
    isolated.extra.powerUser = { ...material.power, instruct: material.instruct || material.power.instruct || {},
        context: material.context || material.power.context || {}, sysprompt: material.power.sysprompt || {} };
    Object.assign(isolated.extra, {
        mainApi: material.backend === 'text' ? 'textgenerationwebui' : 'openai',
        getMaxResponseTokens: () => maxTokens,
        getMaxContextTokens: () => material.contextLimit || material.active.openai_max_context,
        getMaxPromptTokens: () => (material.contextLimit || material.active.openai_max_context) - maxTokens,
    });
    if (material.backend === 'text') {
        await buildTextProfileRequest({}, material, structuredClone(messages), maxTokens, { macroEnvironment: isolated, rawOptions, groupNames, ephemeralStops,
            userName: isolated.names.user, characterName: isolated.names.char, validateOnly: true, captureCleanupStops: () => {} });
    } else {
        const substitute = value => isolated.evaluate(value, { legacy: !material.power.experimental_macro_engine, strictCapabilities: true });
        const prompt = createRawPrompt(structuredClone(messages), 'openai', rawOptions.instructOverride, rawOptions.quietToLoud,
            rawOptions.systemPrompt, rawOptions.prefill, { instruct: material.power.instruct, context: material.power.context,
                name1: isolated.names.user, name2: isolated.names.char, selectedGroup: groupNames.length > 0, substitute });
        const settings = { ...material.active, openai_max_tokens: rawOptions.preserveReasoningBudget ? material.active.openai_max_tokens : maxTokens };
        if (Number.isFinite(rawOptions.temperature)) settings.temp_openai = rawOptions.temperature;
        // Exercise the shared formatter's actual stop passes without catalogue or tokeniser requests.
        await createChatGenerationParameters(settings, material.profile.model, 'quiet', prompt, {
            appendReasoning: value => value, userName: isolated.names.user, characterName: isolated.names.char,
            getGroupNames: () => groupNames, getLogitBias: () => ({}),
            getStoppingStrings: limit => resolveCustomStoppingStrings(material.power, substitute, ephemeralStops, limit),
            getIncludeReasoning: () => Boolean(settings.show_thoughts || settings.auto_append_reasoning_tags),
            getReasoningEffort: () => resolveChatReasoningEffort(settings, material.profile.model),
            getVerbosity: () => settings.verbosity === 'auto' ? undefined : settings.verbosity,
            canPerformToolCalls: () => false, registerTools: async () => {},
            reverseProxySources: REVERSE_PROXY_SUPPORTED_SOURCES, validateReverseProxy: () => {},
            getAssistantPrefill: () => '', getServiceTier: () => settings.nanogpt_service_tier,
            getSamplerMetadata: () => settings.model_sampler_metadata,
        }, { jsonSchema: rawOptions.jsonSchema, cacheScope: rawOptions.cacheScope });
        resolveCustomStoppingStrings(material.power, substitute, ephemeralStops);
    }
    if (!rawOptions.jsonSchema) prepareActiveRegex(material, macroEnvironment);
}

/** Execute a bound Chat Completion profile without browser globals or credential persistence. */
export async function runChatProfile({ context, binding, messages, maxTokens, macroEnvironment,
    ephemeralStops = [], userName = 'User', characterName = 'Character', groupNames = [],
    signal, fetch: fetchImpl, jobContext, modelOverride = '', overridePayload = {}, rawOptions = {}, beforeDispatch, stream = false,
} = {}) {
    if (!context?.directories) fail('A generation context is required.', 400);
    signal ||= jobContext?.signal;
    signal?.throwIfAborted();
    const raw = binding?.kind === 'active';
    if (['kobold', 'novel', 'horde'].includes(binding?.backend)) return runLegacyProfile({ context, binding, messages, maxTokens, macroEnvironment,
        ephemeralStops, userName, characterName, groupNames, signal, fetch: fetchImpl, jobContext,
        modelOverride, overridePayload, rawOptions, beforeDispatch, stream });
    if (!raw && Object.keys(rawOptions).some(option => !['jsonSchema', 'cacheScope'].includes(option))) {
        fail('This request option requires the acknowledged active connection.', 409);
    }
    if (!raw && binding?.backend === 'text' && Object.keys(rawOptions).length) {
        fail('Structured request controls require a Chat Completion connection.', 409);
    }
    if (binding?.backend === 'text' || raw) {
        const options = { context, binding, macroEnvironment, ephemeralStops, userName, characterName, groupNames, signal, fetch: fetchImpl, modelOverride, overridePayload, rawOptions, maxTokens };
        const key = hash({ binding, messages, maxTokens, ephemeralStops, userName, characterName, groupNames, modelOverride, overridePayload,
            ...(stream ? { stream: true } : {}), ...(raw ? { rawOptions } : {}) });
        if (jobContext) {
            const retained = readArtifact(context.directories, jobContext.job.id, 'provider:' + key);
            if (retained !== undefined) return retained;
        }
        const material = resolveGenerationProfile(context.directories, binding);
        if (macroEnvironment) {
            macroEnvironment.names = { ...macroEnvironment.names, user: userName, char: characterName,
                group: macroEnvironment.names?.group ?? (groupNames.join(', ') || characterName),
                groupNotMuted: macroEnvironment.names?.groupNotMuted ?? (groupNames.join(', ') || characterName),
                notChar: macroEnvironment.names?.notChar ?? [...groupNames.filter(name => name !== characterName), userName].join(', ') };
            macroEnvironment.system = { ...macroEnvironment.system, model: modelOverride || material.profile.model };
            Object.assign(macroEnvironment.extra ??= {}, { mainApi: binding.backend === 'text' ? 'textgenerationwebui' : 'openai',
                getMaxResponseTokens: () => maxTokens,
                getMaxContextTokens: () => material.contextLimit || material.active.openai_max_context,
                getMaxPromptTokens: () => (material.contextLimit || material.active.openai_max_context) - maxTokens });
        }
        if (raw) await validateActiveGenerationContext(material, macroEnvironment, messages, rawOptions, { maxTokens, groupNames, ephemeralStops });
        if (raw) {
            const allowed = ['instructOverride', 'quietToLoud', 'systemPrompt', 'prefill', 'trimNames', 'temperature', 'jsonSchema', 'cacheScope', 'preserveReasoningBudget'];
            if (Object.keys(rawOptions).some(key => !allowed.includes(key))) fail('This raw generation option cannot run on the server.', 409);
            if (['proxy_password', 'custom_include_headers', 'custom_include_body'].some(key => Object.hasOwn(overridePayload, key))) {
                fail('Save authentication overrides in the active connection before generating a reply.', 409);
            }
            if (rawOptions.jsonSchema && material.source === 'perplexity' && material.power.reasoning?.auto_parse) {
                fail('Automatic reasoning parsing for structured Perplexity replies is not available on the server.', 409);
            }
        }
        const preparedName = (raw ? 'active-request:' : 'text-request:') + key;
        const prepared = jobContext && readArtifact(context.directories, jobContext.job.id, preparedName);
        let payload = raw ? prepared?.payload : prepared;
        let cleanupStops = prepared?.cleanupStops;
        let regexScripts = prepared?.regexScripts;
        if (!payload) {
            if (raw) regexScripts = rawOptions.jsonSchema ? [] : prepareActiveRegex(material, macroEnvironment);
            if (binding.backend === 'text') payload = await buildTextProfileRequest(context, material, messages, maxTokens, {
                ...options, captureCleanupStops: stops => { cleanupStops = stops; },
            });
            else {
                const substitute = value => {
                    if (macroEnvironment?.evaluate) return macroEnvironment.evaluate(value, { legacy: !material.power.experimental_macro_engine, strictCapabilities: true });
                    if (String(value).includes('{{')) fail('This connection requires the captured chat macro context.', 400);
                    return value;
                };
                if (macroEnvironment?.extra) macroEnvironment.extra.powerUser = { ...structuredClone(material.power),
                    instruct: structuredClone(material.power.instruct ?? {}), context: structuredClone(material.power.context ?? {}),
                    sysprompt: structuredClone(material.power.sysprompt ?? {}) };
                const prompt = createRawPrompt(structuredClone(messages), 'openai', rawOptions.instructOverride, rawOptions.quietToLoud,
                    rawOptions.systemPrompt, rawOptions.prefill, { instruct: material.power.instruct, context: material.power.context,
                        name1: userName, name2: characterName, selectedGroup: groupNames.length > 0, substitute });
                payload = await prepareChatRequest({ ...options, messages: prompt }, material);
                cleanupStops = resolveCustomStoppingStrings(material.power, substitute, ephemeralStops).filter(Boolean);
            }
            payload.stream = stream === true;
            if (jobContext) {
                const savedPayload = { ...payload, proxy_password: undefined, custom_include_headers: undefined, custom_include_body: undefined };
                writeArtifact(context.directories, jobContext.job.id, preparedName, raw ? { payload: savedPayload, cleanupStops, regexScripts } : savedPayload);
            }
        }
        payload.stream = stream === true;
        const current = resolveGenerationProfile(context.directories, binding);
        const call = async () => {
            beforeDispatch?.();
            const requestPayload = raw && binding.backend === 'chat' ? { ...payload, proxy_password: current.proxy.proxy_password,
                custom_include_headers: current.active.custom_include_headers, custom_include_body: current.active.custom_include_body } : payload;
            const result = await runTextGeneration({ context, backend: binding.backend, payload: requestPayload, signal, fetch: fetchImpl,
                anonymousCustom: binding.backend === 'text' ? !material.secretId : payload.chat_completion_source === 'custom' && !payload.secret_id && !payload.reverse_proxy, boundProfile: true });
            if (raw && rawOptions.jsonSchema) return { ...result, text: extractJsonFromData(result.response, {
                mainApi: 'openai', chatCompletionSource: material.source, returnInvalidJson: rawOptions.jsonSchema.returnInvalid,
            }) };
            const rawText = raw ? extractMessageFromData(result.response, binding.backend === 'text' ? 'textgenerationwebui' : 'openai') : result.text;
            const text = raw ? cleanGeneratedText(applyActiveRegex(removePartialStops(rawText, cleanupStops), regexScripts), {
                power: material.power, mainApi: binding.backend === 'text' ? 'textgenerationwebui' : 'openai',
                name1: userName, name2: characterName, groupNames, trimNames: rawOptions.trimNames !== false,
                trimWrongNames: rawOptions.trimNames !== false, displayIncompleteSentences: true,
            }) : cleanScopedTextResponse(result.text, payload.stopping_strings, material.instruct.enabled ? material.instruct : undefined);
            if (raw && !text) fail('No message generated.', 502);
            return { ...result, text, generation: { backend: binding.backend || 'chat', source: material.source,
                showThoughts: Boolean(material.active.show_thoughts || material.active.auto_append_reasoning_tags) } };
        };
        return jobContext ? providerStep(jobContext, key, call) : call();
    }
    const payload = await prepareChatRequest({ context, binding, messages, maxTokens, macroEnvironment, ephemeralStops,
        userName, characterName, groupNames, signal, fetch: fetchImpl, modelOverride, overridePayload, rawOptions });
    payload.stream = stream === true;
    const material = resolveGenerationProfile(context.directories, binding);
    const call = () => {
        beforeDispatch?.();
        return runTextGeneration({ context, backend: 'chat', payload, signal, fetch: fetchImpl,
            anonymousCustom: payload.chat_completion_source === 'custom' && !payload.secret_id && !payload.reverse_proxy })
            .then(result => ({ ...result, text: cleanGeneratedText(removePartialStops(result.text,
                Array.isArray(payload.stop) ? payload.stop : []), { power: material.power,
                mainApi: 'openai', name1: userName, name2: characterName, groupNames, displayIncompleteSentences: true }),
            generation: { backend: 'chat', source: material.source,
                showThoughts: Boolean(material.active.show_thoughts || material.active.auto_append_reasoning_tags) } }));
    };
    return jobContext ? providerStep(jobContext, hash({ binding, payload: { ...payload, proxy_password: undefined } }), call) : call();
}

async function prepareChatRequest({ context, binding, messages, maxTokens, macroEnvironment, ephemeralStops,
    userName, characterName, groupNames, signal, fetch: fetchImpl, modelOverride, overridePayload, rawOptions = {} }, material) {
    const saved = readJson(path.join(context.directories.root, 'settings.json'), {});
    const power = material?.power || saved.power_user || {};
    if (power.custom_stopping_strings_macro && !macroEnvironment?.evaluate) fail('This profile requires the captured chat macro context.', 400);
    const request = { user: { profile: { handle: context.owner }, directories: context.directories }, headers: {} };
    const catalogs = new Map();
    const getCatalog = async (source) => {
        if (catalogs.has(source)) return catalogs.get(source);
        const profile = material?.profile || saved.extension_settings?.connectionManager?.profiles?.find(item => item.id === binding.profileId);
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
            getStoppingStrings: limit => resolveCustomStoppingStrings(power, text => macroEnvironment.evaluate(text, { legacy: material?.kind === 'active' && !power.experimental_macro_engine, strictCapabilities: material?.kind === 'active' }), ephemeralStops, limit),
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
        }, { jsonSchema: rawOptions.jsonSchema, cacheScope: rawOptions.cacheScope });
    };
    const payload = await buildChatProfileRequest(context.directories, binding, structuredClone(messages), maxTokens, generate, { modelOverride, overridePayload, rawOptions });
    if (payload.chat_completion_source === 'nanogpt' && ['flex', 'priority'].includes(payload.service_tier)) {
        payload.service_tier = serviceTier({ ...payload, nanogpt_service_tier: payload.service_tier }, payload.model, await getCatalog('nanogpt'));
    }
    return payload;
}
