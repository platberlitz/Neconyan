import { classifyGenerationOutcome } from '../../public/scripts/generation-outcome.js';
import { extractProviderReasoning, normalizeContentText } from '../../public/scripts/generation-format.js';

/** Split only an enabled, configured leading thinking block. Keep the provider response as evidence. */
export function separateConfiguredReasoning(result, settings, source) {
    if (!settings?.auto_parse || typeof settings.prefix !== 'string' || !settings.prefix
        || typeof settings.suffix !== 'string' || !settings.suffix || typeof result?.text !== 'string'
        || classifyGenerationOutcome(result.response)) return result;
    const content = result.text.trimStart();
    if (!content.startsWith(settings.prefix)) return result;
    const end = content.indexOf(settings.suffix, settings.prefix.length);
    const thinking = content.slice(settings.prefix.length, end < 0 ? undefined : end);
    const existing = result.reasoning ?? extractProviderReasoning(result.response, { mainApi: 'openai', chatCompletionSource: source });
    return { ...result, text: end < 0 ? '' : content.slice(end + settings.suffix.length),
        reasoning: [existing, thinking].filter(Boolean).join('\n\n') };
}

/** A completed paid response can contain thinking without a usable answer. */
export function reasoningOnlyResult(result) {
    if (typeof result?.text !== 'string' || result.text.trim() || classifyGenerationOutcome(result.response)) return null;
    const response = result.response;
    const choice = (Array.isArray(response?.choices) ? response.choices : []).find((value, index) => value && (value.index ?? index) === 0);
    const candidate = (Array.isArray(response?.candidates) ? response.candidates : []).find((value, index) => value && (value.index ?? index) === 0);
    if (response?.choices?.length && !choice || response?.candidates?.length && !candidate) return null;
    const selected = { ...response, ...(choice ? { choices: [choice] } : {}), ...(candidate ? { candidates: [candidate] } : {}) };
    const message = choice?.message;
    if (message?.tool_calls?.length || response?.content?.some?.(part => part.type === 'tool_use')
        || response?.output?.some?.(part => part.type === 'function_call')
        || candidate?.content?.parts?.some(part => part.functionCall)) return null;
    const reasoning = normalizeContentText(result.reasoning ?? message?.reasoning_content ?? message?.reasoning ?? message?.thinking
        ?? extractProviderReasoning(selected, { mainApi: 'openai', chatCompletionSource: result.generation?.source }));
    if (!reasoning.trim()) return null;
    const finishReason = choice?.finish_reason ?? candidate?.finishReason ?? response?.stop_reason;
    const limited = finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'MAX_TOKENS';
    return { reasoning, extra: {
        generation_outcome: { version: 1, status: 'error', reason: limited ? 'reasoning_only_length' : 'reasoning_only' },
        ...(finishReason != null ? { generation_finish_reason: finishReason } : {}),
        ...(response?.usage && typeof response.usage === 'object' && !Array.isArray(response.usage) ? { generation_usage: response.usage } : {}),
    }, message: limited
        ? 'The provider reached its output limit after returning thinking but no reply text. Automatic agents were not run.'
        : 'The provider returned thinking but no reply text. Automatic agents were not run.' };
}
