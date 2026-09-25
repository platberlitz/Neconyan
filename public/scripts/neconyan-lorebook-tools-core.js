import { getFreeCharacterBookEntryId, serializeWorldInfoEntry } from './world-info-character-book.js';

const positions = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 };

export function serializeLorebook(value) {
    return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

export function isNativeLorebook(data) {
    const record = value => value && typeof value === 'object' && !Array.isArray(value);
    return Boolean(record(data) && record(data.entries) && Object.values(data.entries).every(record));
}

export function lorebookEntryTitle(entry) {
    return String(entry?.comment || entry?.name || entry?.key?.[0] || (entry?.uid ?? 'Entry'));
}

function originalEntry(data, uid) {
    const entries = data.originalData?.entries;
    if (!Array.isArray(entries)) return {};
    if (data.originalDataUidMap) return entries[data.originalDataUidMap[uid]] ?? {};
    return entries.find(entry => String(entry.id ?? entry.uid) === String(uid)) ?? {};
}

export function lorebookToCharacterBook(data) {
    const metadata = Object.fromEntries(Object.entries(data).filter(([key]) => !['entries', 'originalData', 'originalDataUidMap'].includes(key)));
    const originalData = data.originalData;
    return {
        ...metadata,
        ...originalData,
        extensions: { ...originalData?.extensions, ...data.extensions },
        entries: Object.entries(data.entries).map(([uid, entry]) => serializeWorldInfoEntry(entry, positions, originalEntry(data, uid))),
    };
}

export function lorebookChanges(before, after) {
    const changes = [];
    for (const uid of new Set([...Object.keys(before?.entries ?? {}), ...Object.keys(after?.entries ?? {})])) {
        const previous = before?.entries?.[uid];
        const next = after?.entries?.[uid];
        if (serializeLorebook(previous) === serializeLorebook(next)) continue;
        changes.push({ uid, title: lorebookEntryTitle(next ?? previous), before: previous, after: next });
    }
    const metadata = book => {
        return Object.fromEntries(Object.entries(book ?? {}).filter(([key]) => !['entries', 'originalData', 'originalDataUidMap'].includes(key)));
    };
    const previous = metadata(before);
    const next = metadata(after);
    if (serializeLorebook(previous) !== serializeLorebook(next)) {
        changes.push({ uid: null, title: 'Lorebook settings', before: previous, after: next });
    }
    return changes;
}

export function searchReplaceLorebook(data, { search, replacement = '', regex = false, wholeWord = false, caseSensitive = false, fields = ['content'] }) {
    if (!search) return { book: structuredClone(data), changes: [], matches: 0 };
    let source = regex ? search : search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
    const pattern = new RegExp(source, caseSensitive ? 'gu' : 'giu');
    const book = structuredClone(data);
    const entryMatches = new Map();
    let matches = 0;
    const replace = value => {
        if (typeof value !== 'string') return value;
        matches += Array.from(value.matchAll(pattern)).length;
        return value.replace(pattern, regex ? replacement : () => replacement);
    };
    for (const [uid, entry] of Object.entries(book.entries)) {
        const before = matches;
        for (const field of fields) {
            if (!['content', 'comment', 'name', 'key', 'keysecondary'].includes(field)) continue;
            if (Array.isArray(entry[field])) entry[field] = entry[field].map(replace);
            else if (typeof entry[field] === 'string') entry[field] = replace(entry[field]);
        }
        entryMatches.set(uid, matches - before);
        syncOriginalEntry(book, uid);
    }
    return { book, changes: lorebookChanges(data, book).map(change => ({ ...change, matches: entryMatches.get(change.uid) ?? 0 })), matches };
}

export function changeLorebookDelimiter(content, style, name = '') {
    const text = String(content ?? '');
    const trimmed = text.trim();
    const tag = trimmed.match(/^<([^<>\r\n]{1,80})>\r?\n?([\s\S]*?)\r?\n?<\/\1>$/);
    const bracket = trimmed.match(/^\[([^\]\r\n=]{1,80})=\r?\n?([\s\S]*?)\r?\n?\]$/);
    const separator = text.match(/^(?:([\s\S]*?)\r?\n)?[ \t]*-{3,}[ \t]*(?:\r?\n)?$/);
    const body = tag ? tag[2] : bracket ? bracket[2] : separator ? (separator[1] ?? '').replace(/\r?\n$/, '') : text;
    const safeName = String(name).replace(/[<>=[\]/\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'entry';
    switch (style) {
        case 'none': return body;
        case 'tag': return `<${safeName}>\n${body}\n</${safeName}>`;
        case 'bracket': return `[${safeName}=\n${body}]`;
        case 'separator': return body ? `${body}\n\n---` : '---';
        default: throw new TypeError('Unsupported delimiter');
    }
}

export function delimitLorebook(data, { style, nameSource = 'title', name = '', uid = '' }) {
    const book = structuredClone(data);
    for (const [entryUid, entry] of Object.entries(book.entries)) {
        if (uid !== '' && String(uid) !== entryUid) continue;
        const delimiterName = nameSource === 'fixed' ? name : nameSource === 'key'
            ? entry.key?.find(key => key.trim()) || lorebookEntryTitle(entry) : lorebookEntryTitle(entry);
        entry.content = changeLorebookDelimiter(entry.content, style, delimiterName);
        syncOriginalEntry(book, entryUid);
    }
    return { book, changes: lorebookChanges(data, book) };
}

export function lorebookMergeCandidates(current, incoming) {
    return Object.entries(incoming.entries).map(([uid, entry]) => {
        const byTitle = Object.entries(current.entries).filter(([, local]) =>
            entry.comment && String(local.comment).trim().toLocaleLowerCase() === String(entry.comment).trim().toLocaleLowerCase());
        const targetUid = byTitle.length === 1 ? byTitle[0][0] : Object.hasOwn(current.entries, uid) ? uid : null;
        return { uid, targetUid, incoming: entry, local: targetUid === null ? null : current.entries[targetUid] };
    });
}

function syncOriginalEntry(book, uid, source = originalEntry(book, uid)) {
    if (!Array.isArray(book.originalData?.entries)) return;
    book.originalDataUidMap ??= Object.fromEntries(Object.keys(book.entries).map(key => [key,
        book.originalData.entries.findIndex(entry => String(entry.id ?? entry.uid) === key),
    ]).filter(([, index]) => index >= 0));
    let index = book.originalDataUidMap[uid];
    if (!Number.isInteger(index) || !book.originalData.entries[index]) {
        index = book.originalData.entries.length;
        book.originalDataUidMap[uid] = index;
        source = { ...source, id: getFreeCharacterBookEntryId(book.originalData.entries) };
    }
    book.originalData.entries[index] = serializeWorldInfoEntry(book.entries[uid], positions, source);
}

/** Keep imported Character Book fields in step with a native World Info edit. */
export function syncLorebookOriginalEntry(book, uid, source) {
    if (source === undefined) syncOriginalEntry(book, uid);
    else syncOriginalEntry(book, uid, source);
}

export function deleteLorebookOriginalEntry(book, uid) {
    if (!Array.isArray(book.originalData?.entries)) return;
    const entries = book.originalData.entries;
    const index = book.originalDataUidMap?.[uid] ?? entries.findIndex(entry => String(entry.id ?? entry.uid) === String(uid));
    if (!Number.isSafeInteger(index) || index < 0 || index >= entries.length) return;
    entries.splice(index, 1);
    if (!book.originalDataUidMap) return;
    book.originalDataUidMap = Object.fromEntries(Object.entries(book.originalDataUidMap)
        .filter(([key]) => key !== String(uid))
        .map(([key, position]) => [key, position > index ? position - 1 : position]));
}

export function mergeLorebooks(data, incoming, choices) {
    const book = structuredClone(data);
    if (incoming.originalData && !book.originalData) {
        book.originalData = { extensions: { ...book.extensions }, entries: [] };
        book.originalDataUidMap = {};
        for (const uid of Object.keys(book.entries)) syncOriginalEntry(book, uid);
    }
    let nextUid = 0;
    let displayIndex = Math.max(-1, ...Object.values(book.entries).map(entry => Number(entry.displayIndex ?? entry.uid) || 0)) + 1;
    for (const candidate of lorebookMergeCandidates(data, incoming)) {
        const choice = choices[candidate.uid] ?? 'skip';
        if (choice === 'skip') continue;
        if (!['import', 'overwrite'].includes(choice) || (choice === 'overwrite' && candidate.targetUid === null)) {
            throw new TypeError('Invalid merge choice');
        }
        while (Object.hasOwn(book.entries, String(nextUid))) nextUid++;
        const uid = choice === 'overwrite' ? candidate.targetUid : String(nextUid++);
        const previous = book.entries[uid];
        book.entries[uid] = {
            ...structuredClone(candidate.incoming),
            uid: Number(uid),
            displayIndex: previous?.displayIndex ?? previous?.uid ?? displayIndex++,
        };
        const source = { ...originalEntry(incoming, candidate.uid), ...(previous ? { id: originalEntry(book, uid).id } : {}) };
        syncOriginalEntry(book, uid, source);
    }
    return { book, changes: lorebookChanges(data, book) };
}

function validateCharacterBook(book) {
    if (!book || !Array.isArray(book.entries) || !book.entries.every(entry => entry && typeof entry === 'object'
        && typeof entry.content === 'string' && (entry.keys === undefined || Array.isArray(entry.keys) && entry.keys.every(key => typeof key === 'string'))
        && (entry.secondary_keys === undefined || Array.isArray(entry.secondary_keys) && entry.secondary_keys.every(key => typeof key === 'string')))) {
        throw new TypeError('Unsupported World Info format');
    }
}

function importCharacterBook(book, convertCharacterBook, nativeBook) {
    validateCharacterBook(book);
    if (isNativeLorebook(nativeBook) && serializeLorebook(lorebookToCharacterBook(nativeBook)) === serializeLorebook(book)) {
        return structuredClone(nativeBook);
    }
    const normalized = structuredClone(book);
    for (const entry of normalized.entries) {
        entry.comment ||= entry.name || '';
        const filter = entry.extensions?.character_filter;
        if (filter && typeof filter === 'object') {
            entry.character_filter = { ...filter, isExclude: filter.is_exclude ?? filter.isExclude ?? false };
        }
    }
    const converted = convertCharacterBook(normalized);
    if (!isNativeLorebook(nativeBook)) return converted;
    // A project edited elsewhere can still carry native fields that its editor does not expose.
    const previousEntries = Object.values(nativeBook.entries);
    const previousRecords = lorebookToCharacterBook(nativeBook).entries;
    const byId = new Map(previousRecords.map((entry, index) => [entry.id, previousEntries[index]]).filter(([id]) => id !== undefined));
    for (const [uid, entry] of Object.entries(converted.entries)) {
        const record = normalized.entries[converted.originalDataUidMap?.[uid] ?? Number(uid)];
        const previous = byId.get(record?.id);
        if (previous) converted.entries[uid] = { ...structuredClone(previous), ...entry };
    }
    return { ...structuredClone(nativeBook), ...converted };
}

export function parseLorebookImport(json, convertCharacterBook) {
    if (json?.format === 'lorestitch-project') {
        const workspace = json.workspace;
        if (json.version !== 1 || !workspace || !Array.isArray(workspace.commits)) throw new TypeError('Unsupported World Info format');
        const { activeBook, nativeBook, commits, ...metadata } = workspace;
        const history = {
            ...metadata,
            version: 1,
            archiveMetadata: Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'workspace')),
            commits: commits.map(({ snapshot, nativeSnapshot, ...commit }) => ({
                ...commit,
                snapshot: importCharacterBook(snapshot, convertCharacterBook, nativeSnapshot),
                sourceSnapshot: structuredClone(snapshot),
            })),
        };
        return { book: importCharacterBook(activeBook, convertCharacterBook, nativeBook), history };
    }
    if (isNativeLorebook(json)) return { book: structuredClone(json), history: null };
    const book = json?.spec === 'lorebook_v3' ? json.data : json;
    return { book: importCharacterBook(book, convertCharacterBook), history: null };
}

