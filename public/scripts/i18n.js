import { addLanguageOptions, browserLanguages, initialLanguageChoice, isNewLanguageInstallation, readLanguageChoice, saveLanguagePreference, storedLanguage, writeLanguageChoice, BROWSER_LANGUAGE } from './page-locale.js';
import { registerDebugFunction } from './power-user.js';
import { updateSecretDisplay } from './secrets.js';
import { assembleLocaleData, tableForKey } from './locale-assembly.js';
import { localizeControls, localizeString } from './ui-localization.js';

let localeFile = 'en';
var langs;
// Don't change to let/const! It will break module loading.
var localeData;
// Entries for 'scoped.' keys, which only translate() and data-i18n reach; never matched against page text. Same caveat.
var scopedData;
// True when either table has entries.
let hasLocaleData = false;
let initialChoice;

function safeSetLocalStorageItem(key, value) {
    try { localStorage.setItem(key, value); } catch { /* Keep debug controls usable when storage is blocked. */ }
}

function safeGetLocalStorageItem(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

/** @type {Set<string>|null} Array of translations keys if they should be tracked - if not tracked then null */
let trackMissingDynamicTranslate = null;

export const getCurrentLocale = () => localeFile;

/**
 * The one place an explicit lookup picks its table: a 'scoped.' key reads the scoped table and every other key reads the
 * matching dictionary. translate(), data-i18n and addLocaleData() all route through it. Either table is undefined
 * until loading finishes, so a lookup made before then finds nothing and the caller's English text is used.
 * @param {string} key
 * @returns {Record<string, string>|undefined}
 */
function lookupTable(key) {
    return tableForKey(key, localeData, scopedData);
}

/**
 * @param {Record<string, string>|undefined} table
 * @returns {boolean}
 */
function hasEntries(table) {
    return Boolean(table) && Object.keys(table).length > 0;
}

/**
 * Adds additional localization data to the current locale file.
 * A key beginning with 'scoped.' goes to the scoped table, every other key to the matching dictionary.
 * @param {string} localeId Locale ID (e.g. 'fr-fr' or 'zh-cn')
 * @param {Record<string, string>} data Localization data to add
 */
export function addLocaleData(localeId, data) {
    if (!localeData || !scopedData) {
        console.warn('Localization data not loaded yet. Additional data will not be added.');
        return;
    }

    if (localeId !== localeFile) {
        console.debug('Ignoring addLocaleData call for different locale', localeId);
        return;
    }

    for (const [key, value] of Object.entries(data)) {
        // Overrides for default locale data are not allowed
        const table = lookupTable(key);
        if (!Object.hasOwn(table, key)) {
            table[key] = value;
            hasLocaleData = true;
        }
    }
}

/**
 * An observer that will check if any new i18n elements are added to the document
 * @type {MutationObserver}
 */
const observer = new MutationObserver(mutations => {
    if (!hasLocaleData) return;
    mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && node instanceof Element) {
                if (node.hasAttribute('data-i18n')) {
                    translateElement(node);
                }
                node.querySelectorAll('[data-i18n]').forEach(element => {
                    translateElement(element);
                });
                localizeControls(node, localeData || {});
            } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
                localizeControls(node.parentElement, localeData || {});
            }
        });
        if (mutation.attributeName === 'data-i18n' && mutation.target instanceof Element) {
            translateElement(mutation.target);
        }
    });
});

/**
 * Translates a template string with named arguments
 *
 * Uses the template literal with all values replaced by index placeholder for translation key.
 *
 * @example
 * ```js
 * toastr.warning(t`Tag ${tagName} not found.`);
 * ```
 * Should be translated in the translation files as:
 * ```
 * Tag ${0} not found. -> Tag ${0} nicht gefunden.
 * ```
 *
 * @param {TemplateStringsArray} strings - Template strings array
 * @param  {...any} values - Values for placeholders in the template string
 * @returns {string} Translated and formatted string
 */
export function t(strings, ...values) {
    let str = strings.reduce((result, string, i) => result + string + (values[i] !== undefined ? `\${${i}}` : ''), '');
    let translatedStr = translate(str);

    // Replace indexed placeholders with actual values
    return translatedStr.replace(/\$\{(\d+)\}/g, (match, index) => values[index]);
}

