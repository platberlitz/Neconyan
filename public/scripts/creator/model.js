/** Creator documents retain the complete imported card, including unknown extensions. */
export const CREATOR_SCHEMA = 1;
import { creatorTargetsSignature } from './formats.js';
export const TEXT_FIELDS = Object.freeze(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version']);
export const PROPOSAL_FIELDS = Object.freeze([...TEXT_FIELDS, 'depth_prompt', 'alternate_greetings']);
export const validCreatorProposalValue = (field, value) => field === 'alternate_greetings'
    ? Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === 'string' && item.length <= 100000) && value.join('').length <= 1000000
    : typeof value === 'string' && value.length <= 100000;
export const creatorTextValue = (draft, field) => field === 'depth_prompt' ? draft.card.data.extensions?.depth_prompt?.prompt ?? '' : draft.card.data[field] ?? (field === 'alternate_greetings' ? [] : '');
export const FACT_SECTIONS = Object.freeze(['identity', 'appearance', 'traits', 'goals', 'limits', 'relationships', 'history', 'voice', 'scenario']);
export const STYLES = Object.freeze(['plain', 'plist', 'alichat', 'hybrid']);
const copy = value => structuredClone(value);

export function createCreatorDraft({ id, card, avatar = null, revision = null, extraBooks = [] }) {
    const original = copy(card ?? { spec: 'chara_card_v2', spec_version: '2.0', data: {} });
    const document = copy(original);
    if (!document.data || typeof document.data !== 'object' || Array.isArray(document.data)) document.data = {};
    for (const field of TEXT_FIELDS) {
        if (document.data[field] === undefined) document.data[field] = String(document[field === 'creator_notes' ? 'creatorcomment' : field] ?? '');
    }
    return {
        schema: CREATOR_SCHEMA, id, source: { avatar, revision, original, extraBooks: copy(extraBooks) }, card: document, additionalBooks: copy(extraBooks),
        facts: [], style: 'plain', rawAhead: false, privateNotes: '', dossier: '', locks: [], books: [],
        media: [], selectedMedia: null, proposals: [], journal: null,
        view: { section: 'identity', selection: null }, history: [], future: [],
    };
}

export function validateCreatorDraft(draft) {
    if (!draft || draft.schema !== CREATOR_SCHEMA || !/^[a-zA-Z0-9_-]{1,64}$/.test(draft.id ?? '')) throw new Error('This Creator draft format is not supported.');
    if (!draft.card?.data || typeof draft.card.data !== 'object' || Array.isArray(draft.card.data)) throw new Error('The character data is missing.');
    for (const key of ['facts', 'locks', 'books', 'media', 'proposals', 'history', 'future']) {
        if (!Array.isArray(draft[key])) throw new Error(`The draft ${key} must be a list.`);
    }
    if (draft.history.length > 50 || draft.future.length > 50) throw new Error('The draft undo history is too large.');
    if (draft.dossier !== undefined && (typeof draft.dossier !== 'string' || draft.dossier.length > 100000)) throw new Error('Keep the dossier within 100,000 characters.');
    if (!draft.source || typeof draft.source !== 'object' || !draft.view || typeof draft.view.section !== 'string') throw new Error('The draft source or workspace settings are missing.');
    for (const field of TEXT_FIELDS) {
        if (typeof draft.card.data[field] !== 'string' || draft.card.data[field].length > 100000) throw new Error(`The character ${field} must be text within 100,000 characters.`);
    }
    if (typeof draft.privateNotes !== 'string' || !draft.locks.every(field => PROPOSAL_FIELDS.includes(field))) throw new Error('The draft notes or field locks are invalid.');
    if (!draft.facts.every(fact => fact && typeof fact.id === 'string' && FACT_SECTIONS.includes(fact.section) && typeof fact.text === 'string' && ['decided', 'tentative', 'open'].includes(fact.status))) throw new Error('The guided facts are invalid.');
    if (!draft.books.every(book => book && typeof book.id === 'string' && typeof book.name === 'string' && ['linked', 'copy', 'embedded'].includes(book.mode) && book.data?.entries && typeof book.data.entries === 'object' && !Array.isArray(book.data.entries))) throw new Error('The draft lorebooks are invalid.');
    if (draft.additionalBooks !== undefined && (!Array.isArray(draft.additionalBooks) || !draft.additionalBooks.every(name => typeof name === 'string'))) throw new Error('The additional lorebook names are invalid.');
    return draft;
}

function snapshot(draft) {
    return copy(Object.fromEntries(Object.entries(draft).filter(([key]) => !['history', 'future', 'journal'].includes(key))));
}

function boundedHistory(entries) {
    let bytes = 0;
    const kept = [];
    for (const entry of entries.slice(-50).reverse()) {
        bytes += JSON.stringify(entry).length;
        if (kept.length && bytes > 1024 * 1024) break;
        kept.unshift(entry);
    }
    return kept;
}

export function editCreatorDraft(draft, operation) {
    const next = copy(draft);
    operation(next);
    next.history = boundedHistory([...draft.history, snapshot(draft)]);
    next.future = [];
    return validateCreatorDraft(next);
}

export function undoCreatorDraft(draft, redo = false) {
    const from = redo ? 'future' : 'history';
    const to = redo ? 'history' : 'future';
    if (!draft[from].length) return draft;
    return { ...copy(draft[from].at(-1)), journal: draft.journal, [from]: draft[from].slice(0, -1), [to]: boundedHistory([...draft[to], snapshot(draft)]) };
}

