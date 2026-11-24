import { findTrackerBlocks, inspectTrackerState } from '../tracker-state.js';
import { EMPTY_OUTPUT_SENTINEL_LINE_PATTERN, EMPTY_OUTPUT_SENTINEL_LINE_PROBE } from './companion-shared.js';

const companion = agent => agent?.execution === 'companion' || agent?.category === 'companion';
const boundary = /^[ \t]*\[\/?[A-Z][A-Z0-9_]*(?::[^|\]\n]+)?[|\]]/;
const bodyLines = [/^\s*$/, /^\s*\d+[.)][ \t]+\S/, /^\s*[A-Za-z][.)][ \t]+\S/, /^\s*[-*+•‣◦][ \t]+\S/,
    /^\s*\|.*\|\s*$/, /^\s*[-=|:+\s]{3,}$/, /^\s*#{1,6}[ \t]+\S/, /^\s*\*\*[^*\n]+\*\*/, /^\s*[A-Z][A-Z0-9 _&'/-]{1,39}$/,
    /^\s*[A-Za-z][\w '/&()-]{0,29}:(?:\s|$)/];

export function extractTrackerTagShapes(text) {
    const source = String(text ?? '').replace(/\r\n?/g, '\n'), shapes = new Map();
    for (const match of source.matchAll(/\[([A-Z][A-Z0-9_]*)(?::[^|\]\n]+)?\|/g)) shapes.set(match[1], 'piped');
    for (const match of source.matchAll(/^[ \t>*_]*\[\/?([A-Z][A-Z0-9_]+)(?::[^|\]\n]+)?\][ \t*_]*$/gm)) {
        if (!shapes.has(match[1])) shapes.set(match[1], 'bare');
    }
    return shapes;
}

export function getOwnedCompanionTrackerShape(agent, text) {
    if (!companion(agent)) return null;
    const tag = String(inspectTrackerState(agent).tag ?? '').trim().toUpperCase();
    const shape = tag && extractTrackerTagShapes(text).get(tag);
    return shape ? { tag, shape } : null;
}

export function getActiveInlineTrackerTags(agents) {
    const tags = new Set();
    for (const agent of agents) {
        if (agent.category !== 'tracker' || companion(agent)) continue;
        const tag = inspectTrackerState(agent).tag;
        if (tag) tags.add(tag.toUpperCase());
        else for (const value of extractTrackerTagShapes(agent.prompt).keys()) tags.add(value);
    }
    return tags;
}

// Line formats such as `clothing-start` / `outfit|Name|...` / `clothing-end` carry no
// brackets, so they get their own keys: a lower-case keyword before the first pipe, or a
// whole `name-start` / `name-end` marker line. Prompts and saved output both declare them.
const LINE_KEY = '[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*';
const LINE_PREFIX = String.raw`^[ \t]*(?:[>*+-][ \t]+)?`;
const LINE_RECORD = new RegExp(`${LINE_PREFIX}(${LINE_KEY})\\|[ \\t]*[^|\\s]`, 'gm');
const LINE_MARKER = new RegExp(`${LINE_PREFIX}(${LINE_KEY}[-_](?:start|end|begin|stop))[ \\t]*$`, 'gim');
const LINE_ECHO = new RegExp(`${LINE_PREFIX}(${LINE_KEY})(?:\\|.*|[ \\t]*)$`);
const LINE_DECLARATION = new RegExp(`${LINE_PREFIX}(?:${LINE_KEY}\\|[ \\t]*[^|\\s]|${LINE_KEY}[-_](?:start|end|begin|stop)[ \\t]*$)`, 'i');
const normalizeLineKey = key => String(key ?? '').trim().toLowerCase().replaceAll('_', '-');
const isLineMarkerKey = key => /-(?:start|end|begin|stop)$/.test(key);

export function extractTrackerLineKeys(text) {
    const source = String(text ?? '').replace(/\r\n?/g, '\n'), keys = new Set();
    for (const match of source.matchAll(LINE_RECORD)) keys.add(normalizeLineKey(match[1]));
    for (const match of source.matchAll(LINE_MARKER)) keys.add(normalizeLineKey(match[1]));
    return keys;
}

/** Saved output only declares a line format once it holds at least two tracker lines. */
export function getOwnedCompanionTrackerLineKeys(agent, text = '') {
    if (!companion(agent)) return new Set();
    const keys = extractTrackerLineKeys(agent.prompt);
    const output = String(text ?? '').replace(/\r\n?/g, '\n');
    if (output.split('\n').filter(line => LINE_DECLARATION.test(line)).length >= 2) {
        for (const key of extractTrackerLineKeys(output)) keys.add(key);
    }
    return keys;
}

/** Keys an inline (non-companion) Agent asks the main reply to write stay in the reply. */
export function getActiveInlineTrackerLineKeys(agents = []) {
    const keys = new Set();
    for (const agent of agents) {
        if (!agent || companion(agent)) continue;
        for (const key of extractTrackerLineKeys(agent.prompt)) keys.add(key);
    }
    return keys;
}

/** The owned line formats that a fed or retained body actually shows the main model. */
export function getVisibleCompanionTrackerLineKeys(agent, text, inlineKeys = new Set()) {
    const owned = getOwnedCompanionTrackerLineKeys(agent, text), visible = new Set();
    for (const key of extractTrackerLineKeys(text)) if (owned.has(key) && !inlineKeys.has(key)) visible.add(key);
    return visible;
}

