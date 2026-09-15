/**
 * Infix condition expressions: `a == b`, `x > 0`, `p || q && r`.
 *
 * The host's {{if}} only asks whether its condition is truthy, and every
 * non-empty string is. So a condition written as `0 > 0` reads as true, which
 * makes a whole class of imported content silently always-on. This module
 * evaluates such a condition properly; compat-impl.js is what routes {{if}}
 * conditions through it.
 *
 * Operands are raw text runs, not identifiers. after macro resolution a
 * condition looks like `selphie windsong == "user"`, so an operand runs up to
 * the next operator and is then trimmed. No Neconyan imports; directly
 * testable under `node --test`.
 */
import { compareValues, isTruthyText } from './logic-impl.js';

export class ExprError extends Error {}

export const EXPR_MAX_LENGTH = 10000;
export const EXPR_MAX_DEPTH = 32;

/** Longest first, so `==` never lexes as `=` and `!=` never as `!`. */
const OPERATORS = ['||', '&&', '==', '!=', '>=', '<=', '>', '<'];

/** True when `text` contains an operator outside quotes and outside nested `{{ }}`. */
export function hasExpressionOperator(text) {
    const s = String(text ?? '');
    let depth = 0;
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === '\'') {
            quote = ch;
            continue;
        }
        if (s.startsWith('{{', i)) {
            depth++;
            i++;
            continue;
        }
        if (s.startsWith('}}', i)) {
            depth = Math.max(0, depth - 1);
            i++;
            continue;
        }
        if (depth > 0) {
            continue;
        }
        // A single `|` is the host's output-filter syntax; only `||` is ours.
        for (const op of OPERATORS) {
            if (s.startsWith(op, i)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Splits a condition into operand and operator tokens. Quoted runs are opaque;
 * everything between operators is one operand, trimmed.
 *
 * @returns {{type: 'operand'|'op'|'lparen'|'rparen'|'not', value: string, quoted?: boolean}[]}
 */
function tokenize(text) {
    const s = String(text ?? '');
    const tokens = [];
    let buffer = '';
    /** Set when the run contained a quoted section, so `""` stays an operand. */
    let bufferQuoted = false;

    const flush = () => {
        const trimmed = buffer.trim();
        if (trimmed !== '' || bufferQuoted) {
            tokens.push({ type: 'operand', value: trimmed });
        }
        buffer = '';
        bufferQuoted = false;
    };
    const expectingOperand = () => {
        if (buffer.trim() !== '') {
            return false;
        }
        const last = tokens[tokens.length - 1];
        return !last || last.type === 'op' || last.type === 'lparen' || last.type === 'not';
    };

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];

        if (ch === '"' || ch === '\'') {
            const close = s.indexOf(ch, i + 1);
            if (close === -1) {
                throw new ExprError(`unclosed ${ch} quote`);
            }
            buffer += s.slice(i + 1, close);
            bufferQuoted = true;
            i = close;
            continue;
        }

        if (ch === '(') {
            flush();
            tokens.push({ type: 'lparen', value: '(' });
            continue;
        }
        if (ch === ')') {
            flush();
            tokens.push({ type: 'rparen', value: ')' });
            continue;
        }

        let matched = null;
        for (const op of OPERATORS) {
            if (s.startsWith(op, i)) {
                matched = op;
                break;
            }
        }
        if (matched) {
            flush();
            tokens.push({ type: 'op', value: matched });
            i += matched.length - 1;
            continue;
        }

        if (ch === '!' && expectingOperand()) {
            tokens.push({ type: 'not', value: '!' });
            continue;
        }

        buffer += ch;
    }
    flush();
    return tokens;
}

/**
 * A parsed operand carries its text; comparisons and logic produce plain
 * booleans. Keeping the text lets `a` on its own fall back to truthiness.
 */
function operandValue(token) {
    return { text: token.value };
}

function truthy(node) {
    return typeof node === 'boolean' ? node : isTruthyText(node.text);
}

function compare(op, left, right) {
    const c = compareValues(left.text, right.text);
    switch (op) {
        case '==': return c === 0;
        case '!=': return c !== 0;
        case '>': return c === 1;
        case '>=': return c >= 0;
        case '<': return c === -1;
        case '<=': return c <= 0;
        default: throw new ExprError(`unknown operator "${op}"`);
    }
}

/**
 * Precedence climbing, loosest first: `||`, then `&&`, then the comparisons.
 * Mirrors the shape of the {{calc}} parser in utility-impl.js.
 */
function parse(tokens) {
    let pos = 0;
    let depth = 0;

    const peek = () => tokens[pos];
    const eat = () => tokens[pos++];

    function parsePrimary() {
        const token = peek();
        if (!token) {
            throw new ExprError('the expression ends early');
        }
        if (token.type === 'not') {
            eat();
            return !truthy(parsePrimary());
        }
        if (token.type === 'lparen') {
            eat();
            if (++depth > EXPR_MAX_DEPTH) {
                throw new ExprError('too many nested brackets');
            }
            const inner = parseOr();
            depth--;
            if (peek()?.type !== 'rparen') {
                throw new ExprError('a closing bracket is missing');
            }
            eat();
            return inner;
        }
        if (token.type === 'operand') {
            eat();
            return operandValue(token);
        }
        throw new ExprError(`unexpected "${token.value}"`);
    }

    function parseComparison() {
        const left = parsePrimary();
        const token = peek();
        if (token?.type === 'op' && token.value !== '&&' && token.value !== '||') {
            eat();
            const right = parsePrimary();
            if (typeof left === 'boolean' || typeof right === 'boolean') {
                // `(a || b) == c` has no sensible reading; compare the words instead.
                throw new ExprError('cannot compare a bracketed condition to a value');
            }
            return compare(token.value, left, right);
        }
        return left;
    }

    function parseAnd() {
        let left = parseComparison();
        while (peek()?.type === 'op' && peek().value === '&&') {
            eat();
            const right = parseComparison();
            left = truthy(left) && truthy(right);
        }
        return left;
    }

    function parseOr() {
        let left = parseAnd();
        while (peek()?.type === 'op' && peek().value === '||') {
            eat();
            const right = parseAnd();
            left = truthy(left) || truthy(right);
        }
        return left;
    }

    const result = parseOr();
    if (pos < tokens.length) {
        throw new ExprError(`unexpected "${tokens[pos].value}"`);
    }
    return result;
}

/**
 * Evaluates a condition to a plain boolean.
 *
 * A condition with no operator falls back to the host's own truthiness rule, so
 * routing every condition through here does not change what plain ones mean.
 *
 * @param {string} text
 * @returns {boolean}
 * @throws {ExprError} on malformed input.
 */
export function evaluateCondition(text) {
    const s = String(text ?? '');
    if (s.length > EXPR_MAX_LENGTH) {
        throw new ExprError(`the condition is longer than ${EXPR_MAX_LENGTH} characters`);
    }
    const tokens = tokenize(s);
    if (!tokens.length) {
        return false;
    }
    return truthy(parse(tokens));
}