export function setCreatorField(draft, field, value, { generated = false } = {}) {
    if (!TEXT_FIELDS.includes(field)) throw new Error('Choose a supported character field.');
    if (generated && draft.locks.includes(field)) throw new Error('Unlock this field before accepting generated changes.');
    if (typeof value !== 'string') throw new Error('Character text must be a string.');
    return editCreatorDraft(draft, next => {
        next.card.data[field] = value;
        const alias = field === 'creator_notes' ? 'creatorcomment' : field;
        if (Object.hasOwn(next.card, alias)) next.card[alias] = value;
        if (['description', 'personality', 'scenario'].includes(field)) next.rawAhead = true;
    });
}

/** Deterministic rendering never invents facts or overwrites raw text. */
export function renderCreatorFacts(draft, style = draft.style) {
    if (!STYLES.includes(style)) throw new Error('Choose a supported writing format.');
    const facts = draft.facts.filter(fact => fact.visibility !== 'private' && fact.status === 'decided' && String(fact.text ?? '').trim());
    const lines = facts.map(fact => `${fact.section}: ${fact.text}`);
    const plain = lines.join('\n');
    const plist = facts.map(fact => `${fact.section}: ${JSON.stringify(String(fact.text))}`).join(';\n');
    const interview = facts.map(fact => `Interviewer: Tell me about your ${fact.section}.\n{{char}}: ${fact.text}`).join('\n\n');
    const propertyField = style === 'plist' && draft.writing?.plistDestination === 'depth_prompt' ? 'depth_prompt' : 'description';
    return { style, version: 1, fields: style === 'alichat' ? { mes_example: interview } : style === 'hybrid' ? { description: plain, mes_example: interview } : { [propertyField]: style === 'plist' ? plist : plain }, kept: facts.map(fact => fact.id), excluded: draft.facts.filter(fact => !facts.includes(fact)).map(fact => fact.id) };
}

/** Every proposed field keeps its exact before-value, so late replies cannot overwrite edits. */
export function creatorProposal(draft, fields, label) {
    const changes = Object.entries(fields).map(([field, after]) => {
        if (!PROPOSAL_FIELDS.includes(field) || !validCreatorProposalValue(field, after)) throw new Error('The proposal contains an unsupported field.');
        return { field, before: copy(field === 'alternate_greetings' ? draft.card.data[field] ?? [] : creatorTextValue(draft, field)), after: copy(after) };
    });
    return { id: globalThis.crypto.randomUUID(), draftId: draft.id, label, changes };
}

export function acceptCreatorProposal(draft, proposal, selected = proposal.changes.map(change => change.field)) {
    if (proposal.draftId !== draft.id) throw new Error('This proposal belongs to another draft.');
    if (proposal.formatBefore !== undefined && proposal.formatBefore !== draft.style) throw new Error('The writing format changed. Review a fresh conversion.');
    if (proposal.targetsBefore !== undefined && proposal.targetsBefore !== creatorTargetsSignature(draft)) throw new Error('The conversion targets changed. Review a fresh conversion.');
    if (proposal.dossierBefore !== undefined && proposal.dossierBefore !== (draft.dossier ?? '')) throw new Error('The dossier changed. Convert the updated dossier before applying these fields.');
    const changes = proposal.changes.filter(change => selected.includes(change.field));
    for (const change of changes) {
        if (!PROPOSAL_FIELDS.includes(change.field) || !validCreatorProposalValue(change.field, change.after)) throw new Error('The proposal contains an unsupported field.');
        if (draft.locks.includes(change.field)) throw new Error(`The ${change.field} field is locked.`);
        const current = change.field === 'alternate_greetings' ? draft.card.data.alternate_greetings ?? [] : creatorTextValue(draft, change.field);
        if (JSON.stringify(current) !== JSON.stringify(change.before)) throw new Error(`The ${change.field} field changed. Review a fresh proposal.`);
    }
    return editCreatorDraft(draft, next => {
        for (const change of changes) {
            if (change.field === 'depth_prompt') {
                next.card.data.extensions ??= {};
                next.card.data.extensions.depth_prompt = { depth: 4, role: 'system', ...next.card.data.extensions.depth_prompt, prompt: change.after };
                continue;
            }
            next.card.data[change.field] = copy(change.after);
            const alias = change.field === 'creator_notes' ? 'creatorcomment' : change.field;
            if (Object.hasOwn(next.card, alias)) next.card[alias] = copy(change.after);
        }
        if (proposal.id) {
            next.proposals = next.proposals.flatMap(item => {
                if (item.id !== proposal.id) return [item];
                const remaining = proposal.changes.filter(change => !selected.includes(change.field));
                return remaining.length ? [{ ...copy(proposal), changes: remaining }] : [];
            });
        }
    });
}

export function creatorAssistantContext(draft, { includePrivate = false } = {}) {
    return {
        character: Object.fromEntries(TEXT_FIELDS.map(field => [field, draft.card.data[field] ?? ''])),
        facts: copy(draft.facts.filter(fact => includePrivate || fact.visibility !== 'private')),
        lorebooks: draft.books.filter(book => !book.detached).map(book => ({ name: book.name, entries: Object.values(book.data?.entries ?? {}).filter(entry => !entry.agentBlacklisted).map(entry => ({ uid: entry.uid, comment: entry.comment, key: entry.key, content: entry.content })) })),
        ...(includePrivate ? { privateNotes: draft.privateNotes } : {}),
    };
}
