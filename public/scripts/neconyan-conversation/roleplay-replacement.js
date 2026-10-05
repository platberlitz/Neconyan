const replacements = new Set(['roleplay.swipe', 'roleplay.correct', 'guided.swipe', 'guided.correction']);

/** Detach only the displayed reply; its saved source remains available for the server. */
export function beginRoleplayReplacement(name, messageIndex, isCurrent) {
    if (!replacements.has(name) || !Number.isSafeInteger(messageIndex) || !isCurrent()) return () => {};
    const chat = document.querySelector('#chat');
    if (!chat || chat.querySelector('[data-roleplay-replacement]')) return () => {};
    const original = chat.querySelector(`.mes[mesid="${messageIndex}"]`);
    if (!original) return () => {};
    const marker = document.createElement('span');
    marker.hidden = true;
    marker.dataset.roleplayReplacement = String(messageIndex);
    original.replaceWith(marker);
    return () => {
        if (!marker.isConnected) return;
        if (isCurrent()) marker.replaceWith(original);
        else marker.remove();
    };
}
