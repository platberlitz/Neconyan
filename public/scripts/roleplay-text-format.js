import { formatInstructModeChat, NAMES_BEHAVIOR } from './instruct-format.js';

/** Render a saved context template without browser globals or UI warnings. */
export function renderRoleplayStory(params, { template, context = {}, instruct = {}, compile, substitute = value => value }) {
    let output = substitute(compile(template, { noEscape: true })(params));
    output = output.replace(/^\n+/, '');
    if (output.length && !output.endsWith('\n') && context.story_string_position !== 1
        && (!instruct.enabled || instruct.wrap && !instruct.story_string_suffix)) output += '\n';
    return output;
}

/** The same saved message formatting is used in the page and native Roleplay jobs. */
export function formatRoleplayTextMessage(message, { instruct, userName, characterName, group = false,
    forceOutputSequence = false, substitute = value => value } = {}) {
    const narrator = message.extra?.type === 'narrator';
    const name = message.is_user ? message.name : message.name || characterName;
    if (!instruct?.enabled) return message.name && !narrator ? `${name}: ${message.mes}\n` : `${message.mes}\n`;
    return formatInstructModeChat({ name, mes: message.mes, isUser: message.is_user, isNarrator: narrator,
        forceAvatar: message.force_avatar, name1: userName, name2: characterName, selectedGroup: group,
        forceOutputSequence, customInstruct: instruct, substitute });
}

/** Combine already formatted context, examples and history with the saved separators. */
export function combineRoleplayTextPrompt({ story = '', examples = '', history = '', continuation = '',
    chatStart = '', preamble = '', collapseNewlines = false }) {
    let result = [story, examples, preamble, chatStart, history, continuation].join('').replace(/\r/gm, '');
    if (collapseNewlines) result = result.replace(/\n+/g, '\n');
    return result;
}

export function formatRoleplayTextExamples(mesExamplesArray, name1, name2, {
    instruct, context, group = false, substitute = value => value, parseExamples,
}) {
    const blockHeading = context.example_separator ? `${substitute(context.example_separator)}\n` : '';

    if (instruct.skip_examples) {
        return mesExamplesArray.map(x => x.replace(/<START>\n/i, blockHeading));
    }

    const includeNames = instruct.names_behavior === NAMES_BEHAVIOR.ALWAYS;
    const includeGroupNames = group && [NAMES_BEHAVIOR.ALWAYS, NAMES_BEHAVIOR.FORCE].includes(instruct.names_behavior);

    let inputPrefix = instruct.input_sequence || '';
    let outputPrefix = instruct.output_sequence || '';
    let inputSuffix = instruct.input_suffix || '';
    let outputSuffix = instruct.output_suffix || '';

    if (instruct.macro) {
        inputPrefix = substitute(inputPrefix, { name1Override: name1, name2Override: name2 });
        outputPrefix = substitute(outputPrefix, { name1Override: name1, name2Override: name2 });
        inputSuffix = substitute(inputSuffix, { name1Override: name1, name2Override: name2 });
        outputSuffix = substitute(outputSuffix, { name1Override: name1, name2Override: name2 });

        inputPrefix = inputPrefix.replace(/{{name}}/gi, name1);
        outputPrefix = outputPrefix.replace(/{{name}}/gi, name2);
        inputSuffix = inputSuffix.replace(/{{name}}/gi, name1);
        outputSuffix = outputSuffix.replace(/{{name}}/gi, name2);

        if (!inputSuffix && instruct.wrap) {
            inputSuffix = '\n';
        }

        if (!outputSuffix && instruct.wrap) {
            outputSuffix = '\n';
        }
    }

    const separator = instruct.wrap ? '\n' : '';
    const formattedExamples = [];

    for (const item of mesExamplesArray) {
        const cleanedItem = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
        const blockExamples = parseExamples(cleanedItem, includeGroupNames);

        if (blockExamples.length === 0) {
            continue;
        }

        if (blockHeading) {
            formattedExamples.push(blockHeading);
        }

        for (const example of blockExamples) {
            // If group names were included, we don't want to add any additional prefix as it already was applied.
            // Otherwise, if force group/persona names is set, we should override the include names for the user placeholder
            const includeThisName = !includeGroupNames && (includeNames || (instruct.names_behavior === NAMES_BEHAVIOR.FORCE && example.name == 'example_user'));

            const prefix = example.name == 'example_user' ? inputPrefix : outputPrefix;
            const suffix = example.name == 'example_user' ? inputSuffix : outputSuffix;
            const name = example.name == 'example_user' ? name1 : name2;
            const messageContent = includeThisName ? `${name}: ${example.content}` : example.content;
            const formattedMessage = [prefix, messageContent + suffix].filter(x => x).join(separator);
            formattedExamples.push(formattedMessage);
        }
    }

    if (formattedExamples.length === 0) {
        return mesExamplesArray.map(x => x.replace(/<START>\n/i, blockHeading));
    }
    return formattedExamples;
}
