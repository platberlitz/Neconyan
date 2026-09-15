/**
 * Chat variables: a persistent per-chat key/value store with a prefix loop.
 *
 * Deliberately NOT the host's chat_metadata.variables, even though the host's
 * {{setvar}} is already chat-scoped and its /setchatvar slash command is an alias
 * for exactly that store. Content that uses {{foreachChatVar::satiety_::p}} also
 * uses {{setvar}} for scratch values, and those scratch keys share the prefixes
 * being iterated ("satiety_food_value" is a real example). sharing one namespace
 * would render scratch values as loop items. These live in the extension's own
 * chat state instead, so the two never collide.
 */
import { safeRegister } from './registration.js';
import { getChatState, touchChatState } from './chat-state.js';
import {
    CHAT_VAR_ENTRIES_WARN_AT,
    addChatVarValue,
    capChatVarValue,
    chatVarEntries,
    isValidChatVarKey,
    isValidLoopAlias,
    loopVarNames,
    normalizeChatVarKey,
} from './chatvar-impl.js';

export const CATEGORY_CHATVAR = 'enhanced-chatvar';

/**
 * Chat-var macros that WRITE persistent chat state. Like the state macros, each
 * must honour env.extra.meSandboxState so the Workbench never touches real data.
 */
export const CHATVAR_MACRO_NAMES = Object.freeze([
    'setchatvar', 'addchatvar', 'deletechatvar', 'foreachchatvar',
]);

/** Every chat-var macro, writers and readers alike. used by the sandbox and auditor. */
export const CHATVAR_ALL_MACRO_NAMES = Object.freeze([
    'setchatvar', 'getchatvar', 'haschatvar', 'deletechatvar', 'addchatvar', 'foreachchatvar',
]);

/** In-flight {{foreachChatVar}} prefixes, so a body that loops itself stops. */
const looping = new Set();

/** Test hook. */
export function resetChatVarRecursion() {
    looping.clear();
}

/** Sandboxed state (Workbench overlay) when present, else the real chat state. */
function resolveState(env) {
    const sandboxState = env?.extra?.meSandboxState;
    if (sandboxState) {
        return { state: sandboxState, sandboxed: true };
    }
    return { state: getChatState(), sandboxed: false };
}

/** The chatVars map to read/write, or null when there is nowhere to persist. */
function resolveVars(env) {
    const { state, sandboxed } = resolveState(env);
    if (!state) {
        return { vars: null, sandboxed };
    }
    if (!state.chatVars || typeof state.chatVars !== 'object') {
        state.chatVars = {};
    }
    return { vars: state.chatVars, sandboxed };
}

function persist(sandboxed) {
    if (!sandboxed) {
        touchChatState();
    }
}

/** Resolves and validates a key argument, warning once on the way out. */
function readKey(ctx, rawKey, macroName) {
    const key = normalizeChatVarKey(rawKey);
    if (!key) {
        ctx.warn(`{{${macroName}}}: the name is empty.`);
        return null;
    }
    if (!isValidChatVarKey(key)) {
        ctx.warn(`{{${macroName}}}: "${key}" is not a valid chat variable name.`);
        return null;
    }
    return key;
}

