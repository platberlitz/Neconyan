import { currentRecords, recordEligible } from './core.js';
import { names } from './markdown.js';

export const RECAP_LIMIT = 8;
export const PROMISE_LIMIT = 40;
export const MAP_NODE_LIMIT = 24;
export const PAGE_LIMIT = 40;

const RANK = { high: 2, medium: 1, low: 0 };

function usable(state) {
    return state.records.filter(record => record.status !== 'invalidated' && recordEligible(state, record));
}

function newestFirst(a, b) {
    return b.asOf - a.asOf || b.createdAt - a.createdAt;
}

function offsetOf(state) {
    return state.inheritedTimeline?.length || 0;
}

function brief(state, record, nameOf) {
    const offset = offsetOf(state);
    return {
        id: record.id,
        kind: record.kind,
        text: record.text || '',
        asOf: record.asOf,
        message: record.asOf >= 0 ? record.asOf - offset + 1 : 0,
        significance: record.significance || 'low',
        status: record.status,
        pinned: Boolean(record.pinned),
        ownerId: record.ownerId || '',
        owner: record.ownerId ? nameOf(record.ownerId) : '',
        subjects: (record.subjectIds || []).map(nameOf),
        ...(record.kind === 'commitment' ? { triggerTerms: [...(record.triggerTerms || [])] } : {}),
    };
}

function namer(state) {
    const known = names(state);
    return id => known.get(id) || id;
}

/** A no-model 'previously on': the latest story events, keeping the important ones when there are many. */
export function storyRecap(state, { limit = RECAP_LIMIT } = {}) {
    const nameOf = namer(state);
    const events = usable(state).filter(record => record.kind === 'event' && record.status !== 'background').sort(newestFirst);
    const window = events.slice(0, limit * 3);
    const chosen = new Set(window
        .map((record, order) => ({ record, order }))
        .sort((a, b) => (RANK[b.record.significance] ?? 0) - (RANK[a.record.significance] ?? 0) || a.order - b.order)
        .slice(0, limit)
        .map(entry => entry.record));
    const picked = window.filter(record => chosen.has(record)).reverse();
    return { total: events.length, events: picked.map(record => brief(state, record, nameOf)) };
}

/** Promises and plans that are still open, newest first. */
export function openPromises(state, { limit = PROMISE_LIMIT } = {}) {
    const nameOf = namer(state);
    const open = usable(state).filter(record => record.kind === 'commitment' && (record.status === 'active' || record.status === 'uncertain')).sort(newestFirst);
    return { total: open.length, promises: open.slice(0, limit).map(record => brief(state, record, nameOf)) };
}

/**
 * Who is linked to whom. Relationship memories have no direction, so they link every pair of their subjects;
 * a point of view links its owner to the subject it is about, with that direction kept.
 */
export function relationshipMap(state, { limit = MAP_NODE_LIMIT } = {}) {
    const nameOf = namer(state);
    const records = usable(state);
    const nodes = new Map();
    for (const record of currentRecords(records.filter(record => record.kind === 'entity' && record.entityId), record => record.entityId)) {
        nodes.set(record.entityId, { id: record.entityId, name: record.name || nameOf(record.entityId), isCharacter: Boolean(record.isCharacter), links: 0 });
    }
    const links = new Map();
    const connect = (a, b, record, from = '') => {
        if (!a || !b || a === b) return;
        for (const id of [a, b]) if (!nodes.has(id)) nodes.set(id, { id, name: nameOf(id), isCharacter: false, links: 0 });
        const [first, second] = [a, b].sort();
        const key = first + '\u0000' + second;
        const link = links.get(key) || { a: first, b: second, records: [] };
        if (!link.records.some(entry => entry.id === record.id)) link.records.push({ ...brief(state, record, nameOf), from });
        links.set(key, link);
    };
    for (const record of records.filter(record => record.kind === 'relationship' && record.status !== 'resolved').sort(newestFirst)) {
        const subjects = [...new Set([...(record.ownerId ? [record.ownerId] : []), ...(record.subjectIds || [])])];
        for (let i = 0; i < subjects.length; i++) for (let j = i + 1; j < subjects.length; j++) connect(subjects[i], subjects[j], record);
    }
    for (const record of currentRecords(records.filter(record => record.kind === 'overview'), record => record.ownerId + '\u0000' + [...(record.subjectIds || [])].sort().join('\u0000'))) {
        for (const subject of record.subjectIds || []) connect(record.ownerId, subject, record, record.ownerId);
    }
    for (const link of links.values()) {
        nodes.get(link.a).links++;
        nodes.get(link.b).links++;
    }
    const kept = [...nodes.values()]
        .filter(node => node.links > 0)
        .sort((a, b) => Number(b.isCharacter) - Number(a.isCharacter) || b.links - a.links || a.name.localeCompare(b.name))
        .slice(0, limit);
    const keep = new Set(kept.map(node => node.id));
    const shown = [...links.values()].filter(link => keep.has(link.a) && keep.has(link.b));
    return { nodes: kept, links: shown, hidden: nodes.size - kept.length };
}

/** Everything Mewmory holds about one character or thing, grouped for reading. */
export function characterPage(state, entityId, { limit = PAGE_LIMIT } = {}) {
    const nameOf = namer(state);
    const records = usable(state);
    const sheet = currentRecords(records.filter(record => record.kind === 'entity' && record.entityId === entityId), record => record.entityId)[0] || null;
    const about = record => (record.subjectIds || []).includes(entityId);
    const pick = list => list.sort(newestFirst).slice(0, limit).map(record => brief(state, record, nameOf));
    const now = currentRecords(records.filter(record => record.kind === 'state' && (record.entityId === entityId || about(record))), record => record.entityId || record.id);
    const views = currentRecords(records.filter(record => record.kind === 'overview' && record.ownerId === entityId), record => [...(record.subjectIds || [])].sort().join('\u0000'));
    const seenBy = currentRecords(records.filter(record => record.kind === 'overview' && about(record) && record.ownerId !== entityId), record => record.ownerId);
    const page = {
        entityId,
        name: sheet?.name || nameOf(entityId),
        sheet: sheet ? { id: sheet.id, text: sheet.text || '', aliases: [...(sheet.aliases || [])], appearance: sheet.appearance || '', speech: sheet.speech || '', isCharacter: Boolean(sheet.isCharacter) } : null,
        now: pick(now),
        knows: pick(records.filter(record => record.kind === 'knowledge' && record.ownerId === entityId)),
        views: pick(views),
        seenBy: pick(seenBy),
        events: pick(records.filter(record => record.kind === 'event' && about(record))),
        relationships: pick(records.filter(record => record.kind === 'relationship' && (about(record) || record.ownerId === entityId))),
        promises: pick(records.filter(record => record.kind === 'commitment' && (about(record) || record.ownerId === entityId))),
    };
    page.total = ['now', 'knows', 'views', 'seenBy', 'events', 'relationships', 'promises'].reduce((sum, key) => sum + page[key].length, 0);
    return page;
}
