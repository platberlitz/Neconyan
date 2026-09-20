export const REVERSE_PROXY_SUPPORTED_SOURCES = ['claude', 'openai', 'openai_responses', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai', 'zai', 'moonshot'];

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
