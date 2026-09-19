/**
 * Shared typedefs for the structured macro environment object (MacroEnv)
 * used by the macro engine, registry, env builder, and macro definition
 * modules. This file intentionally only contains JSDoc typedefs so that
 * it can be imported purely for type information from multiple modules
 * without creating runtime dependencies.
 */

/** @typedef {import('./MacroRegistry.js').MacroHandler} MacroHandler */
/** @typedef {import('./MacroRegistry.js').MacroDefinitionOptions} MacroDefinitionOptions */

/**
 * A dynamic macro value can be:
 * - A string (direct value)
 * - A MacroHandler function (resolved at runtime)
 * - A MacroDefinitionOptions object (full macro definition with handler, args, etc.)
 * @typedef {string | MacroHandler | MacroDefinitionOptions} DynamicMacroValue
 */

/**
 * @typedef {Object} MacroEnvNames
 * @property {string} user
 * @property {string} char
 * @property {string} group
 * @property {string} groupNotMuted
 * @property {string} notChar
 */

/**
 * @typedef {Object} MacroEnvCharacter
 * @property {string} [description]
 * @property {string} [personality]
 * @property {string} [scenario]
 * @property {string} [persona]
 * @property {string} [charPrompt]
 * @property {string} [charInstruction]
 * @property {string} [mesExamplesRaw]
 * @property {string} [charDepthPrompt]
 * @property {string} [creatorNotes]
 * @property {string} [version]
 * @property {string} [firstMessage]
 * @property {string[]} [alternateGreetings]
 */

/**
 * @typedef {Object} MacroEnvSystem
 * @property {string} model
 */

/**
 * @typedef {Object} MacroEnvFunctions
 * @property {() => string} [original]
 * @property {(text: string) => string} postProcess
 */

/**
 * Operation-scoped variable store surface. One is supplied for the local
 * scope and one for the global scope. The host decides where reads and
 * writes actually go (live SillyTavern stores in the browser, an explicit
 * snapshot plus mutation sink on the server).
 *
 * @typedef {Object} MacroVariableScope
 * @property {(name: string) => any} get
 * @property {(name: string, value: any) => void} set
 * @property {(name: string) => boolean} has
 * @property {(name: string) => void} del
 * @property {(name: string, value?: any) => any} inc
 * @property {(name: string, value?: any) => any} dec
 * @property {(name: string, value?: any) => void} add
 * @property {() => void} [flush]
 */

/**
 * @typedef {Object} MacroEnvVariables
 * @property {MacroVariableScope} local
 * @property {MacroVariableScope} global
 */

/**
 * Host capabilities that the browser environment builder (or the server
 * glue) must supply per operation. Definitions read these from env.extra;
 * they must never be captured at registration time, because registration
 * is process-wide and per-user state would leak between callers.
 *
 * Hosts supply capabilities required by the macros they evaluate. Missing
 * required capabilities throw, leaving the macro available for a later pass;
 * optional display values keep their documented empty or neutral result.
 * Server hosts accept functions in extra or in the separate capabilities
 * argument. These functions are never part of a persisted job snapshot.
 *
 * @typedef {Object} MacroEnvExtra
 * @property {MacroEnvVariables} [variables] - Operation-scoped variable stores (only present where the engine supports it, e.g. variable shorthands).
 * @property {() => string} [getInput] - Current composer text, for {{input}}.
 * @property {Object} [chatMetadata] - Live chat metadata object (browser) or snapshot.
 * @property {Array} [chat] - Chat message array.
 * @property {() => string} [getCurrentChatId] - Active chat id.
 * @property {(hash: number) => void} [setChatIdHash]
 * @property {Object} [generationState]
 * @property {(name: string) => Object} [findExtension]
 * @property {() => number|null} [getFirstDisplayedMessageId]
 * @property {() => number} [getMaxPromptTokens]
 * @property {() => number} [getMaxContextTokens]
 * @property {() => number} [getMaxResponseTokens]
 * @property {Record<string, any>} [extensionPrompts] - Map of outlet keys to injected prompts.
 * @property {Record<string, any>} [injectIds] - Injection id helpers.
 * @property {string[]} [bannedWords] - Mutable array of banned words for text completion.
 * @property {string} [mainApi] - Current backend id (e.g. 'textgenerationwebui').
 * @property {Object} [powerUser] - Power user settings snapshot.
 * @property {() => boolean} [isMobile] - Mobile check.
 * @property {(text: string, instruct: boolean) => any} [parseMesExamples]
 * @property {(messages: any, user: string, char: string) => any} [formatInstructModeExamples]
 * @property {(timestamp: any) => any} [timestampToMoment]
 * @property {Record<string, any>} [chatMetadataExtra] - Reserved for future per-operation metadata.
 */

/**
 * @typedef {Object} MacroEnv
 * @property {string} content - The full original input string that is being processed by the macro engine. This is the same value as substituteParams "content" and is provided so macros can build deterministic behavior based on the whole prompt when needed.
 * @property {number} contentHash - A hash of the content string, used for caching and comparison.
 * @property {MacroEnvNames} names
 * @property {MacroEnvCharacter} character
 * @property {MacroEnvSystem} system
 * @property {MacroEnvFunctions} functions
 * @property {Object<string, DynamicMacroValue>} dynamicMacros
 * @property {MacroEnvExtra} extra
 */

export {};
