import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';

import { serverDirectory } from './server-directory.js';
import { mergePageDictionary, pickLocale, translationFor } from '../public/scripts/page-locale.js';

/**
 * Language and text for the pages the server renders itself (blocked clients), read from the same dictionaries the
 * app reads. The language comes from Accept-Language and is always one of the codes in lang.json, so no request can
 * name a file.
 */

const MAX_HEADER_LENGTH = 1000;
const MAX_HEADER_ENTRIES = 32;
const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;
const LOCALE_CODE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;
const QUALITY_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;
const HOLE_PATTERN = /\$\{(\d+)\}/g;
const MAX_COMPILED_TEMPLATES = 8;

function defaultLocalesRoot() {
    return path.join(serverDirectory, 'public', 'locales');
}

/**
 * Reads the languages wanted by a client from an Accept-Language header, most wanted first.
 * Only the first 1,000 characters and 32 entries are looked at; malformed entries and q=0 are dropped.
 * @param {string|undefined} header Header value
 * @returns {string[]} Language tags as written
 */
export function parseAcceptLanguage(header) {
    if (typeof header !== 'string') return [];
    const entries = [];
    for (const [index, entry] of header.slice(0, MAX_HEADER_LENGTH).split(',').slice(0, MAX_HEADER_ENTRIES).entries()) {
        const [rawTag, ...parameters] = entry.split(';');
        const tag = rawTag.trim();
        if (tag !== '*' && !LANGUAGE_TAG_PATTERN.test(tag)) continue;
        let quality = 1;
        let valid = true;
        for (const parameter of parameters) {
            const match = parameter.trim().match(/^q=(.*)$/i);
            if (!match) continue;
            const text = match[1].trim();
            if (!QUALITY_PATTERN.test(text)) {
                valid = false;
                break;
            }
            quality = Number(text);
        }
        if (valid && quality > 0) entries.push({ tag, quality, index });
    }
    return entries.sort((a, b) => b.quality - a.quality || a.index - b.index).map(entry => entry.tag);
}

/** @type {Map<string, string[]>} */
const supportedLocalesByRoot = new Map();

/**
 * Gets the language codes of lang.json, read once per folder for the life of the process.
 * An unreadable or unparsable file gives an empty list (everything is English) and is not tried again.
 * @param {{ localesRoot?: string }} [options] Where the dictionaries are
 * @returns {string[]} Language codes
 */
export function getSupportedLocales({ localesRoot = defaultLocalesRoot() } = {}) {
    if (!supportedLocalesByRoot.has(localesRoot)) {
        let codes = [];
        try {
            const languages = JSON.parse(fs.readFileSync(path.join(localesRoot, 'lang.json'), 'utf8'));
            codes = languages.map(language => language?.lang).filter(code => typeof code === 'string' && LOCALE_CODE_PATTERN.test(code));
        } catch (error) {
            console.warn(`Could not read the language list in ${localesRoot}: ${error.message}`);
        }
        supportedLocalesByRoot.set(localesRoot, codes);
    }
    return supportedLocalesByRoot.get(localesRoot);
}

/**
 * Chooses the language for a request: Accept-Language in quality order, by the shared rule of
 * public/scripts/page-locale.js (pickLocale).
 * @param {{ headers?: Record<string, string|string[]|undefined> }} request Request
 * @param {{ localesRoot?: string }} [options] Where the dictionaries are
 * @returns {string} A supported code, or 'en'
 */
export function chooseRequestLocale(request, { localesRoot } = {}) {
    const header = request?.headers?.['accept-language'];
    return pickLocale(parseAcceptLanguage(Array.isArray(header) ? header.join(',') : header), getSupportedLocales({ localesRoot }));
}

/** @type {Map<string, { values: Map<string, string|null>, chain: Promise<void> }>} */
const translationCache = new Map();
/** @type {Set<string>} */
const reportedReadFailures = new Set();

async function readDictionaryFile(file) {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        return { data: parsed, failed: false };
    } catch (error) {
        if (error?.code === 'ENOENT') return { data: {}, failed: false };
        if (!reportedReadFailures.has(file)) {
            reportedReadFailures.add(file);
            console.warn(`Could not read the dictionary ${file}: ${error.message}`);
        }
        return { data: {}, failed: true };
    }
}

/**
 * Gets the translations of some keys for a language. The two dictionary files are merged like the app does, only the
 * requested keys are kept and the parsed files are let go. A language is read again only when a page asks for keys not
 * seen before. A dictionary edited on disk is used after the next restart.
 * @param {string} locale Language code (from chooseRequestLocale)
 * @param {string[]} keys English texts
 * @param {{ localesRoot?: string }} [options] Where the dictionaries are
 * @returns {Promise<Map<string, string|null>>} Key to translation, or null when English is shown
 */
export async function getPageTranslations(locale, keys, { localesRoot = defaultLocalesRoot() } = {}) {
    const result = new Map();
    if (locale === 'en' || !getSupportedLocales({ localesRoot }).includes(locale)) return result;
    const cacheKey = `${localesRoot}\n${locale}`;
    let entry = translationCache.get(cacheKey);
    if (!entry) {
        entry = { values: new Map(), chain: Promise.resolve() };
        translationCache.set(cacheKey, entry);
    }
    const cache = entry;
    const step = async () => {
        const missing = keys.filter(key => !cache.values.has(key));
        if (missing.length === 0) return;
        const [base, supplement] = await Promise.all([
            readDictionaryFile(path.join(localesRoot, `${locale}.json`)),
            readDictionaryFile(path.join(localesRoot, 'neconyan', `${locale}.json`)),
        ]);
        const merged = mergePageDictionary(base.data, supplement.data);
        const complete = !base.failed && !supplement.failed;
        for (const key of missing) {
            const value = translationFor(merged, key);
            if (complete) cache.values.set(key, value);
            else result.set(key, value);
        }
    };
    cache.chain = cache.chain.then(step, step);
    await cache.chain;
    for (const key of keys) {
        if (!result.has(key)) result.set(key, cache.values.get(key) ?? null);
    }
    return result;
}

/** @type {Map<string, (context: object, options?: object) => string>} */
const compiledTemplates = new Map();
const environment = Handlebars.create();

function compileTemplate(source) {
    let template = compiledTemplates.get(source);
    if (!template) {
        if (compiledTemplates.size >= MAX_COMPILED_TEMPLATES) {
            compiledTemplates.delete(compiledTemplates.keys().next().value);
        }
        template = environment.compile(source);
        compiledTemplates.set(source, template);
    }
    return template;
}

/**
 * Renders a server page template. The t helper looks up the text of a key and fills its ${n} holes with the following
 * arguments (a SafeString such as code's result as it is, anything else escaped); code wraps a text in a code element.
 * @param {string} source Template source
 * @param {{ locale: string, translations: Map<string, string|null>, context?: object }} options Language, translations and context
 * @returns {string} HTML
 */
export function renderPageTemplate(source, { locale, translations, context = {} }) {
    const t = (key, ...rest) => {
        const holes = rest.slice(0, -1);
        const text = Handlebars.escapeExpression(translations.get(key) ?? key);
        return new Handlebars.SafeString(text.replace(HOLE_PATTERN, (match, index) => {
            const hole = holes[Number(index)];
            if (hole === undefined) return match;
            return hole instanceof Handlebars.SafeString ? hole.toString() : Handlebars.escapeExpression(String(hole));
        }));
    };
    const code = text => new Handlebars.SafeString(`<code>${Handlebars.escapeExpression(text)}</code>`);
    return compileTemplate(source)({ ...context, lang: locale }, { helpers: { t, code } });
}