/**
 * Translates a given key or text
 *
 * If the translation is based on a key, that one is used to find a possible translation in the translation file.
 * The original text still has to be provided, as that is the default value being returned if no translation is found.
 * A key beginning with 'scoped.' is looked up in the scoped table only; any other key is looked up in the matching dictionary.
 *
 * For in-code text translation on a format string, using the template literal `t` is preferred.
 *
 * @param {string} text - The text to translate
 * @param {string?} key - The key to use for translation. If not provided, text is used as the key.
 * @returns {string} - The translated text
 */
export function translate(text, key = null) {
    const translationKey = key || text;
    if (translationKey === null || translationKey === undefined) {
        console.trace('WARN: No translation key provided');
        return '';
    }
    const table = lookupTable(translationKey);
    if (trackMissingDynamicTranslate && table && !Object.hasOwn(table, translationKey)) {
        trackMissingDynamicTranslate.add(translationKey);
    }
    return table?.[translationKey] || text;
}

/**
 * Translates a whole message that is about to be put into a t`` frame, where the run-time localiser cannot reach it:
 * a server, provider or browser message. Exact key first, then a ${n} key, as the localiser does; the values in the
 * holes stay as written. Unknown text, and text that is already translated, comes back unchanged. Missing keys are not
 * tracked, because the text is not from the code and may be provider wording.
 * @param {string} text
 * @returns {string}
 */
export function localizeMessage(text) {
    return localeData ? localizeString(text, localeData) : String(text ?? '');
}

/**
 * Fetches the locale data for the given language.
 * @param {string} language Language code
 * @returns {Promise<{dictionary: Record<string, string>, scoped: Record<string, string>}>} The matching dictionary and the scoped table
 */
async function getLocaleData(language) {
    let supportedLang = findLang(language);
    if (!supportedLang) {
        return { dictionary: {}, scoped: {} };
    }

    const data = await fetch(`./locales/${language}.json`).then(response => {
        console.log(`Loading locale data from ./locales/${language}.json`);
        if (!response.ok) {
            return {};
        }
        return response.json();
    });

    if (language === 'en') return { dictionary: data, scoped: {} };
    const readSupplement = async name => {
        const response = await fetch(`./locales/neconyan/${name}.json`);
        return response.ok ? response.json() : {};
    };
    const [catalogue, supplement] = await Promise.all([readSupplement('en'), readSupplement(language)]);
    return assembleLocaleData({ base: data, supplement, catalogue });
}

/**
 * Gets a language object for the given language code.
 * @param {string} language Language code
 */
function findLang(language) {
    const supportedLang = langs.find(x => x.lang === language);

    const isEn = language.startsWith('en'); // includes 'en', and more specific locales like 'en-us', 'en-au', etc
    if (!supportedLang && !isEn) {
        console.warn(`Unsupported language: ${language}`);
    }
    return supportedLang;
}

/**
 * Translates a given element based on its data-i18n attribute.
 * @param {Element} element The element to translate
 */
function translateElement(element) {
    const keys = element.getAttribute('data-i18n')?.split(';') ?? []; // An observed attribute may have been removed.
    for (const key of keys) {
        // Neconyan: only a leading tag names an attribute; its caption may span multiple lines.
        const attributeMatch = key.match(/^\[([^\]]+)\](.+)$/s); // [attribute]key
        if (attributeMatch) { // attribute-tagged key
            const localizedValue = lookupTable(attributeMatch[2])?.[attributeMatch[2]];
            if (localizedValue || localizedValue === '') {
                element.setAttribute(attributeMatch[1], localizedValue);
            }
        } else { // No attribute tag, treat as 'text'
            const localizedValue = lookupTable(key)?.[key];
            if (localizedValue || localizedValue === '') {
                element.textContent = localizedValue;
            }
        }
    }
}

/**
 * Checks if the given locale is supported and not English.
 * @param {string} [locale=null] The locale to check (defaults to the current locale)
 * @returns {boolean} True if the locale is not English and supported
 */
function isSupportedNonEnglish(locale = null) {
    const lang = locale || localeFile;
    return lang && lang != 'en' && findLang(lang);
}

