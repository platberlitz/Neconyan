import { permissionAwareResolver } from './note-index.js';
import { foldKey, notebookError } from './paths.js';

export const PROPERTY_TABLE_LIMITS = Object.freeze({ rows: 100, columns: 12, choices: 128, cellBytes: 4096, totalBytes: 512 * 1024 });
const nameAllowed = key => typeof key === 'string' && /^[^\s:#][^:\n]{0,63}$/u.test(key);
const own = (object, key) => Object.hasOwn(object ?? {}, key);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Field suggestions for the owner; this does not alter the table projection. */
export function notebookPropertyKeys(entries, limit = 500) {
    const keys = new Set();
    for (const entry of entries) for (const key of Object.keys(entry.properties ?? {})) {
        if (nameAllowed(key) && !['neconyan_id', '__proto__', 'constructor', 'prototype'].includes(key.toLowerCase())) keys.add(key);
    }
    const sorted = [...keys].sort(compare);
    return { keys: sorted.slice(0, limit), total: sorted.length, partial: sorted.length > limit };
}

export function propertyCell(entry, key) {
    if (entry.propertiesError) return { kind: 'invalid', editable: false, display: 'Invalid properties. Edit in source.' };
    if (entry.complexProperties?.includes(key)) return { kind: 'complex', editable: false, display: 'Nested value. Edit in source.' };
    if (!own(entry.properties, key)) return { kind: 'missing', editable: nameAllowed(key) && key !== 'neconyan_id', display: 'Not set' };
    const value = entry.properties[key];
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > PROPERTY_TABLE_LIMITS.cellBytes) {
        return { kind: 'large', editable: false, display: 'Large value. Edit in source.' };
    }
    const kind = value === null ? 'null' : Array.isArray(value) ? 'list' : typeof value === 'string' ? 'text' : typeof value;
    return { kind, value, editable: value !== null && nameAllowed(key) && key !== 'neconyan_id',
        display: value === null ? 'Null value. Edit in source.' : typeof value === 'string' ? value : encoded };
}

function simple(value) {
    return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
        || (Array.isArray(value) && value.every(item => typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))));
}

function matchesProperty(entry, filter) {
    if (!filter) return true;
    const exists = own(entry.properties, filter.key) || entry.complexProperties?.includes(filter.key);
    if (filter.op === 'exists') return Boolean(exists);
    if (filter.op === 'missing') return !exists;
    if (!own(entry.properties, filter.key)) return false;
    const value = entry.properties[filter.key];
    if (filter.op === 'equals') return JSON.stringify(value) === JSON.stringify(filter.value);
    if (filter.op === 'greater') return typeof value === 'number' && value > filter.value;
    if (filter.op === 'less') return typeof value === 'number' && value < filter.value;
    const wanted = foldKey(String(filter.value));
    return (Array.isArray(value) ? value : [value]).some(item => foldKey(String(item)).includes(wanted));
}

function sortValue(entry, sort) {
    if (sort.by !== 'property') return { rank: 0, value: foldKey(String(entry[sort.by] ?? '')) };
    if (!own(entry.properties, sort.key) || entry.properties[sort.key] === null) return { rank: 5, value: '' };
    const value = entry.properties[sort.key];
    if (typeof value === 'number') return { rank: 0, value };
    if (typeof value === 'boolean') return { rank: 1, value: Number(value) };
    if (typeof value === 'string') return { rank: 2, value: foldKey(value.slice(0, PROPERTY_TABLE_LIMITS.cellBytes)) };
    return { rank: 3, value: foldKey(JSON.stringify(value).slice(0, PROPERTY_TABLE_LIMITS.cellBytes)) };
}

