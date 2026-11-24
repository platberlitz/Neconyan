// Read-only lookups in Neconyan's own source code for Scratchpad's 'Neconyan source code' switch.
// Only public/script.js, public/scripts/ and src/ can be read. Config, secrets, user data,
// packages, git and build output stay out of reach, and no absolute host path is ever returned.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverDirectory } from '../server-directory.js';
import { originalPositionFor } from './source-map.js';

export const SOURCE_BLOCK_BYTES = 28 * 1024;
export const MAX_READ_LINES = 120;
export const MAX_FILE_BYTES = 1536 * 1024;
export const MAX_SEARCH_RESULTS = 12;
export const MAX_LIST_RESULTS = 60;
export const SOURCE_TAG = 'neconyan_source';

const MAX_PATH_LENGTH = 300;
const MAX_QUERY_LENGTH = 120;
const MAX_SEARCH_BYTES = 48 * 1024 * 1024;
const MAX_MAP_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCES = 24;
const MAX_DETERMINISTIC_READS = 6;
const LINE_CHARS = 320;
const STACK_CONTEXT = 12;
const HEAD_LINES = 40;
const LISTING_TTL_MS = 30_000;

const SOURCE_ROOTS = Object.freeze([
    { prefix: 'public/scripts/', extensions: ['.js', '.mjs', '.cjs', '.css', '.html'] },
    { prefix: 'src/', extensions: ['.js', '.mjs', '.cjs'] },
]);
const SINGLE_FILES = Object.freeze(['public/script.js']);
// Third-party bundles and anything that could hold user data, packages or build output.
const BLOCKED_SEGMENTS = new Set(['node_modules', '.git', 'data', 'default', 'dist', 'lib', 'vendor', '.sourcemaps', '.github']);
const BLOCKED_NAME = /^(?:config\.ya?ml|secrets\.json|package(?:-lock)?\.json|bun\.lockb?|\.env.*|.*\.min\.(?:m?js|css))$/i;
const HASHED_NAME = /-[a-f0-9]{8,}(?=\.[a-z0-9]+$)/i;

const SECRET_PATTERNS = [
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"`]+:[^\s/@'"`]+@/gi, '$1[redacted]@'],
    [/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{20,}=*/g, '$1 [redacted]'],
    [/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{2,}){1,2}/g, '[redacted]'],
    [/\b(?:sk|pk|rk|gsk|hf|nvapi|pplx|xai|glpat|fw|r8)[-_](?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{16,}/g, '[redacted]'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\bAIza[0-9A-Za-z_-]{20,}|\bA(?:KIA|SIA)[0-9A-Z]{12,}/g, '[redacted]'],
    // A long quoted run of letters and digits with no spaces reads as a key, not as code.
    [/(['"`])(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{40,}\1/g, '$1[redacted]$1'],
];

function rootOf(options) {
    return path.resolve(options?.root || serverDirectory);
}

function realRoot(root) {
    try {
        return fs.realpathSync(root);
    } catch {
        return root;
    }
}

