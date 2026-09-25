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

export function buildTrackerEchoGuard(shapes) {
    const examples = [...shapes].flatMap(([tag, shape]) => [shape === 'bare' ? `[${tag}]` : `[${tag}|...]`, `[/${tag}]`]).join(', ');
    return 'HARD STOP for your reply: the Companion-owned bracket formats listed here are read-only reference. '
        + 'A separate side-channel agent writes and re-attaches those formats automatically after your reply, so copying them creates duplicates the user has to delete by hand. '
        + 'Do NOT reproduce, paraphrase, update, restate, or wrap reply content in the listed formats. '
        + 'Do not emit any of: ' + examples + '. '
        + 'Opening one of these tags without its closing tag is still a violation. '
        + 'This restriction applies only to the exact tags listed here; continue following any separate instructions that require other pre-generation inline tracker formats. '
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

export function stripSavedAuxiliaryTrackerEchoes(text, tags = [], agents = []) {
    const source = String(text ?? '').replace(/\r\n?/g, '\n'), inline = getActiveInlineTrackerTags(agents), ranges = [];
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
