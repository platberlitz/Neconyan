const MAX_FOLDER_NAME_LENGTH = 120;
const FOLDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

export const NECONYAN_LOREBOOK_FOLDERS_KEY = 'neconyanFolders';

function ownRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeFolderId(value) {
    const id = String(value ?? '').trim();
    return FOLDER_ID_PATTERN.test(id) ? id : '';
}

function normalizeFolderName(value) {
    return String(value ?? '').trim().slice(0, MAX_FOLDER_NAME_LENGTH);
}

function createFolderId() {
    const randomId = globalThis.crypto?.randomUUID?.();
    if (randomId) return `folder-${randomId}`;
    return `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createNeconyanFolder(name, id = createFolderId()) {
    const normalizedId = normalizeFolderId(id) || createFolderId();
    return { id: normalizedId, name: normalizeFolderName(name) };
}

/**
 * Normalizes only the organizational metadata. Unknown metadata on the object is retained.
 * Book names are used to discard stale assignment keys without touching any book data.
 */
export function normalizeNeconyanLorebookFolders(raw, bookNames = null) {
    const source = ownRecord(raw);
    const seenIds = new Set();
    const folders = [];
    for (const folder of Array.isArray(source.folders) ? source.folders : []) {
        const id = normalizeFolderId(folder?.id);
        const name = normalizeFolderName(folder?.name);
        if (!id || !name || seenIds.has(id)) continue;
        seenIds.add(id);
        folders.push({ ...ownRecord(folder), id, name });
    }

    const validBooks = Array.isArray(bookNames) ? new Set(bookNames
        .map(name => String(name ?? ''))
        .filter(Boolean)) : null;
    const assignments = Object.create(null);
    for (const [bookName, folderId] of Object.entries(ownRecord(source.assignments))) {
        const normalizedBookName = bookName;
        const normalizedFolderId = normalizeFolderId(folderId);
        if ((!validBooks || validBooks.has(normalizedBookName)) && seenIds.has(normalizedFolderId)) {
            assignments[normalizedBookName] = normalizedFolderId;
        }
    }

    return { ...source, folders, assignments };
}

export function renameNeconyanLorebookAssignment(metadata, oldName, newName) {
    const next = normalizeNeconyanLorebookFolders(structuredClone(metadata));
    const oldKey = String(oldName ?? '');
    const newKey = String(newName ?? '');
    if (oldKey && newKey && oldKey !== newKey && Object.hasOwn(next.assignments, oldKey)) {
        next.assignments[newKey] = next.assignments[oldKey];
        delete next.assignments[oldKey];
    }
    return next;
}

export function unfileNeconyanLorebook(metadata, bookName) {
    const next = normalizeNeconyanLorebookFolders(structuredClone(metadata));
    delete next.assignments[String(bookName ?? '')];
    return next;
}

export function moveNeconyanLorebook(metadata, bookName, folderId) {
    const next = normalizeNeconyanLorebookFolders(structuredClone(metadata));
    const name = String(bookName ?? '');
    const id = normalizeFolderId(folderId);
    if (!name) return next;
    if (id && next.folders.some(folder => folder.id === id)) next.assignments[name] = id;
    else delete next.assignments[name];
    return next;
}
