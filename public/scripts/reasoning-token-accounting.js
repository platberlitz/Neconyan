export function getPositiveTokenCount(value) {
    const tokenCount = Number(value);
    return Number.isFinite(tokenCount) && tokenCount > 0 ? tokenCount : 0;
}

export function formatTokenCounterText(value) {
    const tokenCount = getPositiveTokenCount(value);
    return tokenCount > 0 ? `${tokenCount}t` : '';
}

function getActiveSwipeExtra(message) {
    if (typeof message?.swipe_id !== 'number' || !Array.isArray(message?.swipe_info)) {
        return null;
    }

    const swipeInfo = message.swipe_info[message.swipe_id];
    if (!swipeInfo || typeof swipeInfo !== 'object') {
        return null;
    }

    if (!swipeInfo.extra || typeof swipeInfo.extra !== 'object') {
        swipeInfo.extra = {};
    }

    return swipeInfo.extra;
}

/**
 * Stores output and reasoning token counts separately for message metadata.
 * @param {object} message Message to update.
 * @param {object} options Token accounting options.
 * @param {(text: string) => Promise<number>} options.countTokens Token counter to use when a count must be refreshed.
 * @param {string} [options.reasoning] Reasoning text to count separately.
 * @param {number} [options.reasoningTokens] Provider-reported reasoning token count, if available.
 * @param {boolean} [options.countOutput=true] Whether to refresh the visible output token count.
 * @param {boolean} [options.countReasoning=options.countOutput] Whether to count reasoning text locally.
 * @returns {Promise<{outputTokens: number, reasoningTokens: number}>}
 */
export async function updateReasoningTokenAccounting(
    message,
    {
        countTokens,
        reasoning = message?.extra?.reasoning ?? '',
        reasoningTokens = message?.extra?.reasoning_tokens ?? 0,
        countOutput = true,
        countReasoning = countOutput,
    },
) {
    if (!message || typeof message !== 'object') {
        return { outputTokens: 0, reasoningTokens: 0 };
    }

    if (typeof countTokens !== 'function') {
        throw new TypeError('countTokens must be a function');
    }

    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }

    // Resolve the swipe being counted before any await: a swipe change mid-count must not
    // make these numbers land on whichever swipe is active afterwards.
    const countedSwipeId = message.swipe_id;
    const countedText = message.mes ?? '';
    const countedSwipeExtra = getActiveSwipeExtra(message);

    let outputTokens = getPositiveTokenCount(message.extra.token_count);
    if (countOutput) {
        outputTokens = await countTokens(countedText);
    }

    const providerReasoningTokens = getPositiveTokenCount(reasoningTokens);
    let countedReasoningTokens = providerReasoningTokens;
    const reasoningText = String(reasoning ?? '');
    if (reasoningText && countReasoning) {
        const localReasoningTokens = getPositiveTokenCount(await countTokens(reasoningText));
        countedReasoningTokens = Math.max(providerReasoningTokens, localReasoningTokens);
    }

    const targetStillActive = message.swipe_id === countedSwipeId && (message.mes ?? '') === countedText;
    if (targetStillActive) {
        if (countOutput) {
            message.extra.token_count = outputTokens;
        }
        message.extra.reasoning_tokens = countedReasoningTokens;
    }

    if (countedSwipeExtra) {
        if (countOutput) {
            countedSwipeExtra.token_count = outputTokens;
        }
        countedSwipeExtra.reasoning_tokens = countedReasoningTokens;
    }

    return { outputTokens, reasoningTokens: countedReasoningTokens };
}
