/**
 * Compat mode's text rewrite: find {{if}} conditions written as infix
 * expressions and wrap them so they are evaluated rather than merely tested for
 * emptiness.
 *
 *   {{if::{{.hp}} > 0}}…{{/if}}   ->   {{if::{{expr::{{.hp}} > 0}}}}…{{/if}}
 *
 * Done as an engine pre-processor rather than by re-registering {{if}}. The
 * registry stamps ownership from the call stack, so an extension that
 * re-registers the host's {{if}}. even to hand back the host's own handler —
 * marks it as ours, and the disable sweep (unregisterMacrosBySource) would then
 * take {{if}} out of the app entirely. A pre-processor is added and removed with
 * addPreProcessor/removePreProcessor and leaves the registry untouched.
 *
 * The rewrite is surgical: only condition spans that actually contain an
 * operator are spliced, so every other byte survives verbatim. No Neconyan
 * imports; directly testable under `node --test`.
 */
import { hasExpressionOperator } from './expr-impl.js';

/** Flags the host allows between `{{` and the macro name. */
const FLAG_CHARS = '!?~#>/';
const IDENTIFIER = /^[a-zA-Z][\w-]*/;

/**
 * The index just past the `}}` that closes the macro opening at `start`, or -1
 * when it is unbalanced. Counts nested `{{ }}` so arguments containing macros
 * do not end it early.
 */
export function findMacroEnd(text, start) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text.startsWith('{{', i)) {
            depth++;
            i++;
        } else if (text.startsWith('}}', i)) {
            depth--;
            i++;
            if (depth === 0) {
                return i + 1;
            }
        }
    }
    return -1;
}

/**
 * Parses the opening of a macro: its name and where its arguments begin.
 *
 * @returns {{name: string, isClosing: boolean, argsStart: number}|null}
 */
function parseMacroHead(text, start, end) {
    let i = start + 2;
    let isClosing = false;
    while (i < end && (FLAG_CHARS.includes(text[i]) || /\s/.test(text[i]))) {
        if (text[i] === '/') {
            isClosing = true;
        }
        i++;
    }
    const match = IDENTIFIER.exec(text.slice(i, end));
    if (!match) {
        return null;
    }
    i += match[0].length;
    // The host separates a name from its arguments with `::`, `:` or whitespace.
    if (text.startsWith('::', i)) {
        i += 2;
    } else if (text[i] === ':') {
        i += 1;
    } else {
        while (i < end && /\s/.test(text[i])) {
            i++;
        }
    }
    return { name: match[0], isClosing, argsStart: i };
}

/**
 * Splits an argument region on `::` that sits outside nested `{{ }}`.
 *
 * @returns {{start: number, end: number}[]} Absolute spans, end exclusive.
 */
function topLevelArgSpans(text, start, end) {
    const spans = [];
    let depth = 0;
    let cursor = start;
    for (let i = start; i < end; i++) {
        if (text.startsWith('{{', i)) {
            depth++;
            i++;
        } else if (text.startsWith('}}', i)) {
            depth = Math.max(0, depth - 1);
            i++;
        } else if (depth === 0 && text.startsWith('::', i)) {
            spans.push({ start: cursor, end: i });
            i++;
            cursor = i + 1;
        }
    }
    spans.push({ start: cursor, end });
    return spans;
}

/**
 * Every {{if}} condition span in the text that needs wrapping, innermost last.
 * Walks into macro arguments so a nested {{if}} inside another macro is found.
 */
function collectConditionSpans(text, from, to, out) {
    let i = from;
    while (i < to) {
        const open = text.indexOf('{{', i);
        if (open === -1 || open >= to) {
            return;
        }
        const end = findMacroEnd(text, open);
        if (end === -1 || end > to) {
            return;
        }
        // parseMacroHead returns null for `{{// …}}` comments, whose text is not
        // arguments, so those are skipped along with anything else unparseable.
        const head = parseMacroHead(text, open, end);
        if (head && !head.isClosing) {
            const argsEnd = end - 2;
            if (head.argsStart <= argsEnd) {
                const args = topLevelArgSpans(text, head.argsStart, argsEnd);
                let wrapped = false;
                if (head.name.toLowerCase() === 'if' && args.length) {
                    const condition = text.slice(args[0].start, args[0].end);
                    if (hasExpressionOperator(condition)) {
                        out.push(args[0]);
                        wrapped = true;
                    }
                }
                // Recorded spans are spliced whole, so never descend into one —
                // a nested hit would leave the outer span's offsets stale. The
                // cost is that an {{if}} written inside another {{if}}'s
                // condition keeps host truthiness; bodies are unaffected,
                // because they sit outside the braces and are walked above.
                for (const span of args.slice(wrapped ? 1 : 0)) {
                    collectConditionSpans(text, span.start, span.end, out);
                }
            }
        }
        i = end;
    }
}

