/**
 * Macro problems for a piece of saved text, found without the macro engine.
 *
 * This module is deliberately dependency-free: it does not import the app, the
 * parser or the registry, so the caller passes the live macro names in. It is
 * pure, runs under Jest directly, and may later be imported by the server.
 */

const NAME_PREFIX = /^[!?~>#/]*\s*/;
const MACRO_NAME = /^[A-Za-z_][\w-]*/;
const SCOPED_NAME = /^([#/])([A-Za-z_][\w-]*)/;

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

function macroName(body) {
    const value = String(body ?? '');
    const prefix = NAME_PREFIX.exec(value)?.[0] ?? '';
    const name = MACRO_NAME.exec(value.slice(prefix.length))?.[0] ?? '';
    return { name, prefix };
}

/**
 * Finds macro problems in saved text.
 * @param {string} text Saved text, macros unfilled
 * @param {{knownNames?: Iterable<string>}} options Known macro names from the live registry
 * @returns {{rule: string, severity: 'error'|'warning'|'info', target: object, message: string, details?: string}[]}
 */
export function scanMacroProblems(text, { knownNames = [] } = {}) {
    const source = String(text ?? '');
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
    if (source.includes('{{///}}')) {
        findings.push({
            rule: 'macro-scoped-comment',
            severity: 'warning',
            target: {},
            message: 'Scoped comments such as {{//}}text{{///}} do not work in Neconyan. Use {{//}} on its own to hide a comment.',
        });
    }

    const known = new Set([...knownNames].map(name => String(name).toLowerCase()));
    const scope = [];
    for (const token of tokens) {
        const body = token.body.trim();
        // The raw comment macro and its closing form are handled above.
        if (!body || body.startsWith('//')) continue;
        const scoped = SCOPED_NAME.exec(body);
        if (scoped) {
            const [, marker, name] = scoped;
            if (marker === '#') {
                scope.push(name.toLowerCase());
            } else if (scope.length && scope.at(-1) === name.toLowerCase()) {
                scope.pop();
            } else {
                findings.push({
                    rule: 'macro-unmatched-close',
                    severity: 'warning',
                    target: {},
                    message: `{{/${name}}} has no matching opening macro.`,
                });
            }
            continue;
        }
        const { name } = macroName(body);
        if (!name || name.startsWith('.') || name.startsWith('$')) continue;
        if (known.size && !known.has(name.toLowerCase())) {
            findings.push({
                rule: 'macro-unknown',
                severity: 'warning',
                target: {},
                message: `Unknown macro {{${name}}}. Neconyan leaves it as raw text.`,
                details: name,
            });
        }
    }
    for (const name of scope) {
        findings.push({
            rule: 'macro-unclosed-scope',
            severity: 'error',
            target: {},
            message: `{{#${name}}} has no matching {{/${name}}}.`,
        });
    }
    return findings;
}

/** The macro names in saved text, without judgement. Used by the caller's retry. */
export function macroNames(text) {
    return scanBraces(String(text ?? '')).tokens
        .map(token => macroName(token.body.trim()).name)
        .filter(Boolean);
}
