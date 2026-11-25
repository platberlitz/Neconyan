/**
 * Reading a 'Share this' request out of a Scratchpad reply. When a reply needs
 * context the user has not shared, the assistant writes a fenced
 * neconyan-share-request JSON block naming Context tab switches. Nothing here
 * touches the page or the network, so it can be tested on its own and shared
 * with the server.
 */

export const SHARE_REQUEST_FENCE = 'neconyan-share-request';
const FENCE_PATTERN = /```neconyan-share-request[^\n]*\n([\s\S]*?)```/g;
export const MAX_SHARE_REQUESTS = 3;
export const MAX_RAW_CHARS = 8_000;
export const MAX_SHARE_DEPTH = 200;
const MAX_REASON_CHARS = 500;
const MAX_ITEMS = 32;

/** Context tab switches the assistant may ask for, in Context tab order. */
export const SHARE_ITEM_KEYS = Object.freeze([
    'card',
    'persona',
    'authorsNote',
    'mewmory',
    'lore',
    'preset',
    'problems',
    'appEvidence',
    'appSource',
    'lastPrompt',
    'agents',
    'companionNotes',
    'regex',
    'cssSnippets',
    'dialogueColors',
    'hidden',
]);

const KNOWN = new Set(SHARE_ITEM_KEYS);

/** English labels, worded as on the Context tab. */
export const SHARE_LABELS = Object.freeze({
    card: 'Character cards',
    persona: 'Your persona and Scenario Notes',
    authorsNote: 'Author\'s Note',
    mewmory: 'Mewmory',
    lore: 'Lorebook entries',
    preset: 'Current preset',
    problems: 'Problem checks',
    appEvidence: 'App diagnostics',
    appSource: 'Neconyan source code',
    lastPrompt: 'Last prompt sent',
    agents: 'Agents',
    companionNotes: 'Companion notes',
    regex: 'Regexes',
    cssSnippets: 'CSS Snippets',
    dialogueColors: 'Dialogue Colors',
    hidden: 'Hidden messages',
    depth: 'Recent messages to read',
});

/** Short English explanations for switches whose label alone is unclear to the assistant. */
export const SHARE_HINTS = Object.freeze({
    companionNotes: 'Completed Companion notes on shared messages (trackers, Plot Compass, Memory Shards)',
});

const CHAT_ITEMS = Object.freeze({
    roleplay: SHARE_ITEM_KEYS,
    conversation: Object.freeze(SHARE_ITEM_KEYS.filter(key => !['authorsNote', 'mewmory', 'companionNotes'].includes(key))),
});
const GENERAL_ITEMS = Object.freeze(['persona', 'preset', 'problems', 'appEvidence', 'appSource', 'agents', 'regex', 'cssSnippets', 'dialogueColors']);

export class ShareRequestError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ShareRequestError';
    }
}

function clean(value, limit) {
    if (typeof value !== 'string') return '';
    // Control characters never belong in a reason line.
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function sourceKind(source) {
    const kind = source?.kind;
    return kind === 'roleplay' || kind === 'conversation' || kind === 'general' ? kind : 'notebook';
}

/** Whether this Scratchpad mode can read more chat messages at all. */
export function canShareDepth(source) {
    const kind = sourceKind(source);
    return kind === 'roleplay' || kind === 'conversation';
}

/** Context tab switches this Scratchpad mode offers. */
export function availableShareItems(source) {
    const kind = sourceKind(source);
    if (kind === 'roleplay' || kind === 'conversation') return [...CHAT_ITEMS[kind]];
    if (kind === 'general') return source?.avatar ? ['card', ...GENERAL_ITEMS] : [...GENERAL_ITEMS];
    return [];
}

export function isShareItemAvailable(key, source) {
    return availableShareItems(source).includes(key);
}

function currentDepth(settings) {
    const depth = Number(settings?.depth);
    return Number.isFinite(depth) ? Math.max(0, Math.min(MAX_SHARE_DEPTH, Math.trunc(depth))) : 0;
}

function hasPicks(settings) {
    return Array.isArray(settings?.picked) && settings.picked.length > 0;
}

/** Available switches that are off now, and whether more messages could be read. */
export function unsharedShareItems(source, settings = {}) {
    const include = settings?.include && typeof settings.include === 'object' ? settings.include : {};
    const items = availableShareItems(source).filter(key => include[key] !== true);
    const depth = currentDepth(settings);
    const canIncreaseDepth = canShareDepth(source) && depth < MAX_SHARE_DEPTH && !hasPicks(settings);
    return { items, canIncreaseDepth, currentDepth: depth };
}

function depthValue(value) {
    const depth = typeof value === 'string' && /^\d{1,4}$/.test(value.trim()) ? Number(value) : value;
    return Number.isInteger(depth) && depth >= 1 && depth <= MAX_SHARE_DEPTH ? depth : null;
}

/** Keeps only known switch names and a bounded message count; everything else is dropped. */
export function normaliseShareRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ShareRequestError('This share request is not a JSON object.');
    const listed = Array.isArray(input.items) ? input.items.slice(0, MAX_ITEMS) : [];
    const items = [];
    let ignored = 0;
    for (const item of listed) {
        const key = typeof item === 'string' ? item.trim() : '';
        if (!KNOWN.has(key)) {
            ignored += 1;
            continue;
        }
        if (!items.includes(key)) items.push(key);
    }
    const depth = depthValue(input.depth);
    if (!items.length && depth === null) throw new ShareRequestError('This share request does not name anything Scratchpad can share.');
    return { items, depth, reason: clean(input.reason, MAX_REASON_CHARS), ignored };
}

