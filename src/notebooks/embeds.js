import { headingSections } from '../../public/scripts/notebooks/folding.js';
import { extractLinks, scanLines, slugHeading, splitFrontmatter } from './markdown.js';
import { permissionAwareResolver } from './note-index.js';

export const EMBED_LIMITS = Object.freeze({ depth: 5, count: 32, noteBytes: 64 * 1024, totalBytes: 256 * 1024 });
const UNAVAILABLE = 'Embedded note unavailable.';
const LIMITED = 'Embedded note preview limit reached.';
const BLOCK_MARKER = /(?:^|[ \t])\^([A-Za-z0-9][A-Za-z0-9-]{0,63})[ \t]*$/;

function documentSections(text) {
    const source = String(text);
    const split = splitFrontmatter(source);
    const lines = scanLines(split.body, split.bodyStart).map(line => line.start === 0 && source.charCodeAt(0) === 0xFEFF
        ? { ...line, start: 1, text: line.text.replace(/^\uFEFF/, '') } : line);
    const allowed = new Set(lines.filter(line => line.kind === 'text').map(line => line.start));
    const headings = headingSections(source).map(heading => ({ ...heading,
        offset: heading.offset === 0 && source.charCodeAt(0) === 0xFEFF ? 1 : heading.offset,
    })).filter(heading => allowed.has(heading.offset));
    const stack = [];
    for (const heading of headings) {
        while (stack.length && stack.at(-1).level >= heading.level) stack.pop().end = heading.offset;
        heading.path = [...stack.map(item => item.text), heading.text];
        heading.end = source.length;
        stack.push(heading);
    }
    return { source, split, lines, headings };
}

/** Selects an exact heading or paragraph/list block; missing and duplicate selectors are never guessed. */
export function resolveEmbedRegion(text, fragment = '') {
    const source = String(text);
    if (!fragment) {
        const split = splitFrontmatter(source);
        return { text: split.body, key: 'note', label: null };
    }
    const { lines, headings } = documentSections(source);
    const wanted = String(fragment).normalize('NFC').trim();
    if (wanted.startsWith('^')) {
        if (!/^\^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(wanted)) return null;
        const matches = [];
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            if (line.kind !== 'text') continue;
            const marker = BLOCK_MARKER.exec(line.text);
            if (!marker || `^${marker[1]}` !== wanted) continue;
            const heading = headings.find(item => item.offset === line.start);
            if (heading) {
                matches.push({ start: heading.offset, end: heading.end, label: heading.text });
                continue;
            }
            let first = index;
            if (line.text.trim() === wanted) {
                first--;
                while (first >= 0 && !lines[first].text.trim()) first--;
                if (first < 0) continue;
            }
            while (first > 0 && lines[first - 1].text.trim() && lines[first - 1].kind !== 'comment'
                && !headings.some(item => item.offset === lines[first - 1].start)) first--;
            const start = lines[first].start;
            if (headings.some(item => item.offset === start)) continue;
            matches.push({ start, end: line.end, label: wanted });
        }
        if (matches.length !== 1) return null;
        const match = matches[0];
        return { text: source.slice(match.start, match.end).replace(/(?:^|[ \t])\^[A-Za-z0-9][A-Za-z0-9-]{0,63}[ \t]*(?=\r?$)/m, '').replace(/\r$/, ''), key: `region:${match.start}:${match.end}`, label: match.label };
    }
    const path = wanted.split(/[/#]/).map(part => part.trim());
    const normalise = value => String(value).normalize('NFC').toLocaleLowerCase('und');
    const matches = headings.filter(heading => normalise(heading.text) === normalise(wanted) || normalise(slugHeading(heading.text)) === normalise(wanted)
        || (path.length > 1 && heading.path.length === path.length && heading.path.every((part, index) => normalise(part) === normalise(path[index]) || normalise(slugHeading(part)) === normalise(path[index]))));
    if (matches.length !== 1) return null;
    const heading = matches[0];
    return { text: source.slice(heading.offset, heading.end), key: `region:${heading.offset}:${heading.end}`, label: heading.text };
}

/** A read-only projection. Callers must supply visibility; links never grant target access. */
export function buildNoteEmbeds(entries, { sourceId, text, canRead } = {}) {
    const resolver = permissionAwareResolver(entries, canRead);
    const source = resolver.entries.find(entry => entry.id === sourceId);
    const result = { status: source ? 'success' : 'unavailable', embeds: [], limited: false, limits: EMBED_LIMITS };
    if (!source) return result;
    let count = 0;
    let bytes = 0;
    const regions = new Map();
    const placeholder = (link, limited = false) => ({ start: link.start, end: link.end, status: limited ? 'limited' : 'unavailable', message: limited ? LIMITED : UNAVAILABLE });

    function children(markdown, fromPath, depth, ancestors, indexed = null) {
        const output = [];
        const links = indexed ?? extractLinks(markdown);
        for (const link of links) {
            if (!link.embed || link.kind !== 'wiki') continue;
            if (count >= EMBED_LIMITS.count) {
                result.limited = true;
                break;
            }
            count++;
            if (depth > EMBED_LIMITS.depth || link.raw.length > 1024) {
                output.push(placeholder(link, true));
                result.limited = true;
                continue;
            }
            const resolved = resolver.resolve(link, fromPath);
            if (resolved.status !== 'resolved') {
                output.push(placeholder(link));
                continue;
            }
            const entry = resolved.entry;
            const regionKey = `${entry.id}:${link.fragment ?? ''}`;
            if (!regions.has(regionKey)) regions.set(regionKey, resolveEmbedRegion(entry.text, link.fragment));
            const region = regions.get(regionKey);
            if (!region) {
                output.push(placeholder(link));
                continue;
            }
            const key = `${entry.id}:${region.key}`;
            if (ancestors.has(key) || Buffer.byteLength(region.text, 'utf8') > EMBED_LIMITS.noteBytes) {
                output.push(placeholder(link, true));
                result.limited = true;
                continue;
            }
            const node = { start: link.start, end: link.end, status: 'rendered', noteId: entry.id, title: entry.title.slice(0, 200),
                path: entry.path, revision: entry.hash, fragment: link.fragment ?? null, section: region.label, text: region.text, embeds: [] };
            const cost = Buffer.byteLength(JSON.stringify(node), 'utf8');
            // Reserve space for placeholders, separators and the response envelope as well as note text.
            if (bytes + cost > EMBED_LIMITS.totalBytes - 8 * 1024) {
                output.push(placeholder(link, true));
                result.limited = true;
                continue;
            }
            bytes += cost;
            const next = new Set(ancestors);
            next.add(key);
            node.embeds = children(region.text, entry.path, depth + 1, next);
            output.push(node);
        }
        return output;
    }

    const markdown = typeof text === 'string' ? text : source.text;
    result.embeds = children(markdown, source.path, 1, new Set([`${source.id}:note`]), markdown === source.text ? source.links : null);
    return result;
}
