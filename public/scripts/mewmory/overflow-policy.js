/**
 * Shared prompt-overflow policy for Mewmory.
 *
 * Both the browser fallback and the server-owned reply publication use this
 * module, so the accumulated visible history is cleared at the same trigger
 * whether the reply came from an open tab or a background job. The policy only
 * reads message shape; token counting is supplied by the caller so it can use
 * the Mewmory writer tokenizer on either side.
 */

/** Messages that contribute to the prompt, in chat order. Hidden/system rows never count. */
export function visibleMessageIndices(messages) {
    return messages.flatMap((message, index) => message?.is_system ? [] : [index]);
}

/**
 * Visible messages that must be hidden because the accumulated visible history
 * reached the limit. Every eligible visible message older than the latest AI
 * reply is hidden at once; no recent tail is kept. The latest AI reply and every
 * message after it stay visible even when that reply alone reaches the limit.
 * `counts` is aligned with visibleMessageIndices(messages), all in one batch.
 */
export function overflowPlan(messages, limit, counts) {
    const latest = messages.findLastIndex(message => message && !message.is_user && !message.is_system);
    const result = { limit, indices: [] };
    const visible = visibleMessageIndices(messages);
    if (!(limit > 0) || latest < 1 || !Array.isArray(counts)) return result;
    if (counts.length !== visible.length) throw new Error('Mewmory received an incomplete token count for this chat.');
    const used = counts.reduce((total, count) => total + (Number(count) || 0), 0);
    // Reaching the limit triggers a clear of the accumulated eligible history.
    if (used < limit) return result;
    for (const index of visible) {
        if (index >= latest) break;
        result.indices.push(index);
    }
    return result;
}

/** Contiguous ranges for one bulk visibility write. */
export function overflowRanges(indices) {
    const ranges = [];
    for (const index of indices) {
        const range = ranges.at(-1);
        if (range && range[1] === index - 1) range[1] = index;
        else ranges.push([index, index]);
    }
    return ranges;
}

/** A stable, cheap identity for the exact contents the plan was counted from. */
export function overflowFingerprint(messages) {
    return messages.map(message => [
        String(message?.mes ?? ''), Boolean(message?.is_user), Boolean(message?.is_system),
    ].join('\u0000')).join('\u0001');
}
