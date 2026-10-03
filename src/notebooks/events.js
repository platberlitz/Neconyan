const listeners = new Set();

/** Subscribers receive safe identifiers and revisions only, never note bodies. */
export function subscribeNotebookChanges(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function notifyNotebookChanged(change) {
    const safe = {
        owner: change.owner,
        notebookId: change.notebookId ?? null,
        noteId: change.noteId ?? null,
        revision: change.revision ?? null,
        kind: change.kind ?? 'changed',
        operationId: change.operationId ?? null,
        at: Date.now(),
    };
    for (const listener of listeners) {
        try { listener(safe); } catch { /* a broken listener must not undo a committed change */ }
    }
}
