/**
 * Escapes a saved name before it goes into popup HTML. Kept free of imports so suites that
 * mock utils.js with a partial export list can still load the modules that use it.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
