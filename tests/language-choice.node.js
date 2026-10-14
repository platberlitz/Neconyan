/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Language selection (C8). The rule is defined once, in public/scripts/page-locale.js, and used by the app
// (public/scripts/i18n.js), the sign-in, session-expired and 404 pages (the same file) and the server pages
// (src/page-translations.js). Every tag named in the language tables of the plan is a row here.
// Each test imports the modules inside its own body, so that on the code before the change a defect test fails at
// its assertion and not at import.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesRoot = path.join(root, 'public', 'locales');
const languages = JSON.parse(fs.readFileSync(path.join(localesRoot, 'lang.json'), 'utf8'));
const codes = languages.map(language => language.lang);
const requestWith = acceptLanguage => ({ headers: acceptLanguage === undefined ? {} : { 'accept-language': acceptLanguage } });

// C8-U1, written rows: [tag, result]. The whole-tag rows are generated from lang.json below.
const SINGLE_ROWS = [
    // bare codes
    ['de', 'de-de'], ['it', 'it-it'], ['fr', 'fr-fr'], ['es', 'es-es'], ['pt', 'pt-pt'], ['nl', 'nl-nl'], ['ru', 'ru-ru'],
    ['ja', 'ja-jp'], ['ko', 'ko-kr'], ['ar', 'ar-sa'], ['is', 'is-is'], ['uk', 'uk-ua'], ['vi', 'vi-vn'], ['th', 'th-th'],
    ['zh', 'zh-cn'],
    // regions
    ['de-AT', 'de-de'], ['de-CH', 'de-de'], ['de-LI', 'de-de'], ['de-LU', 'de-de'], ['it-CH', 'it-it'], ['it-SM', 'it-it'],
    ['fr-CA', 'fr-fr'], ['fr-CH', 'fr-fr'], ['fr-BE', 'fr-fr'], ['es-419', 'es-es'], ['es-MX', 'es-es'], ['es-AR', 'es-es'],
    ['es-US', 'es-es'], ['pt-BR', 'pt-pt'], ['pt-AO', 'pt-pt'], ['pt-MZ', 'pt-pt'], ['nl-BE', 'nl-nl'], ['ar-EG', 'ar-sa'],
    ['ar-AE', 'ar-sa'], ['ar-MA', 'ar-sa'], ['ru-UA', 'ru-ru'], ['ru-BY', 'ru-ru'], ['ko-KP', 'ko-kr'],
    // English
    ['en', 'en'], ['en-US', 'en'], ['en-GB', 'en'], ['en-AU', 'en'], ['en-IN', 'en'],
    // Chinese: an explicit script wins over the region
    ['zh-Hant', 'zh-tw'], ['zh-Hant-TW', 'zh-tw'], ['zh-Hant-HK', 'zh-tw'], ['zh-Hant-MO', 'zh-tw'], ['zh-Hant-CN', 'zh-tw'],
    ['zh-Hant-SG', 'zh-tw'],
    ['zh-Hans', 'zh-cn'], ['zh-Hans-CN', 'zh-cn'], ['zh-Hans-TW', 'zh-cn'], ['zh-Hans-HK', 'zh-cn'], ['zh-Hans-MO', 'zh-cn'],
    ['zh-Hans-SG', 'zh-cn'],
    // Chinese: the region decides only when there is no script (zh-TW and zh-CN are whole-tag rows)
    ['zh-HK', 'zh-tw'], ['zh-MO', 'zh-tw'], ['zh-SG', 'zh-cn'], ['zh-MY', 'zh-cn'], ['zh-US', 'zh-cn'],
    // languages without a dictionary, and special tags
    ['nb', 'en'], ['nn', 'en'], ['no', 'en'], ['nb-NO', 'en'], ['sv', 'en'], ['da', 'en'], ['pl', 'en'], ['tr', 'en'],
    ['ca', 'en'], ['gl', 'en'], ['be', 'en'], ['he', 'en'], ['yue', 'en'], ['yue-Hant-HK', 'en'], ['gsw-CH', 'en'],
    ['*', 'en'], ['', 'en'], ['x-pirate', 'en'], ['i-klingon', 'en'], ['und', 'en'], ['de_DE', 'en'], ['xx-yy', 'en'],
];

// C8-U1, whole-tag rows: each lang.json code as lang.json writes it, in upper case and in the browser's form
// (language lower case, region upper case: de-DE, zh-TW, ar-SA). Generated, so a code added later is tested.
const browserForm = code => code.replace(/-([a-z]+)$/, (_match, region) => `-${region.toUpperCase()}`);
const wholeTagRows = () => codes.map(code => [code, [code, code.toUpperCase(), browserForm(code)]]);

