/**
 * Pure helpers for Story Mode. Nothing in here touches the host or the DOM,
 * so every function is exercised by test/core.test.js.
 */

export const SETTINGS_KEY = 'SillyBunny-Story-Mode';
/** chat_metadata key: { enabled } */
export const CHAT_KEY = 'story_mode';
/** message.extra key: { cuts: number[], revision: string } */
export const EXTRA_KEY = 'story_mode';
/** character.data.extensions key: { default, instruction } */
export const CARD_KEY = 'story_mode';
export const PROMPT_RULES_KEY = 'sbstory_rules';
export const PROMPT_DIRECTION_KEY = 'sbstory_direction';
export const BODY_CLASS = 'sbstory';

export const DEFAULT_RULES = '[Story Mode: you and {{user}} are co-writing one continuous manuscript. '
    + 'Every message so far, including {{user}}\'s, is consecutive text of the same story, not dialogue between you. '
    + 'Continue from exactly where the last text stops - mid-sentence if it stops mid-sentence - without repeating or rephrasing earlier text, '
    + 'and with no speaker labels, headings, or commentary. Keep the same tense, person, and style. '
    + 'Write {{length}} and stop there, even mid-scene: do not wrap up, resolve, or hand the turn back.]';

/** The 0.1.0 defaults, so an untouched install picks up the new ones instead of keeping a copy. */
const LEGACY_RULES = '[Story Mode: you and {{user}} are co-writing one continuous manuscript. '
    + 'Every message so far, including {{user}}\'s, is consecutive text of the same story, not dialogue between you. '
    + 'Continue from exactly where the last text stops - mid-sentence if it stops mid-sentence - without repeating or rephrasing earlier text, '
    + 'and with no speaker labels, headings, or commentary. Keep the same tense, person, and style. '
    + 'Write {{length}}, then stop at a natural beat.]';
const LEGACY_LENGTH_HINT = 'two to four paragraphs';

export const DEFAULT_SETTINGS = Object.freeze({
    defaultOn: false,
    /** Optional shade on the model's text. Off: the text sits on the theme's own chat background. */
    shading: false,
    serif: false,
    rules: DEFAULT_RULES,
    lengthHint: 'about a paragraph',
    /** Hard cap on a continuation's reply, like NovelAI's output length; 0 = the preset's response length. */
    maxTokens: 160,
    transformsUseFullContext: false,
    /** When on, only the In-Chat Agents listed in allowedAgents run while Story Mode is on. */
    agentGate: false,
    allowedAgents: Object.freeze([]),
});

function nonEmptyText(value, fallback) {
    return typeof value === 'string' && value.trim() ? value : fallback;
}

function tokenCap(value, fallback) {
    if (value === '' || value === null || value === undefined) {
        return fallback;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

export function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        defaultOn: source.defaultOn === true,
        shading: source.shading === true,
        serif: source.serif === true,
        rules: nonEmptyText(source.rules === LEGACY_RULES ? '' : source.rules, DEFAULT_SETTINGS.rules),
        lengthHint: nonEmptyText(source.lengthHint === LEGACY_LENGTH_HINT ? '' : source.lengthHint, DEFAULT_SETTINGS.lengthHint),
        maxTokens: tokenCap(source.maxTokens, DEFAULT_SETTINGS.maxTokens),
        transformsUseFullContext: source.transformsUseFullContext === true,
        agentGate: source.agentGate === true,
        allowedAgents: Array.isArray(source.allowedAgents) ? [...new Set(source.allowedAgents.filter((id) => typeof id === 'string' && id))] : [],
    };
}

/** Chat flag beats the card default, which beats the global default. */
export function resolveEnabled({ chatFlag, cardDefault, globalDefault } = {}) {
    if (typeof chatFlag === 'boolean') {
        return chatFlag;
    }
    if (typeof cardDefault === 'boolean') {
        return cardDefault;
    }
    return globalDefault === true;
}

