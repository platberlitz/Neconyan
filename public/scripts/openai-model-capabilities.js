import { getLinkApiRequestFormat } from './linkapi-utils.js';

/**
 * The sampler names understood by the Chat Completions bridge. Keep this list
 * deliberately small: provider catalogues contain many unrelated request
 * fields and those must never become UI controls by accident.
 */
export const CHAT_COMPLETION_SAMPLER_KEYS = Object.freeze([
    'temperature',
    'top_p',
    'frequency_penalty',
    'presence_penalty',
    'top_k',
    'min_p',
    'top_a',
    'typical_p',
    'repetition_penalty',
    'seed',
]);

const SAMPLER_KEY_SET = new Set(CHAT_COMPLETION_SAMPLER_KEYS);

const SOURCE_DEFAULTS = Object.freeze({
    openai: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'],
    azure_openai: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'],
    openai_responses: ['temperature', 'top_p'],
    claude: ['temperature', 'top_p', 'top_k'],
    makersuite: ['temperature', 'top_p', 'top_k', 'seed'],
    vertexai: ['temperature', 'top_p', 'top_k', 'seed'],
    ai21: ['temperature', 'top_p'],
    minimax: ['temperature', 'top_p'],
    zai: ['temperature', 'top_p'],
    mistralai: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'],
    openrouter: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'],
    custom: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'],
    cohere: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'top_k', 'seed'],
    perplexity: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'top_k'],
    groq: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'],
    xai: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'],
    aimlapi: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'],
    pollinations: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'],
    electronhub: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'top_k', 'seed'],
    chutes: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'top_k', 'min_p', 'repetition_penalty', 'seed'],
    nanogpt: ['temperature', 'top_p'],
    deepseek: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'],
    siliconflow: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'],
    fireworks: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'],
    moonshot: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'],
    workers_ai: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'top_k', 'repetition_penalty', 'seed'],
    cometapi: [],
});

const BASE_RANGES = Object.freeze({
    temperature: Object.freeze({ min: 0, max: 2, step: 0.01 }),
    top_p: Object.freeze({ min: 0, max: 1, step: 0.01 }),
    frequency_penalty: Object.freeze({ min: -2, max: 2, step: 0.01 }),
    presence_penalty: Object.freeze({ min: -2, max: 2, step: 0.01 }),
    top_k: Object.freeze({ min: 0, max: 500, step: 1 }),
    min_p: Object.freeze({ min: 0, max: 1, step: 0.001 }),
    top_a: Object.freeze({ min: 0, max: 1, step: 0.001 }),
    typical_p: Object.freeze({ min: 0, max: 1, step: 0.001 }),
    repetition_penalty: Object.freeze({ min: 1, max: 2, step: 0.01 }),
    seed: Object.freeze({ min: -1, max: 2147483647, step: 1 }),
});

const METADATA_WIDENABLE_KEYS = Object.freeze({
    openrouter: new Set(['top_k', 'min_p', 'top_a', 'repetition_penalty']),
    custom: new Set(['top_k', 'min_p', 'top_a', 'typical_p', 'repetition_penalty']),
    nanogpt: new Set(CHAT_COMPLETION_SAMPLER_KEYS),
    linkapi: new Set(['top_k', 'min_p', 'top_a', 'typical_p', 'repetition_penalty']),
});

const NANO_OPEN_WEIGHT_KEYS = Object.freeze([
    'temperature',
    'top_p',
    'frequency_penalty',
    'presence_penalty',
    'top_k',
    'min_p',
    'top_a',
    'typical_p',
    'repetition_penalty',
]);

function normalizedSource(source) {
    return String(source ?? '').trim().toLowerCase();
}

function normalizedModel(model) {
    return String(model ?? '').trim();
}

function uniqueKnownKeys(keys) {
    return [...new Set(keys)].filter(key => SAMPLER_KEY_SET.has(key));
}

/**
 * Return a conservative representation of a model catalogue record.
 * The fingerprint is source/model-bound so a response from a previous
 * provider cannot silently widen another provider's controls.
 */
export function buildChatCompletionSamplerMetadata(source, model, record = {}) {
    const metadata = {
        source: String(source ?? ''),
        model: String(model ?? ''),
    };

    if (Object.hasOwn(record ?? {}, 'supported_parameters')) {
        metadata.supported_parameters = Array.isArray(record.supported_parameters)
            ? [...record.supported_parameters] : record.supported_parameters;
    }

    if (Object.hasOwn(record ?? {}, 'open_weights')) {
        metadata.open_weights = record.open_weights;
    }

    return metadata;
}