/**
 * Splits on a top-level operator: outside quotes, outside nested `{{ }}`, and
 * outside brackets. Returns a single-element array when the operator is absent.
 */
function splitTopLevel(text, operator) {
    const parts = [];
    let depth = 0;
    let parens = 0;
    let quote = null;
    let cursor = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === '\'') {
            quote = ch;
        } else if (text.startsWith('{{', i)) {
            depth++;
            i++;
        } else if (text.startsWith('}}', i)) {
            depth = Math.max(0, depth - 1);
            i++;
        } else if (depth === 0 && ch === '(') {
            parens++;
        } else if (depth === 0 && ch === ')') {
            parens = Math.max(0, parens - 1);
        } else if (depth === 0 && parens === 0 && text.startsWith(operator, i)) {
            parts.push(text.slice(cursor, i));
            i += operator.length - 1;
            cursor = i + 1;
        }
    }
    parts.push(text.slice(cursor));
    return parts;
}

/** True when `(` at index 0 is closed by the very last character. */
function isFullyBracketed(text) {
    if (!text.startsWith('(') || !text.endsWith(')')) {
        return false;
    }
    let parens = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '(') {
            parens++;
        } else if (text[i] === ')') {
            parens--;
            if (parens === 0) {
                return i === text.length - 1;
            }
        }
    }
    return false;
}

/** A `|` outside nested `{{ }}`, which the engine would read as a filter. */
function hasTopLevelPipe(text) {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.startsWith('{{', i)) {
            depth++;
            i++;
        } else if (text.startsWith('}}', i)) {
            depth = Math.max(0, depth - 1);
            i++;
        } else if (depth === 0 && text[i] === '|') {
            return true;
        }
    }
    return false;
}

/**
 * Turns a condition into macros the engine can actually lex.
 *
 * `||` cannot survive as text inside a macro argument. the lexer treats `|` as
 * the start of an output filter, and the whole macro fails to parse. So OR is
 * decomposed into the {{or}} macro, whose arguments are separated by `::`
 * instead. `&&`, brackets and comparisons all lex fine and stay inside {{expr}},
 * which under compat mode reads each {{or}} argument as an expression too.
 *
 * @returns {string|null} null when the condition cannot be expressed.
 */
function buildCondition(condition, names) {
    const text = String(condition).trim();
    if (!text) {
        return null;
    }

    // Loosest operator first, so precedence survives the decomposition.
    for (const [operator, macro] of [['||', names.or], ['&&', names.and]]) {
        const split = splitTopLevel(text, operator);
        if (split.length > 1) {
            if (!macro) {
                return null;
            }
            const parts = split.map(part => buildCondition(part, names));
            return parts.some(part => part === null)
                ? null
                : `{{${macro}::${parts.join('::')}}}`;
        }
    }

    if (isFullyBracketed(text)) {
        return buildCondition(text.slice(1, -1), names);
    }

    if (text.startsWith('!') && text[1] !== '=') {
        const inner = buildCondition(text.slice(1), names);
        return inner && names.not ? `{{${names.not}::${inner}}}` : null;
    }

    // What is left is a comparison or a bare value. A `|` still in it is a real
    // output filter, or a pipe inside quotes -- the lexer does not treat quotes
    // as string delimiters, so either way it would break the macro. Refuse
    // rather than emit something unparseable.
    return hasTopLevelPipe(text) ? null : `{{${names.expr}::${text}}}`;
}

/**
 * Rewrites every infix {{if}} condition into macros that evaluate it.
 *
 * @param {string} text
 * @param {{expr: string, or: string|null, and: string|null, not: string|null}} names - The names
 *        those macros actually registered under, which safeRegister may have
 *        remapped on a collision.
 * @param {(message: string) => void} [onSkip] - Called for a condition that
 *        cannot be expressed, which is then left exactly as it was.
 * @returns {string}
 */
export function rewriteIfConditions(text, names, onSkip = () => {}) {
    const source = String(text ?? '');
    if (!source.includes('{{')) {
        return source;
    }
    const resolved = typeof names === 'string'
        ? { expr: names, or: 'or', and: 'and', not: 'not' }
        : names;
    const spans = [];
    collectConditionSpans(source, 0, source.length, spans);
    if (!spans.length) {
        return source;
    }
    // Splice from the end so earlier spans keep their offsets.
    spans.sort((a, b) => b.start - a.start);
    let result = source;
    for (const span of spans) {
        const condition = result.slice(span.start, span.end);
        const replacement = buildCondition(condition, resolved);
        if (replacement === null) {
            onSkip(condition);
            continue;
        }
        result = `${result.slice(0, span.start)}${replacement}${result.slice(span.end)}`;
    }
    return result;
}
