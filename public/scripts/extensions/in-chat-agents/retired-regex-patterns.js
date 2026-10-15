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
