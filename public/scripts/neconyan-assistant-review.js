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
