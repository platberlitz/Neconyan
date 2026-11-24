import { getStringHash } from '../../macro-primitives.js';

/**
 * Bundled find patterns that a later release replaced, keyed by the bundled script id.
 * A saved script still holding one of these exactly was never edited, so it can take the
 * new pattern. Its replacement is left alone because a theme may have restyled it.
 */
const RETIRED_FIND_PATTERNS = Object.freeze([
    // Miracle Certificate before the citation in the header became optional.
    Object.freeze({
        scriptId: 'fb09f6d3-e5bf-4aec-8166-07f3f33aaeaa',
        findRegex: String.raw`/\[CERT\|([^\]\n\r|]+)\|([^\]\n\r|]+)\|([^\]\n\r|]+)\][ \t]*\r?\n?[ \t]*(?:stamp:[ \t]*)?((?:(?!\[\/|\[[A-Z])[^\n\r])*)(?:\s*\[\/CERT\])?/g`,
    }),
]);

/**
 * Give saved regex scripts the current bundled find pattern when they still hold a retired one.
 * @param {object[]} scripts Saved regex scripts of one agent.
 * @param {(scriptId: string) => object|null|undefined} findBundledScript Looks up the bundled script by id.
 * @returns {object[]|null} Updated copies of the scripts, or null when none changed.
 */
export function updateRetiredFindPatterns(scripts, findBundledScript) {
    if (!Array.isArray(scripts)) {
        return null;
    }

    let changed = false;
    const updated = scripts.map(script => {
        const retired = RETIRED_FIND_PATTERNS.find(entry => entry.findRegex === script?.findRegex);
        const findRegex = retired ? findBundledScript(retired.scriptId)?.findRegex : null;
        if (typeof findRegex !== 'string' || !findRegex || findRegex === script.findRegex) {
            return script;
        }

        changed = true;
        return { ...script, findRegex };
    });

    return changed ? updated : null;
}

/**
 * Fingerprints of bundled replacements that a later release rewrote, keyed by the bundled
 * script id. A saved script whose replacement still matches one exactly was never restyled,
 * so it can take the current markup.
 */
const RETIRED_REPLACEMENTS = Object.freeze([
    // Relationship Bond before its header wrapped the status pill on narrow cards.
    Object.freeze({ scriptId: 'c81e4b95-2d7a-4a60-8f3c-7b9e0d6a4c22', hash: 5463418370444986, length: 8220 }),
]);

/**
 * Give saved regex scripts the current bundled replacement when they still hold a retired one.
 * @param {object[]} scripts Saved regex scripts of one agent.
 * @param {(scriptId: string) => object|null|undefined} findBundledScript Looks up the bundled script by id.
 * @returns {object[]|null} Updated copies of the scripts, or null when none changed.
 */
export function updateRetiredReplacements(scripts, findBundledScript) {
    if (!Array.isArray(scripts)) {
        return null;
    }

    let changed = false;
    const updated = scripts.map(script => {
        const text = script?.replaceString;
        if (typeof text !== 'string') {
            return script;
        }

        const retired = RETIRED_REPLACEMENTS.find(entry => entry.length === text.length
            && entry.hash === getStringHash(text));
        const replaceString = retired ? findBundledScript(retired.scriptId)?.replaceString : null;
        if (typeof replaceString !== 'string' || !replaceString || replaceString === text) {
            return script;
        }

        changed = true;
        return { ...script, replaceString };
    });

    return changed ? updated : null;
}