/** Every active companion owns the line formats its prompt declares, fed back or not. */
export function getActiveCompanionTrackerLineKeys(agents = [], extraKeys = []) {
    const inline = getActiveInlineTrackerLineKeys(agents), keys = new Set();
    for (const agent of agents) for (const key of getOwnedCompanionTrackerLineKeys(agent)) keys.add(key);
    for (const key of extraKeys) keys.add(normalizeLineKey(key));
    for (const key of inline) keys.delete(key);
    keys.delete('');
    return keys;
}

export function stripTrackerLineEchoes(text, keys = []) {
    const source = String(text ?? '').replace(/\r\n?/g, '\n');
    const owned = new Set([...keys].map(normalizeLineKey).filter(Boolean));
    if (!owned.size) return source;
    let removed = false;
    const kept = source.split('\n').filter(line => {
        const match = LINE_ECHO.exec(line), key = match && normalizeLineKey(match[1]);
        if (!key || !owned.has(key)) return true;
        const marker = !line.includes('|');
        if (marker && !isLineMarkerKey(key)) return true;
        removed = true;
        return false;
    });
    if (!removed) return source;
    return kept.join('\n').replace(/^[ \t]*```[^\n`]*\n(?:[ \t]*\n)*[ \t]*```[ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function formatLineKeyExamples(lineKeys) {
    return [...lineKeys].map(normalizeLineKey).filter(Boolean).map(key => isLineMarkerKey(key) ? key : `${key}|...`);
}

export function buildTrackerEchoGuard(shapes, lineKeys = []) {
    const bracket = [...shapes].flatMap(([tag, shape]) => [shape === 'bare' ? `[${tag}]` : `[${tag}|...]`, `[/${tag}]`]);
    const lines = formatLineKeyExamples(lineKeys);
    const kind = bracket.length && lines.length ? 'bracket and line formats' : lines.length ? 'line formats' : 'bracket formats';
    return `HARD STOP for your reply: the Companion-owned ${kind} listed here are read-only reference. `
        + 'A separate side-channel agent writes and re-attaches those formats automatically after your reply, so copying them creates duplicates the user has to delete by hand. '
        + 'Do NOT reproduce, paraphrase, update, restate, or wrap reply content in the listed formats. '
        + 'Do not emit any of: ' + [...bracket, ...lines].join(', ') + '. '
        + (bracket.length ? 'Opening one of these tags without its closing tag is still a violation. ' : '')
        + (lines.length ? 'Starting a line with one of these keywords is still a violation. ' : '')
        + `This restriction applies only to the exact ${bracket.length ? 'tags' : 'formats'} listed here; continue following any separate instructions that require other pre-generation inline tracker formats. `
        + 'Never repeat an "[... - auxiliary notes]" label. '
        + 'Produce your normal story reply, including any other required inline tracker blocks.';
}

function boundUnclosed(source, start) {
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    if (source.slice(lineStart, start).trim()) return -1;
    const lineBreak = source.indexOf('\n', start), openerEnd = lineBreak < 0 ? source.length : lineBreak;
    const opener = source.slice(start, openerEnd), truncated = lineBreak < 0 && !opener.includes(']');
    if (!/^\[[^\]\n]*\]\s*$/.test(opener) && !truncated) return -1;
    if (truncated || opener.startsWith('[/')) return openerEnd;
    let end = openerEnd, cursor = lineBreak < 0 ? source.length : lineBreak + 1;
    while (cursor < source.length) {
        const next = source.indexOf('\n', cursor), lineEnd = next < 0 ? source.length : next, line = source.slice(cursor, lineEnd);
        if (boundary.test(line)) break;
        if (/^\s*[^:\n]{1,40}:\s*["'‘“]/.test(line) || !bodyLines.some(pattern => pattern.test(line))) return -1;
        if (line.trim()) end = lineEnd;
        cursor = next < 0 ? source.length : next + 1;
    }
    return end;
}

export function stripSavedAuxiliaryTrackerEchoes(text, tags = [], agents = [], lineKeys = []) {
    const lines = stripTrackerLineEchoes(text, getActiveCompanionTrackerLineKeys(agents, lineKeys));
    const source = lines.replace(/\r\n?/g, '\n'), inline = getActiveInlineTrackerTags(agents), ranges = [];
    for (const value of tags) {
        const tag = String(value ?? '').trim().toUpperCase();
        if (!tag || inline.has(tag)) continue;
        for (const block of findTrackerBlocks(source, tag)) {
            const end = block.complete ? block.end : boundUnclosed(source, block.start);
            if (end > block.start) ranges.push({ start: block.start, end });
        }
    }
    const label = /^\s*\[[^\]\n]+ - auxiliary notes\]\s*$/gim;
    if (!ranges.length && !label.test(source) && !EMPTY_OUTPUT_SENTINEL_LINE_PROBE.test(source)) return source;
    const merged = [];
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
        else merged.push({ ...range });
    }
    let cleaned = source;
    for (const range of merged.reverse()) cleaned = cleaned.slice(0, range.start) + cleaned.slice(range.end);
    label.lastIndex = 0;
    EMPTY_OUTPUT_SENTINEL_LINE_PATTERN.lastIndex = 0;
    return cleaned.replace(label, '').replace(EMPTY_OUTPUT_SENTINEL_LINE_PATTERN, '').replace(/\n{3,}/g, '\n\n').trim();
}