export function parseShareRequest(raw) {
    const text = String(raw ?? '').trim();
    if (!text || text.length > MAX_RAW_CHARS) throw new ShareRequestError('This share request could not be read.');
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        throw new ShareRequestError('This share request could not be read.');
    }
    return normaliseShareRequest(value);
}

/** Splits a reply into text and share request parts, in order. */
export function splitShareRequests(text) {
    const source = String(text ?? '');
    const parts = [];
    let last = 0;
    let count = 0;
    for (const match of source.matchAll(FENCE_PATTERN)) {
        if (match.index > last) parts.push({ type: 'text', text: source.slice(last, match.index) });
        last = match.index + match[0].length;
        if (count >= MAX_SHARE_REQUESTS) {
            parts.push({ type: 'text', text: match[0] });
            continue;
        }
        const raw = match[1].trim();
        let request = null;
        let error = '';
        try {
            request = parseShareRequest(raw);
        } catch (caught) {
            error = caught instanceof ShareRequestError ? caught.message : 'This share request could not be read.';
        }
        parts.push({ type: 'share-request', index: count, request, error, raw: raw.slice(0, MAX_RAW_CHARS) });
        count += 1;
    }
    if (last < source.length) parts.push({ type: 'text', text: source.slice(last) });
    return parts;
}

/**
 * Sorts a request against the live mode and settings: what can be switched on
 * now, what is already shared and what this mode cannot share.
 */
export function planShareRequest(request, source, settings = {}) {
    const include = settings?.include && typeof settings.include === 'object' ? settings.include : {};
    const available = new Set(availableShareItems(source));
    const actionable = [];
    const shared = [];
    const unavailable = [];
    for (const key of request?.items ?? []) {
        if (!available.has(key)) unavailable.push(key);
        else if (include[key] === true) shared.push(key);
        else actionable.push(key);
    }
    let depth = null;
    const requested = depthValue(request?.depth);
    if (requested !== null) {
        const current = currentDepth(settings);
        const state = !canShareDepth(source) ? 'unavailable'
            : requested <= current ? 'shared'
                : hasPicks(settings) ? 'picked'
                    : 'actionable';
        depth = { requested, current, state };
    }
    return { actionable, shared, unavailable, depth };
}

/** The settings change for the ticked switches; depth only ever goes up. */
export function shareSettingsPatch(keys, depth = null) {
    const include = {};
    for (const key of keys ?? []) if (KNOWN.has(key)) include[key] = true;
    const patch = {};
    if (Object.keys(include).length) patch.include = include;
    const value = depthValue(depth);
    if (value !== null) patch.depth = value;
    return patch;
}

function joinLabels(labels) {
    if (labels.length <= 1) return labels.join('');
    return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/** English labels for what was shared, in Context tab order. */
export function shareLabels(keys, depth = null) {
    const labels = SHARE_ITEM_KEYS.filter(key => keys?.includes(key)).map(key => SHARE_LABELS[key]);
    const value = depthValue(depth);
    if (value !== null) labels.push(`${SHARE_LABELS.depth} (${value})`);
    return labels;
}

/**
 * The message sent after sharing. It is built only from fixed labels, never
 * from the assistant's own wording.
 */
export function shareFollowUp(keys, depth = null) {
    const labels = shareLabels(keys, depth);
    return labels.length ? `I shared ${joinLabels(labels)}. Please continue.` : '';
}
