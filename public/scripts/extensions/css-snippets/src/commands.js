import { findSnippetByName, isTrueFlag, readBooleanArgument, toSnippetJson } from './store.js';
import { createSnippet, deleteSnippet, getCtx, getCurrentContext, getSettings, saveSnippet } from './runtime.js';

let registered = false;

function warnMissing(args, name) {
    if (!isTrueFlag(args?.quiet)) {
        globalThis.toastr?.warning(`No such snippet: ${name}`);
    }
}

function setDisabled(args, value, isDisabled, isActive) {
    if (!isActive()) {
        return '';
    }
    const name = String(value ?? '');
    const snippet = findSnippetByName(getSettings().snippetList, name, { caseInsensitive: true });
    if (!snippet) {
        warnMissing(args, name);
        return '';
    }
    snippet.isDisabled = isDisabled;
    saveSnippet(snippet);
    return '';
}

/**
 * Registers the original `/csss*` commands once; callbacks no-op while the
 * extension is switched off.
 * @param {{ isActive: () => boolean, openManager: () => Promise<void> }} hooks
 */
export function registerCommands({ isActive, openManager }) {
    if (registered) {
        return;
    }
    const ctx = getCtx();
    const {
        SlashCommandParser,
        SlashCommand,
        SlashCommandArgument,
        SlashCommandNamedArgument,
        SlashCommandEnumValue,
        ARGUMENT_TYPE,
    } = ctx;
    if (!SlashCommandParser || !SlashCommand) {
        return;
    }
    registered = true;

    const snippetNames = () => getSettings().snippetList.map(snippet => new SlashCommandEnumValue(snippet.name));
    const quietArgument = () => SlashCommandNamedArgument.fromProps({
        name: 'quiet',
        description: 'no warning if snippet does not exist',
        typeList: [ARGUMENT_TYPE.BOOLEAN],
        defaultValue: 'false',
    });
    const booleanArgument = (name, description, defaultValue) => SlashCommandNamedArgument.fromProps({
        name,
        description,
        typeList: [ARGUMENT_TYPE.BOOLEAN],
        defaultValue,
        enumList: ['true', 'false'],
    });
    const nameArgument = description => SlashCommandArgument.fromProps({
        description,
        typeList: [ARGUMENT_TYPE.STRING],
        isRequired: true,
        enumProvider: snippetNames,
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'csss',
        callback: () => {
            if (isActive()) {
                void openManager();
            }
            return '';
        },
        helpString: 'Show the CSS Snippet Manager.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'csss-on',
        callback: (args, value) => setDisabled(args, value, false, isActive),
        namedArgumentList: [quietArgument()],
        unnamedArgumentList: [nameArgument('name of the snippet to enable')],
        helpString: 'Enable a CSS snippet.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'csss-off',
        callback: (args, value) => setDisabled(args, value, true, isActive),
        namedArgumentList: [quietArgument()],
        unnamedArgumentList: [nameArgument('name of the snippet to disable')],
        helpString: 'Disable a CSS snippet.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'csss-create',
        callback: (args, value) => {
            if (!isActive()) {
                return '';
            }
            createSnippet({
                name: String(args.name ?? ''),
                content: String(value ?? ''),
                disabled: readBooleanArgument(args.disabled, false),
                global: readBooleanArgument(args.global, true),
                theme: readBooleanArgument(args.theme, false),
            });
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'name of the snippet',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            booleanArgument('disabled', 'whether the snippet is disabled', 'false'),
            booleanArgument('global', 'whether the snippet is applied globally', 'true'),
            booleanArgument('theme', 'whether the snippet is applied to the current theme', 'false'),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'CSS content',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Create a new CSS snippet.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'csss-delete',
        callback: (args, value) => {
            if (!isActive()) {
                return '';
            }
            const name = String(value ?? '');
            const snippet = findSnippetByName(getSettings().snippetList, name);
            if (!snippet) {
                warnMissing(args, name);
                return '';
            }
            deleteSnippet(snippet);
            return '';
        },
        namedArgumentList: [quietArgument()],
        unnamedArgumentList: [nameArgument('name of the snippet to delete')],
        helpString: 'Delete a CSS snippet.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'csss-get',
        callback: (args, value) => {
            if (!isActive()) {
                return '';
            }
            const name = String(value ?? '');
            const snippet = findSnippetByName(getSettings().snippetList, name);
            if (!snippet) {
                warnMissing(args, name);
                return '';
            }
            if (isTrueFlag(args.all)) {
                return JSON.stringify(toSnippetJson(snippet));
            }
            return snippet.content;
        },
        namedArgumentList: [
            quietArgument(),
            SlashCommandNamedArgument.fromProps({
                name: 'all',
                description: 'return the full snippet as JSON instead of only the CSS',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
            }),
        ],
        unnamedArgumentList: [nameArgument('name of the snippet to get')],
        returns: 'CSS content or JSON of the snippet',
        helpString: `
            <div>Get the CSS content of a snippet, or the whole snippet as JSON with <code>all=</code>.</div>
            <div><strong>Example:</strong></div>
            <ul><li><pre><code class="language-stscript">/csss-get My Snippet |\n/echo</code></pre></li></ul>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'csss-update',
        callback: (args, value) => {
            if (!isActive()) {
                return '';
            }
            const name = String(args.name ?? '');
            let snippet = findSnippetByName(getSettings().snippetList, name);
            if (!snippet) {
                if (!isTrueFlag(args.create)) {
                    warnMissing(args, name);
                    return '';
                }
                snippet = createSnippet({ name, content: '' });
            }
            if (args.disabled !== undefined) {
                snippet.isDisabled = readBooleanArgument(args.disabled, snippet.isDisabled);
            }
            if (args.global !== undefined) {
                snippet.isGlobal = readBooleanArgument(args.global, snippet.isGlobal);
            }
            if (args.theme !== undefined) {
                const theme = getCurrentContext().theme;
                const wanted = readBooleanArgument(args.theme, false);
                if (theme && wanted && !snippet.themeList.includes(theme)) {
                    snippet.themeList.push(theme);
                } else if (theme && !wanted) {
                    snippet.themeList = snippet.themeList.filter(item => item !== theme);
                }
            }
            const content = String(value ?? '');
            if (content.trim().length) {
                snippet.content = content;
            }
            saveSnippet(snippet);
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'name of the snippet',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: snippetNames,
            }),
            SlashCommandNamedArgument.fromProps({ name: 'disabled', description: 'whether the snippet is disabled', typeList: [ARGUMENT_TYPE.BOOLEAN], enumList: ['true', 'false'] }),
            SlashCommandNamedArgument.fromProps({ name: 'global', description: 'whether the snippet is applied globally', typeList: [ARGUMENT_TYPE.BOOLEAN], enumList: ['true', 'false'] }),
            SlashCommandNamedArgument.fromProps({ name: 'theme', description: 'whether the snippet is applied to the current theme', typeList: [ARGUMENT_TYPE.BOOLEAN], enumList: ['true', 'false'] }),
            booleanArgument('create', 'create the snippet if it does not exist', 'false'),
            quietArgument(),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'CSS content (leave empty to keep the current CSS)',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: 'Update an existing CSS snippet.',
    }));
}
