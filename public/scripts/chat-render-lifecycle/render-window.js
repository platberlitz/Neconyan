export const CHAT_RENDER_WINDOW_DEFAULT = 100;
export const CHAT_RENDER_WINDOW_MAX = 200;
// Neconyan: aggressive DOM unloading for low-memory devices (e.g., iPhones crashing on long streams)
export const CHAT_RENDER_WINDOW_AGGRESSIVE_DEFAULT = 5;
export const CHAT_RENDER_WINDOW_LOW_MEMORY_MAX = 25;

/**
 * Keeps chat DOM windows bounded even when older settings used 0 as "render everything".
 * @param {number} requestedSize User-configured or caller-requested window size.
 * @param {object} [options] Options
 * @param {number} [options.defaultSize=CHAT_RENDER_WINDOW_DEFAULT] Fallback for invalid or disabled values.
 * @param {number} [options.maxSize=CHAT_RENDER_WINDOW_MAX] Hard cap for rendered chat messages.
 * @returns {number}
 */
export function normalizeChatRenderWindowSize(requestedSize, {
    defaultSize = CHAT_RENDER_WINDOW_DEFAULT,
    maxSize = CHAT_RENDER_WINDOW_MAX,
} = {}) {
    const normalizedDefault = normalizePositiveInteger(defaultSize, CHAT_RENDER_WINDOW_DEFAULT);
    const normalizedMax = Math.max(1, normalizePositiveInteger(maxSize, CHAT_RENDER_WINDOW_MAX));
    const numericSize = Number(requestedSize);

    if (!Number.isFinite(numericSize) || numericSize <= 0) {
        return Math.min(normalizedDefault, normalizedMax);
    }

    return Math.min(Math.floor(numericSize), normalizedMax);
}

/**
 * Resolves the tail-window start index for initial chat rendering.
 * @param {number} totalMessages Total messages in the chat array.
 * @param {number} requestedSize User-configured or caller-requested window size.
 * @param {object} [options] Normalization options.
 * @returns {number}
 */
export function getChatRenderWindowStartIndex(totalMessages, requestedSize, options = {}) {
    const messageCount = Math.max(0, Math.floor(Number(totalMessages) || 0));
    const windowSize = normalizeChatRenderWindowSize(requestedSize, options);

    return Math.max(0, messageCount - windowSize);
}

/**
 * Leaves one already-rendered message in place while paging so scroll anchors survive pruning.
 * @param {number} requestedSize User-configured or caller-requested page size.
 * @param {object} [options] Options
 * @param {number} [options.renderedMessageCount=0] Number of message elements currently rendered.
 * @param {number} [options.windowSize=CHAT_RENDER_WINDOW_DEFAULT] Current DOM window size.
 * @param {boolean} [options.preserveAnchor=true] Leave one rendered message in place for scroll anchoring.
 * @returns {number}
 */
export function getChatHistoryPageSize(requestedSize, {
    renderedMessageCount = 0,
    windowSize = CHAT_RENDER_WINDOW_DEFAULT,
    preserveAnchor = true,
} = {}) {
    const normalizedWindowSize = normalizeChatRenderWindowSize(windowSize);
    const normalizedRequestedSize = normalizeChatRenderWindowSize(requestedSize, { maxSize: normalizedWindowSize });

    if (preserveAnchor && renderedMessageCount > 0) {
        return Math.min(normalizedRequestedSize, Math.max(1, normalizedWindowSize - 1));
    }

    return normalizedRequestedSize;
}

/**
 * Resolves the effective Roleplay chat render window policy.
 * @param {object} [options]
 * @param {number} [options.requestedSize] Caller-requested window size.
 * @param {number} [options.chatTruncation=CHAT_RENDER_WINDOW_DEFAULT] Saved chat_truncation setting.
 * @param {boolean} [options.aggressiveUnload=false] Saved aggressive_dom_unload setting.
 * @param {number} [options.aggressiveWindowSize=CHAT_RENDER_WINDOW_AGGRESSIVE_DEFAULT] Saved aggressive_dom_window_size setting.
 * @param {boolean} [options.lowMemoryActive=false] Whether low-memory mode is currently active.
 * @param {boolean} [options.historyExplicit=false] Whether any of the three history settings is explicitly owned by the user.
 * @returns {{ mode: 'fixed' | 'normal', initialSize: number, maxSize: number }}
 */
export function resolveChatRenderWindowPolicy({
    requestedSize,
    chatTruncation = CHAT_RENDER_WINDOW_DEFAULT,
    aggressiveUnload = false,
    aggressiveWindowSize = CHAT_RENDER_WINDOW_AGGRESSIVE_DEFAULT,
    lowMemoryActive = false,
    historyExplicit = false,
} = {}) {
    if (aggressiveUnload) {
        const aggressiveCap = normalizePositiveInteger(aggressiveWindowSize, CHAT_RENDER_WINDOW_AGGRESSIVE_DEFAULT);
        const boundedAggressiveCap = normalizeChatRenderWindowSize(aggressiveCap, {
            defaultSize: CHAT_RENDER_WINDOW_AGGRESSIVE_DEFAULT,
            maxSize: aggressiveCap,
        });
        const maxSize = lowMemoryActive && !historyExplicit
            ? Math.min(boundedAggressiveCap, CHAT_RENDER_WINDOW_LOW_MEMORY_MAX)
            : boundedAggressiveCap;
        return Object.freeze({
            mode: 'fixed',
            initialSize: maxSize,
            maxSize,
        });
    }

    if (lowMemoryActive && !historyExplicit) {
        const baseLimit = normalizeChatRenderWindowSize(chatTruncation, {
            defaultSize: CHAT_RENDER_WINDOW_LOW_MEMORY_MAX,
            maxSize: CHAT_RENDER_WINDOW_LOW_MEMORY_MAX,
        });
        const initialSize = requestedSize !== undefined
            ? normalizeChatRenderWindowSize(requestedSize, {
                defaultSize: baseLimit,
                maxSize: baseLimit,
            })
            : baseLimit;
        return Object.freeze({
            mode: 'fixed',
            initialSize,
            maxSize: baseLimit,
        });
    }

    const initialSize = normalizeChatRenderWindowSize(
        requestedSize !== undefined ? requestedSize : chatTruncation,
        {
            defaultSize: CHAT_RENDER_WINDOW_DEFAULT,
            maxSize: CHAT_RENDER_WINDOW_MAX,
        },
    );
    return Object.freeze({
        mode: 'normal',
        initialSize,
        maxSize: CHAT_RENDER_WINDOW_MAX,
    });
}

/**
 * Resolves the maximum rendered message count allowed after a history paging step.
 * @param {number} requestedSize Caller-requested or user-configured page size.
 * @param {number} renderedMessageCount Currently mounted message count.
 * @param {object} [policyOptions] Policy resolution options.
 * @returns {number}
 */
export function resolvePagedChatRenderWindowSize(requestedSize, renderedMessageCount, policyOptions = {}) {
    const policy = resolveChatRenderWindowPolicy({
        ...policyOptions,
        requestedSize,
    });
    if (policy.mode === 'fixed') {
        return policy.maxSize;
    }
    const safeRenderedCount = Math.max(0, Math.floor(Number(renderedMessageCount) || 0));
    return normalizeChatRenderWindowSize(safeRenderedCount + policy.initialSize, {
        defaultSize: policy.initialSize,
        maxSize: policy.maxSize,
    });
}

function normalizePositiveInteger(value, fallback) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue) || numericValue <= 0) {
        return fallback;
    }

    return Math.floor(numericValue);
}
