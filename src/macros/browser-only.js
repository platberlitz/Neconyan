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

export function assertServerMacroVocabulary(content, dynamicMacros, customNames = [], syntax = {}) {
    if (typeof content !== 'string' || !content.includes('{{')) return;
    if (syntax.fixImportedSyntax && rewriteMacros(content) !== content
        || syntax.compatExpressions && rewriteIfConditions(content, 'expr') !== content) {
        throw Object.assign(new Error('This prompt uses a browser-only Macro Enhanced syntax setting. Rewrite it using supported core macros before sending a server prompt.'),
            { status: 409, code: 'MACRO_BROWSER_ONLY' });
    }
    const comments = [];
    for (const token of MacroLexer.tokenize(content).tokens) {
        if (token.tokenType.name === 'Macro.Start') comments.push(comments.at(-1) ?? false);
        if (token.tokenType.name === 'Macro.DoubleSlash') comments[comments.length - 1] = true;
        if (token.tokenType.name === 'Macro.End') comments.pop();
        if (comments.at(-1)) continue;
        if (!['Macro.Identifier', 'Filter.Identifier'].includes(token.tokenType.name)) continue;
        const name = token.image.toLowerCase();
        if (Object.hasOwn(dynamicMacros, name) || MacroRegistry.hasMacro(name)) continue;
        if (names.has(name) || customNames.includes(name)) {
            throw Object.assign(new Error(`The {{${name}}} macro is browser-only in Macro Enhanced and cannot run in a server prompt. Remove it or use a supported core macro.`),
                { status: 409, code: 'MACRO_BROWSER_ONLY' });
        }
    }
}
