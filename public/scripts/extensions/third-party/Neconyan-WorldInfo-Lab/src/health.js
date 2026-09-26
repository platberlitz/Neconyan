import { entryId } from './constants.js';
import { matchKey } from './simulator/matching.js';
import { runWorldInfoLab } from './native.js';

const MIN_OVERLAP_KEY_LENGTH = 3;
const identity = value => String(value ?? '');

function reference(entry) {
    return {
        id: entryId(entry),
        uid: entry.uid,
        label: String(entry.comment ?? '').trim() || `Entry ${entry.uid}`,
    };
}

function normalizedKeys(entry, expand) {
    const keys = Array.isArray(entry.key) ? entry.key : [];
    return keys
        .filter(raw => typeof raw === 'string')
        .map(raw => ({ raw, expanded: String(expand(raw) ?? '').trim() }))
        .filter(key => key.expanded);
}

export function findMultiConcept(entries) {
    const findings = [];
    for (const entry of entries) {
        const comment = String(entry.comment ?? '');
        const reasons = [];
        if (/\band\b/i.test(comment)) {
            reasons.push('its title contains "and"');
        }
        if (comment.includes('&')) {
            reasons.push('its title contains "&"');
        }
        if (/\w\s*\/\s*\w/.test(comment)) {
            reasons.push('its title contains "/"');
        }
        if (reasons.length) {
            findings.push({ ...reference(entry), reasons });
        }
    }
    return findings;
}

export function findShortKeys(entries, expand = identity) {
    const findings = [];
    for (const entry of entries) {
        if (entry.disable) {
            continue;
        }
        const short = normalizedKeys(entry, expand)
            .filter(key => key.expanded.length < MIN_OVERLAP_KEY_LENGTH)
            .map(key => key.raw);
        if (short.length) {
            findings.push({ ...reference(entry), keys: short });
        }
    }
    return findings;
}

export function findKeyOverlaps(entries, settings, { parseRegex = null, expand = identity } = {}) {
    const prepared = entries
        .filter(entry => !entry.disable)
        .map(entry => ({
            entry,
            keys: normalizedKeys(entry, expand).filter(key => (
                key.expanded.length >= MIN_OVERLAP_KEY_LENGTH
            )),
        }))
        .filter(item => item.keys.length);
    const findings = [];
    const seenPairs = new Set();
    // ponytail: O(n²·k²) pairwise scan; index keys by prefix if books grow past ~1k entries
    for (const a of prepared) {
        for (const b of prepared) {
            if (a.entry === b.entry) {
                continue;
            }
            const pairKey = JSON.stringify([entryId(a.entry), entryId(b.entry)].sort());
            if (seenPairs.has(pairKey)) {
                continue;
            }
            outer: for (const aKey of a.keys) {
                for (const bKey of b.keys) {
                    if (matchKey(bKey.expanded, aKey.expanded, a.entry, settings, parseRegex).matched) {
                        seenPairs.add(pairKey);
                        findings.push({
                            a: reference(a.entry),
                            b: reference(b.entry),
                            aKey: aKey.raw,
                            bKey: bKey.raw,
                        });
                        break outer;
                    }
                }
            }
        }
    }
    return findings;
}

export function classifyActivation(entries, haystack, settings, { parseRegex = null, expand = identity } = {}) {
    const alwaysOn = [];
    const disabled = [];
    const neverActivates = [];
    const neverMatched = [];
    const text = String(haystack ?? '');
    for (const entry of entries) {
        if (entry.disable) {
            disabled.push(reference(entry));
            continue;
        }
        const decorators = Array.isArray(entry.decorators) ? entry.decorators : [];
        if (decorators.some(decorator => decorator.startsWith('@@dont_activate'))) {
            neverActivates.push({ ...reference(entry), reason: 'dont-activate' });
            continue;
        }
        if (entry.constant || decorators.some(decorator => decorator.startsWith('@@activate'))) {
            alwaysOn.push(reference(entry));
            continue;
        }
        const keys = normalizedKeys(entry, expand);
        if (!keys.length) {
            neverActivates.push({ ...reference(entry), reason: 'no-keys' });
            continue;
        }
        if (text && !entry.vectorized
            && !keys.some(key => matchKey(text, key.expanded, entry, settings, parseRegex).matched)) {
            neverMatched.push(reference(entry));
        }
    }
    return { alwaysOn, disabled, neverActivates, neverMatched };
}

export function tokenOutliers(perEntry) {
    const active = perEntry
        .filter(item => !item.disabled && item.tokens > 0)
        .map(item => item.tokens)
        .sort((left, right) => left - right);
    if (active.length < 4) {
        return new Set();
    }
    const median = active[Math.floor(active.length / 2)];
    const threshold = Math.max(200, median * 3);
    return new Set(perEntry
        .filter(item => !item.disabled && item.tokens > threshold)
        .map(item => item.id));
}

export async function auditSnapshot({ bookName, entries, settings, parseRegex, expand, messages, haystack, tokenCount, maxContext }) {
    const tokenCache = new Map();
    const cost = (content) => {
        const text = String(content ?? '');
        if (!tokenCache.has(text)) {
            tokenCache.set(text, tokenCount(text));
        }
        return tokenCache.get(text);
    };
    const perEntry = [];
    for (const entry of entries) {
        perEntry.push({
            ...reference(entry),
            tokens: Number(await cost(entry.content)),
            constant: Boolean(entry.constant),
            disabled: Boolean(entry.disable),
        });
    }

    const activation = classifyActivation(entries, haystack, settings, { parseRegex, expand });
    const alwaysIds = new Set(activation.alwaysOn.map(item => item.id));
    const enabledTotal = perEntry
        .filter(item => !item.disabled)
        .reduce((sum, item) => sum + item.tokens, 0);
    const alwaysTotal = perEntry
        .filter(item => !item.disabled && alwaysIds.has(item.id))
        .reduce((sum, item) => sum + item.tokens, 0);
    maxContext = Number.isFinite(maxContext) && maxContext > 0 ? maxContext : 4096;
    let budget = Math.round(Number(settings.budgetPercent) * maxContext / 100) || 1;
    if (Number(settings.budgetCap) > 0 && budget > Number(settings.budgetCap)) {
        budget = Number(settings.budgetCap);
    }

    return {
        bookName,
        entryCount: entries.length,
        enabledCount: entries.filter(entry => !entry.disable).length,
        chatMessageCount: messages.length,
        multiConcept: findMultiConcept(entries),
        shortKeys: findShortKeys(entries, expand),
        overlaps: findKeyOverlaps(entries, settings, { parseRegex, expand }),
        ...activation,
        tokens: {
            perEntry: [...perEntry].sort((left, right) => right.tokens - left.tokens),
            enabledTotal,
            alwaysTotal,
            budget,
            maxContext,
            outliers: tokenOutliers(perEntry),
        },
    };
}

export async function auditLorebook({ bookName, signal } = {}) {
    const report = await runWorldInfoLab('health', { book: bookName, mode: 'text' }, { signal });
    return { ...report, tokens: { ...report.tokens, outliers: new Set(report.tokens.outliers) } };
}