export function registerChatVarMacros() {
    safeRegister('setchatvar', {
        category: CATEGORY_CHATVAR,
        unnamedArgs: [
            { name: 'name', description: 'The chat variable to write.' },
            { name: 'value', description: 'The value to store.' },
        ],
        description: 'Stores a value in a chat variable, which persists in this chat only. Writes nothing to the prompt. Separate from {{setvar}}, so loop prefixes never collide with scratch values.',
        returns: 'nothing',
        exampleUsage: ['{{setchatvar::current_location::Forest}}'],
        handler: (ctx) => {
            const [rawKey, rawValue] = ctx.unnamedArgs;
            const key = readKey(ctx, rawKey, 'setchatvar');
            if (!key) {
                return '';
            }
            const { vars, sandboxed } = resolveVars(ctx.env);
            if (!vars) {
                ctx.warn('{{setchatvar}}: no chat is loaded, so there is nowhere to store it.');
                return '';
            }
            const { value, truncated } = capChatVarValue(rawValue);
            if (truncated) {
                ctx.warn(`{{setchatvar}}: "${key}" was longer than the limit and has been cut.`);
            }
            vars[key] = value;
            if (Object.keys(vars).length > CHAT_VAR_ENTRIES_WARN_AT) {
                ctx.warn(`This chat now has over ${CHAT_VAR_ENTRIES_WARN_AT} chat variables.`);
            }
            persist(sandboxed);
            return '';
        },
    });

    safeRegister('getchatvar', {
        category: CATEGORY_CHATVAR,
        unnamedArgs: [
            { name: 'name', description: 'The chat variable to read.' },
            { name: 'fallback', optional: true, defaultValue: '', description: 'Returned when the variable is not set.' },
        ],
        description: 'Reads a chat variable. Returns the fallback (or nothing) when it has never been set.',
        returns: 'the stored value',
        exampleUsage: ['{{getchatvar::current_location}}', '{{getchatvar::day::1}}'],
        handler: (ctx) => {
            const [rawKey, fallback = ''] = ctx.unnamedArgs;
            const key = readKey(ctx, rawKey, 'getchatvar');
            if (!key) {
                return String(fallback ?? '');
            }
            const { vars } = resolveVars(ctx.env);
            if (!vars || !Object.hasOwn(vars, key)) {
                return String(fallback ?? '');
            }
            return String(vars[key] ?? '');
        },
    });

    safeRegister('haschatvar', {
        aliases: [{ alias: 'chatvarexists', visible: false }],
        category: CATEGORY_CHATVAR,
        unnamedArgs: [{ name: 'name', description: 'The chat variable to look for.' }],
        description: 'True when the chat variable has been set in this chat. Composes with {{if}}.',
        returns: 'true or false',
        returnType: 'boolean',
        exampleUsage: ['{{if::{{haschatvar::start_minutes}}}}Started{{/if}}'],
        handler: (ctx) => {
            const key = readKey(ctx, ctx.unnamedArgs[0], 'haschatvar');
            if (!key) {
                return 'false';
            }
            const { vars } = resolveVars(ctx.env);
            return vars && Object.hasOwn(vars, key) ? 'true' : 'false';
        },
    });

    safeRegister('deletechatvar', {
        aliases: [{ alias: 'flushchatvar', visible: false }],
        category: CATEGORY_CHATVAR,
        unnamedArgs: [{ name: 'name', description: 'The chat variable to remove.' }],
        description: 'Removes a chat variable from this chat. Writes nothing to the prompt.',
        returns: 'nothing',
        exampleUsage: ['{{deletechatvar::satiety_ren}}'],
        handler: (ctx) => {
            const key = readKey(ctx, ctx.unnamedArgs[0], 'deletechatvar');
            if (!key) {
                return '';
            }
            const { vars, sandboxed } = resolveVars(ctx.env);
            if (vars && Object.hasOwn(vars, key)) {
                delete vars[key];
                persist(sandboxed);
            }
            return '';
        },
    });

    safeRegister('addchatvar', {
        category: CATEGORY_CHATVAR,
        unnamedArgs: [
            { name: 'name', description: 'The chat variable to add to.' },
            { name: 'value', description: 'The amount to add (or text to append).' },
        ],
        description: 'Adds to a chat variable, creating it at 0 when it does not exist yet. Adds numerically when both sides are numbers, otherwise appends as text. Writes nothing to the prompt.',
        returns: 'nothing',
        exampleUsage: ['{{addchatvar::elapsed_minutes::15}}'],
        handler: (ctx) => {
            const [rawKey, rawValue] = ctx.unnamedArgs;
            const key = readKey(ctx, rawKey, 'addchatvar');
            if (!key) {
                return '';
            }
            const { vars, sandboxed } = resolveVars(ctx.env);
            if (!vars) {
                ctx.warn('{{addchatvar}}: no chat is loaded, so there is nowhere to store it.');
                return '';
            }
            const next = addChatVarValue(Object.hasOwn(vars, key) ? vars[key] : '', rawValue);
            vars[key] = capChatVarValue(next).value;
            persist(sandboxed);
            return '';
        },
    });

    safeRegister('foreachChatVar', {
        category: CATEGORY_CHATVAR,
        delayArgResolution: true,
        unnamedArgs: [
            { name: 'prefix', description: 'Only chat variables whose name starts with this are visited.' },
            { name: 'alias', description: 'Name for the loop variables: {{.alias}} is the name with the prefix removed, {{.alias_key}} the full name, {{.alias_value}} the value.' },
            { name: 'content', description: 'The block to repeat, between the opening tag and {{/foreachChatVar}}.' },
        ],
        displayOverride: '{{foreachChatVar::prefix::alias}}…{{/foreachChatVar}}',
        description: 'Repeats a block once per chat variable whose name starts with the prefix, in name order. Use it as a block with a matching {{/foreachChatVar}}.',
        returns: 'the block repeated once per match, joined together',
        exampleUsage: ['{{foreachChatVar::satiety_::p}}{{.p}}: {{.p_value}} {{/foreachChatVar}}'],
        handler: (ctx) => {
            // delayArgResolution: these arrive as raw text, so the prefix and alias
            // are resolved here but the body is resolved once per iteration, after
            // the loop variables exist.
            const [rawPrefix, rawAlias, rawBody = ''] = ctx.unnamedArgs;
            const prefix = String(ctx.resolve(rawPrefix ?? '')).trim();
            const alias = String(ctx.resolve(rawAlias ?? '')).trim();

            if (!isValidLoopAlias(alias)) {
                ctx.warn(`{{foreachChatVar}}: "${alias}" cannot be used as a loop name. Start with a letter and use letters, numbers or underscores.`);
                return '';
            }

            const guardKey = `${prefix} ${alias}`;
            if (looping.has(guardKey)) {
                ctx.warn(`{{foreachChatVar}}: the "${prefix}" block loops itself; expansion stopped.`);
                return '';
            }

            const { vars } = resolveVars(ctx.env);
            const entries = chatVarEntries(vars ?? {}, prefix);
            if (!entries.length) {
                return '';
            }

            // Loop variables are read back as {{.alias}} shorthand, which bypasses
            // both the registry and dynamicMacros and goes straight to the host's
            // local store. so they have to be written there for real, then put
            // back exactly as they were (Layer B in workbench/sandbox.js).
            const names = loopVarNames(alias);
            const store = SillyTavern.getContext().chatMetadata?.variables ?? null;
            if (!store) {
                ctx.warn('{{foreachChatVar}}: no chat is loaded.');
                return '';
            }
            const slots = [names.value, names.key, names.entryValue];
            const saved = slots.map(name => (Object.hasOwn(store, name) ? store[name] : undefined));

            looping.add(guardKey);
            try {
                let out = '';
                for (const entry of entries) {
                    store[names.value] = entry.suffix;
                    store[names.key] = entry.key;
                    store[names.entryValue] = entry.value;
                    out += String(ctx.resolve(rawBody));
                }
                return out;
            } finally {
                looping.delete(guardKey);
                slots.forEach((name, i) => {
                    if (saved[i] === undefined) {
                        delete store[name];
                    } else {
                        store[name] = saved[i];
                    }
                });
            }
        },
    });
}
