/**
 * Language rules for the pages that load before the app: the sign-in page, the session-expired page, the 404 page
 * and the pages the server renders for blocked clients. It imports nothing and touches no browser object at module
 * level, so Node can import the pure functions (src/page-translations.js does) and the browser loader can use
 * them without loading i18n.js, which pulls in the whole app.
 *
 * The language rule here is also used by the app (public/scripts/i18n.js), so the app, these pages and the server
 * pages choose a language the same way.
 *
 * Text is translated by exact key lookup only, the way the app's translate() and data-i18n do. It never uses the
 * run-time pattern localiser.
 */

const STORAGE_KEY = 'language';
const HOLE_PATTERN = /\$\{(\d+)\}/g;
const ATTRIBUTE_KEY_PATTERN = /^\[([^\]]+)\](.+)$/s;
const ATTRIBUTE_NAMES = new Set(['alt', 'title', 'aria-label']);
const FORM_CONTROL_SELECTOR = 'input,textarea,select,option';
const TEMPLATE_KEY_PATTERN = /\{\{\s*t\s+"([^"]+)"/g;

function isEnglish(locale) {
    return locale === 'en' || locale.startsWith('en-');
}

const PRIMARY_PATTERN = /^[a-z]{2,3}$/;
const SCRIPT_PATTERN = /^[a-z]{4}$/;
const REGION_PATTERN = /^(?:[a-z]{2}|\d{3})$/;

function partsOf(locale) {
    const [primary, ...rest] = locale.split('-');
    return {
        primary,
        script: rest.find(part => SCRIPT_PATTERN.test(part)) ?? null,
        region: rest.find(part => REGION_PATTERN.test(part)) ?? null,
    };
}

/**
 * How a tag picks among the dictionaries of a language that has more than one (lower-case parts in, a code out).
 * Every language with one dictionary needs no entry. tests/language-choice.node.js fails when lang.json gains a
 * second dictionary for a language not listed here, so that choice is made on purpose.
 * Chinese: an explicit script wins over the region (Hant gives Traditional zh-tw, Hans gives Simplified zh-cn, so
 * zh-Hans-TW is Simplified and zh-Hant-CN Traditional); the region decides only when there is no script (tw, hk and mo
 * are Traditional); bare zh, with no script and no region, gives Simplified (zh-cn) by default.
 */
export const VARIANT_RULES = Object.freeze({
    zh: ({ script, region }) => {
        if (script === 'hant') return 'zh-tw';
        if (script === 'hans') return 'zh-cn';
        return ['tw', 'hk', 'mo'].includes(region) ? 'zh-tw' : 'zh-cn';
    },
});

/**
 * Finds the dictionary of a tag's language when the tag itself is not a supported code: 'de' and 'de-at' give
 * 'de-de'. Never a different language. A language with several dictionaries is decided by VARIANT_RULES.
 * @param {string} locale Lower-case language tag
 * @param {string[]} supportedCodes Language codes of public/locales/lang.json
 * @returns {string|null} A supported code, or null
 */
export function matchLanguage(locale, supportedCodes) {
    const parts = partsOf(locale);
    if (!PRIMARY_PATTERN.test(parts.primary)) return null;
    const sameLanguage = supportedCodes.filter(code => code.split('-')[0] === parts.primary);
    if (sameLanguage.length === 0) return null;
    if (sameLanguage.length === 1) return sameLanguage[0];
    const chosen = VARIANT_RULES[parts.primary]?.(parts);
    return sameLanguage.includes(chosen) ? chosen : null;
}

/**
 * Picks the language to use from a list of wanted languages, in order.
 * For each tag, lower-cased: a supported code wins; an English tag stops the search with English; otherwise a tag
 * of a supported language uses that language's dictionary (matchLanguage). Tags with no dictionary are skipped.
 * @param {string[]} candidates Wanted language tags, most wanted first
 * @param {string[]} supportedCodes Language codes of public/locales/lang.json
 * @returns {string} A supported code, or 'en'
 */
export function pickLocale(candidates, supportedCodes) {
    for (const candidate of candidates ?? []) {
        const locale = String(candidate).toLowerCase();
        if (!locale || locale === '*') continue;
        if (supportedCodes.includes(locale)) return locale;
        if (isEnglish(locale)) return 'en';
        const match = matchLanguage(locale, supportedCodes);
        if (match) return match;
    }
    return 'en';
}

/**
 * The choice saved by the app's language picker, matched as a whole tag as the app always has: a supported code is
 * used, anything else (English, an old or unknown value) means English. Never mapped to another code.
 * @param {string} stored Stored value
 * @param {string[]} supportedCodes Language codes of public/locales/lang.json
 * @returns {string} A supported code, or 'en'
 */
