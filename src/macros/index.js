/**
 * Server-side macro host: environment snapshots, variable sinks, and the
 * registration entrypoint. All evaluation logic lives in public/ and is shared
 * with the browser; this file only supplies operation data.
 */
import { MacroEngine } from '../../public/scripts/macros/engine/MacroEngine.js';
import { MacroRegistry } from '../../public/scripts/macros/engine/MacroRegistry.js';
import { registerCoreMacros } from '../../public/scripts/macros/definitions/core-macros.js';
import { registerEnvMacros } from '../../public/scripts/macros/definitions/env-macros.js';
import { registerChatMacros } from '../../public/scripts/macros/definitions/chat-macros.js';
import { registerTimeMacros } from '../../public/scripts/macros/definitions/time-macros.js';
import { registerInstructMacros } from '../../public/scripts/macros/definitions/instruct-macros.js';
import { registerVariableMacros } from '../../public/scripts/macros/definitions/variable-macros.js';
import { registerStateMacros } from '../../public/scripts/macros/definitions/state-macros.js';
import { getStringHash } from '../../public/scripts/macro-primitives.js';
import { readVariableValue } from '../../public/scripts/slash-commands/SlashCommandRuntimeUtils.js';
import { parseTimestamp } from '../../public/scripts/message-timestamp.js';
import { moment } from './vendor.js';
import { evaluateLegacyMacros } from './legacy-macros.js';

export { MacroEngine, MacroRegistry };
export {
    registerCoreMacros,
    registerEnvMacros,
    registerChatMacros,
    registerTimeMacros,
    registerInstructMacros,
    registerStateMacros,
    registerVariableMacros,
};

export { evaluateLegacyMacros } from './legacy-macros.js';

let registered = false;
export function registerMacros() {
    if (registered) return;
    for (const register of [registerCoreMacros, registerEnvMacros, registerChatMacros, registerTimeMacros, registerInstructMacros, registerVariableMacros, registerStateMacros]) register();
    registered = true;
}

