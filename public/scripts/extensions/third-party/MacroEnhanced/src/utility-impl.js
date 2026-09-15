/**
 * Pure implementations for the utility macro pack. No Neconyan imports —
 * everything in this file is directly testable under `node --test`.
 */

export const REPEAT_MAX = 1000;
export const CHARS_PER_TOKEN = 4;

// ---------- text ----------

export function capitalizeText(text) {
    const s = String(text);
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function replaceText(text, search, replacement) {
    const s = String(text);
    const from = String(search);
    if (!from) {
        return s;
    }
    return s.split(from).join(String(replacement ?? ''));
}

export function substringText(text, start, end) {
    const s = String(text);
    const from = Number.isFinite(start) ? start : 0;
    if (end === undefined || end === null || !Number.isFinite(end)) {
        return s.slice(from);
    }
    return s.slice(from, end);
}

export function repeatText(text, count) {
    const s = String(text);
    const n = Math.max(0, Math.trunc(count));
    const clamped = Math.min(n, REPEAT_MAX);
    return { result: s.repeat(clamped), clamped: clamped !== n };
}

export function defaultText(value, fallback) {
    const s = String(value ?? '');
    return s.trim() ? s : String(fallback ?? '');
}

/**
 * One field of a separated string, by position. Negative positions count from
 * the end; a position past either end yields "".
 *
 * An empty separator means a single space. The host's lexer discards whitespace
 * between argument separators, so `{{split::a b:: ::0}}` cannot deliver a literal
 * space. a space is also the only separator worth defaulting to, since splitting
 * on the true empty string is what {{substring}} is for. Write {{space}} to be
 * explicit about it.
 */
export function splitField(text, separator, index) {
    const s = String(text ?? '');
    const sep = String(separator ?? '') || ' ';
    const parts = s.split(sep);
    const at = Math.trunc(index);
    const resolved = at < 0 ? parts.length + at : at;
    return resolved >= 0 && resolved < parts.length ? parts[resolved] : '';
}

/**
 * Surrounds a value with a prefix and suffix, but only when the value is not
 * empty. the point being to attach separators that should vanish along with
 * whatever they were separating.
 */
export function wrapText(value, prefix, suffix) {
    const s = String(value ?? '');
    if (!s) {
        return '';
    }
    return `${String(prefix ?? '')}${s}${String(suffix ?? '')}`;
}

export function truncateText(text, maxChars, ellipsis = '…') {
    const s = String(text);
    const max = Math.max(0, Math.trunc(maxChars));
    if (s.length <= max) {
        return s;
    }
    const tail = String(ellipsis ?? '');
    if (tail.length >= max) {
        return s.slice(0, max);
    }
    return s.slice(0, max - tail.length) + tail;
}

export function estimateTokens(text) {
    return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

export function truncateTokensText(text, maxTokens, ellipsis = '…') {
    const maxChars = Math.max(0, Math.trunc(maxTokens)) * CHARS_PER_TOKEN;
    return truncateText(text, maxChars, ellipsis);
}

// ---------- math ----------

export class CalcError extends Error {}

const CALC_FUNCTIONS = {
    min: { minArgs: 1, maxArgs: Infinity, fn: (...a) => Math.min(...a) },
    max: { minArgs: 1, maxArgs: Infinity, fn: (...a) => Math.max(...a) },
    round: { minArgs: 1, maxArgs: 2, fn: (x, d = 0) => roundTo(x, d) },
    floor: { minArgs: 1, maxArgs: 1, fn: Math.floor },
    ceil: { minArgs: 1, maxArgs: 1, fn: Math.ceil },
    abs: { minArgs: 1, maxArgs: 1, fn: Math.abs },
    sqrt: { minArgs: 1, maxArgs: 1, fn: Math.sqrt },
    pow: { minArgs: 2, maxArgs: 2, fn: Math.pow },
};

const CALC_CONSTANTS = {
    pi: Math.PI,
    e: Math.E,
};

export function roundTo(value, decimals = 0) {
    const factor = 10 ** Math.trunc(decimals);
    return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function clampNumber(value, min, max) {
    if (min > max) {
        [min, max] = [max, min];
    }
    return Math.min(max, Math.max(min, value));
}

/** Renders a computed number without floating point noise ("0.30000000000000004"). */
export function formatNumber(value) {
    if (!Number.isFinite(value)) {
        return String(value);
    }
    if (Number.isInteger(value)) {
        return String(value);
    }
    return String(Number(value.toPrecision(12)));
}

function tokenizeCalc(expression) {
    const tokens = [];
    const src = String(expression);
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (/[0-9.]/.test(ch)) {
            const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i));
            if (!match) {
                throw new CalcError(`Invalid number at position ${i}`);
            }
            tokens.push({ type: 'number', value: Number(match[0]) });
            i += match[0].length;
            continue;
        }
        if (/[a-zA-Z_]/.test(ch)) {
            const match = /^[a-zA-Z_]\w*/.exec(src.slice(i));
            tokens.push({ type: 'ident', value: match[0].toLowerCase() });
            i += match[0].length;
            continue;
        }
        if ('+-*/%^(),'.includes(ch)) {
            tokens.push({ type: ch });
            i++;
            continue;
        }
        throw new CalcError(`Unexpected character "${ch}" at position ${i}`);
    }
    tokens.push({ type: 'end' });
    return tokens;
}

