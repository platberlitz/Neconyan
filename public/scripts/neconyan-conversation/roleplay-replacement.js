const replacements = new Set(['roleplay.swipe', 'roleplay.correct', 'guided.swipe', 'guided.regenerate', 'guided.correction']);
const sources = new WeakMap();

/**
 * Empty the old reply and its Companion notes on screen at once, as a browser-side swipe does. The row
 * shrinks with them: holding its old height left a blank page. Display only: the saved chat is untouched,
 * and the returned function puts the old reply back unless something else has redrawn the message meanwhile.
 */
function blankReply(row) {
    const text = row.querySelector?.('.mes_text');
    if (!text) return () => {};
    const kept = [...text.childNodes];
    const placeholder = document.createTextNode('...');
    text.replaceChildren(placeholder);
    const hidden = [...row.querySelectorAll('.mes_reasoning_details, .mes_timer, .tokenCounterDisplay')]
        .filter(node => !node.hidden);
    for (const node of hidden) node.hidden = true;
    // The notes belong to the reply being replaced. Their stylesheet sets a display, so the hidden
    // attribute would not hide them: take them out and put them back where they were.
    const notes = [...row.querySelectorAll('.ica--companion-ledger')]
        .map(node => ({ node, parent: node.parentNode, next: node.nextSibling }));
    for (const { node } of notes) node.remove();
    return () => {
        for (const node of hidden) node.hidden = false;
        if (!row.querySelector('.ica--companion-ledger')) {
            for (const { node, parent, next } of notes) parent?.insertBefore(node, next?.parentNode === parent ? next : null);
        }
        if (text.childNodes.length === 1 && text.firstChild === placeholder) text.replaceChildren(...kept);
    };
}

/** Keep the displayed reply's row, emptied, until its prepared preview can replace it. */
export function beginRoleplayReplacement(name, messageIndex, isCurrent) {
    if (!replacements.has(name) || !Number.isSafeInteger(messageIndex) || !isCurrent()) return () => {};
    const chat = document.querySelector('#chat');
    if (!chat || chat.querySelector('[data-roleplay-replacement]')) return () => {};
    const original = chat.querySelector(`.mes[mesid="${messageIndex}"]`);
    if (!original) return () => {};
    const marker = document.createElement('span');
    marker.hidden = true;
    marker.dataset.roleplayReplacement = String(messageIndex);
    const wasInert = original.inert;
    sources.set(marker, original);
    original.inert = true;
    const refill = blankReply(original);
    original.before(marker);
    return () => {
        if (!marker.isConnected) return;
        original.inert = wasInert;
        if (isCurrent()) {
            refill();
            if (original.isConnected) marker.remove();
            else marker.replaceWith(original);
        } else {
            original.remove();
            marker.remove();
        }
        sources.delete(marker);
    };
}

/** Swap synchronously with the prepared preview, never collapse the waiting chat. */
export function commitRoleplayReplacement(marker) {
    if (marker?.isConnected) sources.get(marker)?.remove();
}
