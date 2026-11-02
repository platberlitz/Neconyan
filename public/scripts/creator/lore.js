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
    main.append(textField('Lorebook name', name, value => { name = value; }, { rows: 1 }));
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
    }, true)));
    main.append(actions);
    for (const book of draft.books.filter(item => !item.detached)) {
        const panel = element('section', 'creator-book');
        panel.append(element('h3', '', book.name), element('p', 'creator-muted', book.mode === 'linked' ? 'Shared book: saving updates this book for all its users.' : book.mode === 'embedded' ? 'Portable: saved inside this card.' : 'Independent book: a new file is created on save.'));
        renderCreatorLoreTools(workspace, panel, book);
        renderLoreWriter(workspace, panel, book);
        let copyName = `${book.name} copy`;
        panel.append(textField('Independent copy name', copyName, value => { copyName = value; }, { rows: 1 }));
        panel.append(button('Make independent', () => workspace.edit(next => {
            if (!copyName.trim() || copyName === book.name) throw new Error('Give the independent copy a different name.');
            const current = next.books.find(item => item.id === book.id);
            next.additionalBooks = (next.additionalBooks ?? []).filter(name => name !== current.name);
            if (next.card.data.extensions?.world === current.name) delete next.card.data.extensions.world;
            if (current.mode === 'embedded') delete next.card.data.character_book;
            current.mode = 'copy'; current.name = copyName.trim(); current.revision = null;
            linkCreatorBook(next, current);
        }, true)));
        if (book.mode !== 'embedded') panel.append(button('Store inside this card', () => workspace.edit(next => {
            if (next.books.some(item => item.mode === 'embedded' && !item.detached)) throw new Error('This card already has a portable book. Detach it first.');
            const current = next.books.find(item => item.id === book.id);
            current.mode = 'embedded';
            next.additionalBooks = (next.additionalBooks ?? []).filter(name => name !== current.name);
            if (next.card.data.extensions?.world === current.name) delete next.card.data.extensions.world;
        }, true)));
        panel.append(button('Detach', () => workspace.edit(next => {
            next.books.find(item => item.id === book.id).detached = true;
            next.additionalBooks = (next.additionalBooks ?? []).filter(name => name !== book.name);
            if (next.card.data.extensions?.world === book.name) delete next.card.data.extensions.world;
        }, true)));
        const list = element('div');
        panel.append(textField('Filter entries', '', value => {
            for (const item of list.children) item.hidden = !item.dataset.search.includes(value.toLocaleLowerCase());
        }, { rows: 1 }));
        for (const [uid, entry] of Object.entries(book.data.entries)) {
            const row = element('details', 'creator-review-item');
            row.dataset.search = `${entry.comment} ${(entry.key ?? []).join(' ')} ${entry.content}`.toLocaleLowerCase();
            row.append(element('summary', '', `${entry.disable ? 'Disabled: ' : ''}${entry.comment || `Entry ${uid}`}${entry.agentBlacklisted ? ' · Protected from AI' : ''}`));
            const update = change => workspace.edit(next => change(next.books.find(item => item.id === book.id).data.entries[uid]));
            row.append(textField('Entry title', entry.comment, value => update(item => { item.comment = value; }), { rows: 1 }));
            row.append(textField('Keys, one per line', (entry.key ?? []).join('\n'), value => update(item => { item.key = value.split('\n').map(key => key.trim()).filter(Boolean); }), { rows: 2 }));
            row.append(textField('Content', entry.content, value => update(item => { item.content = value; })));
            row.append(button(entry.disable ? 'Enable' : 'Disable', () => { update(item => { item.disable = !item.disable; }); workspace.render(); }));
            row.append(button(entry.constant ? 'Use matching keys' : 'Always include', () => { update(item => { item.constant = !item.constant; }); workspace.render(); }));
            const advanced = element('details');
            advanced.append(element('summary', '', 'All entry settings'));
            workspace.jsonField(advanced, 'Native entry settings', entry, value => {
                if (!value || typeof value !== 'object' || Array.isArray(value) || String(value.uid) !== String(entry.uid)) throw new Error('Keep the entry UID unchanged.');
                update(item => { for (const key of Object.keys(item)) delete item[key]; Object.assign(item, value); });
            });
            row.append(advanced);
            row.append(button('Duplicate', () => workspace.edit(next => {
                const entries = next.books.find(item => item.id === book.id).data.entries;
                const id = nextEntryId(entries);
                entries[id] = { ...structuredClone(entries[uid]), uid: id, comment: `${entry.comment || 'Entry'} copy` };
            }, true)), button('Delete entry', () => workspace.edit(next => { delete next.books.find(item => item.id === book.id).data.entries[uid]; }, true)));
            list.append(row);
        }
        panel.append(list, button('Add entry', () => workspace.edit(next => {
            const entries = next.books.find(item => item.id === book.id).data.entries;
            const uid = nextEntryId(entries);
            entries[uid] = { uid, key: [], keysecondary: [], comment: '', content: '', constant: false, selective: true, order: 100, position: 0, disable: false };
        }, true)));
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
