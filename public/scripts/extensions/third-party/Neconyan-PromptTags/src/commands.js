import { getSection, SECTION_IDS } from './sections.js';
import { isValidTagName } from './wrap.js';
import {
    getEditableRules,
    getSettings,
    isEnabled,
    listProfiles,
    resolveProfile,
    save,
    setActiveProfile,
    setEnabled,
} from './settings.js';

const COMMAND_ENABLE = 'prompttags';
const COMMAND_SET = 'prompttags-set';
const COMMAND_PROFILE = 'prompttags-profile';

let onChange = () => {};
let commandsRegistered = false;
let extensionActive = true;
let registeredParser = null;
const registeredCommandNames = new Set();

function usage() {
    return 'Usage: /prompttags [on|off|toggle]';
}

function profileEnumProvider(ctx) {
    return () => listProfiles().map(name => {
        if (typeof ctx.SlashCommandEnumValue === 'function') {
            return new ctx.SlashCommandEnumValue(name);
        }
        return {
            value: name,
            toString: () => name,
        };
    });
}

export function setCommandsActive(value) {
    extensionActive = !!value;
}

export function isCommandsRegistered() {
    return commandsRegistered;
}

/**
 * Registers the extension commands once the host parser is available. A failed attempt does
 * not consume the registration flag, so a later lifecycle event can retry it.
 */
export function registerCommands(refresh) {
    onChange = typeof refresh === 'function' ? refresh : () => {};

    let ctx;
    try {
        ctx = SillyTavern.getContext();
    } catch {
        return false;
    }

    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = ctx;

    if (!SlashCommandParser || !SlashCommand || !SlashCommandArgument || !SlashCommandNamedArgument || !ARGUMENT_TYPE) {
        console.warn('[Prompt Tags] Slash command API unavailable; commands not registered.');
        return false;
    }

    if (registeredParser !== SlashCommandParser) {
        registeredParser = SlashCommandParser;
        registeredCommandNames.clear();
        commandsRegistered = false;
    }

    if (commandsRegistered) {
        return true;
    }

    const registerCommand = command => {
        if (registeredCommandNames.has(command.name)) {
            return;
        }
        SlashCommandParser.addCommandObject(command);
        registeredCommandNames.add(command.name);
    };

    try {
        registerCommand(SlashCommand.fromProps({
            name: COMMAND_ENABLE,
            callback: (_named, unnamed) => {
                if (!extensionActive) {
                    return 'Prompt Tags is inactive.';
                }

                const argument = String(unnamed ?? '').trim().toLowerCase();

                if (argument === 'on') {
                    setEnabled(true);
                } else if (argument === 'off') {
                    setEnabled(false);
                } else if (argument === 'toggle' || argument === '') {
                    setEnabled(!isEnabled());
                } else {
                    return usage();
                }

                onChange();
                return String(isEnabled());
            },
            unnamedArgumentList: [
                new SlashCommandArgument('on, off or toggle', [ARGUMENT_TYPE.STRING], false, false, 'toggle', ['on', 'off', 'toggle']),
            ],
            returns: 'whether Prompt Tags is enabled',
            helpString: 'Enables, disables, or toggles Prompt Tags. With no argument, it toggles.',
        }));

        registerCommand(SlashCommand.fromProps({
            name: COMMAND_SET,
            callback: (named) => {
                if (!extensionActive) {
                    return 'Prompt Tags is inactive.';
                }

                const settings = getSettings();
                const targetProfile = String(named?.profile ?? settings.activeProfile).trim();
                const rules = getEditableRules(targetProfile);
                const id = String(named?.section ?? '').trim();

                if (!rules || !SECTION_IDS.includes(id)) {
                    return rules ? `Unknown section: ${id}` : `No such profile: ${targetProfile}`;
                }

                if (named?.tag !== undefined) {
                    const tag = String(named.tag).trim();
                    if (!isValidTagName(tag)) {
                        return `Invalid tag name: ${tag}`;
                    }
                    rules[id].tag = tag;
                    rules[id].advanced = false;
                }

                if (named?.enabled !== undefined) {
                    const enabled = String(named.enabled).toLowerCase();
                    if (enabled !== 'true' && enabled !== 'false') {
                        return 'enabled must be true or false';
                    }
                    rules[id].enabled = enabled === 'true';
                }

                save();
                onChange();
                return `${getSection(id).label}: ${rules[id].enabled ? rules[id].tag : 'disabled'}`;
            },
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'section',
                    description: 'prompt section to change',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                    enumList: SECTION_IDS,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'tag',
                    description: 'XML-style tag name for the section',
                    typeList: [ARGUMENT_TYPE.STRING],
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'enabled',
                    description: 'whether Prompt Tags wraps the section',
                    typeList: [ARGUMENT_TYPE.BOOLEAN],
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'profile',
                    description: 'profile to change (defaults to the active default profile)',
                    typeList: [ARGUMENT_TYPE.STRING],
                    enumProvider: profileEnumProvider(ctx),
                }),
            ],
            returns: 'the section name and its new state',
            helpString: 'Changes the tag name or enabled state of one section in a profile.',
        }));

        registerCommand(SlashCommand.fromProps({
            name: COMMAND_PROFILE,
            callback: (_named, unnamed) => {
                if (!extensionActive) {
                    return 'Prompt Tags is inactive.';
                }

                const name = String(unnamed ?? '').trim();
                if (!name) {
                    return resolveProfile().name;
                }
                if (!setActiveProfile(name)) {
                    return `No such profile: ${name}`;
                }
                onChange();
                return resolveProfile().name;
            },
            unnamedArgumentList: [
                new SlashCommandArgument(
                    'profile name',
                    [ARGUMENT_TYPE.STRING],
                    false,
                    false,
                    '',
                    [],
                    profileEnumProvider(ctx),
                ),
            ],
            returns: 'the effective profile name',
            helpString: 'Changes the default profile. With no argument, reports the effective profile.',
        }));
    } catch (error) {
        console.warn('[Prompt Tags] Slash command registration failed; it will be retried.', error);
        return false;
    }

    commandsRegistered = [COMMAND_ENABLE, COMMAND_SET, COMMAND_PROFILE]
        .every(name => registeredCommandNames.has(name));
    return true;
}