export function pickStoredLocale(stored, supportedCodes) {
    const locale = String(stored).toLowerCase();
    return supportedCodes.includes(locale) ? locale : 'en';
}

/**
 * Chooses a browser's language: the stored choice alone when there is one, else the browser's languages in order.
 * @param {string|null} stored Stored value (null or '' when nothing is stored)
 * @param {string[]} languages Browser languages, most wanted first
 * @param {string[]} supportedCodes Language codes of public/locales/lang.json
 * @returns {string} A supported code, or 'en'
 */
export function chooseBrowserLocale(stored, languages, supportedCodes) {
    return stored && stored !== BROWSER_LANGUAGE ? pickStoredLocale(stored, supportedCodes) : pickLocale(languages, supportedCodes);
}

function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Merges the two dictionary files of a language the way the app does (the supplement wins).
 * The app's extra step that copies symbolic upstream keys to their English caption is left out on purpose:
 * it changes no key these pages use, and tests/page-locale.node.js fails if that ever stops being true.
 * @param {Record<string, string>} base public/locales/<lang>.json
 * @param {Record<string, string>} supplement public/locales/neconyan/<lang>.json
 * @returns {Record<string, string>} Merged dictionary
 */
export function mergePageDictionary(base, supplement) {
    return { ...plainObject(base), ...plainObject(supplement) };
}

function holesOf(text) {
    return (String(text).match(HOLE_PATTERN) ?? []).sort();
}

/**
 * Gets the translation to show for a key, or null when the English text should be shown.
 * The value must be a non-blank string that differs from the key and has exactly the key's ${n} holes, each once,
 * so a bad translation can never drop an address or a code element.
 * @param {Record<string, string>} dictionary Merged dictionary
 * @param {string} key English text
 * @returns {string|null} Translation or null
 */
export function translationFor(dictionary, key) {
    if (!dictionary || typeof dictionary !== 'object' || typeof key !== 'string') return null;
    if (!Object.hasOwn(dictionary, key)) return null;
    const value = dictionary[key];
    if (typeof value !== 'string' || value.trim() === '' || value === key) return null;
    const wanted = holesOf(key);
    const found = holesOf(value);
    if (wanted.length !== found.length || wanted.some((hole, index) => hole !== found[index])) return null;
    if (new Set(found).size !== found.length) return null;
    return value;
}

/**
 * Lists the keys of the {{t "..."}} calls of a server page template, each once, in order of first use.
 * @param {string} source Template source
 * @returns {string[]} Keys
 */
export function templateKeys(source) {
    const keys = new Set();
    for (const match of String(source).matchAll(TEMPLATE_KEY_PATTERN)) keys.add(match[1]);
    return [...keys];
}

/**
 * Gets the choice saved by the app's language picker, or null when nothing is saved or storage cannot be read.
 * @returns {string|null} Stored value
 */
export function storedLanguage() {
    try {
        return localStorage.getItem(STORAGE_KEY);
    } catch {
        // Storage can be blocked (private modes); the browser languages are used then.
        return null;
    }
}

/**
 * Gets the browser's languages, most wanted first: navigator.languages, else navigator.language as one entry.
 * @returns {string[]} Language tags as the browser reports them
 */
export function browserLanguages() {
    const listed = Array.from(navigator.languages ?? []).filter(language => typeof language === 'string' && language);
    return listed.length ? listed : [navigator.language || navigator.userLanguage || 'en'];
}

/**
 * Gets the language this browser asks for first: the stored choice, else the first browser language (unchanged).
 * @returns {string} Lower-case language tag
 */
export function requestedLocale() {
    return String(storedLanguage() || navigator.language || navigator.userLanguage || 'en').toLowerCase();
}

async function readJson(url, failures) {
    try {
        const response = await fetch(url, { credentials: 'same-origin', priority: 'low' });
        if (!response.ok) return {};
        return plainObject(await response.json());
    } catch (error) {
        failures.push(`${url}: ${error?.message ?? error}`);
        return {};
    }
}

/**
 * Loads the dictionary for this browser's language: the same two files the app reads. The language is the stored
 * choice, else the browser's languages in order, by the shared rule above.
 * English needs no file. Any failure leaves English and logs one warning.
 * @returns {Promise<{locale: string, dictionary: Record<string, string>}>} Language used and its dictionary
 */
