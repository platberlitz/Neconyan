// Organisational metadata only. Activation groups, keys and insertion order are independent.
export const ENTRY_FOLDER_KEY = 'neconyan_entry_folder';
export const ENTRY_FOLDERS_KEY = 'neconyan_entry_folders';

export function normalizeEntryFolder(value) {
    return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

export function getEntryFolder(entry) {
    return normalizeEntryFolder(entry?.extensions?.[ENTRY_FOLDER_KEY]);
}

export function getEntryFolders(data) {
    const stored = data?.extensions?.[ENTRY_FOLDERS_KEY];
    return [...new Set([
        ...(Array.isArray(stored) ? stored : []),
        ...Object.values(data?.entries ?? {}).map(getEntryFolder),
    ].map(normalizeEntryFolder).filter(Boolean))];
}

function storeFolders(data, folders) {
    data.extensions = { ...data.extensions, [ENTRY_FOLDERS_KEY]: folders };
    if (data.originalData) {
        data.originalData.extensions = { ...data.originalData.extensions, [ENTRY_FOLDERS_KEY]: [...folders] };
    }
}

export function addEntryFolder(data, folder) {
    const name = normalizeEntryFolder(folder);
    if (name) storeFolders(data, [...new Set([...getEntryFolders(data), name])]);
    return name;
}

export function setEntryFolder(entry, folder) {
    // Keep an explicit empty string so merging with an embedded original also clears its folder.
    entry.extensions = { ...entry.extensions, [ENTRY_FOLDER_KEY]: normalizeEntryFolder(folder) };
}

/** Renaming to an existing folder merges them. Removing a folder only unfiles its entries. */
export function renameEntryFolder(data, oldName, newName) {
    const nextName = normalizeEntryFolder(newName);
    const folders = getEntryFolders(data).map(name => name === oldName ? nextName : name).filter(Boolean);
    const changed = Object.values(data.entries).filter(entry => getEntryFolder(entry) === oldName);
    changed.forEach(entry => setEntryFolder(entry, nextName));
    storeFolders(data, [...new Set(folders)]);
    return changed;
}

/** A folder heading under the pointer wins; otherwise the entry joins the folder whose heading sits above it. */
export function resolveEntryFolderDrop({ hovered = null, preceding = null } = {}) {
    return normalizeEntryFolder(hovered ?? preceding ?? '');
}

export function findEntryFolderHeadingAt(headings, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [...headings].find(heading => {
        const box = heading.getBoundingClientRect();
        return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    }) ?? null;
}

/** Stable folder grouping preserves the selected sort order inside every folder. */
export function groupEntriesByFolder(entries, data, filter = null) {
    const rank = new Map(['', ...getEntryFolders(data)].map((name, index) => [name, index]));
    return entries.filter(entry => filter === null || getEntryFolder(entry) === filter)
        .sort((a, b) => (rank.get(getEntryFolder(a)) ?? 0) - (rank.get(getEntryFolder(b)) ?? 0));
}
