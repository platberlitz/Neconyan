const PREFIX = 'neconyan-notes-draft';
const MAX_DRAFT_CHARS = 4 * 1024 * 1024;

function storage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

export function draftKey(account, notebookId, noteId) {
    return `${PREFIX}:${encodeURIComponent(String(account ?? ''))}:${notebookId}:${noteId}`;
}

/**
 * Drafts are kept per account, notebook and note so one login never sees or uploads another login's drafts.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function saveDraft(account, notebookId, noteId, { text, baseRevision }) {
    const store = storage();
    if (!store) return { ok: false, reason: 'unavailable' };
    if (typeof text !== 'string' || text.length > MAX_DRAFT_CHARS) return { ok: false, reason: 'too-large' };
    try {
        store.setItem(draftKey(account, notebookId, noteId), JSON.stringify({ schema: 1, account, text, baseRevision: baseRevision ?? null, at: Date.now() }));
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: error?.name === 'QuotaExceededError' ? 'quota' : 'unavailable' };
    }
}

export function readDraft(account, notebookId, noteId) {
    const store = storage();
    if (!store) return null;
    try {
        const value = JSON.parse(store.getItem(draftKey(account, notebookId, noteId)) ?? 'null');
        if (!value || value.schema !== 1 || value.account !== account || typeof value.text !== 'string') return null;
        return value;
    } catch {
        return null;
    }
}

export function clearDraft(account, notebookId, noteId) {
    try {
        storage()?.removeItem(draftKey(account, notebookId, noteId));
    } catch {
        /* Storage can be unavailable in private windows. */
    }
}

export function listDrafts(account, notebookId) {
    const store = storage();
    if (!store) return [];
    const prefix = `${PREFIX}:${encodeURIComponent(String(account ?? ''))}:${notebookId}:`;
    const drafts = [];
    try {
        for (let index = 0; index < store.length; index++) {
            const key = store.key(index);
            if (!key?.startsWith(prefix)) continue;
            const noteId = key.slice(prefix.length);
            const draft = readDraft(account, notebookId, noteId);
            if (draft) drafts.push({ noteId, ...draft });
        }
    } catch {
        return drafts;
    }
    return drafts;
}
