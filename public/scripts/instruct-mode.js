'use strict';

import { formatRoleplayTextExamples } from './roleplay-text-format.js';
import { name1, name2, online_status, saveSettingsDebounced, substituteParams } from '../script.js';
import { selected_group } from './group-chats.js';
import { parseExampleIntoIndividual } from './openai.js';
import {
    power_user,
    context_presets,
} from './power-user.js';
import { regexFromString, resetScrollHeight } from './utils.js';
import {
    FORCE_OUTPUT_SEQUENCE,
    formatInstructModeChat as formatInstructModeChatPure,
    formatInstructModePrompt as formatInstructModePromptPure,
    formatInstructModeStoryString as formatInstructModeStoryStringPure,
    getInstructStoppingSequences as getInstructStoppingSequencesPure,
} from './instruct-format.js';

/**
 * @type {InstructSettings[]} Instruct mode presets.
 */
export let instruct_presets = [];

export const names_behavior_types = {
    NONE: 'none',
    FORCE: 'force',
    ALWAYS: 'always',
};

const controls = [
    { id: 'instruct_enabled', property: 'enabled', isCheckbox: true },
    { id: 'instruct_wrap', property: 'wrap', isCheckbox: true },
    { id: 'instruct_macro', property: 'macro', isCheckbox: true },
    { id: 'instruct_story_string_prefix', property: 'story_string_prefix', isCheckbox: false },
    { id: 'instruct_story_string_suffix', property: 'story_string_suffix', isCheckbox: false },
    { id: 'instruct_input_sequence', property: 'input_sequence', isCheckbox: false },
    { id: 'instruct_input_suffix', property: 'input_suffix', isCheckbox: false },
    { id: 'instruct_output_sequence', property: 'output_sequence', isCheckbox: false },
    { id: 'instruct_output_suffix', property: 'output_suffix', isCheckbox: false },
    { id: 'instruct_system_sequence', property: 'system_sequence', isCheckbox: false },
    { id: 'instruct_system_suffix', property: 'system_suffix', isCheckbox: false },
    { id: 'instruct_last_system_sequence', property: 'last_system_sequence', isCheckbox: false },
    { id: 'instruct_user_alignment_message', property: 'user_alignment_message', isCheckbox: false },
    { id: 'instruct_stop_sequence', property: 'stop_sequence', isCheckbox: false },
    { id: 'instruct_first_output_sequence', property: 'first_output_sequence', isCheckbox: false },
    { id: 'instruct_last_output_sequence', property: 'last_output_sequence', isCheckbox: false },
    { id: 'instruct_first_input_sequence', property: 'first_input_sequence', isCheckbox: false },
    { id: 'instruct_last_input_sequence', property: 'last_input_sequence', isCheckbox: false },
    { id: 'instruct_activation_regex', property: 'activation_regex', isCheckbox: false },
    { id: 'instruct_bind_to_context', property: 'bind_to_context', isCheckbox: true },
    { id: 'instruct_skip_examples', property: 'skip_examples', isCheckbox: true },
    { id: 'instruct_names_behavior', property: 'names_behavior', isCheckbox: false },
    { id: 'instruct_system_same_as_user', property: 'system_same_as_user', isCheckbox: true, trigger: true },
    { id: 'instruct_sequences_as_stop_strings', property: 'sequences_as_stop_strings', isCheckbox: true },
];

/**
 * Migrates instruct mode settings into the evergreen format.
 * @param {object} settings Instruct mode settings.
 * @returns {void}
 */
function migrateInstructModeSettings(settings) {
    // Separator sequence => Output suffix
    if (settings.separator_sequence !== undefined) {
        settings.output_suffix = settings.separator_sequence || '';
        delete settings.separator_sequence;
    }

    // names, names_force_groups => names_behavior
    if (settings.names !== undefined) {
        settings.names_behavior = settings.names
            ? names_behavior_types.ALWAYS
            : (settings.names_force_groups ? names_behavior_types.FORCE : names_behavior_types.NONE);
        delete settings.names;
        delete settings.names_force_groups;
    }

    const defaults = {
        input_suffix: '',
        system_sequence: '',
        system_suffix: '',
        user_alignment_message: '',
        last_system_sequence: '',
        first_input_sequence: '',
        last_input_sequence: '',
        skip_examples: false,
        system_same_as_user: false,
        names_behavior: names_behavior_types.FORCE,
        sequences_as_stop_strings: true,
        story_string_prefix: '',
        story_string_suffix: '',
    };

    for (let key in defaults) {
        if (settings[key] === undefined) {
            settings[key] = defaults[key];
        }
    }

    const obsoleteFields = [
        'names',
        'names_force_groups',
        'system_sequence_prefix',
        'system_sequence_suffix',
    ];

    for (const field of obsoleteFields) {
        if (Object.hasOwn(settings, field)) {
            delete settings[field];
        }
    }
}

