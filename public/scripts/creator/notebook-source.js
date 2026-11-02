/** Import an explicit saved-note snapshot; never resolve links or read other notes. */
export function appendCreatorNote(draft, { notebookId, note }) {
    if (!notebookId || !note?.id || typeof note.text !== 'string' || typeof note.title !== 'string') throw new Error('This note could not be read.');
    const source = { notebookId, noteId: note.id, revision: note.revision, title: note.title };
    if (draft.notebookSources?.some(item => item.notebookId === notebookId && item.noteId === note.id && item.revision === note.revision)) throw new Error('This version of the note is already in the Dossier.');
    const dossier = [draft.dossier, `## ${note.title}\n\n${note.text}`].filter(Boolean).join('\n\n');
    if (dossier.length > 100000) throw new Error('These notes exceed the Dossier limit. Import a shorter note or shorten the Dossier first.');
    draft.dossier = dossier;
    draft.notebookSources = [...(draft.notebookSources ?? []), source];
}