/**
 * Evaluates an arithmetic expression with a small Pratt parser. No eval/Function.
 * Supports + - * / % ^ (right-assoc), unary minus, parentheses, min/max/round/floor/
 * ceil/abs/sqrt/pow, and the constants pi/e.
 *
 * @param {string} expression
 * @returns {number}
 * @throws {CalcError} on malformed input
 */
export function evaluateExpression(expression) {
    const tokens = tokenizeCalc(expression);
    let pos = 0;

    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const expect = (type) => {
        const token = next();
        if (token.type !== type) {
            throw new CalcError(`Expected "${type}" but found "${token.type}"`);
        }
        return token;
    };

    // binding powers: + - (10), * / % (20), ^ (30, right-assoc), unary - (25)
    function parseExpressionBp(minBp) {
        let left = parsePrefix();
        for (;;) {
            const token = peek();
            const bp = { '+': 10, '-': 10, '*': 20, '/': 20, '%': 20, '^': 30 }[token.type];
            if (bp === undefined || bp < minBp) {
                break;
            }
            next();
            const rightBp = token.type === '^' ? bp : bp + 1;
            const right = parseExpressionBp(rightBp);
            left = applyBinary(token.type, left, right);
        }
        return left;
    }

    function parsePrefix() {
        const token = next();
        if (token.type === 'number') {
            return token.value;
        }
        if (token.type === '-') {
            return -parseExpressionBp(25);
        }
        if (token.type === '+') {
            return parseExpressionBp(25);
        }
        if (token.type === '(') {
            const value = parseExpressionBp(0);
            expect(')');
            return value;
        }
        if (token.type === 'ident') {
            if (peek().type === '(') {
                return parseCall(token.value);
            }
            if (token.value in CALC_CONSTANTS) {
                return CALC_CONSTANTS[token.value];
            }
            throw new CalcError(`Unknown identifier "${token.value}"`);
        }
        throw new CalcError(`Unexpected token "${token.type}"`);
    }

    function parseCall(name) {
        const spec = CALC_FUNCTIONS[name];
        if (!spec) {
            throw new CalcError(`Unknown function "${name}"`);
        }
        expect('(');
        const args = [];
        if (peek().type !== ')') {
            args.push(parseExpressionBp(0));
            while (peek().type === ',') {
                next();
                args.push(parseExpressionBp(0));
            }
        }
        expect(')');
        if (args.length < spec.minArgs || args.length > spec.maxArgs) {
            throw new CalcError(`Function "${name}" takes ${spec.minArgs}${spec.maxArgs === Infinity ? '+' : `-${spec.maxArgs}`} arguments`);
        }
        return spec.fn(...args);
    }

    function applyBinary(op, left, right) {
        switch (op) {
            case '+': return left + right;
            case '-': return left - right;
            case '*': return left * right;
            case '/':
                if (right === 0) {
                    throw new CalcError('Division by zero');
                }
                return left / right;
            case '%':
                if (right === 0) {
                    throw new CalcError('Modulo by zero');
                }
                return left % right;
            case '^': return left ** right;
            default: throw new CalcError(`Unknown operator "${op}"`);
        }
    }

    const result = parseExpressionBp(0);
    expect('end');
    if (!Number.isFinite(result)) {
        throw new CalcError('Expression did not produce a finite number');
    }
    return result;
}

// ---------- lists ----------

export function splitList(list, separator = ',') {
    const s = String(list);
    if (!s.trim()) {
        return [];
    }
    const sep = String(separator);
    return (sep ? s.split(sep) : [s]).map(item => item.trim());
}

export function itemAt(index, list, separator = ',') {
    const items = splitList(list, separator);
    const i = index < 0 ? items.length + index : index;
    return i >= 0 && i < items.length ? items[i] : '';
}

export function sortList(list, separator = ',', order = 'asc') {
    const items = splitList(list, separator);
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    items.sort(collator.compare);
    if (String(order).toLowerCase() === 'desc') {
        items.reverse();
    }
    return items;
}

// ---------- JSON ----------

export class JsonPathError extends Error {}

export function parseJsonPath(path) {
    const segments = [];
    const src = String(path);
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '.') {
            i++;
            continue;
        }
        if (ch === '[') {
            const close = src.indexOf(']', i);
            if (close === -1) {
                throw new JsonPathError(`Unclosed "[" in path at position ${i}`);
            }
            const inner = src.slice(i + 1, close).trim();
            const quoted = /^["'](.*)["']$/.exec(inner);
            if (quoted) {
                segments.push(quoted[1]);
            } else if (/^-?\d+$/.test(inner)) {
                segments.push(Number(inner));
            } else {
                throw new JsonPathError(`Invalid bracket segment "[${inner}]"`);
            }
            i = close + 1;
            continue;
        }
        const match = /^[^.[\]]+/.exec(src.slice(i));
        if (!match) {
            throw new JsonPathError(`Unexpected "${ch}" in path at position ${i}`);
        }
        segments.push(match[0]);
        i += match[0].length;
    }
    return segments;
}

export function jsonGet(jsonText, path) {
    let value;
    try {
        value = JSON.parse(String(jsonText));
    } catch {
        throw new JsonPathError('Input is not valid JSON');
    }

    for (const segment of parseJsonPath(path)) {
        if (value === null || typeof value !== 'object') {
            return '';
        }
        const key = typeof segment === 'number' && Array.isArray(value) && segment < 0
            ? value.length + segment
            : segment;
        value = value[key];
    }

    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}