const TERMINAL = /[.!?…]$/u;
const TRAILING_DECOR = /[\s*_~`"'”’»)\]}]+$/u;

/** True when the text stops without finishing its sentence, so the next block reads as the same paragraph. */
export function endsMidSentence(text) {
    const raw = String(text ?? '');
    if (!raw.trim()) {
        return false;
    }
    if (/\n\s*$/u.test(raw)) {
        return false;
    }
    const stripped = raw.replace(TRAILING_DECOR, '');
    if (!stripped) {
        return false;
    }
    return !TERMINAL.test(stripped);
}

/** Compact full-text revision used to ensure a saved cut still belongs to the current text. */
export function textRevision(text) {
    const value = String(text ?? '');
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < value.length; i++) {
        const char = value.charCodeAt(i);
        h1 = Math.imul(h1 ^ char, 2654435761);
        h2 = Math.imul(h2 ^ char, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${value.length}:${4294967296 * (2097151 & h2) + (h1 >>> 0)}`;
}

export function getCuts(message) {
    const state = message?.extra?.[EXTRA_KEY];
    const cuts = state?.cuts;
    const text = String(message?.mes ?? '');
    if (!Array.isArray(cuts) || state.revision !== textRevision(text)) {
        return [];
    }
    let previous = -1;
    for (const cut of cuts) {
        if (!Number.isInteger(cut) || cut < 0 || cut > text.length || cut <= previous) {
            return [];
        }
        previous = cut;
    }
    return [...cuts];
}

/** Who wrote a block: the model, the user, or the user with the model's continuation appended. */
export function classifyBlock(message) {
    const cuts = getCuts(message);
    if (!message?.is_user) {
        return { origin: 'model', cut: null, cuts };
    }
    if (cuts.length > 0) {
        return { origin: 'mixed', cut: cuts[0], cuts };
    }
    return { origin: 'user', cut: null, cuts };
}

/** Undo/Retry apply to a block with a recorded continuation, or a plain model block; a stale-cut block is left alone. */
export function canRevertBlock(message) {
    if (!message) {
        return false;
    }
    if (getCuts(message).length > 0) {
        return true;
    }
    const state = message.extra?.[EXTRA_KEY];
    const stamped = state && (Object.hasOwn(state, 'cuts') || Object.hasOwn(state, 'revision'));
    return !stamped && !message.is_user && !message.is_system;
}

/** Indices of blocks whose previous visible block stopped mid-sentence. */
export function computeJoins(chat) {
    const joins = new Set();
    if (!Array.isArray(chat)) {
        return joins;
    }
    let previous = null;
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message || message.is_system) {
            continue;
        }
        if (previous && endsMidSentence(previous.mes)) {
            joins.add(i);
        }
        previous = message;
    }
    return joins;
}

/** The chat as one piece of prose: hidden blocks skipped, no speaker names, a mid-sentence block runs straight into the next. */
export function buildManuscript(chat) {
    if (!Array.isArray(chat)) {
        return '';
    }
    let out = '';
    let previous = null;
    for (const message of chat) {
        if (!message || message.is_system) {
            continue;
        }
        const text = String(message.mes ?? '').trim();
        if (!text) {
            continue;
        }
        if (previous !== null) {
            out += endsMidSentence(previous) ? ' ' : '\n\n';
        }
        out += text;
        previous = message.mes;
    }
    return out;
}

/** Whitespace-separated tokens that carry at least one letter or digit, so `* * *` and `--` count for nothing. */
export function countWords(text) {
    return (String(text ?? '').match(/\S*[\p{L}\p{N}]\S*/gu) ?? []).length;
}

export function buildRules(template, { lengthHint } = {}) {
    const text = nonEmptyText(template, DEFAULT_RULES);
    return text.replace(/\{\{length\}\}/giu, nonEmptyText(lengthHint, DEFAULT_SETTINGS.lengthHint)).trim();
}

/** Macro braces are neutralised so a direction never expands as a macro. */
export function escapeMacros(text) {
    return String(text ?? '').replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
}

export function buildDirection(text) {
    const clean = escapeMacros(text).replace(/\s+/gu, ' ').trim();
    return clean ? `[Direction for the next passage only: ${clean}]` : '';
}

function paragraphs(text) {
    return String(text ?? '').split(/\n\s*\n/u).map((p) => p.trim()).filter(Boolean);
}

