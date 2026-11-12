import { fail } from './core.js';
import { ASK_CONTRACT, CONFLICT_CONTRACT } from './contracts.js';
import { callJsonRole } from './models.js';
import { lexicalSearch, searchDocuments } from './search.js';
import { brief, namer, usable } from './story.js';

export const ASK_LIMIT = 24;
export const CITATION_LIMIT = 8;
export const CONFLICT_RECORDS = 60;
export const CONFLICT_LIMIT = 10;

const CONFLICT_KINDS = new Set(['state', 'event', 'relationship', 'knowledge', 'commitment']);

function newestFirst(a, b) {
    return b.asOf - a.asOf || b.createdAt - a.createdAt;
}

function modelMemory(state, record, nameOf, text = record.text) {
    const item = brief(state, record, nameOf);
    return {
        id: record.id, kind: record.kind, text: String(text || '').slice(0, 1200), message: item.message,
        ...(item.owner ? { owner: item.owner } : {}),
        ...(item.subjects.length ? { about: item.subjects } : {}),
        ...(record.status !== 'active' ? { status: record.status } : {}),
    };
}

/** Pick the memories most likely to answer a question: matching ones first, then the newest. */
export function askCandidates(state, question, config = {}, limit = ASK_LIMIT) {
    const documents = searchDocuments(state, Infinity, config).filter(document => document.dataType === 'memory');
    const byId = new Map(state.records.map(record => [record.id, record]));
    const picked = new Map();
    for (const { document } of lexicalSearch(documents, question, limit)) {
        const record = byId.get(document.recordId);
        if (record) picked.set(record.id, { record, text: document.text });
    }
    for (const record of usable(state).filter(record => record.kind !== 'interview').sort(newestFirst)) {
        if (picked.size >= limit) break;
        if (!picked.has(record.id)) picked.set(record.id, { record, text: record.text });
    }
    return [...picked.values()].slice(0, limit);
}

/** Answer a question about the story from saved memories, citing the memories used. Changes nothing. */
export async function askMemories(directories, state, config, question, { call = callJsonRole, signal } = {}) {
    question = String(question || '').trim().slice(0, 500);
    if (!question) fail('Type a question first.', 400);
    const candidates = askCandidates(state, question, config);
    if (!candidates.length) return { question, answer: 'Mewmory has no memories for this chat yet, so it cannot answer.', citations: [], unsure: true, checked: 0 };
    const nameOf = namer(state);
    const input = { question, memories: candidates.map(({ record, text }) => modelMemory(state, record, nameOf, text)) };
    const { value } = await call(directories, config, 'extractor', ASK_CONTRACT, input, { dataTypes: ['memory'], signal });
    const answer = typeof value?.answer === 'string' ? value.answer.trim().slice(0, 2000) : '';
    if (!answer) fail('The model sent back an empty answer. Try asking again.', 502);
    const known = new Map(candidates.map(({ record }) => [record.id, record]));
    const cited = [...new Set(Array.isArray(value.citations) ? value.citations.filter(id => typeof id === 'string') : [])]
        .filter(id => known.has(id)).slice(0, CITATION_LIMIT);
    return {
        question, answer, unsure: value.unsure === true || !cited.length,
        citations: cited.map(id => brief(state, known.get(id), nameOf)), checked: candidates.length,
    };
}

/** Ask the model for pairs of current memories that cannot both be true. Changes nothing. */
export async function findConflicts(directories, state, config, { call = callJsonRole, signal } = {}) {
    const records = usable(state).filter(record => CONFLICT_KINDS.has(record.kind) && record.status !== 'resolved')
        .sort(newestFirst).slice(0, CONFLICT_RECORDS);
    if (records.length < 2) return { conflicts: [], checked: records.length };
    const nameOf = namer(state);
    const input = { memories: records.map(record => modelMemory(state, record, nameOf)) };
    const { value } = await call(directories, config, 'extractor', CONFLICT_CONTRACT, input, { dataTypes: ['memory'], signal });
    const known = new Map(records.map(record => [record.id, record]));
    const seen = new Set();
    const conflicts = [];
    for (const item of Array.isArray(value?.conflicts) ? value.conflicts : []) {
        if (conflicts.length >= CONFLICT_LIMIT) break;
        const a = typeof item?.a === 'string' ? item.a : '';
        const b = typeof item?.b === 'string' ? item.b : '';
        if (!known.has(a) || !known.has(b) || a === b) continue;
        const key = [a, b].sort().join('\n');
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({
            a: brief(state, known.get(a), nameOf), b: brief(state, known.get(b), nameOf),
            explanation: typeof item.explanation === 'string' ? item.explanation.trim().slice(0, 400) : '',
        });
    }
    return { conflicts, checked: records.length };
}
