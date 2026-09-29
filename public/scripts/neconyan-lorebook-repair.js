export const REPAIR_KIND_LABELS = Object.freeze({
    'coerce-id': 'Id corrected',
    'reassign-id': 'Id renumbered',
    'rekey-entry': 'Entry slot corrected',
    'default-insertion-order': 'Insertion order set',
    'unset-priority': 'Priority unset',
});

export const REPAIR_DEFECT_LABELS = Object.freeze({
    'entries-malformed': 'The entries collection is malformed',
    'content-not-string': 'Content is not text',
    'keys-not-string-array': 'Keys is not a list of keywords',
    'secondary-keys-not-string-array': 'Secondary keys is not a list of keywords',
    'extensions-not-object': 'Extensions is not an object',
});

/**
 * Shows a value from a broken book in a readable way.
 * @param {unknown} value Original value
 * @returns {string}
 */
export function repairValueText(value) {
    if (value === undefined) return '(missing)';
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : value === Infinity ? '∞' : value === -Infinity ? '-∞' : String(value);
    if (typeof value === 'boolean') return String(value);
    return '(object)';
}

function isStringArray(value) {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseableId(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function repairTitle(entry, id) {
    for (const value of [entry?.comment, entry?.name]) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const keys = Array.isArray(entry?.keys) ? entry.keys : Array.isArray(entry?.key) ? entry.key : [];
    const joined = keys.filter(key => typeof key === 'string' && key.trim()).join(', ');
    return joined || `Entry ${repairValueText(id)}`;
}

/**
 * Settles every id: keeps good ones, turns number-like text into numbers when free, and renumbers the rest.
 * @param {unknown[]} ids Raw ids in book order
 * @param {(index: number) => number|null} fallback Id to try when the raw id is missing
 * @returns {{kind: 'keep'|'coerce-id'|'reassign-id', to: number}[]}
 */
function settleIds(ids, fallback = () => null) {
    const plans = ids.map((id, index) => {
        if (typeof id === 'number') return Number.isFinite(id) ? { kind: 'keep', target: id } : { kind: 'reassign-id' };
        const parsed = id === undefined ? fallback(index) : parseableId(id);
        return parsed === null ? { kind: 'reassign-id' } : { kind: 'coerce-id', target: parsed };
    });
    const seen = new Set();
    for (const plan of plans) {
        if (plan.kind !== 'keep') continue;
        if (seen.has(plan.target)) plan.kind = 'reassign-id';
        seen.add(plan.target);
    }
    const taken = new Set(plans.filter(plan => plan.kind === 'keep').map(plan => plan.target));
    for (const plan of plans) {
        if (plan.kind !== 'coerce-id') continue;
        if (taken.has(plan.target)) plan.kind = 'reassign-id';
        else taken.add(plan.target);
    }
    let next = Math.max(-1, ...[...taken].filter(Number.isFinite)) + 1;
    for (const plan of plans) {
        if (plan.kind !== 'reassign-id') continue;
        while (taken.has(next)) next++;
        plan.target = next;
        taken.add(next);
    }
    return plans.map(plan => ({ kind: plan.kind, to: plan.target }));
}

function planCharacterBook(book) {
    if (!Array.isArray(book.entries) || book.entries.some(entry => !isPlainObject(entry))) {
        return { book, changes: [], defects: [{ kind: 'entries-malformed', entryTitle: '' }] };
    }
    const defects = [];
    book.entries.forEach((entry, index) => {
        const entryTitle = repairTitle(entry, entry.id ?? index);
        // Neconyan's card converter already fills missing content and keys, so only present, wrong-typed values block.
        if (entry.content != null && typeof entry.content !== 'string') defects.push({ kind: 'content-not-string', entryTitle });
        if (entry.keys != null && !isStringArray(entry.keys)) defects.push({ kind: 'keys-not-string-array', entryTitle });
        if (entry.secondary_keys != null && !isStringArray(entry.secondary_keys)) defects.push({ kind: 'secondary-keys-not-string-array', entryTitle });
        if (entry.extensions != null && !isPlainObject(entry.extensions)) defects.push({ kind: 'extensions-not-object', entryTitle });
    });
    const repaired = structuredClone(book);
    const changes = [];
    settleIds(repaired.entries.map(entry => entry.id)).forEach((plan, index) => {
        const entry = repaired.entries[index];
        const entryTitle = repairTitle(book.entries[index], book.entries[index].id);
        if (plan.kind !== 'keep') {
            changes.push({ kind: plan.kind, entryTitle, field: 'id', from: repairValueText(entry.id), to: String(plan.to) });
            entry.id = plan.to;
        }
        if (entry.insertion_order !== undefined && !Number.isFinite(entry.insertion_order)) {
            changes.push({ kind: 'default-insertion-order', entryTitle, field: 'insertion order', from: repairValueText(entry.insertion_order), to: '100' });
            entry.insertion_order = 100;
        }
        if (entry.priority !== undefined && !Number.isFinite(entry.priority)) {
            changes.push({ kind: 'unset-priority', entryTitle, field: 'priority', from: repairValueText(entry.priority), to: '(unset)' });
            delete entry.priority;
        }
    });
    return { book: changes.length ? repaired : book, changes, defects };
}

function planNativeBook(book) {
    if (!isPlainObject(book.entries) || Object.values(book.entries).some(entry => !isPlainObject(entry))) {
        return { book, changes: [], defects: [{ kind: 'entries-malformed', entryTitle: '' }] };
    }
    const slots = Object.entries(book.entries);
    const defects = [];
    for (const [, entry] of slots) {
        const entryTitle = repairTitle(entry, entry.uid);
        if (entry.content !== undefined && typeof entry.content !== 'string') defects.push({ kind: 'content-not-string', entryTitle });
        if (entry.key !== undefined && !isStringArray(entry.key)) defects.push({ kind: 'keys-not-string-array', entryTitle });
        if (entry.keysecondary != null && !isStringArray(entry.keysecondary)) defects.push({ kind: 'secondary-keys-not-string-array', entryTitle });
        if (entry.extensions != null && !isPlainObject(entry.extensions)) defects.push({ kind: 'extensions-not-object', entryTitle });
    }
    const changes = [];
    const entries = {};
    const plans = settleIds(slots.map(([, entry]) => entry.uid), index => parseableId(slots[index][0]));
    plans.forEach((plan, index) => {
        const [slot, original] = slots[index];
        const entry = structuredClone(original);
        const entryTitle = repairTitle(original, original.uid);
        if (plan.kind !== 'keep') {
            changes.push({ kind: plan.kind, entryTitle, field: 'id', from: repairValueText(original.uid), to: String(plan.to) });
            entry.uid = plan.to;
        } else if (slot !== String(plan.to)) {
            changes.push({ kind: 'rekey-entry', entryTitle, field: 'slot', from: JSON.stringify(slot), to: JSON.stringify(String(plan.to)) });
        }
        if (entry.order !== undefined && !Number.isFinite(entry.order)) {
            changes.push({ kind: 'default-insertion-order', entryTitle, field: 'insertion order', from: repairValueText(entry.order), to: '100' });
            entry.order = 100;
        }
        entries[String(entry.uid)] = entry;
    });
    return { book: changes.length ? { ...book, entries } : book, changes, defects };
}

/**
 * Finds broken entry ids in a native lorebook or character book and plans the fixes.
 * Books with nothing to fix come back unchanged, so exporting them stays byte-for-byte the same.
 * @param {object} book Native lorebook ({entries: {...}}) or character book ({entries: [...]})
 * @returns {{book: object, changes: {kind: string, entryTitle: string, field: string, from: string, to: string}[], defects: {kind: string, entryTitle: string}[]}}
 */
export function planLorebookRepair(book) {
    if (!isPlainObject(book)) return { book, changes: [], defects: [{ kind: 'entries-malformed', entryTitle: '' }] };
    return Array.isArray(book.entries) ? planCharacterBook(book) : planNativeBook(book);
}

/**
 * One readable line per fix, such as 'Tavern: id "7" → 7'.
 * @param {{entryTitle: string, field: string, from: string, to: string}} change Planned fix
 * @returns {string}
 */
export function repairChangeText({ entryTitle, field, from, to }) {
    return `${entryTitle}: ${field} ${from} → ${to}`;
}

/**
 * One readable line per problem that cannot be fixed automatically.
 * @param {{kind: string, entryTitle: string}} defect Problem
 * @returns {string}
 */
export function repairDefectText({ kind, entryTitle }) {
    const label = REPAIR_DEFECT_LABELS[kind] ?? kind;
    return entryTitle ? `${entryTitle}: ${label}` : label;
}
