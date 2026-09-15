const actions = new Map();
const formatters = new Map();

export function registerToolAction(key, fn) {
    if (typeof fn !== 'function') {
        throw new TypeError(`[ToolActionRegistry] Action for key "${key}" must be a function.`);
    }
    actions.set(key, fn);
}

export function getToolAction(key) {
    return actions.get(key) ?? null;
}

export function hasToolAction(key) {
    return actions.has(key);
}

export function unregisterToolAction(key) {
    actions.delete(key);
}

export function registerToolFormatter(key, fn) {
    if (typeof fn !== 'function') {
        throw new TypeError(`[ToolActionRegistry] Formatter for key "${key}" must be a function.`);
    }
    formatters.set(key, fn);
}

export function getToolFormatter(key) {
    return formatters.get(key) ?? null;
}

export function hasToolFormatter(key) {
    return formatters.has(key);
}

export function unregisterToolFormatter(key) {
    formatters.delete(key);
}

export function clearAll() {
    actions.clear();
    formatters.clear();
}

export function getRegisteredActionKeys() {
    return [...actions.keys()];
}

export function getRegisteredFormatterKeys() {
    return [...formatters.keys()];
}
