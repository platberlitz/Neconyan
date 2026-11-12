/** Default lorebook name for a chat's memories. */
export function defaultLorebookName(chat) {
    return ('Mewmory - ' + String(chat || 'chat')).slice(0, 120);
}

function sameKeys(a, b) {
    return Array.isArray(a) && a.length === b.length && a.every((key, index) => key === b[index]);
}

/**
 * Copies Mewmory lore entries into lorebook data. Entries sent before are found by their memory id and updated in place,
 * so sending twice never duplicates them. Entries whose memory is gone are left for the author to decide.
 */
export function mergeLoreEntries(data, entries, createEntry) {
    const existing = new Map();
    for (const entry of Object.values(data.entries || {})) {
        if (entry?.mewmoryRecordId) existing.set(entry.mewmoryRecordId, entry);
    }
    const result = { added: 0, updated: 0, unchanged: 0, stale: 0 };
    const sent = new Set();
    for (const item of entries) {
        sent.add(item.id);
        let entry = existing.get(item.id);
        if (entry) {
            if (entry.comment === item.title && entry.content === item.content && sameKeys(entry.key, item.keys)) {
                result.unchanged += 1;
                continue;
            }
            result.updated += 1;
        } else {
            entry = createEntry(data);
            if (!entry) throw new Error('The lorebook could not take another entry.');
            entry.mewmoryRecordId = item.id;
            result.added += 1;
        }
        entry.comment = item.title;
        entry.key = [...item.keys];
        entry.content = item.content;
        entry.mewmoryVersion = item.version;
    }
    for (const id of existing.keys()) if (!sent.has(id)) result.stale += 1;
    return result;
}

/** Sends entries to a lorebook, creating it when missing. Returns the saved name and the counts from mergeLoreEntries. */
export async function sendToLorebook(name, entries) {
    const requested = String(name || '').trim();
    if (!requested) throw new Error('Name the lorebook first.');
    if (!entries.length) throw new Error('There are no memories to send yet.');
    const worldInfo = await import('../world-info.js');
    const find = () => worldInfo.world_names.find(world => world.toLocaleLowerCase() === requested.toLocaleLowerCase());
    let saved = find();
    if (!saved) {
        if (!await worldInfo.createNewWorldInfo(requested, { interactive: false })) throw new Error('That lorebook name cannot be used. Try another.');
        saved = find() || requested;
    }
    const data = await worldInfo.loadWorldInfo(saved);
    if (!data || typeof data !== 'object') throw new Error('The lorebook could not be opened.');
    data.entries ??= {};
    const result = mergeLoreEntries(data, entries, book => worldInfo.createWorldInfoEntry(saved, book));
    if (result.added || result.updated) {
        if (await worldInfo.saveWorldInfo(saved, data, true) === null) throw new Error('The lorebook could not be saved.');
    }
    return { name: saved, ...result };
}
