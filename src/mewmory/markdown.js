import { recordEligible } from './core.js';
import { dayKey } from './spend.js';

const SECTIONS = [
    ['entity', 'Characters, places and things'],
    ['state', 'How things are now'],
    ['event', 'What happened'],
    ['relationship', 'Relationships'],
    ['knowledge', 'Who knows what'],
    ['commitment', 'Promises and plans'],
    ['overview', 'Points of view'],
    ['interview', 'Character interviews'],
];

const STATUS_NOTES = { background: 'background', resolved: 'resolved', uncertain: 'uncertain' };

/** Keeps memory text from breaking out of its list item or starting a heading. */
function inline(value) {
    return String(value ?? '').replace(/\s*\n+\s*/g, ' ').replace(/^#+\s*/, '').trim();
}

export function names(state) {
    const found = new Map();
    for (const record of state.records) {
        for (const [id, name] of Object.entries(record.subjectNames || {})) if (name && !found.has(id)) found.set(id, name);
        if (record.kind === 'entity' && record.entityId && record.name) found.set(record.entityId, record.name);
    }
    return found;
}

function notes(record, offset, nameOf) {
    const parts = [];
    if (record.asOf >= 0) parts.push('message ' + (record.asOf - offset + 1));
    else parts.push('from the character card');
    if (record.ownerId && record.kind !== 'entity') parts.push(nameOf(record.ownerId) + '\'s view');
    if (STATUS_NOTES[record.status]) parts.push(STATUS_NOTES[record.status]);
    if (record.pinned) parts.push('pinned');
    if (record.authorOverride) parts.push('edited by you');
    return ' _(' + parts.join(', ') + ')_';
}

function entityLines(record) {
    const lines = ['### ' + inline(record.name || 'Unnamed')];
    if (record.aliases?.length) lines.push('Also called: ' + record.aliases.map(inline).join(', '));
    if (record.text) lines.push('', inline(record.text));
    if (record.appearance) lines.push('', 'Appearance: ' + inline(record.appearance));
    if (record.speech) lines.push('', 'Speech: ' + inline(record.speech));
    return [...lines, ''];
}

const LORE_KINDS = { entity: 'Character', state: 'Now', event: 'Event', relationship: 'Relationship', knowledge: 'Knowledge', commitment: 'Promise' };
const LORE_LIMIT = 500;

function shorten(value, limit) {
    const flat = inline(value);
    return flat.length > limit ? flat.slice(0, limit - 1).trimEnd() + '…' : flat;
}

/** Lorebook entries for the memories Mewmory would use now. Points of view and interviews stay out: they are one character's opinion, not world facts. */
export function loreEntries(state) {
    const known = names(state);
    const nameOf = id => known.get(id) || '';
    const records = state.records.filter(record => LORE_KINDS[record.kind] && record.status !== 'invalidated' && !record.excluded && recordEligible(state, record))
        .sort((a, b) => a.asOf - b.asOf || a.createdAt - b.createdAt).slice(0, LORE_LIMIT);
    return records.map(record => {
        const keys = new Map();
        const add = value => {
            const key = inline(value).slice(0, 80);
            if (key && !keys.has(key.toLocaleLowerCase())) keys.set(key.toLocaleLowerCase(), key);
        };
        if (record.kind === 'entity') [record.name, ...(record.aliases || [])].forEach(add);
        for (const id of record.subjectIds || []) add(record.subjectNames?.[id] || nameOf(id));
        for (const term of record.triggerTerms || []) add(term);
        const owner = record.ownerId ? nameOf(record.ownerId) : '';
        const content = record.kind === 'entity'
            ? [record.text, record.appearance && 'Appearance: ' + record.appearance, record.speech && 'Speech: ' + record.speech].filter(Boolean).join('\n\n')
            : record.kind === 'knowledge' && owner ? owner + ' knows: ' + record.text : record.text;
        return {
            id: record.id,
            version: record.version,
            title: record.kind === 'entity' ? inline(record.name || 'Unnamed') : LORE_KINDS[record.kind] + ': ' + shorten(record.text, 60),
            keys: [...keys.values()].slice(0, 12),
            content: String(content || ''),
        };
    });
}

/** A readable copy of the memories Mewmory would use now. Retired and unavailable memories are left out. */
export function exportMarkdown(state, { title = 'Mewmory', exportedAt = new Date() } = {}) {
    const offset = state.inheritedTimeline?.length || 0;
    const known = names(state);
    const nameOf = id => known.get(id) || id;
    const records = state.records.filter(record => record.status !== 'invalidated' && !record.excluded && recordEligible(state, record))
        .sort((a, b) => a.asOf - b.asOf || a.createdAt - b.createdAt);
    const lines = ['# ' + inline(title), '', 'Exported ' + dayKey(exportedAt) + ' from Mewmory. ' + records.length + (records.length === 1 ? ' memory.' : ' memories.'), ''];
    for (const [kind, heading] of SECTIONS) {
        const group = records.filter(record => record.kind === kind);
        if (!group.length) continue;
        lines.push('## ' + heading, '');
        for (const record of group) {
            if (kind === 'entity') {
                lines.push(...entityLines(record));
            } else if (kind === 'interview') {
                const about = (record.subjectIds || []).map(nameOf).join(', ');
                lines.push('### ' + inline(nameOf(record.ownerId)) + (about ? ' on ' + inline(about) : '') + notes(record, offset, nameOf), '');
                for (const turn of record.interview || []) lines.push('- **' + inline(turn.question) + '** ' + inline(turn.answer));
                lines.push('');
            } else {
                lines.push('- ' + inline(record.text) + notes(record, offset, nameOf));
            }
        }
        if (kind !== 'entity' && kind !== 'interview') lines.push('');
    }
    if (!records.length) lines.push('No memories yet.', '');
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