function readMatchingMetadata(source, model, metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return { state: 'missing' };
    }

    // Exact string equality is intentional. A stale fingerprint is safer than
    // guessing that a provider-normalized model id is the same model.
    if (metadata.source !== source || metadata.model !== model) {
        return { state: 'stale' };
    }

    const hasSupportedParameters = Object.hasOwn(metadata, 'supported_parameters');
    if (hasSupportedParameters && !Array.isArray(metadata.supported_parameters)) {
        return { state: 'malformed' };
    }

    if (hasSupportedParameters && metadata.supported_parameters.some(parameter => typeof parameter !== 'string')) {
        return { state: 'malformed' };
    }

    if (Object.hasOwn(metadata, 'open_weights') && typeof metadata.open_weights !== 'boolean') {
        return { state: 'malformed' };
    }

    return {
        state: 'valid',
        hasSupportedParameters,
        supportedParameters: hasSupportedParameters ? uniqueKnownKeys(metadata.supported_parameters) : null,
        openWeights: metadata.open_weights,
    };
}

function nanoGptFamilySamplers(model) {
    if (/(?:^|[/:])(?:gpt-(?!oss(?:[-./:]|$))|chatgpt-|o[134](?:[-./:]|$))/i.test(model)) {
        return ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'];
    }
    if (/(?:^|[/:])(?:claude|gemini)(?:[-./:]|$)/i.test(model)) {
        return ['temperature', 'top_p', 'top_k'];
    }
    if (/(?:^|[/:])(?:grok|kimi)(?:[-./:]|$)/i.test(model)) {
        return ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'];
    }
    if (/(?:^|[/:])glm(?:[-./:]|$)/i.test(model)) return ['temperature', 'top_p'];
    return null;
}

function isCanonicalNanoOpenWeightModel(model) {
    const id = normalizedModel(model).toLowerCase();
    // NanoGPT exposes these OpenAI ids directly and through its TEE aliases.
    return /(?:^|\/)openai\/gpt-oss-(?:20b|120b)(?:$|[-_:]tee$)/i.test(id);
}

function modelRestrictedKeys(source, model, format) {
    const normalized = normalizedModel(model).toLowerCase();
    const restrictions = new Set();

    if (/(?:^|[/:])claude-(?:fable|opus-5|sonnet-5)(?:[-./:]|$)/.test(normalized)) {
        CHAT_COMPLETION_SAMPLER_KEYS.forEach(key => restrictions.add(key));
    }

    if (/(?:^|[/:])kimi-k3(?:[-./:]|$)/.test(normalized)
        || (source === 'moonshot' && /(?:^|[/:])kimi-k2\.5(?:[-./:]|$)/.test(normalized))) {
        for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) {
            restrictions.add(key);
        }
    }

    if (/grok-(?:3-mini|4|code)(?:[-./:]|$)/.test(normalized)) {
        restrictions.add('frequency_penalty');
        restrictions.add('presence_penalty');
    }

    if (/^(?:openai\/)?(?:o1|o3|o4)(?:[-./:]|$)/.test(normalized) || /^(?:openai\/)?gpt-6-astra$/.test(normalized)) {
        for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'top_k', 'min_p', 'top_a', 'typical_p', 'repetition_penalty']) {
            restrictions.add(key);
        }
    }

    if (/^(?:openai\/)?gpt-5\.\d/.test(normalized) && !normalized.includes('chat-latest')) {
        for (const key of ['frequency_penalty', 'presence_penalty', 'top_k', 'min_p', 'top_a', 'typical_p', 'repetition_penalty']) {
            restrictions.add(key);
        }
    } else if (/^(?:openai\/)?gpt-5(?:[-./:]|$)/.test(normalized) && !normalized.includes('chat-latest')) {
        for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'top_k', 'min_p', 'top_a', 'typical_p', 'repetition_penalty']) {
            restrictions.add(key);
        }
    }

    if ((['makersuite', 'vertexai'].includes(source) || (source === 'linkapi' && format === 'google'))
        && /(?:^|[/:])gemini-3\.[67]-flash(?:[-./:]|$)|(?:^|[/:])gemini-3\.5-flash-lite(?:[-./:]|$)/.test(normalized)) {
        for (const key of ['temperature', 'top_p', 'top_k']) {
            restrictions.add(key);
        }
    }

    return restrictions;
}

