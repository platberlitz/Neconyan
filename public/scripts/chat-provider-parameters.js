import { applyClaudeModelParameterConstraints, applyKimiK3ModelParameterConstraints, filterChatCompletionSamplingParameters, isKimiK3Model } from './openai-model-capabilities.js';
import { LINKAPI_ENDPOINT, getLinkApiRequestFormat } from './linkapi-utils.js';

/** Build a request using explicit operation capabilities, without reading browser state. */
export async function createChatGenerationParameters(settings, model, type, messages, context, { jsonSchema = null, cacheScope = null } = {}) {
    if (!Array.isArray(messages)) throw new Error('messages must be an array');
    messages = context.appendReasoning(messages.filter(message => message && typeof message === 'object'));
    const source = settings.chat_completion_source;
    const gpt = ['openai', 'openai_responses', 'azure_openai', 'openrouter'].includes(source);
    const kimi = ['custom', 'moonshot', 'nanogpt', 'openrouter'].includes(source) && isKimiK3Model(model);
    const stream = settings.stream_openai && type !== 'quiet' && !(gpt && ['o1-2024-12-17', 'o1'].includes(model)) && !(source === 'workers_ai' && jsonSchema);
    const canMultiSwipe = settings.n > 1 && !['quiet', 'impersonate', 'continue'].includes(type)
        && ['openai', 'azure_openai', 'custom', 'xai', 'aimlapi', 'moonshot'].includes(source) && !kimi;
    let bias = {};
    if (settings.bias_preset_selected && ['openai', 'azure_openai', 'openrouter', 'electronhub', 'chutes', 'custom'].includes(source)
        && Array.isArray(settings.bias_presets[settings.bias_preset_selected]) && settings.bias_presets[settings.bias_preset_selected].length) bias = await context.getLogitBias();
    const data = {
        type, messages, model, log_prompts: Boolean(context.logPrompts),
        temperature: Number(settings.temp_openai), frequency_penalty: Number(settings.freq_pen_openai),
        presence_penalty: Number(settings.pres_pen_openai), top_p: Number(settings.top_p_openai), typical_p: Number(settings.typical_p_openai),
        max_tokens: settings.openai_max_tokens, stream, logit_bias: Object.keys(bias).length ? bias : undefined,
        stop: context.getStoppingStrings(4), chat_completion_source: source, n: canMultiSwipe ? settings.n : undefined,
        user_name: context.userName, char_name: context.characterName, group_names: context.getGroupNames(),
        include_reasoning: context.getIncludeReasoning(), reasoning_effort: context.getReasoningEffort(),
        enable_web_search: Boolean(settings.enable_web_search), request_images: Boolean(settings.request_images),
        request_image_resolution: String(settings.request_image_resolution), request_image_aspect_ratio: String(settings.request_image_aspect_ratio),
        custom_prompt_post_processing: settings.custom_prompt_post_processing, verbosity: context.getVerbosity(),
        cacheScope: cacheScope ?? (type === 'quiet' ? 'auxiliary' : 'main'),
    };
    if (source === 'azure_openai') {
        data.azure_base_url = settings.azure_base_url;
        data.azure_deployment_name = settings.azure_deployment_name;
        data.azure_api_version = settings.azure_api_version;
        if (/^gpt-[34]/.test(model)) delete data.reasoning_effort;
    }
    if (!canMultiSwipe && context.canPerformToolCalls()) await context.registerTools(data);
    if (!Array.isArray(data.stop) || !data.stop.length) delete data.stop;
    if (settings.reverse_proxy && context.reverseProxySources.includes(source)) {
        await context.validateReverseProxy();
        data.reverse_proxy = settings.reverse_proxy;
        data.proxy_password = settings.proxy_password;
    }
    if (context.requestTokenProbabilities && ['openai', 'azure_openai', 'custom', 'deepseek', 'xai', 'aimlapi', 'chutes'].includes(source)) data.logprobs = 5;
    if (gpt && ['gpt', 'vision'].every(value => typeof model === 'string' && model.includes(value))) {
        delete data.logit_bias;
        delete data.stop;
        delete data.logprobs;
    }
    if (gpt && /gpt-4.5/.test(model)) delete data.logprobs;
    applyChatProviderParameters(data, settings, {
        model, type, getStoppingStrings: context.getStoppingStrings, getAssistantPrefill: context.getAssistantPrefill,
        serviceTier: source === 'nanogpt' ? await context.getServiceTier() : undefined,
        samplerMetadata: context.getSamplerMetadata(),
    });
    if (jsonSchema) data.json_schema = jsonSchema;
    return { generate_data: data, stream, canMultiSwipe };
}

