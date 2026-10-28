import { t } from './i18n.js';

/**
 * Server-side Roleplay errors are written for the saved-data guards that raise
 * them. A toast says what happened to the reply and what to do next instead,
 * and the original wording goes to the console for diagnosis.
 */
const STORAGE_TERMS = /\b(protected|evidence|transaction|reconcile|receipt|candidate|incarnation|lease|ledger|accepted record|bound workflow)\b/i;

function codeMessage(code) {
    switch (code) {
        case 'ROLEPLAY_STORE_FULL':
            return t`Neconyan has no room left to record new replies for this account, so this reply was not started. Your chat was not changed.`;
        case 'ROLEPLAY_RECOVERY_REQUIRED':
        case 'ROLEPLAY_STORE_UNCERTAIN':
        case 'ROLEPLAY_STORE_CHANGED':
        case 'ROLEPLAY_WRITE_UNCERTAIN':
            return t`Neconyan was still finishing an earlier save, so this reply was not saved. Wait a moment, then try again. If it keeps happening, reload the page.`;
        case 'ROLEPLAY_STORE_DAMAGED':
            return t`Neconyan could not read its saved reply records for this account, so nothing was changed. Reload the page and try again.`;
        case 'ROLEPLAY_ACCOUNT_CHANGED':
            return t`The account changed while the reply was running. Reload the page, then try again.`;
        case 'ROLEPLAY_ACCOUNT_UNAVAILABLE':
            return t`This account is still being prepared or repaired. Reload the page, then try again.`;
        case 'ROLEPLAY_FOREIGN_SOURCE':
            return t`This chat's saved files need recovery. Open Settings > System & Device > Import & Restore > Repair transferred data.`;
        case 'ROLEPLAY_SOURCE_MISSING':
            return t`The chat or character for this reply is missing, so the reply was not saved.`;
        case 'ROLEPLAY_JOB_REJECTED':
            return t`This reply was replaced or withdrawn before it could be saved. Try again.`;
        default:
            return '';
    }
}

/** The toast title says what happened to the reply, not only that it ended. */
function stateTitle(state) {
    switch (state) {
        case 'failed': return t`Reply failed`;
        case 'interrupted': return t`Reply interrupted`;
        case 'conflict': return t`Reply not saved`;
        case 'refused': return t`Nothing was generated`;
        default: return t`Reply stopped`;
    }
}

/**
 * @param {{ message?: string, code?: string } | string | null | undefined} error A job error or a refused request's error.
 * @param {string} state The job's terminal state, or 'refused' when the request was never accepted.
 * @returns {{ title: string, message: string }}
 */
export function roleplayReplyNotice(error, state) {
    const raw = typeof error === 'string' ? error : String(error?.message ?? '');
    const code = typeof error === 'object' && error ? String(error.code ?? error.body?.code ?? '') : '';
    let message = codeMessage(code);
    if (!message && code === 'ROLEPLAY_SOURCE_CHANGED' && STORAGE_TERMS.test(raw)) {
        message = t`The chat changed while the reply was being written, so the reply was not saved. Try again.`;
    }
    if (!message && STORAGE_TERMS.test(raw)) message = t`The reply could not be finished, and nothing in your chat was changed. Try again.`;
    if (message && raw && message !== raw) console.warn('[Roleplay] Reply ended:', { state, code: code || null, message: raw });
    return { title: stateTitle(state), message: message || raw };
}
