import { LOGIC, SCAN_STATE, entryRef, entryRefKey } from '../constants.js';

const MAX_SCAN_DEPTH = 1000;
const MATCHER = '\x01';
const JOINER = `\n${MATCHER}`;

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createRng(seed) {
    let state = Number(seed) >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
}

export function parseRegexKey(value) {
    const match = String(value ?? '').match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match || match[1].match(/(^|[^\\])\//)) {
        return null;
    }
    try {
        return new RegExp(match[1].replace('\\/', '/'), match[2]);
    } catch {
        return null;
    }
}

export function matchKey(haystack, needle, entry, settings, parseRegex = parseRegexKey) {
    const regex = parseRegex?.(needle);
    if (regex) {
        const match = regex.exec(haystack);
        return {
            matched: Boolean(match),
            kind: 'regex',
            index: match?.index ?? -1,
            value: match?.[0] ?? '',
        };
    }

    const caseSensitive = entry.caseSensitive ?? settings.caseSensitive;
    const transformedHaystack = caseSensitive ? haystack : haystack.toLowerCase();
    const transformedNeedle = caseSensitive ? needle : needle.toLowerCase();
    const wholeWords = entry.matchWholeWords ?? settings.matchWholeWords;
    if (!wholeWords || transformedNeedle.split(/\s+/).length > 1) {
        const index = transformedHaystack.indexOf(transformedNeedle);
        return {
            matched: index !== -1,
            kind: wholeWords ? 'phrase' : 'plain',
            index,
            value: index === -1 ? '' : haystack.slice(index, index + needle.length),
        };
    }
    const boundary = new RegExp(`(?:^|\\W)(${escapeRegex(transformedNeedle)})(?:$|\\W)`);
    const match = boundary.exec(transformedHaystack);
    return {
        matched: Boolean(match),
        kind: 'whole-word',
        index: match?.index ?? -1,
        value: match?.[1] ?? '',
    };
}

function normalizeKey(raw, expand, scope) {
    if (typeof raw !== 'string') {
        return null;
    }
    const expanded = String(expand(raw, scope) ?? '').trim();
    return expanded ? { raw, expanded } : null;
}

export function evaluateKeys(entry, haystack, settings, expand, parseRegex) {
    const scope = `entry:${entryRefKey(entryRef(entry))}`;
    const rawPrimary = Array.isArray(entry.key) ? entry.key : [];
    const primaryResults = [];
    let primaryMatch = null;
    let normalizedPrimaryCount = 0;
    for (const [index, raw] of rawPrimary.entries()) {
        const key = normalizeKey(raw, expand, `${scope}:primary:${index}`);
        if (!key) {
            continue;
        }
        normalizedPrimaryCount++;
        const result = {
            ...key,
            ...matchKey(haystack, key.expanded, entry, settings, parseRegex),
        };
        primaryResults.push(result);
        if (result.matched) {
            primaryMatch = result;
            break;
        }
    }
    if (!primaryMatch) {
        return {
            matched: false,
            reason: normalizedPrimaryCount ? 'primary-miss' : 'no-primary-keys',
            primary: primaryResults,
            secondary: [],
            unvisitedPrimaryCount: Math.max(0, rawPrimary.length - primaryResults.length),
        };
    }

    const secondary = Array.isArray(entry.keysecondary)
        ? entry.keysecondary.map((key, index) => normalizeKey(key, expand, `${scope}:secondary:${index}`)).filter(Boolean)
        : [];
    if (!entry.selective || !secondary.length) {
        return {
            matched: true,
            reason: 'primary',
            primary: primaryResults,
            primaryMatch,
            secondary: [],
        };
    }
    const secondaryResults = [];
    const logic = entry.selectiveLogic ?? LOGIC.AND_ANY;
    let any = false;
    let all = true;
    let matched = false;
    for (const key of secondary) {
        const result = {
            ...key,
            ...matchKey(haystack, key.expanded, entry, settings, parseRegex),
        };
        secondaryResults.push(result);
        any ||= result.matched;
        all &&= result.matched;
        if (logic === LOGIC.AND_ANY && result.matched) {
            matched = true;
            break;
        }
        if (logic === LOGIC.NOT_ALL && !result.matched) {
            matched = true;
            break;
        }
    }
    if (logic === LOGIC.NOT_ANY) {
        matched = !any;
    } else if (logic === LOGIC.AND_ALL) {
        matched = all;
    }
    return {
        matched,
        reason: matched ? 'primary-secondary' : 'secondary-miss',
        logic,
        primary: primaryResults,
        primaryMatch,
        secondary: secondaryResults,
        unvisitedSecondaryCount: Math.max(0, secondary.length - secondaryResults.length),
    };
}