/** A read-only, permission-first projection. Cell writes use the ordinary properties operation. */
export function queryPropertyTable(entries, { canRead, folder = null, tag = null, query = '', filter = null, sort = {}, columns, offset = 0, limit = 50 } = {}) {
    const { entries: visible } = permissionAwareResolver(entries, canRead);
    if (filter && (!nameAllowed(filter.key) || !['contains', 'equals', 'exists', 'missing', 'greater', 'less'].includes(filter.op)
        || (!['exists', 'missing'].includes(filter.op) && !simple(filter.value))
        || (['greater', 'less'].includes(filter.op) && (typeof filter.value !== 'number' || !Number.isFinite(filter.value))))) {
        throw notebookError('NOTE_TABLE_FILTER', 'Choose a property and a valid value for this filter.');
    }
    if (columns !== undefined && (!Array.isArray(columns) || columns.some(key => !nameAllowed(key)))) {
        throw notebookError('NOTE_TABLE_COLUMNS', 'Choose valid property names for the table.');
    }
    const order = { by: ['title', 'path', 'createdAt', 'updatedAt', 'property'].includes(sort?.by) ? sort.by : 'title',
        key: typeof sort?.key === 'string' && nameAllowed(sort.key) ? sort.key : '', direction: sort?.direction === 'desc' ? 'desc' : 'asc' };
    const pageSize = Math.max(1, Math.min(PROPERTY_TABLE_LIMITS.rows, Math.trunc(Number(limit)) || 50));
    const start = Math.max(0, Math.min(100000, Math.trunc(Number(offset)) || 0));
    const folderKey = folder === null ? null : foldKey(folder);
    const tagKey = foldKey(String(tag ?? '').replace(/^#/, '').trim());
    const text = foldKey(String(query ?? '').slice(0, 500));
    const choices = new Set();
    let columnsLimited = false;
    for (const entry of visible) {
        for (const key of [...Object.keys(entry.properties ?? {}), ...(entry.complexProperties ?? [])]) {
            if (!nameAllowed(key) || choices.has(key)) continue;
            if (choices.size >= PROPERTY_TABLE_LIMITS.choices) { columnsLimited = true; break; }
            choices.add(key);
        }
    }
    const availableColumns = [...choices].sort((a, b) => compare(foldKey(a), foldKey(b)) || compare(a, b));
    const selected = [...new Set(columns ?? availableColumns.slice(0, 6))].slice(0, PROPERTY_TABLE_LIMITS.columns);
    const matched = visible.filter(entry => (folderKey === null || foldKey(entry.folder) === folderKey || (folderKey && foldKey(entry.folder).startsWith(`${folderKey}/`)))
        && (!tagKey || entry.tags.some(value => foldKey(value) === tagKey || foldKey(value).startsWith(`${tagKey}/`)))
        && (!text || foldKey(`${entry.title}\n${entry.path}`).includes(text)) && matchesProperty(entry, filter));
    const decorated = matched.map(entry => ({ entry, value: sortValue(entry, order) }));
    decorated.sort((a, b) => {
        if (a.value.rank === 5 || b.value.rank === 5) {
            const missing = compare(a.value.rank, b.value.rank);
            if (missing) return missing;
        }
        const compared = compare(a.value.rank, b.value.rank) || compare(a.value.value, b.value.value);
        return (order.direction === 'desc' ? -compared : compared) || compare(foldKey(a.entry.path), foldKey(b.entry.path)) || compare(a.entry.id, b.entry.id);
    });
    const rows = [];
    let bytes = 64 * 1024;
    for (const { entry } of decorated.slice(start, start + pageSize)) {
        const row = { id: entry.id, title: String(entry.title).slice(0, 200), path: entry.path, folder: entry.folder, revision: entry.hash,
            cells: Object.fromEntries(selected.map(key => [key, propertyCell(entry, key)])) };
        const cost = Buffer.byteLength(JSON.stringify(row), 'utf8');
        if (bytes + cost > PROPERTY_TABLE_LIMITS.totalBytes) break;
        bytes += cost;
        rows.push(row);
    }
    return { status: 'success', rows, columns: selected, availableColumns, total: matched.length, offset: start, limit: pageSize,
        nextOffset: start + rows.length < matched.length ? start + rows.length : null, sort: order,
        limited: { columns: columnsLimited || (columns?.length ?? 0) > selected.length, bytes: rows.length < Math.min(pageSize, Math.max(0, matched.length - start)) },
        limits: PROPERTY_TABLE_LIMITS };
}
