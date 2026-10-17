/**
 * How the interface dictionary is assembled from its three files. It imports nothing and touches no browser object, so
 * public/scripts/i18n.js and the Node tests share one code path.
 *
 * Two tables come out. The matching dictionary is what the run-time localiser reads, so every key in it, and every
 * English alias made for it, can change text anywhere on the page. A 'scoped' key (one beginning with 'scoped.') is for
 * a string that only an explicit translate(english, key) or data-i18n lookup may reach. It goes to the scoped table
 * and never into the matching dictionary, and it gets no English alias, so its English text matches nothing else.
 */

export const SCOPED_PREFIX = 'scoped.';

/**
 * @param {unknown} key
 * @returns {boolean} True for a key reserved for explicit lookups.
 */
export const isScopedKey = key => typeof key === 'string' && key.startsWith(SCOPED_PREFIX);

/**
 * Merges the base and supplement dictionaries and aliases the catalogue's symbolic keys under their English text.
 * Unscoped output is the same as the single table the loader built before scoped keys existed.
 * @param {object} files
 * @param {Record<string, string>} [files.base] Upstream dictionary for the language (public/locales/<lang>.json)
 * @param {Record<string, string>} [files.supplement] Generated supplement (public/locales/neconyan/<lang>.json)
 * @param {Record<string, string>} [files.catalogue] English catalogue (public/locales/neconyan/en.json)
 * @returns {{dictionary: Record<string, string>, scoped: Record<string, string>}}
 */
export function assembleLocaleData({ base = {}, supplement = {}, catalogue = {} }) {
    const entries = Object.entries({ ...base, ...supplement });
    const dictionary = Object.fromEntries(entries.filter(([key]) => !isScopedKey(key)));
    const scoped = Object.fromEntries(entries.filter(([key]) => isScopedKey(key)));
    // Older translations use symbolic keys; new labelled controls use the English caption.
    for (const [key, english] of Object.entries(catalogue)) {
        if (isScopedKey(key) || isScopedKey(english)) continue; // A scoped key must leave no alias behind.
        if (dictionary[key] && !Object.hasOwn(dictionary, english)) dictionary[english] = dictionary[key];
    }
    return { dictionary, scoped };
}

/**
 * Picks the table an explicit lookup reads: the scoped table for a scoped key, the matching dictionary otherwise.
 * Either table may be missing before loading, so the result may be undefined.
 * @param {string} key
 * @param {Record<string, string>|undefined} dictionary
 * @param {Record<string, string>|undefined} scoped
 * @returns {Record<string, string>|undefined}
 */
export const tableForKey = (key, dictionary, scoped) => isScopedKey(key) ? scoped : dictionary;
