import { parseDocument, isMap, isScalar, isSeq } from 'yaml';

export const FRONTMATTER_LIMIT = 64 * 1024;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const BLOCK_ID = /[ \t]\^([A-Za-z0-9][A-Za-z0-9-]{0,63})[ \t]*$/;

/**
 * Splits YAML frontmatter from the body without changing either side.
 * Offsets are UTF-16 indexes into the original text.
 */
export function splitFrontmatter(text) {
    const source = String(text ?? '');
    const bom = source.startsWith('\uFEFF') ? 1 : 0;
    const open = /^---[ \t]*\r?\n/.exec(source.slice(bom));
    if (!open) return { raw: null, data: {}, error: null, bodyStart: 0, body: source };
    const start = bom + open[0].length;
    const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
    close.lastIndex = start;
    let match;
    while ((match = close.exec(source))) {
        if (match.index < start) continue;
        if (match.index !== start && source[match.index - 1] !== '\n') continue;
        const raw = source.slice(start, match.index);
        const bodyStart = match.index + match[0].length;
        const parsed = parseFrontmatterData(raw);
        return { raw, rawStart: start, rawEnd: match.index, data: parsed.data, error: parsed.error, bodyStart, body: source.slice(bodyStart) };
    }
    return { raw: null, data: {}, error: 'The properties block at the top of this note is never closed.', bodyStart: 0, body: source };
}

export function parseFrontmatterData(raw) {
    if (!raw.trim()) return { data: {}, error: null };
    if (Buffer.byteLength(raw, 'utf8') > FRONTMATTER_LIMIT) return { data: {}, error: 'The properties block is too large to read.' };
    try {
        const document = parseDocument(raw, { maxAliasCount: 20, uniqueKeys: true, prettyErrors: false, strict: true });
        if (document.errors.length) return { data: {}, error: 'The properties block is not valid YAML.' };
        const data = document.toJS({ maxAliasCount: 20 });
        if (data === null || data === undefined) return { data: {}, error: null };
        if (typeof data !== 'object' || Array.isArray(data)) return { data: {}, error: 'The properties block must be a list of named fields.' };
        return { data, error: null };
    } catch {
        return { data: {}, error: 'The properties block is not valid YAML.' };
    }
}

