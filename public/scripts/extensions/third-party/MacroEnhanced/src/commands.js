import { isEngineAvailable } from './engine-gate.js';
import { getRegisteredNames } from './registration.js';
import { getChatState, touchChatState } from './chat-state.js';
import { findEntry } from './lorebook-cache.js';
import { truncateText } from './utility-impl.js';
import { SCOPE_CHARACTER, SCOPE_CHAT, SCOPE_GLOBAL, createDef, getAllCustomNames, getCharacterDefs, getChatDefs, getGlobalDefs, saveCharacterDefs, saveChatDefs, saveGlobalDefs, validateDef } from './custom/store.js';
import { getRegisteredCustomNames, syncRegistrations } from './custom/registrar.js';
import { createSandbox } from './workbench/sandbox.js';
import { openWorkbench } from './workbench/panel.js';
import { formatAuditReport, runAudit } from './auditor/audit.js';
import { exportPack } from './custom/pack.js';
import { clearCommandDocs, recordCommand } from './catalog.js';

let commandsRegistered = false;
let extensionActive = true;
let registeredParser = null;
const registeredCommandNames = new Set();

export function setCommandsActive(value) {
    extensionActive = !!value;
}

const INACTIVE = 'Macro Enhanced is inactive.';
const ENGINE_OFF = 'Macro Enhanced needs the Experimental Macro Engine enabled (User Settings → Experimental Macro Engine).';

function evaluateWithEngine(text, dynamicMacros = {}, extra = null) {
    const ctx = SillyTavern.getContext();
    const env = ctx.macros.envBuilder.buildFromRawEnv({
        content: text,
        replaceCharacterCard: true,
        dynamicMacros,
        postProcessFn: (x) => x,
    });
    if (extra) {
        env.extra = { ...(env.extra ?? {}), ...extra };
    }
    return ctx.macros.engine.evaluate(text, env);
}

/**
 * Registers the slash commands. Retried from lifecycle events; a failed attempt
 * does not consume the flag (PromptTags pattern).
 */