// C8-U2: lists as navigator.languages reports them, [list, result].
const LIST_ROWS = [
    [['nb', 'de-DE', 'en-US'], 'de-de'], [['nb', 'en-US', 'de'], 'en'], [['en-GB', 'de-DE'], 'en'], [['pl', 'it'], 'it-it'],
    [['fr-CH', 'de-DE'], 'fr-fr'], [['de-AT', 'it-IT'], 'de-de'], [['*', 'de'], 'de-de'], [['x-pirate', 'de'], 'de-de'],
    [['', 'de'], 'de-de'], [['de', 'de-DE', 'en', 'en-GB', 'en-US'], 'de-de'], [['pt-BR', 'pt', 'en', 'en-GB', 'en-US'], 'pt-pt'],
    [['xx', 'pt-PT'], 'pt-pt'], [['de-DE', 'de', 'en'], 'de-de'], [[], 'en'],
    // how an English preference stays English (plan 4.3): an English tag ends the search wherever it stands
    [['en-US', 'de-DE'], 'en'], [['en-GB', 'de'], 'en'], [['nb', 'de', 'en'], 'de-de'],
    // measured navigator.languages (Chromium 148 and Edge 155, profile Preferences, no flags)
    [['de', 'en-US', 'en'], 'de-de'], [['it', 'en-US', 'en'], 'it-it'], [['ar', 'en-US', 'en'], 'ar-sa'],
    [['pt-BR', 'en'], 'pt-pt'], [['zh-HK', 'en'], 'zh-tw'], [['de-CH', 'en-US', 'en'], 'de-de'], [['en-US', 'en'], 'en'],
];

// C8-U5: [stored value, browser languages, result].
const STORED_ROWS = [
    ['de-de', ['it'], 'de-de'], ['it-it', ['de-DE'], 'it-it'], ['en', ['de'], 'en'], ['xx-yy', ['de-DE'], 'en'],
    ['de', ['de-DE'], 'en'], ['es-spa', ['es'], 'en'], ['ar_sa', ['ar'], 'en'], ['DE-DE', ['it'], 'de-de'],
    [null, ['de'], 'de-de'], ['', ['de'], 'de-de'],
];

// C8-U7: [Accept-Language, result]. 'measured' rows were received by a throw-away loopback echo server from a real
// browser; 'constructed' rows follow Firefox's and Safari's defaults and Chromium's way of building the header.
const HEADER_ROWS = [
    ['de', 'de-de'], // measured: Playwright context locale 'de'
    ['de,en-US;q=0.9,en;q=0.8', 'de-de'], // measured: Chromium 148 and Edge 155, list de,en-US,en (plain German at the top)
    ['de-DE,de;q=0.9', 'de-de'], // measured: Chromium 148 full binary, German interface (--lang=de-DE, plan check)
    ['de-DE', 'de-de'], // constructed: Safari
    ['de,en-US;q=0.7,en;q=0.3', 'de-de'], // constructed: Firefox, German
    ['de-AT,de;q=0.9,en;q=0.8', 'de-de'], // constructed: German (Austria) above English
    ['de-CH,de;q=0.9,en;q=0.8,fr;q=0.7', 'de-de'], // constructed: German (Switzerland), English, French
    ['de-CH,de;q=0.9,en-US;q=0.8,en;q=0.7', 'de-de'], // measured: Chromium 148 and Edge 155, list de-CH,en-US,en
    ['de,de-DE;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6', 'de-de'], // measured: Edge 155, German interface (--lang=de-DE, plan check)
    ['it,en-US;q=0.9,en;q=0.8', 'it-it'], // measured: Chromium 148 and Edge 155, list it,en-US,en
    ['it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7', 'it-it'], // constructed: Italian (Italy)
    ['pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7', 'pt-pt'], // constructed: Portuguese (Brazil), then American English
    ['pt-BR,pt;q=0.9,en;q=0.8', 'pt-pt'], // measured: Chromium 148 and Edge 155, list pt-BR,en
    ['fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7', 'fr-fr'], // constructed: French (Canada)
    ['es-419,es;q=0.9', 'es-es'], // measured: Chromium 148 full binary, Spanish (Latin America) interface (plan check)
    ['es-419,es;q=0.9,en;q=0.8', 'es-es'], // measured: Chromium 148, list es-419,en (plan check)
    ['zh-HK,zh;q=0.9,en;q=0.8', 'zh-tw'], // measured: Chromium 148 and Edge 155, list zh-HK,en
    ['zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7', 'zh-tw'], // constructed: Chinese (Taiwan)
    ['zh-CN,zh;q=0.9', 'zh-cn'], // constructed: Chinese (China)
    ['ar,en-US;q=0.9,en;q=0.8', 'ar-sa'], // measured: Chromium 148 and Edge 155, list ar,en-US,en
    ['nb-NO,nb;q=0.9,no;q=0.8,nn;q=0.7,en-US;q=0.6,en;q=0.5', 'en'], // constructed: Norwegian Bokmal
    ['nb,de;q=0.9,en;q=0.8', 'de-de'], // constructed: Norwegian, German, English
    ['nb,de-DE;q=0.9,de;q=0.8,en-US;q=0.7,en;q=0.6', 'de-de'], // measured: Chromium 148 and Edge 155, list nb,de-DE,en-US
    ['nb,en-US;q=0.9,en;q=0.8,de;q=0.7', 'en'], // measured: Chromium 148 and Edge 155, list nb,en-US,de
    ['pl-PL,pl;q=0.9,it;q=0.8,en;q=0.7', 'it-it'], // constructed: Polish, then Italian
    ['en-US,en;q=0.9,de;q=0.8', 'en'], // constructed: English above German
    ['en-US,en;q=0.9', 'en'], // measured: Chromium 148 and Edge 155, fresh profile
    ['en-GB,en;q=0.9', 'en'], // constructed: British English
    ['en-GB,en;q=0.9,de-DE;q=0.8,de;q=0.7', 'en'], // measured: Chromium 148 and Edge 155, list en-GB,de-DE
];

