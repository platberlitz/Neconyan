import { extractLinks, frontmatterAliases, frontmatterTags, headingsOf, inlineTags, noteProperties, splitFrontmatter } from './markdown.js';
import { baseName, foldKey, parentFolder, stemOf } from './paths.js';

export const SEARCH_LIMIT = 50;
const SNIPPET_RADIUS = 80;

/** Index record for one note. Holds the literal text so search never runs or expands anything. */
export function buildEntry(id, relative, text, hash, extra = {}) {
    const split = splitFrontmatter(text);
    const { properties, complex } = noteProperties(split.data);
    const stem = stemOf(relative);
    const title = typeof split.data?.title === 'string' && split.data.title.trim() ? split.data.title.trim() : stem;
    const tags = [...new Set([...frontmatterTags(split.data), ...inlineTags(text)])];
    return {
        id,
        path: relative,
        folder: parentFolder(relative),
        stem,
        title,
        aliases: frontmatterAliases(split.data),
        tags,
        type: typeof split.data?.type === 'string' ? split.data.type : null,
        properties,
        complexProperties: complex,
        propertiesError: split.error,
        headings: headingsOf(text).map(({ level, text: heading, id: anchor, path, blockId }) => ({ level, text: heading, id: anchor, path, blockId })),
        links: extractLinks(text).map(({ kind, embed, target, fragment, label, external, raw, start, end }) => ({ kind, embed, target, fragment, label, external: Boolean(external), raw, start, end })),
        hash,
        size: Buffer.byteLength(text, 'utf8'),
        text,
        lower: text.normalize('NFC').toLocaleLowerCase('und'),
        ...extra,
    };
}

/** What a listing exposes about a note: never the body. */
export function summariseEntry(entry, meta = {}) {
    return {
        id: entry.id,
        path: entry.path,
        folder: entry.folder,
        title: entry.title,
        aliases: entry.aliases,
        tags: entry.tags,
        type: entry.type,
        revision: entry.hash,
        size: entry.size,
        updatedAt: meta.updatedAt ?? null,
        createdAt: meta.createdAt ?? null,
        favourite: Boolean(meta.favourite),
    };
}

function lookupTables(entries) {
    const byPath = new Map();
    const byStem = new Map();
    const byTitle = new Map();
    const byAlias = new Map();
    const add = (map, key, entry) => {
        const list = map.get(key) ?? [];
        if (!list.includes(entry)) list.push(entry);
        map.set(key, list);
    };
    for (const entry of entries) {
        byPath.set(foldKey(entry.path.replace(/\.md$/i, '')), entry);
        add(byStem, foldKey(entry.stem), entry);
        add(byTitle, foldKey(entry.title), entry);
        for (const alias of entry.aliases) add(byAlias, foldKey(alias), entry);
    }
    return { byPath, byStem, byTitle, byAlias };
}

const tableCache = new WeakMap();
function tablesFor(entries) {
    let tables = tableCache.get(entries);
    if (!tables) {
        tables = lookupTables(entries);
        tableCache.set(entries, tables);
    }
    return tables;
}

function normaliseSegments(folder, target) {
    const parts = [];
    for (const part of [...(folder ? folder.split('/') : []), ...target.split('/')]) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!parts.length) return null;
            parts.pop();
        } else parts.push(part);
    }
    return parts.join('/');
}

/**
 * Resolves a link inside one notebook. Path matches beat file names, file names beat titles,
 * titles beat aliases. Two equally good candidates are reported as ambiguous, never guessed.
 * Returns { status: 'resolved', entry } | { status: 'ambiguous', candidates } | { status: 'missing' } | { status: 'external' } | { status: 'attachment', path }.
 */
export function resolveLink(entries, link, fromPath = '') {
    if (link.external) return { status: 'external' };
    const tables = tablesFor(entries);
    const target = String(link.target ?? '').normalize('NFC').trim();
    if (!target) {
        const self = entries.find(entry => entry.path === fromPath);
        return self ? { status: 'resolved', entry: self } : { status: 'missing' };
    }
    if (link.kind === 'markdown') {
        const resolved = target.startsWith('/') ? normaliseSegments('', target) : normaliseSegments(parentFolder(fromPath), target);
        if (!resolved) return { status: 'missing' };
        if (!/\.md$/i.test(resolved)) return { status: 'attachment', path: resolved };
        const entry = tables.byPath.get(foldKey(resolved.replace(/\.md$/i, '')));
        return entry ? { status: 'resolved', entry } : { status: 'missing', path: resolved };
    }
    const bare = target.replace(/\.md$/i, '');
    if (/\.(png|jpe?g|gif|webp|avif|svg|pdf|mp3|wav|ogg|mp4|webm|txt)$/i.test(bare)) {
        const direct = bare.includes('/') ? normaliseSegments('', bare) : null;
        return { status: 'attachment', path: direct ?? bare, name: baseName(bare) };
    }
    if (bare.includes('/')) {
        const relative = normaliseSegments(bare.startsWith('.') ? parentFolder(fromPath) : '', bare);
        const entry = relative ? tables.byPath.get(foldKey(relative)) : null;
        if (entry) return { status: 'resolved', entry };
        const suffix = foldKey(`/${bare.replace(/^\/+/, '')}`);
        const matches = entries.filter(item => foldKey(`/${item.path.replace(/\.md$/i, '')}`).endsWith(suffix));
        if (matches.length === 1) return { status: 'resolved', entry: matches[0] };
        if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
        return { status: 'missing' };
    }
    const key = foldKey(bare);
    for (const table of [tables.byStem, tables.byTitle, tables.byAlias]) {
        const matches = table.get(key) ?? [];
        if (matches.length === 1) return { status: 'resolved', entry: matches[0] };
        if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
    }
    return { status: 'missing' };
}

