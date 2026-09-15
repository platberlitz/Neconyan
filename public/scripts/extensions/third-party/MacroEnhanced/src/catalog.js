/**
 * The documentation catalogue.
 *
 * Every macro this extension registers already carries its own documentation --
 * a description, an argument list with per-argument explanations, and worked
 * examples -- because the engine registry accepts all of it. That metadata is
 * handed over at registration and never read back, so it only ever surfaces in
 * the host's `/help macros`.
 *
 * This module captures it on the way past, at the single funnel every macro
 * goes through (safeRegister). Reading it back off the registry instead would
 * lose half of it: the registry keeps name/category/description/unnamedArgs and
 * drops exampleUsage, returns, returnType and the behaviour flags.
 *
 * Data only -- no Neconyan imports, no DOM.
 */

/** @type {Map<string, object>} lowercased registered name -> catalogue entry */
const entries = new Map();

/**
 * Records a successful registration. Called from safeRegister once the engine
 * has accepted the macro, so the catalogue only ever describes live macros.
 *
 * @param {object} params
 * @param {string} params.requested - The name the extension asked for.
 * @param {string} params.actual - The name actually registered (differs on collision).
 * @param {object} params.options - The MacroDefinitionOptions handed to the registry.
 */
export function recordMacro({ requested, actual, options = {} }) {
    // `handler` is a closure over engine internals; the catalogue is data only.
    const { handler, aliases, ...rest } = options;
    entries.set(String(actual).toLowerCase(), {
        ...rest,
        name: actual,
        requested,
        renamed: actual !== requested,
        // Hidden aliases (the me-* namespace) are an implementation detail; the
        // reference only shows the ones the engine itself would advertise.
        aliases: (aliases ?? []).filter(alias => alias?.visible !== false).map(alias => alias.alias),
        unnamedArgs: Array.isArray(rest.unnamedArgs) ? rest.unnamedArgs : [],
        exampleUsage: Array.isArray(rest.exampleUsage) ? rest.exampleUsage : [],
    });
}

/**
 * Drops an entry. Custom macros unregister and re-register on every edit, so
 * this keeps the reference from showing a stale definition.
 *
 * @param {string} name - The registered name (either case).
 */
export function forgetMacro(name) {
    entries.delete(String(name).toLowerCase());
}

/** Empties the catalogue (extension teardown). */
export function clearCatalog() {
    entries.clear();
}

/**
 * Every documented macro, sorted by category then name -- the order the
 * reference renders them in.
 *
 * @returns {object[]}
 */
export function getMacroCatalog() {
    return [...entries.values()].sort((a, b) =>
        a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/**
 * One macro's documentation, by registered name.
 *
 * @param {string} name
 * @returns {object|undefined}
 */
export function getMacroDoc(name) {
    return entries.get(String(name).toLowerCase());
}

/**
 * The call signature to show in the reference: `{{name::arg::arg}}`.
 * Optional arguments are wrapped in brackets so a glance tells you what is
 * required, while the examples stay copy-pasteable.
 *
 * @param {object} entry - A catalogue entry.
 * @returns {string}
 */
export function macroSignature(entry) {
    const args = (entry.unnamedArgs ?? []).map(arg =>
        (arg.optional ? `::[${arg.name}]` : `::${arg.name}`)).join('');
    const rest = entry.list ? '::…' : '';
    return `{{${entry.name}${args}${rest}}}`;
}

// ---- slash commands ----------------------------------------------------
// Same idea, same reason: each command is built with a helpString the host only
// shows under `/help slash`. Captured at the registerCommand wrapper.

/** @type {Map<string, object>} command name -> documentation */
const commandDocs = new Map();

/** Normalises a host SlashCommandArgument into plain data. */
function commandArg(arg, named) {
    const enums = (arg?.enumList ?? [])
        .map(value => (typeof value === 'string' ? value : value?.value))
        .filter(Boolean);
    return {
        name: arg?.name ?? '',
        named,
        description: arg?.description ?? '',
        required: !!arg?.isRequired,
        defaultValue: arg?.defaultValue ?? undefined,
        enums,
    };
}

/**
 * Records a slash command's documentation.
 *
 * @param {object} command - The host SlashCommand object being registered.
 */
export function recordCommand(command) {
    if (!command?.name) {
        return;
    }
    commandDocs.set(command.name, {
        name: command.name,
        helpString: command.helpString ?? '',
        returns: command.returns ?? '',
        args: [
            ...(command.namedArgumentList ?? []).map(arg => commandArg(arg, true)),
            ...(command.unnamedArgumentList ?? []).map(arg => commandArg(arg, false)),
        ],
    });
}

/** Empties the command documentation (the host parser was swapped out). */
export function clearCommandDocs() {
    commandDocs.clear();
}

/** Every documented slash command, in registration order. */
export function getCommandDocs() {
    return [...commandDocs.values()];
}