// C8-U4: input that is not a language tag at all.
const ODD_INPUT = ['constructor', '__proto__', 'toString', '../de-de', 'de-de/../x', 'a'.repeat(5000), 'zh-hant-hant', '123', null, undefined, 123];

test('C8-U1 pickLocale gives the table\'s result for every single tag, all 15 languages', async () => {
    const { pickLocale } = await import('../public/scripts/page-locale.js');
    assert.equal(SINGLE_ROWS.length, 82);
    for (const [tag, expected] of SINGLE_ROWS) {
        assert.equal(pickLocale([tag], codes), expected, `pickLocale([${JSON.stringify(tag)}])`);
    }
    const wholeTags = wholeTagRows();
    assert.equal(wholeTags.length, codes.length);
    for (const [code, forms] of wholeTags) {
        for (const form of forms) assert.equal(pickLocale([form], codes), code, `pickLocale([${JSON.stringify(form)}])`);
    }
});

test('C8-U2 pickLocale walks a list in order and stops at English', async () => {
    const { pickLocale } = await import('../public/scripts/page-locale.js');
    assert.equal(LIST_ROWS.length, 24);
    for (const [list, expected] of LIST_ROWS) {
        assert.equal(pickLocale(list, codes), expected, JSON.stringify(list));
    }
});

test('C8-U3 a language with two dictionaries needs a variant rule, and none is guessed', async () => {
    const { VARIANT_RULES, pickLocale } = await import('../public/scripts/page-locale.js');
    const primaries = [...new Set(codes.map(code => code.split('-')[0]))];
    const several = primaries.filter(primary => codes.filter(code => code.split('-')[0] === primary).length > 1);
    assert.ok(several.length > 0);
    for (const primary of several) {
        assert.equal(typeof VARIANT_RULES[primary], 'function', `lang.json has several ${primary} dictionaries and page-locale.js has no VARIANT_RULES entry for ${primary}`);
    }
    // A made-up second Portuguese dictionary with no rule: nothing is guessed for the bare language, and the whole tag still wins.
    const withSecondPortuguese = [...codes, 'pt-br'];
    assert.equal(pickLocale(['pt'], withSecondPortuguese), 'en');
    assert.equal(pickLocale(['pt-BR'], withSecondPortuguese), 'pt-br');
});