function linkApiDefaults(model) {
    switch (getLinkApiRequestFormat(model)) {
        case 'anthropic': return ['temperature', 'top_p', 'top_k'];
        case 'google': return ['temperature', 'top_p', 'top_k', 'seed'];
        default: return ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'];
    }
}

/**
 * Resolve one capability result for both the UI and request filtering.
 * @param {{source?: string, model?: string, metadata?: object}} options
 */
export function getChatCompletionSamplerCapabilities({ source = '', model = '', metadata = null } = {}) {
    const sourceId = normalizedSource(source);
    const modelId = normalizedModel(model);
    const format = sourceId === 'linkapi' ? getLinkApiRequestFormat(modelId) : null;
    let supported = sourceId === 'linkapi' ? linkApiDefaults(modelId) : (SOURCE_DEFAULTS[sourceId] ?? ['temperature', 'top_p']);
    const matchingMetadata = readMatchingMetadata(source, model, metadata);
    const nanoFamily = sourceId === 'nanogpt' ? nanoGptFamilySamplers(modelId) : null;
    if (sourceId === 'nanogpt') {
        supported = nanoFamily ?? (isCanonicalNanoOpenWeightModel(modelId)
            || (matchingMetadata.state === 'valid' && matchingMetadata.openWeights === true)
            ? NANO_OPEN_WEIGHT_KEYS : SOURCE_DEFAULTS.nanogpt);
    }

    if (matchingMetadata.state === 'valid') {
        if (matchingMetadata.hasSupportedParameters) {
            const reported = new Set(matchingMetadata.supportedParameters);
            const widenable = sourceId === 'linkapi' && format !== 'openai'
                ? new Set()
                : (METADATA_WIDENABLE_KEYS[sourceId] ?? new Set());
            supported = supported.filter(key => reported.has(key));
            for (const key of matchingMetadata.supportedParameters) {
                if (widenable.has(key) && !supported.includes(key)) {
                    supported.push(key);
                }
            }
        }
    } else if (matchingMetadata.state === 'malformed') {
        supported = [];
    }

    // A broad transport must not turn known proprietary NanoGPT models into
    // open-weight models, even if a catalogue record is wrong.
    if (nanoFamily) {
        supported = supported.filter(key => nanoFamily.includes(key) || key === 'seed');
    }

    const restricted = modelRestrictedKeys(sourceId, modelId, format);
    supported = uniqueKnownKeys(supported).filter(key => !restricted.has(key));

    const ranges = Object.fromEntries(supported.map(key => [key, { ...BASE_RANGES[key] }]));
    if (sourceId === 'cohere') {
        if (ranges.top_p) ranges.top_p = { min: 0.01, max: 0.99, step: 0.01 };
        for (const key of ['frequency_penalty', 'presence_penalty']) {
            if (ranges[key]) ranges[key] = { min: 0, max: 1, step: 0.01 };
        }
    }
    if (sourceId === 'workers_ai') {
        if (ranges.top_k) ranges.top_k = { min: 0, max: 50, step: 1 };
        if (ranges.top_p) ranges.top_p = { min: 0.001, max: 1, step: 0.001 };
    }
    if (ranges.temperature && ['claude', 'cohere', 'minimax', 'moonshot', 'zai'].includes(sourceId)) {
        ranges.temperature = { ...ranges.temperature, max: 1 };
    }
    if (ranges.temperature && sourceId === 'mistralai') {
        ranges.temperature = { ...ranges.temperature, max: 1.5 };
    }
    if (ranges.temperature && sourceId === 'linkapi' && format !== 'openai') {
        ranges.temperature = { ...ranges.temperature, max: 1 };
    }
    if (ranges.temperature && ['makersuite', 'vertexai'].includes(sourceId)
        && /(?:vision|ultra|gemma)/.test(modelId.toLowerCase())) {
        ranges.temperature = { ...ranges.temperature, max: 1 };
    }

    return {
        source: sourceId,
        model: modelId,
        format,
        supported: Object.freeze(supported),
        supportedParameters: Object.freeze(new Set(supported)),
        ranges: Object.freeze(ranges),
        metadataState: matchingMetadata.state,
        metadata: matchingMetadata.state === 'valid' ? {
            source: metadata.source,
            model: metadata.model,
            ...(matchingMetadata.hasSupportedParameters ? { supported_parameters: [...matchingMetadata.supportedParameters] } : {}),
            ...(matchingMetadata.openWeights !== undefined ? { open_weights: matchingMetadata.openWeights } : {}),
        } : null,
    };
}

