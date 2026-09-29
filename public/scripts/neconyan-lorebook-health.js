import { detectMalformedWrapper, entryDelimiterName, entryDelimiterNameFromKey, malformedWrapperLabel } from './neconyan-lorebook-delimiters.js';
import { classifyKey, findKeyMatches } from './neconyan-lorebook-keytest.js';
import { lorebookEntryTitle } from './neconyan-lorebook-tools-core.js';

export const HEALTH_LARGE_BOOK_THRESHOLD = 1500;
const CONTENT_SCAN_LIMIT = 5000;
const ENTRIES_PER_STEP = 200;
const SOURCES_PER_STEP = 16;

export const HEALTH_RULES = Object.freeze({
    'invalid-regex': 'Invalid regex',
    'duplicate-key': 'Duplicate keys',
    'secondary-keys-ignored': 'Ignored secondary keys',
    'selective-without-secondary': 'Selective without secondary',
    'never-activatable': 'Never activatable',
    'recursion-cycle': 'Recursion cycles',
    'self-trigger': 'Self-triggers',
    'malformed-wrapper': 'Malformed wrappers',
});

export const HEALTH_SEVERITIES = Object.freeze([
    ['error', 'Errors'],
    ['warning', 'Warnings'],
    ['info', 'Notes'],
]);

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };
const GRAPH_RULES = ['recursion-cycle', 'self-trigger'];
const ALTERNATE_SOURCES = [
    'matchPersonaDescription',
    'matchCharacterDescription',
    'matchCharacterPersonality',
    'matchCharacterDepthPrompt',
    'matchScenario',
    'matchCreatorNotes',
];

/**
 * Stable identity of a finding, used to remember 'not an issue'.
 * @param {{rule: string, entryIds: string[], details?: string}} diagnostic Finding
 * @returns {string}
 */
export function healthSignature({ rule, entryIds, details }) {
    return `${rule}|${entryIds.join(',')}|${details ?? ''}`;
}

/**
 * Cleans saved Health check preferences, dropping unknown rule names.
 * @param {unknown} value Saved preferences
 * @returns {{ignoredSignatures: string[], mutedRules: string[]}|undefined}
 */
export function sanitizeHealthPrefs(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const strings = list => Array.isArray(list) ? [...new Set(list.filter(item => typeof item === 'string' && item.trim()))] : [];
    return {
        ignoredSignatures: strings(value.ignoredSignatures),
        mutedRules: strings(value.mutedRules).filter(rule => Object.hasOwn(HEALTH_RULES, rule)),
    };
}