/** Provider-specific request fields, shared by browser and server request builders. */
export function applyChatProviderParameters(data, settings, {
    model, type, getStoppingStrings, getAssistantPrefill, serviceTier, samplerMetadata,
}) {
    const source = settings.chat_completion_source;
    const topK = settings.top_k_openai > 0 ? Number(settings.top_k_openai) : undefined;
    const anthropic = source === 'claude' || (source === 'linkapi' && getLinkApiRequestFormat(model) === 'anthropic');
    const google = ['makersuite', 'vertexai'].includes(source) || (source === 'linkapi' && getLinkApiRequestFormat(model) === 'google');
    if (anthropic) {
        data.top_k = topK;
        data.use_sysprompt = settings.use_sysprompt;
        data.stop = getStoppingStrings();
        if (type !== 'quiet' && !(type === 'continue' && settings.continue_prefill)) data.assistant_prefill = getAssistantPrefill();
        data.claude_disable_temperature = Boolean(settings.claude_disable_temperature);
        data.claude_disable_top_p = Boolean(settings.claude_disable_top_p);
    }
    if (google) {
        data.top_k = topK;
        data.use_sysprompt = settings.use_sysprompt;
        data.stop = getStoppingStrings(5).slice(0, 5).filter(value => value.length >= 1 && value.length <= 16);
        if (source === 'vertexai') {
            data.vertexai_auth_mode = settings.vertexai_auth_mode;
            data.vertexai_region = settings.vertexai_region;
            data.vertexai_express_project_id = settings.vertexai_express_project_id;
        }
    }
    if (source === 'openrouter') {
        Object.assign(data, {
            top_k: topK, min_p: Number(settings.min_p_openai), repetition_penalty: Number(settings.repetition_penalty_openai),
            top_a: Number(settings.top_a_openai), use_fallback: settings.openrouter_use_fallback,
            provider: settings.openrouter_providers, service_tier: settings.openrouter_service_tier || undefined,
            quantizations: settings.openrouter_quantizations, allow_fallbacks: settings.openrouter_allow_fallbacks,
            middleout: settings.openrouter_middleout,
        });
    }
    if (source === 'mistralai') {
        data.safe_prompt = false;
        data.stop = getStoppingStrings();
    }
    if (source === 'custom') {
        for (const key of ['custom_url', 'custom_include_body', 'custom_exclude_body', 'custom_include_headers',
            'custom_reasoning_param_name', 'custom_reasoning_param_format', 'custom_reasoning_enabled_value', 'custom_reasoning_disabled_value']) data[key] = settings[key];
    }
    if (source === 'cohere') {
        data.top_p = Math.min(Math.max(Number(settings.top_p_openai), 0.01), 0.99);
        data.top_k = topK;
        data.frequency_penalty = Math.min(Math.max(Number(settings.freq_pen_openai), 0), 1);
        data.presence_penalty = Math.min(Math.max(Number(settings.pres_pen_openai), 0), 1);
        data.stop = getStoppingStrings(5);
    }
    if (source === 'perplexity') {
        data.top_k = topK;
        data.frequency_penalty = Number(settings.freq_pen_openai);
        data.presence_penalty = Number(settings.pres_pen_openai);
        delete data.stop;
    }
    if (source === 'groq') {
        delete data.logprobs;
        delete data.logit_bias;
        delete data.top_logprobs;
        delete data.n;
    }
    if (source === 'deepseek') data.top_p = data.top_p || Number.EPSILON;
    if (source === 'xai') {
        if (!['grok-3-mini', 'grok-4.20-multi-agent'].some(value => model.includes(value))) delete data.reasoning_effort;
        if (model.includes('grok-3-mini') || model.includes('grok-4') || model.includes('grok-code')) {
            delete data.presence_penalty;
            delete data.frequency_penalty;
            if (model.includes('grok-3-mini') || !model.includes('grok-4-fast-non-reasoning')) delete data.stop;
        }
    }
    if (source === 'electronhub') data.top_k = topK;
    if (source === 'chutes') {
        data.min_p = Number(settings.min_p_openai);
        data.top_k = topK;
        data.repetition_penalty = Number(settings.repetition_penalty_openai);
        data.stop = getStoppingStrings();
    }
    if (source === 'zai') {
        data.top_p = data.top_p || 0.01;
        data.stop = getStoppingStrings(1);
        data.zai_endpoint = settings.zai_endpoint || 'common';
        delete data.presence_penalty;
        delete data.frequency_penalty;
    }
    if (source === 'siliconflow') data.siliconflow_endpoint = settings.siliconflow_endpoint || 'global';
    if (source === 'minimax') {
        data.minimax_endpoint = settings.minimax_endpoint || 'global';
        if (Number.isFinite(data.temperature)) data.temperature = Math.min(Math.max(data.temperature, Number.EPSILON), 1.0);
    }
    if (source === 'workers_ai') {
        data.workers_ai_account_id = settings.workers_ai_account_id;
        data.top_k = settings.top_k_openai > 0 ? Math.min(Number(settings.top_k_openai), 50) : undefined;
        data.repetition_penalty = Number(settings.repetition_penalty_openai);
        data.seed = settings.seed >= 1 ? Number(settings.seed) : undefined;
        data.top_p = Math.max(Number(settings.top_p_openai), 0.001);
        delete data.n;
        delete data.logit_bias;
    }
    if (source === 'nanogpt') {
        for (const key of ['nanogpt_provider', 'nanogpt_allowed_providers', 'nanogpt_ignored_providers', 'nanogpt_payg_override']) data[key] = settings[key];
        data.service_tier = serviceTier;
        data.top_k = topK;
        data.min_p = Number(settings.min_p_openai);
        data.repetition_penalty = Number(settings.repetition_penalty_openai);
        data.top_a = Number(settings.top_a_openai);
    }
    if (source === 'moonshot' && /kimi-k2.5/.test(model)) {
        delete data.temperature;
        delete data.top_p;
        delete data.frequency_penalty;
        delete data.presence_penalty;
    }
    if (source === 'linkapi') data.linkapi_endpoint = settings.linkapi_endpoint || LINKAPI_ENDPOINT.GLOBAL;
    if (['openai', 'openai_responses', 'azure_openai', 'openrouter', 'mistralai', 'custom', 'cohere', 'groq',
        'electronhub', 'nanogpt', 'xai', 'pollinations', 'aimlapi', 'vertexai', 'makersuite', 'chutes', 'linkapi'].includes(source) && settings.seed >= 0) data.seed = settings.seed;

    if ((['openai', 'openai_responses', 'azure_openai'].includes(source) && /^(o1|o3|o4)/.test(model))
        || (source === 'openrouter' && /^openai\/(o1|o3|o4)/.test(model))) {
        data.max_completion_tokens = data.max_tokens;
        for (const key of ['max_tokens', 'logprobs', 'top_logprobs', 'stop', 'logit_bias', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) delete data[key];
        if (/^(openai\/)?(o1)/.test(model)) {
            for (const message of data.messages) if (message.role === 'system') message.role = 'user';
            delete data.n;
            delete data.tools;
            delete data.tool_choice;
        }
    }
    if (['openai', 'openai_responses', 'azure_openai', 'openrouter'].includes(source) && /gpt-5/.test(model)) {
        data.max_completion_tokens = data.max_tokens;
        delete data.max_tokens;
        delete data.logprobs;
        delete data.top_logprobs;
        if (/gpt-5-chat-latest/.test(model)) {
            delete data.tools;
            delete data.tool_choice;
        } else {
            for (const key of ['frequency_penalty', 'presence_penalty', 'logit_bias', 'stop']) delete data[key];
            if (!/gpt-5\.\d/.test(model) || /chat-latest/.test(model)) {
                delete data.temperature;
                delete data.top_p;
            }
        }
    }
    applyClaudeModelParameterConstraints(data, { preserveReasoning: ['claude', 'linkapi'].includes(source) });
    if (['custom', 'moonshot', 'nanogpt', 'openrouter'].includes(source) && isKimiK3Model(model)) applyKimiK3ModelParameterConstraints(data);
    if (samplerMetadata) data.model_sampler_metadata = structuredClone(samplerMetadata);
    filterChatCompletionSamplingParameters(data, { source, model, metadata: samplerMetadata, stripMetadata: false });
    return data;
}
