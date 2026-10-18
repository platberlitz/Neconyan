/**
 * Serial queue and coalescing owner for per-message colour work.
 *
 * A chat load can enqueue hundreds of message jobs at once. They must run one
 * at a time, because each pass can remap text and save the chat, but no valid
 * queued message may be dropped. A lifecycle change cancels the whole
 * generation, including timers already in flight, so a late recount cannot
 * overwrite a reset chat.
 */
export function bindMessageWorkLifecycle({ eventSource, eventTypes = {}, isEnabled = () => true, cancel }) {
    const events = [
        eventTypes.CHAT_CHANGED,
        eventTypes.CHAT_CREATED,
        eventTypes.MESSAGE_DELETED,
    ].filter(Boolean);
    for (const event of new Set(events)) eventSource?.on?.(event, cancel);
    if (eventTypes.SETTINGS_UPDATED) {
        eventSource?.on?.(eventTypes.SETTINGS_UPDATED, () => {
            if (!isEnabled()) cancel();
        });
    }
}

export function createMessageWorkController({
    processDelay = 600,
    countDelay = 100,
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer),
    syncCounts,
    refreshList,
    isEnabled = () => true,
    getChat = () => null,
    onError = error => console.error('[Dialogue Colors] New-message processing failed:', error),
} = {}) {
    let generation = 0;
    let jobs = [];
    let flushTimer = null;
    let countTimer = null;
    let countChat = null;
    let refreshCharList = false;

    function cancel() {
        generation += 1;
        jobs = [];
        if (flushTimer !== null) clearTimer(flushTimer);
        flushTimer = null;
        if (countTimer !== null) clearTimer(countTimer);
        countTimer = null;
        countChat = null;
        refreshCharList = false;
    }

    function capture() {
        return generation;
    }

    function isCurrent(token) {
        return token === generation;
    }

    function schedule(job) {
        const token = generation;
        jobs.push({ job, token });
        if (flushTimer !== null) clearTimer(flushTimer);
        flushTimer = setTimer(async () => {
            flushTimer = null;
            const batch = jobs.splice(0);
            for (const entry of batch) {
                if (!isCurrent(entry.token)) break;
                try {
                    await entry.job();
                } catch (error) {
                    onError(error);
                }
                if (!isCurrent(entry.token)) break;
            }
        }, processDelay);
    }

    function scheduleCounts(chat, { refreshCharList: refresh = false } = {}) {
        const token = generation;
        if (Array.isArray(chat)) countChat = chat;
        if (refresh) refreshCharList = true;
        if (countTimer !== null) clearTimer(countTimer);
        countTimer = setTimer(() => {
            countTimer = null;
            if (!isCurrent(token)) return;
            const targetChat = countChat;
            const refreshListNow = refreshCharList;
            countChat = null;
            refreshCharList = false;
            if (!isEnabled()) return;
            let countsChanged = false;
            if (targetChat) {
                if (getChat() !== targetChat) return;
                countsChanged = syncCounts(targetChat);
            }
            if (refreshListNow || countsChanged) refreshList();
        }, countDelay);
    }

    return { cancel, capture, isCurrent, schedule, scheduleCounts };
}
