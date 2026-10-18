/**
 * Finds and removes global variables that nothing installed refers to, such
 * as the leftovers of a deleted preset. The server does the checking, because
 * presets, characters, lorebooks, Quick Replies, Agents and chats live on disk.
 */
import { areVariablesReadOnly } from '../../../../variable-read-only.js';

export const UNUSED_GLOBALS_ENDPOINT = '/api/global-variables/unused';

/**
 * @param {object} ctx SillyTavern.getContext()
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ unused: string[], used: string[], checked: Record<string, number>, unreadable: number }>}
 */
export async function findUnusedGlobals(ctx, fetchFn = globalThis.fetch) {
    const names = Object.keys(ctx.extensionSettings?.variables?.global ?? {});
    if (!names.length) {
        return { unused: [], used: [], checked: {}, unreadable: 0 };
    }
    const response = await fetchFn(UNUSED_GLOBALS_ENDPOINT, {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ names }),
    });
    if (!response.ok) {
        throw new Error(`The server could not check global variables (${response.status}).`);
    }
    const result = await response.json();
    const current = new Set(Object.keys(ctx.extensionSettings?.variables?.global ?? {}));
    return {
        unused: (result.unused ?? []).filter(name => current.has(name)).sort(),
        used: result.used ?? [],
        checked: result.checked ?? {},
        unreadable: Number(result.unreadable) || 0,
    };
}

/**
 * Plain-language summary of what the server looked through.
 * @param {Record<string, number>} checked
 */
export function describeChecked(checked) {
    const parts = Object.entries(checked ?? {})
        .filter(([, count]) => count > 0)
        .map(([label, count]) => `${count} ${label === 'Settings' ? 'settings file' : label.toLowerCase()}${count === 1 ? '' : 's'}`);
    return parts.length ? parts.join(', ') : 'nothing';
}

/**
 * @param {object} ctx SillyTavern.getContext()
 * @param {string[]} names
 * @returns {string[]} The names that were removed.
 */
export function removeGlobals(ctx, names) {
    if (areVariablesReadOnly()) {
        return [];
    }
    const store = ctx.extensionSettings?.variables?.global;
    if (!store) {
        return [];
    }
    const removed = names.filter(name => Object.hasOwn(store, name));
    for (const name of removed) {
        delete store[name];
    }
    if (removed.length) {
        ctx.saveSettingsDebounced();
    }
    return removed;
}