function plainValue(value) {
    if (value === null || value === undefined) return null;
    if (['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (Array.isArray(value) && value.every(item => ['string', 'number', 'boolean'].includes(typeof item))) return value;
    return undefined;
}

/** Simple editable properties; nested values stay in the source untouched and are reported as complex. */
export function noteProperties(data) {
    const properties = {};
    const complex = [];
    for (const [key, value] of Object.entries(data || {})) {
        const plain = plainValue(value);
        if (plain === undefined) complex.push(key);
        else properties[key] = plain;
    }
    return { properties, complex };
}

const listOf = value => (Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value])
    .map(item => String(item).trim()).filter(Boolean);

export function frontmatterTags(data) {
    return listOf(data?.tags ?? data?.tag).map(tag => tag.replace(/^#/, '')).filter(Boolean);
}

export function frontmatterAliases(data) {
    return listOf(data?.aliases ?? data?.alias);
}

/**
 * Applies property changes through the YAML document model so comments, ordering and
 * nested or unknown fields survive. `changes` maps keys to a value, or to null to remove.
 */
export function updateFrontmatter(text, changes) {
    const source = String(text ?? '');
    const split = splitFrontmatter(source);
    if (split.error) throw Object.assign(new Error(split.error), { code: 'NOTE_PROPERTIES_INVALID' });
    const document = parseDocument(split.raw ?? '', { maxAliasCount: 20, uniqueKeys: true });
    if (document.contents !== null && !isMap(document.contents)) throw Object.assign(new Error('The properties block must be a list of named fields.'), { code: 'NOTE_PROPERTIES_INVALID' });
    for (const [key, value] of Object.entries(changes)) {
        if (!/^[^\s:#][^:\n]{0,63}$/u.test(key)) throw Object.assign(new Error('A property name is invalid.'), { code: 'NOTE_PROPERTIES_INVALID' });
        if (value === null || value === undefined || (Array.isArray(value) && !value.length)) {
            document.delete(key);
            continue;
        }
        if (plainValue(value) === undefined) throw Object.assign(new Error('Properties can be text, numbers, yes/no values or lists.'), { code: 'NOTE_PROPERTIES_INVALID' });
        const existing = document.get(key, true);
        if (isScalar(existing) && !Array.isArray(value)) existing.value = value;
        else if (isSeq(existing) && Array.isArray(value)) existing.items = document.createNode(value).items;
        else document.set(key, value);
    }
    const empty = !document.contents || (isMap(document.contents) && !document.contents.items.length);
    const yaml = empty ? '' : String(document);
    if (split.raw === null) {
        if (empty) return source;
        const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
        return `${bom}---\n${yaml}---\n${source.slice(bom.length)}`;
    }
    if (empty) return source.slice(0, source.startsWith('\uFEFF') ? 1 : 0) + source.slice(split.bodyStart);
    return source.slice(0, split.rawStart) + yaml + source.slice(split.rawEnd);
}

/**
 * Line scanner that marks fenced code and HTML comments so links, tags and headings inside
 * them are ignored. Returns line records with offsets into `text`.
 */
export function scanLines(text, base = 0) {
    const lines = [];
    let fence = null;
    let comment = false;
    let offset = 0;
    const source = String(text ?? '');
    while (offset <= source.length) {
        const newline = source.indexOf('\n', offset);
        const end = newline === -1 ? source.length : newline;
        const raw = source.slice(offset, end).replace(/\r$/, '');
        let kind = 'text';
        if (fence) {
            kind = 'code';
            const close = FENCE.exec(raw);
            if (close && close[2][0] === fence[0] && close[2].length >= fence.length && !close[3].trim()) fence = null;
        } else if (comment) {
            kind = 'comment';
            if (raw.includes('-->')) comment = false;
        } else {
            const open = FENCE.exec(raw);
            if (open && !(open[2][0] === '`' && open[3].includes('`'))) {
                fence = open[2];
                kind = 'code';
            } else if (/^ {0,3}<!--/.test(raw) && !raw.includes('-->')) {
                comment = true;
                kind = 'comment';
            }
        }
        lines.push({ text: raw, start: base + offset, end: base + end, kind });
        if (newline === -1) break;
        offset = newline + 1;
    }
    return lines;
}

export function slugHeading(text) {
    return String(text ?? '').normalize('NFC').trim().toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
}

/** Headings with nesting paths and section ranges (heading line through to the next heading of the same or higher level). */
export function headingsOf(text) {
    const source = String(text ?? '');
    const split = splitFrontmatter(source);
    const lines = scanLines(split.body, split.bodyStart);
    const headings = [];
    for (const line of lines) {
        if (line.kind !== 'text') continue;
        const match = HEADING.exec(line.text);
        if (!match) continue;
        let title = (match[2] ?? '').trim();
        const block = BLOCK_ID.exec(title);
        if (block) title = title.slice(0, block.index).trim();
        headings.push({ level: match[1].length, text: title, blockId: block?.[1] ?? null, start: line.start, lineEnd: line.end });
    }
    const stack = [];
    headings.forEach((heading, index) => {
        while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
        heading.path = [...stack.map(item => item.text), heading.text];
        stack.push(heading);
        let end = source.length;
        for (let next = index + 1; next < headings.length; next++) {
            if (headings[next].level <= heading.level) { end = headings[next].start; break; }
        }
        heading.end = end;
        heading.bodyStart = Math.min(heading.lineEnd + 1, end);
        heading.id = heading.blockId ? `^${heading.blockId}` : heading.path.map(slugHeading).join('/');
    });
    return headings;
}

/**
 * Resolves a section selector. A selector is { kind: 'heading', path: [...] } or { kind: 'block', id }.
 * Returns { status: 'ok', heading } | { status: 'missing' } | { status: 'ambiguous', count }.
 */
export function resolveSection(text, selector) {
    const headings = headingsOf(text);
    let matches = [];
    if (selector?.kind === 'block') matches = headings.filter(item => item.blockId === selector.id);
    else if (selector?.kind === 'heading' && Array.isArray(selector.path) && selector.path.length) {
        const wanted = selector.path.map(item => String(item).normalize('NFC'));
        matches = headings.filter(item => item.path.length === wanted.length && item.path.every((part, i) => part.normalize('NFC') === wanted[i]));
    } else if (selector?.kind === 'id') matches = headings.filter(item => item.id === selector.id);
    if (!matches.length) return { status: 'missing' };
    if (matches.length > 1) return { status: 'ambiguous', count: matches.length };
    return { status: 'ok', heading: matches[0] };
}

/** The exact text under a heading, without the heading line, with only edge blank lines removed. */
export function sectionBody(text, heading) {
    return String(text).slice(heading.bodyStart, heading.end).replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');
}

export function noteBody(text) {
    return splitFrontmatter(text).body.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');
}

function codeSpans(line) {
    const spans = [];
    const pattern = /(`+)([\s\S]*?[^`])\1(?!`)/g;
    let match;
    while ((match = pattern.exec(line))) spans.push([match.index, match.index + match[0].length]);
    return spans;
}

const insideSpan = (spans, index) => spans.some(([start, end]) => index >= start && index < end);
const escaped = (line, index) => {
    let count = 0;
    for (let i = index - 1; i >= 0 && line[i] === '\\'; i--) count++;
    return count % 2 === 1;
};

export function parseWikiTarget(inner) {
    const pipe = inner.indexOf('|');
    const reference = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const label = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null;
    const hash = reference.indexOf('#');
    const target = (hash === -1 ? reference : reference.slice(0, hash)).trim();
    const fragment = hash === -1 ? null : reference.slice(hash + 1).trim() || null;
    return { target, fragment, label };
}

/** Links outside code, comments and escapes, with exact offsets into the full text. */
export function extractLinks(text) {
    const source = String(text ?? '');
    const split = splitFrontmatter(source);
    const links = [];
    for (const line of scanLines(split.body, split.bodyStart)) {
        if (line.kind !== 'text') continue;
        const spans = codeSpans(line.text);
        const wiki = /(!?)\[\[([^[\]\n]+?)\]\]/g;
        let match;
        while ((match = wiki.exec(line.text))) {
            if (insideSpan(spans, match.index) || escaped(line.text, match.index)) continue;
            const parsed = parseWikiTarget(match[2]);
            if (!parsed.target && !parsed.fragment) continue;
            links.push({ kind: 'wiki', embed: match[1] === '!', ...parsed, raw: match[0], start: line.start + match.index, end: line.start + match.index + match[0].length });
        }
        const markdown = /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^>\n]+>|[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
        while ((match = markdown.exec(line.text))) {
            if (insideSpan(spans, match.index) || escaped(line.text, match.index)) continue;
            if (line.text[match.index - 1] === '[' && line.text[match.index] !== '!') continue;
            let href = match[3].startsWith('<') ? match[3].slice(1, -1) : match[3];
            const external = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
            const hash = href.indexOf('#');
            let target = hash === -1 ? href : href.slice(0, hash);
            const fragment = hash === -1 ? null : decodeSafe(href.slice(hash + 1)) || null;
            target = decodeSafe(target);
            links.push({ kind: 'markdown', embed: match[1] === '!', external, target, fragment, label: match[2] || null, href, raw: match[0], start: line.start + match.index, end: line.start + match.index + match[0].length });
        }
    }
    return links;
}

function decodeSafe(value) {
    try { return decodeURIComponent(value); } catch { return value; }
}

export function inlineTags(text) {
    const split = splitFrontmatter(text);
    const tags = new Set();
    for (const line of scanLines(split.body, split.bodyStart)) {
        if (line.kind !== 'text') continue;
        const spans = codeSpans(line.text);
        const pattern = /(^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
        let match;
        while ((match = pattern.exec(line.text))) {
            const index = match.index + match[1].length;
            if (insideSpan(spans, index) || escaped(line.text, index)) continue;
            tags.add(match[2]);
        }
    }
    return [...tags];
}

export function noteTitle(text, fallback) {
    const split = splitFrontmatter(text);
    const title = typeof split.data?.title === 'string' ? split.data.title.trim() : '';
    return title || fallback;
}

/** Plain searchable text: body without frontmatter. Literal, nothing is executed or expanded. */
export function searchableText(text) {
    return splitFrontmatter(text).body;
}

/** Heading-aware chunks for scoped reference use. */
export function chunkNote(text, { maxChars = 2400 } = {}) {
    const source = String(text ?? '');
    const split = splitFrontmatter(source);
    const headings = headingsOf(source);
    const chunks = [];
    const push = (path, start, end) => {
        const body = source.slice(start, end).trim();
        if (!body) return;
        for (let offset = 0; offset < body.length; offset += maxChars) {
            chunks.push({ path, start, end, text: body.slice(offset, offset + maxChars) });
        }
    };
    let cursor = split.bodyStart;
    const leaves = headings;
    if (!leaves.length) {
        push([], cursor, source.length);
        return chunks;
    }
    if (leaves[0].start > cursor) push([], cursor, leaves[0].start);
    leaves.forEach((heading, index) => {
        const next = leaves[index + 1]?.start ?? source.length;
        push(heading.path, heading.start, next);
    });
    return chunks;
}