/**
 * Loads instruct mode settings from the given data object.
 * @param {object} data Settings data object.
 */
export async function loadInstructMode(data) {
    if (data.instruct !== undefined) {
        instruct_presets = data.instruct;
    }

    migrateInstructModeSettings(power_user.instruct);

    $('#instruct_enabled').parent().find('i').toggleClass('toggleEnabled', !!power_user.instruct.enabled);
    $('#instructSettingsBlock, #InstructSequencesColumn').toggleClass('disabled', !power_user.instruct.enabled);
    $('#instruct_derived').parent().find('i').toggleClass('toggleEnabled', !!power_user.instruct_derived);
    $('#instruct_bind_to_context').parent().find('i').toggleClass('toggleEnabled', !!power_user.instruct.bind_to_context);

    controls.forEach(control => {
        const $element = $(`#${control.id}`);

        if (control.isCheckbox) {
            $element.prop('checked', power_user.instruct[control.property]);
        } else if ($element.is('select')) {
            const value = power_user.instruct[control.property];
            $element.val(value);
            $element.filter(`[value="${value}"]`).prop('checked', true);
        } else {
            $element.val(power_user.instruct[control.property]);
        }

        $element.on('input', async function () {
            power_user.instruct[control.property] = control.isCheckbox ? !!$(this).prop('checked') : $(this).val();
            if (!CSS.supports('field-sizing', 'content') && $(this).is('textarea')) {
                await resetScrollHeight($(this));
            }
            saveSettingsDebounced();
        });

        if (control.trigger) {
            $element.trigger('input');
        }
    });

    instruct_presets.forEach((preset) => {
        const name = preset.name;
        const option = document.createElement('option');
        option.value = name;
        option.innerText = name;
        option.selected = name === power_user.instruct.preset;
        $('#instruct_presets').append(option);
    });
}

/**
 * Updates the bind model template state based on the current model, instruct and context preset.
 */
export function updateBindModelTemplatesState() {
    const bindModelTemplates = power_user.model_templates_mappings[online_status] ?? power_user.model_templates_mappings[power_user.chat_template_hash];
    const bindingsMatch = (bindModelTemplates && power_user.context.preset === bindModelTemplates.context && (!power_user.instruct.enabled || power_user.instruct.preset === bindModelTemplates.instruct)) ?? false;
    const currentState = $('#bind_model_templates').prop('checked');
    if (bindingsMatch === currentState) {
        // No change needed
        return;
    }
    $('#bind_model_templates').prop('checked', bindingsMatch);
}

/**
 * Select context template if not already selected.
 * @param {string} preset Preset name.
 * @param {object} [options={}] Optional arguments.
 * @param {boolean} [options.quiet=false] Suppress toast messages.
 * @param {boolean} [options.isAuto=false] Is auto-select.
 */
export function selectContextPreset(preset, { quiet = false, isAuto = false } = {}) {
    const presetExists = context_presets.some(x => x.name === preset);
    if (!presetExists) {
        console.warn(`Context template "${preset}" not found`);
        return;
    }

    // If context template is not already selected, select it
    if (preset !== power_user.context.preset) {
        $('#context_presets').val(preset).trigger('change');
        !quiet && toastr.info(`Context Template: "${preset}" ${isAuto ? 'auto-' : ''}selected`);
    }

    updateBindModelTemplatesState();

    saveSettingsDebounced();
}

/**
 * Select instruct preset if not already selected.
 * @param {string} preset Preset name.
 * @param {object} [options={}] Optional arguments.
 * @param {boolean} [options.quiet=false] Suppress toast messages.
 * @param {boolean} [options.isAuto=false] Is auto-select.
 */
