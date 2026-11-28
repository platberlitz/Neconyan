// While one chat keeps failing to save, the person needs one notice, not one per attempt.
// Every failure is still logged by the caller; this only decides whether to show the toast again.
export const SAVE_FAILURE_REMINDER_MS = 5 * 60 * 1000;

const notices = new Map();
const failures = new Map();
const changeNotices = new Map();
const showErrorToast = (message, title, options) => globalThis.toastr?.error(message, title, options);

/**
 * Shows a save failure notice unless the same notice for the same chat is on screen or was shown recently.
 * @param {string} key Identifies the chat that failed to save.
 * @param {string} message Toast message.
 * @param {string} title Toast title.
 * @param {(message: string, title: string, options: { onHidden: () => void }) => unknown} [show] Shows the toast.
 * @param {number} [now] Current time in milliseconds.
 * @param {{ family?: string }} [options] Notices of one family stand in for each other, so an outage whose cause
 * flips between attempts still gets one toast.
 * @returns {boolean} True when the notice was shown.
 */
export function showSaveFailureNotice(key, message, title, show = showErrorToast, now = Date.now(), { family = '' } = {}) {
    const id = String(key ?? '');
    const previous = notices.get(id);
    if (previous && previous.title === title && (previous.message === message || (family && previous.family === family))
        && (previous.visible || now - previous.shownAt < SAVE_FAILURE_REMINDER_MS)) {
        previous.suppressed++;
        return false;
    }
    const notice = { message, title, family, shownAt: now, visible: true, suppressed: 0 };
    notices.set(id, notice);
    try {
        show(message, title, { onHidden: () => { notice.visible = false; } });
    } catch (error) {
        notices.delete(id);
        throw error;
    }
    return true;
}

/** Forgets the notice and the failure for a chat once it saves again, so the next failure is shown at once. */
export function clearSaveFailureNotice(key) {
    const id = String(key ?? '');
    notices.delete(id);
    failures.delete(id);
}

/**
 * Remembers why the chat's latest save failed, until it saves again.
 * @param {string} key Identifies the chat that failed to save.
 * @param {string} kind Why it failed.
 */
export function noteSaveFailure(key, kind) {
    failures.set(String(key ?? ''), String(kind || 'local'));
}

/** Why the chat's latest save failed, or null when it has saved since. */
export function lastSaveFailure(key) {
    return failures.get(String(key ?? '')) ?? null;
}

/**
 * Shows a notice for a change that was put back because it could not be saved.
 * Each attempt was the person's own action, so it repeats once the previous toast has gone.
 * @param {string} key Identifies the chat.
 * @param {string} message Toast message.
 * @param {string} title Toast title.
 * @param {(message: string, title: string, options: { onHidden: () => void }) => unknown} [show] Shows the toast.
 * @returns {boolean} True when the notice was shown.
 */
export function showUndoneChangeNotice(key, message, title, show = showErrorToast) {
    const id = String(key ?? '');
    const previous = changeNotices.get(id);
    if (previous?.visible && previous.message === message && previous.title === title) {
        return false;
    }
    const notice = { message, title, visible: true };
    changeNotices.set(id, notice);
    try {
        show(message, title, { onHidden: () => { notice.visible = false; } });
    } catch (error) {
        changeNotices.delete(id);
        throw error;
    }
    return true;
}

/** Number of repeats hidden since the chat's notice was last shown. */
export function suppressedSaveFailureNotices(key) {
    return notices.get(String(key ?? ''))?.suppressed ?? 0;
}

export function chatSaveNoticeKey(avatar, chat) {
    return JSON.stringify(['chat', String(avatar ?? ''), String(chat ?? '')]);
}

export function groupChatSaveNoticeKey(chatId) {
    return JSON.stringify(['group', String(chatId ?? '')]);
}