async function getMissingTranslations() {
    /** @type {Array<{key: string, language: string, value: string}>} */
    const missingData = [];

    if (trackMissingDynamicTranslate) {
        missingData.push(...Array.from(trackMissingDynamicTranslate).map(key => ({ key, language: localeFile, value: key })));
    }

    // Determine locales to search for untranslated strings
    const langsToProcess = isSupportedNonEnglish() ? [findLang(localeFile)] : langs;

    for (const language of langsToProcess) {
        const { dictionary, scoped } = await getLocaleData(language.lang);
        $(document).find('[data-i18n]').each(function () {
            const keys = $(this).data('i18n').split(';'); // Multi-key entries are ; delimited
            for (const key of keys) {
                const attributeMatch = key.match(/^\[([^\]]+)\](.+)$/s); // [attribute]key
                if (attributeMatch) { // attribute-tagged key
                    const localizedValue = tableForKey(attributeMatch[2], dictionary, scoped)?.[attributeMatch[2]];
                    if (!localizedValue) {
                        missingData.push({ key, language: language.lang, value: String($(this).attr(attributeMatch[1])) });
                    }
                } else { // No attribute tag, treat as 'text'
                    const localizedValue = tableForKey(key, dictionary, scoped)?.[key];
                    if (!localizedValue) {
                        missingData.push({ key, language: language.lang, value: $(this).text().trim() });
                    }
                }
            }
        });
    }

    // Remove duplicates
    const uniqueMissingData = [];
    for (const { key, language, value } of missingData) {
        if (!uniqueMissingData.some(x => x.key === key && x.language === language && x.value === value)) {
            uniqueMissingData.push({ key, language, value });
        }
    }

    // Sort by language, then key
    uniqueMissingData.sort((a, b) => a.language.localeCompare(b.language) || a.key.localeCompare(b.key));

    // Map to { language: { key: value } }
    const missingDataMap = Object.fromEntries(uniqueMissingData.map(({ key, value }) => [key, value]));

    console.log(`Missing Translations (${uniqueMissingData.length}):`);
    console.table(uniqueMissingData);
    console.log(`Full map of missing data (${Object.keys(missingDataMap).length}):`);
    console.log(missingDataMap);

    if (trackMissingDynamicTranslate) {
        const trackMissingDynamicTranslateMap = Object.fromEntries(Array.from(trackMissingDynamicTranslate).map(key => [key, key]));
        console.log(`Dynamic translations missing (${Object.keys(trackMissingDynamicTranslateMap).length}):`);
        console.log(trackMissingDynamicTranslateMap);
    }

    toastr.success(t`Found ${uniqueMissingData.length} missing translations. Their full list is in the developer console (press F12 to open it).`);
}

/**
 * Applies localization to a given root element or HTML string.
 * @param {Document|string} root The root element or HTML string to apply localization to
 * @returns {Document|string} Translated root, in the same format as the input (Document or HTML string)
 */
export function applyLocale(root = document) {
    if (!hasEntries(localeData) && !hasEntries(scopedData)) {
        return root;
    }

    const $root = root instanceof Document ? $(root) : $(new DOMParser().parseFromString(root, 'text/html'));

    //find all the elements with `data-i18n` attribute
    $root.find('[data-i18n]').each(function () {
        translateElement(this);
    });
    localizeControls($root.get(0), localeData);

    if (root !== document) {
        return $root.get(0).body.innerHTML;
    }
}

function addLanguagesToDropdown() {
    const selects = document.querySelectorAll('#ui_language_select, #onboarding_ui_language_select');
    for (const select of selects) {
        addLanguageOptions(select, langs);
        const browserOption = select.querySelector('option[value=""]');
        if (browserOption) {
            browserOption.dataset.i18n = 'Follow browser';
            browserOption.textContent = translate('Follow browser');
        }
        const stored = storedLanguage();
        select.value = stored === BROWSER_LANGUAGE || initialChoice.record?.mode === 'browser' ? '' : (stored || localeFile);
    }
}

