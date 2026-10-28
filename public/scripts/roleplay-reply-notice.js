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

function keptReason(error) {
    const raw = typeof error === 'string' ? error : String(error?.message ?? '');
    const code = typeof error === 'object' && error ? String(error.code ?? error.body?.code ?? '') : '';
    if (code === 'ROLEPLAY_SOURCE_CHANGED') return t`The chat changed while the reply was being written.`;
    if (code === 'ROLEPLAY_STORE_FULL') return t`Neconyan ran out of room while it was finishing this reply.`;
    if (['ROLEPLAY_RECOVERY_REQUIRED', 'ROLEPLAY_STORE_UNCERTAIN', 'ROLEPLAY_WRITE_UNCERTAIN'].includes(code)) {
        return t`An earlier save was still unfinished.`;
    }
    if (code === 'ROLEPLAY_AGENT_RECOVERY') return t`The after-reply Agent work couldn't finish.`;
    if (STORAGE_TERMS.test(raw)) return t`The reply ended while Neconyan was checking its save.`;
    return raw;
}

/**
 * @param {{ message?: string, code?: string } | string | null | undefined} error A job error or a refused request's error.
 * @param {string} state The job's terminal state, or 'refused' when the request was never accepted.
 * @param {{ kept?: boolean }} [options] Whether the text written so far is already in this chat.
 * @returns {{ title: string, message: string }}
 */
export function roleplayReplyNotice(error, state, { kept = false } = {}) {
    const raw = typeof error === 'string' ? error : String(error?.message ?? '');
    const code = typeof error === 'object' && error ? String(error.code ?? error.body?.code ?? '') : '';
    let message = codeMessage(code);
    if (kept) {
        const reason = keptReason(error);
        const saved = t`The text written so far was saved in this chat.`;
        message = reason ? `${reason} ${saved}` : saved;
        if (raw) console.warn('[Roleplay] Reply ended:', { state, code: code || null, message: raw, kept: true });
        return { title: state === 'conflict' ? t`Reply kept` : stateTitle(state), message };
    }
    if (!message && code === 'ROLEPLAY_SOURCE_CHANGED' && STORAGE_TERMS.test(raw)) {
        message = t`The chat changed while the reply was being written, so the reply was not saved. Try again.`;
    }
    if (!message && STORAGE_TERMS.test(raw)) message = t`The reply could not be finished, and nothing in your chat was changed. Try again.`;
    if (message && raw && message !== raw) console.warn('[Roleplay] Reply ended:', { state, code: code || null, message: raw });
    return { title: stateTitle(state), message: message || raw };
}

/**
 * A stopped or failed reply whose server keeper could not write the chat. Say
 * what happened, and do not promise a retry the keeper cannot perform.
 */
export function roleplayKeptReplyNotice({ state = 'failed', error = null } = {}) {
    const code = String(error?.code ?? '');
    const held = t`Neconyan still has the text saved.`;
    let message = t`The text written so far couldn't be added to this chat.`;
    if (code === 'ROLEPLAY_SOURCE_MISSING' || code === 'ROLEPLAY_SOURCE_DAMAGED') {
        message = t`The chat is missing, so the text couldn't be added to it.`;
    } else if (code === 'ROLEPLAY_STORE_FULL') {
        message = t`Neconyan has no room left to add this text to the chat.`;
    } else if (code === 'ROLEPLAY_WORKFLOW_CAPACITY') {
        message = t`This chat has no room left for the reply.`;
    } else if (['ROLEPLAY_RECOVERY_REQUIRED', 'ROLEPLAY_STORE_UNCERTAIN', 'ROLEPLAY_WRITE_UNCERTAIN',
        'ROLEPLAY_JOB_REJECTED'].includes(code)) {
        message = t`Another save was still unfinished, so the text wasn't added to this chat.`;
    }
    return { title: stateTitle(state), message: `${message} ${held}` };
}

/**
 * A refused chat save names the store that refused it, so a full store is not
 * mistaken for a lost connection. Returns '' for refusals without plain words.
 * @param {{ error?: string } | null | undefined} data The refused save's response body.
 * @returns {string}
 */
export function roleplaySaveNotice(data) {
    if (data?.error === 'roleplay_store_full') {
        return t`Neconyan ran out of room to record saves for this account, so this change was not saved. Reload the page, then try again.`;
    }
    return '';
}
