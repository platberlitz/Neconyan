const replacements = new Set(['roleplay.swipe', 'roleplay.correct', 'guided.swipe', 'guided.regenerate', 'guided.correction']);
const sources = new WeakMap();

/** Keep the displayed reply in place until its prepared preview can replace it. */
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
    original.before(marker);
    return () => {
        if (!marker.isConnected) return;
        original.inert = wasInert;
        if (isCurrent()) {
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
