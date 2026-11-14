import { MacroEngine } from '../../public/scripts/macros/engine/MacroEngine.js';
import { MacroRegistry } from '../../public/scripts/macros/engine/MacroRegistry.js';
import { normalizeExtensionBootId } from '../../public/scripts/extension-boot-lifecycle/index.js';
import { registerUtilityMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/utility-macros.js';
import { registerStateMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/state-macros.js';
import { registerLogicMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/logic-macros.js';
import { registerChatVarMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/chatvar-macros.js';
import { registerDateMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/date-macros.js';
import { registerPronounMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/pronoun-macros.js';
import { registerCompatMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/compat-macros.js';
import { RESERVED_NAMES } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/registration.js';
import { rewriteIfConditions } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/compat-impl.js';
import { rewriteMacros } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/import-fixes-impl.js';

/** Only the selected persona/card settings belong to an operation's snapshot. */
export function captureEnhancedMacros(settings, character = {}, { personaAvatar = settings.user_avatar, group = false } = {}) {
    const extensions = settings.extension_settings ?? {};
    const enhanced = extensions.MacroEnhanced ?? {};
    return {
        enabled: Boolean(settings.power_user?.experimental_macro_engine)
            && !extensions.disabledExtensions?.some(name => normalizeExtensionBootId(name) === 'macroenhanced'),
        pronouns: { user: String(enhanced.pronouns?.personas?.[personaAvatar] ?? ''),
            char: group ? '' : String(character.MacroEnhanced?.pronouns ?? '') },
        syntax: { compatExpressions: Boolean(enhanced.compatExpressions), fixImportedSyntax: Boolean(enhanced.fixImportedSyntax) },
    };
}

let definitions;
/** Reuse the browser handlers, with request-local host capabilities rather than browser globals. */
export function enhancedMacroDefinitions() {
    if (definitions) return definitions;
    definitions = Object.create(null);
    const register = (name, options) => {
        name = name.toLowerCase();
        const target = MacroRegistry.hasMacro(name) || RESERVED_NAMES.includes(name) ? `me-${name}` : name;
        for (const alias of [target, `me-${name}`, ...(options.aliases ?? []).map(item => item.alias.toLowerCase())]) {
            if (!MacroRegistry.hasMacro(alias)) definitions[alias] = { ...options, aliases: [] };
        }
        return target;
    };
    for (const install of [registerUtilityMacros, registerStateMacros, registerLogicMacros, registerChatVarMacros,
        registerDateMacros, registerPronounMacros, registerCompatMacros]) install(register);
    // The browser uses these same priorities. Settings come from the environment,
    // so nested resolutions and concurrent accounts never share a toggle.
    MacroEngine.addPreProcessor((text, env) => env.extra.meSyntax?.fixImportedSyntax ? rewriteMacros(text) : text,
        { priority: 25, source: 'server:macro-enhanced-imports' });
    MacroEngine.addPreProcessor((text, env) => env.extra.meSyntax?.compatExpressions
        ? rewriteIfConditions(text, { expr: 'me-expr', and: 'me-and', or: 'me-or', not: 'me-not' }) : text,
    { priority: 30, source: 'server:macro-enhanced-expressions' });
    MacroEngine.addPreProcessor((text, env) => {
        env.extra.assertMacroVocabulary?.(text, env.dynamicMacros);
        return text;
    }, { priority: 35, source: 'server:macro-vocabulary' });
    return definitions;
}
