/**
 * Compat mode: makes {{if}} understand infix conditions, and lets {{and}}/{{or}}
 * take them as arguments.
 *
 * Off by default. While on, an engine pre-processor rewrites infix {{if}}
 * conditions to run through {{expr}} (see compat-impl.js for why a pre-processor
 * rather than re-registering {{if}}). Turning it off removes the pre-processor,
 * which restores the host's behaviour exactly. nothing about the registry was
 * changed to begin with.
 */
import { getRemaps, safeRegister } from './registration.js';
import { ExprError, evaluateCondition, hasExpressionOperator } from './expr-impl.js';
import { boolString, isTruthyText } from './logic-impl.js';
import { rewriteIfConditions } from './compat-impl.js';

export const CATEGORY_COMPAT = 'enhanced-compat';

/** The name {{expr}} actually got, which safeRegister may have remapped. */
let exprMacroName = null;

/** The installed pre-processor, kept so it can be removed again. */
let preProcessor = null;

/**
 * Evaluates a condition the way compat mode does: as an expression when it has
 * an operator, otherwise by the host's plain truthiness rule. Shared by {{expr}},
 * {{and}} and {{or}} so all three agree.
 *
 * @param {string} text
 * @param {(message: string) => void} warn
 * @returns {boolean}
 */
export function conditionIsTrue(text, warn) {
    const s = String(text ?? '');
    if (!hasExpressionOperator(s)) {
        return isTruthyText(s);
    }
    try {
        return evaluateCondition(s);
    } catch (error) {
        if (error instanceof ExprError) {
            warn(`Could not read the condition "${s}": ${error.message}. Treating it as false.`);
            return false;
        }
        throw error;
    }
}

export function registerCompatMacros() {
    exprMacroName = safeRegister('expr', {
        category: CATEGORY_COMPAT,
        unnamedArgs: [{ name: 'condition', description: 'The condition to work out, e.g. "{{.hp}} > 0".' }],
        list: true,
        description: 'Works out a condition written the ordinary way, with == != > >= < <= && || ! and brackets. Compare text or numbers; quote values containing spaces. Without this, {{if}} only asks whether the condition is non-empty, so "0 > 0" would count as true.',
        returns: 'true or false',
        returnType: 'boolean',
        exampleUsage: ['{{expr::{{getchatvar::day}} > 3}}', '{{if::{{expr::{{.name}} != "Ren"}}}}Not Ren{{/if}}'],
        handler: (ctx) => {
            // list: true so a condition containing a top-level `::` survives; the
            // engine split it into arguments, so put it back together.
            const parts = [ctx.unnamedArgs[0] ?? '', ...(ctx.list ?? [])];
            return boolString(conditionIsTrue(parts.join('::'), ctx.warn));
        },
    });
}

/**
 * The name a macro of ours is really available under, or null if it is not
 * registered at all. Needed because OR is decomposed into {{or}}, which
 * safeRegister may have had to rename.
 */
function liveName(name) {
    const actual = getRemaps().get(name.toLowerCase())?.actual ?? name;
    try {
        return SillyTavern.getContext().macros?.registry?.hasMacro(actual) ? actual : null;
    } catch {
        return null;
    }
}

/** True once compat mode has installed its pre-processor. */
export function isCompatActive() {
    return preProcessor !== null;
}

/**
 * Installs the pre-processor. Safe to call repeatedly.
 *
 * @returns {boolean} True when compat mode is active afterwards.
 */
export function enableCompatMode() {
    if (preProcessor) {
        return true;
    }
    const engine = SillyTavern.getContext().macros?.engine;
    if (!engine?.addPreProcessor) {
        console.warn('[Macro Enhanced] This build has no macro pre-processor hook; expression conditions stay off.');
        return false;
    }
    if (!exprMacroName) {
        console.warn('[Macro Enhanced] {{expr}} is not registered; expression conditions stay off.');
        return false;
    }
    const names = {
        expr: exprMacroName,
        or: liveName('or'),
        and: liveName('and'),
        not: liveName('not'),
    };
    preProcessor = (text) => rewriteIfConditions(text, names, (condition) => {
        console.warn(`[Macro Enhanced] Cannot rewrite the condition "${condition}"; leaving it as it is.`);
    });
    // Priority 30 puts this after the host's own legacy rewrites (10 and 20).
    engine.addPreProcessor(preProcessor, { priority: 30, source: 'MacroEnhanced' });
    return true;
}

/** Removes the pre-processor, returning {{if}} to stock behaviour. */
export function disableCompatMode() {
    if (!preProcessor) {
        return;
    }
    try {
        SillyTavern.getContext().macros?.engine?.removePreProcessor?.(preProcessor);
    } catch (error) {
        console.warn('[Macro Enhanced] Failed to remove the compatibility pre-processor', error);
    }
    preProcessor = null;
}

/** Applies the saved setting. Called at startup and whenever the toggle moves. */
export function syncCompatMode(enabled) {
    if (enabled) {
        return enableCompatMode();
    }
    disableCompatMode();
    return false;
}

/** Test hook. */
export function resetCompatState() {
    preProcessor = null;
    exprMacroName = null;
}