/** The selection plus up to `count` paragraphs either side, for cheap local-context rewrites. */
export function contextWindow(value, start, end, count = 2) {
    const source = String(value ?? '');
    const from = Math.max(0, Math.min(Number(start) || 0, Number(end) || 0));
    const to = Math.min(source.length, Math.max(Number(start) || 0, Number(end) || 0));
    return {
        before: paragraphs(source.slice(0, from)).slice(-count).join('\n\n'),
        selection: source.slice(from, to),
        after: paragraphs(source.slice(to)).slice(0, count).join('\n\n'),
    };
}

export const TRANSFORMS = Object.freeze({
    rewrite: 'Rewrite the passage for clarity and flow while keeping its meaning, voice, tense and point of view.',
    expand: 'Expand the passage with more concrete detail while keeping its intent, continuity and point of view.',
    compress: 'Compress the passage to a tighter version while keeping its essential meaning and continuity.',
});

export const TRANSFORM_SYSTEM = 'You are a line editor working inside a manuscript. Change only the passage you are given; '
    + 'the text around it is context and must not be repeated. Reply with the replacement passage only: no preamble, no quotes, no notes.';

export function estimateTokens(text) {
    return Math.ceil(String(text ?? '').length / 3.5);
}

/**
 * Normalizes reasoning entries from a message or story extra.
 * Returns an array of { cut, text, duration }.
 */
export function extractReasonings(message, extraKey = EXTRA_KEY) {
    if (!message || typeof message !== 'object') {
        return [];
    }
    const list = message.extra?.[extraKey]?.reasonings;
    if (Array.isArray(list) && list.length > 0) {
        return list.map((item, index) => ({
            cut: typeof item?.cut === 'number' ? item.cut : index,
            text: String(item?.text ?? '').trim(),
            duration: typeof item?.duration === 'number' ? item.duration : (Number(item?.duration) || null),
        })).filter(r => r.text.length > 0);
    }
    if (typeof message.extra?.reasoning === 'string' && message.extra.reasoning.trim()) {
        return [{
            cut: 0,
            text: message.extra.reasoning.trim(),
            duration: typeof message.extra.reasoning_duration === 'number' ? message.extra.reasoning_duration : (Number(message.extra.reasoning_duration) || null),
        }];
    }
    return [];
}

export function clampTokens(value, min = 64, max = 1024) {
    const number = Number.isFinite(value) ? Math.round(value) : min;
    return Math.min(max, Math.max(min, number));
}

export function formatDuration(milliseconds) {
    const s = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
    if (s < 60) {
        return `${s}s`;
    }
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

export function buildTransformPrompt(kind, { before = '', selection = '', after = '', instruction = '' } = {}) {
    const guidance = kind === 'custom'
        ? (String(instruction ?? '').trim() || 'Improve the passage.')
        : (TRANSFORMS[kind] ?? TRANSFORMS.rewrite);
    const parts = [guidance];
    if (before) {
        parts.push(`Text before the passage:\n${before}`);
    }
    parts.push(`Passage to change:\n${selection}`);
    if (after) {
        parts.push(`Text after the passage:\n${after}`);
    }
    parts.push('Replacement passage:');
    const factor = kind === 'expand' ? 3 : kind === 'compress' ? 1.25 : 2;
    return {
        systemPrompt: TRANSFORM_SYSTEM,
        prompt: parts.join('\n\n'),
        responseLength: clampTokens(estimateTokens(selection) * factor),
    };
}

/** Strips fences, a stray label, and quotes the model wrapped around the passage (unless the passage itself was quoted). */
export function cleanTransformResult(text, selection = '') {
    let out = String(text ?? '').trim();
    out = out.replace(/^```[a-z]*\s*\n?/iu, '').replace(/\n?```\s*$/u, '').trim();
    out = out.replace(/^replacement passage:\s*/iu, '').trim();
    const selectionQuoted = /^["“]/u.test(String(selection ?? '').trim());
    if (!selectionQuoted && out.length > 1) {
        if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”'))) {
            out = out.slice(1, -1).trim();
        }
    }
    return out;
}

/** `/story on|off|toggle` → true/false; null for junk. */
export function parseStoryArg(arg, current) {
    const value = String(arg ?? '').trim().toLowerCase();
    if (!value || value === 'toggle') {
        return !current;
    }
    if (['on', 'true', '1', 'yes', 'enable'].includes(value)) {
        return true;
    }
    if (['off', 'false', '0', 'no', 'disable'].includes(value)) {
        return false;
    }
    return null;
}
