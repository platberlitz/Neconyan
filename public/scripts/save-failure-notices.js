// While one chat keeps failing to save, the person needs one notice, not one per attempt.
// Every failure is still logged by the caller; this only decides whether to show the toast again.
export const SAVE_FAILURE_REMINDER_MS = 5 * 60 * 1000;

const notices = new Map();
const showErrorToast = (message, title, options) => globalThis.toastr?.error(message, title, options);

/**
 * Shows a save failure notice unless the same notice for the same chat is on screen or was shown recently.
 * @param {string} key Identifies the chat that failed to save.
 * @param {string} message Toast message.
 * @param {string} title Toast title.
 * @param {(message: string, title: string, options: { onHidden: () => void }) => unknown} [show] Shows the toast.
 * @param {number} [now] Current time in milliseconds.
 * @returns {boolean} True when the notice was shown.
 */
export function showSaveFailureNotice(key, message, title, show = showErrorToast, now = Date.now()) {
    const id = String(key ?? '');
    const previous = notices.get(id);
    if (previous && previous.message === message && previous.title === title
        && (previous.visible || now - previous.shownAt < SAVE_FAILURE_REMINDER_MS)) {
        previous.suppressed++;
        return false;
    }
    const notice = { message, title, shownAt: now, visible: true, suppressed: 0 };
    notices.set(id, notice);
    try {
        show(message, title, { onHidden: () => { notice.visible = false; } });
    } catch (error) {
        notices.delete(id);
        throw error;
    }
    return true;
}

/** Forgets the notice for a chat once it saves again, so the next failure is shown at once. */
export function clearSaveFailureNotice(key) {
    notices.delete(String(key ?? ''));
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
