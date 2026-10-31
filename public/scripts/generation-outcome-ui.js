import { t } from './i18n.js';
import { messageGenerationBlocked } from './generation-outcome.js';

export function generationBlockedNotice(hasText = true, outcome = null) {
    if (outcome?.status === 'truncated') return t`The connection ended before this reply finished, so it may be incomplete. Automatic agents were not run.`;
    if (outcome?.status === 'error') return t`The provider ended this reply with an error. Automatic agents were not run.`;
    return hasText
        ? t`The provider stopped this reply because of a content filter. Automatic agents were not run.`
        : t`The provider blocked this request before returning reply text. Automatic agents were not run.`;
}

/** A status outside the model text, rebuilt without a toast on reload or swipe. */
export function renderGenerationOutcome(element, message) {
    const root = element?.jquery ? element[0] : element;
    if (!root) return;
    root.querySelector('.generation_outcome')?.remove();
    const outcome = message?.extra?.generation_outcome;
    // The legacy provider_error status stays silent, as the explicit stream-error notice already covers it.
    const error = outcome?.version === 1 && ['error', 'truncated'].includes(outcome.status) && outcome.reason !== 'provider_error';
    if (!messageGenerationBlocked(message) && !error) return;
    const status = document.createElement('small');
    status.className = 'generation_outcome';
    status.setAttribute('role', 'status');
    status.textContent = generationBlockedNotice(true, error ? outcome : null);
    const text = root.querySelector('.mes_text, .sb-conversation-message-text');
    if (text) text.after(status);
}
