/**
 * Batch one navigation refresh per render burst without letting a queued bare
 * message id cross into a replaced element, another chat, or a disabled feature.
 */
export function createPendingNavigationQueue({
    delay = 100,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = timer => clearTimeout(timer),
    getContext,
    getSettings,
    findElement,
    addNavigation,
} = {}) {
    const pending = new Map();
    let timer = null;

    function cancel() {
        pending.clear();
        if (timer !== null) clearTimer(timer);
        timer = null;
    }

    function flush() {
        timer = null;
        const settings = getSettings();
        const context = getContext();
        const entries = Array.from(pending.values());
        pending.clear();
        if (!settings?.enabled || !settings.swipeNavigation) return;
        for (const entry of entries) {
            if (!entry.chat || context?.chat !== entry.chat) continue;
            const currentChatId = context?.chatId ?? context?.chat_id ?? null;
            if (entry.chatId !== null && currentChatId !== entry.chatId) continue;
            const element = entry.element ?? findElement(entry.messageId);
            if (!element?.isConnected) continue;
            if (entry.element && findElement(entry.messageId) !== entry.element) continue;
            addNavigation(entry.messageId, { chat: entry.chat, element });
        }
    }

    function schedule(messageId, element = null) {
        if (!Number.isInteger(messageId) || messageId < 0) return;
        const context = getContext();
        pending.set(messageId, {
            messageId,
            chat: context?.chat ?? null,
            chatId: context?.chatId ?? context?.chat_id ?? null,
            element: element ?? findElement(messageId),
        });
        // Keep the first deadline: later message mutations must not postpone
        // controls until after the saved-reply reading position has settled.
        if (timer !== null) return;
        timer = setTimer(flush, delay);
    }

    return { cancel, flush, schedule, size: () => pending.size };
}
