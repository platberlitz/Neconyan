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

/** Render a notebook proposal (create, add, change or publish) with its exact line diff. */
export function buildNoteProposalReview({ summary = {}, diff = '' } = {}) {
    const root = document.createElement('div');
    root.className = 'neconyan-assistant-review neconyan-note-proposal-review';
    const lines = [
        `Allow this change? ${summary.label || 'Notebook change'}`,
        'Not saved yet.',
        summary.affectsLiveLore ? 'This changes live World Info (lore).' : 'This changes a note draft only. Live lore is not touched.',
    ];
    if (Array.isArray(summary.changedRegions) && summary.changedRegions.length) lines.push(`Sections: ${summary.changedRegions.join(', ')}`);
    if (Number.isFinite(summary.added) || Number.isFinite(summary.removed)) lines.push(`Lines added: ${summary.added ?? 0}, lines removed: ${summary.removed ?? 0}`);
    for (const text of lines) {
        const line = document.createElement('p');
        line.textContent = text;
        root.append(line);
    }
    const heading = document.createElement('strong');
    heading.textContent = 'Changes';
    const content = document.createElement('pre');
    content.textContent = typeof diff === 'string' && diff ? diff : '(no visible text changes)';
    content.style.whiteSpace = 'pre-wrap';
    content.style.overflowWrap = 'anywhere';
    content.style.maxHeight = 'none';
    root.append(heading, content);
    return root;
}