function quotedList(items) {
    const quoted = items.map(item => `"${item}"`);
    if (quoted.length < 2) return quoted[0] ?? '';
    return `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}

function usableKeys(keys) {
    return Array.isArray(keys) ? keys.filter(key => typeof key === 'string' && key.trim()) : [];
}

function orderedEntries(book) {
    return Object.values(book?.entries ?? {}).filter(entry => entry && typeof entry === 'object');
}

function hasAlternateActivation(entry) {
    return Boolean(entry.vectorized)
        || (typeof entry.automationId === 'string' && entry.automationId.trim() !== '')
        || (Array.isArray(entry.triggers) && entry.triggers.length > 0)
        || ALTERNATE_SOURCES.some(flag => Boolean(entry[flag]));
}

function entryRules(entry, index, emit) {
    const title = lorebookEntryTitle(entry);
    const id = String(entry.uid ?? index);
    for (const key of [...usableKeys(entry.key), ...usableKeys(entry.keysecondary)]) {
        if (classifyKey(key) === 'invalid-regex') {
            emit({ rule: 'invalid-regex', severity: 'error', entryIds: [id], details: key.trim(),
                message: `Entry "${title}" has a regex-shaped key that is not a valid regex - SillyTavern will not treat it as a regex.` }, index);
        }
    }
    const malformed = detectMalformedWrapper(String(entry.content ?? ''), [entryDelimiterName(entry), entryDelimiterNameFromKey(entry)]);
    if (malformed) {
        emit({ rule: 'malformed-wrapper', severity: malformed.kind === 'mismatched' ? 'error' : 'warning', entryIds: [id],
            details: malformedWrapperLabel(malformed), message: `Entry "${title}" content has a malformed whole-content wrapper.` }, index);
    }
    const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary : [];
    if (secondary.length && entry.constant) {
        emit({ rule: 'secondary-keys-ignored', severity: 'warning', entryIds: [id],
            message: `Entry "${title}" is constant - SillyTavern ignores all of its keys, including these secondary keys.` }, index);
    } else if (secondary.length && !entry.selective) {
        emit({ rule: 'secondary-keys-ignored', severity: 'warning', entryIds: [id],
            message: `Entry "${title}" is not selective - SillyTavern ignores its secondary keys.` }, index);
    }
    if (entry.selective === true && !secondary.length) {
        emit({ rule: 'selective-without-secondary', severity: 'info', entryIds: [id],
            message: `Entry "${title}" is selective but has no secondary keys to match against.` }, index);
    }
    if (!entry.constant && !usableKeys(entry.key).length && !hasAlternateActivation(entry)) {
        emit({ rule: 'never-activatable', severity: 'warning', entryIds: [id],
            message: `Entry "${title}" has no primary keys and no alternate activation source - it can never activate.` }, index);
    }
}

function duplicateKeyRules(entries, emit, defaults) {
    const buckets = new Map();
    entries.forEach((entry, index) => {
        if (entry.disable) return;
        const caseSensitive = Boolean(entry.caseSensitive ?? defaults.caseSensitive ?? false);
        for (const spelling of new Set(usableKeys(entry.key).map(key => key.trim()))) {
            const folded = spelling.toLowerCase();
            if (!buckets.has(folded)) buckets.set(folded, []);
            buckets.get(folded).push({ entry, index, spelling, caseSensitive });
        }
    });
    for (const participants of buckets.values()) {
        if (new Set(participants.map(item => item.index)).size < 2) continue;
        const parent = participants.map((_, index) => index);
        const find = index => parent[index] === index ? index : (parent[index] = find(parent[index]));
        for (let a = 0; a < participants.length; a++) {
            for (let b = a + 1; b < participants.length; b++) {
                const left = participants[a];
                const right = participants[b];
                if (left.spelling === right.spelling || !(left.caseSensitive && right.caseSensitive)) parent[find(a)] = find(b);
            }
        }
        const components = new Map();
        participants.forEach((item, index) => {
            const root = find(index);
            if (!components.has(root)) components.set(root, []);
            components.get(root).push(item);
        });
        for (const component of components.values()) {
            const members = [...new Map(component.map(item => [item.index, item])).values()].sort((a, b) => a.index - b.index);
            if (members.length < 2) continue;
            const groups = members.map(item => String(item.entry.group ?? '').trim());
            const sharedGroup = groups[0] !== '' && groups.every(group => group === groups[0]);
            const details = component[0].spelling;
            const names = quotedList(members.map(item => lorebookEntryTitle(item.entry)));
            emit({
                rule: 'duplicate-key',
                severity: sharedGroup ? 'info' : 'warning',
                entryIds: members.map(item => String(item.entry.uid ?? item.index)),
                details,
                message: sharedGroup
                    ? `Entries ${names} share the primary key '${details}' - they compete for the same activation, but their shared inclusion group makes the tie intentional.`
                    : `Entries ${names} share the primary key '${details}' - they compete for the same activation.`,
            }, members[0].index);
        }
    }
}

function stronglyConnected(nodes) {
    const stack = [];
    const components = [];
    let counter = 0;
    const visit = node => {
        node.tarjanIndex = node.lowlink = counter++;
        stack.push(node);
        node.onStack = true;
        for (const next of node.successors) {
            if (next.tarjanIndex === -1) {
                visit(next);
                node.lowlink = Math.min(node.lowlink, next.lowlink);
            } else if (next.onStack) {
                node.lowlink = Math.min(node.lowlink, next.tarjanIndex);
            }
        }
        if (node.lowlink !== node.tarjanIndex) return;
        const component = [];
        let member;
        do {
            member = stack.pop();
            member.onStack = false;
            component.push(member);
        } while (member !== node);
        components.push(component);
    };
    for (const node of nodes) if (node.tarjanIndex === -1) visit(node);
    return components;
}

function cyclePath(component) {
    const members = new Set(component);
    const ordered = [...component].sort((a, b) => a.index - b.index);
    const start = ordered[0];
    const path = [start];
    const visited = new Set([start]);
    const walk = current => {
        for (const next of current.successors) {
            if (next === start) {
                if (path.length >= 2) return true;
                continue;
            }
            if (!members.has(next) || visited.has(next)) continue;
            visited.add(next);
            path.push(next);
            if (walk(next)) return true;
            path.pop();
        }
        return false;
    };
    return walk(start) ? path : ordered;
}

function* recursionRules(entries, emit, defaults) {
    const nodes = entries.map((entry, index) => ({ entry, index, successors: [], tarjanIndex: -1, lowlink: 0, onStack: false }));
    const targets = nodes.filter(({ entry }) => !entry.disable && !entry.constant && !entry.excludeRecursion && usableKeys(entry.key).length);
    const sources = nodes.filter(({ entry }) => !entry.disable && !entry.preventRecursion);
    for (let offset = 0; offset < sources.length; offset += SOURCES_PER_STEP) {
        for (const source of sources.slice(offset, offset + SOURCES_PER_STEP)) {
            const content = String(source.entry.content ?? '').slice(0, CONTENT_SCAN_LIMIT);
            if (!content) continue;
            for (const target of targets) {
                const options = {
                    caseSensitive: Boolean(target.entry.caseSensitive ?? defaults.caseSensitive ?? false),
                    matchWholeWords: Boolean(target.entry.matchWholeWords ?? defaults.matchWholeWords ?? false),
                };
                const matched = usableKeys(target.entry.key).find(key => findKeyMatches(key, content, options).ranges.length);
                if (matched === undefined) continue;
                if (target === source) {
                    emit({ rule: 'self-trigger', severity: 'info', entryIds: [String(source.entry.uid ?? source.index)], details: matched.trim(),
                        message: `Entry "${lorebookEntryTitle(source.entry)}" content contains its own keys - it may activate itself during recursion.` }, source.index);
                } else {
                    source.successors.push(target);
                }
            }
        }
        yield Math.min(1, (offset + SOURCES_PER_STEP) / Math.max(sources.length, 1));
    }
    for (const component of stronglyConnected(nodes)) {
        if (component.length < 2) continue;
        const path = cyclePath(component);
        const titles = path.map(node => lorebookEntryTitle(node.entry));
        emit({ rule: 'recursion-cycle', severity: 'warning', entryIds: path.map(node => String(node.entry.uid ?? node.index)),
            details: [...titles, titles[0]].join(' → '), message: `Entries ${quotedList(titles)} may activate during recursion in a loop.` },
        Math.min(...path.map(node => node.index)));
    }
}

/**
 * Runs the Health check in steps so a large lorebook does not freeze the page. Yields progress from 0 to 1.
 * @param {object} book Native lorebook
 * @param {{prefs?: object, includeGraphRules?: boolean, defaults?: {caseSensitive?: boolean, matchWholeWords?: boolean}}} options Options
 * @returns {Generator<number, {diagnostics: object[], hidden: number}>}
 */
export function* healthCheckSteps(book, { prefs, includeGraphRules = true, defaults = {} } = {}) {
    const entries = orderedEntries(book);
    const clean = sanitizeHealthPrefs(prefs) ?? { ignoredSignatures: [], mutedRules: [] };
    const found = [];
    const emit = (diagnostic, index) => found.push({ diagnostic, index, seq: found.length });
    for (let offset = 0; offset < entries.length; offset += ENTRIES_PER_STEP) {
        entries.slice(offset, offset + ENTRIES_PER_STEP).forEach((entry, step) => entryRules(entry, offset + step, emit));
        yield 0.05 * Math.min(1, (offset + ENTRIES_PER_STEP) / entries.length);
    }
    duplicateKeyRules(entries, emit, defaults);
    yield 0.1;
    const graphMuted = GRAPH_RULES.every(rule => clean.mutedRules.includes(rule));
    if (includeGraphRules && !graphMuted) {
        if (entries.length > HEALTH_LARGE_BOOK_THRESHOLD) {
            emit({ rule: 'recursion-cycle', severity: 'info', entryIds: [],
                message: `Lorebook has ${entries.length} entries - the recursion cycle and self-trigger checks are skipped above ${HEALTH_LARGE_BOOK_THRESHOLD} for performance.` }, 0);
        } else {
            for (const progress of recursionRules(entries, emit, defaults)) yield 0.1 + 0.9 * progress;
        }
    }
    found.sort((a, b) => SEVERITY_RANK[a.diagnostic.severity] - SEVERITY_RANK[b.diagnostic.severity] || a.index - b.index || a.seq - b.seq);
    const ignored = new Set(clean.ignoredSignatures);
    const visible = found.map(item => item.diagnostic).filter(item => !clean.mutedRules.includes(item.rule));
    const diagnostics = visible.filter(item => !ignored.has(healthSignature(item)));
    return { diagnostics, hidden: visible.length - diagnostics.length };
}

/**
 * Runs the whole Health check at once.
 * @param {object} book Native lorebook
 * @param {object} options Same options as healthCheckSteps
 * @returns {{diagnostics: object[], hidden: number}}
 */
export function checkLorebookHealth(book, options = {}) {
    const steps = healthCheckSteps(book, options);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

/**
 * Runs the Health check in chunks, handing control back to the page between them.
 * @param {object} book Native lorebook
 * @param {object} options Same options as healthCheckSteps, plus onProgress(fraction) and isCancelled()
 * @returns {Promise<{diagnostics: object[], hidden: number}|null>} Null when cancelled
 */
export async function runLorebookHealth(book, { onProgress, isCancelled, ...options } = {}) {
    const steps = healthCheckSteps(book, options);
    let next = steps.next();
    while (!next.done) {
        onProgress?.(next.value);
        await new Promise(resolve => setTimeout(resolve, 0));
        if (isCancelled?.()) return null;
        next = steps.next();
    }
    onProgress?.(1);
    return next.value;
}

/**
 * Count shown on the Health check button: errors and warnings from the quick checks.
 * @param {object} book Native lorebook
 * @param {object} options Same options as healthCheckSteps
 * @returns {number}
 */
export function quickHealthCount(book, options = {}) {
    return checkLorebookHealth(book, { ...options, includeGraphRules: false }).diagnostics.filter(item => item.severity !== 'info').length;
}
