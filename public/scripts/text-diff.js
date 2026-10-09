import { DiffMatchPatch } from '../lib.js';
import { escapeHtml } from './utils.js';

/** The inline added/removed text view shared by agent history and Scratchpad. */
export function buildTextDiffMarkup(beforeText, afterText) {
    const dmp = new DiffMatchPatch();
    const diffs = dmp.diff_main(String(beforeText ?? ''), String(afterText ?? ''));
    dmp.diff_cleanupSemantic(diffs);

    return diffs.map(([operation, text]) => {
        const escapedText = escapeHtml(text);
        if (operation === 1) {
            return `<span class="ica-transform-diff-part--ins">${escapedText}</span>`;
        }
        if (operation === -1) {
            return `<span class="ica-transform-diff-part--del">${escapedText}</span>`;
        }
        return `<span>${escapedText}</span>`;
    }).join('');
}
