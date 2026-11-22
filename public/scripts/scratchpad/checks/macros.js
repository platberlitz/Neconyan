/**
 * Macro problems for a piece of saved text, found without the macro engine.
 *
 * This module is deliberately dependency-free: it does not import the app, the
 * parser or the registry, so the caller passes the live macro names in. It is
 * pure, runs under Jest directly, and may later be imported by the server.
 */

import { stripScopedComments } from '../../prompt-token-counts.js';

// Flags precede the identifier and may be spaced out, as in `{{ ! user }}`.
const FLAGS = /^((?:\s*[!?~>#/])*)\s*/;
const MACRO_NAME = /^[A-Za-z_][\w-]*/;
// MacroEngine rewrites this legacy form before parsing, so it never reaches the registry.
const LEGACY_TIME = /^time_UTC[+-]\d+$/i;

/** A rough token stream of balanced {{...}} pairs plus any leftovers. */
function scanBraces(text) {
    const tokens = [];
    const stack = [];
    let extraClosers = 0;
    for (let index = 0; index < text.length; index++) {
        if (text.startsWith('{{', index)) {
            stack.push(index);
            index += 1;
            continue;
        }
        if (text.startsWith('}}', index) && stack.length) {
            const start = stack.pop();
            tokens.push({ start, end: index + 2, body: text.slice(start + 2, index) });
            index += 1;
            continue;
        }
        if (text.startsWith('}}', index)) {
            extraClosers++;
            index += 1;
        }
    }
    return { tokens: tokens.sort((a, b) => a.start - b.start), unclosed: stack, extraClosers };
}

function macroToken(body) {
    const value = String(body ?? '').trim();
    const flags = FLAGS.exec(value)?.[0] ?? '';
    const afterFlags = value.slice(flags.length);
    const name = LEGACY_TIME.exec(afterFlags)?.[0] ?? MACRO_NAME.exec(afterFlags)?.[0] ?? '';
    return { name, flags: flags.replace(/\s+/g, ''), closing: flags.includes('/') };
}

/**
 * Finds macro problems in saved text.
 * @param {string} text Saved text, macros unfilled
 * @param {{knownNames?: Iterable<string>}} options Known macro names from the live registry
 * @returns {{rule: string, severity: 'error'|'warning'|'info', target: object, message: string, details?: string}[]}
 */
export function scanMacroProblems(text, { knownNames = [] } = {}) {
    // Text inside a {{//}}...{{///}} block is hidden, so braces in it are not problems.
    const source = stripScopedComments(String(text ?? ''));
    if (!source.includes('{{')) return [];
    const findings = [];
    const { tokens, unclosed, extraClosers } = scanBraces(source);
    if (unclosed.length || extraClosers) {
        const example = unclosed.length ? source.slice(unclosed[0], unclosed[0] + 40) : '}}';
        findings.push({
            rule: 'macro-unbalanced',
            severity: 'error',
            target: {},
            message: 'A macro is missing its closing braces or has an extra closing pair.',
            details: example,
        });
    }

    const known = new Set([...knownNames].map(name => String(name).toLowerCase()));
    const open = [];
    const orphanClosers = [];
    for (const token of tokens) {
        const body = token.body.trim();
        // Inline comments and a stray {{///}} hide themselves and are never problems.
        if (!body || body.startsWith('//')) continue;
        const { name, closing } = macroToken(body);
        if (!name || name.startsWith('.') || name.startsWith('$')) continue;
        const lower = name.toLowerCase();
        if (closing) {
            // A closer matches the nearest earlier opener of the same name and
            // implicitly closes any openers nested inside it, case-insensitively.
            // This mirrors MacroCstWalker.findUnclosedScopes.
            const match = open.findLastIndex(entry => entry === lower);
            if (match === -1) orphanClosers.push(name);
            else open.splice(match);
            continue;
        }
        open.push(lower);
        if (known.size && !known.has(lower) && !LEGACY_TIME.test(name)) {
            findings.push({
                rule: 'macro-unknown',
                severity: 'warning',
                target: {},
                message: `Unknown macro {{${name}}}. Neconyan leaves it as raw text.`,
                details: name,
            });
        }
    }
    for (const name of orphanClosers) {
        findings.push({
            rule: 'macro-unmatched-close',
            severity: 'info',
            target: {},
            message: `{{/${name}}} has no matching opening macro. Neconyan leaves it as raw text.`,
        });
    }
    return findings;
}

/** The macro names in saved text, without judgement. Used by the caller's retry. */
export function macroNames(text) {
    return scanBraces(String(text ?? '')).tokens
        .map(token => macroToken(token.body).name)
        .filter(Boolean);
}