export function registerCommands() {
    let ctx;
    try {
        ctx = SillyTavern.getContext();
    } catch {
        return false;
    }

    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = ctx;
    if (!SlashCommandParser || !SlashCommand || !SlashCommandArgument || !SlashCommandNamedArgument || !ARGUMENT_TYPE) {
        console.warn('[Macro Enhanced] Slash command API unavailable; commands not registered.');
        return false;
    }

    if (registeredParser !== SlashCommandParser) {
        registeredParser = SlashCommandParser;
        registeredCommandNames.clear();
        clearCommandDocs();
        commandsRegistered = false;
    }
    if (commandsRegistered) {
        return true;
    }

    const registerCommand = (command) => {
        if (registeredCommandNames.has(command.name)) {
            return;
        }
        SlashCommandParser.addCommandObject(command);
        registeredCommandNames.add(command.name);
        recordCommand(command);
    };

    try {
        registerCommand(SlashCommand.fromProps({
            name: 'me-workbench',
            callback: () => {
                if (!extensionActive) {
                    return INACTIVE;
                }
                if (!isEngineAvailable()) {
                    return ENGINE_OFF;
                }
                openWorkbench();
                return '';
            },
            helpString: 'Opens the Macro Workbench: a sandboxed playground to preview macro text without changing real variables.',
        }));

        registerCommand(SlashCommand.fromProps({
            name: 'me-eval',
            callback: (named, unnamed) => {
                if (!extensionActive) {
                    return INACTIVE;
                }
                if (!isEngineAvailable()) {
                    return ENGINE_OFF;
                }
                const text = String(unnamed ?? '');
                if (!text) {
                    return '';
                }
                const sandboxed = String(named?.sandbox ?? 'true').toLowerCase() !== 'false';
                if (!sandboxed) {
                    return evaluateWithEngine(text);
                }
                const liveCtx = SillyTavern.getContext();
                const sandbox = createSandbox({
                    getLocalStore: () => liveCtx.chatMetadata?.variables ?? {},
                    getGlobalStore: () => liveCtx.extensionSettings?.variables?.global ?? {},
                    getChatState: () => getChatState(),
                });
                return sandbox.run(
                    (input, dynamicMacros) => evaluateWithEngine(input, dynamicMacros, { meSandboxState: sandbox.chatState }),
                    text);
            },
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'sandbox',
                    description: 'Set to false to let variable changes apply for real.',
                    typeList: [ARGUMENT_TYPE.BOOLEAN],
                    defaultValue: 'true',
                    isRequired: false,
                }),
            ],
            unnamedArgumentList: [
                new SlashCommandArgument('the text to evaluate', [ARGUMENT_TYPE.STRING], true, false),
            ],
            returns: 'the text with all macros resolved',
            helpString: 'Evaluates text through the macro engine. Sandboxed by default: variable macros do not change real variables. Example: <code>/me-eval {{calc::2^10}}</code>',
        }));

        registerCommand(SlashCommand.fromProps({
            name: 'me-lore',
            callback: (named, unnamed) => {
                if (!extensionActive) {
                    return INACTIVE;
                }
                const liveCtx = SillyTavern.getContext();
                const entryName = String(unnamed ?? '').trim();
                if (!entryName) {
                    return 'Usage: /me-lore [book=name] entry title';
                }
                const bookName = named?.book ? String(named.book) : undefined;
                const { entry, missing } = findEntry(liveCtx, entryName, bookName);
                if (!entry) {
                    return missing.length
                        ? `Lorebook(s) still loading: ${missing.join(', ')}. try again.`
                        : `No entry named "${entryName}" found.`;
                }
                return String(entry.content ?? '');
            },
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'book',
                    description: 'A specific lorebook name.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
            ],
            unnamedArgumentList: [
                new SlashCommandArgument('entry title or uid', [ARGUMENT_TYPE.STRING], true, false),
            ],
            returns: 'the raw content of the lorebook entry',
            helpString: 'Returns a lorebook entry\'s content. Example: <code>/me-lore Backstory</code>',
        }));

        registerCommand(SlashCommand.fromProps({
            name: 'me-unfreeze',
            callback: (named, unnamed) => {
                if (!extensionActive) {
                    return INACTIVE;
                }
                const state = getChatState();
                if (!state) {
                    return 'No chat is loaded.';
                }
                // kind label (user-facing) -> property on the chat state.
                const kinds = { freeze: 'frozen', sticky: 'sticky', daily: 'daily', roll: 'rolls' };
                if (String(named?.all ?? '').toLowerCase() === 'true') {
                    let cleared = 0;
                    for (const prop of Object.values(kinds)) {
                        cleared += Object.keys(state[prop] ?? {}).length;
                        state[prop] = {};
                    }
                    touchChatState();
                    return `Cleared ${cleared} stored value${cleared === 1 ? '' : 's'} in this chat.`;
                }
                const key = String(named?.key ?? unnamed ?? '').trim();
                if (!key) {
                    const lines = [];
                    for (const [label, prop] of Object.entries(kinds)) {
                        const entries = Object.entries(state[prop] ?? {});
                        if (entries.length) {
                            lines.push(`${label}: ${entries.map(([entryKey, entry]) =>
                                `${entryKey} = ${truncateText(String(entry?.value ?? ''), 40)}`).join(' | ')}`);
                        }
                    }
                    return lines.length ? lines.join('\n') : 'Nothing is frozen in this chat.';
                }
                const kindArg = String(named?.kind ?? 'any').toLowerCase();
                let removed = 0;
                for (const [label, prop] of Object.entries(kinds)) {
                    if (kindArg !== 'any' && kindArg !== label) {
                        continue;
                    }
                    if (state[prop] && Object.hasOwn(state[prop], key)) {
                        delete state[prop][key];
                        removed++;
                    }
                }
                if (removed) {
                    touchChatState();
                    return `Unfroze "${key}". it will re-evaluate next time.`;
                }
                return `No stored value named "${key}" in this chat.`;
            },
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'key',
                    description: 'The stored key to remove (same as the unnamed argument).',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'kind',
                    description: 'Limit to one kind: freeze, sticky, daily or roll.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    defaultValue: 'any',
                    enumList: ['any', 'freeze', 'sticky', 'daily', 'roll'],
                    isRequired: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'all',
                    description: 'Set to true to clear every stored value in this chat.',
                    typeList: [ARGUMENT_TYPE.BOOLEAN],
                    defaultValue: 'false',
                    isRequired: false,
                }),
            ],
            unnamedArgumentList: [
                new SlashCommandArgument('the stored key to remove (leave empty to list everything)', [ARGUMENT_TYPE.STRING], false, false),
            ],
            returns: 'a confirmation, or the list of stored values',
            helpString: 'Lists or removes values saved by {{freeze}}, {{sticky}}, {{daily}} and {{rollonce}} in this chat. Examples: <code>/me-unfreeze</code>, <code>/me-unfreeze opening-weather</code>, <code>/me-unfreeze all=true</code>',
        }));

        registerCommand(SlashCommand.fromProps({
            name: 'me-chatvar',
            callback: (named, unnamed) => {
                if (!extensionActive) {
                    return INACTIVE;
                }
                const state = getChatState();
                if (!state) {
                    return 'No chat is loaded.';
                }
                const vars = state.chatVars ?? {};
                const key = String(named?.key ?? unnamed ?? '').trim();

                if (String(named?.delete ?? '').toLowerCase() === 'true') {
                    if (!key) {
                        return 'Name which chat variable to delete.';
                    }
                    if (!Object.hasOwn(vars, key)) {
                        return `No chat variable named "${key}".`;
                    }
                    delete vars[key];
                    touchChatState();
                    return `Deleted chat variable "${key}".`;
                }

                if (named?.value !== undefined) {
                    if (!key) {
                        return 'Name which chat variable to set.';
                    }
                    vars[key] = String(named.value);
                    touchChatState();
                    return `Set "${key}" to ${truncateText(String(named.value), 40)}.`;
                }

                if (key) {
                    return Object.hasOwn(vars, key) ? String(vars[key]) : '';
                }

                const prefix = String(named?.prefix ?? '');
                const entries = Object.entries(vars)
                    .filter(([name]) => name.startsWith(prefix))
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
                if (!entries.length) {
                    return prefix
                        ? `No chat variables start with "${prefix}".`
                        : 'No chat variables are set in this chat.';
                }
                return entries.map(([name, value]) => `${name} = ${truncateText(String(value), 60)}`).join('\n');
            },
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'key',
                    description: 'The chat variable to read, set or delete (same as the unnamed argument).',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'value',
                    description: 'Set the chat variable to this value.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'prefix',
                    description: 'When listing, show only names starting with this.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'delete',
                    description: 'Set to true to remove the named chat variable.',
                    typeList: [ARGUMENT_TYPE.BOOLEAN],
                    defaultValue: 'false',
                    isRequired: false,
                }),
            ],
            unnamedArgumentList: [
                new SlashCommandArgument('the chat variable to read (leave empty to list them all)', [ARGUMENT_TYPE.STRING], false, false),
            ],
            returns: 'the value, the list of chat variables, or a confirmation',
            helpString: 'Reads, sets, lists or deletes the chat variables used by {{setchatvar}} and {{foreachChatVar}}. These are a separate store from the host\'s own chat variables, so the built-in /getchatvar does not see them. Examples: <code>/me-chatvar</code>, <code>/me-chatvar prefix=satiety_</code>, <code>/me-chatvar key=day value=3</code>, <code>/me-chatvar key=satiety_ren delete=true</code>',
        }));

        registerCommand(SlashCommand.fromProps({
            name: 'me-audit',
            callback: async () => {
                if (!extensionActive) {
                    return INACTIVE;
                }
                let sandboxEvaluate;
                if (isEngineAvailable()) {
                    const liveCtx = SillyTavern.getContext();
                    const sandbox = createSandbox({
                        getLocalStore: () => liveCtx.chatMetadata?.variables ?? {},
                        getGlobalStore: () => liveCtx.extensionSettings?.variables?.global ?? {},
                        getChatState: () => getChatState(),
                    });
                    sandboxEvaluate = (text) => sandbox.run(
                        (input, dynamicMacros) => evaluateWithEngine(input, dynamicMacros, { meSandboxState: sandbox.chatState }),
                        text);
                }
                const report = await runAudit({ sandboxEvaluate });
                return formatAuditReport(report);
            },
            returns: 'a cache-audit report',
            helpString: 'Scans presets, character card, persona, lorebooks and recent chat for macros that break the prompt-caching discount. Same report as the Workbench\'s Cache Audit tab.',
        }));

        registerCommand(SlashCommand.fromProps({
            name: 'me-define',
            callback: async (named, unnamed) => {
                if (!extensionActive) {
                    return INACTIVE;
                }
                const liveCtx = SillyTavern.getContext();
                const name = String(named?.name ?? '').trim();
                const template = String(unnamed ?? '');
                if (!name || !template) {
                    return 'Usage: /me-define name=mymacro [args=a,b] [scope=global|character|chat] the template text';
                }
                const scopeRaw = String(named?.scope ?? SCOPE_GLOBAL).toLowerCase();
                const scope = [SCOPE_GLOBAL, SCOPE_CHARACTER, SCOPE_CHAT].includes(scopeRaw) ? scopeRaw : SCOPE_GLOBAL;
                const args = String(named?.args ?? '').split(',').map(part => part.trim()).filter(Boolean)
                    .map(argName => ({ name: argName, optional: false }));

                const defs = scope === SCOPE_CHARACTER ? getCharacterDefs()
                    : scope === SCOPE_CHAT ? getChatDefs() : getGlobalDefs();
                const existing = defs.find(def => def.name.toLowerCase() === name.toLowerCase());
                const def = createDef({ ...(existing ?? {}), name, template, args });

                const siblings = defs.filter(other => other.id !== def.id);
                const errors = validateDef(def, { siblings, registry: liveCtx.macros?.registry, customNames: getAllCustomNames() })
                    .filter(problem => !(existing && problem.includes('already exists')));
                if (errors.length) {
                    return errors.join(' ');
                }

                const nextDefs = [...siblings, def];
                if (scope === SCOPE_CHARACTER) {
                    if (liveCtx.characterId === undefined || liveCtx.characterId === null) {
                        return 'Open a character chat first to save a character-scoped macro.';
                    }
                    await saveCharacterDefs(nextDefs);
                } else if (scope === SCOPE_CHAT) {
                    if (liveCtx.chatId === undefined || liveCtx.chatId === null) {
                        return 'Open a chat first to save a chat-scoped macro.';
                    }
                    saveChatDefs(nextDefs);
                } else {
                    saveGlobalDefs(nextDefs);
                }
                syncRegistrations();
                return `Macro {{${name}}} ${existing ? 'updated' : 'created'} (${scope}).`;
            },
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'name',
                    description: 'The macro name (used as {{name}}).',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'args',
                    description: 'Comma-separated argument names.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'scope',
                    description: 'global (default), character, or chat (this chat only).',
                    typeList: [ARGUMENT_TYPE.STRING],
                    defaultValue: SCOPE_GLOBAL,
                    enumList: [SCOPE_GLOBAL, SCOPE_CHARACTER, SCOPE_CHAT],
                    isRequired: false,
                }),
            ],
            unnamedArgumentList: [
                new SlashCommandArgument('the template the macro expands to', [ARGUMENT_TYPE.STRING], true, false),
            ],
            returns: 'a confirmation message',
            helpString: 'Creates or updates a custom macro. Example: <code>/me-define name=greet args=who Hello {{who}}, it is {{time}}!</code>',
        }));

        registerCommand(SlashCommand.fromProps({
            name: 'me-undefine',
            callback: async (_named, unnamed) => {
                if (!extensionActive) {
                    return INACTIVE;
                }
                const name = String(unnamed ?? '').trim().toLowerCase();
                if (!name) {
                    return 'Usage: /me-undefine name';
                }
                const globals = getGlobalDefs();
                const characterDefs = getCharacterDefs();
                const chatDefs = getChatDefs();
                let removed = false;
                if (globals.some(def => def.name.toLowerCase() === name)) {
                    saveGlobalDefs(globals.filter(def => def.name.toLowerCase() !== name));
                    removed = true;
                }
                if (characterDefs.some(def => def.name.toLowerCase() === name)) {
                    await saveCharacterDefs(characterDefs.filter(def => def.name.toLowerCase() !== name));
                    removed = true;
                }
                if (chatDefs.some(def => def.name.toLowerCase() === name)) {
                    saveChatDefs(chatDefs.filter(def => def.name.toLowerCase() !== name));
                    removed = true;
                }
                syncRegistrations();
                return removed ? `Macro {{${name}}} removed.` : `No custom macro named {{${name}}}.`;
            },
            unnamedArgumentList: [
                new SlashCommandArgument('the macro name to remove', [ARGUMENT_TYPE.STRING], true, false),
            ],
            returns: 'a confirmation message',
            helpString: 'Removes a custom macro (from every scope it appears in).',
        }));

        registerCommand(SlashCommand.fromProps({
            name: 'me-export',
            callback: (named) => {
                if (!extensionActive) {
                    return INACTIVE;
                }
                const scopeRaw = String(named?.scope ?? SCOPE_GLOBAL).toLowerCase();
                const defs = scopeRaw === SCOPE_CHARACTER ? getCharacterDefs()
                    : scopeRaw === SCOPE_CHAT ? getChatDefs() : getGlobalDefs();
                if (!defs.length) {
                    return `No custom macros in the ${scopeRaw} scope.`;
                }
                return JSON.stringify(exportPack(defs, { exportedAt: new Date().toISOString() }), null, 2);
            },
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'scope',
                    description: 'global (default), character, or chat.',
                    typeList: [ARGUMENT_TYPE.STRING],
                    defaultValue: SCOPE_GLOBAL,
                    enumList: [SCOPE_GLOBAL, SCOPE_CHARACTER, SCOPE_CHAT],
                    isRequired: false,
                }),
            ],
            returns: 'the scope\'s custom macros as shareable pack JSON',
            helpString: 'Exports custom macros as pack JSON (the drawer has matching file download/upload buttons).',
        }));

        registerCommand(SlashCommand.fromProps({
            name: 'me-macros',
            callback: () => {
                if (!extensionActive) {
                    return INACTIVE;
                }
                const names = getRegisteredNames().sort();
                const custom = getRegisteredCustomNames().sort();
                return [
                    `Registered (${names.length}): ${names.map(name => `{{${name}}}`).join(', ')}`,
                    custom.length ? `Custom (${custom.length}): ${custom.map(name => `{{${name}}}`).join(', ')}` : '',
                ].filter(Boolean).join('\n');
            },
            returns: 'the names of all macros this extension registered',
            helpString: 'Lists every macro Macro Enhanced has registered (debug aid).',
        }));

        commandsRegistered = true;
        return true;
    } catch (error) {
        console.error('[Macro Enhanced] Failed to register slash commands.', error);
        return false;
    }
}
