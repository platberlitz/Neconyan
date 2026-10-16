import { mergeChatPresetSettings } from '../../public/scripts/chat-preset-request.js';
import { BUNDLED_MACROS, bundledMacroMissingError, serverMacroNames } from '../macros/browser-only.js';
import { readRoleplayAgents } from './roleplay-agents-source.js';
import { readBoundRoleplayBooks } from './world-info.js';

function findBundledMacro(value) {
    if (typeof value === 'string') {
        if (!value.includes('{{')) return null;
        const lower = value.toLowerCase();
        if (![...BUNDLED_MACROS].some(name => lower.includes(name))) return null;
        for (const name of serverMacroNames(value)) if (BUNDLED_MACROS.has(name)) return name;
        return null;
    }
    if (!value || typeof value !== 'object') return null;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
        const name = findBundledMacro(item);
        if (name) return name;
    }
    return null;
}

/** Only the prompts the saved prompt order can place; disabled ones never render. */
function placeablePrompts(material) {
    if (!material) return null;
    const order = mergeChatPresetSettings(material.active, material.preset)?.prompt_order
        ?.find(value => String(value?.character_id) === '100001')?.order;
    const placed = new Set((Array.isArray(order) ? order : [])
        .filter(item => item?.enabled || item?.identifier === 'main').map(item => item.identifier));
    const strip = settings => !settings || typeof settings !== 'object' ? settings : { ...settings, prompt_order: undefined,
        prompts: Array.isArray(settings.prompts) ? settings.prompts.filter(prompt => placed.has(prompt?.identifier)) : settings.prompts };
    return { ...material, active: strip(material.active), preset: strip(material.preset) };
}

/**
 * A Roleplay request accepted without the page's bundled macro capture (a page
 * that had not reloaded, or a job accepted before captures existed) is refused
 * before any paid preparation when its pending prompt sources use one of those
 * macros. The scan reads the frozen request, the bound connection, the saved
 * history, page contributions, bound lore and Agents; it builds no prompt.
 */
export function assertRoleplayBundledMacrosCaptured(base, { snapshot, material, records, contributions }) {
    if (!snapshot || Object.hasOwn(snapshot, 'bundledMacros')) return;
    const sources = [
        () => snapshot,
        () => placeablePrompts(material),
        () => (records ?? []).slice(1).map(record => [record?.mes, record?.extra?.reasoning]),
        () => contributions,
        () => Object.values(readBoundRoleplayBooks(base, snapshot))
            .map(book => Object.values(book?.entries ?? {}).filter(entry => !entry?.disable)),
        () => readRoleplayAgents(base, snapshot),
    ];
    for (const read of sources) {
        const name = findBundledMacro(read());
        if (name) throw bundledMacroMissingError(name);
    }
}
