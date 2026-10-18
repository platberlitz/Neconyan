import { MODULE_NAME, getSettings, saveSettings } from '../settings.js';
import { FALLBACK_PREFIX, RESERVED_NAMES } from '../registration.js';
import { getChatState, peekChatState, touchChatState } from '../chat-state.js';
import { notifyMacroDataChanged } from '../data-events.js';
import {
    getBrowserDefs as readBrowserDefs,
    getBrowserStoreProblem,
    writeBrowserDefs,
} from './browser-store.js';

// Mirrors MACRO_IDENTIFIER_PATTERN in the engine's MacroLexer.js (not imported to
// avoid deep imports into Neconyan internals).
export const NAME_PATTERN = /^[a-zA-Z][\w-]*$/;

export const SCOPE_GLOBAL = 'global';
export const SCOPE_BROWSER = 'browser';
export const SCOPE_CHARACTER = 'character';
export const SCOPE_CHAT = 'chat';

/**
 * @typedef {object} CustomMacroDef
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} template
 * @property {{name: string, optional?: boolean, defaultValue?: string, description?: string}[]} args
 * @property {boolean} enabled
 */

export function createDef(partial = {}) {
    const ctx = SillyTavern.getContext();
    return {
        id: partial.id ?? ctx.uuidv4(),
        name: partial.name ?? '',
        description: partial.description ?? '',
        template: partial.template ?? '',
        args: Array.isArray(partial.args) ? partial.args : [],
        enabled: partial.enabled !== false,
    };
}

/**
 * Validates a definition against the engine's naming rules and current registry state.
 *
 * @param {CustomMacroDef} def
 * @param {object} options
 * @param {CustomMacroDef[]} options.siblings - Other defs in the same scope (for uniqueness).
 * @param {object|null} options.registry - Engine registry, to refuse names owned by others.
 * @param {string[]} options.customNames - Lowercased names of custom defs in every scope.
 *        A registry entry we own is only acceptable when it is one of these (an edit of
 *        this def, or the more-specific-scope case). otherwise it is a built-in macro
 *        of this extension and taking the name would clobber it.
 * @returns {string[]} Human-readable problems; empty when valid.
 */
export function validateDef(def, { siblings = [], registry = null, customNames = [] } = {}) {
    const problems = [];
    const name = String(def.name ?? '').trim();

    if (!name) {
        problems.push('Give the macro a name.');
    } else if (!NAME_PATTERN.test(name)) {
        problems.push('Names must start with a letter and only use letters, numbers, hyphens and underscores.');
    } else if (RESERVED_NAMES.includes(name.toLowerCase())) {
        problems.push(`"${name}" is reserved for a future Neconyan update. Pick another name.`);
    } else if (name.toLowerCase().startsWith(FALLBACK_PREFIX)) {
        problems.push(`Names starting with "${FALLBACK_PREFIX}" are reserved for collision-proof aliases. Pick another name.`);
    }

    if (name && siblings.some(other => other.id !== def.id && String(other.name).toLowerCase() === name.toLowerCase())) {
        problems.push(`You already have a macro named "${name}" in this scope.`);
    }

    if (name && registry?.hasMacro?.(name)) {
        const owner = registry.getMacro(name)?.source?.name ?? '';
        if (String(owner).toLowerCase() !== MODULE_NAME.toLowerCase()) {
            problems.push(`"${name}" already exists (${owner || 'built-in'}). Pick another name.`);
        } else if (!customNames.includes(name.toLowerCase())) {
            problems.push(`"${name}" is one of Macro Enhanced's built-in macros. Pick another name.`);
        }
    }

    if (!String(def.template ?? '').trim()) {
        problems.push('The template (what the macro expands to) cannot be empty.');
    }

    const argNames = new Set();
    for (const arg of def.args ?? []) {
        const argName = String(arg.name ?? '').trim();
        if (!NAME_PATTERN.test(argName)) {
            problems.push(`Argument name "${argName}" is invalid. Start with a letter, then use letters, numbers, hyphens or underscores.`);
        }
        if (argNames.has(argName.toLowerCase())) {
            problems.push(`Duplicate argument name "${argName}".`);
        }
        argNames.add(argName.toLowerCase());
    }
    // The engine requires optional args to be a contiguous suffix.
    let sawOptional = false;
    for (const arg of def.args ?? []) {
        if (arg.optional) {
            sawOptional = true;
        } else if (sawOptional) {
            problems.push('Optional arguments must come after all required ones.');
            break;
        }
    }

    return problems;
}

