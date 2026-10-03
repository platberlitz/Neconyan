import { CANVAS_LIMITS, validateCanvasDocument } from './canvas-format.js';

const prefix = 'neconyan-canvas-draft';
const key = (account, notebookId, canvasId) => `${prefix}:${encodeURIComponent(account)}:${notebookId}:${canvasId}`;

export function readCanvasDraft(account, notebookId, canvasId) {
    try {
        const text = localStorage.getItem(key(account, notebookId, canvasId));
        if (!text || new TextEncoder().encode(text).length > CANVAS_LIMITS.bytes + 2048) return null;
        const draft = JSON.parse(text);
        if (draft.schema !== 1 || draft.account !== account || draft.notebookId !== notebookId || draft.canvasId !== canvasId
            || !/^[a-f\d]{64}$/.test(draft.baseRevision)) return null;
        validateCanvasDocument(draft.document);
        return draft;
    } catch { return null; }
}

export function saveCanvasDraft(account, notebookId, canvasId, document, baseRevision) {
    try {
        validateCanvasDocument(document);
        if (!account || !/^nb_[a-f\d]{16}$/.test(notebookId) || !/^cv_[a-f\d]{16}$/.test(canvasId) || !/^[a-f\d]{64}$/.test(baseRevision)) return false;
        localStorage.setItem(key(account, notebookId, canvasId), JSON.stringify({ schema: 1, account, notebookId, canvasId,
            baseRevision, document, at: Date.now() }));
        return true;
    } catch { return false; }
}

export function clearCanvasDraft(account, notebookId, canvasId) {
    try { localStorage.removeItem(key(account, notebookId, canvasId)); } catch { /* Keep the owner copy if storage is unavailable. */ }
}
