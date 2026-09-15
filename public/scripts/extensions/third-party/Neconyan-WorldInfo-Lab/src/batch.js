import { LOGIC, POSITION } from './constants.js';
import { getContext, loadHost, mutateWorldInfo } from './host.js';

const PREVIEW_VERSION = 1;
const ALLOWED_FIELDS = new Set([
    'characterFilter',
    'depth',
    'disable',
    'groupWeight',
    'matchWholeWords',
    'order',
    'position',
    'probability',
    'scanDepth',
    'selectiveLogic',
    'useProbability',
]);

export class BatchConflictError extends Error {
    constructor(conflicts) {
        super(`${conflicts.length} reviewed ${conflicts.length === 1 ? 'entry changed' : 'entries changed'} after this preview was created.`);
        this.name = 'BatchConflictError';
        this.conflicts = conflicts;
    }
}

function checkAbort(signal) {
    if (signal?.aborted) {
        throw new DOMException('Batch edit canceled. Nothing was saved.', 'AbortError');
    }
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function fingerprint(value) {
    const text = JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function entryLabel(entry, key) {
    return String(entry.comment || `Entry ${entry.uid ?? key}`);
}

function matchesFilter(entry, key, filter) {
    const query = String(filter ?? '').trim().toLowerCase();
    if (!query) {
        return true;
    }
    return [
        key,
        entry.uid,
        entry.comment,
        entry.content,
        ...(Array.isArray(entry.key) ? entry.key : []),
        ...(Array.isArray(entry.keysecondary) ? entry.keysecondary : []),
    ].some(value => String(value ?? '').toLowerCase().includes(query));
}

function finiteNumber(value, field, min, max, { integer = false, nullable = false } = {}) {
    if (nullable && (value === null || value === '')) {
        return null;
    }
    const number = Number(value);
    if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min || number > max) {
        throw new TypeError(`Enter ${field} as ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
    }
    return number;
}

function normalizeCharacterFilter(value) {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch (error) {
            throw new TypeError(`Character filter is not valid JSON. Technical details: ${error?.message ?? error}`);
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('Character filter must be a JSON object containing names, tags, and isExclude.');
    }
    const strings = (items, field) => {
        if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) {
            throw new TypeError(`In the character filter, "${field}" must be a JSON list of text values.`);
        }
        return [...new Set(items.map(item => item.trim()).filter(Boolean))];
    };
    if (parsed.isExclude !== undefined && typeof parsed.isExclude !== 'boolean') {
        throw new TypeError('In the character filter, "isExclude" must be true or false.');
    }
    return {
        names: strings(parsed.names ?? [], 'names'),
        tags: strings(parsed.tags ?? [], 'tags'),
        isExclude: parsed.isExclude ?? false,
    };
}

function normalizeFieldValue(field, value) {
    switch (field) {
        case 'order':
            return finiteNumber(value, field, -1000000, 1000000);
        case 'probability':
            return finiteNumber(value, field, 0, 100);
        case 'depth':
            return finiteNumber(value, field, 0, 10000, { integer: true });
        case 'scanDepth':
            return finiteNumber(value, field, 0, 1000, { integer: true, nullable: true });
        case 'groupWeight':
            return finiteNumber(value, field, 1, 999999);
        case 'position': {
            const position = finiteNumber(value, field, 0, 7, { integer: true });
            if (!Object.values(POSITION).includes(position)) {
                throw new TypeError('Choose a valid insertion position.');
            }
            return position;
        }
        case 'selectiveLogic': {
            const logic = finiteNumber(value, field, 0, 3, { integer: true });
            if (!Object.values(LOGIC).includes(logic)) {
                throw new TypeError('Choose a valid secondary-key rule.');
            }
            return logic;
        }
        case 'disable':
        case 'matchWholeWords':
        case 'useProbability': {
            if (value === true || value === 'true') {
                return true;
            }
            if (value === false || value === 'false') {
                return false;
            }
            throw new TypeError(`Choose On or Off for ${field}.`);
        }
        case 'characterFilter':
            return normalizeCharacterFilter(value);
        default:
            throw new TypeError('That entry setting cannot be changed in Batch Edit. Choose a setting from the list.');
    }
}

async function mirrorOriginalData(book, changes, signal) {
    if (!Array.isArray(book?.originalData?.entries)) {
        return;
    }
    const originalIndex = (uid) => {
        const mappedIndex = book.originalDataUidMap?.[uid];
        const mapped = book.originalData.entries[mappedIndex];
        if (Number.isInteger(mappedIndex) && String(mapped?.id ?? mapped?.uid) === String(uid)) {
            return mappedIndex;
        }
        const matches = book.originalData.entries
            .map((item, index) => String(item?.id ?? item?.uid) === String(uid) ? index : -1)
            .filter(index => index !== -1);
        if (matches.length !== 1) {
            return -1;
        }
        if (!book.originalDataUidMap || typeof book.originalDataUidMap !== 'object' || Array.isArray(book.originalDataUidMap)) {
            book.originalDataUidMap = {};
        }
        book.originalDataUidMap[uid] = matches[0];
        return matches[0];
    };
    const missing = changes.filter((change) => {
        const entry = book.entries[change.entryKey];
        const uid = entry?.uid ?? change.uid;
        return originalIndex(uid) === -1;
    });
    if (missing.length) {
        throw new Error(`Nothing was saved because ${missing.length} reviewed ${missing.length === 1 ? 'entry could not' : 'entries could not'} be matched to the lorebook's CharacterBook data. Reload and build a new preview.`);
    }
    const host = await loadHost();
    checkAbort(signal);
    const setOriginal = host.ok ? host.worldInfo?.setWIOriginalDataValue : null;
    const keyMap = host.ok ? host.worldInfo?.originalWIDataKeyMap : null;
    if (typeof setOriginal !== 'function' || !keyMap) {
        throw new Error('This CharacterBook-format lorebook cannot be safely updated with this Neconyan version. Nothing was saved.');
    }
    for (const change of changes) {
        const entry = book.entries[change.entryKey];
        const uid = entry?.uid ?? change.uid;
        if (change.field === 'disable') {
            setOriginal(book, uid, 'enabled', !change.after);
            continue;
        }
        if (change.field === 'characterFilter') {
            setOriginal(book, uid, 'character_filter', clone(change.after));
            continue;
        }
        if (change.field === 'position') {
            setOriginal(book, uid, 'position', change.after === POSITION.before ? 'before_char' : 'after_char');
            setOriginal(book, uid, 'extensions.position', change.after);
            continue;
        }
        const originalKey = keyMap[change.field];
        if (!originalKey) {
            throw new Error(`The setting "${change.field}" cannot be safely written to this CharacterBook-format lorebook. Nothing was saved.`);
        }
        setOriginal(book, uid, originalKey, clone(change.after));
    }
}

function getBookFromSnapshot(snapshot, bookName) {
    const book = snapshot?.books instanceof Map
        ? snapshot.books.get(bookName)
        : snapshot?.books?.[bookName];
    if (!book) {
        throw new Error(`"${bookName}" is no longer loaded. Reload lorebooks and create a new preview.`);
    }
    return book;
}

function makeChange(entry, key, field, before, after) {
    return {
        entryKey: key,
        uid: entry.uid ?? key,
        label: entryLabel(entry, key),
        field,
        before: clone(before),
        after: clone(after),
        entrySnapshot: JSON.stringify(entry),
        entryFingerprint: fingerprint(entry),
    };
}

export async function previewBatch(payload, { signal } = {}) {
    checkAbort(signal);
    const bookName = String(payload?.bookName ?? '').trim();
    if (!bookName) {
        throw new TypeError('Choose a lorebook before previewing changes.');
    }
    const book = getBookFromSnapshot(payload.snapshot, bookName);
    const entries = book?.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        throw new TypeError(`The lorebook "${bookName}" has no editable entries.`);
    }
    const operation = payload.operation === 'set-field' ? 'set-field' : 'replace-content';
    const changes = [];
    let field = 'content';
    let nextValue;

    if (operation === 'replace-content') {
        const find = String(payload.find ?? '');
        if (!find) {
            throw new TypeError('Enter the exact text to find.');
        }
        const replacement = String(payload.replacement ?? '');
        for (const [key, entry] of Object.entries(entries)) {
            checkAbort(signal);
            if (!entry || typeof entry !== 'object' || !matchesFilter(entry, key, payload.filter)) {
                continue;
            }
            const before = String(entry.content ?? '');
            if (!before.includes(find)) {
                continue;
            }
            const after = before.split(find).join(replacement);
            if (after !== before) {
                changes.push(makeChange(entry, key, field, before, after));
            }
        }
    } else {
        field = String(payload.field ?? '');
        if (!ALLOWED_FIELDS.has(field)) {
            throw new TypeError('That entry setting cannot be changed in Batch Edit. Choose a setting from the list.');
        }
        nextValue = normalizeFieldValue(field, payload.value);
        for (const [key, entry] of Object.entries(entries)) {
            checkAbort(signal);
            if (!entry || typeof entry !== 'object' || !matchesFilter(entry, key, payload.filter)) {
                continue;
            }
            const before = entry[field];
            if (JSON.stringify(before) !== JSON.stringify(nextValue)) {
                changes.push(makeChange(entry, key, field, before, nextValue));
            }
        }
    }

    return {
        kind: 'batch-preview',
        version: PREVIEW_VERSION,
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        createdAt: new Date().toISOString(),
        bookName,
        operation,
        field,
        count: changes.length,
        changes,
    };
}

async function applyReviewedPreview(preview, signal) {
    checkAbort(signal);
    if (preview?.kind !== 'batch-preview' || preview.version !== PREVIEW_VERSION || !Array.isArray(preview.changes)) {
        throw new TypeError('This preview is no longer valid. Build and review a new preview.');
    }
    if (!preview.changes.length) {
        return { count: 0, message: 'There are no reviewed changes to save. Create a new preview.' };
    }
    const context = getContext();
    const result = await mutateWorldInfo(preview.bookName, async (next) => {
        if (!next?.entries || typeof next.entries !== 'object' || Array.isArray(next.entries)) {
            throw new Error(`The latest copy of "${preview.bookName}" could not be loaded. Nothing was saved.`);
        }
        const conflicts = [];
        for (const change of preview.changes) {
            const current = next.entries[change.entryKey];
            if (!current || JSON.stringify(current) !== change.entrySnapshot) {
                conflicts.push({ entryKey: change.entryKey, uid: change.uid, label: change.label });
            }
        }
        if (conflicts.length) {
            throw new BatchConflictError(conflicts);
        }
        for (const change of preview.changes) {
            next.entries[change.entryKey][change.field] = clone(change.after);
        }
        await mirrorOriginalData(next, preview.changes, signal);
        return {
            count: preview.changes.length,
            message: `Saved changes to ${preview.changes.length} ${preview.changes.length === 1 ? 'entry' : 'entries'} in "${preview.bookName}".`,
        };
    }, { signal });
    let refreshWarning = '';
    try {
        await context.reloadWorldInfoEditor?.(preview.bookName, true);
        await context.updateWorldInfoList?.();
    } catch (error) {
        refreshWarning = `Changes were saved, but Neconyan could not refresh its lorebook list. Reload before making another edit. Technical details: ${error?.message ?? error}`;
    }
    return {
        ...result,
        refreshWarning,
    };
}

export function applyBatch(preview, { signal } = {}) {
    return applyReviewedPreview(preview, signal);
}
