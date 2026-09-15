/**
 * Sandboxed macro evaluation for the Workbench. Three layers keep previews from
 * touching real data:
 *
 * Layer A. dynamicMacros overrides. The engine resolves env.dynamicMacros before
 * the registry, so every variable macro (and each of its aliases. lookups are
 * name-keyed) is shadowed with versions that read/write a copy-on-write store.
 *
 * Layer B. snapshot/restore. Variable shorthand ({{.x = 5}}, {{$y++}}) bypasses
 * the registry entirely and writes the real stores, so evaluation is wrapped in a
 * clone-evaluate-diff-restore cycle. Safe because engine.evaluate is synchronous;
 * documented limitation: another extension's synchronous listener could observe
 * the transient values.
 *
 * Layer C. chat-state overlay. Stateful macros ({{freeze}} and friends) resolve
 * their store through env.extra.meSandboxState, which the panel points at this
 * sandbox's cloned chat state. A snapshot/restore backstop around run() catches
 * any future stateful handler that forgets that discipline.
 */
import { emptyState } from '../chat-state.js';

/** The variable macros we shadow, grouped by operation. Aliases listed explicitly. */
export const SHADOWED_LOCAL = {
    set: ['setvar'],
    add: ['addvar'],
    inc: ['incvar'],
    dec: ['decvar'],
    get: ['getvar'],
    has: ['hasvar', 'varexists'],
    del: ['deletevar', 'flushvar'],
};
export const SHADOWED_GLOBAL = {
    set: ['setglobalvar'],
    add: ['addglobalvar'],
    inc: ['incglobalvar'],
    dec: ['decglobalvar'],
    get: ['getglobalvar'],
    has: ['hasglobalvar', 'globalvarexists'],
    del: ['deleteglobalvar', 'flushglobalvar'],
};

const DELETED = Symbol('deleted');

/**
 * Copy-on-write view over a real variable store. Reads fall through to the real
 * object until the sandbox has written that name; writes never leave the overlay.
 */
export function createSandboxStore(getRealStore) {
    const overlay = new Map();

    const read = (name) => {
        if (overlay.has(name)) {
            const value = overlay.get(name);
            return value === DELETED ? undefined : value;
        }
        const real = getRealStore() ?? {};
        return Object.hasOwn(real, name) ? real[name] : undefined;
    };

    const toNumber = (value) => {
        const n = Number.parseFloat(String(value ?? 0));
        return Number.isNaN(n) ? 0 : n;
    };

    return {
        get: (name) => read(name),
        has: (name) => read(name) !== undefined,
        set: (name, value) => {
            overlay.set(name, String(value));
        },
        add: (name, value) => {
            const current = read(name);
            const currentNumber = Number.parseFloat(String(current ?? ''));
            const valueNumber = Number.parseFloat(String(value));
            if (!Number.isNaN(currentNumber) && !Number.isNaN(valueNumber)) {
                overlay.set(name, String(currentNumber + valueNumber));
            } else {
                overlay.set(name, String(current ?? '') + String(value));
            }
        },
        inc: (name) => {
            const next = toNumber(read(name)) + 1;
            overlay.set(name, String(next));
            return next;
        },
        dec: (name) => {
            const next = toNumber(read(name)) - 1;
            overlay.set(name, String(next));
            return next;
        },
        del: (name) => {
            overlay.set(name, DELETED);
        },
        /** name -> {before, after}; after === undefined means deleted. */
        changes: () => {
            const real = getRealStore() ?? {};
            const result = new Map();
            for (const [name, value] of overlay) {
                const before = Object.hasOwn(real, name) ? real[name] : undefined;
                const after = value === DELETED ? undefined : value;
                // String-compare like diffObjects: real stores may hold numbers.
                if (String(before) !== String(after) || (before === undefined) !== (after === undefined)) {
                    result.set(name, { before, after });
                }
            }
            return result;
        },
        reset: () => overlay.clear(),
    };
}

function argDef(name, description) {
    return { name, description };
}