/** A private working copy; sinks persist writes without sharing account state. */
export function createMacroEnvironment(snapshot = {}, capabilities = {}, { readOnly = false, onVariableChange, onMetadataChange, dynamicMacros = {}, postProcess = x => x } = {}) {
    registerMacros();
    // Only mutable macro state is copied; chat and configuration are read-only
    // operation snapshots. Capabilities may be supplied in extra or separately.
    const data = { ...snapshot, variables: structuredClone(snapshot.variables ?? {}), extra: {
        ...snapshot.extra,
        chatMetadata: structuredClone(snapshot.extra?.chatMetadata ?? {}),
        bannedWords: [...(snapshot.extra?.bannedWords ?? [])],
    } };
    const makeScope = (scope) => {
        const values = Object.assign(Object.create(null), data.variables?.[scope]);
        data.variables[scope] = values;
        const get = name => readVariableValue(values[name]);
        const set = (name, value) => {
            if (readOnly) return '';
            if (typeof name !== 'string' || !name) throw new Error('Variable name cannot be empty.');
            values[name] = value;
            onVariableChange?.({ scope, name, value, deleted: false });
            return value;
        };
        const add = (name, value) => {
            if (readOnly) return '';
            const current = get(name) || 0;
            let array;
            try { array = JSON.parse(current); } catch { /* Non-array values use numeric or string addition. */ }
            if (Array.isArray(array)) {
                array.push(value);
                set(name, JSON.stringify(array));
                return array;
            }
            const increment = Number(value);
            const result = isNaN(increment) || isNaN(Number(current)) ? String(current || '') + value : Number(current) + increment;
            if (typeof result === 'number' && isNaN(result)) return '';
            set(name, result);
            return result;
        };
        return {
            get, set, add, inc: name => add(name, 1), dec: name => add(name, -1),
            has: name => Object.hasOwn(values, name),
            del: name => {
                if (readOnly) return;
                delete values[name];
                onVariableChange?.({ scope, name, deleted: true });
            },
        };
    };
    const env = {
        content: data.content ?? '',
        contentHash: getStringHash(data.content ?? ''),
        names: data.names ?? {},
        character: data.character ?? {},
        system: data.system ?? {},
        functions: {
            postProcess,
        },
        dynamicMacros: Object.fromEntries(Object.entries(dynamicMacros).map(([key, value]) => [key.toLowerCase(), value])),
        extra: {
            chat: [], extensionPrompts: {},
            getInput: () => '', getCurrentChatId: () => data.chatId ?? '',
            getFirstDisplayedMessageId: () => null, populateEnv: () => {},
            timestampToMoment: timestamp => {
                const parsed = parseTimestamp(timestamp);
                return parsed ? moment(parsed).locale(data.extra.locale ?? 'en') : moment.invalid();
            },
            ...data.extra,
            ...capabilities,
            powerUser: { ...data.extra.powerUser, instruct: data.extra.powerUser?.instruct ?? {},
                sysprompt: data.extra.powerUser?.sysprompt ?? {}, context: data.extra.powerUser?.context ?? {} },
            variables: { local: makeScope('local'), global: makeScope('global') },
            setChatIdHash: value => {
                env.extra.chatMetadata.chat_id_hash = value;
                if (!readOnly) onMetadataChange?.({ key: 'chat_id_hash', value });
            },
        },
    };
    // Each string has its own deterministic pick seed and one-shot original,
    // while variables and mutation sinks remain shared within the operation.
    env.fork = () => createMacroEnvironment({ ...data, names: env.names, character: env.character, system: env.system,
        extra: { ...data.extra, powerUser: env.extra.powerUser, mainApi: env.extra.mainApi } }, capabilities, { dynamicMacros, postProcess });
    env.captureState = () => structuredClone({ variables: data.variables,
        chatMetadata: env.extra.chatMetadata, bannedWords: env.extra.bannedWords });
    env.evaluate = (content, { legacy = false, strictCapabilities = false } = {}) => {
        let unavailable;
        const extra = { ...env.extra };
        const missing = name => () => {
            unavailable = Object.assign(new Error(`The ${name} macro requires unavailable browser context.`), { status: 409 });
            throw unavailable;
        };
        if (strictCapabilities) {
            for (const [key, name] of Object.entries({ isMobile: 'isMobile', findExtension: 'hasExtension', getInput: 'input',
                getFirstDisplayedMessageId: 'firstDisplayedMessageId', parseMesExamples: 'mesExamples', formatInstructModeExamples: 'mesExamples' })) {
                if (!Object.hasOwn(capabilities, key) && !Object.hasOwn(snapshot.extra || {}, key)) extra[key] = missing(name);
            }
        }
        let original = data.original;
        const functions = { ...env.functions };
        if (typeof original === 'string') functions.original = () => { const value = original; original = ''; return value; };
        if (legacy) {
            const fields = env.character;
            const values = {
                charPrompt: fields.charPrompt ?? '', charInstruction: fields.charInstruction ?? '', charJailbreak: fields.charInstruction ?? '',
                description: fields.description ?? '', personality: fields.personality ?? '', scenario: fields.scenario ?? '', persona: fields.persona ?? '',
                mesExamplesRaw: fields.mesExamplesRaw ?? '', charVersion: fields.version ?? '', char_version: fields.version ?? '',
                charDepthPrompt: fields.charDepthPrompt ?? '', creatorNotes: fields.creatorNotes ?? '',
                ...env.names, charIfNotGroup: env.names.group ?? env.names.char, model: env.system.model,
                isMobile: () => String(Boolean(extra.isMobile?.())),
                ...env.dynamicMacros,
            };
            if (functions.original) values.original = functions.original;
            if (strictCapabilities) values.mesExamples = missing('mesExamples');
            const result = evaluateLegacyMacros(content, values, extra, postProcess);
            if (unavailable) throw unavailable;
            return result;
        }
        const result = MacroEngine.evaluate(content, { ...env, extra, content, contentHash: getStringHash(content), functions });
        if (unavailable) throw unavailable;
        return result;
    };
    return env;
}
