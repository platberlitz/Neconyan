/**
 * Change history for saved Scratchpad changes. Everything is built with h(), so text the model or
 * the user wrote only ever reaches the page through textContent.
 */
import { t, translate } from '../i18n.js';
import { h } from '../notebooks/dom.js';

// Its own key, because Prompt Media already translates the same English under a scoped key.
export function historyHeading() {
    return translate('Change history', 'scoped.scratchpad.HIS-01');
}

/** 'Saved' entries can be undone, 'Recorded' ones are kept for reference only. */
export function historyStatus(entry) {
    if (entry?.status === 'undone') return { key: 'undone', label: t`Undone` };
    return entry?.undoable ? { key: 'saved', label: t`Saved` } : { key: 'recorded', label: t`Recorded` };
}

export function canUndoEntry(entry) {
    return Boolean(entry?.undoable && entry.status !== 'undone');
}

export function findHistoryEntry(history, { sessionId, messageId, proposalIndex }) {
    return (Array.isArray(history) ? history : []).find(entry => entry?.sessionId === sessionId
        && entry?.messageId === messageId && entry?.proposalIndex === proposalIndex) ?? null;
}

function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try {
        return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
        return date.toLocaleString();
    }
}

function textBlock(label, text, className) {
    return h('div', { class: `scratchpad-history-text ${className}` },
        h('span', { class: 'scratchpad-history-text-label', text: label }),
        text
            ? h('pre', { class: 'scratchpad-history-text-body', 'data-i18n-ignore': '', text })
            : h('p', { class: 'scratchpad-history-text-empty', text: t`(empty)` }));
}

const DIFF_CLASSES = { 1: 'ica-transform-diff-part--ins', [-1]: 'ica-transform-diff-part--del' };

/** The same word-level diff as the Review popup, drawn only when the entry is opened. */
function diffBlock(before, after, diffParts) {
    const diff = h('div', { class: 'ica-transform-diff', role: 'group', tabindex: '0', 'aria-label': t`Changes`, 'data-i18n-ignore': '' });
    let drawn = false;
    const draw = () => {
        if (drawn) return;
        drawn = true;
        try {
            diff.append(...diffParts(before, after).map(([op, text]) => h('span', { class: DIFF_CLASSES[op] ?? null, text })));
        } catch {
            diff.closest('.ica-transform-history')?.remove();
        }
    };
    return { node: h('div', { class: 'ica-transform-history' }, h('strong', { text: t`Changes` }), diff), draw };
}

function renderEntry(entry, { button, busy, conflict, open, diffParts, onUndo, onCopy }) {
    const status = historyStatus(entry);
    const where = String(entry.target?.label ?? '').trim();
    const field = String(entry.field ?? '').trim();
    const savedAt = formatTime(entry.savedAt);
    const undoneAt = entry.status === 'undone' ? formatTime(entry.undoneAt) : '';
    const before = String(entry.before ?? '');
    const after = String(entry.after ?? '');
    const undoButton = canUndoEntry(entry)
        ? button(busy ? t`Undoing…` : t`Undo`, () => onUndo(entry), { icon: 'fa-rotate-left', className: 'scratchpad-history-undo', disabled: busy })
        : null;
    if (undoButton && busy) undoButton.setAttribute('aria-busy', 'true');
    return h('li', { class: `scratchpad-history-entry is-${status.key}`, dataset: { historyId: entry.id } },
        h('div', { class: 'scratchpad-history-head' },
            h('span', { class: `scratchpad-history-badge is-${status.key}`, text: status.label }),
            savedAt ? h('time', { class: 'scratchpad-history-time', datetime: entry.savedAt, text: savedAt }) : null),
        h('p', { class: 'scratchpad-history-title', 'data-i18n-ignore': '', text: entry.description || t`Saved change` }),
        where || field ? h('dl', { class: 'scratchpad-history-meta' },
            where ? [h('dt', { text: t`Where` }), h('dd', { 'data-i18n-ignore': '', text: where })] : null,
            field ? [h('dt', { text: t`What` }), h('dd', { 'data-i18n-ignore': '', text: field })] : null) : null,
        undoneAt ? h('p', { class: 'scratchpad-history-note', text: t`Undone on ${undoneAt}.` }) : null,
        conflict ? h('p', { class: 'scratchpad-history-conflict', role: 'status', text: conflict }) : null,
        !entry.undoable && entry.undoUnavailableReason
            ? h('p', { class: 'scratchpad-history-note', text: entry.undoUnavailableReason }) : null,
        before || after ? renderDetails(before, after, { open, diffParts }) : null,
        before || undoButton ? h('div', { class: 'scratchpad-history-actions' },
            before ? button(t`Copy previous text`, () => onCopy(before), { icon: 'fa-copy', className: 'scratchpad-history-copy' }) : null,
            undoButton) : null);
}

function renderDetails(before, after, { open, diffParts }) {
    const diff = typeof diffParts === 'function' && before !== after ? diffBlock(before, after, diffParts) : null;
    const details = h('details', { class: 'scratchpad-history-diff' },
        h('summary', { text: t`View before & after` }),
        diff?.node,
        textBlock(t`Before`, before, 'is-before'),
        textBlock(t`After`, after, 'is-after'));
    if (diff) details.addEventListener('toggle', () => details.open && diff.draw());
    if (open) {
        details.open = true;
        diff?.draw();
    }
    return details;
}

/**
 * history is newest first, as the server keeps it. busy, conflicts and open are keyed by entry id.
 * diffParts is textDiffParts from text-diff.js, passed in so this module stays free of the diff library.
 * button is the caller's icon button factory, so the dialog matches the rest of Scratchpad.
 */
export function renderChangeHistory(history, { button, busy = new Set(), conflicts = new Map(), open = new Set(), diffParts = null, onUndo, onCopy }) {
    const entries = (Array.isArray(history) ? history : []).filter(entry => entry && typeof entry.id === 'string');
    const root = h('div', { class: 'scratchpad-history' },
        h('h3', { text: historyHeading() }),
        h('p', { class: 'scratchpad-history-intro', text: t`Changes you saved from Scratchpad here, newest first. Undo puts the previous text back if nothing else has changed it since.` }));
    if (!entries.length) {
        root.append(h('p', { class: 'scratchpad-history-empty', text: t`No saved changes yet. When you save a suggested change, it shows up here so you can look back or undo it.` }));
        return root;
    }
    root.append(h('ol', { class: 'scratchpad-history-list' },
        entries.map(entry => renderEntry(entry, {
            button, busy: busy.has(entry.id), conflict: conflicts.get(entry.id) || '', open: open.has(entry.id), diffParts, onUndo, onCopy,
        }))));
    return root;
}