export function selectInstructPreset(preset, { quiet = false, isAuto = false } = {}) {
    const presetExists = instruct_presets.some(x => x.name === preset);
    if (!presetExists) {
        console.warn(`Instruct template "${preset}" not found`);
        return;
    }

    // If instruct preset is not already selected, select it
    if (preset !== power_user.instruct.preset) {
        $('#instruct_presets').val(preset).trigger('change');
        !quiet && toastr.info(`Instruct Template: "${preset}" ${isAuto ? 'auto-' : ''}selected`);
    }

    // If instruct mode is disabled, enable it
    if (!power_user.instruct.enabled) {
        power_user.instruct.enabled = true;
        $('#instruct_enabled').prop('checked', true).trigger('change');
        !quiet && toastr.info('Instruct Mode enabled');
    }

    updateBindModelTemplatesState();

    saveSettingsDebounced();
}

/**
 * Automatically select instruct preset based on model id.
 * Otherwise, if default instruct preset is set, selects it.
 * @param {string} modelId Model name reported by the API.
 * @returns {boolean} True if instruct preset was activated by model id, false otherwise.
 */
export function autoSelectInstructPreset(modelId) {
    const modelTemplatesMap = power_user.model_templates_mappings[modelId];

    if (modelTemplatesMap) {
        const { instruct, context } = modelTemplatesMap;
        if (instruct) {
            selectInstructPreset(instruct, { isAuto: true });
        }
        if (context) {
            selectContextPreset(context, { isAuto: true });
        }
        return true;
    } else {
        updateBindModelTemplatesState();
    }

    // If instruct mode is disabled, don't do anything
    if (!power_user.instruct.enabled) {
        return false;
    }

    // Select matching instruct preset
    let foundMatch = false;

    for (const preset of instruct_presets) {
        // If activation regex is set, check if it matches the model id
        if (preset.activation_regex) {
            try {
                const regex = regexFromString(preset.activation_regex);

                // Stop on first match so it won't cycle back and forth between presets if multiple regexes match
                if (regex instanceof RegExp && regex.test(modelId)) {
                    selectInstructPreset(preset.name, { isAuto: true });
                    foundMatch = true;
                    break;
                }
            } catch {
                // If regex is invalid, ignore it
                console.warn(`Invalid instruct activation regex in preset "${preset.name}"`);
            }
        }
    }

    // If no match was found, auto-select instruct preset
    if (!foundMatch && power_user.instruct.bind_to_context) {
        for (const instruct_preset of instruct_presets) {
            // If instruct preset matches the context template
            if (instruct_preset.name === power_user.context.preset) {
                selectInstructPreset(instruct_preset.name, { isAuto: true });
                foundMatch = true;
                break;
            }
        }
    }

    return foundMatch;
}

/**
 * Converts instruct mode sequences to an array of stopping strings.
 * @param {Object} options
 * @param {InstructSettings?} [options.customInstruct=null] - Custom instruct settings.
 * @param {boolean?} [options.useStopStrings] - Decides whether to use "Chat Start" and "Example Separator"
 * @returns {string[]} Array of instruct mode stopping strings.
 */
export function getInstructStoppingSequences({ customInstruct = null, useStopStrings = null } = {}) {
    return getInstructStoppingSequencesPure({
        customInstruct: customInstruct ?? power_user.instruct,
        useStopStrings,
        context: power_user.context,
        substitute: substituteParams,
        name1,
        name2,
    });
}

export const force_output_sequence = FORCE_OUTPUT_SEQUENCE;

/**
 * Formats instruct mode chat message.
 * @param {string} name Character name.
 * @param {string} mes Message text.
 * @param {boolean} isUser Is the message from the user.
 * @param {boolean} isNarrator Is the message from the narrator.
 * @param {string} forceAvatar Force avatar string.
 * @param {string} name1 User name.
 * @param {string} name2 Character name.
 * @param {boolean|number} forceOutputSequence Force to use first/last output sequence (if configured).
 * @param {InstructSettings} customInstruct Custom instruct mode settings.
 * @returns {string} Formatted instruct mode chat message.
 */
export function formatInstructModeChat(name, mes, isUser, isNarrator, forceAvatar, name1, name2, forceOutputSequence, customInstruct = null) {
    return formatInstructModeChatPure({
        name, mes, isUser, isNarrator, forceAvatar, name1, name2, forceOutputSequence,
        customInstruct: customInstruct ?? power_user.instruct,
        selectedGroup: Boolean(selected_group),
        substitute: substituteParams,
    });
}

