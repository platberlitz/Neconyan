import { normalizeWorldInfoPosition, serializeWorldInfoEntry } from '../public/scripts/world-info-character-book.js';
import { convertCharacterBookEntry, worldInfoPositions } from '../public/scripts/world-info-character-book-entry.js';
import { newWorldInfoEntryTemplate } from '../public/scripts/world-info-entry.js';
import { hasEditableWorldInfoId } from '../public/scripts/world-info-entry-id.js';

const nativeFields = [...Object.keys(newWorldInfoEntryTemplate), 'displayIndex', 'characterFilter'];
const sharedFields = new Set(['comment', 'content', 'constant', 'selective', 'position']);
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const stableId = uid => (typeof uid === 'string' || typeof uid === 'number')
    && hasEditableWorldInfoId(String(uid), { uid }) ? Number(uid) : null;
const isUsableEntry = entry => isRecord(entry) && typeof entry.content === 'string'
    && [entry.key, entry.keysecondary, entry.keys, entry.secondary_keys].every(keys => keys === undefined
        || (Array.isArray(keys) && keys.every(key => typeof key === 'string')))
    && (entry.comment === undefined || typeof entry.comment === 'string');

/** Read saved World Info in its native form, without rewriting the file. */
export function parseSavedWorldInfo(text) {
    const book = JSON.parse(text);
    if (!Array.isArray(book?.entries)) return book;

    const source = book.entries;
    const entries = {};
    const originalDataUidMap = {};
    const hasOriginalData = Array.isArray(book.originalData?.entries);
    const originals = [...source];
    const preferred = source.map(entry => isUsableEntry(entry) ? stableId(entry.uid) ?? stableId(entry.id) : null);
    const reserved = new Set(preferred);
    let nextId = 0;

    source.forEach((entry, index) => {
        if (!isUsableEntry(entry)) {
            // Let Health report the bad slot without letting it run during lore scanning.
            entries[`invalid-${index}`] = { disable: true, content: '', key: [], keysecondary: [], originalEntry: entry };
            return;
        }
        let uid = preferred[index];
        if (uid === null || Object.hasOwn(entries, uid)) {
            while (reserved.has(nextId) || Object.hasOwn(entries, nextId)) nextId++;
            uid = nextId++;
        }

        const native = convertCharacterBookEntry(entry, uid, index);
        // Some saved lists have both sets of fields. Use the native fields where present.
        for (const field of nativeFields) {
            if (field !== 'position' && Object.hasOwn(entry, field)) native[field] = entry[field];
        }
        native.position = (typeof entry.position === 'number' ? normalizeWorldInfoPosition(entry.position, worldInfoPositions) : undefined) ?? native.position;
        native.order ??= newWorldInfoEntryTemplate.order;
        if (entry.comment === undefined && typeof entry.name === 'string') native.comment = entry.name;
        entries[uid] = native;

        if (!hasOriginalData) {
            // Keep portable metadata, not competing copies of editable native fields.
            const portable = { ...entry };
            for (const field of nativeFields) if (!sharedFields.has(field)) delete portable[field];
            delete portable.uid;
            originals[index] = serializeWorldInfoEntry(native, worldInfoPositions, portable);
            originalDataUidMap[uid] = index;
        } else if (uid === preferred[index] && Number.isSafeInteger(book.originalDataUidMap?.[uid])) {
            originalDataUidMap[uid] = book.originalDataUidMap[uid];
        }
    });

    return {
        ...book,
        entries,
        originalData: hasOriginalData ? book.originalData : { ...book, entries: originals },
        // Legacy originalData without a map falls back to lookup by ID.
        ...(hasOriginalData && !book.originalDataUidMap ? {} : { originalDataUidMap }),
    };
}
