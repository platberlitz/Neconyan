import { MacroRegistry, MacroCategory } from '../engine/MacroRegistry.js';

/**
 * Registers macros that depend on runtime application state rather than
 * static environment fields (last generation type, extension enabled state).
 *
 * Host capabilities are read from env.extra so this module stays free of
 * module-level app globals; the browser environment provider supplies the
 * event source, the current generation type and an extension lookup.
 */

/**
 * @returns {import('../engine/MacroEnv.types.js').MacroEnvExtra | undefined}
 */
function getExtra(env) {
    return env?.extra;
}

export function registerStateMacros() {
    MacroRegistry.registerMacro('lastGenerationType', {
        category: MacroCategory.STATE,
        description: 'Type of the last queued generation request (e.g. "normal", "impersonate", "regenerate", "quiet", "swipe", "continue"). Empty if none yet or chat was switched.',
        returns: 'Type of the last queued generation request.',
        handler: ({ env }) => {
            const state = getExtra(env)?.generationState;
            return state?.lastGenerationType ?? '';
        },
    });

    // Macro that checks if an extension is enabled
    MacroRegistry.registerMacro('hasExtension', {
        category: MacroCategory.STATE,
        unnamedArgs: [{
            name: 'extensionName',
            type: 'string',
            description: 'The name of the extension to check',
        }],
        description: 'Checks if a specific extension is enabled. If the extension does not exist, returns false.',
        returns: 'true if the extension is enabled, false otherwise.',
        handler: ({ unnamedArgs: [extensionName], env }) => {
            const extra = getExtra(env);
            const extension = extra?.findExtension?.(extensionName);
            return String(extension?.enabled ?? false);
        },
    });
}
