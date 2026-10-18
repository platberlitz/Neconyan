/**
 * `/me-define` argument handling. Extracted so the preservation rule is a plain
 * function: leaving `args=` out updates the template without wiping the saved
 * argument names, optional flags, defaults or descriptions.
 */

/**
 * @param {string|undefined|null} rawArgs - The named `args=` value.
 * @param {object[]} [existingArgs] - Arguments already saved on the definition.
 * @returns {object[]}
 */
export function resolveDefineArgs(rawArgs, existingArgs = []) {
    if (rawArgs === undefined || rawArgs === null) {
        return Array.isArray(existingArgs) ? existingArgs.map(arg => ({ ...arg })) : [];
    }
    return String(rawArgs)
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
        .map(name => ({ name, optional: false }));
}