function buildOverrides(store, shadowed) {
    const overrides = {};
    const nameArg = argDef('name', 'Variable name.');
    const valueArg = argDef('value', 'Value.');

    for (const alias of shadowed.set) {
        overrides[alias] = {
            unnamedArgs: [nameArg, valueArg],
            description: 'Sandboxed by Macro Enhanced Workbench.',
            handler: ({ unnamedArgs: [name, value] }) => {
                store.set(name, value);
                return '';
            },
        };
    }
    for (const alias of shadowed.add) {
        overrides[alias] = {
            unnamedArgs: [nameArg, valueArg],
            description: 'Sandboxed by Macro Enhanced Workbench.',
            handler: ({ unnamedArgs: [name, value] }) => {
                store.add(name, value);
                return '';
            },
        };
    }
    for (const alias of shadowed.inc) {
        overrides[alias] = {
            unnamedArgs: [nameArg],
            description: 'Sandboxed by Macro Enhanced Workbench.',
            handler: ({ unnamedArgs: [name] }) => String(store.inc(name)),
        };
    }
    for (const alias of shadowed.dec) {
        overrides[alias] = {
            unnamedArgs: [nameArg],
            description: 'Sandboxed by Macro Enhanced Workbench.',
            handler: ({ unnamedArgs: [name] }) => String(store.dec(name)),
        };
    }
    for (const alias of shadowed.get) {
        overrides[alias] = {
            unnamedArgs: [nameArg],
            description: 'Sandboxed by Macro Enhanced Workbench.',
            handler: ({ unnamedArgs: [name] }) => {
                const value = store.get(name);
                return value === undefined || value === null ? '' : String(value);
            },
        };
    }
    for (const alias of shadowed.has) {
        overrides[alias] = {
            unnamedArgs: [nameArg],
            description: 'Sandboxed by Macro Enhanced Workbench.',
            handler: ({ unnamedArgs: [name] }) => (store.has(name) ? 'true' : 'false'),
        };
    }
    for (const alias of shadowed.del) {
        overrides[alias] = {
            unnamedArgs: [nameArg],
            description: 'Sandboxed by Macro Enhanced Workbench.',
            handler: ({ unnamedArgs: [name] }) => {
                store.del(name);
                return '';
            },
        };
    }
    return overrides;
}

export function getShadowedNames() {
    return [...Object.values(SHADOWED_LOCAL), ...Object.values(SHADOWED_GLOBAL)].flat();
}

/**
 * Registry variable-category macros the sandbox does NOT shadow (e.g. after an
 * upstream sync adds new ones). The panel shows these as "not sandboxed".
 */
export function findUnshadowedVariableMacros(registry) {
    const shadowed = new Set(getShadowedNames().map(name => name.toLowerCase()));
    const unshadowed = [];
    for (const macro of registry?.getAllMacros?.({ excludeAliases: false }) ?? []) {
        if (macro.category === 'variable' && !shadowed.has(macro.name.toLowerCase())) {
            unshadowed.push(macro.name);
        }
    }
    return unshadowed;
}

/**
 * Flattens the persistent chat state into a single-level name -> string map so
 * the generic diff helpers apply: "frozen:key", "sticky:key", ..., "counter:swipes".
 */
export function flattenChatState(state) {
    const flat = {};
    for (const kind of ['frozen', 'sticky', 'daily', 'rolls']) {
        for (const [key, entry] of Object.entries(state?.[kind] ?? {})) {
            flat[`${kind}:${key}`] = String(entry?.value ?? '');
        }
    }
    // Chat vars are a flat map rather than {value} entries, so they flatten on
    // their own; without this the sandbox would miss a leaked {{setchatvar}}.
    for (const [key, value] of Object.entries(state?.chatVars ?? {})) {
        flat[`chatvar:${key}`] = String(value ?? '');
    }
    for (const [key, value] of Object.entries(state?.counters ?? {})) {
        if (key !== 'firstSeenAt') {
            flat[`counter:${key}`] = String(value);
        }
    }
    return flat;
}

