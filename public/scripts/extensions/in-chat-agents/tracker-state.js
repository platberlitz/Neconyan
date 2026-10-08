import { escapeRegex } from '../../util/escape-regex.js';

function normalizeText(value = '') {
    return String(value ?? '').replaceAll(/\r\n?/g, '\n');
}

export const TRACKER_REPAIR_INSTRUCTION = 'Repair mode: produce the requested result again in the requested format. Keep scene prose, character dialogue, and narrative continuation outside the result. For choice/menu agents, return the bracketed choice or direction block.';

function getTrackerTagFromPattern(pattern = '') {
    return String(pattern).match(/\\+\[([A-Za-z][A-Za-z0-9_-]*)/)?.[1] ?? '';
}

function getTrackerTagFromText(text = '') {
    return String(text).match(/\[([A-Za-z][A-Za-z0-9_-]*)(?=[:|\]])/)?.[1] ?? '';
}

function getTrackerTag(agent = {}, text = '') {
    const pattern = String(agent?.postProcess?.extractPattern ?? '').trim();
    if (pattern) return getTrackerTagFromPattern(pattern);
    return getTrackerTagFromText(agent?.prompt) || getTrackerTagFromText(text);
}

/**
 * Finds complete and malformed blocks for one tracker tag. Variant openers such
 * as [NPC:MAJOR|...] share the base tag's [/NPC] closer.
 * @param {string} text
 * @param {string} tag
 * @returns {Array<{ complete: boolean, replaceable: boolean, start: number, end: number, text: string }>}
 */
export function findTrackerBlocks(text, tag) {
    const source = normalizeText(text);
    if (!tag) return [];

    const escapedTag = escapeRegex(String(tag));
    const opener = new RegExp(`\\[${escapedTag}(?=[:|\\]])`, 'ig');
    const closer = new RegExp(`\\[\\/${escapedTag}\\]`, 'ig');
    const openers = [...source.matchAll(opener)];
    const blocks = [];
    const matchedClosers = new Set();

    for (let index = 0; index < openers.length; index++) {
        const openMatch = openers[index];
        const nextOpenStart = openers[index + 1]?.index ?? source.length;
        const lineEnd = source.indexOf('\n', openMatch.index);
        const openingBracketEnd = source.indexOf(']', openMatch.index + openMatch[0].length);
        const hasCompleteOpener = openingBracketEnd >= 0 && (lineEnd < 0 || openingBracketEnd < lineEnd);
        closer.lastIndex = openMatch.index + openMatch[0].length;
        const closeMatch = closer.exec(source);

        if (closeMatch && closeMatch.index < nextOpenStart) {
            const end = closeMatch.index + closeMatch[0].length;
            matchedClosers.add(closeMatch.index);
            blocks.push({
                complete: hasCompleteOpener && openingBracketEnd < closeMatch.index,
                replaceable: true,
                start: openMatch.index,
                end,
                text: source.slice(openMatch.index, end),
            });
            continue;
        }

        const isTrailingBlock = nextOpenStart === source.length;
        const malformedEnd = isTrailingBlock
            ? source.length
            : hasCompleteOpener
                ? openingBracketEnd + 1
                : Math.min(lineEnd < 0 ? source.length : lineEnd, nextOpenStart);
        blocks.push({
            complete: false,
            replaceable: false,
            start: openMatch.index,
            end: malformedEnd,
            text: source.slice(openMatch.index, malformedEnd),
        });
    }

    const unmatchedClosers = [...source.matchAll(new RegExp(`\\[\\/${escapedTag}\\]`, 'ig'))]
        .filter(match => !matchedClosers.has(match.index))
        .map(match => ({
            complete: false,
            replaceable: false,
            start: match.index,
            end: match.index + match[0].length,
            text: match[0],
        }));

    return [...blocks, ...unmatchedClosers].sort((left, right) => left.start - right.start);
}

function compileExtractPattern(pattern) {
    if (!pattern) return { regex: null, error: '' };

    try {
        return { regex: new RegExp(pattern, 'g'), error: '' };
    } catch (error) {
        return {
            regex: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Reorders labelled, single-line fields to match the agent's own format example.
 * Values, headers and surrounding prose are retained. Ambiguous records are left alone.
 */
export function repairTrackerFieldOrder(agent, text) {
    const source = normalizeText(text);
    const tag = getTrackerTag(agent, source);
    const examples = findTrackerBlocks(agent.prompt, tag).filter(block => block.complete);
    const parse = block => {
        const lines = block.text.split('\n');
        const fields = lines.slice(1, -1).map(line => ({ line, key: line.match(/^([a-z][a-z0-9_-]*):[ \t]*/i)?.[1] }));
        if (!fields.length || fields.some(field => !field.key) || new Set(fields.map(field => field.key)).size !== fields.length) return null;
        return { lines, fields, variant: lines[0].split('|')[0] };
    };
    let result = source;
    for (const block of findTrackerBlocks(source, tag).reverse()) {
        if (!block.complete) continue;
        const record = parse(block);
        if (!record) continue;
        const candidates = examples.map(parse).filter(example => example?.variant === record.variant
            && example.fields.length === record.fields.length
            && example.fields.every(field => record.fields.some(current => current.key === field.key)));
        if (candidates.length !== 1) continue;
        const values = new Map(record.fields.map(field => [field.key, field.line]));
        const reordered = [record.lines[0], ...candidates[0].fields.map(field => values.get(field.key)), record.lines.at(-1)].join('\n');
        result = result.slice(0, block.start) + reordered + result.slice(block.end);
    }
    return result;
}

const TRACKER_BULLET_LINE = /^[ \t]*[-*•](?:[ \t]|$)/;
const TRACKER_LABELLED_BULLET_LINE = /^[ \t]*[-*•][ \t]*[^:\s][^:\n]*:[ \t]*\S/;

function getTrackerBlockVariant(block) {
    return block.text.split('\n')[0].split('|')[0].trim().toUpperCase();
}

function getTrackerBlockBulletLines(block) {
    return block.text.split('\n').slice(1, -1).filter(line => TRACKER_BULLET_LINE.test(line));
}

/**
 * True when the agent's own format example labels every bullet ("- Name: what they do")
 * but a complete block in the text has bullets without a label. Such blocks close
 * correctly yet cannot be displayed, so repair must rewrite them.
 * @param {object} agent
 * @param {string} text
 */
export function hasUnlabelledTrackerBullets(agent = {}, text = '') {
    const source = normalizeText(text);
    const tag = getTrackerTag(agent, source);
    const labelledVariants = new Set(findTrackerBlocks(agent?.prompt, tag)
        .filter(block => block.complete)
        .filter(block => {
            const body = block.text.split('\n').slice(1, -1).filter(line => line.trim());
            return body.length > 0 && body.every(line => TRACKER_LABELLED_BULLET_LINE.test(line));
        })
        .map(getTrackerBlockVariant));
    if (labelledVariants.size === 0) return false;

    return findTrackerBlocks(source, tag).some(block => block.complete
        && labelledVariants.has(getTrackerBlockVariant(block))
        && getTrackerBlockBulletLines(block).some(line => !TRACKER_LABELLED_BULLET_LINE.test(line)));
}

export function getTrackerMetadataKey(agent = {}) {
    const variable = String(agent?.postProcess?.extractVariable ?? '').trim();
    return variable ? `agent_${variable}` : '';
}

/**
 * Writes an extracted tracker value where both readers can find it: the legacy
 * top-level metadata key, and the host's local variable store so {{getvar::agent_x}}
 * and /getvar resolve it. Passing an empty value removes both copies.
 * @param {object} metadata chat metadata object
 * @param {string} key metadata key from getTrackerMetadataKey
 * @param {string} value extracted text, or '' to clear
 * @returns {boolean} true when anything changed
 */
export function writeTrackerMetadataValue(metadata, key, value = '') {
    if (!metadata || typeof metadata !== 'object' || !key) return false;
    if (!metadata.variables || typeof metadata.variables !== 'object') {
        metadata.variables = {};
    }
    if (value) {
        if (metadata[key] === value && metadata.variables[key] === value) return false;
        metadata[key] = value;
        metadata.variables[key] = value;
        return true;
    }
    const existed = Object.hasOwn(metadata, key) || Object.hasOwn(metadata.variables, key);
    delete metadata[key];
    delete metadata.variables[key];
    return existed;
}

/**
 * Inspects tracker text using structural block boundaries first. The configured
 * extractor remains useful metadata, but a stale or invalid regex cannot make a
 * complete [TAG]...[/TAG] block look broken.
 * @param {object} agent
 * @param {string} text
 */
export function inspectTrackerState(agent = {}, text = '') {
    const pattern = String(agent?.postProcess?.extractPattern ?? '').trim();
    const source = normalizeText(text);
    const patternTag = getTrackerTagFromPattern(pattern);
    const tag = getTrackerTag(agent, source);
    const { regex, error } = compileExtractPattern(pattern);
    const matches = regex ? [...source.matchAll(regex)].map(match => String(match[0] ?? '')).filter(Boolean) : [];
    const blocks = findTrackerBlocks(source, tag);
    const completeBlocks = blocks.filter(block => block.complete);
    const malformedBlocks = blocks.filter(block => !block.complete);
    const structuralPayloads = completeBlocks.map(block => block.text.trim()).filter(Boolean);
    const regexPayloads = matches.map(match => match.trim()).filter(Boolean);

    if (structuralPayloads.length > 0 && malformedBlocks.length === 0) {
        return {
            status: 'valid',
            matches,
            payloads: structuralPayloads,
            value: structuralPayloads.join('\n\n'),
            tag,
            error,
            blocks,
        };
    }

    // Custom trackers may use a non-bracket grammar. Keep their configured
    // extractor authoritative when it does not describe a structural tag.
    if (!patternTag && blocks.length === 0 && regexPayloads.length > 0) {
        return {
            status: 'valid',
            matches,
            payloads: regexPayloads,
            value: regexPayloads.join('\n'),
            tag: '',
            error,
            blocks,
        };
    }

    const status = blocks.length > 0
        ? 'malformed'
        : error
            ? 'invalid-pattern'
            : 'missing';

    return {
        status,
        matches,
        payloads: [],
        value: '',
        tag,
        error,
        blocks,
    };
}

export function getTrackerRepairPayload(agent = {}, text = '') {
    const inspection = inspectTrackerState(agent, text);
    return {
        ...inspection,
        payload: inspection.status === 'valid' ? inspection.value : '',
    };
}

/**
 * Companion cards are sidecar tracker output rather than story prose. Repair a
 * single card-local missing or mistyped closer before asking the model again.
 * Inline message repair intentionally continues to reject malformed spans.
 * @param {object} agent
 * @param {string} text
 */
export function normalizeCompanionTrackerRepairPayload(agent = {}, text = '') {
    const source = normalizeText(text);
    const inspection = getTrackerRepairPayload(agent, source);
    if (inspection.payload) {
        return rejectUnlabelledTrackerBullets(agent, inspection);
    }

    const malformedBlocks = inspection.blocks.filter(block => !block.complete);
    const firstContentIndex = source.search(/\S/u);
    if (!inspection.tag || malformedBlocks.length !== 1 || inspection.blocks.length !== 1 || malformedBlocks[0].start !== firstContentIndex) {
        return inspection;
    }

    const escapedTag = escapeRegex(String(inspection.tag));
    const malformedCloser = new RegExp(`(?:\\r?\\n)?\\s*\\/?${escapedTag}\\]\\s*$`, 'i');
    let normalized = source.trim();
    if (malformedCloser.test(normalized)) {
        normalized = normalized.replace(malformedCloser, `\n[/${inspection.tag}]`);
    }
    if (!new RegExp(`\\[\\/${escapedTag}\\]\\s*$`, 'i').test(normalized)) {
        normalized = `${normalized}\n[/${inspection.tag}]`;
    }

    return rejectUnlabelledTrackerBullets(agent, getTrackerRepairPayload(agent, normalized));
}

function rejectUnlabelledTrackerBullets(agent, inspection) {
    if (!inspection.payload || !hasUnlabelledTrackerBullets(agent, inspection.payload)) return inspection;
    return { ...inspection, status: 'unlabelled', payload: '' };
}

const TRACKER_EMPTY_SENTINEL_LINE = /^[^\S\n]*(?:tracker-none|TRACKER_NONE|phone-none|PHONE_NONE)[^\S\n]*$/gm;
const TRACKER_FENCE_LINE = /^[^\S\n]*(?:```|~~~)[^\n]*$/gm;
const STRAY_SPEECH = /["“”«»][^"“”«»\n]{3,}["“”«»]/u;
const STRAY_ACTION = /(?:^|\s)\*[^*\n]{3,}\*/u;

/** The tag a companion tracker must produce, taken only from its configuration, never from its output. */
function getConfiguredTrackerTag(agent = {}) {
    const pattern = String(agent?.postProcess?.extractPattern ?? '').trim();
    if (pattern) return getTrackerTagFromPattern(pattern);
    const tag = getTrackerTagFromText(agent?.prompt);
    return tag && findTrackerBlocks(agent?.prompt, tag).some(block => block.complete) ? tag : '';
}

const BLOCK_CLOSER = /\[\/([A-Za-z][A-Za-z0-9_-]*)\]/g;

/** Upper-cased tags of every [/TAG] closer named in the tracker's prompt or extract pattern. */
function getConfiguredBlockTags(agent = {}) {
    const config = `${agent?.prompt ?? ''}\n${String(agent?.postProcess?.extractPattern ?? '').replace(/\\(?=[[\]/])/g, '')}`;
    return new Set([...config.matchAll(BLOCK_CLOSER)].map(match => match[1].toUpperCase()));
}

/** Story prose or dialogue left beside a tracker block, as opposed to a one-line preamble. */
function isStoryLikeStrayText(text = '') {
    const stray = normalizeText(text).replaceAll(TRACKER_EMPTY_SENTINEL_LINE, '').replaceAll(TRACKER_FENCE_LINE, '').trim();
    if (!stray) return false;
    const words = stray.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
    const letters = stray.match(/\p{L}/gu)?.length ?? 0;
    if (words >= 30 || letters >= 160) return true;
    return words >= 8 && (STRAY_SPEECH.test(stray) || STRAY_ACTION.test(stray));
}

function getTextOutsideBlocks(source, blocks) {
    let outside = '';
    let cursor = 0;
    for (const block of blocks) {
        outside += `${source.slice(cursor, block.start)}\n`;
        cursor = block.end;
    }
    return outside + source.slice(cursor);
}

/**
 * Decides what an automatic companion tracker run should do with a model reply.
 * - keep: store `content` (the reply, or its locally fixed tracker block).
 * - regenerate: the reply is story prose, with or without a tracker beside it; `content`
 *   holds the intact tracker block when there is one, as a fallback.
 * - repair: the tracker block is broken and needs a repair pass.
 * Only trackers whose configuration names a [TAG]...[/TAG] block are checked.
 * @param {object} agent
 * @param {string} text
 * @returns {{ action: 'keep'|'regenerate'|'repair', content: string, reason: string }}
 */
export function inspectCompanionTrackerOutput(agent = {}, text = '') {
    const source = normalizeText(text);
    const keep = (reason, content = source) => ({ action: 'keep', content, reason });
    if (agent?.category !== 'tracker' || !source.trim()) return keep('not-checked');
    const tag = getConfiguredTrackerTag(agent);
    if (!tag) return keep('not-checked');

    const blocks = findTrackerBlocks(source, tag);
    const completeBlocks = blocks.filter(block => block.complete);
    const outside = getTextOutsideBlocks(source, completeBlocks);
    // Another block the tracker's own configuration asks for makes it a custom multi-block format;
    // leave it alone. Blocks it never asks for were copied from the story reply and count as stray text.
    const ownTags = getConfiguredBlockTags(agent);
    if ([...outside.matchAll(BLOCK_CLOSER)].some(match => match[1].toUpperCase() !== tag.toUpperCase() && ownTags.has(match[1].toUpperCase()))) {
        return keep('unknown-structure');
    }

    if (blocks.length === 0) {
        const hasSentinel = new RegExp(TRACKER_EMPTY_SENTINEL_LINE.source, 'm').test(source);
        if (hasSentinel && !isStoryLikeStrayText(source)) return keep('empty', 'tracker-none');
        return { action: 'regenerate', content: '', reason: 'no-tracker' };
    }

    if (blocks.length === completeBlocks.length) {
        const payload = completeBlocks.map(block => block.text.trim()).join('\n\n');
        if (hasUnlabelledTrackerBullets(agent, payload)) {
            return { action: 'repair', content: '', reason: 'unlabelled' };
        }
        if (isStoryLikeStrayText(outside)) {
            return { action: 'regenerate', content: payload, reason: 'story-text' };
        }
        return keep('valid');
    }

    // A lone block with only a mistyped closer ("/TAG]" or "TAG]") is fixed here; a block that
    // never closes could have swallowed story prose, so it goes to the model for repair.
    const trimmed = source.trim();
    const mistypedCloser = new RegExp(`(?:^|\\n)\\s*\\/?${escapeRegex(tag)}\\]\\s*$`, 'i');
    if (blocks.length === 1 && blocks[0].start === source.search(/\S/u) && mistypedCloser.test(trimmed)) {
        const payload = normalizeCompanionTrackerRepairPayload(agent, trimmed).payload;
        if (payload) return keep('closer-fixed', payload);
    }
    return { action: 'repair', content: '', reason: 'malformed' };
}

/**
 * The tracker payload from an automatic repair reply, or '' when it is still unusable. Stricter
 * than the manual repair: a block that never closes is rejected because it may hold story prose.
 * @param {object} agent
 * @param {string} text
 */
export function getCompanionTrackerAutoRepairPayload(agent = {}, text = '') {
    const check = inspectCompanionTrackerOutput(agent, text);
    if (check.action === 'keep') return normalizeCompanionTrackerRepairPayload(agent, check.content).payload;
    return check.reason === 'story-text' ? check.content : '';
}

/**
 * Atomically replaces complete blocks or malformed headers with explicit closing
 * tags, or inserts a missing tracker payload. Unbounded spans preserve the prose.
 * @param {object} agent
 * @param {string} messageText
 * @param {string} payload
 * @param {{ prepend?: boolean }} options
 */
export function mergeTrackerRepairPayload(agent = {}, messageText = '', payload = '', { prepend = false } = {}) {
    const source = normalizeText(messageText);
    const addition = getTrackerRepairPayload(agent, payload).payload;
    if (!addition) {
        return { text: source, changed: false, replaced: false, reason: 'invalid-payload' };
    }

    const inspection = inspectTrackerState(agent, source);
    const replaceableBlocks = inspection.blocks.filter(block => block.replaceable);
    if (replaceableBlocks.length > 0 && replaceableBlocks.length === inspection.blocks.length) {
        let nextText = source;
        for (let index = replaceableBlocks.length - 1; index >= 0; index--) {
            const block = replaceableBlocks[index];
            nextText = `${nextText.slice(0, block.start)}${index === 0 ? addition : ''}${nextText.slice(block.end)}`;
        }
        return {
            text: nextText,
            changed: nextText !== source,
            replaced: true,
            reason: '',
        };
    }

    const malformedBlocks = inspection.blocks.filter(block => !block.complete);
    if (malformedBlocks.length > 0) {
        return { text: source, changed: false, replaced: false, reason: 'unsafe-malformed' };
    }

    if (!source.trim()) {
        return { text: addition, changed: true, replaced: false, reason: '' };
    }

    const nextText = prepend
        ? `${addition}\n\n${source}`
        : `${source}${source.endsWith('\n') ? '\n' : '\n\n'}${addition}`;
    return {
        text: nextText,
        changed: nextText !== source,
        replaced: false,
        reason: '',
    };
}
