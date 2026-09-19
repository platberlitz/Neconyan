import { Handlebars } from '../lib.js';
import { chat, substituteParams, eventSource, event_types } from '../script.js';
import { uuidv4 } from './utils.js';
import { isMobile } from './RossAscends-mods.js';
import { evaluateLegacyMacros, getLegacyLastMessageId, sanitizeMacroValue } from './macros/legacy-macros.js';
import { populateBrowserExtra } from './macros/engine/MacroEnvExtra.browser.js';
import { initRegisterMacros, macros as macroSystem } from './macros/macro-system.js';
import { power_user } from './power-user.js';

/**
 * @typedef Macro
 * @property {RegExp} regex - Regular expression to match the macro
 * @property {(substring: string, ...args: any[]) => string} replace - Function to replace the macro
 */

// Register any macro that you want to leave in the compiled story string
Handlebars.registerHelper('trim', () => '{{trim}}');
// Catch-all helper for any macro that is not defined for story strings
Handlebars.registerHelper('helperMissing', function () {
    const options = arguments[arguments.length - 1];
    const macroName = options.name;
    return substituteParams(`{{${macroName}}}`);
});

/**
 * @typedef {Object<string, *>} EnvObject
 * @typedef {(nonce: string) => string} MacroFunction
 */

/**
 * @typedef {Object} CustomMacro
 * @property {string} key - Macro name (key)
 * @property {string} description - Optional description of the macro
 */

/**
 * @deprecated Use macros.registry.registerMacro (from scripts/macros/macro-system.js)
 * or substituteParams({ dynamicMacros }) with the new macro engine.
 */
export class MacrosParser {
    /**
     * A map of registered macros.
     * @type {Map<string, string|MacroFunction>}
     */
    static #macros = new Map();

    /**
     * A map of macro descriptions.
     * @type {Map<string, string>}
     */
    static #descriptions = new Map();

    /**
     * A map of macro sources.
     * @type {Map<string, string>}
     */
    static #sources = new Map();