/** Lowercased names of every custom def in all scopes, for validateDef's customNames. */
export function getAllCustomNames() {
    return [...getGlobalDefs(), ...safeBrowserDefs(), ...getCharacterDefs(), ...getChatDefs()]
        .map(def => String(def.name ?? '').toLowerCase())
        .filter(Boolean);
}

function safeBrowserDefs() {
    try {
        return readBrowserDefs();
    } catch (error) {
        // A blocked or absent localStorage is an expected state on some hosts;
        // the My macros panel and save errors say so in plain language.
        if (error?.code !== 'BROWSER_MACRO_STORAGE') {
            console.warn('[Macro Enhanced] Browser macros could not be read.', error);
        }
        return [];
    }
}

// ---------- persistence ----------

/** Browser macros are read from this browser's localStorage for the signed-in account. */
export function getBrowserDefs(options = {}) {
    return readBrowserDefs(options);
}

/** Browser macros are saved only in this browser's localStorage for the signed-in account. */
export function saveBrowserDefs(defs, options = {}) {
    writeBrowserDefs(defs, options);
    notifyMacroDataChanged('macros');
}

export { getBrowserStoreProblem };

/** The stored list for a scope. Callers that write should use saveDefsForScope. */
export function getDefsForScope(scope) {
    if (scope === SCOPE_BROWSER) {
        return getBrowserDefs();
    }
    if (scope === SCOPE_CHARACTER) {
        return getCharacterDefs();
    }
    if (scope === SCOPE_CHAT) {
        return getChatDefs();
    }
    return getGlobalDefs();
}

/**
 * Persists a scope through its one storage path. Character cards save
 * asynchronously; the other scopes settle during the call.
 *
 * @param {string} scope
 * @param {CustomMacroDef[]} defs
 * @param {object} [options] - storage and account injection for browser tests.
 * @returns {Promise<void>}
 */
export async function saveDefsForScope(scope, defs, options = {}) {
    if (scope === SCOPE_BROWSER) {
        saveBrowserDefs(defs, options);
        return;
    }
    if (scope === SCOPE_CHARACTER) {
        await saveCharacterDefs(defs);
        return;
    }
    if (scope === SCOPE_CHAT) {
        saveChatDefs(defs);
        return;
    }
    if (scope === SCOPE_GLOBAL) {
        saveGlobalDefs(defs);
        return;
    }
    throw new Error(`Unknown macro scope "${scope}".`);
}

export function getGlobalDefs() {
    return getSettings().customMacros;
}

export function saveGlobalDefs(defs) {
    getSettings().customMacros = defs;
    saveSettings();
    notifyMacroDataChanged('macros');
}

export function getCharacterDefs() {
    const ctx = SillyTavern.getContext();
    if (ctx.groupId) {
        return [];
    }
    const character = ctx.characters?.[ctx.characterId];
    const defs = character?.data?.extensions?.[MODULE_NAME]?.customMacros;
    return Array.isArray(defs) ? defs : [];
}

export async function saveCharacterDefs(defs) {
    const ctx = SillyTavern.getContext();
    if (ctx.groupId) {
        throw new Error('Group chats have no single character card to save a macro on.');
    }
    if (ctx.characterId === undefined || ctx.characterId === null) {
        throw new Error('No character selected.');
    }
    const existing = ctx.characters?.[ctx.characterId]?.data?.extensions?.[MODULE_NAME] ?? {};
    await ctx.writeExtensionField(ctx.characterId, MODULE_NAME, { ...existing, customMacros: defs });
    notifyMacroDataChanged('macros');
}

export function getChatDefs() {
    return peekChatState()?.customMacros ?? [];
}

/** Synchronous, unlike the character scope. Chat metadata saves in the background. */
export function saveChatDefs(defs) {
    const state = getChatState();
    if (!state) {
        throw new Error('No chat is loaded.');
    }
    state.customMacros = defs;
    touchChatState('macros');
}

/**
 * The definitions that should currently be registered: enabled globals, then
 * this browser's defs, then character defs, then chat defs. The most specific
 * scope wins a shared name.
 *
 * @returns {{def: CustomMacroDef, scope: string}[]}
 */
export function getEffectiveDefs() {
    const byName = new Map();
    const layers = [
        [getGlobalDefs(), SCOPE_GLOBAL],
        [safeBrowserDefs(), SCOPE_BROWSER],
        [getCharacterDefs(), SCOPE_CHARACTER],
        [getChatDefs(), SCOPE_CHAT],
    ];
    for (const [defs, scope] of layers) {
        for (const def of defs) {
            if (def.enabled && def.name) {
                byName.set(def.name.toLowerCase(), { def, scope });
            }
        }
    }
    return [...byName.values()];
}
