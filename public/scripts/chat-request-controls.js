export const REVERSE_PROXY_SUPPORTED_SOURCES = ['claude', 'openai', 'openai_responses', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai', 'zai', 'moonshot'];

const REASONING_CONTROL_VALUES = ['none', 'min', 'low', 'medium', 'high', 'xhigh', 'max'];

function reasoningComparisonValue(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    const canonical = trimmed.toLowerCase();
    if (canonical === 'minimal') return 'min';
    return REASONING_CONTROL_VALUES.includes(canonical) || canonical === 'auto' ? canonical : trimmed;
}

/** Read only an exact native NanoGPT declaration, without changing saved preferences. */
export function getNanoGptReasoningCapabilities({ source, model, metadata } = {}) {
    const unknown = { known: false, declaredEfforts: [], supportedEfforts: [] };
    if (source !== 'nanogpt' || typeof model !== 'string' || !model || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || metadata.source !== source || metadata.model !== model) return unknown;
    const declaration = metadata.reasoning_efforts;
    if (!Array.isArray(declaration) || declaration.some(value => typeof value !== 'string')) return unknown;
    const declaredEfforts = [...new Set(declaration.map(reasoningComparisonValue).filter(value => value && value !== 'auto'))];
    const supportedEfforts = REASONING_CONTROL_VALUES.filter(value => declaredEfforts.includes(value));
    // Auto is omission, not an eighth control. Future-only declarations cannot
    // establish availability for any of the seven controls this client knows.
    return supportedEfforts.length ? { known: true, declaredEfforts, supportedEfforts } : unknown;
}

/** Unknown support and legacy omission remain compatible; explicit None is checked. */
export function checkNanoGptReasoningEffort({ effort, ...identity } = {}) {
    const capabilities = getNanoGptReasoningCapabilities(identity);
    const value = reasoningComparisonValue(effort);
    const omitted = effort == null || (typeof effort === 'string' && (!value || value === 'auto'));
    return { ...capabilities, supported: !capabilities.known || omitted || (typeof effort === 'string' && capabilities.declaredEfforts.includes(value)) };
}

export function resolveChatReasoningEffort(settings, model, modelList) {
    const source = settings.chat_completion_source;
    let effort = settings.reasoning_effort;
    if (!['openai', 'openai_responses', 'azure_openai', 'custom', 'xai', 'aimlapi', 'openrouter', 'pollinations', 'perplexity', 'cometapi', 'electronhub', 'chutes'].includes(source)) return effort;
    if (effort === 'none' && !(['openai', 'openai_responses', 'azure_openai', 'custom'].includes(source) && /^gpt-5\.([1-9]|\d{2,})/.test(model))) effort = undefined;
    if (effort === 'min') effort = 'minimal';
    if (source === 'electronhub' && Array.isArray(modelList) && effort) {
        const supported = modelList.find(item => item.id === model)?.metadata?.supported_reasoning_efforts;
        if (!Array.isArray(supported) || !supported.includes(effort)) return undefined;
    }
    return effort;
}

export function resolveCustomStoppingStrings(settings, substitute, ephemeral = [], limit) {
    let permanent = [];
    try {
        const parsed = settings.custom_stopping_strings ? JSON.parse(settings.custom_stopping_strings) : [];
        if (Array.isArray(parsed)) {
            permanent = parsed.filter(value => typeof value === 'string' && value.length > 0);
        }
    } catch (error) {
        console.warn('Error parsing custom stopping strings:', error);
        permanent = [];
    }
    if (settings.custom_stopping_strings_macro) permanent = permanent.map(substitute);
    const strings = [...permanent, ...ephemeral];
    return limit > 0 ? strings.slice(0, limit) : strings;
}