/** Removes absolute host paths, home folders and credential-looking strings from text that leaves the server. */
export function scrubSourceText(value, options = {}) {
    let text = String(value ?? '');
    const root = rootOf(options);
    for (const base of [...new Set([realRoot(root), root])].sort((a, b) => b.length - a.length)) {
        if (base.length < 2) continue;
        for (const form of new Set([base, base.replaceAll('\\', '/')])) {
            text = text.split(`${form}/`).join('').split(`${form}\\`).join('').split(form).join('.');
        }
    }
    const home = os.homedir();
    if (home && home.length > 1) text = text.split(home).join('~');
    text = text.replace(/(^|[\s('"`=:])\/(?:home|Users|root)\/[^\s/'"`)]+/g, '$1~').replace(/\b[A-Za-z]:\\Users\\[^\s\\'"`)]+/g, '~');
    for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
    return text;
}

/**
 * Checks a requested path against the allow-list without touching the disk.
 * Returns the repo-relative POSIX path, or null when it is not a readable source file.
 */
export function normaliseSourcePath(input) {
    if (typeof input !== 'string') return null;
    const raw = input.trim();
    if (!raw || raw.length > MAX_PATH_LENGTH) return null;
    // Null bytes, control characters, encoded segments, absolute and drive paths are refused outright.
    if (/[\u0000-\u001F\u007F%]/.test(raw) || raw.includes('\\')) return null;
    if (raw.startsWith('/') || raw.startsWith('~') || /^[a-z]:/i.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
    const relative = raw.replace(/^(?:\.\/)+/, '');
    const segments = relative.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.trim() !== segment)) return null;
    if (segments.some(segment => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) return null;
    const name = segments.at(-1);
    if (BLOCKED_NAME.test(name)) return null;
    if (SINGLE_FILES.includes(relative)) return relative;
    const extension = path.posix.extname(name).toLowerCase();
    const allowed = SOURCE_ROOTS.find(item => relative.startsWith(item.prefix) && relative.length > item.prefix.length);
    if (!allowed || !allowed.extensions.includes(extension)) return null;
    return relative;
}

/** Checks a folder prefix for search and list requests. An empty prefix means every source root. */
export function normaliseSourcePrefix(input) {
    if (input === undefined || input === null || input === '') return '';
    if (typeof input !== 'string') return null;
    const raw = input.trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (raw.length > MAX_PATH_LENGTH || /[\u0000-\u001F\u007F%]/.test(raw) || raw.includes('\\')) return null;
    if (raw.startsWith('/') || raw.startsWith('~') || /^[a-z]:/i.test(raw)) return null;
    const relative = raw.replace(/^(?:\.\/)+/, '');
    const segments = relative.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
    if (segments.some(segment => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) return null;
    if (SINGLE_FILES.includes(relative)) return relative;
    if (relative === 'public') return 'public/';
    if (relative === 'public/scripts' || relative === 'src') return `${relative}/`;
    if (SOURCE_ROOTS.some(item => `${relative}/`.startsWith(item.prefix))) return normaliseSourcePath(relative) ?? `${relative}/`;
    return null;
}

function isInside(child, parent) {
    const relative = path.relative(parent, child);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Finds an allowed source file on disk. Symbolic links must end inside the same source roots.
 * Returns { path, absolute, size } or null.
 */
export function resolveSourceFile(input, options = {}) {
    const relative = normaliseSourcePath(input);
    if (!relative) return null;
    const root = realRoot(rootOf(options));
    try {
        const absolute = fs.realpathSync(path.join(root, ...relative.split('/')));
        const allowedRoots = [
            ...SOURCE_ROOTS.map(item => path.join(root, ...item.prefix.split('/').filter(Boolean))),
        ].map(realRoot);
        const single = SINGLE_FILES.map(file => path.join(root, ...file.split('/')));
        const inRoot = allowedRoots.some(base => isInside(absolute, base) && absolute !== base)
            || single.some(file => absolute === realRoot(file));
        if (!inRoot) return null;
        // The real file must pass the same allow-list as the name that was asked for.
        const realRelative = path.relative(root, absolute).split(path.sep).join('/');
        if (normaliseSourcePath(realRelative) !== realRelative) return null;
        const stat = fs.statSync(absolute);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
        return { path: relative, absolute, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
        return null;
    }
}

const lineCache = new Map();

function fileLines(file) {
    const key = `${file.absolute}:${file.size}:${file.mtimeMs}`;
    const cached = lineCache.get(key);
    if (cached) {
        lineCache.delete(key);
        lineCache.set(key, cached);
        return cached;
    }
    let text;
    try {
        text = fs.readFileSync(file.absolute, 'utf8');
    } catch {
        return null;
    }
    if (text.slice(0, 8192).includes('\u0000')) return null;
    const lines = text.split(/\r?\n/);
    // A final newline ends the last line; it does not start another one.
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    lineCache.set(key, lines);
    while (lineCache.size > 12) lineCache.delete(lineCache.keys().next().value);
    return lines;
}

function shownLine(text, options) {
    const line = String(text ?? '').replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
    const clipped = line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)} …` : line;
    return scrubSourceText(clipped, options).trimEnd();
}

/**
 * Reads a numbered slice of one source file, at most MAX_READ_LINES lines.
 * Returns { path, start, end, total, text } where every line reads '42: code', or null.
 */
export function readSourceWindow(input, { start = 1, end } = {}, options = {}) {
    const file = resolveSourceFile(input, options);
    if (!file) return null;
    const lines = fileLines(file);
    if (!lines) return null;
    const total = lines.length;
    let first = Number.isSafeInteger(Number(start)) ? Math.trunc(Number(start)) : 1;
    first = Math.min(Math.max(first, 1), total);
    let last = Number.isSafeInteger(Number(end)) ? Math.trunc(Number(end)) : first + HEAD_LINES - 1;
    last = Math.min(Math.max(last, first), total, first + MAX_READ_LINES - 1);
    const text = [];
    for (let line = first; line <= last; line++) text.push(`${line}: ${shownLine(lines[line - 1], options)}`);
    return { path: file.path, start: first, end: last, total, text: text.join('\n') };
}

const listingCache = new Map();

function walk(root, directory, prefix, output) {
    let entries;
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        if (BLOCKED_SEGMENTS.has(entry.name.toLowerCase())) continue;
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory()) {
            walk(root, path.join(directory, entry.name), `${relative}/`, output);
        } else if (entry.isFile() && normaliseSourcePath(relative) === relative) {
            output.push(relative);
        } else if (entry.isSymbolicLink() && normaliseSourcePath(relative) === relative && resolveSourceFile(relative, { root })) {
            output.push(relative);
        }
    }
}

/** Every allowed source path, sorted, cached briefly. */
export function allSourceFiles(options = {}) {
    const root = realRoot(rootOf(options));
    const cached = listingCache.get(root);
    if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.files;
    const files = [];
    for (const file of SINGLE_FILES) if (fs.existsSync(path.join(root, ...file.split('/')))) files.push(file);
    for (const item of SOURCE_ROOTS) walk(root, path.join(root, ...item.prefix.split('/').filter(Boolean)), item.prefix, files);
    listingCache.set(root, { at: Date.now(), files });
    return files;
}

function underPrefix(file, prefix) {
    if (!prefix) return true;
    return prefix.endsWith('/') ? file.startsWith(prefix) || (prefix === 'public/' && file === 'public/script.js') : file === prefix;
}

function cleanQuery(value) {
    if (typeof value !== 'string') return '';
    const query = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    return query.length >= 2 && query.length <= MAX_QUERY_LENGTH ? query : '';
}

/** Lists source files under a prefix whose path contains a fragment, ignoring case. */
export function listSourceFiles({ prefix = '', query = '', limit = MAX_LIST_RESULTS } = {}, options = {}) {
    const folder = normaliseSourcePrefix(prefix);
    if (folder === null) return null;
    const fragment = typeof query === 'string' ? query.trim().toLowerCase().slice(0, MAX_QUERY_LENGTH) : '';
    const matches = allSourceFiles(options).filter(file => underPrefix(file, folder) && (!fragment || file.toLowerCase().includes(fragment)));
    const cap = Math.min(Math.max(1, Math.trunc(Number(limit) || MAX_LIST_RESULTS)), MAX_LIST_RESULTS);
    return { prefix: folder, query: fragment, files: matches.slice(0, cap), total: matches.length };
}

/**
 * Plain, case-insensitive substring search. No regular expression is built from the query.
 * Returns { query, prefix, results: [{ path, line, text }], truncated } or null for a bad request.
 */
export function searchSource({ query, prefix = '', limit = MAX_SEARCH_RESULTS } = {}, options = {}) {
    const text = cleanQuery(query);
    const folder = normaliseSourcePrefix(prefix);
    if (!text || folder === null) return null;
    const needle = text.toLowerCase();
    const cap = Math.min(Math.max(1, Math.trunc(Number(limit) || MAX_SEARCH_RESULTS)), MAX_SEARCH_RESULTS);
    const results = [];
    let scanned = 0;
    let truncated = false;
    for (const relative of allSourceFiles(options)) {
        if (!underPrefix(relative, folder)) continue;
        const file = resolveSourceFile(relative, options);
        if (!file) continue;
        if (scanned + file.size > MAX_SEARCH_BYTES) {
            truncated = true;
            break;
        }
        scanned += file.size;
        const lines = fileLines(file);
        if (!lines) continue;
        for (let index = 0; index < lines.length; index++) {
            if (!lines[index].toLowerCase().includes(needle)) continue;
            if (results.length >= cap) {
                truncated = true;
                break;
            }
            results.push({ path: relative, line: index + 1, text: shownLine(lines[index].trim(), options) });
        }
        if (truncated) break;
    }
    return { query: text, prefix: folder, results, truncated };
}

const manifestCache = new Map();

function distRootOf(options) {
    return path.resolve(options?.distRoot || path.join(rootOf(options), 'dist', 'frontend'));
}

function readJson(file, limit) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > limit) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function builtAssetIndex(options) {
    const distRoot = distRootOf(options);
    const file = path.join(distRoot, 'asset-manifest.json');
    let stamp = '';
    try {
        const stat = fs.statSync(file);
        stamp = `${stat.size}:${stat.mtimeMs}`;
    } catch {
        return null;
    }
    const cached = manifestCache.get(file);
    if (cached?.stamp === stamp) return cached.index;
    const manifest = readJson(file, MAX_MANIFEST_BYTES);
    const index = new Map();
    for (const [source, entry] of Object.entries(manifest?.assets || {})) {
        if (typeof entry?.output !== 'string') continue;
        index.set(entry.output, { source: `public/${source}`, map: typeof entry.map === 'string' ? entry.map : '' });
    }
    manifestCache.set(file, { stamp, index });
    return index;
}

function readBuiltMap(mapPath, options) {
    if (typeof mapPath !== 'string' || !/^\.sourcemaps\/(?:[\w.@-]+\/)*[\w.@-]+\.map$/.test(mapPath) || mapPath.split('/').includes('..')) return null;
    const distRoot = distRootOf(options);
    const base = path.join(distRoot, '.sourcemaps');
    const file = path.join(distRoot, ...mapPath.split('/'));
    try {
        if (!isInside(fs.realpathSync(file), realRoot(base))) return null;
    } catch {
        return null;
    }
    return readJson(file, MAX_MAP_BYTES);
}

/**
 * Maps a position in a built, hashed asset (as served under /frontend-assets/) back to its original file.
 * Returns { path, line?, column?, name?, mapped, note? } or null when the asset is unknown.
 */
export function resolveBuiltPosition(output, line, column, options = {}) {
    const asset = typeof output === 'string' ? output.replace(/^\/+/, '') : '';
    if (!asset || asset.split('/').some(segment => segment === '..' || !segment)) return null;
    const index = builtAssetIndex(options);
    const entry = index?.get(asset);
    const fallback = `public/${asset.replace(HASHED_NAME, '')}`;
    const original = entry?.source || fallback;
    if (!normaliseSourcePath(original) || !resolveSourceFile(original, options)) return null;
    const map = entry?.map ? readBuiltMap(entry.map, options) : null;
    if (map && Number.isSafeInteger(line) && Number.isSafeInteger(column)) {
        const position = originalPositionFor(map, { line, column });
        const mappedPath = position ? normaliseSourcePath(position.source) : null;
        if (position && mappedPath) {
            return { path: mappedPath, line: position.line, column: position.column, ...(position.name ? { name: position.name } : {}), mapped: true };
        }
    }
    return { path: original, mapped: false, note: map ? 'the source map has no entry for that spot, so the exact line is unmapped' : 'no source map was found for this built file, so the exact line is unmapped' };
}

const BUILT_ASSET = /(?:https?:\/\/[^\s/()'"`]+)?\/frontend-assets\/((?:[\w.@-]+\/)*[\w.@-]+-[a-f0-9]{8,}\.(?:m?js|css))(?::(\d+))?(?::(\d+))?/gi;
const PUBLIC_URL = /(?:https?:\/\/[^\s/()'"`]+|(?<![\w.@/-]))\/((?:scripts\/(?:[\w.@-]+\/)*[\w.@-]+\.(?:m?js|cjs|css|html))|script\.js)(?::(\d+))?(?::(\d+))?/gi;
const REPO_PATH = /(?<![\w.@-])((?:public\/scripts\/(?:[\w.@-]+\/)*[\w.@-]+\.(?:m?js|cjs|css|html))|public\/script\.js|src\/(?:[\w.@-]+\/)*[\w.@-]+\.(?:m?js|cjs))(?::(\d+))?(?::(\d+))?/g;
const API_ROUTE = /(?<![\w.@-])\/api\/([a-z0-9][\w-]*)((?:\/[\w-]+)*)/gi;
const STACK_NAME = /(?:^|\s)at (?:async )?(?:new )?([\w$.<>]+) [([]|(?:^|\s)([\w$.]+)@(?:https?:|\/|file:)/;
const ERROR_CODE = /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+){1,5}\b/g;
const IGNORED_NAMES = new Set(['Object.<anonymous>', '<anonymous>', 'eval', 'new', 'async', 'Promise', 'Array', 'Function']);

function positiveInt(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function frameName(line) {
    const match = STACK_NAME.exec(line);
    const raw = match?.[1] || match?.[2] || '';
    if (!raw || IGNORED_NAMES.has(raw)) return '';
    const name = raw.split('.').filter(part => part && !/^<.*>$/.test(part)).at(-1) || '';
    return /^[A-Za-z_$][\w$]{2,79}$/.test(name) && !IGNORED_NAMES.has(name) ? name : '';
}

/**
 * Pulls file locations, built-asset positions, API routes and error codes out of a question and its App evidence.
 * Each reference is { kind: 'file'|'built'|'route'|'code', ... }, deduplicated and capped.
 */
export function findSourceReferences(text) {
    const value = typeof text === 'string' ? text.slice(0, 64 * 1024) : '';
    const references = [];
    const seen = new Set();
    const add = reference => {
        const key = JSON.stringify(reference);
        if (seen.has(key) || references.length >= MAX_REFERENCES) return;
        seen.add(key);
        references.push(reference);
    };
    for (const line of value.split(/\r?\n/)) {
        const name = frameName(line);
        const taken = [];
        const claim = (match, length) => taken.push([match.index, match.index + length]);
        const overlaps = match => taken.some(([from, to]) => match.index < to && match.index + match[0].length > from);
        for (const match of line.matchAll(BUILT_ASSET)) {
            claim(match, match[0].length);
            add({ kind: 'built', output: match[1], line: positiveInt(match[2]), column: positiveInt(match[3]), ...(name ? { name } : {}), origin: `/frontend-assets/${match[1]}${match[2] ? `:${match[2]}` : ''}${match[3] ? `:${match[3]}` : ''}` });
        }
        for (const match of line.matchAll(REPO_PATH)) {
            if (overlaps(match)) continue;
            // A path inside someone else's package is not Neconyan's code.
            const before = line.slice(Math.max(0, match.index - 200), match.index);
            if (/node_modules\/[^\s]*$/.test(before)) continue;
            claim(match, match[0].length);
            add({ kind: 'file', path: match[1], line: positiveInt(match[2]), column: positiveInt(match[3]), ...(name ? { name } : {}) });
        }
        for (const match of line.matchAll(PUBLIC_URL)) {
            if (overlaps(match)) continue;
            claim(match, match[0].length);
            add({ kind: 'file', path: `public/${match[1]}`, line: positiveInt(match[2]), column: positiveInt(match[3]), ...(name ? { name } : {}) });
        }
        for (const match of line.matchAll(API_ROUTE)) {
            if (overlaps(match)) continue;
            add({ kind: 'route', group: match[1].toLowerCase(), route: `/api/${match[1]}${match[2] || ''}` });
        }
        for (const match of line.matchAll(ERROR_CODE)) add({ kind: 'code', code: match[0] });
    }
    // Routes and error codes are weaker hints than real stack positions, so they go last.
    const rank = { built: 0, file: 0, route: 1, code: 2 };
    return references.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

function windowAround(line, total) {
    const start = Math.max(1, line - STACK_CONTEXT);
    return { start, end: Math.min(total || line + STACK_CONTEXT, line + STACK_CONTEXT) };
}

function findInFile(file, needle, options) {
    if (!needle) return 0;
    const lines = fileLines(resolveSourceFile(file, options) || {});
    if (!lines) return 0;
    const lower = needle.toLowerCase();
    const index = lines.findIndex(text => text.toLowerCase().includes(lower));
    return index + 1;
}

function definitionLine(file, name, options) {
    if (!name) return 0;
    const lines = fileLines(resolveSourceFile(file, options) || {});
    if (!lines) return 0;
    const patterns = [`function ${name}(`, `function ${name} (`, `${name} = (`, `${name} = async`, `${name}(`, name];
    for (const pattern of patterns) {
        const index = lines.findIndex(text => text.includes(pattern));
        if (index >= 0) return index + 1;
    }
    return 0;
}

/**
 * Turns one reference into a numbered read, or null when nothing readable matches.
 * Returns { type: 'read', path, start, end, total, text, reason, stack? }.
 */
export function resolveSourceReference(reference, options = {}) {
    if (!reference || typeof reference !== 'object') return null;
    const read = (file, line, reason, extra = {}) => {
        const found = resolveSourceFile(file, options);
        if (!found) return null;
        const lines = fileLines(found);
        if (!lines) return null;
        const range = line ? windowAround(line, lines.length) : { start: 1, end: HEAD_LINES };
        const slice = readSourceWindow(found.path, range, options);
        return slice ? { type: 'read', ...slice, reason, ...extra } : null;
    };
    if (reference.kind === 'built') {
        const position = resolveBuiltPosition(reference.output, reference.line, reference.column, options);
        if (!position) return null;
        if (position.mapped) {
            return read(position.path, position.line, `${reference.origin} maps to ${position.path}:${position.line}:${position.column}${position.name ? ` (${position.name})` : ''}`, { stack: `${position.path}:${position.line}` });
        }
        const line = definitionLine(position.path, reference.name, options);
        return read(position.path, line, `${reference.origin} comes from ${position.path}; ${position.note}${line ? `, so this is where ${reference.name} is defined` : ''}`, { stack: false, unmapped: true });
    }
    if (reference.kind === 'file') {
        const file = normaliseSourcePath(reference.path);
        if (!file) return null;
        if (reference.line) return read(file, reference.line, `${file}:${reference.line}${reference.column ? `:${reference.column}` : ''}${reference.name ? ` (${reference.name})` : ''}`, { stack: `${file}:${reference.line}` });
        const line = definitionLine(file, reference.name, options);
        return read(file, line, line ? `${file}, where ${reference.name} is defined` : `${file} was mentioned`);
    }
    if (reference.kind === 'route') {
        const file = `src/endpoints/${reference.group}.js`;
        if (!resolveSourceFile(file, options)) return null;
        const tail = reference.route.slice(`/api/${reference.group}`.length);
        const line = (tail && findInFile(file, `'${tail}'`, options)) || (tail && findInFile(file, tail, options)) || 0;
        return line ? read(file, line, `route ${reference.route}`) : null;
    }
    if (reference.kind === 'code') {
        const hit = searchSource({ query: reference.code, prefix: 'src/', limit: 1 }, options)?.results?.[0];
        return hit ? read(hit.path, hit.line, `error code ${reference.code}`) : null;
    }
    return null;
}

/** Joins reads of the same file that overlap or touch, keeping each under the line cap. */
export function mergeSourceReads(items, options = {}) {
    const output = [];
    for (const item of items) {
        if (item?.type !== 'read') {
            output.push(item);
            continue;
        }
        const near = output.find(other => other.type === 'read' && other.path === item.path
            && item.start <= other.end + 1 && item.end >= other.start - 1
            && Math.max(other.end, item.end) - Math.min(other.start, item.start) < MAX_READ_LINES);
        if (!near) {
            output.push({ ...item });
            continue;
        }
        const merged = readSourceWindow(item.path, { start: Math.min(near.start, item.start), end: Math.max(near.end, item.end) }, options);
        if (!merged) continue;
        Object.assign(near, merged, { reason: [near.reason, item.reason].filter((reason, index, all) => reason && all.indexOf(reason) === index).join('; '), stack: near.stack || item.stack });
    }
    return output;
}

/**
 * Step 0: the lookups that need no model. Reads the code behind each stack position, route and error code.
 * Returns { items, resolvedStacks, unmapped }.
 */
export function gatherSourceForQuestion({ question = '', evidence = '' } = {}, options = {}) {
    const references = findSourceReferences([question, evidence].filter(Boolean).join('\n'));
    const items = [];
    const stacks = new Map();
    let unmapped = 0;
    for (const reference of references) {
        if (items.length >= MAX_DETERMINISTIC_READS) break;
        const item = resolveSourceReference(reference, options);
        if (!item) continue;
        // An error line and its first stack frame often name the same spot; keep the fuller description.
        const same = item.stack ? stacks.get(item.stack) : null;
        if (same) {
            if (item.reason.length > same.reason.length) same.reason = item.reason;
            continue;
        }
        if (item.stack) stacks.set(item.stack, item);
        if (item.unmapped) unmapped++;
        items.push(item);
    }
    return { items: mergeSourceReads(items, options), resolvedStacks: stacks.size, unmapped };
}

function escapeTag(text) {
    return String(text).replace(/<(\/?)(neconyan_source)/gi, '‹$1$2');
}

function bytes(text) {
    return Buffer.byteLength(text, 'utf8');
}

function readSection(item) {
    return [`### ${item.path} lines ${item.start}-${item.end} of ${item.total}`, ...(item.reason ? [`Why: ${item.reason}`] : []), item.text].join('\n');
}

function searchSection(item) {
    const where = item.prefix ? ` in ${item.prefix}` : '';
    const lines = item.results.map(hit => `${hit.path}:${hit.line}: ${hit.text}`);
    return [`### Search for "${item.query}"${where}: ${item.results.length ? `${item.results.length}${item.truncated ? '+' : ''} matching lines` : 'no matches'}`, ...lines].join('\n');
}

function listSection(item) {
    const label = [item.prefix || 'all source', item.query ? `matching "${item.query}"` : ''].filter(Boolean).join(' ');
    return [`### Files in ${label}: ${item.total}${item.total > item.files.length ? `, first ${item.files.length} shown` : ''}`, ...item.files].join('\n');
}

function sectionFor(item) {
    if (item.type === 'read') return readSection(item);
    if (item.type === 'search') return searchSection(item);
    if (item.type === 'list') return listSection(item);
    return '';
}

/**
 * Formats the gathered lookups as one <neconyan_source> block within a byte budget.
 * A read that does not fit is shortened from the end; anything after that is counted, not shown.
 * Returns { text, shown: items that made it in }.
 */
export function formatSourceBlock(items, { budget = SOURCE_BLOCK_BYTES, notes = [], options = {} } = {}) {
    const head = [
        `<${SOURCE_TAG}>`,
        'Read-only source code from this Neconyan install, looked up for this message. Paths are relative to the Neconyan folder, and each code line starts with its line number. Config, secrets and user data were never read.',
        ...notes.filter(Boolean).map(note => `Note: ${note}`),
    ].join('\n');
    const tail = `</${SOURCE_TAG}>`;
    const parts = [];
    const shown = [];
    // Room for the line that counts left-out lookups, so the block never passes the budget.
    let used = bytes(head) + bytes(tail) + 2 + 96;
    let left = 0;
    for (const item of items) {
        const section = escapeTag(scrubSourceText(sectionFor(item), options));
        if (!section) continue;
        const size = bytes(section) + 2;
        if (used + size <= budget) {
            parts.push(section);
            shown.push(item);
            used += size;
            continue;
        }
        if (item.type === 'read' && !left) {
            // Keep the start of the read, which holds the lines nearest the reason it was read.
            const lines = section.split('\n');
            let fitted = lines.length;
            while (fitted > 3 && used + bytes(lines.slice(0, fitted).join('\n')) + 2 > budget) fitted--;
            const header = item.reason ? 2 : 1;
            if (fitted - header >= 5) {
                const kept = fitted - header;
                const end = item.start + kept - 1;
                const trimmed = lines.slice(0, fitted);
                trimmed[0] = `### ${item.path} lines ${item.start}-${end} of ${item.total}`;
                const text = trimmed.join('\n');
                if (used + bytes(text) + 2 <= budget) {
                    parts.push(text);
                    shown.push({ ...item, end });
                    used += bytes(text) + 2;
                    continue;
                }
            }
        }
        left++;
    }
    const overflow = left ? [`[${left} more lookup${left === 1 ? ' was' : 's were'} left out to keep this within the size limit.]`] : [];
    const empty = parts.length ? [] : ['No matching source code was found for this message.'];
    return { text: [head, ...empty, ...parts, ...overflow, tail].join('\n\n'), shown };
}
