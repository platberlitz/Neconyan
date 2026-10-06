import { parsePropertyValue } from './property-values.js';

export const RESERVED_PROPERTIES = new Set(['title', 'tags', 'tag', 'aliases', 'alias', 'type', 'neconyan_id', '__proto__', 'constructor', 'prototype']);
export const isCustomPropertyKey = key => typeof key === 'string' && /^[^\s:#][^:\n\r]{0,63}$/u.test(key) && !RESERVED_PROPERTIES.has(key.toLowerCase());
const listText = value => Array.isArray(value) ? value.join(', ') : String(value ?? '');
const kindOf = value => Array.isArray(value) ? 'list' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text';
const inputOf = value => Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createPropertyDraft(properties, complex = []) {
    const fields = { tags: listText(properties.tags ?? properties.tag), aliases: listText(properties.aliases ?? properties.alias), type: listText(properties.type) };
    return { base: structuredClone(properties), baseFields: { ...fields }, fields, complex: [...complex], rows:
        Object.entries(properties).filter(([key]) => !RESERVED_PROPERTIES.has(key.toLowerCase()) && !complex.includes(key))
            .map(([key, value]) => ({ originalKey: key, key, value: inputOf(value), originalInput: inputOf(value), kind: kindOf(value), removed: false })) };
}

export function blankPropertyRow() {
    return { originalKey: null, key: '', value: '', originalInput: '', kind: 'text', removed: false };
}

/** Only edited fields are sent. A changed source field must not be overwritten. */
export function propertyChanges(draft, current = draft.base) {
    const desired = Object.create(null);
    const deleted = new Set();
    const seen = new Set();
    for (const key of ['tags', 'aliases', 'type']) {
        if (draft.fields[key] === draft.baseFields[key]) continue;
        const raw = draft.fields[key].trim();
        desired[key] = !raw ? null : key === 'type' ? raw : raw.split(',').map(item => item.trim()).filter(Boolean);
    }
    for (const row of draft.rows) {
        if (row.removed) { if (row.originalKey) deleted.add(row.originalKey); continue; }
        const untouched = row.originalKey && row.key === row.originalKey && row.value === row.originalInput;
        const key = untouched ? row.originalKey : row.key.trim();
        if (!key && !row.value.trim() && !row.originalKey) continue;
        if (seen.has(key)) throw new Error(`The field '${key}' appears twice. Give each row a different name.`);
        seen.add(key);
        if (untouched) continue;
        if (!key || !isCustomPropertyKey(key)) throw new Error('Use a field name of up to 64 characters, without a colon. Tags, Type and other built-in fields have their own controls.');
        if (draft.complex.includes(key)) throw new Error('Edit nested fields in Write view; their existing text is kept here.');
        if (row.originalKey && key !== row.originalKey) deleted.add(row.originalKey);
        if (!row.originalKey && !row.value.trim()) throw new Error('Give the new field a value, or remove its empty row.');
        desired[key] = row.value.trim() ? parsePropertyValue(row.kind, row.value) : null;
    }
    for (const key of deleted) if (!Object.hasOwn(desired, key)) desired[key] = null;
    const set = Object.create(null);
    for (const [key, value] of Object.entries(desired)) {
        const unchanged = same(current[key], draft.base[key]) && Object.hasOwn(current, key) === Object.hasOwn(draft.base, key);
        if (!unchanged && !(value === null ? !Object.hasOwn(current, key) : same(current[key], value))) {
            throw new Error(`The field '${key}' changed in the note. Reopen Properties before saving it.`);
        }
        if (value === null ? Object.hasOwn(current, key) : !same(current[key], value)) set[key] = value;
    }
    return set;
}
