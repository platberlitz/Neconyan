/** Parse a literal or plain pattern, including multiline input.
 * @copyright Originally from https://github.com/IonicaBizau/regex-parser.js/blob/master/lib/index.js
 */
export function regexFromString(input) {
    try {
        const match = input.match(/^(\/?)([\s\S]+)\1([a-z]*)$/i);
        try {
            return new RegExp(match[2], match[3]);
        } catch {
            return RegExp(input);
        }
    } catch {
        return;
    }
}

const SIMPLE_CONTROL_ESCAPES = {
    n: '\n',
    r: '\r',
    t: '\t',
    f: '\f',
    v: '\v',
};

const ANY_STAR_PREFIXES = [
    '[\\s\\S]*',
    '[\\S\\s]*',
    '[\\w\\W]*',
    '[\\W\\w]*',
    '[\\d\\D]*',
    '[\\D\\d]*',
];

const REGEX_META_CHARS = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|']);
const QUANTIFIER_STARTERS = new Set(['*', '+', '?', '{']);
const leadingLookbehindPlans = new WeakMap();

function matchAnyStarSuffix(source, index, dotAll) {
    for (const prefix of ANY_STAR_PREFIXES) {
        if (source.startsWith(prefix, index)) {
            let end = index + prefix.length;
            if (source[end] === '?') end += 1;
            if (source[end] === ')') return end + 1;
        }
    }
    if (dotAll && source.startsWith('.*', index)) {
        let end = index + 2;
        if (source[end] === '?') end += 1;
        if (source[end] === ')') return end + 1;
    }
    return -1;
}

function hasTopLevelAlternation(pattern) {
    let inClass = false;
    let parenDepth = 0;
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === '\\') {
            i += 1;
            continue;
        }
        if (inClass) {
            if (ch === ']') inClass = false;
            continue;
        }
        if (ch === '[') {
            inClass = true;
            continue;
        }
        if (ch === '(') {
            parenDepth += 1;
            continue;
        }
        if (ch === ')') {
            if (parenDepth > 0) parenDepth -= 1;
            continue;
        }
        if (ch === '|' && parenDepth === 0) {
            return true;
        }
    }
    return false;
}

function parseLeadingLookbehind(regex) {
    if (regex.sticky || regex.unicodeSets) {
        return null;
    }
    const source = regex.source;
    if (!source.startsWith('(?<=')) {
        return null;
    }

    let i = 4;
    let literalText = '';
    let markerEndIndex = -1;
    let bodyStart = -1;

    while (i < source.length) {
        if (literalText.length > 0) {
            const afterLookbehind = matchAnyStarSuffix(source, i, regex.dotAll);
            if (afterLookbehind !== -1) {
                markerEndIndex = i;
                bodyStart = afterLookbehind;
                break;
            }
        }

        const ch = source[i];
        let nextIndex = i + 1;
        if (ch === '\\') {
            if (nextIndex >= source.length) return null;
            const escaped = source[nextIndex];
            nextIndex += 1;
            if (Object.hasOwn(SIMPLE_CONTROL_ESCAPES, escaped)) {
                literalText += SIMPLE_CONTROL_ESCAPES[escaped];
            } else if (escaped === '0' && !/^[0-9]$/.test(source[nextIndex] || '')) {
                literalText += '\0';
            } else if (!/^[A-Za-z0-9]$/.test(escaped)) {
                literalText += escaped;
            } else {
                return null;
            }
        } else if (REGEX_META_CHARS.has(ch)) {
            return null;
        } else {
            literalText += ch;
        }

        // A quantifier makes the marker variable-length or optional, so fall back to native replace.
        if (QUANTIFIER_STARTERS.has(source[nextIndex])) {
            return null;
        }
        i = nextIndex;
    }

    if (bodyStart === -1 || !literalText) {
        return null;
    }

    // A quantifier on the lookbehind itself (allowed in non-Unicode mode) makes it optional.
    if (QUANTIFIER_STARTERS.has(source[bodyStart])) {
        return null;
    }

    const bodySource = source.slice(bodyStart);
    if (hasTopLevelAlternation(bodySource)) {
        return null;
    }

    const markerSource = source.slice(4, markerEndIndex);
    const bodyFlags = regex.global ? regex.flags : `${regex.flags}g`;

    // Case-sensitive BMP literals can use indexOf; case-insensitive or surrogate-bearing
    // markers delegate to a tiny non-lookbehind RegExp so case folding matches JS exactly.
    const useIndexOf = !regex.ignoreCase && !/[\uD800-\uDFFF]/.test(literalText);
    const markerFlags = `${regex.ignoreCase ? 'i' : ''}${regex.unicode ? 'u' : ''}`;
    let bodyRegex;
    let markerRegex = null;
    try {
        bodyRegex = new RegExp(bodySource, bodyFlags);
        if (!useIndexOf) {
            markerRegex = new RegExp(markerSource, markerFlags);
        }
    } catch {
        return null;
    }

    return {
        literalText,
        markerRegex,
        bodyRegex,
        isGlobal: regex.global,
        unicode: regex.unicode,
    };
}

