// Provider declarations describe exact source/model pairs, not model families.
export const REASONING_CONTROL_VALUES = Object.freeze(['none', 'min', 'low', 'medium', 'high', 'xhigh', 'max']);

// Exact native IDs only. Contracts reviewed 1 November 2026:
// https://developers.openai.com/api/docs/guides/reasoning
// https://ai.google.dev/gemini-api/docs/generate-content/thinking
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking
// https://api-docs.deepseek.com/api/create-chat-completion/
// https://platform.kimi.ai/docs/guide/kimi-k3-quickstart
// https://docs.z.ai/guides/overview/concept-param
// https://platform.minimax.io/docs/api-reference/text-openai-api
// https://docs.mistral.ai/studio/conversations/reasoning
// https://console.groq.com/docs/reasoning
// https://docs.aimlapi.com/api-references/text-models-llm/openai/gpt-oss-20b
// https://docs.aimlapi.com/api-references/text-models-llm/openai/gpt-oss-120b
// https://docs.fireworks.ai/api-reference/post-chatcompletions#body-reasoning-effort
const OPENAI_EFFORTS = Object.freeze({
    'gpt-5': ['min', 'low', 'medium', 'high'], 'gpt-5-2025-08-07': ['min', 'low', 'medium', 'high'],
    'gpt-5.1': ['none', 'low', 'medium', 'high'], 'gpt-5.1-2025-11-13': ['none', 'low', 'medium', 'high'],
    'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'], 'gpt-5.2-2025-12-11': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'], 'gpt-5.5-2026-04-23': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
});
const NATIVE_EFFORTS = Object.freeze({
    openai: OPENAI_EFFORTS,
    openai_responses: OPENAI_EFFORTS,
    makersuite: {
        'gemini-3.8-flash': ['low', 'medium', 'high'], 'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
        'gemini-3.6-flash': ['min', 'low', 'medium', 'high'], 'gemini-3.5-flash-lite': ['min', 'low', 'medium', 'high'],
        'gemini-3.1-flash-lite': ['min', 'low', 'medium', 'high'], 'gemini-3-flash-preview': ['min', 'low', 'medium', 'high'],
    },
    vertexai: { 'gemini-3.1-pro-preview': ['low', 'medium', 'high'], 'gemini-3-flash-preview': ['min', 'low', 'medium', 'high'] },
    deepseek: { 'deepseek-v4-pro': ['none', 'low', 'high', 'max'] },
    moonshot: { 'kimi-k3': ['low', 'high', 'max'] },
    zai: { 'glm-5.3': ['low', 'high', 'max'], 'glm-5.3-flash': ['low', 'high', 'max'] },
    minimax: { 'MiniMax-M3.1-Flash': ['low', 'medium', 'high', 'xhigh', 'max'] },
    mistralai: { 'mistral-small-2603': ['none', 'high'], 'mistral-medium-3-5': ['none', 'high'],
        'mistral-large-4-0': ['low', 'medium', 'high'], 'zai-glm-5-3': ['low', 'high', 'max'] },
    groq: { 'openai/gpt-oss-20b': ['low', 'medium', 'high'], 'openai/gpt-oss-120b': ['low', 'medium', 'high'],
        'qwen/qwen3.8-27b': ['none', 'low', 'medium', 'high', 'default'], 'meta-models/muse-spark-open': ['low', 'medium', 'high', 'xhigh'] },
    aimlapi: { 'openai/gpt-oss-20b': ['low', 'medium', 'high'], 'openai/gpt-oss-120b': ['low', 'medium', 'high'] },
    fireworks: { 'accounts/fireworks/models/gpt-oss-20b': ['low', 'medium', 'high'],
        'accounts/fireworks/models/gpt-oss-120b': ['low', 'medium', 'high'] },
});

// The Google serializer and fallback eligibility share this exact image protocol boundary.
export const GOOGLE_IMAGE_GENERATION_MODELS = Object.freeze([
    'gemini-2.0-flash-exp', 'gemini-2.0-flash-exp-image-generation', 'gemini-2.0-flash-preview-image-generation',
    'gemini-2.5-flash-image-preview', 'gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview',
]);

export function hasNativeReasoningFallback({ source, model, route } = {}) {
    const rules = Object.hasOwn(NATIVE_EFFORTS, source) ? NATIVE_EFFORTS[source] : null;
    if (!rules || typeof model !== 'string' || !model.trim() || Object.hasOwn(rules, model)
        || !route || typeof route !== 'object' || typeof route.reverseProxy !== 'string' || route.reverseProxy
        || (source === 'makersuite' && route.googleApiVersion !== 'v1beta')
        || (source === 'vertexai' && !['express', 'full'].includes(route.vertexAuthMode))
        || (source === 'zai' && route.zaiEndpoint !== 'common')
        || (source === 'minimax' && route.minimaxEndpoint !== 'global')) return false;
    if (['makersuite', 'vertexai'].includes(source)
        && (GOOGLE_IMAGE_GENERATION_MODELS.includes(model) || /^gemini-2\.5-(flash|pro)/.test(model))) return false;
    return true;
}

/** Build a route description from the effective request, never from a URL's name. */
export function getNativeReasoningRoute(settings = {}, { googleApiVersion } = {}) {
    const source = settings.chat_completion_source;
    const proxySources = ['openai', 'openai_responses', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'moonshot', 'zai'];
    return {
        reverseProxy: proxySources.includes(source) ? settings.reverse_proxy || '' : '',
        googleApiVersion,
        vertexAuthMode: settings.vertexai_auth_mode || 'express',
        zaiEndpoint: settings.zai_endpoint || 'common',
        minimaxEndpoint: settings.minimax_endpoint || 'global',
    };
}