export async function initLocales(installationData) {
    try {
        const response = await fetch('/locales/lang.json');
        if (!response.ok) throw new Error('Language list unavailable');
        langs = await response.json();
        if (!Array.isArray(langs) || langs.some(language => typeof language.lang !== 'string' || typeof language.display !== 'string')) throw new Error('Invalid language list');
    } catch (error) {
        console.warn('Language list unavailable; using English.', error);
        langs = [];
    }
    initialChoice = initialLanguageChoice(storedLanguage(), browserLanguages(), langs.map(language => language.lang), {
        record: readLanguageChoice(), newInstallation: isNewLanguageInstallation(installationData),
    });
    if (langs.length && initialChoice.record) writeLanguageChoice(initialChoice.record);
    localeFile = initialChoice.locale;
    try { ({ dictionary: localeData, scoped: scopedData } = await getLocaleData(localeFile)); } catch (error) {
        console.warn('Dictionary unavailable; using English.', error);
        localeData = {};
        scopedData = {};
    }
    hasLocaleData = hasEntries(localeData) || hasEntries(scopedData);
    if (localeFile !== 'en' && !hasLocaleData) localeFile = 'en';
    document.documentElement.lang = localeFile;
    applyLocale();
    addLanguagesToDropdown();
    updateSecretDisplay();

    $('#ui_language_select, #onboarding_ui_language_select').on('change', function () {
        saveLanguagePreference(String($(this).val()));
        location.reload();
    });

    observer.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-i18n'],
    });

    if (safeGetLocalStorageItem('trackDynamicTranslate') === 'true' && isSupportedNonEnglish()) {
        trackMissingDynamicTranslate = new Set();
    }

    registerDebugFunction('getMissingTranslations', 'Get missing translations',
        'Detects missing localization data in the current locale and dumps the data into the browser console. ' +
        'If the current locale is English, searches all other locales.',
        getMissingTranslations);
    registerDebugFunction('trackDynamicTranslate', 'Track dynamic translation',
        'Toggles tracking of dynamic translations, which will be dumped into the missing translations translations too. ' +
        'This includes things translated via the t`...` function and translate(). It will only track strings translated <b>after</b> this is toggled on, '
        + 'and when they actually pop up, so refreshing the page and opening popups, etc, is needed. Will only track if the current locale is not English.',
        () => {
            const isTracking = safeGetLocalStorageItem('trackDynamicTranslate') !== 'true';
            safeSetLocalStorageItem('trackDynamicTranslate', isTracking ? 'true' : 'false');
            if (isTracking && isSupportedNonEnglish()) {
                trackMissingDynamicTranslate = new Set();
                toastr.success('Dynamic translation tracking enabled.');
            } else if (isTracking) {
                trackMissingDynamicTranslate = null;
                toastr.warning('Dynamic translation tracking enabled, but will not be tracked with locale English.');
            } else {
                trackMissingDynamicTranslate = null;
                toastr.info('Dynamic translation tracking disabled.');
            }
        });
    registerDebugFunction('applyLocale', 'Apply locale', 'Reapplies the currently selected locale to the page.', applyLocale);
}

/** Offered after startup; cancelling is a persistent decision to retain the previous effective language. */
export async function showLanguageChoicePrompt() {
    if (!initialChoice?.prompt) return;
    const { Popup, POPUP_TYPE } = await import('./popup.js');
    const content = document.createElement('div');
    content.id = 'language-choice-prompt';
    const heading = document.createElement('h3');
    heading.textContent = t`Choose your language`;
    const explanation = document.createElement('p');
    explanation.textContent = t`Neconyan can now match more browser languages. Keep English, or choose another language. You can change this later in Settings.`;
    const label = document.createElement('label');
    label.htmlFor = 'language-choice-select';
    label.textContent = t`Choose another language`;
    const select = document.createElement('select');
    select.id = label.htmlFor;
    select.className = 'text_pole';
    for (const [value, text] of [[BROWSER_LANGUAGE, t`Follow browser`], ['en', 'English']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.append(option);
    }
    addLanguageOptions(select, langs);
    select.value = initialChoice.suggested;
    content.append(heading, explanation, label, select);
    const suggestedName = langs.find(language => language.lang === initialChoice.suggested)?.display || initialChoice.suggested;
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Use ${suggestedName}`, cancelButton: t`Keep English`, allowVerticalScrolling: true,
    });
    popup.dlg.classList.add('language-choice-popup');
    select.addEventListener('change', () => {
        const name = select.selectedOptions[0].textContent;
        popup.okButton.textContent = select.value === BROWSER_LANGUAGE ? t`Follow browser` : t`Use ${name}`;
    });
    const result = await popup.show();
    const choice = result ? select.value : initialChoice.locale;
    saveLanguagePreference(choice);
    initialChoice.prompt = false;
    if (choice !== initialChoice.locale) location.reload();
}
