/**
 * Language rules for the pages that load before the app: the sign-in page, the session-expired page, the 404 page
 * and the pages the server renders for blocked clients. It imports nothing and touches no browser object at module
 * level, so Node can import the pure functions (src/page-translations.js does) and the browser loader can use
 * them without loading i18n.js, which pulls in the whole app.
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

/**
 * Picks the language to use from a list of wanted languages, in order.
 * Candidates are lower-cased and matched as whole tags against the supported codes, like the app does.
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
    }
    return 'en';
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
 * Gets the language wanted by this browser: the choice saved by the app, else the browser language.
 * @returns {string} Lower-case language tag
 */
export function requestedLocale() {
    let stored = null;
    try {
        stored = localStorage.getItem(STORAGE_KEY);
    } catch {
        // Storage can be blocked (private modes); the browser language is used then.
    }
    return String(stored || navigator.language || navigator.userLanguage || 'en').toLowerCase();
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
 * Loads the dictionary for this browser's language: the same two files the app reads.
 * English needs no file. Any failure leaves English and logs one warning.
 * @returns {Promise<{locale: string, dictionary: Record<string, string>}>} Language used and its dictionary
 */
export async function loadPageDictionary() {
    const english = { locale: 'en', dictionary: {} };
    const requested = requestedLocale();
    if (isEnglish(requested)) return english;
    const failures = [];
    try {
        const response = await fetch('/locales/lang.json', { credentials: 'same-origin', priority: 'low' });
        if (!response.ok) throw new Error(`lang.json answered ${response.status}`);
        const languages = await response.json();
        const codes = languages.map(language => language.lang);
        const locale = pickLocale([requested], codes);
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
export async function startPageLocale() {
    let result = { locale: 'en', dictionary: {} };
    try {
        result = await loadPageDictionary();
        localisePage(document, result.dictionary);
        document.documentElement.lang = result.locale;
    } catch (error) {
        console.warn('page-locale: the page could not be translated', error);
    }
    return result;
}
