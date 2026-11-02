// Shared by the streaming pipeline and the in-chat Agents runner, so keep it free of DOM and app imports.

const completedMessages = new WeakSet();

/** Called only after a reply's completion markers are written, so no automatic Agent reads a half-finished reply. */
export function markStreamCompleted(message) {
    if (message && typeof message === 'object') completedMessages.add(message);
}

/** A new stream on the same message object starts again from not completed. */
export function unmarkStreamCompleted(message) {
    if (message && typeof message === 'object') completedMessages.delete(message);
}

export function isStreamCompleted(message) {
    return Boolean(message) && typeof message === 'object' && completedMessages.has(message);
}

/** Marks a continuation whose newly written text is empty, while the saved prefix is still on the message. */
export function setContinuationEmptyMarker(extra, empty) {
    if (!extra || typeof extra !== 'object') return;
    if (empty) extra.reasoning_continuation_empty = true;
    else delete extra.reasoning_continuation_empty;
}

/** Marks a reply whose turn called tools. Its thinking is planning for the tool call, not a reply to recover. */
export function setGenerationToolTurnMarker(extra, toolTurn) {
    if (!extra || typeof extra !== 'object') return;
    if (toolTurn) extra.generation_tool_turn = true;
    else delete extra.generation_tool_turn;
}

/** The reasoning this generation produced, kept apart from any reasoning an earlier turn already saved on the reply. */
export function setFreshReasoningMarker(extra, reasoning) {
    if (!extra || typeof extra !== 'object') return;
    if (typeof reasoning === 'string' && reasoning.trim()) extra.reasoning_current = reasoning;
    else delete extra.reasoning_current;
}