export class ScanBuffer {
    constructor(messages, globalScanData, injections, settings) {
        this.messages = Array.from({ length: Math.min(messages.length, MAX_SCAN_DEPTH) }, (_, index) => (
            messages[index] ? String(messages[index]).trim() : ''
        ));
        this.globalScanData = globalScanData ?? {};
        this.injections = (injections ?? []).map(String);
        this.settings = settings;
        this.recursion = [];
        this.skew = 0;
    }

    getDepth() {
        return Number(this.settings.depth) + this.skew;
    }

    advance() {
        this.skew++;
    }

    addRecursion(value) {
        if (value) {
            this.recursion.push(value);
        }
    }

    hasRecursion() {
        return this.recursion.length > 0;
    }

    get(entry, state) {
        let depth = Number(entry.scanDepth ?? this.getDepth());
        if (depth < 0) {
            return '';
        }
        depth = Math.min(MAX_SCAN_DEPTH, depth);
        let value = MATCHER + this.messages.slice(0, depth).join(JOINER);
        if (depth > 0) {
            const fields = [
                ['matchPersonaDescription', 'personaDescription'],
                ['matchCharacterDescription', 'characterDescription'],
                ['matchCharacterPersonality', 'characterPersonality'],
                ['matchCharacterDepthPrompt', 'characterDepthPrompt'],
                ['matchScenario', 'scenario'],
                ['matchCreatorNotes', 'creatorNotes'],
            ];
            for (const [flag, key] of fields) {
                if (entry[flag] && this.globalScanData[key]) {
                    value += JOINER + this.globalScanData[key];
                }
            }
        }
        if (this.injections.length) {
            value += JOINER + this.injections.join(JOINER);
        }
        if (this.recursion.length && state !== SCAN_STATE.MIN_ACTIVATIONS) {
            value += JOINER + this.recursion.join(JOINER);
        }
        return value;
    }

    score(entry, state, expand, parseRegex) {
        const haystack = this.get(entry, state);
        const scope = `entry:${entryRefKey(entryRef(entry))}`;
        const primary = Array.isArray(entry.key)
            ? entry.key.map((key, index) => normalizeKey(key, expand, `${scope}:primary:${index}`)).filter(Boolean)
            : [];
        if (!primary.length) {
            return 0;
        }
        const primaryScore = primary.filter(key => (
            matchKey(haystack, key.expanded, entry, this.settings, parseRegex).matched
        )).length;
        const secondary = Array.isArray(entry.keysecondary)
            ? entry.keysecondary.map((key, index) => normalizeKey(key, expand, `${scope}:secondary:${index}`)).filter(Boolean)
            : [];
        const secondaryScore = secondary.filter(key => (
            matchKey(haystack, key.expanded, entry, this.settings, parseRegex).matched
        )).length;
        if (secondary.length && entry.selectiveLogic === LOGIC.AND_ANY) {
            return primaryScore + secondaryScore;
        }
        if (secondary.length && entry.selectiveLogic === LOGIC.AND_ALL && secondaryScore === secondary.length) {
            return primaryScore + secondaryScore;
        }
        return primaryScore;
    }
}