test('C8-U4 the rule only ever returns a lang.json code or English, whatever it is given', async () => {
    const { pickLocale } = await import('../public/scripts/page-locale.js');
    const { chooseRequestLocale } = await import('../src/page-translations.js');
    const allowed = new Set([...codes, 'en']);
    // Known and accepted: a tag containing a slash maps by its first subtag (de-de/../x gives de-de). The result is
    // still a code, so no request can name a file, and the server's header parser rejects the slash anyway.
    const lists = [
        ...SINGLE_ROWS.map(([tag]) => [tag]),
        ...wholeTagRows().flatMap(([, forms]) => forms.map(form => [form])),
        ...LIST_ROWS.map(([list]) => list),
        ...ODD_INPUT.map(input => [input]),
    ];
    let inputs = 0;
    for (const list of lists) {
        inputs++;
        assert.ok(allowed.has(pickLocale(list, codes)), `pickLocale(${JSON.stringify(list)?.slice(0, 60)})`);
    }
    for (const [header] of HEADER_ROWS) {
        inputs++;
        assert.ok(allowed.has(chooseRequestLocale(requestWith(header), { localesRoot })), header);
    }
    assert.equal(inputs, 194);
    for (const input of ODD_INPUT) {
        assert.ok(allowed.has(chooseRequestLocale(requestWith(input), { localesRoot })), `header ${String(input).slice(0, 60)}`);
    }
    assert.equal(pickLocale(undefined, codes), 'en');
});

test('C8-U5 a stored choice is matched as a whole tag; with nothing stored the browser languages decide', async () => {
    const { chooseBrowserLocale, pickStoredLocale } = await import('../public/scripts/page-locale.js');
    assert.equal(STORED_ROWS.length, 10);
    for (const [stored, browser, expected] of STORED_ROWS) {
        assert.equal(chooseBrowserLocale(stored, browser, codes), expected, `stored ${JSON.stringify(stored)}, browser ${JSON.stringify(browser)}`);
    }
    // The stored rule alone: a supported code in any case, anything else (English, old or unknown values) is English.
    assert.equal(pickStoredLocale('Pt-PT', codes), 'pt-pt');
    assert.equal(pickStoredLocale('en', codes), 'en');
    assert.equal(pickStoredLocale('de', codes), 'en');
});

/** Replaces a global for the length of a callback, then puts it back as it was. */
async function withGlobals(replacements, callback) {
    const saved = Object.keys(replacements).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    try {
        for (const [name, value] of Object.entries(replacements)) {
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
        }
        return await callback();
    } finally {
        for (const [name, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
}

const storage = value => ({ getItem: key => (key === 'language' ? value : null) });
const brokenStorage = { getItem() { throw new Error('storage is blocked'); } };

test('C8-U6 the browser helpers read navigator and storage, and fall back the way the app always has', async () => {
    const { browserLanguages, requestedLocale, storedLanguage } = await import('../public/scripts/page-locale.js');
    await withGlobals({ navigator: { languages: ['de', 'en'], language: 'de' }, localStorage: storage(null) }, () => {
        assert.deepEqual(browserLanguages(), ['de', 'en']);
    });
    await withGlobals({ navigator: { languages: [], language: 'it' }, localStorage: storage(null) }, () => {
        assert.deepEqual(browserLanguages(), ['it']);
    });
    await withGlobals({ navigator: { userLanguage: 'pt-BR' }, localStorage: storage(null) }, () => {
        assert.deepEqual(browserLanguages(), ['pt-BR']);
    });
    await withGlobals({ navigator: {}, localStorage: storage(null) }, () => {
        assert.deepEqual(browserLanguages(), ['en']);
    });
    await withGlobals({ navigator: { languages: ['de', 42, '', null, 'en'], language: 'de' }, localStorage: storage(null) }, () => {
        assert.deepEqual(browserLanguages(), ['de', 'en']);
    });
    await withGlobals({ navigator: { languages: ['it'], language: 'it' }, localStorage: storage('DE-DE') }, () => {
        assert.equal(storedLanguage(), 'DE-DE');
        assert.equal(requestedLocale(), 'de-de');
    });
    await withGlobals({ navigator: { languages: ['it'], language: 'it' }, localStorage: brokenStorage }, () => {
        assert.equal(storedLanguage(), null);
        assert.equal(requestedLocale(), 'it');
    });
});

test('C8-U7 the server pages choose their language from Accept-Language as browsers send it', async () => {
    const { chooseRequestLocale } = await import('../src/page-translations.js');
    assert.equal(HEADER_ROWS.length, 29);
    for (const [header, expected] of HEADER_ROWS) {
        assert.equal(chooseRequestLocale(requestWith(header), { localesRoot }), expected, header);
    }
});

test('C8-U8 the Portuguese entry of lang.json is labelled Português (Brasil) and keeps its code', () => {
    const entries = languages.filter(language => language.lang === 'pt-pt');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].display, 'Português (Brasil)');
    for (const language of languages) assert.equal(language.display.includes('Portuguese brazil'), false, language.lang);
});
