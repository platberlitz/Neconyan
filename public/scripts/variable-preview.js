import { readVariableValue } from './slash-commands/SlashCommandRuntimeUtils.js';
import { withReadOnlyVariables } from './variable-read-only.js';

let activePreview = null;

/**
 * A preview owns its variable writes, including across separate synchronous
 * substitutions. Never leave the scope installed while awaiting token counts.
 * Other stateful macros retain the normal read-only preview protection.
 * @returns {<T>(callback: () => T) => T}
 */
export function createVariablePreview() {
    const preview = { variables: null };
    return callback => {
        const previous = activePreview;
        activePreview = preview;
        try {
            return withReadOnlyVariables(callback);
        } finally {
            activePreview = previous;
        }
    };
}

/** Copy the browser stores only when a preview first evaluates a macro. */
export function getPreviewVariables(local, global, restrictedLocal = false) {
    if (!activePreview) return null;
    activePreview.variables ??= {
        local: createScope(local, name => !restrictedLocal || !String(name).startsWith('agent_')),
        global: createScope(global),
    };
    return activePreview.variables;
}

/** Match the browser's macro variable operations without any persistence hooks. */
function createScope(source = {}, canRead = () => true) {
    const values = Object.assign(Object.create(null), structuredClone(source));
    const get = name => canRead(name) ? readVariableValue(values[name]) : '';
    const set = (name, value) => {
        if (!name) throw new Error('Variable name cannot be empty or undefined.');
        values[name] = value;
        return value;
    };
    const add = (name, value) => {
        const current = get(name) || 0;
        try {
            const array = JSON.parse(current);
            if (Array.isArray(array)) {
                array.push(value);
                set(name, JSON.stringify(array));
                return array;
            }
        } catch { /* Non-array values use numeric or string addition. */ }
        const result = isNaN(Number(value)) || isNaN(Number(current))
            ? String(current || '') + value : Number(current) + Number(value);
        if (typeof result === 'number' && isNaN(result)) return '';
        set(name, result);
        return result;
    };
    return {
        get, set, add,
        inc: name => add(name, 1),
        dec: name => add(name, -1),
        has: name => canRead(name) && values[name] !== undefined,
        del: name => { delete values[name]; },
    };
}
