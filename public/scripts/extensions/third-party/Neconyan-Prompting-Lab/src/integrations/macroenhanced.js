import { ctxOf } from '../host.js';
import { stableStringify } from '../message-content.js';

/**
 * Reads the Macro Enhanced extension's configuration.
 *
 * Recorded only, never applied. A test case notes what the macro configuration
 * was when a prompt was built, so that a later difference can be explained
 * ("the macro pack changed between these two runs"). Applying it would mean
 * writing to three separate stores the user owns, and a crash part way through
 * would leave their own macros in a state they never chose.
 */

const SETTINGS_KEY = 'MacroEnhanced';

export function isMacroEnhancedAvailable(hostRef) {
    return Boolean(ctxOf(hostRef)?.extensionSettings?.[SETTINGS_KEY]);
}

function customMacroFingerprint(definitions) {
    return (Array.isArray(definitions) ? definitions : [])
        .filter(definition => definition?.enabled !== false)
        .map(definition => ({
            name: String(definition?.name ?? ''),
            template: String(definition?.template ?? ''),
            args: (Array.isArray(definition?.args) ? definition.args : []).map(argument => ({
                name: String(argument?.name ?? ''),
                optional: Boolean(argument?.optional),
                defaultValue: String(argument?.defaultValue ?? ''),
            })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || stableStringify(a).localeCompare(stableStringify(b)));
}

function hashValue(value) {
    const text = String(stableStringify(value) ?? '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function valueHashes(values) {
    return Object.entries(values && typeof values === 'object' ? values : {})
        .map(([key, value]) => ({ key, hash: hashValue(value) }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

export function readMacroEnhanced(hostRef) {
    const context = ctxOf(hostRef);
    const settings = context?.extensionSettings?.[SETTINGS_KEY];
    if (!settings) {
        return null;
    }

    const characterIndex = context?.characterId;
    const characterMacros = context?.characters?.[characterIndex]?.data?.extensions?.[SETTINGS_KEY]?.customMacros;
    const chatState = context?.chatMetadata?.[SETTINGS_KEY] ?? null;

    return {
        settingsVersion: settings.settingsVersion ?? null,
        compatExpressions: Boolean(settings.compatExpressions),
        manualCachingAtDepth: settings.auditor?.manualCachingAtDepth ?? null,
        globalMacros: customMacroFingerprint(settings.customMacros),
        characterMacros: customMacroFingerprint(characterMacros),
        chatMacros: customMacroFingerprint(chatState?.customMacros),
        // Stored values that make a macro return the same thing twice; a change
        // here explains a prompt difference that no setting accounts for.
        frozenKeys: Object.keys(chatState?.frozen ?? {}).sort(),
        stickyKeys: Object.keys(chatState?.sticky ?? {}).sort(),
        dailyKeys: Object.keys(chatState?.daily ?? {}).sort(),
        rollKeys: Object.keys(chatState?.rolls ?? {}).sort(),
        chatVarNames: Object.keys(chatState?.chatVars ?? {}).sort(),
        frozenValues: valueHashes(chatState?.frozen),
        stickyValues: valueHashes(chatState?.sticky),
        dailyValues: valueHashes(chatState?.daily),
        rollValues: valueHashes(chatState?.rolls),
        chatVarValues: valueHashes(chatState?.chatVars),
        countersHash: hashValue(chatState?.counters ?? {}),
        pronounsHash: hashValue(chatState?.pronouns ?? {}),
    };
}

/** True when two recorded configurations would produce different prompts. */
export function macroConfigDiffers(a, b) {
    if (!a || !b) {
        return Boolean(a) !== Boolean(b);
    }
    return JSON.stringify(a) !== JSON.stringify(b);
}
