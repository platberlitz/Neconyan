import { translate } from './i18n.js';
import { proposalLabel, userPhrase } from './notebooks/user-text.js';

/** Render both page-run and server-run assistant edits as plain text. */
export function buildAssistantReview(review) {
    const root = document.createElement('div');
    root.className = 'neconyan-assistant-review';
    for (const text of [`Allow ${review.resource} edit?`, `Target: ${review.target}`, `Field: ${review.field}`]) {
        const line = document.createElement('p');
        line.textContent = text;
        root.append(line);
    }
    for (const [label, value] of [['Before', review.before], ['After', review.after]]) {
        const heading = document.createElement('strong');
        heading.textContent = label;
        const content = document.createElement('pre');
        content.textContent = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
        content.style.whiteSpace = 'pre-wrap';
        content.style.overflowWrap = 'anywhere';
        content.style.maxHeight = 'none';
        root.append(heading, content);
    }
    return root;
}

/**
 * Render a notebook proposal (create, add, change or publish) with its exact line diff. Notes and the chat's assistant tools both
 * show it; the note title and section names stay as written and the wording around them is translated here (notebooks/user-text.js).
 * The sections arrive as text only ('Whole note' or a heading the user named so look the same), so they are shown as written.
 */
export function buildNoteProposalReview({ summary = {}, diff = '' } = {}) {
    const root = document.createElement('div');
    root.className = 'neconyan-assistant-review neconyan-note-proposal-review';
    const lines = [
        userPhrase`Allow this change? ${summary.label ? proposalLabel(summary) : translate('Notebook change')}`,
        'Not saved yet.',
        summary.affectsLiveLore ? 'This changes live World Info (lore).' : 'This changes a note draft only. Live lore is not touched.',
    ];
    if (Array.isArray(summary.changedRegions) && summary.changedRegions.length) lines.push(userPhrase`Sections: ${summary.changedRegions.join(', ')}`);
    if (Number.isFinite(summary.added) || Number.isFinite(summary.removed)) lines.push(`Lines added: ${summary.added ?? 0}, lines removed: ${summary.removed ?? 0}`);
    for (const text of lines) {
        const line = document.createElement('p');
        line.append(text);
        root.append(line);
    }
    const title = document.createElement('strong');
    title.textContent = 'Changes';
    const content = document.createElement('pre');
    content.textContent = typeof diff === 'string' && diff ? diff : '(no visible text changes)';
    content.style.whiteSpace = 'pre-wrap';
    content.style.overflowWrap = 'anywhere';
    content.style.maxHeight = 'none';
    root.append(title, content);
    return root;
}
