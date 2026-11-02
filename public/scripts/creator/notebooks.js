import { notesRequest } from '../notebooks/api.js';
import { element, button, textField } from './fields.js';
import { appendCreatorNote } from './notebook-source.js';

export async function renderCreatorNotebooks(workspace, main) {
    const draftId = workspace.session.draft.id;
    const current = () => {
        workspace.session.assertOwner();
        if (workspace.session.draft.id !== draftId || !main.isConnected) throw new Error('Return to this draft before importing notes.');
    };
    const request = async (route, body) => {
        current();
        const result = await notesRequest(route, body);
        current();
        if (result.status !== 'success') throw new Error(result.message || 'Notebooks could not be loaded.');
        return result;
    };
    main.append(element('h3', '', 'Notebook sources'), element('p', 'creator-muted', 'Choose saved notes to copy into the Dossier. You can edit the copied text before conversion. Only the notes you import are included; future notebook edits do not change this draft.'));
    const libraries = element('div', 'creator-actions');
    const results = element('div', 'creator-stack');
    const preview = element('div', 'creator-stack');
    main.append(libraries, results, preview);
    const showNote = async (notebookId, noteId) => {
        const result = await request('/notes/read', { notebookId, noteId });
        preview.replaceChildren(element('h4', '', result.note.title));
        const field = textField('Note preview', result.note.text, () => {}, { rows: 10 });
        field.querySelector('textarea').readOnly = true;
        preview.append(field, button('Copy note into Dossier', () => workspace.run(async () => {
            current();
            workspace.edit(next => appendCreatorNote(next, { notebookId, note: result.note }));
            await workspace.session.save();
            workspace.status('Note copied into the Dossier. The notebook is unchanged.');
        }), true));
    };
    const showNotes = async (notebookId, offset = 0) => {
        const result = await request('/notes/list', { notebookId, folder: null, offset, limit: 50 });
        results.replaceChildren(); preview.replaceChildren();
        for (const note of result.notes ?? []) results.append(button(note.title || note.path || 'Untitled note', () => workspace.run(() => showNote(notebookId, note.id))));
        if (!result.notes?.length) results.append(element('p', 'creator-muted', 'No saved notes in this notebook.'));
        if (offset) results.append(button('Previous notes', () => workspace.run(() => showNotes(notebookId, Math.max(0, offset - 50)))));
        if (offset + 50 < result.total) results.append(button('Next notes', () => workspace.run(() => showNotes(notebookId, offset + 50))));
    };
    const { notebooks = [] } = await request('/list');
    for (const notebook of notebooks) libraries.append(button(notebook.name || notebook.title || 'Notebook', () => workspace.run(() => showNotes(notebook.id))));
    if (!notebooks.length) libraries.append(element('p', 'creator-muted', 'Create a notebook in Notebooks, then return here to import its notes.'));
    for (const source of workspace.session.draft.notebookSources ?? []) main.append(element('p', 'creator-muted', `Imported: ${source.title}`));
}