function diffObjects(before, after) {
    const changes = new Map();
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const beforeValue = Object.hasOwn(before, name) ? before[name] : undefined;
        const afterValue = Object.hasOwn(after, name) ? after[name] : undefined;
        if (String(beforeValue) !== String(afterValue) || (beforeValue === undefined) !== (afterValue === undefined)) {
            changes.set(name, { before: beforeValue, after: afterValue });
        }
    }
    return changes;
}

function restoreInPlace(target, snapshot) {
    for (const key of Object.keys(target)) {
        delete target[key];
    }
    Object.assign(target, snapshot);
}

/**
 * Creates a Workbench sandbox session.
 *
 * @param {object} deps - Injectable for tests; defaults to the live context.
 * @param {() => object} deps.getLocalStore - Returns the real local variables object.
 * @param {() => object} deps.getGlobalStore - Returns the real global variables object.
 * @param {() => object|null} [deps.getChatState] - Returns the real per-chat state
 *        (chat_metadata.MacroEnhanced), or null when no chat is loaded.
 */
export function createSandbox({ getLocalStore, getGlobalStore, getChatState = () => null }) {
    const local = createSandboxStore(getLocalStore);
    const global = createSandboxStore(getGlobalStore);

    const dynamicMacros = {
        ...buildOverrides(local, SHADOWED_LOCAL),
        ...buildOverrides(global, SHADOWED_GLOBAL),
    };

    /** Layer C overlay: stateful macros write here via env.extra.meSandboxState. */
    const chatState = structuredClone(getChatState() ?? emptyState());

    /** Shorthand writes observed in the last evaluation (Layer B). */
    let shorthandLocal = new Map();
    let shorthandGlobal = new Map();
    /** Real chat-state writes leaked past the overlay in the last evaluation. */
    let leakedChat = new Map();

    return {
        dynamicMacros,
        local,
        global,
        chatState,

        /**
         * Evaluates text with sandboxed variables.
         * @param {(input: string, dynamicMacros: object) => string} evaluate - Runs the engine
         *        synchronously with the given dynamicMacros merged into the env.
         * @param {string} input
         * @returns {string}
         */
        run(evaluate, input) {
            const realLocal = getLocalStore() ?? {};
            const realGlobal = getGlobalStore() ?? {};
            const realChat = getChatState();
            const localSnapshot = structuredClone(realLocal);
            const globalSnapshot = structuredClone(realGlobal);
            const chatSnapshot = realChat ? structuredClone(realChat) : null;
            try {
                return evaluate(input, dynamicMacros);
            } finally {
                shorthandLocal = diffObjects(localSnapshot, realLocal);
                shorthandGlobal = diffObjects(globalSnapshot, realGlobal);
                restoreInPlace(realLocal, localSnapshot);
                restoreInPlace(realGlobal, globalSnapshot);
                if (realChat && chatSnapshot) {
                    leakedChat = diffObjects(flattenChatState(chatSnapshot), flattenChatState(realChat));
                    restoreInPlace(realChat, chatSnapshot);
                }
            }
        },

        /** Merged pending changes: Layer A overlay writes + Layer B shorthand diffs
         *  + Layer C chat-state overlay writes (and any restored leaks). */
        pendingChanges() {
            const merge = (overlayChanges, shorthandChanges) => {
                const merged = new Map(overlayChanges);
                for (const [name, change] of shorthandChanges) {
                    merged.set(name, change);
                }
                return merged;
            };
            const chatOverlay = diffObjects(
                flattenChatState(getChatState() ?? emptyState()),
                flattenChatState(chatState));
            return {
                local: merge(local.changes(), shorthandLocal),
                global: merge(global.changes(), shorthandGlobal),
                chat: merge(chatOverlay, leakedChat),
            };
        },

        reset() {
            local.reset();
            global.reset();
            restoreInPlace(chatState, structuredClone(getChatState() ?? emptyState()));
            shorthandLocal = new Map();
            shorthandGlobal = new Map();
            leakedChat = new Map();
        },
    };
}