/**
 * Formats instruct mode system prompt.
 * @param {string} systemPrompt System prompt string.
 * @param {InstructSettings} _customInstruct Custom instruct mode settings.
 * @returns {string} Formatted instruct mode system prompt.
 * @deprecated Currently doesn't do anything useful.
 */
export function formatInstructModeSystemPrompt(systemPrompt, _customInstruct = null) {
    return systemPrompt || '';
}

/**
 * Formats instruct mode story string.
 * @param {string} storyString Story string and anchors
 * @param {object} [params]
 * @param {ContextSettings} [params.customContext] Custom context settings.
 * @param {InstructSettings} [params.customInstruct] Custom instruct mode settings.
 * @returns {string} Formatted instruct mode story string.
 */
export function formatInstructModeStoryString(storyString, { customContext = null, customInstruct = null } = {}) {
    return formatInstructModeStoryStringPure(storyString, {
        customContext: customContext ?? power_user.context,
        customInstruct: customInstruct ?? power_user.instruct,
        substitute: substituteParams,
    });
}

/**
 * Formats example messages according to instruct mode settings.
 * @param {string[]} mesExamplesArray Example messages array.
 * @param {string} name1 User name.
 * @param {string} name2 Character name.
 * @returns {string[]} Formatted example messages string.
 */
export function formatInstructModeExamples(mesExamplesArray, name1, name2) {
    return formatRoleplayTextExamples(mesExamplesArray, name1, name2, { instruct: power_user.instruct,
        context: power_user.context, group: Boolean(selected_group), substitute: substituteParams, parseExamples: parseExampleIntoIndividual });
}

/**
 * Formats instruct mode last prompt line.
 * @param {string} name Character name.
 * @param {boolean} isImpersonate Is generation in impersonation mode.
 * @param {string} promptBias Prompt bias string.
 * @param {string} name1 User name.
 * @param {string} name2 Character name.
 * @param {boolean} isQuiet Is quiet mode generation.
 * @param {boolean} isQuietToLoud Is quiet to loud generation.
 * @param {InstructSettings} customInstruct Custom instruct settings.
 * @returns {string} Formatted instruct mode last prompt line.
 */
export function formatInstructModePrompt(name, isImpersonate, promptBias, name1, name2, isQuiet, isQuietToLoud, customInstruct = null) {
    return formatInstructModePromptPure({
        name, isImpersonate, promptBias, name1, name2, isQuiet, isQuietToLoud,
        customInstruct: customInstruct ?? power_user.instruct,
        selectedGroup: Boolean(selected_group),
        substitute: substituteParams,
    });
}

/**
 * Select context template matching instruct preset.
 * @param {string} name Preset name.
 */
function selectMatchingContextTemplate(name) {
    for (const context_preset of context_presets) {
        // If context template matches the instruct preset
        if (context_preset.name === name) {
            selectContextPreset(context_preset.name, { isAuto: true });
            break;
        }
    }
}

/**
 * Replaces instruct mode macros in the given input string.
 * @param {Object<string, *>} env - Map of macro names to the values they'll be substituted with. If the param
 * values are functions, those functions will be called and their return values are used.
 * @returns {import('./macros.js').Macro[]} Macro objects.
 */
