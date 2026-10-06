/**
 * User Settings > "Clear job history". Every reply, image or memory task is a
 * saved job on the server, and failed ones keep their whole prompt until they
 * are dismissed. This button dismisses failures and deletes finished records
 * so a full job ledger never blocks new messages.
 */
import { clearJobHistory } from './jobs.js';
import { Popup, POPUP_RESULT } from './popup.js';
import { t } from './i18n.js';

export const CLEAR_JOB_HISTORY_BUTTON_ID = 'clear_job_history_button';

async function confirmClearJobHistory() {
    const result = await Popup.show.confirm(
        t`Clear job history?`,
        t`This removes finished and failed replies, images and memory tasks from the server's job list. Work that is still running stays, and your chats and messages are not touched. Failed replies can no longer be retried afterwards.`,
        { okButton: t`Clear job history`, cancelButton: t`Cancel` },
    );
    return result === POPUP_RESULT.AFFIRMATIVE;
}

export function describeJobHistoryClear({ removed = 0, dismissed = 0, remaining = 0 } = {}) {
    if (!removed && !dismissed) return t`Job history was already clear.`;
    const parts = [`${removed} ${removed === 1 ? t`job removed` : t`jobs removed`}`];
    if (remaining) parts.push(`${remaining} ${t`still running or just finished`}`);
    return `${parts.join(', ')}.`;
}

function setBusy(button, busy) {
    button.disabled = busy;
    button.classList.toggle('disabled', busy);
    if (busy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
}

export async function handleClearJobHistoryClick(event, { confirm = confirmClearJobHistory, clear = clearJobHistory } = {}) {
    event?.preventDefault?.();
    const button = document.getElementById(CLEAR_JOB_HISTORY_BUTTON_ID);
    if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
    setBusy(button, true);
    try {
        if (!await confirm()) return null;
        const result = await clear();
        globalThis.toastr?.success?.(describeJobHistoryClear(result), t`Job history cleared`);
        return result;
    } catch (error) {
        console.error('Failed to clear job history', error);
        globalThis.toastr?.error?.(String(error?.message || error), t`Clear failed`);
        return null;
    } finally {
        setBusy(button, false);
    }
}

export function bindClearJobHistoryButton() {
    const button = document.getElementById(CLEAR_JOB_HISTORY_BUTTON_ID);
    if (!(button instanceof HTMLButtonElement) || button.dataset.sbJobHistoryBound === 'true') return;
    button.dataset.sbJobHistoryBound = 'true';
    button.addEventListener('click', event => {
        void handleClearJobHistoryClick(event);
    });
}
