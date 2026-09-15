import { MODULE_NAME } from './settings.js';
import { clearCatalog, forgetMacro, recordMacro } from './catalog.js';

export const FALLBACK_PREFIX = 'me-';

// Upstream SillyTavern has already claimed these in newer versions of the engine;
// the fork just hasn't synced yet. Never take them.
export const RESERVED_NAMES = Object.freeze([
    'setvarkey', 'getvarkey', 'setglobalvarkey', 'getglobalvarkey',
    'setvarindex', 'getvarindex', 'setglobalvarindex', 'getglobalvarindex',
]);

/** @type {Set<string>} registry entry names (primaries AND aliases) we own, lowercased */
const registeredNames = new Set();
/** @type {Map<string, {requested: string, actual: string}>} lowercased requested name -> remap, when the names differ */
const remaps = new Map();

function getRegistry() {
    try {
        return SillyTavern.getContext().macros?.registry ?? null;
    } catch {
        return null;
    }
}

function ownsEntry(registry, name) {
    const def = registry.getMacro?.(name);
    return !!def && String(def.source?.name ?? '').toLowerCase() === MODULE_NAME.toLowerCase();
}

/**
 * Registers a macro without ever clobbering someone else's. If the requested name is
 * taken by another source (or reserved for upstream), the macro is registered under
 * the `me-` prefixed fallback instead and the remap is recorded for the settings UI.
 *
 * Every macro registered under its plain name also gets a hidden `me-<name>` alias,
 * so prompts can opt into a collision-proof name from day one.
 *
 * @param {string} name - Desired macro name.
 * @param {object} options - MacroDefinitionOptions for the engine registry.
 * @returns {string|null} The name actually registered, or null if registration failed.
 */
export function safeRegister(name, options) {
    const registry = getRegistry();
    if (!registry) {
        return null;
    }

    const lower = name.toLowerCase();
    let targetName = name;

    const reserved = RESERVED_NAMES.includes(lower);
    const takenByOther = registry.hasMacro(name) && !ownsEntry(registry, name);

    if (reserved || takenByOther) {
        targetName = `${FALLBACK_PREFIX}${name}`;
        if (registry.hasMacro(targetName) && !ownsEntry(registry, targetName)) {
            console.warn(`[Macro Enhanced] Cannot register "{{${name}}}": both "${name}" and "${targetName}" are taken by other sources. Skipping.`);
            return null;
        }
        console.warn(`[Macro Enhanced] Macro name "${name}" is ${reserved ? 'reserved by upstream' : 'taken by another source'}; registering as "{{${targetName}}}" instead.`);
        remaps.set(lower, { requested: name, actual: targetName });
    }

    const aliases = [...(options.aliases ?? [])];
    const fallbackAlias = `${FALLBACK_PREFIX}${name}`;
    if (targetName === name && !lower.startsWith(FALLBACK_PREFIX)) {
        if (!registry.hasMacro(fallbackAlias) || ownsEntry(registry, fallbackAlias)) {
            aliases.push({ alias: fallbackAlias, visible: false });
        }
    }

    // Drop alias candidates someone else owns; never clobber.
    const safeAliases = aliases.filter(({ alias }) => !registry.hasMacro(alias) || ownsEntry(registry, alias));

    const definition = registry.registerMacro(targetName, { ...options, aliases: safeAliases });
    if (!definition) {
        remaps.delete(lower);
        return null;
    }

    registeredNames.add(targetName.toLowerCase());
    for (const { alias } of safeAliases) {
        registeredNames.add(alias.toLowerCase());
    }
    recordMacro({ requested: name, actual: targetName, options: { ...options, aliases: safeAliases } });
    return targetName;
}

/**
 * Unregisters a single macro we own, including its hidden fallback alias and any
 * collision remap. Used by the custom-macro registrar when defs are edited/removed.
 *
 * @param {string} name - The name passed to safeRegister (pre-remap).
 */
export function safeUnregister(name) {
    const registry = getRegistry();
    if (!registry) {
        return;
    }
    const lower = String(name).toLowerCase();
    const actual = remaps.get(lower)?.actual ?? name;
    for (const candidate of new Set([actual, `${FALLBACK_PREFIX}${name}`])) {
        const key = candidate.toLowerCase();
        if (registeredNames.has(key)) {
            try {
                registry.unregisterMacro(candidate);
            } catch (error) {
                console.warn(`[Macro Enhanced] Failed to unregister "{{${candidate}}}"`, error);
            }
            registeredNames.delete(key);
            forgetMacro(candidate);
        }
    }
    remaps.delete(lower);
}

/** Names of all registry entries this extension registered (primaries and aliases). */
export function getRegisteredNames() {
    return [...registeredNames];
}

/** Requested-name -> actual-name remaps caused by collisions, for the settings UI. */
export function getRemaps() {
    return new Map(remaps);
}

/**
 * Unregisters every entry we registered. The fork's EXTENSION_DISABLED sweep via
 * unregisterMacrosBySource is a backstop; this is the deterministic path.
 */
export function teardownRegistrations() {
    const registry = getRegistry();
    if (registry) {
        for (const name of registeredNames) {
            try {
                registry.unregisterMacro(name);
            } catch (error) {
                console.warn(`[Macro Enhanced] Failed to unregister "{{${name}}}"`, error);
            }
        }
    }
    registeredNames.clear();
    remaps.clear();
    clearCatalog();
}