function advanceStringIndex(input, index, unicode) {
    if (!unicode || index + 1 >= input.length) {
        return index + 1;
    }
    const first = input.charCodeAt(index);
    if (first < 0xD800 || first > 0xDBFF) {
        return index + 1;
    }
    const second = input.charCodeAt(index + 1);
    if (second < 0xDC00 || second > 0xDFFF) {
        return index + 1;
    }
    return index + 2;
}

/**
 * Runs String.prototype.replace with a linear-time fast path for leading
 * `(?<=literal[\s\S]*)rest` lookbehinds. JavaScriptCore evaluates variable-length
 * lookbehinds backwards at every position, turning themed HTML cards into a
 * multi-second freeze on Safari and iOS WebKit.
 * @param {string} input
 * @param {RegExp} regex
 * @param {Function|string} replacer
 * @returns {string}
 */
export function replaceWithRegex(input, regex, replacer) {
    if (typeof input !== 'string' || !(regex instanceof RegExp) || typeof replacer !== 'function') {
        return typeof input === 'string' ? input.replace(regex, replacer) : input;
    }

    let plan = leadingLookbehindPlans.get(regex);
    if (plan === undefined) {
        plan = parseLeadingLookbehind(regex);
        leadingLookbehindPlans.set(regex, plan);
    }
    if (!plan) {
        return input.replace(regex, replacer);
    }

    if (plan.isGlobal) {
        regex.lastIndex = 0;
    }

    let markerEnd = -1;
    if (plan.markerRegex) {
        const found = plan.markerRegex.exec(input);
        if (found) {
            markerEnd = found.index + found[0].length;
        }
    } else {
        const found = input.indexOf(plan.literalText);
        if (found !== -1) {
            markerEnd = found + plan.literalText.length;
        }
    }

    if (markerEnd === -1) {
        return input;
    }

    const { bodyRegex, isGlobal, unicode } = plan;
    let result = '';
    let lastCopied = 0;
    let searchFrom = markerEnd;
    let matched = false;

    while (searchFrom <= input.length) {
        bodyRegex.lastIndex = searchFrom;
        const match = bodyRegex.exec(input);
        if (!match) {
            break;
        }

        matched = true;
        const matchIndex = match.index;
        const matchText = match[0];
        const nextIndex = matchText.length > 0
            ? matchIndex + matchText.length
            : advanceStringIndex(input, matchIndex, unicode);

        const replacement = match.groups !== undefined
            ? String(replacer(...match, matchIndex, input, match.groups))
            : String(replacer(...match, matchIndex, input));

        result += input.slice(lastCopied, matchIndex) + replacement;
        lastCopied = matchIndex + matchText.length;

        if (!isGlobal) {
            break;
        }
        searchFrom = nextIndex;
    }

    if (!matched) {
        return input;
    }

    return result + input.slice(lastCopied);
}