export async function loadPageDictionary(preference = effectiveLanguagePreference()) {
    const english = { locale: 'en', dictionary: {} };
    if (preference && isEnglish(String(preference).toLowerCase())) return english;
    if ((!preference || preference === BROWSER_LANGUAGE) && isEnglish(String(browserLanguages()[0]).toLowerCase())) return english;
    const failures = [];
    try {
        const response = await fetch('/locales/lang.json', { credentials: 'same-origin', priority: 'low' });
        if (!response.ok) throw new Error(`lang.json answered ${response.status}`);
        const languages = await response.json();
        const codes = languages.map(language => language.lang);
        const locale = chooseBrowserLocale(preference, browserLanguages(), codes);
        if (locale === 'en') return english;
        const [base, supplement] = await Promise.all([
            readJson(`/locales/${locale}.json`, failures),
            readJson(`/locales/neconyan/${locale}.json`, failures),
        ]);
        if (failures.length) console.warn('page-locale: some dictionary files could not be read', failures);
        const dictionary = mergePageDictionary(base, supplement);
        return Object.keys(dictionary).length ? { locale, dictionary } : english;
    } catch (error) {
        console.warn('page-locale: the dictionary could not be loaded', error);
        return english;
    }
}

function attributeKeyOf(spec) {
    const match = spec.match(ATTRIBUTE_KEY_PATTERN);
    return match ? { attribute: match[1], key: match[2] } : { attribute: null, key: spec };
}

function setAttributeIfChanged(element, attribute, value) {
    if (element.getAttribute(attribute) === value) return false;
    element.setAttribute(attribute, value);
    return true;
}

function applyDataI18n(element, dictionary) {
    let changes = 0;
    const isFormControl = element.matches(FORM_CONTROL_SELECTOR);
    for (const spec of element.getAttribute('data-i18n').split(';')) {
        const { attribute, key } = attributeKeyOf(spec);
        const value = translationFor(dictionary, key);
        if (value === null) continue;
        if (attribute) {
            // Attributes only, and never on a field; a wrapper of fields may carry its aria-label.
            if (isFormControl || !ATTRIBUTE_NAMES.has(attribute)) continue;
            if (setAttributeIfChanged(element, attribute, value)) changes++;
            continue;
        }
        if (isFormControl || element.querySelector(FORM_CONTROL_SELECTOR)) continue;
        if (element.children.length) {
            console.warn('page-locale: skipped a text key on an element that has child elements', key);
            continue;
        }
        if (element.textContent !== value) {
            element.textContent = value;
            changes++;
        }
    }
    return changes;
}

function sameNodes(element, nodes) {
    const current = element.childNodes;
    if (current.length !== nodes.length) return false;
    return nodes.every((node, index) => current[index] === node
        || (node.nodeType === 3 && current[index].nodeType === 3 && current[index].data === node.data));
}

function applyCompose(element, dictionary) {
    const key = element.getAttribute('data-i18n-compose');
    const value = translationFor(dictionary, key);
    if (value === null) return 0;
    if (element.matches(FORM_CONTROL_SELECTOR) || element.querySelector(FORM_CONTROL_SELECTOR)) return 0;
    // The child elements, in order, are the holes: they are moved, never rebuilt, so a code element stays as written.
    const holes = [...element.children];
    if (holes.length !== holesOf(key).length) {
        console.warn('page-locale: skipped a composed key whose holes do not match the child elements', key);
        return 0;
    }
    const nodes = [];
    for (const [index, part] of value.split(HOLE_PATTERN).entries()) {
        if (index % 2 === 0) {
            if (part) nodes.push(element.ownerDocument.createTextNode(part));
        } else if (holes[Number(part)]) {
            nodes.push(holes[Number(part)]);
        } else {
            return 0;
        }
    }
    if (sameNodes(element, nodes)) return 0;
    element.replaceChildren(...nodes);
    return 1;
}

/**
 * Translates the marked elements below a root in place. Only the text of elements that contain no other element
 * and the alt, title and aria-label attributes are written. No field is rebuilt, moved, focused or given a value,
 * and nothing is written into an element that contains a field, so a typed or autofilled value is never touched.
 * @param {Document|Element} root Where to look
 * @param {Record<string, string>} dictionary Merged dictionary
 * @returns {number} How many elements or attributes changed
 */
export function localisePage(root, dictionary) {
    let changes = 0;
    for (const element of root.querySelectorAll('[data-i18n]')) changes += applyDataI18n(element, dictionary);
    for (const element of root.querySelectorAll('[data-i18n-compose]')) changes += applyCompose(element, dictionary);
    return changes;
}

/**
 * Translates a message set at run time (exact key lookup).
 * @param {Record<string, string>} dictionary Merged dictionary
 * @param {string} text English message
 * @returns {string} Translation, or the message itself
 */