    /**
     * Logs a deprecation warning for MacrosParser APIs, pointing callers to
     * the new macro engine registration surface.
     *
     * @param {string} method
     * @param {string} replacement
     * @param {IArguments} [methodArgs=null]
     * @returns {void}
     */
    static #logDeprecated(method, replacement, methodArgs = null) {
        console.warn(`[DEPRECATED] MacrosParser.${method} is deprecated and will be removed in a future version. Use ${replacement} instead. Arguments:`, (methodArgs ?? 'none'));
    }

    /**
     * Bridges a legacy MacrosParser macro registration into the new macro
     * engine.
     *
     * This mirrors the simple "{{key}}" replacement behavior by registering
     * a 0-arg macro in MacroRegistry that does not take arguments and returns
     * the sanitized value from the legacy registry.
     *
     * @param {string} key
     * @param {string|MacroFunction} value
     * @param {string} description
     * @returns {void}
     */
    static #registerMacroInNewEngine(key, value, description) {
        if (!power_user.experimental_macro_engine) {
            return;
        }

        // Like the old MacrosParser, we explicitly allow overriding macros, and only warn
        if (macroSystem.registry.hasMacro(key)) {
            console.warn(`Macro ${key} is already registered`);
        }

        const legacyValue = value;

        macroSystem.registry.registerMacro(key, {
            // Legacy MacrosParser macros never took arguments; keep the
            // contract that only {{key}} without arguments is valid.
            category: 'legacy',
            description: typeof description === 'string' ? description : 'Automatically registered macro from MacrosParser',
            handler: () => {
                /** @type {string|MacroFunction|undefined} */
                let stored = legacyValue;

                if (typeof stored === 'function') {
                    try {
                        const nonce = uuidv4();
                        stored = stored(nonce);
                    } catch (e) {
                        console.warn(`Macro "${key}" function threw an error.`, e);
                        stored = '';
                    }
                }

                // Let the new macro engine's normalizeMacroResult handle type
                // normalization for the returned value.
                return stored;
            },
        });
    }

    /**
     * Bridges a legacy MacrosParser macro unregistration into the new macro
     * engine.
     *
     * @param {string} key
     * @returns {boolean} True if a macro was removed.
     */
    static #unregisterMacroInNewEngine(key) {
        return macroSystem.registry.unregisterMacro(key);
    }

    /**
     * Returns an iterator over all registered macros.
     * @returns {IterableIterator<CustomMacro>}
     */
    static [Symbol.iterator] = function* () {
        // When experimental macro engine is active, yield from the new registry
        if (power_user.experimental_macro_engine) {
            // Exclude hidden aliases for consistency with autocomplete behavior
            for (const def of macroSystem.registry.getAllMacros({ excludeHiddenAliases: true })) {
                yield { key: def.name, description: def.description || '' };
            }
            return;
        }

        for (const macro of MacrosParser.#macros.keys()) {
            yield { key: macro, description: MacrosParser.#descriptions.get(macro) };
        }
    };

    /**
     * Access a macro by its name.
     * @param {string} key Macro name (key)
     * @returns {string|MacroFunction|undefined} The macro value
     */
    static get(key) {
        MacrosParser.#logDeprecated('get', 'macros.registry.getMacro (from scripts/macros/macro-system.js)', arguments);
        return MacrosParser.#macros.get(key);
    }

    /**
     * Checks if a macro is registered.
     * @param {string} key Macro name (key)
     * @returns {boolean} True if the macro is registered, false otherwise
     */
    static has(key) {
        MacrosParser.#logDeprecated('has', 'macros.registry.hasMacro (from scripts/macros/macro-system.js)', arguments);
        if (power_user.experimental_macro_engine) {
            return macroSystem.registry.hasMacro(key);
        }

        return MacrosParser.#macros.has(key);
    }

    /**
     * Registers a global macro that can be used anywhere where substitution is allowed.
     * @param {string} key Macro name (key)
     * @param {string|MacroFunction} value A string or a function that returns a string
     * @param {string} [description] Optional description of the macro
     */
    static registerMacro(key, value, description = '') {
        MacrosParser.#logDeprecated('registerMacro', 'macros.registry.registerMacro (from scripts/macros/macro-system.js) or substituteParams({ dynamicMacros })', arguments);
        if (typeof key !== 'string') {
            throw new Error('Macro key must be a string');
        }

        // Allowing surrounding whitespace would just create more confusion...
        key = key.trim();

        if (!key) {
            throw new Error('Macro key must not be empty or whitespace only');
        }

        if (key.startsWith('{{') || key.endsWith('}}')) {
            throw new Error('Macro key must not include the surrounding braces');
        }

        if (typeof value !== 'string' && typeof value !== 'function') {
            console.warn(`Macro value for "${key}" will be converted to a string`);
            value = this.sanitizeMacroValue(value);
        }

        MacrosParser.#registerMacroInNewEngine(key, value, description);
        if (power_user.experimental_macro_engine) {
            return;
        }

        if (this.#macros.has(key)) {
            console.warn(`Macro ${key} is already registered`);
        }

        this.#macros.set(key, value);
        this.#sources.set(key, detectLegacyMacroSource());

        if (typeof description === 'string' && description) {
            this.#descriptions.set(key, description);
        }
    }

    /**
     * Unregisters a global macro with the given key
     *
     * @param {string} key Macro name (key)
     */
    static unregisterMacro(key) {
        MacrosParser.#logDeprecated('unregisterMacro', 'macros.registry.unregisterMacro (from scripts/macros/macro-system.js)', arguments);
        if (typeof key !== 'string') {
            throw new Error('Macro key must be a string');
        }

        // Allowing surrounding whitespace would just create more confusion...
        key = key.trim();

        if (!key) {
            throw new Error('Macro key must not be empty or whitespace only');
        }

        const deleted = this.#macros.delete(key);
        const deletedInNewEngine = MacrosParser.#unregisterMacroInNewEngine(key);

        if (!deleted && !deletedInNewEngine) {
            console.warn(`Macro ${key} was not registered`);
        }

        this.#descriptions.delete(key);
        this.#sources.delete(key);
    }

    /**
     * Unregisters macros registered by a source, such as a disabled extension.
     * @param {string} sourceName Source identifier.
     * @returns {number} Number of macro entries removed.
     */
    static unregisterMacrosBySource(sourceName) {
        const normalizedSource = normalizeMacroSourceName(sourceName);
        if (!normalizedSource) {
            return 0;
        }

        let removed = 0;
        for (const [key, source] of this.#sources) {
            if (normalizeMacroSourceName(source) === normalizedSource) {
                this.#macros.delete(key);
                this.#descriptions.delete(key);
                this.#sources.delete(key);
                removed++;
            }
        }

        removed += macroSystem.registry.unregisterMacrosBySource(sourceName);
        return removed;
    }

    /**
     * Populate the env object with macro values from the current context.
     * @param {EnvObject} env Env object for the current evaluation context
     * @returns {void}
     */
    static populateEnv(env) {
        if (!env || typeof env !== 'object') {
            console.warn('Env object is not provided');
            return;
        }

        // No macros are registered
        if (this.#macros.size === 0) {
            return;
        }

        for (const [key, value] of this.#macros) {
            env[key] = value;
        }
    }

    /**
     * Performs a type-check on the macro value and returns a sanitized version of it.
     * @param {any} value Value returned by a macro
     * @returns {string} Sanitized value
     */
    static sanitizeMacroValue(value) {
        return sanitizeMacroValue(value);
    }
}

