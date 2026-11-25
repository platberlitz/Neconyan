// Quick prompts row rules. Kept free of the DOM so the rules can be tested alone.

// An empty session shows the row; a session with messages folds it away. A click on the toggle
// overrides that for that session only, so every other session keeps following its own rule.
const MAX_OVERRIDES = 50;

export function createQuickBarState() {
    return { overrides: new Map() };
}

export function quickBarExpanded(state, key, messageCount) {
    return state.overrides.get(key) ?? !(messageCount > 0);
}

export function toggleQuickBar(state, key, messageCount) {
    const expanded = !quickBarExpanded(state, key, messageCount);
    state.overrides.delete(key);
    state.overrides.set(key, expanded);
    if (state.overrides.size > MAX_OVERRIDES) state.overrides.delete(state.overrides.keys().next().value);
    return expanded;
}

const LINE_PIXELS = 16;

// How far a vertical mouse wheel should move a sideways row, or 0 to leave the event alone.
export function wheelScrollDelta({ deltaX = 0, deltaY = 0, deltaMode = 0, ctrlKey = false, shiftKey = false } = {}, { scrollLeft = 0, scrollWidth = 0, clientWidth = 0 } = {}) {
    if (ctrlKey || shiftKey || !deltaY || Math.abs(deltaX) >= Math.abs(deltaY)) return 0;
    const room = scrollWidth - clientWidth;
    if (room <= 1) return 0;
    const delta = deltaMode === 1 ? deltaY * LINE_PIXELS : deltaMode === 2 ? deltaY * clientWidth : deltaY;
    if (delta < 0 && scrollLeft <= 0) return 0;
    if (delta > 0 && scrollLeft >= room - 1) return 0;
    return delta;
}
