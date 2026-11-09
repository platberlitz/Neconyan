export const MAX_REPLY_SWIPES = 50;

/** The selected reply lives at the top level; its slot stays empty to avoid stale copies. */
export function replySwipes(message) {
    const { swipes, swipeIndex, ...current } = message;
    if (!Array.isArray(swipes) || !Number.isSafeInteger(swipeIndex) || swipeIndex < 0 || swipeIndex >= swipes.length) return [current];
    return swipes.map((swipe, index) => index === swipeIndex ? current : swipe);
}

export function selectReplySwipe(message, index) {
    const swipes = replySwipes(message);
    return { ...swipes[index], swipeIndex: index, swipes: swipes.map((swipe, position) => position === index ? null : swipe) };
}

export function appendReplySwipe(message, next) {
    const swipes = replySwipes(message);
    return { ...next, swipeIndex: swipes.length, swipes: [...swipes, null] };
}

/** Exports contain text alternatives, never saved permissions or executable proposal identities. */
export function exportReply(message) {
    const plain = item => Object.fromEntries(['role', 'text', 'created', 'assistant', 'assistantName', 'gender'].map(key => [key, item[key]]));
    const exported = plain(message);
    if (message.role === 'assistant' && message.swipes?.length > 1) {
        exported.swipeIndex = message.swipeIndex;
        exported.swipes = replySwipes(message).map(plain);
    }
    return exported;
}