export function getInstructMacros(env) {
    /** @type {{ key: string,value: string, enabled: boolean }[]} */
    const instructMacros = [
        // Instruct template macros
        {
            key: 'instructStoryStringPrefix',
            value: power_user.instruct.story_string_prefix,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructStoryStringSuffix',
            value: power_user.instruct.story_string_suffix,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructInput|instructUserPrefix',
            value: power_user.instruct.input_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructUserSuffix',
            value: power_user.instruct.input_suffix,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructOutput|instructAssistantPrefix',
            value: power_user.instruct.output_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructSeparator|instructAssistantSuffix',
            value: power_user.instruct.output_suffix,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructSystemPrefix',
            value: power_user.instruct.system_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructSystemSuffix',
            value: power_user.instruct.system_suffix,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructFirstOutput|instructFirstAssistantPrefix',
            value: power_user.instruct.first_output_sequence || power_user.instruct.output_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructLastOutput|instructLastAssistantPrefix',
            value: power_user.instruct.last_output_sequence || power_user.instruct.output_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructStop',
            value: power_user.instruct.stop_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructUserFiller',
            value: power_user.instruct.user_alignment_message,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructSystemInstructionPrefix',
            value: power_user.instruct.last_system_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructFirstInput|instructFirstUserPrefix',
            value: power_user.instruct.first_input_sequence || power_user.instruct.input_sequence,
            enabled: power_user.instruct.enabled,
        },
        {
            key: 'instructLastInput|instructLastUserPrefix',
            value: power_user.instruct.last_input_sequence || power_user.instruct.input_sequence,
            enabled: power_user.instruct.enabled,
        },
        // System prompt macros
        {
            key: 'systemPrompt',
            value: power_user.prefer_character_prompt && env.charPrompt ? env.charPrompt : power_user.sysprompt.content,
            enabled: power_user.sysprompt.enabled,
        },
        {
            key: 'defaultSystemPrompt|instructSystem|instructSystemPrompt',
            value: power_user.sysprompt.content,
            enabled: power_user.sysprompt.enabled,
        },
        // Context template macros
        {
            key: 'chatSeparator',
            value: power_user.context.example_separator,
            enabled: true,
        },
        {
            key: 'chatStart',
            value: power_user.context.chat_start,
            enabled: true,
        },
    ];

    const macros = [];

    for (const { key, value, enabled } of instructMacros) {
        const regex = new RegExp(`{{(${key})}}`, 'gi');
        const replace = () => enabled ? value : '';
        macros.push({ regex, replace });
    }

    return macros;
}

jQuery(() => {
    $('#instruct_system_same_as_user').on('input', function () {
        const state = !!$(this).prop('checked');
        if (state) {
            $('#instruct_system_sequence_block').addClass('disabled');
            $('#instruct_system_suffix_block').addClass('disabled');
            $('#instruct_system_sequence').prop('readOnly', true);
            $('#instruct_system_suffix').prop('readOnly', true);
        } else {
            $('#instruct_system_sequence_block').removeClass('disabled');
            $('#instruct_system_suffix_block').removeClass('disabled');
            $('#instruct_system_sequence').prop('readOnly', false);
            $('#instruct_system_suffix').prop('readOnly', false);
        }
    });

    $('#instruct_enabled').on('change', function () {
        //color toggle for the main switch
        $('#instruct_enabled').parent().find('i').toggleClass('toggleEnabled', !!power_user.instruct.enabled);
        $('#instructSettingsBlock, #InstructSequencesColumn').toggleClass('disabled', !power_user.instruct.enabled);

        if (!power_user.instruct.bind_to_context) {
            return;
        }

        // When instruct mode gets enabled, select context template matching selected instruct preset
        if (power_user.instruct.enabled) {
            selectMatchingContextTemplate(power_user.instruct.preset);
        }
    });

    $('#instruct_derived').on('change', function () {
        $('#instruct_derived').parent().find('i').toggleClass('toggleEnabled', !!power_user.instruct_derived);
    });

    $('#instruct_bind_to_context').on('change', function () {
        $('#instruct_bind_to_context').parent().find('i').toggleClass('toggleEnabled', !!power_user.instruct.bind_to_context);
    });

    $('#instruct_presets').on('change', function () {
        const name = String($(this).find(':selected').val());
        const preset = instruct_presets.find(x => x.name === name);

        if (!preset) {
            return;
        }

        migrateInstructModeSettings(preset);

        power_user.instruct.preset = String(name);
        controls.forEach(control => {
            if (preset[control.property] !== undefined) {
                power_user.instruct[control.property] = preset[control.property];
                const $element = $(`#${control.id}`);

                if (control.isCheckbox) {
                    $element.prop('checked', power_user.instruct[control.property]).trigger('input');
                } else if ($element.is('select')) {
                    const value = power_user.instruct[control.property];
                    $element.val(value);
                    $element.filter(`[value="${value}"]`).prop('checked', true).trigger('input');
                } else {
                    $element.val(power_user.instruct[control.property]);
                    $element.trigger('input');
                }
            }
        });

        if (power_user.instruct.bind_to_context) {
            // Select matching context template
            selectMatchingContextTemplate(name);
        }

        updateBindModelTemplatesState();
    });

    if (!CSS.supports('field-sizing', 'content')) {
        $('#InstructSequencesColumn details').on('toggle', function () {
            if ($(this).prop('open')) {
                resetScrollHeight($(this).find('textarea'));
            }
        });
    }
});
