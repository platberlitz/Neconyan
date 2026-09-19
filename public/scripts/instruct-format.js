/**
 * Pure instruct-mode formatting. No browser globals: every dependency is an
 * explicit argument so the server can build the same prompts as the page.
 * public/scripts/instruct-mode.js wraps these with the live settings.
 */

export const NAMES_BEHAVIOR = {
    NONE: 'none',
    FORCE: 'force',
    ALWAYS: 'always',
};

export const FORCE_OUTPUT_SEQUENCE = {
    FIRST: 1,
    LAST: 2,
};

export const EXTENSION_PROMPT_TYPES = {
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
};

/**
 * Collect the stopping strings implied by an instruct preset.
 * @param {object} options
 * @param {object|null} options.customInstruct Explicit instruct preset.
 * @param {boolean|null} options.useStopStrings Whether context stop strings apply.
 * @param {object} options.context Context preset (chat_start, example_separator, use_stop_strings).
 * @param {(value: string) => string} options.substitute Macro/legacy substitution.
 * @param {string} options.name1 User name.
 * @param {string} options.name2 Character name.
 * @returns {string[]}
 */
export function getInstructStoppingSequences({ customInstruct = null, useStopStrings = null, context = {}, substitute = value => value, name1 = '', name2 = '' } = {}) {
    const instruct = structuredClone(customInstruct ?? {});

    function addInstructSequence(sequence) {
        const wrap = s => instruct.wrap ? '\n' + s : s;
        if (typeof sequence === 'string' && sequence.length > 0) {
            if (sequence.trim().length > 0) {
                const wrappedSequence = wrap(sequence);
                const stopString = instruct.macro ? substitute(wrappedSequence) : wrappedSequence;
                result.push(stopString);
            }
        }
    }

    const result = [];

    if (customInstruct ?? instruct.enabled) {
        const stop_sequence = instruct.stop_sequence || '';
        const input_sequence = instruct.input_sequence?.replace(/{{name}}/gi, name1) || '';
        const output_sequence = instruct.output_sequence?.replace(/{{name}}/gi, name2) || '';
        const first_output_sequence = instruct.first_output_sequence?.replace(/{{name}}/gi, name2) || '';
        const last_output_sequence = instruct.last_output_sequence?.replace(/{{name}}/gi, name2) || '';
        const system_sequence = instruct.system_sequence?.replace(/{{name}}/gi, 'System') || '';
        const last_system_sequence = instruct.last_system_sequence?.replace(/{{name}}/gi, 'System') || '';

        const combined_sequence = [
            stop_sequence,
        ];

        if (instruct.sequences_as_stop_strings) {
            combined_sequence.push(
                input_sequence,
                output_sequence,
                first_output_sequence,
                last_output_sequence,
                system_sequence,
                last_system_sequence,
            );
        }

        combined_sequence.join('\n').split('\n').filter(onlyUnique).forEach(addInstructSequence);
    }

    if (useStopStrings ?? context.use_stop_strings) {
        if (context.chat_start) {
            result.push(`\n${substitute(context.chat_start)}`);
        }

        if (context.example_separator) {
            result.push(`\n${substitute(context.example_separator)}`);
        }
    }

    return result;
}

/**
 * Format one chat message for the text-completion backend.
 * @param {object} options
 * @param {string} options.name Speaker name.
 * @param {string} options.mes Message text.
 * @param {boolean} options.isUser User message.
 * @param {boolean} options.isNarrator Narrator message.
 * @param {string} options.forceAvatar Forced avatar name.
 * @param {string} options.name1 User name.
 * @param {string} options.name2 Character name.
 * @param {boolean|number} options.forceOutputSequence Forced first/last output sequence.
 * @param {object|null} options.customInstruct Explicit instruct preset.
 * @param {boolean} options.selectedGroup A group chat is active.
 * @param {(value: string, overrides?: object) => string} options.substitute Macro/legacy substitution.
 * @returns {string}
 */
export function formatInstructModeChat({ name = '', mes = '', isUser = false, isNarrator = false, forceAvatar = '', name1 = '', name2 = '', forceOutputSequence = false, customInstruct = null, selectedGroup = false, substitute = value => value } = {}) {
    const instruct = structuredClone(customInstruct ?? {});
    let includeNames = isNarrator ? false : instruct.names_behavior === NAMES_BEHAVIOR.ALWAYS;

    if (!isNarrator && instruct.names_behavior === NAMES_BEHAVIOR.FORCE && ((selectedGroup && name !== name1) || (forceAvatar && name !== name1))) {
        includeNames = true;
    }

    function getPrefix() {
        if (isNarrator) {
            return instruct.system_same_as_user ? instruct.input_sequence : instruct.system_sequence;
        }

        if (isUser) {
            if (forceOutputSequence === FORCE_OUTPUT_SEQUENCE.FIRST) {
                return instruct.first_input_sequence || instruct.input_sequence;
            }

            if (forceOutputSequence === FORCE_OUTPUT_SEQUENCE.LAST) {
                return instruct.last_input_sequence || instruct.input_sequence;
            }

            return instruct.input_sequence;
        }

        if (forceOutputSequence === FORCE_OUTPUT_SEQUENCE.FIRST) {
            return instruct.first_output_sequence || instruct.output_sequence;
        }

        if (forceOutputSequence === FORCE_OUTPUT_SEQUENCE.LAST) {
            return instruct.last_output_sequence || instruct.output_sequence;
        }

        return instruct.output_sequence;
    }

    function getSuffix() {
        if (isNarrator) {
            return instruct.system_same_as_user ? instruct.input_suffix : instruct.system_suffix;
        }

        if (isUser) {
            return instruct.input_suffix;
        }

        return instruct.output_suffix;
    }

    let prefix = getPrefix() || '';
    let suffix = getSuffix() || '';

    if (instruct.macro) {
        prefix = substitute(prefix, { name1Override: name1, name2Override: name2 });
        prefix = prefix.replace(/{{name}}/gi, name || 'System');

        suffix = substitute(suffix, { name1Override: name1, name2Override: name2 });
        suffix = suffix.replace(/{{name}}/gi, name || 'System');
    }

    if (!suffix && instruct.wrap) {
        suffix = '\n';
    }

    const separator = instruct.wrap ? '\n' : '';

    const textArray = includeNames && name ? [prefix, `${name}: ${mes}` + suffix] : [prefix, mes + suffix];
    const text = textArray.filter(x => x).join(separator);

    return text;
}

