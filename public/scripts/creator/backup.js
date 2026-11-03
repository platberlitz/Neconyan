import { validateCreatorDraft } from './model.js';

/** A restored backup is a new private draft, never authority to overwrite an old account. */
export function restoreCreatorBackup(value, id = globalThis.crypto.randomUUID()) {
    if (value?.format !== 'neconyan-creator-backup' || value.version !== 1) throw new Error('Choose a Catelier private draft backup.');
    const draft = structuredClone(validateCreatorDraft(value.draft));
    draft.id = id;
    draft.source = { avatar: null, revision: null, original: structuredClone(draft.card), extraBooks: [] };
    draft.journal = null;
    draft.history = [];
    draft.future = [];
    draft.proposals = [];
    // External names from a different account are not publication permissions.
    draft.additionalBooks = [];
    if (draft.card.data.extensions) delete draft.card.data.extensions.world;
    draft.books = draft.books.filter(book => !book.detached).map(book => ({
        ...book, id: globalThis.crypto.randomUUID(), revision: null,
        mode: book.mode === 'embedded' ? 'embedded' : 'copy',
    }));
    const external = draft.books.filter(book => book.mode === 'copy');
    if (external.length) {
        draft.card.data.extensions ??= {};
        draft.card.data.extensions.world = external[0].name;
        draft.additionalBooks = external.slice(1).map(book => book.name);
    }
    return validateCreatorDraft(draft);
}
