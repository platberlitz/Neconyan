/** Explicit provider facts only. This module is shared by browser and native workers. */
const blockedReasons = new Set(['content_filter', 'content_policy_violation', 'refusal', 'SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'RECITATION', 'IMAGE_RECITATION']);
const errorReasons = new Set(['error', 'MALFORMED_FUNCTION_CALL', 'MALFORMED_RESPONSE', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS', 'MISSING_THOUGHT_SIGNATURE', 'PUP_LIMITED_DISABLED']);

export function classifyGenerationOutcome(data, choiceIndex = 0) {
    if (!data || typeof data !== 'object') return null;
    const choice = (Array.isArray(data.choices) ? data.choices : []).find((value, index) => value && (value.index ?? index) === choiceIndex);
    const candidate = (Array.isArray(data.candidates) ? data.candidates : []).find((value, index) => value && (value.index ?? index) === choiceIndex);
    const reasons = [choice?.finish_reason, candidate?.finishReason];
    if (choiceIndex === 0) reasons.push(data.stop_reason, data.delta?.stop_reason, data.promptFeedback?.blockReason,
        data.error?.code, data.error?.type, data.code, data.detail?.error?.code);
    const reason = reasons.find(value => blockedReasons.has(value));
    if (reason) return { version: 1, status: 'blocked', reason };
    const error = [choice?.finish_reason, candidate?.finishReason].find(value => errorReasons.has(value));
    return error ? { version: 1, status: 'error', reason: error } : null;
}

export function generationErrorEnvelope(data, eventType = '') {
    return Boolean(data && (eventType === 'error' || data.type === 'error' || data.error || data.quota_error
        || data.detail?.error || typeof data.message === 'string' && !data.choices && !data.candidates));
}

export function isBlockedGeneration(outcome) {
    return outcome?.version === 1 && outcome.status === 'blocked' && blockedReasons.has(outcome.reason);
}

export function messageGenerationBlocked(message) {
    return isBlockedGeneration(message?.extra?.generation_outcome);
}

export function applyGenerationOutcome(message, outcome) {
    if (!message) return;
    message.extra ??= {};
    if (isBlockedGeneration(outcome) || outcome?.version === 1 && outcome.status === 'error') message.extra.generation_outcome = { ...outcome };
    else delete message.extra.generation_outcome;
}

export function providerBlockedError(outcome) {
    const message = outcome?.status === 'error'
        ? 'The provider ended this reply with an error. Automatic agents were not run.'
        : 'The provider blocked this reply because of a content filter. Automatic agents were not run.';
    return Object.assign(new Error(message), { code: 'GENERATION_BLOCKED', status: 422, generationOutcome: outcome });
}

// Request identity covers refusal before any message exists; persisted metadata covers recovery.
const suppressedRequests = new Set();
const requestKey = context => context ? JSON.stringify([context.chatId, context.runId, context.cancelRevision]) : null;
export function suppressAutomaticGeneration(context) {
    const key = requestKey(context);
    if (!key) return;
    suppressedRequests.add(key);
    while (suppressedRequests.size > 128) suppressedRequests.delete(suppressedRequests.values().next().value);
}
export function automaticGenerationSuppressed(context) {
    return suppressedRequests.has(requestKey(context));
}

export function messageAutomaticGenerationSuppressed(message) {
    return messageGenerationBlocked(message) || message?.extra?.generation_outcome?.version === 1 && message.extra.generation_outcome.status === 'error';
}
