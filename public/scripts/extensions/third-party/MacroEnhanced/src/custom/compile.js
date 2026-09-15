export const CATEGORY_CUSTOM = 'enhanced-custom';
export const MAX_DEPTH = 10;

/** In-flight expansion names + depth, shared across all custom macros so mutual
 *  recursion (A -> B -> A) is caught, not just direct self-reference. */
const expanding = new Set();
let depth = 0;

/** Test hook. */
export function resetRecursionState() {
    expanding.clear();
    depth = 0;
}

/**
 * Compiles a stored custom macro definition into engine MacroDefinitionOptions.
 *
 * Argument values are exposed to the template as {{argname}} and {{argN}} via
 * dynamicMacros, which the engine resolves before registered macros. The handler
 * re-evaluates the template itself (rather than ctx.resolve) because the incoming
 * env is frozen and per-invocation bindings need a fresh env object.
 *
 * @param {import('./store.js').CustomMacroDef} def
 * @param {object} deps
 * @param {{evaluate: Function}} deps.engine - The macro engine (injectable for tests).
 * @returns {object} MacroDefinitionOptions
 */
export function compileDef(def, { engine }) {
    const args = def.args ?? [];
    const requiredArgs = args.filter(arg => !arg.optional);

    return {
        category: CATEGORY_CUSTOM,
        description: def.description?.trim() || 'User-defined macro (Macro Enhanced).',
        unnamedArgs: args.map(arg => ({
            name: arg.name,
            optional: !!arg.optional,
            ...(arg.optional && arg.defaultValue !== undefined ? { defaultValue: String(arg.defaultValue) } : {}),
            ...(arg.description ? { description: arg.description } : {}),
        })),
        exampleUsage: [`{{${def.name}${requiredArgs.map(arg => `::${arg.name}`).join('')}}}`],
        handler: (ctx) => {
            const guardKey = def.name.toLowerCase();
            if (expanding.has(guardKey) || depth >= MAX_DEPTH) {
                ctx.warn(`Custom macro "${def.name}" expands itself (or nests deeper than ${MAX_DEPTH} levels); expansion stopped.`);
                return '';
            }

            const bindings = {};
            args.forEach((arg, i) => {
                const value = ctx.unnamedArgs[i] !== undefined && ctx.unnamedArgs[i] !== ''
                    ? ctx.unnamedArgs[i]
                    : String(arg.defaultValue ?? '');
                bindings[arg.name.toLowerCase()] = value;
                bindings[`arg${i + 1}`] = value;
            });

            expanding.add(guardKey);
            depth++;
            try {
                const env = { ...ctx.env, dynamicMacros: { ...ctx.env.dynamicMacros, ...bindings } };
                return engine.evaluate(def.template, env, { contextOffset: ctx.globalOffset });
            } finally {
                expanding.delete(guardKey);
                depth--;
            }
        },
    };
}
