/**
 * One small display tokenizer for readable macro type. It never rewrites the
 * text: every character is still selectable and copyable. Braces and separators
 * become punctuation spans, macro names are bold, arguments are italic, and an
 * optional argument keeps its square brackets.
 */
import { el } from '../dom.js';

/** Index just past the `}}` that closes a macro starting at `start`, or -1. */
function findMacroEnd(text, start) {
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

function pushText(tokens, text) {
    if (text) {
        tokens.push({ kind: 'text', text });
    }
}

/** Split an argument region on top-level `::`, leaving nested macros intact. */
export function splitMacroArgs(inner) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < inner.length; i++) {
        if (inner.startsWith('{{', i)) {
            depth++;
            i++;
        } else if (inner.startsWith('}}', i)) {
            depth = Math.max(0, depth - 1);
            i++;
        } else if (depth === 0 && inner.startsWith('::', i)) {
            parts.push(inner.slice(start, i));
            i++;
            start = i + 1;
        }
    }
    parts.push(inner.slice(start));
    return parts;
}

function tokenizeArgument(text, tokens) {
    const optional = /^(\s*)\[([\s\S]*)\]\s*$/.exec(text);
    if (optional) {
        pushText(tokens, optional[1]);
        tokens.push({ kind: 'punct', text: '[' });
        if (optional[2].includes('{{')) {
            tokenizeInto(optional[2], tokens);
        } else {
            tokens.push({ kind: 'opt', text: optional[2] });
        }
        tokens.push({ kind: 'punct', text: ']' });
        return;
    }
    if (text.includes('{{')) {
        tokenizeInto(text, tokens);
        return;
    }
    tokens.push({ kind: 'arg', text });
}

function tokenizeInner(inner, tokens) {
    if (inner.startsWith('//')) {
        pushText(tokens, inner);
        return;
    }
    const head = /^([!?~#>/\s]*)([A-Za-z][\w-]*)([\s\S]*)$/.exec(inner);
    if (!head) {
        pushText(tokens, inner);
        return;
    }
    if (head[1]) {
        // Block slashes, flags and leading whitespace read as punctuation.
        tokens.push({ kind: 'punct', text: head[1] });
    }
    tokens.push({ kind: 'name', text: head[2] });
    const rest = head[3];
    if (!rest) {
        return;
    }
    const separatorsStart = rest.startsWith('::');
    const args = splitMacroArgs(separatorsStart ? rest.slice(2) : rest);
    if (separatorsStart) {
        tokens.push({ kind: 'punct', text: '::' });
    }
    args.forEach((part, index) => {
        if (index > 0) {
            tokens.push({ kind: 'punct', text: '::' });
        }
        tokenizeArgument(part, tokens);
    });
}

function tokenizeInto(input, tokens) {
    const text = String(input ?? '');
    let cursor = 0;
    let buffer = '';
    while (cursor < text.length) {
        if (text.startsWith('{{', cursor)) {
            const end = findMacroEnd(text, cursor);
            if (end < 0) {
                buffer += text.slice(cursor);
                break;
            }
            pushText(tokens, buffer);
            buffer = '';
            tokens.push({ kind: 'punct', text: '{{' });
            tokenizeInner(text.slice(cursor + 2, end - 2), tokens);
            tokens.push({ kind: 'punct', text: '}}' });
            cursor = end;
            continue;
        }
        buffer += text[cursor];
        cursor++;
    }
    pushText(tokens, buffer);
}

/**
 * @param {string} input
 * @returns {{kind: 'text'|'punct'|'name'|'arg'|'opt', text: string}[]}
 */
export function tokenizeMacroText(input) {
    const tokens = [];
    tokenizeInto(input, tokens);
    return tokens;
}

/**
 * Renders macro-readable text as real DOM text with styling spans.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.tag]
 * @param {string} [options.className]
 * @returns {HTMLElement}
 */
export function renderMacroText(text, { tag = 'code', className = 'me-mt' } = {}) {
    const node = el(tag, className);
    for (const token of tokenizeMacroText(text)) {
        if (token.kind === 'text') {
            node.appendChild(document.createTextNode(token.text));
        } else {
            node.appendChild(el('span', `me-mt-${token.kind}`, token.text));
        }
    }
    return node;
}
