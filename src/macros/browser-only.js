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
