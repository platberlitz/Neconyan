import { element, button, textField } from './fields.js';
import { editCreatorDraft } from './model.js';
import { renderCreatorLoreTools } from './lore-tools.js';
import { renderLoreWriter } from './lore-writer.js';

export function nextEntryId(entries) {
    let id = 0;
    while (Object.hasOwn(entries, id)) id++;
    return id;
}

/** Reconcile only Creator-managed links, retaining unrelated imported extension keys. */
export function linkCreatorBook(draft, book, { primary = !draft.card.data.extensions?.world || draft.card.data.extensions.world === book.name } = {}) {
    draft.card.data.extensions ??= {};
    if (!primary) {
        draft.additionalBooks ??= [];
        if (!draft.additionalBooks.includes(book.name)) draft.additionalBooks.push(book.name);
        return;
    }
    const previous = draft.card.data.extensions.world;
    if (previous && previous !== book.name && draft.books.some(item => item.name === previous && !item.detached && item.mode !== 'embedded')) throw new Error('Detach the current primary book before replacing its link.');
    draft.card.data.extensions.world = book.name;
}

export async function renderLore(workspace, main) {
    const draft = workspace.session.draft;
    main.append(element('h3', '', 'A world of their own'), element('p', 'creator-muted', 'Edit isolated draft copies here. Shared lorebooks affect every character that uses them when you save.'));
    for (const missing of draft.missingBooks ?? []) main.append(element('p', 'creator-muted', `Linked book unavailable: ${missing}. Its existing link is retained until you replace it.`));
    let name = '';
    const attachRow = element('div', 'creator-inline-bar');
    attachRow.append(textField('Lorebook name', name, value => { name = value; }, { rows: 1, placeholder: 'Enter lorebook name...' }));
    const actions = element('div', 'creator-actions');
    actions.append(button('Attach existing', () => workspace.run(async () => {
        const source = await workspace.session.request('book', { name });
        if (workspace.session.draft.id !== draft.id) throw new Error('The draft changed. Attach the book again.');
        workspace.edit(next => {
            if (next.books.some(book => book.name === source.name && !book.detached)) throw new Error('This lorebook is already attached.');
            const book = { id: crypto.randomUUID(), ...source, original: structuredClone(source.data), mode: 'linked' };
            next.books.push(book); linkCreatorBook(next, book);
        }, true);
    })), button('New lorebook', () => workspace.edit(next => {
        if (!name.trim()) throw new Error('Give the lorebook a name.');
        const book = { id: crypto.randomUUID(), name: name.trim(), data: { entries: {} }, original: null, revision: null, mode: 'copy' };
        next.books.push(book); linkCreatorBook(next, book);
    }, true), true));
    attachRow.append(actions);
    main.append(attachRow);
    for (const book of draft.books.filter(item => !item.detached)) {
        const panel = element('section', 'creator-book');
        const bookHeader = element('div', 'creator-section-header');
        bookHeader.append(
            element('h3', '', book.name),
            element('span', 'creator-badge', book.mode === 'linked' ? 'Shared library book' : book.mode === 'embedded' ? 'Portable inside card' : 'Independent copy'),
        );
        panel.append(bookHeader, element('p', 'creator-muted', book.mode === 'linked' ? 'Shared book: saving updates this book for all its users.' : book.mode === 'embedded' ? 'Portable: saved inside this card.' : 'Independent book: a new file is created on save.'));
        renderCreatorLoreTools(workspace, panel, book);
        renderLoreWriter(workspace, panel, book);
        let copyName = `${book.name} copy`;
        const ownershipRow = element('div', 'creator-inline-bar');
        ownershipRow.append(textField('Independent copy name', copyName, value => { copyName = value; }, { rows: 1 }));
        const ownershipActions = element('div', 'creator-actions');
        ownershipActions.append(button('Make independent', () => workspace.edit(next => {
            if (!copyName.trim() || copyName === book.name) throw new Error('Give the independent copy a different name.');
            const current = next.books.find(item => item.id === book.id);
            next.additionalBooks = (next.additionalBooks ?? []).filter(name => name !== current.name);
            if (next.card.data.extensions?.world === current.name) delete next.card.data.extensions.world;
            if (current.mode === 'embedded') delete next.card.data.character_book;
            current.mode = 'copy'; current.name = copyName.trim(); current.revision = null;
            linkCreatorBook(next, current);
        }, true), false, 'creator-chip-btn'));
        if (book.mode !== 'embedded') ownershipActions.append(button('Store inside this card', () => workspace.edit(next => {
            if (next.books.some(item => item.mode === 'embedded' && !item.detached)) throw new Error('This card already has a portable book. Detach it first.');
            const current = next.books.find(item => item.id === book.id);
            current.mode = 'embedded';
            next.additionalBooks = (next.additionalBooks ?? []).filter(name => name !== current.name);
            if (next.card.data.extensions?.world === current.name) delete next.card.data.extensions.world;
        }, true), false, 'creator-chip-btn'));
        ownershipActions.append(button('Detach', () => workspace.edit(next => {
            next.books.find(item => item.id === book.id).detached = true;
            next.additionalBooks = (next.additionalBooks ?? []).filter(name => name !== book.name);
            if (next.card.data.extensions?.world === book.name) delete next.card.data.extensions.world;
        }, true), false, 'creator-chip-btn creator-danger-outline'));
        ownershipRow.append(ownershipActions);
        panel.append(ownershipRow);
        const list = element('div', 'creator-entry-list');
        const filterHeader = element('div', 'creator-inline-bar');
        filterHeader.append(
            textField('Filter entries', '', value => {
                for (const item of list.children) item.hidden = !item.dataset.search.includes(value.toLocaleLowerCase());
            }, { rows: 1, placeholder: 'Filter by title, key or content...' }),
            button('Add entry', () => workspace.edit(next => {
                const entries = next.books.find(item => item.id === book.id).data.entries;
                const uid = nextEntryId(entries);
                entries[uid] = { uid, key: [], keysecondary: [], comment: '', content: next.writing?.loreBrackets === false ? '' : '[\n\n]', constant: false, selective: true, order: 100, position: 0, disable: false };
            }, true), true),
        );
        panel.append(filterHeader);
        for (const [uid, entry] of Object.entries(book.data.entries)) {
            const row = element('details', 'creator-review-item creator-lore-entry');
            row.dataset.search = `${entry.comment} ${(entry.key ?? []).join(' ')} ${entry.content}`.toLocaleLowerCase();
            row.append(element('summary', '', `${entry.disable ? 'Disabled: ' : ''}${entry.comment || `Entry ${uid}`}${entry.agentBlacklisted ? ' · Protected from AI' : ''}`));
            const update = change => workspace.edit(next => change(next.books.find(item => item.id === book.id).data.entries[uid]));
            const entryGrid = element('div', 'creator-form-grid');
            entryGrid.append(
                textField('Entry title', entry.comment, value => update(item => { item.comment = value; }), { rows: 1 }),
                textField('Keys, one per line', (entry.key ?? []).join('\n'), value => update(item => { item.key = value.split('\n').map(key => key.trim()).filter(Boolean); }), { rows: 2 }),
            );
            row.append(entryGrid);
            row.append(textField('Content', entry.content, value => update(item => { item.content = value; }), { rows: 4 }));
            const entryActions = element('div', 'creator-actions');
            entryActions.append(
                button(entry.disable ? 'Enable' : 'Disable', () => { update(item => { item.disable = !item.disable; }); workspace.render(); }, false, 'creator-chip-btn'),
                button(entry.constant ? 'Use matching keys' : 'Always include', () => { update(item => { item.constant = !item.constant; }); workspace.render(); }, false, 'creator-chip-btn'),
                button('Duplicate', () => workspace.edit(next => {
                    const entries = next.books.find(item => item.id === book.id).data.entries;
                    const id = nextEntryId(entries);
                    entries[id] = { ...structuredClone(entries[uid]), uid: id, comment: `${entry.comment || 'Entry'} copy` };
                }, true), false, 'creator-chip-btn'),
                button('Delete entry', () => workspace.edit(next => { delete next.books.find(item => item.id === book.id).data.entries[uid]; }, true), false, 'creator-chip-btn creator-danger-outline'),
            );
            row.append(entryActions);
            const advanced = element('details', 'creator-subdetails');
            advanced.append(element('summary', '', 'All entry settings'));
            let advancedBefore;
            let advancedText;
            const editor = element('div', 'creator-subdetails-body');
            advanced.append(editor);
            advanced.addEventListener('toggle', () => {
                if (!advanced.open) return;
                advancedBefore = structuredClone(workspace.session.draft.books.find(item => item.id === book.id).data.entries[uid]);
                advancedText = JSON.stringify(advancedBefore, null, 2);
                editor.replaceChildren(textField('Native entry settings', advancedText, value => { advancedText = value; }, { rows: 6, className: 'creator-mono-field' }));
                editor.append(button('Apply entry settings', () => workspace.run(async () => {
                    const { mergeCreatorEntrySettings } = await import('./lore-entry.js');
                    const edited = JSON.parse(advancedText);
                    workspace.edit(next => {
                        const entries = next.books.find(item => item.id === book.id).data.entries;
                        entries[uid] = mergeCreatorEntrySettings(advancedBefore, entries[uid], edited);
                    }, true);
                }), true, 'creator-chip-btn'));
            });
            row.append(advanced);
            list.append(row);
        }
        panel.append(list);
        main.append(panel);
    }
}

export function applyLoreProposal(draft, proposal) {
    if (proposal.draftId !== draft.id) throw new Error('This proposal belongs to another draft.');
    return editCreatorDraft(draft, next => {
        const book = next.books.find(item => item.id === proposal.bookId);
        if (!book || JSON.stringify(book.data) !== proposal.before) throw new Error('The lorebook changed. Request a fresh proposal.');
        for (const entry of Object.values(book.data.entries)) {
            if (entry.agentBlacklisted && JSON.stringify(proposal.data.entries[entry.uid]) !== JSON.stringify(entry)) throw new Error('This entry is protected from AI changes.');
        }
        book.data = structuredClone(proposal.data);
    });
}