export function exportLorebookProject(name, book, history) {
    const { archiveMetadata, commits = [] } = history;
    const metadata = Object.fromEntries(Object.entries(history).filter(([key]) => !['version', 'archiveMetadata', 'commits'].includes(key)));
    return {
        ...archiveMetadata,
        format: 'lorestitch-project',
        version: 1,
        exportedAt: new Date().toISOString(),
        workspace: {
            ...metadata,
            title: name,
            targetType: metadata.targetType || 'standalone_lorebook',
            activeBook: lorebookToCharacterBook(book),
            nativeBook: book,
            commits: commits.map(({ snapshot, sourceSnapshot, ...commit }) => ({
                ...commit,
                snapshot: sourceSnapshot ?? lorebookToCharacterBook(snapshot),
                nativeSnapshot: snapshot,
            })),
        },
    };
}

export function lorebookDigest(name, data) {
    const entries = Object.values(data.entries).sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid));
    const tokens = Math.ceil(entries.reduce((total, entry) => total + String(entry.content ?? '').length, 0) / 3.5);
    return [`# ${name}`, '', `${entries.length} entries · ~${tokens} tokens (rough)`, '', ...entries.flatMap(entry => [
        `### ${lorebookEntryTitle(entry)}${entry.disable ? ' (disabled)' : ''}`,
        `Order: ${entry.order ?? 100} | Keys: ${(entry.key ?? []).join(', ')}`,
        '', String(entry.content ?? ''), '', '---', '',
    ])].join('\n');
}
