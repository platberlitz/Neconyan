import { element, button, textField } from './fields.js';
import { editCreatorDraft } from './model.js';

/** Deliberately advisory; this does not emulate timed effects, recursion or vector retrieval. */
export function inspectCreatorKeys(book, text) {
    return Object.values(book.data.entries).map(entry => {
        const keys = (entry.key ?? []).filter(key => typeof key === 'string' && !key.startsWith('/'));
        const haystack = entry.caseSensitive ? text : text.toLocaleLowerCase();
        const matched = keys.filter(key => key && haystack.includes(entry.caseSensitive ? key : key.toLocaleLowerCase()));
        return { uid: entry.uid, title: entry.comment || `Entry ${entry.uid}`, matched,
            reason: entry.disable ? 'Disabled' : entry.constant ? 'Always included before other runtime rules' : matched.length ? 'Text contains a primary key' : 'No literal primary key found' };
    });
}

export function acceptCreatorBulkLore(draft, proposal) {
    if (draft.id !== proposal.draftId) throw new Error('This review belongs to another draft.');
    const book = draft.books.find(item => item.id === proposal.bookId && !item.detached);
    if (!book || JSON.stringify(book.data) !== proposal.before) throw new Error('This book changed. Preview the operation again.');
    return editCreatorDraft(draft, next => {
        const entries = next.books.find(item => item.id === book.id).data.entries;
        for (const change of proposal.changes) {
            if (!Object.hasOwn(entries, change.uid) || !['content', 'disable'].includes(change.field)) throw new Error('Invalid reviewed entry change.');
            entries[change.uid][change.field] = change.after;
        }
    });
}

export function renderCreatorLoreTools(workspace, panel, book) {
    const tools = element('details', 'creator-review-item');
    tools.append(element('summary', '', 'Check keys and bulk edit'));
    let sample = '', pattern = '', replacement = '';
    tools.append(textField('Sample conversation for key check', sample, value => { sample = value; }));
    const results = element('div');
    tools.append(button('Check literal keys', () => {
        const current = workspace.session.draft.books.find(item => item.id === book.id);
        results.replaceChildren(element('p', 'creator-muted', 'Advisory substring check only. Word boundaries, secondary keys, regular-expression keys, budgets, recursion, probability, vectors and timed effects are not simulated.'));
        for (const row of inspectCreatorKeys(current, sample)) results.append(element('p', '', `${row.title}: ${row.reason}${row.matched.length ? ` (${row.matched.join(', ')})` : ''}`));
    }), results);
    tools.append(element('h4', '', 'Bulk changes'));
    const selected = new Set();
    for (const [uid, entry] of Object.entries(book.data.entries)) {
        const label = element('label', 'creator-bulk-choice');
        const check = element('input'); check.type = 'checkbox';
        check.addEventListener('change', () => check.checked ? selected.add(uid) : selected.delete(uid));
        label.append(check, document.createTextNode(entry.comment || `Entry ${uid}`)); tools.append(label);
    }
    tools.append(textField('Find regular expression', pattern, value => { pattern = value; }, { rows: 2 }), textField('Replacement text', replacement, value => { replacement = value; }, { rows: 3 }));
    const review = element('div');
    const preview = kind => workspace.run(async () => {
        if (!selected.size) throw new Error('Choose the entries to change.');
        if (selected.size > 100) throw new Error('Review up to 100 entries at a time.');
        const draft = structuredClone(workspace.session.draft);
        const current = draft.books.find(item => item.id === book.id && !item.detached);
        if (!current) throw new Error('The book was detached.');
        const changes = [];
        const capturedPattern = pattern, capturedReplacement = replacement;
        for (const uid of selected) {
            const entry = current.data.entries[uid];
            if (!entry) throw new Error('The entry list changed. Reopen the bulk editor.');
            if (kind === 'replace') {
                const { previewCreatorRegex } = await import('./regex.js');
                const result = await previewCreatorRegex(capturedPattern, capturedReplacement, entry.content || '');
                if (result.output !== entry.content) changes.push({ uid, field: 'content', before: entry.content, after: result.output });
            } else changes.push({ uid, field: 'disable', before: entry.disable, after: kind === 'disable' });
        }
        const proposal = { draftId: draft.id, bookId: book.id, before: JSON.stringify(current.data), changes };
        review.replaceChildren(element('h4', '', `${changes.length} entry changes to review`));
        for (const change of changes) review.append(element('pre', '', `Entry ${change.uid}\nBefore: ${change.before ?? ''}\nAfter: ${change.after}`));
        if (changes.length) review.append(button('Apply reviewed changes to draft', () => {
            workspace.change(value => acceptCreatorBulkLore(value, proposal), true);
        }, true));
    });
    tools.append(button('Preview replacement', () => preview('replace')), button('Preview enable', () => preview('enable')), button('Preview disable', () => preview('disable')), review);
    panel.append(tools);
}
