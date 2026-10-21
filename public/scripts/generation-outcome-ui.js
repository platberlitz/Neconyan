import { t } from './i18n.js';
import { messageGenerationBlocked } from './generation-outcome.js';

export function generationBlockedNotice(hasText = true) {
    return hasText
        ? t`The provider stopped this reply because of a content filter. Automatic agents were not run.`
        : t`The provider blocked this request before returning reply text. Automatic agents were not run.`;
}

/** A status outside the model text, rebuilt without a toast on reload or swipe. */
export function renderGenerationOutcome(element, message) {
    const root = element?.jquery ? element[0] : element;
    if (!root) return;
    root.querySelector('.generation_outcome')?.remove();
    if (!messageGenerationBlocked(message)) return;
    const status = document.createElement('small');
    status.className = 'generation_outcome';
    status.setAttribute('role', 'status');
    status.textContent = generationBlockedNotice();
    const text = root.querySelector('.mes_text, .sb-conversation-message-text');
    if (text) text.after(status);
}