/** The line a link sits on, cut down to a readable excerpt. */
export function excerptAround(text, start, end) {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const newline = text.indexOf('\n', end);
    const lineEnd = newline === -1 ? text.length : newline;
    let from = Math.max(lineStart, start - SNIPPET_RADIUS);
    let to = Math.min(lineEnd, end + SNIPPET_RADIUS);
    let excerpt = text.slice(from, to).replace(/\r/g, '').trim();
    if (from > lineStart) excerpt = `…${excerpt}`;
    if (to < lineEnd) excerpt = `${excerpt}…`;
    return excerpt;
}

export function outgoingLinks(entries, entry) {
    return entry.links.map(link => {
        const result = resolveLink(entries, link, entry.path);
        return {
            kind: link.kind,
            embed: link.embed,
            raw: link.raw,
            target: link.target,
            fragment: link.fragment,
            label: link.label,
            status: result.status,
            noteId: result.entry?.id ?? null,
            title: result.entry?.title ?? null,
            candidates: result.candidates?.map(item => ({ id: item.id, title: item.title, path: item.path })) ?? [],
            path: result.path ?? null,
        };
    });
}

export function backlinksTo(entries, target, allowed = () => true) {
    const results = [];
    for (const entry of entries) {
        if (entry.id === target.id || !allowed(entry)) continue;
        const passages = [];
        for (const link of entry.links) {
            if (link.kind === 'markdown' && link.external) continue;
            const resolved = resolveLink(entries, link, entry.path);
            if (resolved.status === 'resolved' && resolved.entry.id === target.id) {
                passages.push({ excerpt: excerptAround(entry.text, link.start, link.end), fragment: link.fragment, embed: link.embed });
            }
        }
        if (passages.length) results.push({ id: entry.id, title: entry.title, path: entry.path, passages: passages.slice(0, 5), count: passages.length });
    }
    return results.sort((a, b) => a.title.localeCompare(b.title));
}

function subsequence(needle, haystack) {
    let index = 0;
    for (const char of haystack) {
        if (char === needle[index]) index++;
        if (index === needle.length) return true;
    }
    return false;
}

/**
 * Plain text search with no model and no embeddings. Exact substring matches rank above
 * fuzzy title matches, and every result says which kind of match it was.
 */
export function searchEntries(entries, { query = '', folder = null, tag = null, type = null, property = null, offset = 0, limit = 20 } = {}) {
    const wanted = String(query ?? '').normalize('NFC').toLocaleLowerCase('und').trim();
    const cappedLimit = Math.max(1, Math.min(SEARCH_LIMIT, Number(limit) || 20));
    const start = Math.max(0, Number(offset) || 0);
    const folderKey = folder ? foldKey(folder) : null;
    const tagKey = tag ? foldKey(String(tag).replace(/^#/, '')) : null;
    const results = [];
    for (const entry of entries) {
        if (folderKey !== null && !(foldKey(entry.folder) === folderKey || foldKey(entry.folder).startsWith(`${folderKey}/`))) continue;
        if (tagKey && !entry.tags.some(item => foldKey(item) === tagKey || foldKey(item).startsWith(`${tagKey}/`))) continue;
        if (type && foldKey(entry.type ?? '') !== foldKey(type)) continue;
        if (property?.key) {
            const value = entry.properties[property.key];
            const values = Array.isArray(value) ? value : [value];
            if (value === undefined || (property.value !== undefined && property.value !== '' && !values.some(item => foldKey(String(item)) === foldKey(property.value)))) continue;
        }
        if (!wanted) {
            results.push({ entry, score: 0, match: 'filter', snippet: null });
            continue;
        }
        const title = foldKey(entry.title);
        let score = 0;
        let match = null;
        if (title === wanted) {
            score = 100;
            match = 'title';
        } else if (title.includes(wanted)) {
            score = 80;
            match = 'title';
        } else if (entry.aliases.some(alias => foldKey(alias).includes(wanted))) {
            score = 70;
            match = 'alias';
        }
        const bodyIndex = entry.lower.indexOf(wanted);
        if (bodyIndex !== -1) {
            if (!match) { score = 50; match = 'text'; }
            score += Math.min(10, entry.lower.split(wanted).length - 1);
        }
        if (!match && wanted.length >= 2 && subsequence(wanted, title)) { score = 10; match = 'fuzzy'; }
        if (!match) continue;
        results.push({ entry, score, match, snippet: bodyIndex === -1 ? null : excerptAround(entry.text, bodyIndex, bodyIndex + wanted.length) });
    }
    results.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
    return {
        total: results.length,
        offset: start,
        limit: cappedLimit,
        results: results.slice(start, start + cappedLimit).map(({ entry, match, snippet }) => ({ ...summariseEntry(entry), match, exact: match !== 'fuzzy', snippet })),
    };
}
