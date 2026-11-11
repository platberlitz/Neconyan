const replacements = new Set(['roleplay.swipe', 'roleplay.correct', 'guided.swipe', 'guided.regenerate', 'guided.correction']);
const sources = new WeakMap();

/**
 * Empty the old reply on screen at once, as a browser-side swipe does, while its row keeps its height
 * so the chat does not jump. Display only: the saved chat is untouched, and the returned function puts
 * the old reply back unless something else has redrawn the message meanwhile.
 */
function blankReply(row) {
    const text = row.querySelector?.('.mes_text');
    if (!text) return () => {};
    const height = row.getBoundingClientRect?.().height;
    const minHeight = row.style.minHeight;
    if (height > 0) row.style.minHeight = `${height}px`;
    const kept = [...text.childNodes];
    const placeholder = document.createTextNode('...');
    text.replaceChildren(placeholder);
    const hidden = [...row.querySelectorAll('.mes_reasoning_details, .mes_timer, .tokenCounterDisplay')]
        .filter(node => !node.hidden);
    for (const node of hidden) node.hidden = true;
    return () => {
        row.style.minHeight = minHeight;
        for (const node of hidden) node.hidden = false;
        if (text.childNodes.length === 1 && text.firstChild === placeholder) text.replaceChildren(...kept);
    };
}

/** Reserve the displayed reply's place, emptied, until its prepared preview can replace it. */
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
