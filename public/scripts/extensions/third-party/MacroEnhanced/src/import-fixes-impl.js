/**
 * Rewrites for the macro spellings Neconyan's grammar cannot express.
 *
 * Content written for other chat apps reaches the engine with syntax its lexer
 * has no token for. It does not error. it is handed back as literal text, so a
 * card appears to work while quietly printing `{{@name}}` at the model.
 *
 *   {{@name}}                 `@` is not one of the host's sigils (! ? ~ # / >),
 *                             so this never lexes at all.
 *   {{!setvar name value}}    `!` is parsed but documented as not implemented,
 *                             and space-separated arguments arrive as ONE
 *                             argument, so the call fails arity either way.
 *   {{split::x:: ::0}}        WhiteSpace is Lexer.SKIPPED inside arguments, so a
 *                             lone space produces no token and the separator
 *                             arrives empty.
 *
 * None of these can be fixed by registering a macro. they fail before the
 * registry is consulted. which is why this ships as a pre-processor
 * (src/import-fixes.js) and as the offline converter (scripts/convert-import.js).
 * Both call rewriteMacros().
 *
 * Every rewrite here must be IDEMPOTENT. The engine re-enters evaluate() for
 * nested content, so a pre-processor runs again over its own output; a rewrite
 * that changed its result on a second pass would corrupt nested macros. Each one
 * below leaves no trace of its own trigger pattern behind, and the tests assert
 * it.
 *
 * No Neconyan imports; directly testable under `node --test`.
 */
import { findMacroEnd } from './compat-impl.js';

/** `{{@foo}}` -> `{{getchatvar::foo}}`. */
export function rewriteAtShorthand(text) {
    return String(text ?? '').replace(/\{\{@([\w.:-]+)\}\}/g, '{{getchatvar::$1}}');
}

/**
 * `{{!setvar name value}}` -> the value's own macros, or a proper {{setvar}}.
 *
 * The form exists only to run a side effect and swallow whatever it printed.
 * Since every setter here already returns nothing, a wrapper whose variable is
 * never read collapses to just its value.
 */
export function rewriteBangSetvar(text) {
    const source = String(text ?? '');
    let out = '';
    let i = 0;
    while (i < source.length) {
        const open = source.indexOf('{{!setvar ', i);
        if (open === -1) {
            out += source.slice(i);
            break;
        }
        const end = findMacroEnd(source, open);
        if (end === -1) {
            out += source.slice(i);
            break;
        }
        out += source.slice(i, open);
        const inner = source.slice(open + '{{!setvar '.length, end - 2).trim();
        const space = inner.search(/\s/);
        const name = space === -1 ? inner : inner.slice(0, space);
        const value = space === -1 ? '' : inner.slice(space + 1).trim();
        // `_dummy` is the throwaway name the pattern uses when it only wants the
        // side effect; anything else is a variable the content really reads back.
        out += name.startsWith('_') ? value : `{{setvar::${name}::${value}}}`;
        i = end;
    }
    return out;
}

/**
 * A single-space argument (`::` space `::`) becomes `{{space}}`.
 *
 * The lexer discards whitespace between argument separators, so the space never
 * reaches the macro. {{split}} and {{wrap}} resolve their own arguments, which
 * lets an explicit {{space}} through where a literal one cannot survive.
 */
export function rewriteSpaceArgs(text) {
    return String(text ?? '').replace(/::[ \t]+(?=::|\}\})/g, '::{{space}}');
}

/**
 * Every rewrite, in the order they compose.
 *
 * ponytail: `||` is not here. A `|` opens an output filter, so `{{or::a||b}}`
 * fails to lex and no textual substitution is safe in the general case. the
 * pipe may be a filter the author meant. Compat mode already decomposes it to
 * {{or::a::b}} inside {{if}}/{{and}}/{{or}} conditions, where the intent is
 * unambiguous, and refuses rather than guessing elsewhere. Extend that instead
 * of adding a fourth rewrite here.
 */
export function rewriteMacros(text) {
    return rewriteSpaceArgs(rewriteBangSetvar(rewriteAtShorthand(text)));
}