let extensionMacroCleanupBound = false;

function detectLegacyMacroSource() {
    const stack = new Error().stack?.split('\n').map(line => line.trim()) ?? [];

    const thirdPartyMatch = stack.find(line => line.includes('/scripts/extensions/third-party/'));
    if (thirdPartyMatch) {
        return thirdPartyMatch.replace(/^.*?\/scripts\/extensions\/third-party\/([^/]+)\/.*$/, '$1');
    }

    const extensionMatch = stack.find(line => line.includes('/scripts/extensions/'));
    if (extensionMatch) {
        return extensionMatch.replace(/^.*?\/scripts\/extensions\/([^/]+)\/.*$/, '$1');
    }

    return 'unknown';
}

function normalizeMacroSourceName(sourceName) {
    return String(sourceName || '')
        .replace(/^third-party\//i, '')
        .replace(/^\/?scripts\/extensions\/(?:third-party\/)?/i, '')
        .split('/')[0]
        .trim()
        .toLowerCase();
}

/**
 * Returns the ID of the last message in the chat
 *
 * Optionally can only choose specific messages, if a filter is provided.
 *
 * @param {object} param0 - Optional arguments
 * @param {boolean} [param0.exclude_swipe_in_propress=true] - Whether a message that is currently being swiped should be ignored
 * @param {function(object):boolean} [param0.filter] - A filter applied to the search, ignoring all messages that don't match the criteria. For example to only find user messages, etc.
 * @returns {number|null} The message id, or null if none was found
 */
export function getLastMessageId({ exclude_swipe_in_propress = true, filter = null } = {}) {
    return getLegacyLastMessageId(chat, { exclude_swipe_in_propress, filter });
}

/**
 * Substitutes {{macro}} parameters in a string.
 * @param {string} content - The string to substitute parameters in.
 * @param {EnvObject} env - Map of macro names to the values they'll be substituted with. If the param
 * values are functions, those functions will be called and their return values are used.
 * @param {function(string): string} postProcessFn - Function to run on the macro value before replacing it.
 * @returns {string} The string with substituted parameters.
 */
export function evaluateMacros(content, env, postProcessFn) {
    if (!content) return '';
    const operation = { extra: {} };
    populateBrowserExtra(operation);
    operation.extra.populateEnv = target => MacrosParser.populateEnv(target);
    // Preserve the legacy jQuery conversion when no input element exists.
    operation.extra.getInput = () => $('#send_textarea').val();
    return evaluateLegacyMacros(content, env, operation.extra, postProcessFn);
}

export function initMacros() {
    if (!extensionMacroCleanupBound) {
        eventSource.on(event_types.EXTENSION_DISABLED, extensionName => {
            MacrosParser.unregisterMacrosBySource(extensionName);
        });
        extensionMacroCleanupBound = true;
    }

    // Only manually register those is new macro engine is not on. In the new one, they are already registered automatically
    if (!power_user.experimental_macro_engine) {
        const initLastGenerationType = () => {
            let lastGenerationType = '';

            MacrosParser.registerMacro('lastGenerationType',
                () => lastGenerationType,
                'Returns the type of the last generation (e.g., "normal", "swipe", "continue", "impersonate", "quiet").',
            );

            eventSource.on(event_types.GENERATION_STARTED, (type, _params, isDryRun) => {
                if (isDryRun) return;
                lastGenerationType = type || 'normal';
            });

            eventSource.on(event_types.CHAT_CHANGED, () => {
                lastGenerationType = '';
            });
        };

        MacrosParser.registerMacro('isMobile',
            () => String(isMobile()),
            'Returns "true" if the user is on a mobile device, "false" otherwise.',
        );
        initLastGenerationType();
    }

    // TODO: Needs to be moved once old macros are deprecated and removed
    initRegisterMacros();
}
