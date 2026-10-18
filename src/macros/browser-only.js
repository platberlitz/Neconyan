import { MacroLexer } from '../../public/scripts/macros/engine/MacroLexer.js';
import { MacroRegistry } from '../../public/scripts/macros/engine/MacroRegistry.js';
import { registerUtilityMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/utility-macros.js';
import { registerStateMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/state-macros.js';
import { registerLogicMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/logic-macros.js';
import { registerChatVarMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/chatvar-macros.js';
import { registerDateMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/date-macros.js';
import { registerLorebookMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/lorebook-macros.js';
import { registerPronounMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/pronoun-macros.js';
import { registerCompatMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/compat-macros.js';
import { rewriteIfConditions } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/compat-impl.js';
import { rewriteMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/import-fixes-impl.js';

// Read the extension's actual definitions without registering browser handlers or
// accessing a browser account. New definitions automatically join this boundary.
const names = new Set();
for (const register of [registerUtilityMacros, registerStateMacros, registerLogicMacros, registerChatVarMacros,
    registerDateMacros, registerLorebookMacros, registerPronounMacros, registerCompatMacros]) {
    register((name, options) => {
        for (const value of [name, `me-${name}`, ...(options.aliases ?? []).map(item => item.alias)]) names.add(value.toLowerCase());
        return name;
    });
}

/** Custom definitions stay request-local; never install one account's names globally. */
export function capturedBrowserMacros(settings, character, metadata) {
    return [...new Set([settings, character, metadata].flatMap(value => {
        const definitions = value?.MacroEnhanced?.customMacros;
        return (Array.isArray(definitions) ? definitions : [])
            .filter(item => item?.enabled !== false && typeof item?.name === 'string')
            .flatMap(item => [item.name.toLowerCase(), `me-${item.name.toLowerCase()}`]);
    }))];
}

/** The engine's macro identifier shape, and a bound for names the page hands over. */
export const MAX_BROWSER_MACRO_NAME_LENGTH = 512;
export const MAX_BROWSER_MACROS = 512;
const BROWSER_MACRO_NAME = /^[a-zA-Z][\w-]*$/;

/**
 * The optional browser-local names a page sends with a workflow. Only names
 * travel: an entry's template never leaves the browser. Values are trimmed and
 * lower-cased because the refusal boundary compares lower-cased macro names,
 * then deduplicated case-insensitively. Null means the field is malformed.
 */
export function normalizeBrowserMacroNames(value) {
    if (!Array.isArray(value) || value.length > MAX_BROWSER_MACROS) return null;
    const names = [];
    const seen = new Set();
    for (const item of value) {
        const name = typeof item === 'string' ? item.trim().toLowerCase() : '';
        if (!name || name.length > MAX_BROWSER_MACRO_NAME_LENGTH || !BROWSER_MACRO_NAME.test(name)) return null;
        if (seen.has(name)) continue;
        seen.add(name);
        names.push(name);
    }
    return names;
}

/** Add page-local names to the vocabulary the server already reads from saved data. */
export function mergeBrowserMacros(captured, submitted) {
    if (!submitted?.length) return captured;
    const merged = [...captured];
    const seen = new Set(captured.map(name => name.toLowerCase()));
    for (const item of submitted) {
        const name = String(item).trim().toLowerCase();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        merged.push(name);
    }
    return merged;
}

// Macros a loaded page extension delivers: they resolve only when the page
// captured their text with the reply. Only a Roleplay execution snapshot that
// opts in refuses a missing capture; elsewhere they stay literal, as any unknown
// macro does.
export const BUNDLED_MACROS = new Set(['dialoguecolors']);

export function bundledMacroMissingError(name) {
    return Object.assign(new Error(`The {{${name}}} macro is delivered by the Dialogue Colors extension, and this saved reply was accepted without its captured instruction. Reload the page and send the message again.`),
        { status: 409, code: 'MACRO_BUNDLED_MISSING' });
}

/** Macro and filter names used outside {{// comments}}, lower-cased, in source order. */
export function* serverMacroNames(content) {
    if (typeof content !== 'string' || !content.includes('{{')) return;
    const comments = [];
    for (const token of MacroLexer.tokenize(content).tokens) {
        if (token.tokenType.name === 'Macro.Start') comments.push(comments.at(-1) ?? false);
        if (token.tokenType.name === 'Macro.DoubleSlash') comments[comments.length - 1] = true;
        if (token.tokenType.name === 'Macro.End') comments.pop();
        if (comments.at(-1)) continue;
        if (!['Macro.Identifier', 'Filter.Identifier'].includes(token.tokenType.name)) continue;
        yield token.image.toLowerCase();
    }
}

export function assertServerMacroVocabulary(content, dynamicMacros, customNames = [], syntax = {}, { requireBundled = false } = {}) {
    if (typeof content !== 'string' || !content.includes('{{')) return;
    if (syntax.fixImportedSyntax && rewriteMacros(content) !== content
        || syntax.compatExpressions && rewriteIfConditions(content, 'expr') !== content) {
        throw Object.assign(new Error('This prompt uses a browser-only Macro Enhanced syntax setting. Rewrite it using supported core macros before sending a server prompt.'),
            { status: 409, code: 'MACRO_BROWSER_ONLY' });
    }
    for (const name of serverMacroNames(content)) {
        if (Object.hasOwn(dynamicMacros, name) || MacroRegistry.hasMacro(name)) continue;
        if (requireBundled && BUNDLED_MACROS.has(name)) throw bundledMacroMissingError(name);
        if (names.has(name) || customNames.includes(name)) {
            throw Object.assign(new Error(`The {{${name}}} macro is browser-only in Macro Enhanced and cannot run in a server prompt. Remove it or use a supported core macro.`),
                { status: 409, code: 'MACRO_BROWSER_ONLY' });
        }
    }
}
