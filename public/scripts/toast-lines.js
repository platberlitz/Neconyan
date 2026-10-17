import { translate } from './i18n.js';

const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
/**
 * Escapes text for a toast shown with { escapeHtml: false }, where toastr no longer escapes the title or the message.
 * @param {unknown} text
 * @returns {string}
 */
export const escapeToastText = text => String(text ?? '').replace(/[&<>"']/g, character => escapes[character]);

/**
 * HTML for a toast that shows two lines. A toast shows a newline as a space, so the lines are joined with a line break.
 * The sentence is a whole message the caller has already translated or written. The reason comes from the server or a
 * provider, so it is looked up by its exact key, escaped, and wrapped so the run-time localiser leaves it alone.
 * Show the result with { escapeHtml: false }; both lines are escaped here.
 * @param {string} sentence The sentence line
 * @param {string} [reason] The reason line; with no reason only the sentence is returned
 * @param {{reasonFirst?: boolean}} [options] reasonFirst puts the reason on the first line
 * @returns {string}
 */
export function twoLineToastHtml(sentence, reason = '', { reasonFirst = false } = {}) {
    const first = escapeToastText(sentence);
    const detail = String(reason ?? '').trim();
    if (!detail) return first;
    const second = `<span data-i18n-ignore>${escapeToastText(translate(detail))}</span>`;
    return reasonFirst ? `${second}<br>${first}` : `${first}<br>${second}`;
}
