/**
 * Imported-syntax fixes: installs the rewrites in import-fixes-impl.js as an
 * engine pre-processor, so content written for another app works without being
 * edited first.
 *
 * Off by default. It rewrites text on its way into the engine for every
 * evaluation in the app, which is not something to turn on behind someone's
 * back. even though each rewrite only touches spellings that cannot work as
 * they stand. Turning it off removes the pre-processor and restores the host's
 * behaviour exactly; nothing in the registry is touched either way.
 */
import { rewriteMacros } from './import-fixes-impl.js';

/** The installed pre-processor, kept so it can be removed again. */
let preProcessor = null;

/** True once the fixes are installed. */
export function isImportFixesActive() {
    return preProcessor !== null;
}

/**
 * Installs the pre-processor. Safe to call repeatedly.
 *
 * @returns {boolean} True when the fixes are active afterwards.
 */
export function enableImportFixes() {
    if (preProcessor) {
        return true;
    }
    const engine = SillyTavern.getContext().macros?.engine;
    if (!engine?.addPreProcessor) {
        console.warn('[Macro Enhanced] This build has no macro pre-processor hook; imported-syntax fixes stay off.');
        return false;
    }
    preProcessor = (text) => rewriteMacros(text);
    // Priority 25 runs after the host's own legacy rewrites (10 and 20) and
    // before compat mode (30), so a condition compat mode rewrites has already
    // had its unlexable spellings repaired.
    engine.addPreProcessor(preProcessor, { priority: 25, source: 'MacroEnhanced' });
    return true;
}

/** Removes the pre-processor, returning the engine to stock behaviour. */
export function disableImportFixes() {
    if (!preProcessor) {
        return;
    }
    try {
        SillyTavern.getContext().macros?.engine?.removePreProcessor?.(preProcessor);
    } catch (error) {
        console.warn('[Macro Enhanced] Failed to remove the imported-syntax pre-processor', error);
    }
    preProcessor = null;
}

/** Applies the saved setting. Called at startup and whenever the toggle moves. */
export function syncImportFixes(enabled) {
    if (enabled) {
        return enableImportFixes();
    }
    disableImportFixes();
    return false;
}

/** Test hook. */
export function resetImportFixesState() {
    preProcessor = null;
}