export function translateText(dictionary, text) {
    return translationFor(dictionary, text) ?? text;
}

/**
 * Loads the dictionary, translates the page and sets its language. Never rejects, hides or disables anything.
 * @returns {Promise<{locale: string, dictionary: Record<string, string>}>} Language used and its dictionary
 */
export async function startPageLocale(preference) {
    let result = { locale: 'en', dictionary: {} };
    try {
        result = await loadPageDictionary(preference);
        localisePage(document, result.dictionary);
        document.documentElement.lang = result.locale;
    } catch (error) {
        console.warn('page-locale: the page could not be translated', error);
    }
    return result;
}

// Choices are local to this browser and origin, as the existing language preference is.
export const BROWSER_LANGUAGE = 'browser';
export const LANGUAGE_CHOICE_KEY = 'NeconyanLanguageChoice.v1';
export const NEW_LANGUAGE_POLICY_KEY = 'NeconyanLanguagePolicy.v1';

export function readLanguageChoice() {
    try {
        const record = JSON.parse(localStorage.getItem(LANGUAGE_CHOICE_KEY));
        return record && ['legacy', 'browser', 'fixed'].includes(record.mode)
            && typeof record.locale === 'string' && typeof record.handled === 'boolean' ? record : null;
    } catch {
        return null;
    }
}

export function writeLanguageChoice(record) {
    try { localStorage.setItem(LANGUAGE_CHOICE_KEY, JSON.stringify(record)); } catch { /* Keep this visit usable. */ }
}

export function saveLanguagePreference(language) {
    const value = language || BROWSER_LANGUAGE;
    // Each write is independent: an acknowledgement can survive when the preference write fails.
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Storage must never block sign-in. */ }
    writeLanguageChoice({ mode: value === BROWSER_LANGUAGE ? 'browser' : 'fixed', locale: value, handled: true });
}

export function effectiveLanguagePreference() {
    const stored = storedLanguage();
    if (stored) return stored;
    const record = readLanguageChoice();
    return record ? (record.mode === 'browser' ? BROWSER_LANGUAGE : record.locale) : stored;
}

/** Positive evidence created only with fresh default settings; onboarding absence is never evidence of newness. */
export function isNewLanguageInstallation(data) {
    try {
        const settings = typeof data?.settings === 'string' ? JSON.parse(data.settings) : data?.settings;
        return settings?.accountStorage?.[NEW_LANGUAGE_POLICY_KEY] === BROWSER_LANGUAGE;
    } catch {
        return false;
    }
}

/** Pure migration rule. Existing/ambiguous profiles retain the pre-C8 exact match of the first browser language. */
export function initialLanguageChoice(stored, languages, codes, { record = null, newInstallation = false } = {}) {
    const suggested = pickLocale(languages, codes);
    if (stored) return { locale: chooseBrowserLocale(stored, languages, codes), suggested, prompt: false, record: null };
    if (record?.mode === 'browser') return { locale: suggested, suggested, prompt: false, record };
    if (record && ['fixed', 'legacy'].includes(record.mode)) {
        const locale = pickStoredLocale(record.locale, codes);
        return { locale, suggested, prompt: !record.handled && locale === 'en' && suggested !== 'en', record };
    }
    if (newInstallation) return { locale: suggested, suggested, prompt: false, record: { mode: 'browser', locale: suggested, handled: true } };
    const locale = pickStoredLocale(languages[0] || 'en', codes);
    return { locale, suggested, prompt: locale === 'en' && suggested !== 'en', record: { mode: 'legacy', locale, handled: locale !== 'en' } };
}

export function addLanguageOptions(select, languages) {
    for (const language of languages) {
        const option = select.ownerDocument.createElement('option');
        option.value = language.lang;
        option.textContent = language.display;
        select.append(option);
    }
}

/** Restores original marked captions before a language switch, without rebuilding any field or moving focus. */
export function rememberPageCaptions(root) {
    const captions = [];
    for (const element of root.querySelectorAll('[data-i18n]')) {
        if (element.matches(FORM_CONTROL_SELECTOR)) continue;
        for (const spec of element.getAttribute('data-i18n').split(';')) {
            const { attribute } = attributeKeyOf(spec);
            if (attribute && ATTRIBUTE_NAMES.has(attribute)) {
                const value = element.getAttribute(attribute);
                captions.push(() => element.setAttribute(attribute, value));
            } else if (!attribute && !element.children.length) {
                const value = element.textContent;
                captions.push(() => { element.textContent = value; });
            }
        }
    }
    return () => captions.forEach(restore => restore());
}
