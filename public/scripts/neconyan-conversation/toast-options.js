// Dependency-free so Conversation modules can use it without joining the partial
// constants.js and render-utils.js mocks in the Jest suites.

/** Toast options that show names, provider text and error details as plain text. */
export const CONVERSATION_SAFE_TOAST_OPTIONS = Object.freeze({ escapeHtml: true });

/**
 * Escapes text for a toast whose call signature tests pin, so it stays plain text without a third argument.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeToastText(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