/**
 * Filter a request in place after provider-specific fields have been assembled.
 * Values are clamped on the outbound copy; saved UI settings are untouched.
 */
export function filterChatCompletionSamplingParameters(requestBody, { source, model, metadata = requestBody?.model_sampler_metadata, stripMetadata = true } = {}) {
    if (!requestBody || typeof requestBody !== 'object') {
        return requestBody;
    }

    const sourceId = source ?? requestBody.chat_completion_source;
    const modelId = model ?? requestBody.model;
    const capabilities = getChatCompletionSamplerCapabilities({ source: sourceId, model: modelId, metadata });

    for (const key of CHAT_COMPLETION_SAMPLER_KEYS) {
        if (!capabilities.supportedParameters.has(key)) {
            delete requestBody[key];
            continue;
        }

        const rawValue = requestBody[key];
        const value = Number(rawValue);
        if (!Object.hasOwn(requestBody, key) || rawValue === null || rawValue === '' || typeof rawValue === 'boolean' || !Number.isFinite(value)) {
            delete requestBody[key];
            continue;
        }

        const range = capabilities.ranges[key];
        if (range) {
            requestBody[key] = Math.min(range.max, Math.max(range.min, value));
        }
    }

    // Never let internal catalogue state reach an upstream provider.
    if (stripMetadata) {
        delete requestBody.model_sampler_metadata;
    }
    return requestBody;
}

/**
 * Removes request parameters that are unsupported by the selected Claude model.
 *
 * @param {Record<string, any>} generateData Chat Completion request data
 * @param {object} [options] Constraint options
 * @param {boolean} [options.preserveReasoning=false] Keep reasoning fields for native Claude handlers
 * @returns {Record<string, any>} The request data
 */
export function applyClaudeModelParameterConstraints(generateData, { preserveReasoning = false } = {}) {
    const model = String(generateData?.model ?? '').trim().toLowerCase();
    const hasRestrictedSampling = /(?:^|[/:])claude-(?:fable|opus-5|sonnet-5)(?:[-./:]|$)/.test(model);

    if (!hasRestrictedSampling) {
        return generateData;
    }

    for (const key of CHAT_COMPLETION_SAMPLER_KEYS) {
        delete generateData[key];
    }
    if (!preserveReasoning) {
        delete generateData.reasoning_effort;
        delete generateData.custom_reasoning_param_name;
    }

    return generateData;
}

/**
 * Removes penalty samplers that Grok reasoning models reject.
 *
 * @param {Record<string, any>} generateData Chat Completion request data
 * @returns {Record<string, any>} The request data
 */
export function applyGrokModelParameterConstraints(generateData) {
    const model = String(generateData?.model ?? '').toLowerCase();

    if (!/grok-(?:3-mini|4|code)(?:[-./:]|$)/.test(model)) {
        return generateData;
    }

    delete generateData.frequency_penalty;
    delete generateData.presence_penalty;

    return generateData;
}

/**
 * Checks whether a Z.AI model accepts the top-level `reasoning_effort` parameter.
 *
 * @param {unknown} model Model identifier
 * @returns {boolean} Whether the model accepts a reasoning effort
 */
export function zaiSupportsReasoningEffort(model) {
    const normalizedModel = String(model ?? '').trim().toLowerCase();
    const version = normalizedModel.match(/(?:^|[/:])glm-(\d+)(?:\.(\d+))?/);

    if (!version) {
        return false;
    }

    const major = Number(version[1]);
    const minor = Number(version[2] ?? 0);

    return major > 5 || (major === 5 && minor >= 2);
}

/**
 * Checks whether a model ID targets Kimi K3, including provider-prefixed IDs.
 *
 * @param {unknown} model Model identifier
 * @returns {boolean} Whether the model is Kimi K3
 */
export function isKimiK3Model(model) {
    const normalizedModel = String(model ?? '').trim().toLowerCase();
    return /(?:^|[/:])kimi-k3(?:[-/:]|$)/.test(normalizedModel);
}

/**
 * Removes request parameters fixed by the Kimi K3 API.
 *
 * @param {Record<string, any>} generateData Chat Completion request data
 * @returns {Record<string, any>} The request data
 */
export function applyKimiK3ModelParameterConstraints(generateData) {
    if (!isKimiK3Model(generateData?.model)) {
        return generateData;
    }

    delete generateData.temperature;
    delete generateData.top_p;
    delete generateData.frequency_penalty;
    delete generateData.presence_penalty;
    delete generateData.n;
    delete generateData.thinking;

    return generateData;
}