function comparisonValue(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    const canonical = trimmed.toLowerCase();
    if (canonical === 'minimal') return 'min';
    return REASONING_CONTROL_VALUES.includes(canonical) || canonical === 'auto' ? canonical : trimmed;
}

function matchingMetadata(source, model, metadata) {
    return typeof model === 'string' && Boolean(model) && metadata && typeof metadata === 'object'
        && !Array.isArray(metadata) && metadata.source === source && metadata.model === model;
}

/** The original Nano contract is kept for existing callers and persisted profiles. */
export function getNanoGptReasoningCapabilities({ source, model, metadata } = {}) {
    const unknown = { known: false, declaredEfforts: [], supportedEfforts: [] };
    if (source !== 'nanogpt' || !matchingMetadata(source, model, metadata)) return unknown;
    const declaration = metadata.reasoning_efforts;
    if (!Array.isArray(declaration) || declaration.some(value => typeof value !== 'string')) return unknown;
    const declaredEfforts = [...new Set(declaration.map(comparisonValue).filter(value => value && value !== 'auto'))];
    const supportedEfforts = REASONING_CONTROL_VALUES.filter(value => declaredEfforts.includes(value));
    return supportedEfforts.length ? { known: true, declaredEfforts, supportedEfforts } : unknown;
}

export function checkNanoGptReasoningEffort({ effort, ...identity } = {}) {
    const capabilities = getNanoGptReasoningCapabilities(identity);
    const value = comparisonValue(effort);
    const omitted = effort == null || (typeof effort === 'string' && (!value || value === 'auto'));
    return { ...capabilities, supported: !capabilities.known || omitted || (typeof effort === 'string' && capabilities.declaredEfforts.includes(value)) };
}

/** Read only the documented OpenRouter catalogue declaration for this exact model.
 * https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#discovering-per-model-reasoning-options
 * Reviewed 1 November 2026.
 */
export function getChatReasoningCapabilities({ source, model, metadata, route } = {}) {
    const unknown = { state: 'unknown', declaredEfforts: [], supportedEfforts: [], forbiddenEfforts: [], reason: 'no-matching-declaration', provenance: null, nativeFallback: hasNativeReasoningFallback({ source, model, route }) };
    if (source === 'nanogpt') {
        const nano = getNanoGptReasoningCapabilities({ source, model, metadata });
        return { ...unknown, ...nano, state: nano.known ? 'effort-list' : 'unknown',
            reason: nano.known ? 'declared-efforts' : 'no-matching-declaration', provenance: nano.known ? 'nanogpt-catalogue' : null };
    }
    if (source !== 'openrouter') {
        const rules = Object.hasOwn(NATIVE_EFFORTS, source) ? NATIVE_EFFORTS[source] : null;
        if (!rules || typeof model !== 'string' || !Object.hasOwn(rules, model) || !route || typeof route !== 'object'
            || route.reverseProxy || (source === 'makersuite' && route.googleApiVersion !== 'v1beta')
            || (source === 'vertexai' && !['express', 'full'].includes(route.vertexAuthMode))
            || (source === 'zai' && route.zaiEndpoint !== 'common')
            || (source === 'minimax' && route.minimaxEndpoint !== 'global')) return unknown;
        const declaredEfforts = [...rules[model]];
        return { ...unknown, state: 'effort-list', declaredEfforts,
            supportedEfforts: REASONING_CONTROL_VALUES.filter(value => declaredEfforts.includes(value)),
            reason: 'documented-native-efforts', provenance: `${source}-documentation` };
    }
    if (!matchingMetadata(source, model, metadata)) return unknown;
    const reasoning = metadata.reasoning;
    if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)
        || (Object.hasOwn(reasoning, 'mandatory') && typeof reasoning.mandatory !== 'boolean')) return { ...unknown, reason: 'missing-or-malformed-reasoning' };
    const forbiddenEfforts = reasoning.mandatory === true ? ['none'] : [];
    const result = { ...unknown, forbiddenEfforts, reason: 'unknown-efforts', provenance: 'openrouter-catalogue' };
    if (!Object.hasOwn(reasoning, 'supported_efforts')) return { ...result, state: 'no-selector', reason: 'selector-not-exposed' };
    const declaration = reasoning.supported_efforts;
    if (declaration === null) {
        const supportedEfforts = REASONING_CONTROL_VALUES.filter(value => !forbiddenEfforts.includes(value));
        return { ...result, state: 'effort-list', declaredEfforts: supportedEfforts, supportedEfforts, reason: 'all-gateway-efforts' };
    }
    if (!Array.isArray(declaration) || !declaration.length || declaration.some(value => typeof value !== 'string')) return result;
    const declaredEfforts = [...new Set(declaration.map(comparisonValue)
        .filter(value => value && value !== 'auto' && !forbiddenEfforts.includes(value)))];
    const supportedEfforts = REASONING_CONTROL_VALUES.filter(value => declaredEfforts.includes(value));
    return supportedEfforts.length ? { ...result, state: 'effort-list', declaredEfforts, supportedEfforts, reason: 'declared-efforts' } : result;
}

export function checkChatReasoningEffort({ effort, ...identity } = {}) {
    const capabilities = getChatReasoningCapabilities(identity);
    const value = comparisonValue(effort);
    const omitted = effort == null || (typeof effort === 'string' && (!value || value === 'auto'));
    const forbidden = capabilities.forbiddenEfforts.includes(value);
    const supported = omitted || (!forbidden && capabilities.state !== 'no-selector'
        && (capabilities.state !== 'effort-list' || (typeof effort === 'string' && capabilities.declaredEfforts.includes(value))));
    return { ...capabilities, known: capabilities.state !== 'unknown', supported, omitted, forbidden };
}
