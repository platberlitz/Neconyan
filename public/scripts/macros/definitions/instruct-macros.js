import { MacroRegistry, MacroCategory } from '../engine/MacroRegistry.js';

/** @typedef {import('../engine/MacroEnv.types.js').MacroEnv} MacroEnv */

/**
 * Registers instruct-mode related {{...}} macros (instruct* and system
 * prompt/context macros) in the MacroRegistry.
 *
 * All values come from env.extra.powerUser, supplied per operation by the
 * browser environment builder (live power_user) or by server glue (explicit
 * snapshot). No module-level globals are captured at registration time.
 */
export function registerInstructMacros() {
    /**
     * Helper to register macros that just expose a value from power_user.instruct.
     * The first name is the primary, subsequent names become visible aliases.
     * @param {string[]} names - First is primary, rest are aliases.
     * @param {(powerUser: any) => string} getValue
     * @param {(powerUser: any) => boolean} isEnabled
     * @param {string} description
     * @param {string} [category=MacroCategory.PROMPTS]
     */
    function registerSimple(names, getValue, isEnabled, description, category = MacroCategory.PROMPTS) {
        const [primary, ...aliasNames] = names;
        const aliases = aliasNames.map(alias => ({ alias }));

        MacroRegistry.registerMacro(primary, {
            category,
            description,
            aliases: aliases.length > 0 ? aliases : undefined,
            handler: ({ env }) => {
                const powerUser = env.extra?.powerUser;
                if (!powerUser || !isEnabled(powerUser)) return '';
                return getValue(powerUser) ?? '';
            },
        });
    }

    const instEnabled = (powerUser) => !!powerUser.instruct?.enabled;
    const sysEnabled = (powerUser) => !!powerUser.sysprompt?.enabled;

    // Instruct template macros
    registerSimple(['instructStoryStringPrefix'], (p) => p.instruct.story_string_prefix, instEnabled, 'Instruct story string prefix.');
    registerSimple(['instructStoryStringSuffix'], (p) => p.instruct.story_string_suffix, instEnabled, 'Instruct story string suffix.');

    registerSimple(['instructUserPrefix', 'instructInput'], (p) => p.instruct.input_sequence, instEnabled, 'Instruct input / user prefix sequence.');
    registerSimple(['instructUserSuffix'], (p) => p.instruct.input_suffix, instEnabled, 'Instruct input / user suffix sequence.');

    registerSimple(['instructAssistantPrefix', 'instructOutput'], (p) => p.instruct.output_sequence, instEnabled, 'Instruct output / assistant prefix sequence.');
    registerSimple(['instructAssistantSuffix', 'instructSeparator'], (p) => p.instruct.output_suffix, instEnabled, 'Instruct output / assistant suffix sequence.');

    registerSimple(['instructSystemPrefix'], (p) => p.instruct.system_sequence, instEnabled, 'Instruct system prefix sequence.');
    registerSimple(['instructSystemSuffix'], (p) => p.instruct.system_suffix, instEnabled, 'Instruct system suffix sequence.');

    registerSimple(['instructFirstAssistantPrefix', 'instructFirstOutputPrefix'], (p) => p.instruct.first_output_sequence || p.instruct.output_sequence, instEnabled, 'Instruct first assistant / output prefix sequence');
    registerSimple(['instructLastAssistantPrefix', 'instructLastOutputPrefix'], (p) => p.instruct.last_output_sequence || p.instruct.output_sequence, instEnabled, 'Instruct last assistant / output prefix sequence.');

    registerSimple(['instructStop'], (p) => p.instruct.stop_sequence, instEnabled, 'Instruct stop sequence.');
    registerSimple(['instructUserFiller'], (p) => p.instruct.user_alignment_message, instEnabled, 'Instruct user alignment filler.');
    registerSimple(['instructSystemInstructionPrefix'], (p) => p.instruct.last_system_sequence, instEnabled, 'Instruct system instruction prefix sequence.');

    registerSimple(['instructFirstUserPrefix', 'instructFirstInput'], (p) => p.instruct.first_input_sequence || p.instruct.input_sequence, instEnabled, 'Instruct first user / input prefix sequence.');
    registerSimple(['instructLastUserPrefix', 'instructLastInput'], (p) => p.instruct.last_input_sequence || p.instruct.input_sequence, instEnabled, 'Instruct last user / input prefix sequence.');

    // System prompt macros
    registerSimple(['defaultSystemPrompt', 'instructSystem', 'instructSystemPrompt'], (p) => p.sysprompt.content, sysEnabled, 'Default system prompt.');

    MacroRegistry.registerMacro('systemPrompt', {
        category: MacroCategory.PROMPTS,
        description: 'Active system prompt text (optionally overridden by character prompt)',
        handler: ({ env }) => {
            const powerUser = env.extra?.powerUser;
            if (!powerUser || !powerUser.sysprompt?.enabled) return '';

            if (powerUser.prefer_character_prompt && env.character.charPrompt) {
                return env.character.charPrompt;
            }
            return powerUser.sysprompt.content ?? '';
        },
    });

    // Context template macros
    registerSimple(['exampleSeparator', 'chatSeparator'], (p) => p.context.example_separator, () => true, 'Separator used between example chat blocks in text completion prompts.');
    registerSimple(['chatStart'], (p) => p.context.chat_start, () => true, 'Chat start marker used in text completion prompts.');
}
