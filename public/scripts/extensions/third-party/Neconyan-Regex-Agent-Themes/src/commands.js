/**
 * Slash commands. Objects are retained so live deactivation can remove only registry
 * entries still owned by this extension. Every callback is gated too, because a parsed
 * command closure can outlive its registry entry.
 */

import { STOCK_THEME } from './constants.js';
import { THEMABLE_TEMPLATE_IDS } from './specs.js';
import { THEMES } from './themes/index.js';
import { getSettings, updateSettings } from './settings.js';
import { applyAll, inspectAgent, themableAgents } from './apply.js';
import { getContext, loadHost } from './host.js';
import { STATUS_LABELS, TEMPLATE_LABELS } from './ui.js';

const registeredCommands = [];
let commandParser = null;
let active = false;

function themeSlugs(settings = getSettings()) {
    return [
        STOCK_THEME,
        ...THEMES.map(theme => theme.slug),
        ...Object.keys(settings.customThemes),
    ];
}

function summarizeResult(result) {
    if (!result?.ok) {
        return String(result?.reason ?? 'failed');
    }

    const parts = [];
    if (result.applied) parts.push(`${result.applied} themed`);
    if (result.reverted) parts.push(`${result.reverted} restored`);
    if (result.unchanged) parts.push(`${result.unchanged} unchanged`);
    if (result.blocked?.length) {
        parts.push(`blocked: ${result.blocked.map(item => item.agentName ?? item.agentId).join(', ')}`);
    }
    if (result.failed?.length) {
        parts.push(`failed: ${result.failed.map(item => item.agentName ?? item.agentId).join(', ')}`);
    }
    return parts.join('; ') || 'no compatible trackers changed';
}

function guarded(callback) {
    return async (...args) => {
        if (!active) {
            return 'Regex Agent Themes is disabled.';
        }
        return callback(...args);
    };
}

export function unregisterCommands() {
    active = false;
    for (const command of registeredCommands.splice(0)) {
        for (const name of [command.name, ...(command.aliases ?? [])]) {
            if (commandParser?.commands?.[name] === command) {
                delete commandParser.commands[name];
            }
        }
    }
    commandParser = null;
}

export function registerCommands(onChange = () => {}) {
    unregisterCommands();
    const context = getContext();
    const parser = context?.SlashCommandParser;
    const SlashCommand = context?.SlashCommand;
    const SlashCommandArgument = context?.SlashCommandArgument;
    const SlashCommandNamedArgument = context?.SlashCommandNamedArgument;
    const SlashCommandEnumValue = context?.SlashCommandEnumValue;
    const ARGUMENT_TYPE = context?.ARGUMENT_TYPE;

    if (!parser || !SlashCommand || !SlashCommandArgument || !ARGUMENT_TYPE) {
        return false;
    }

    const enumProvider = SlashCommandEnumValue
        ? () => themeSlugs().map(slug => new SlashCommandEnumValue(slug))
        : null;
    const commands = [];
    const command = props => SlashCommand.fromProps({
        ...props,
        callback: guarded(props.callback),
    });

    commands.push(command({
        name: 'rat-theme',
        helpString: 'Show or set the global tracker theme.',
        returns: 'the active theme slug',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'theme slug, or "stock"',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumList: themeSlugs(),
                enumProvider,
            }),
        ],
        callback: async (_named, unnamed) => {
            const slug = String(unnamed ?? '').trim();
            if (!slug) {
                return getSettings().theme;
            }
            if (!themeSlugs().includes(slug)) {
                return `unknown theme: ${slug}`;
            }
            updateSettings({ theme: slug });
            const result = await applyAll();
            if (active) onChange();
            return `${slug}; ${summarizeResult(result)}`;
        },
    }));

    commands.push(command({
        name: 'rat-theme-tracker',
        helpString: 'Set or clear one tracker\'s theme.',
        returns: 'the theme now set for that tracker',
        namedArgumentList: SlashCommandNamedArgument
            ? [
                SlashCommandNamedArgument.fromProps({
                    name: 'tracker',
                    description: 'which tracker',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                    enumList: THEMABLE_TEMPLATE_IDS,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'theme',
                    description: 'theme slug, or empty to use the global theme',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                    enumList: themeSlugs(),
                    enumProvider,
                }),
            ]
            : [],
        callback: async (named) => {
            const templateId = String(named?.tracker ?? '');
            if (!THEMABLE_TEMPLATE_IDS.includes(templateId)) {
                return `unknown tracker: ${templateId}`;
            }
            const slug = String(named?.theme ?? '').trim();
            if (slug && !themeSlugs().includes(slug)) {
                return `unknown theme: ${slug}`;
            }
            const settings = getSettings();
            const overrides = { ...settings.overrides };
            if (slug) {
                overrides[templateId] = slug;
            } else {
                delete overrides[templateId];
            }
            updateSettings({ overrides });
            const result = await applyAll();
            if (active) onChange();
            return `${slug || 'inherit'}; ${summarizeResult(result)}`;
        },
    }));

    commands.push(command({
        name: 'rat-apply',
        helpString: 'Re-apply the current theme to every tracker.',
        returns: 'how many trackers changed',
        callback: async () => {
            const result = await applyAll();
            if (active) onChange();
            return summarizeResult(result);
        },
    }));

    commands.push(command({
        name: 'rat-revert',
        helpString: 'Put every tracker back to stock.',
        returns: 'how many trackers were reverted',
        callback: async () => {
            updateSettings({ theme: STOCK_THEME, overrides: {} });
            const result = await applyAll();
            if (active) onChange();
            return summarizeResult(result);
        },
    }));

    commands.push(command({
        name: 'rat-status',
        helpString: "List each tracker's theme and state.",
        returns: 'one line per tracker',
        callback: async () => {
            const host = await loadHost();
            if (!host.ok) {
                return host.reason;
            }
            const settings = getSettings();
            const lines = themableAgents(host.store.getAgents() ?? []).map(agent => {
                const report = inspectAgent(agent, settings);
                const label = TEMPLATE_LABELS[report.templateId] ?? report.templateId;
                const status = STATUS_LABELS[report.status] ?? report.status;
                return `${label}: ${report.themeSlug} (${status})`;
            });
            return lines.length ? lines.join('\n') : 'no themable agents installed';
        },
    }));

    const names = commands.flatMap(item => [item.name, ...(item.aliases ?? [])]);
    if (names.some(name => parser.commands?.[name])) {
        console.error('Regex Agent Themes could not register slash commands: name collision');
        return false;
    }

    commandParser = parser;
    try {
        for (const item of commands) {
            parser.addCommandObject(item);
            registeredCommands.push(item);
        }
        active = true;
        return true;
    } catch (error) {
        unregisterCommands();
        console.error('Regex Agent Themes could not register slash commands', error);
        return false;
    }
}