/**
 * Format the assistant prefill / prompt tail for the text-completion backend.
 * @param {object} options
 * @param {string} options.name Speaker name.
 * @param {boolean} options.isImpersonate User impersonation.
 * @param {string} options.promptBias Prompt bias text.
 * @param {string} options.name1 User name.
 * @param {string} options.name2 Character name.
 * @param {boolean} options.isQuiet Quiet request.
 * @param {boolean} options.isQuietToLoud Quiet-to-loud request.
 * @param {object|null} options.customInstruct Explicit instruct preset.
 * @param {boolean} options.selectedGroup A group chat is active.
 * @param {(value: string, overrides?: object) => string} options.substitute Macro/legacy substitution.
 * @returns {string}
 */
export function formatInstructModePrompt({ name = '', isImpersonate = false, promptBias = '', name1 = '', name2 = '', isQuiet = false, isQuietToLoud = false, customInstruct = null, selectedGroup = false, substitute = value => value } = {}) {
    const instruct = structuredClone(customInstruct ?? {});
    const includeNames = name && (instruct.names_behavior === NAMES_BEHAVIOR.ALWAYS || (!!selectedGroup && instruct.names_behavior === NAMES_BEHAVIOR.FORCE)) && !(isQuiet && !isQuietToLoud);

    function getSequence() {
        if (isImpersonate) {
            return instruct.last_input_sequence || instruct.input_sequence;
        }

        if (isQuiet && !isQuietToLoud) {
            return instruct.last_system_sequence || instruct.output_sequence;
        }

        if (isQuiet && isQuietToLoud) {
            return instruct.last_output_sequence || instruct.output_sequence;
        }

        return instruct.last_output_sequence || instruct.output_sequence;
    }

    let sequence = getSequence() || '';
    let nameFiller = '';

    if (
        includeNames &&
        instruct.last_output_sequence &&
        instruct.output_sequence &&
        sequence === instruct.last_output_sequence &&
        /\s$/.test(instruct.output_sequence) &&
        !/\s$/.test(instruct.last_output_sequence)
    ) {
        nameFiller = instruct.output_sequence.slice(-1);
    }

    if (instruct.macro) {
        sequence = substitute(sequence, { name1Override: name1, name2Override: name2 });
        sequence = sequence.replace(/{{name}}/gi, name || 'System');
    }

    const separator = instruct.wrap ? '\n' : '';
    let text = includeNames ? (separator + sequence + separator + nameFiller + `${name}:`) : (separator + sequence);

    if (isQuiet && separator) {
        text = text.slice(separator.length);
    }

    if (!isImpersonate && promptBias) {
        text += (includeNames ? promptBias : (separator + promptBias.trimStart()));
    }

    return (instruct.wrap ? text.trimEnd() : text) + (includeNames ? '' : separator);
}

/**
 * Wrap a story string with the instruct preset's story prefixes/suffixes.
 * @param {string} storyString Story string.
 * @param {object} options
 * @param {object|null} options.customContext Explicit context preset.
 * @param {object|null} options.customInstruct Explicit instruct preset.
 * @param {(value: string) => string} options.substitute Macro/legacy substitution.
 * @returns {string}
 */
export function formatInstructModeStoryString(storyString, { customContext = null, customInstruct = null, substitute = value => value } = {}) {
    if (!storyString) {
        return '';
    }

    const instructSettings = structuredClone(customInstruct ?? {});
    const contextSettings = structuredClone(customContext ?? {});
    const storyStringPosition = contextSettings.story_string_position ?? EXTENSION_PROMPT_TYPES.IN_PROMPT;

    const applySequences = storyStringPosition !== EXTENSION_PROMPT_TYPES.IN_CHAT;
    const separator = instructSettings.wrap ? '\n' : '';
    if (applySequences && instructSettings.story_string_prefix) {
        const prefix = substitute(instructSettings.story_string_prefix).replace(/{{name}}/gi, 'System');
        storyString = prefix + separator + storyString;
    }

    if (applySequences && instructSettings.story_string_suffix) {
        const suffix = substitute(instructSettings.story_string_suffix);
        storyString = storyString + suffix;
    }

    return storyString;
}

function onlyUnique(value, index, array) {
    return array.indexOf(value) === index;
}
